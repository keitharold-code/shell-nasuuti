-- Section 4.6: first-day opening dip, one row per product (not per date —
-- it's the one-time baseline the stock chain starts from, before any
-- daily_entries row exists to supply a "previous day's dip").
--
-- 09/09/2026's own closing dip is still missing (none was posted on the
-- morning of 10/09, per the brief) — not back-filled here, so the stock
-- chain correctly reports 09/09-10/09 as one combined variance period
-- rather than inventing a number. See PLAN.md §6.
--
-- Rollback: drop table. Stock chain reverts to today's behaviour (first
-- entry has no opening stock to check against).
--
-- id is a plain bigserial, with product as a separate unique column,
-- rather than product itself as the primary key — audit_row() (0001)
-- only knows how to extract a record_key from a trading_date or id
-- column, and every other table in this project follows that
-- convention; matching it here avoids special-casing the shared audit
-- trigger for one table (caught by applying this migration to a local
-- test database before it ever touched production — see the project's
-- testing notes).

create table opening_stock (
  id bigserial primary key,
  product text not null unique check (product in ('PMS', 'AGO', 'VP')),
  dip numeric not null,
  set_by uuid references profiles(id),
  set_at timestamptz not null default now()
);

create trigger opening_stock_audit
  after insert or update or delete on opening_stock
  for each row execute function audit_row();

alter table opening_stock enable row level security;

create policy opening_stock_select on opening_stock
  for select
  using (is_active_profile());

create policy opening_stock_write_admin on opening_stock
  for all
  using (is_admin())
  with check (is_admin());

insert into opening_stock (product, dip) values
  ('PMS', 1089),
  ('AGO', 1191),
  ('VP', 1713)
on conflict (product) do update set dip = excluded.dip;
