-- Section 4.4: replaces the global "single-account banking from" setting
-- with a per-day flag, so history before an unpredictable two-account
-- split stays correct instead of being forced through one global date.
-- settings.single_account_banking_from is left in place (ground rule:
-- don't drop existing columns) but the reporting views (0017) read this
-- per-day flag instead.
--
-- Default true backfills every existing row to Y via the ALTER itself
-- (Postgres fills existing rows from a column default when adding
-- NOT NULL + DEFAULT), which already matches the brief's Y list for every
-- date except the explicit N list below — so only the N dates need an
-- explicit UPDATE.
--
-- Rollback: drop column. The views fall back to the global
-- single_account_banking_from date they already know about.

alter table daily_entries
  add column if not exists non_fuel_cash_banked_with_forecourt boolean not null default true;

-- N: every date before 26/09/2026 except 18, 19, 20 Sep (which are Y).
update daily_entries
set non_fuel_cash_banked_with_forecourt = false
where trading_date in (
  '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'
);
