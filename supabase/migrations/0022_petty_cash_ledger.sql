-- PLAN_PHASE2.md section 4/7. Section 5.5.F: petty cash opening/top-ups/
-- spend/closing float. No Phase 1 column ever tracked petty cash, so
-- there is nothing to mirror into — this table IS the permanent record,
-- same standalone-primitive treatment as nozzle_meters/safe_counts.
--
-- Rollback: drop petty_cash_ledger. Nothing references it yet.

create table petty_cash_ledger (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  event_type text not null check (event_type in ('opening', 'topup', 'spend', 'closing')),
  amount numeric not null,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index petty_cash_ledger_date_idx on petty_cash_ledger (trading_date);

create trigger petty_cash_ledger_set_created_by
  before insert on petty_cash_ledger
  for each row execute function set_created_by();

create trigger petty_cash_ledger_audit
  after insert or update or delete on petty_cash_ledger
  for each row execute function audit_row();

alter table petty_cash_ledger enable row level security;

create policy petty_cash_ledger_select on petty_cash_ledger
  for select
  using (is_admin() or is_cashier_for(trading_date));

create policy petty_cash_ledger_write on petty_cash_ledger
  for insert
  with check (can_cashier_edit(trading_date));

create policy petty_cash_ledger_update on petty_cash_ledger
  for update
  using (can_cashier_edit(trading_date))
  with check (can_cashier_edit(trading_date));

create policy petty_cash_ledger_delete_admin on petty_cash_ledger
  for delete
  using (is_admin());
