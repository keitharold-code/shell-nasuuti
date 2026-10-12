-- PLAN_PHASE2.md section 4/6/7. Section 5.4.G (manager: shop-excess ->
-- other_income, and stock purchases from takings) and 5.5.E (cashier:
-- payments from takings, including confirming the manager's own
-- stock-purchase entries).
--
-- draft_expense_entries is the one draft table BOTH roles write to: the
-- manager logs a stock purchase (category 'Shop expenses', paid_from
-- 'takings') during the day, and the cashier later confirms it alongside
-- their own payments-from-takings entries — PLAN_PHASE2.md's "ticking the
-- manager's shop purchases to confirm" is literally this table's
-- confirmed_by/confirmed_at pair getting set on a row the manager
-- created. Every other draft table in this sequence has exactly one
-- writer; this is the one genuine exception, so its RLS says `can_manager
-- OR can_cashier` instead of picking one.
--
-- Reuses expense_entries_apply_nssf() (0016) unchanged on the draft
-- table — same column names, same "gross_pay in, nssf_amount + amount
-- computed" behaviour, so a staff-cost draft row already carries the
-- correct total before approve_day_record() ever copies it.
--
-- Rollback: drop draft_other_income, draft_expense_entries (and its NSSF
-- trigger). Nothing references either yet.

create table draft_expense_entries (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  category text not null check (category in (
    'Staff costs', 'Electricity', 'Water', 'Generator fuel', 'Stationery',
    'Housekeeping', 'Repairs', 'Transport', 'Bank charges', 'Shop expenses', 'Other'
  )),
  amount numeric not null,
  gross_pay numeric,
  nssf_amount numeric,
  description text,
  paid_from text not null check (paid_from in ('takings', 'petty_cash', 'bank')),
  receipt_url text,
  confirmed_by uuid references profiles(id),
  confirmed_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_expense_entries_date_idx on draft_expense_entries (trading_date);

create trigger draft_expense_entries_nssf
  before insert or update on draft_expense_entries
  for each row execute function expense_entries_apply_nssf();

create trigger draft_expense_entries_set_created_by
  before insert on draft_expense_entries
  for each row execute function set_created_by();

create trigger draft_expense_entries_audit
  after insert or update or delete on draft_expense_entries
  for each row execute function audit_row();

alter table draft_expense_entries enable row level security;

create policy draft_expense_entries_select on draft_expense_entries
  for select
  using (is_admin() or is_manager_for(trading_date) or is_cashier_for(trading_date));

create policy draft_expense_entries_write on draft_expense_entries
  for insert
  with check (can_manager_edit(trading_date) or can_cashier_edit(trading_date));

create policy draft_expense_entries_update on draft_expense_entries
  for update
  using (can_manager_edit(trading_date) or can_cashier_edit(trading_date))
  with check (can_manager_edit(trading_date) or can_cashier_edit(trading_date));

create policy draft_expense_entries_delete_admin on draft_expense_entries
  for delete
  using (is_admin());

create table draft_other_income (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  category text not null check (category in ('vivo_shortage_refund', 'pressure_air', 'other')),
  description text,
  amount numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_other_income_date_idx on draft_other_income (trading_date);

create trigger draft_other_income_set_created_by
  before insert on draft_other_income
  for each row execute function set_created_by();

create trigger draft_other_income_audit
  after insert or update or delete on draft_other_income
  for each row execute function audit_row();

alter table draft_other_income enable row level security;

create policy draft_other_income_select on draft_other_income
  for select
  using (is_admin() or is_manager_for(trading_date));

create policy draft_other_income_write on draft_other_income
  for insert
  with check (can_manager_edit(trading_date));

create policy draft_other_income_update on draft_other_income
  for update
  using (can_manager_edit(trading_date))
  with check (can_manager_edit(trading_date));

create policy draft_other_income_delete_admin on draft_other_income
  for delete
  using (is_admin());
