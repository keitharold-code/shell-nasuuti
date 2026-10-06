-- Section 4.3: Airtel Pay and MTN MoMo Pay as their own fields, plus an
-- optional per-channel department split. The existing "Mobile money"
-- field (pay_momo) is untouched and keeps counting as the legacy channel
-- — it is NOT renamed or merged into pay_momo_mtn, so historical totals
-- read identically before and after this migration.
--
-- Rollback: drop payment_channel_splits, then drop the two new columns.
-- No existing column is touched.

alter table daily_entries
  add column if not exists pay_airtel numeric,
  add column if not exists pay_momo_mtn numeric;

-- One row per channel per department the split actually covers; absence
-- of any row for a channel on a date means "whole amount is Forecourt",
-- per spec — so this table is sparse by design, not one row per
-- date/channel always.
create table payment_channel_splits (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  channel text not null check (channel in ('cash', 'momo', 'shell', 'visa', 'airtel', 'momo_mtn')),
  department text not null check (department in ('forecourt', 'shop', 'lubes', 'lpg', 'other')),
  amount numeric not null,
  other_note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index payment_channel_splits_date_idx on payment_channel_splits (trading_date);

create trigger payment_channel_splits_set_created_by
  before insert on payment_channel_splits
  for each row execute function set_created_by();

create trigger payment_channel_splits_audit
  after insert or update or delete on payment_channel_splits
  for each row execute function audit_row();

alter table payment_channel_splits enable row level security;

create policy payment_channel_splits_select on payment_channel_splits
  for select
  using (is_active_profile());

create policy payment_channel_splits_write on payment_channel_splits
  for insert
  with check (can_write_entries());

create policy payment_channel_splits_update on payment_channel_splits
  for update
  using (can_write_entries())
  with check (can_write_entries());

create policy payment_channel_splits_delete_admin on payment_channel_splits
  for delete
  using (is_admin());
