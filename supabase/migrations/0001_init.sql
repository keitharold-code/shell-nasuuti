-- Shell Nasuuti — daily sales & gross profit
-- Initial schema: profiles, price_sets, settings, daily_entries, audit_log.
-- Run in the Supabase SQL editor, or via `supabase db push`.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin', 'entry', 'viewer')) default 'entry',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table price_sets (
  id bigserial primary key,
  effective_from date not null unique,
  pms_price numeric not null, pms_margin numeric not null,
  ago_price numeric not null, ago_margin numeric not null,
  vp_price  numeric not null, vp_margin  numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table settings (
  id int primary key default 1 check (id = 1),
  shop_margin_pct numeric not null default 0,
  lpg_margin_pct numeric not null default 0,
  lubes_margin_pct numeric not null default 0,
  stock_tolerance_pct numeric not null default 0.5,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table daily_entries (
  trading_date date primary key,
  dip_pms numeric, dip_ago numeric, dip_vp numeric,
  deliv_pms numeric, deliv_ago numeric, deliv_vp numeric,
  sold_pms numeric, sold_ago numeric, sold_vp numeric,
  forecourt_sales numeric, shop_sales numeric, lpg_sales numeric, lubes_sales numeric,
  pay_cash numeric, pay_momo numeric, pay_shell_card numeric, pay_visa numeric, pay_credit numeric,
  bank_centenary numeric, bank_exim numeric,
  expenses numeric,
  notes text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  table_name text not null,
  record_key text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_data jsonb,
  new_data jsonb,
  changed_by uuid references profiles(id),
  changed_at timestamptz not null default now()
);

create index audit_log_table_changed_idx on audit_log (table_name, changed_at desc);
create index audit_log_changed_by_idx on audit_log (changed_by);

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read profiles without
-- recursing through profiles' own RLS policies).
-- ---------------------------------------------------------------------------

create function is_active_profile()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and is_active
  );
$$;

create function current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from profiles where id = auth.uid() and is_active;
$$;

create function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() = 'admin';
$$;

create function can_write_entries()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() in ('admin', 'entry');
$$;

-- ---------------------------------------------------------------------------
-- updated_at / updated_by trigger
-- ---------------------------------------------------------------------------

create function set_updated_meta()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger daily_entries_set_updated_meta
  before update on daily_entries
  for each row execute function set_updated_meta();

create trigger settings_set_updated_meta
  before update on settings
  for each row execute function set_updated_meta();

-- created_by default, so the API doesn't have to send it
create function set_created_by()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger daily_entries_set_created_by
  before insert on daily_entries
  for each row execute function set_created_by();

create trigger price_sets_set_created_by
  before insert on price_sets
  for each row execute function set_created_by();

-- ---------------------------------------------------------------------------
-- Audit trigger — owned by the migration role, SECURITY DEFINER, so it can
-- always write to audit_log even though audit_log has no client-facing
-- write policy (see RLS below). record_key is the primary key as text.
-- ---------------------------------------------------------------------------

-- Field access on NEW/OLD (e.g. new.trading_date) is resolved against the
-- ACTUAL composite type bound at runtime for every branch of a CASE
-- expression, not just the branch that ends up taken — so a direct
-- `new.trading_date` reference blows up the moment this function fires on
-- `settings`, which has no such column, even though that branch is never
-- meant to run for that table. Going through jsonb sidesteps this: `->>`
-- on a jsonb object simply returns null for a key that isn't there.
create function audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  key text;
  new_json jsonb;
  old_json jsonb;
begin
  new_json := to_jsonb(new);
  old_json := to_jsonb(old);
  key := coalesce(
    (new_json ->> 'trading_date'), (old_json ->> 'trading_date'),
    (new_json ->> 'id'), (old_json ->> 'id')
  );
  if tg_op = 'DELETE' then
    insert into audit_log (table_name, record_key, action, old_data, changed_by)
    values (tg_table_name, key, 'delete', old_json, auth.uid());
    return old;
  elsif tg_op = 'UPDATE' then
    insert into audit_log (table_name, record_key, action, old_data, new_data, changed_by)
    values (tg_table_name, key, 'update', old_json, new_json, auth.uid());
    return new;
  else
    insert into audit_log (table_name, record_key, action, new_data, changed_by)
    values (tg_table_name, key, 'insert', new_json, auth.uid());
    return new;
  end if;
end;
$$;

create trigger daily_entries_audit
  after insert or update or delete on daily_entries
  for each row execute function audit_row();

create trigger price_sets_audit
  after insert or update or delete on price_sets
  for each row execute function audit_row();

create trigger settings_audit
  after insert or update or delete on settings
  for each row execute function audit_row();

-- ---------------------------------------------------------------------------
-- New auth.users -> profiles bootstrap.
-- Admin invites a user from the Supabase dashboard (Authentication > Users
-- > Invite); this trigger creates their profile row automatically with the
-- 'entry' role, which an admin then adjusts from the Admin screen.
-- ---------------------------------------------------------------------------

create function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, full_name, role, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email, 'New user'),
    'entry',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table price_sets enable row level security;
alter table settings enable row level security;
alter table daily_entries enable row level security;
alter table audit_log enable row level security;

-- profiles: everyone with an active profile can read the list (needed to
-- show "changed by" names in reports/audit); only admins can write.
create policy profiles_select on profiles
  for select
  using (auth.uid() = id or is_admin());

create policy profiles_update_admin on profiles
  for update
  using (is_admin())
  with check (is_admin());

-- price_sets: read by anyone with an active profile; write by admin only.
create policy price_sets_select on price_sets
  for select
  using (is_active_profile());

create policy price_sets_write_admin on price_sets
  for all
  using (is_admin())
  with check (is_admin());

-- settings: read by anyone with an active profile; write by admin only.
create policy settings_select on settings
  for select
  using (is_active_profile());

create policy settings_write_admin on settings
  for update
  using (is_admin())
  with check (is_admin());

-- daily_entries: read by anyone with an active profile; insert/update by
-- admin or entry; delete by admin only.
create policy daily_entries_select on daily_entries
  for select
  using (is_active_profile());

create policy daily_entries_write on daily_entries
  for insert
  with check (can_write_entries());

create policy daily_entries_update on daily_entries
  for update
  using (can_write_entries())
  with check (can_write_entries());

create policy daily_entries_delete_admin on daily_entries
  for delete
  using (is_admin());

-- audit_log: read by admin only. No insert/update/delete policy for the
-- authenticated role at all — every row is written by audit_row(), which
-- runs SECURITY DEFINER as the table owner and so bypasses RLS.
create policy audit_log_select_admin on audit_log
  for select
  using (is_admin());

-- ---------------------------------------------------------------------------
-- Seed the settings singleton (id = 1) so the app has a row to read/update
-- from first boot. updated_by is left null until an admin saves changes.
-- ---------------------------------------------------------------------------

insert into settings (id) values (1)
on conflict (id) do nothing;
