-- Section 4.9: structured expenses. daily_entries.expenses is kept as a
-- live sum of this table (trigger), same pattern as deliv_* in 0014, so
-- it's not dropped and anything still reading it keeps working.
--
-- "Own-use fuel" is deliberately NOT a selectable category here — section
-- 4.5/§3 says it's booked automatically at own-use litres x unit cost,
-- and unit cost is a view-level figure (it depends on the cost-basis
-- setting, which a director can change later). Materialising it as a
-- real stored row here would go stale the moment cost basis changes, or
-- a dip/correction changes own-use litres after the fact. Instead the
-- 0017 reporting view adds it as a synthetic category row alongside the
-- real stored categories when building the expense-by-category
-- breakdown and net profit — "automatic" means it always appears without
-- manual entry, not that a row exists on disk for it. Not offering it as
-- a category choice here also rules out someone manually double-booking it.
--
-- Staff costs: gross_pay and nssf_amount are recorded as their own
-- columns (so the 10% employer NSSF is visible as a breakdown, not just
-- folded invisibly into one number), and a trigger sets
-- amount = gross_pay + nssf_amount whenever gross_pay is provided for
-- this category — one row per staff-cost entry, not two.
--
-- Rollback: drop the sync trigger, then the table. daily_entries.expenses
-- keeps whatever value the trigger last wrote.

create table expense_entries (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
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
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index expense_entries_date_idx on expense_entries (trading_date);
create index expense_entries_category_idx on expense_entries (category);

create function expense_entries_apply_nssf()
returns trigger
language plpgsql
as $$
begin
  if new.category = 'Staff costs' and new.gross_pay is not null then
    new.nssf_amount := round(new.gross_pay * 0.10, 2);
    new.amount := new.gross_pay + new.nssf_amount;
  end if;
  return new;
end;
$$;

create trigger expense_entries_nssf
  before insert or update on expense_entries
  for each row execute function expense_entries_apply_nssf();

create function sync_expense_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d date;
begin
  d := coalesce(new.trading_date, old.trading_date);
  update daily_entries set
    expenses = (select coalesce(sum(amount), 0) from expense_entries where trading_date = d)
  where trading_date = d;
  return coalesce(new, old);
end;
$$;

create trigger expense_entries_sync_totals
  after insert or update or delete on expense_entries
  for each row execute function sync_expense_totals();

create trigger expense_entries_set_created_by
  before insert on expense_entries
  for each row execute function set_created_by();

create trigger expense_entries_audit
  after insert or update or delete on expense_entries
  for each row execute function audit_row();

alter table expense_entries enable row level security;

create policy expense_entries_select on expense_entries
  for select
  using (is_active_profile());

create policy expense_entries_write on expense_entries
  for insert
  with check (can_write_entries());

create policy expense_entries_update on expense_entries
  for update
  using (can_write_entries())
  with check (can_write_entries());

create policy expense_entries_delete_admin on expense_entries
  for delete
  using (is_admin());
