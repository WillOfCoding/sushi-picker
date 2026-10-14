// Reads a pasted, uploaded or photographed menu with Claude and returns what the whole menu should be.
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

const SYSTEM = `You maintain the menu of a small sushi ordering site. Staff give you something (pasted text, a photo, a PDF or a file) and you decide what the whole menu should be afterwards.

You are given the current menu as JSON. Reply with the complete new menu: every item that should exist once you are done, in the order customers should see it. You have free control: add, rename, reprice, reorder or remove items as the input calls for.

How to read the input:
- If it is a complete menu (a photographed or pasted menu, a price list), the new menu is that menu. Items on the current menu that are not in it are removed.
- If it is a partial list or an instruction ("add miso soup for 3", "remove the eel roll", "everything goes up a dollar"), apply it to the current menu and keep everything else exactly as it is.
- Keep an existing item's name, emoji and price unchanged unless the input changes them.

For each item:
- name: short, as customers should read it, at most 40 characters.
- price: dollars as a number, like 6 or 7.5. If a new item has no price in the input, use 0 and say so in the summary so staff can fill it in.
- emoji: pick one emoji that fits the item. Several items sharing the same emoji is completely fine; a good fit matters more than variety.

summary: one or two plain sentences telling staff what changed.
understood: false only when the input has nothing you can turn into menu changes (a blurry or unrelated photo, empty text). In that case return the current menu unchanged and use the summary to say what was wrong.`;

const SCHEMA = {
  type: "object",
  properties: {
    understood: { type: "boolean" },
    summary: { type: "string" },
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
  required: ["understood", "summary", "items"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  let b: { u?: string; p?: string; text?: string; file?: { type?: string; data?: string } };
  try { b = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  const base = Deno.env.get("SUPABASE_URL")!, apikey = req.headers.get("apikey") ?? "";
  const login = await fetch(`${base}/rest/v1/rpc/staff_login`, {
    method: "POST",
    headers: { apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ u: b.u ?? "", p: b.p ?? "" }),
  });
  if (!login.ok) return json({ error: "Please log in again." }, 401);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "The AI key isn't set up yet. Add ANTHROPIC_API_KEY under Edge Functions > Secrets in Supabase." }, 503);
  }

  const menuRes = await fetch(`${base}/rest/v1/menu?select=name,emoji,price&order=pos,created_at`, { headers: { apikey } });
  if (!menuRes.ok) return json({ error: "Couldn't read the current menu." }, 502);
  const menu = await menuRes.json();

  const content: Anthropic.ContentBlockParam[] = [];
  const f = b.file;
  if (f?.data && f.type) {
    if (f.data.length > 12_000_000) return json({ error: "That file is too big." }, 413);
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
      content.push({ type: "image", source: { type: "base64", media_type: f.type as "image/jpeg", data: f.data } });
    } else if (f.type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else return json({ error: "That kind of file isn't supported. Use a photo, a PDF or text." }, 415);
  } else if (typeof b.text === "string" && b.text.trim()) {
    if (b.text.length > 200_000) return json({ error: "That text is too long." }, 413);
    content.push({ type: "text", text: `What staff gave you:\n<input>\n${b.text}\n</input>` });
  } else return json({ error: "Nothing to scan." }, 400);
  content.push({ type: "text", text: `Current menu:\n${JSON.stringify(menu)}\n\nReturn the complete new menu.` });

  let out: { understood: boolean; summary: string; items: { name: string; emoji: string; price: number }[] };
  try {
    const res = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    if (res.stop_reason !== "end_turn") return json({ error: "The AI couldn't finish reading that. Try again." }, 502);
    const text = res.content.find((c) => c.type === "text");
    out = JSON.parse(text && text.type === "text" ? text.text : "");
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return json({ error: "The AI key was rejected. Check ANTHROPIC_API_KEY in Supabase." }, 503);
    }
    if (e instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.BadRequestError) return json({ error: "The AI couldn't read that file. Try a clearer photo or paste the text." }, 422);
    console.error(e);
    return json({ error: "The AI scan failed. Try again." }, 502);
  }

  if (!out.understood) return json({ error: out.summary || "Couldn't find any menu items in that." }, 422);
  const items = (out.items ?? []).slice(0, 100).map((x) => ({
    name: String(x.name ?? "").trim().slice(0, 40),
    emoji: [...String(x.emoji ?? "").trim()].slice(0, 8).join("") || "🍣",
    price: Math.min(999.99, Math.max(0, Math.round((Number(x.price) || 0) * 100) / 100)),
  })).filter((x) => x.name);
  return json({ items, summary: String(out.summary ?? "") });
});
