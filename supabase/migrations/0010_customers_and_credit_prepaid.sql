-- Section 4.3 (customer-linked money) + lays groundwork for section 5.4.F
-- /5.5.C/5.5.D (Records forms reuse these same tables). credit_sales and
-- prepaid_draws are modelled as one table with a type column, matching
-- how 5.4.F describes them as one repeatable form section with a
-- credit/prepaid-draw type choice, rather than two near-identical tables.
-- Recoveries and prepaid deposits are the reverse flow (money coming in
-- against an existing balance) and stay separate, matching their own
-- form sections in 5.5.
--
-- Rollback: drop the four new tables in reverse dependency order
-- (credit_prepaid_draws, recoveries, prepaid_deposits, then customers).
-- Nothing existing references them yet.

create table customers (
  id bigserial primary key,
  name text not null unique,
  phone text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create trigger customers_set_created_by
  before insert on customers
  for each row execute function set_created_by();

create trigger customers_audit
  after insert or update or delete on customers
  for each row execute function audit_row();

alter table customers enable row level security;

create policy customers_select on customers
  for select
  using (is_active_profile());

create policy customers_write_admin on customers
  for all
  using (is_admin())
  with check (is_admin());

create table credit_prepaid_draws (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  type text not null check (type in ('credit', 'prepaid_draw')),
  product text check (product in ('PMS', 'AGO', 'VP')),
  litres numeric,
  amount numeric not null,
  vehicle_reg text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index credit_prepaid_draws_date_idx on credit_prepaid_draws (trading_date);
create index credit_prepaid_draws_customer_idx on credit_prepaid_draws (customer_id);

create table recoveries (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  amount numeric not null,
  mode text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index recoveries_date_idx on recoveries (trading_date);

create table prepaid_deposits (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  customer_id bigint not null references customers(id),
  amount numeric not null,
  mode text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index prepaid_deposits_date_idx on prepaid_deposits (trading_date);

do $$
declare t text;
begin
  foreach t in array array['credit_prepaid_draws', 'recoveries', 'prepaid_deposits'] loop
    execute format('create trigger %I_set_created_by before insert on %I for each row execute function set_created_by();', t, t);
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row();', t, t);
    execute format('alter table %I enable row level security;', t);
    execute format('create policy %I_select on %I for select using (is_active_profile());', t, t);
    execute format('create policy %I_write on %I for insert with check (can_write_entries());', t, t);
    execute format('create policy %I_update on %I for update using (can_write_entries()) with check (can_write_entries());', t, t);
    execute format('create policy %I_delete_admin on %I for delete using (is_admin());', t, t);
  end loop;
end $$;
