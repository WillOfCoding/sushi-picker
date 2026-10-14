-- Sushi Picker schema. Run once in the Supabase SQL editor.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  items jsonb not null,
  total numeric(8,2) not null check (total >= 0 and total < 10000),
  day date not null,
  paid boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.orders enable row level security;
drop policy if exists "anyone can order" on public.orders;
create policy "anyone can order" on public.orders for insert to anon with check (paid = false);
grant insert on public.orders to anon;

-- Staff logins. Passwords are stored as SHA-256 hashes; the table is not readable through the API.
create table if not exists public.staff (
  username text primary key,
  display text not null,
  pass_sha256 text not null
);
alter table public.staff enable row level security;
insert into public.staff values
  ('will','Will','560ad08b19fa9573686e1debcf8cbbdec81bfe9d149e6837e13ec2c4274f3c9c'),
  ('zunis','Zunis','03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4')
on conflict (username) do update set display = excluded.display, pass_sha256 = excluded.pass_sha256;

create or replace function public.staff_login(u text, p text) returns text
language plpgsql security definer set search_path = public as $$
declare d text;
begin
  select display into d from staff
   where username = lower(trim(u)) and pass_sha256 = encode(sha256(convert_to(p, 'UTF8')), 'hex');
  if d is null then
    perform pg_sleep(0.5);
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  return d;
end $$;

create or replace function public.staff_orders(u text, p text) returns setof public.orders
language plpgsql security definer set search_path = public as $$
begin
  perform staff_login(u, p);
  return query select * from orders order by created_at desc;
end $$;

create or replace function public.staff_set_paid(u text, p text, order_id uuid, is_paid boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform staff_login(u, p);
  update orders set paid = is_paid where id = order_id;
end $$;

create or replace function public.staff_clear(u text, p text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform staff_login(u, p);
  delete from orders where true;
end $$;

-- Lets a customer see paid status for orders whose ids their browser remembers.
create or replace function public.order_status(ids uuid[]) returns table (id uuid, paid boolean)
language sql security definer set search_path = public stable as $$
  select o.id, o.paid from orders o where o.id = any(ids[1:200]);
$$;

grant execute on function public.staff_login(text, text), public.staff_orders(text, text),
  public.staff_set_paid(text, text, uuid, boolean), public.staff_clear(text, text),
  public.order_status(uuid[]) to anon;

-- Menu. Anyone can read it; only staff can change it, through the functions below.
create table if not exists public.menu (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null default '🍣' check (char_length(emoji) between 1 and 16),
  price numeric(6,2) not null check (price >= 0 and price < 1000),
  pos int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.menu enable row level security;
drop policy if exists "anyone can read menu" on public.menu;
create policy "anyone can read menu" on public.menu for select to anon using (true);
grant select on public.menu to anon;
insert into public.menu (name, emoji, price, pos)
select * from (values ('Salmon Nigiri','🍣',5,1),('Tuna Roll','🍙',6,2),('California Roll','🥑',6,3),
  ('Shrimp Tempura','🍤',8,4),('Eel Roll','🐟',9,5),('Veggie Roll','🥒',5,6)) v
where not exists (select 1 from public.menu);

-- Adds an item when item_id is null, otherwise edits that item.
create or replace function public.staff_menu_save(u text, p text, item_id uuid, item_name text, item_emoji text, item_price numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  perform staff_login(u, p);
  if item_id is null then
    insert into menu (name, emoji, price, pos)
    values (trim(item_name), trim(item_emoji), item_price, (select coalesce(max(pos), 0) + 1 from menu))
    returning id into r;
  else
    update menu set name = trim(item_name), emoji = trim(item_emoji), price = item_price
     where id = item_id returning id into r;
  end if;
  return r;
end $$;

create or replace function public.staff_menu_delete(u text, p text, item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform staff_login(u, p);
  delete from menu where id = item_id;
end $$;

grant execute on function public.staff_menu_save(text, text, uuid, text, text, numeric),
  public.staff_menu_delete(text, text, uuid) to anon;
