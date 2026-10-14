// Menu assistant: a chat with Claude that knows the site, the menu and the orders, and can rewrite the menu.
// Staff send the conversation so far (text, plus a photo, PDF or text file on the newest message).
// Deploy with "Verify JWT" off: staff are checked here with the same login the dashboard uses.
// Needs the ANTHROPIC_API_KEY secret (Supabase > Edge Functions > Secrets).
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5"; // swap for "claude-sonnet-5-5" if messy photos get misread

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You are the menu assistant inside Sushi Picker, a small sushi ordering site run by a few students (Will, Zunis and Elliot). You chat with one of the staff.

About the site:
- Customers open the order form, type their name, tap menu items to pick quantities, choose the day they want the food on a calendar, and submit. They pay in cash when they pick it up; nothing is paid online.
- Staff log in to a dashboard that lists orders (name, items, total, day wanted, when ordered), a Paid / Not paid toggle per order, totals, and a menu editor.
- Menu items have an emoji, a name and a price in dollars. Customers see menu changes right away.

What you can do:
- Answer questions about the menu, the orders and the site, using the data below. Be accurate; do not invent orders.
- Change the menu when staff ask, or when they send a menu (pasted text, a photo, a PDF or a file) and want it used. You can add, rename, reprice, reorder or remove items.
- You cannot change orders, payments, logins or the site's design. If asked, say so briefly and say what staff can do instead (for example, mark orders paid on the dashboard).

Changing the menu:
- Set change_menu to true and put the complete new menu in items: every item that should exist afterwards, in the order customers should see it. Set change_menu to false for everything else (questions, chat, unclear requests) and leave items empty.
- If staff send a complete menu and clearly want it used, the new menu is that menu. If they send a partial list or an instruction, apply it and keep everything else exactly as it is.
- Keep an existing item's name, emoji and price unchanged unless asked to change them.
- name: short, as customers should read it, at most 40 characters. price: dollars as a number, like 6 or 7.5. emoji: one emoji that fits; repeats are fine.
- If a new item has no price, use 0 and mention it. If a request is ambiguous or would wipe most of the menu without being clearly asked, ask first instead of changing anything.
- If staff send a menu with no instructions, it is usually meant to replace or update the menu; if you are not sure which, ask.

reply: what you say back. Plain, friendly and short: one to four sentences, no markdown headings or tables. When you change the menu, say what changed (the app also shows the list and an Undo link, so do not repeat every item). Earlier messages may mention attachments that you can no longer see; only the newest message's attachment is included.`;

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    change_menu: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, emoji: { type: "string" }, price: { type: "number" } },
        required: ["name", "emoji", "price"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "change_menu", "items"],
  additionalProperties: false,
};

type Msg = { role?: string; text?: string; file?: { type?: string; data?: string; name?: string } };
type Order = { name: string; items: { name: string; qty: number }[]; total: number; day: string; paid: boolean; created_at: string };

function ordersText(o: Order[]) {
  if (!o.length) return "There are no orders right now.";
  let owed = 0, got = 0;
  const counts: Record<string, number> = {};
  for (const x of o) {
    x.paid ? (got += +x.total) : (owed += +x.total);
    for (const it of x.items ?? []) counts[it.name] = (counts[it.name] ?? 0) + (+it.qty || 0);
  }
  const lines = o.slice(0, 150).map((x) =>
    `- ${x.name}: ${(x.items ?? []).map((it) => `${it.qty} × ${it.name}`).join(", ")} | $${(+x.total).toFixed(2)} | for ${x.day} | ${x.paid ? "paid" : "not paid"} | ordered ${x.created_at.slice(0, 16).replace("T", " ")} UTC`);
  return `${o.length} orders. Not paid $${owed.toFixed(2)}, paid $${got.toFixed(2)}.\nItems ordered in total: ${
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}\nNewest first:\n${lines.join("\n")}${o.length > 150 ? "\n(older orders left out)" : ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  let b: { u?: string; p?: string; messages?: Msg[]; today?: string };
  try { b = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  const base = Deno.env.get("SUPABASE_URL")!, apikey = req.headers.get("apikey") ?? "";
  const call = (fn: string, args: unknown) => fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  const login = await call("staff_login", { u: b.u ?? "", p: b.p ?? "" });
  if (!login.ok) return json({ error: "Please log in again." }, 401);
  const who = String(await login.json());
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "The AI key isn't set up yet. Add ANTHROPIC_API_KEY under Edge Functions > Secrets in Supabase." }, 503);
  }

  const [menuRes, ordRes] = await Promise.all([
    fetch(`${base}/rest/v1/menu?select=name,emoji,price&order=pos,created_at`, { headers: { apikey } }),
    call("staff_orders", { u: b.u, p: b.p }),
  ]);
  if (!menuRes.ok) return json({ error: "Couldn't read the current menu." }, 502);
  const menu = await menuRes.json();
  const orders: Order[] = ordRes.ok ? await ordRes.json() : [];

  // Build the conversation. Only the newest user message may carry a file.
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-40);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Nothing to send." }, 400);
  if (JSON.stringify(msgs).length > 14_000_000) return json({ error: "That's too much to send at once." }, 413);
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i], last = i === msgs.length - 1, role = m.role === "assistant" ? "assistant" : "user";
    const content: Anthropic.ContentBlockParam[] = [];
    const f = m.file;
    if (role === "user" && f?.data && f.type && last) {
      if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
        content.push({ type: "image", source: { type: "base64", media_type: f.type as "image/jpeg", data: f.data } });
      } else if (f.type === "application/pdf") {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      } else return json({ error: "That kind of file isn't supported. Use a photo, a PDF or text." }, 415);
    } else if (f?.name) content.push({ type: "text", text: `[attached ${f.name}, no longer visible]` });
    const t = String(m.text ?? "").slice(0, 200_000).trim();
    if (t) content.push({ type: "text", text: t });
    if (!content.length) content.push({ type: "text", text: last ? "(see attachment)" : "…" });
    // The API wants alternating turns; merge repeats.
    const prev = out[out.length - 1];
    if (prev && prev.role === role) (prev.content as Anthropic.ContentBlockParam[]).push(...content);
    else out.push({ role, content });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "(chat started)" });

  const context = `You are talking with ${who}. Today is ${String(b.today ?? new Date().toISOString().slice(0, 10)).slice(0, 40)}.

Current menu (live, as of this message):
${JSON.stringify(menu)}

Orders (live):
${ordRes.ok ? ordersText(orders) : "Couldn't load orders this time."}`;

  let res: { reply: string; change_menu: boolean; items: { name: string; emoji: string; price: number }[] };
  try {
    const r = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM }, { type: "text", text: context }],
      messages: out,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    if (r.stop_reason !== "end_turn") return json({ error: "The AI couldn't finish that. Try again." }, 502);
    const text = r.content.find((c) => c.type === "text");
    res = JSON.parse(text && text.type === "text" ? text.text : "");
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return json({ error: "The AI key was rejected. Check ANTHROPIC_API_KEY in Supabase." }, 503);
    }
    if (e instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.BadRequestError) return json({ error: "The AI couldn't read that. Try a clearer photo or paste the text." }, 422);
    console.error(e);
    return json({ error: "The AI didn't answer. Try again." }, 502);
  }

  const reply = String(res.reply ?? "").trim() || "Done.";
  if (!res.change_menu) return json({ reply, items: null });
  const items = (res.items ?? []).slice(0, 100).map((x) => ({
    name: String(x.name ?? "").trim().slice(0, 40),
    emoji: [...String(x.emoji ?? "").trim()].slice(0, 8).join("") || "🍣",
    price: Math.min(999.99, Math.max(0, Math.round((Number(x.price) || 0) * 100) / 100)),
  })).filter((x) => x.name);
  return json({ reply, items });
});
