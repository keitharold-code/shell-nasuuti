-- PLAN_PHASE2.md section 4/6. The cashier's single-valued-per-day draft
-- fields: section 5.5.B's payment channels (now five, with Absa Card
-- added per your decision) and the banking-flag override from 5.5.G.
-- Banking slip fields (banking_slip_no/_photo_url) are deliberately NOT
-- here — they land in 0030 alongside the matching real daily_entries
-- columns, per PLAN_PHASE2.md section 7's migration sequence.
--
-- non_fuel_cash_banked_with_forecourt mirrors daily_entries' existing
-- Phase 1 column (0011) in name and default, but there's no Phase 1 row
-- to read a prior value from before approval — the cashier simply sets it
-- for the day, same as every other field here. banking_flag_note is
-- free text; PLAN_PHASE2.md's "editable-with-note" requirement (a note
-- when deviating from the default) is validated in the UI, same as the
-- Section 3 tolerance-exceeded explanation in 5.5 — neither is a figure
-- a CHECK constraint can usefully police.
--
-- Rollback: drop cashier_day_entries. Nothing references it yet.

create table cashier_day_entries (
  trading_date date primary key references day_records(trading_date) on delete cascade,
  pay_shell_card numeric,
  pay_visa numeric,
  pay_airtel numeric,
  pay_momo_mtn numeric,
  pay_absa numeric,
  bank_centenary numeric,
  non_fuel_cash_banked_with_forecourt boolean not null default true,
  banking_flag_note text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger cashier_day_entries_set_created_by
  before insert on cashier_day_entries
  for each row execute function set_created_by();

create trigger cashier_day_entries_set_updated_meta
  before update on cashier_day_entries
  for each row execute function set_updated_meta();

create trigger cashier_day_entries_audit
  after insert or update or delete on cashier_day_entries
  for each row execute function audit_row();

alter table cashier_day_entries enable row level security;

create policy cashier_day_entries_select on cashier_day_entries
  for select
  using (is_admin() or is_cashier_for(trading_date));

create policy cashier_day_entries_write on cashier_day_entries
  for insert
  with check (can_cashier_edit(trading_date));

create policy cashier_day_entries_update on cashier_day_entries
  for update
  using (can_cashier_edit(trading_date))
  with check (can_cashier_edit(trading_date));
