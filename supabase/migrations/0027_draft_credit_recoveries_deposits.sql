-- PLAN_PHASE2.md section 4/6/7. Section 5.4.F (manager: credit/prepaid
-- draws), 5.5.C (cashier: recoveries), 5.5.D (cashier: prepaid deposits).
-- customer_id stays a NOT NULL FK straight to the real, global `customers`
-- table (0010) — that FK is what makes "unknown customers blocked" true
-- at the database layer, same as it already is for Phase 1; there's no
-- separate draft customer list to keep in step.
--
-- Rollback: drop the three tables. Nothing references them yet.

create table draft_credit_prepaid_draws (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  type text not null check (type in ('credit', 'prepaid_draw')),
  product text check (product in ('PMS', 'AGO', 'VP')),
  litres numeric,
  amount numeric not null,
  vehicle_reg text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_credit_prepaid_draws_date_idx on draft_credit_prepaid_draws (trading_date);
create index draft_credit_prepaid_draws_customer_idx on draft_credit_prepaid_draws (customer_id);

create table draft_recoveries (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  amount numeric not null,
  mode text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_recoveries_date_idx on draft_recoveries (trading_date);

create table draft_prepaid_deposits (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  amount numeric not null,
  mode text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_prepaid_deposits_date_idx on draft_prepaid_deposits (trading_date);

-- credit/prepaid draws are the manager's section (5.4.F); recoveries and
-- prepaid deposits are the cashier's (5.5.C/D) — different edit predicate
-- per table, so one dynamic loop per owner rather than one loop for all
-- three.
create trigger draft_credit_prepaid_draws_set_created_by
  before insert on draft_credit_prepaid_draws
  for each row execute function set_created_by();
create trigger draft_credit_prepaid_draws_audit
  after insert or update or delete on draft_credit_prepaid_draws
  for each row execute function audit_row();
alter table draft_credit_prepaid_draws enable row level security;
create policy draft_credit_prepaid_draws_select on draft_credit_prepaid_draws
  for select using (is_admin() or is_manager_for(trading_date));
create policy draft_credit_prepaid_draws_write on draft_credit_prepaid_draws
  for insert with check (can_manager_edit(trading_date));
create policy draft_credit_prepaid_draws_update on draft_credit_prepaid_draws
  for update using (can_manager_edit(trading_date)) with check (can_manager_edit(trading_date));
create policy draft_credit_prepaid_draws_delete_admin on draft_credit_prepaid_draws
  for delete using (is_admin());

do $$
declare t text;
begin
  foreach t in array array['draft_recoveries', 'draft_prepaid_deposits'] loop
    execute format('create trigger %I_set_created_by before insert on %I for each row execute function set_created_by();', t, t);
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row();', t, t);
    execute format('alter table %I enable row level security;', t);
    execute format('create policy %I_select on %I for select using (is_admin() or is_cashier_for(trading_date));', t, t);
    execute format('create policy %I_write on %I for insert with check (can_cashier_edit(trading_date));', t, t);
    execute format('create policy %I_update on %I for update using (can_cashier_edit(trading_date)) with check (can_cashier_edit(trading_date));', t, t);
    execute format('create policy %I_delete_admin on %I for delete using (is_admin());', t, t);
  end loop;
end $$;
