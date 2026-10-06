-- Section 4.5: own-use and pump-test fields, per product (one value per
-- day — these aren't repeatable) plus a repeatable "other own-use" table
-- for the litres+reason case that doesn't fit the two fixed categories.
--
-- The warning for "Generator fuel" expense + genuse_* both used the same
-- day (4.5) is a UI/view-layer check (0016/0017), not a schema
-- constraint — nothing here prevents both from being entered, since a
-- hard DB constraint would block a legitimate same-day combination the
-- spec only asks to flag, not forbid.
--
-- Rollback: drop other_own_use, then drop the six new columns.

alter table daily_entries
  add column if not exists pumptest_returned_pms numeric,
  add column if not exists pumptest_returned_ago numeric,
  add column if not exists pumptest_returned_vp numeric,
  add column if not exists genuse_pms numeric,
  add column if not exists genuse_ago numeric,
  add column if not exists genuse_vp numeric;

create table other_own_use (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  product text not null check (product in ('PMS', 'AGO', 'VP')),
  litres numeric not null,
  reason text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index other_own_use_date_idx on other_own_use (trading_date);

create trigger other_own_use_set_created_by
  before insert on other_own_use
  for each row execute function set_created_by();

create trigger other_own_use_audit
  after insert or update or delete on other_own_use
  for each row execute function audit_row();

alter table other_own_use enable row level security;

create policy other_own_use_select on other_own_use
  for select
  using (is_active_profile());

create policy other_own_use_write on other_own_use
  for insert
  with check (can_write_entries());

create policy other_own_use_update on other_own_use
  for update
  using (can_write_entries())
  with check (can_write_entries());

create policy other_own_use_delete_admin on other_own_use
  for delete
  using (is_admin());
