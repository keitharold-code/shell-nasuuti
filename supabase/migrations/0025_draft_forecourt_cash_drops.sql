-- PLAN_PHASE2.md section 4/6/7. Section 5.4.G: forecourt cash drops,
-- split per shift (day/night) instead of daily_entries' single daily
-- figure. First genuine draft_* table in this sequence — mirrors an
-- EXISTING Phase 1 column (daily_entries.forecourt_cash_drop), so
-- approve_day_record() (0032) sums these into that column rather than
-- creating a new one, same "kept + synced" pattern as deliv_pms/ago/vp
-- (0014). Manager-owned per 5.4's own section lettering.
--
-- Delete is admin-only with no status gate, matching every Phase 1
-- child table's own convention (0010/0014/0016's own *_delete_admin
-- policies) rather than inventing a different rule here.
--
-- Rollback: drop draft_forecourt_cash_drops. Nothing references it yet.

create table draft_forecourt_cash_drops (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  shift text not null check (shift in ('day', 'night')),
  amount numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (trading_date, shift)
);

create index draft_forecourt_cash_drops_date_idx on draft_forecourt_cash_drops (trading_date);

create trigger draft_forecourt_cash_drops_set_created_by
  before insert on draft_forecourt_cash_drops
  for each row execute function set_created_by();

create trigger draft_forecourt_cash_drops_audit
  after insert or update or delete on draft_forecourt_cash_drops
  for each row execute function audit_row();

alter table draft_forecourt_cash_drops enable row level security;

create policy draft_forecourt_cash_drops_select on draft_forecourt_cash_drops
  for select
  using (is_admin() or is_manager_for(trading_date));

create policy draft_forecourt_cash_drops_write on draft_forecourt_cash_drops
  for insert
  with check (can_manager_edit(trading_date));

create policy draft_forecourt_cash_drops_update on draft_forecourt_cash_drops
  for update
  using (can_manager_edit(trading_date))
  with check (can_manager_edit(trading_date));

create policy draft_forecourt_cash_drops_delete_admin on draft_forecourt_cash_drops
  for delete
  using (is_admin());
