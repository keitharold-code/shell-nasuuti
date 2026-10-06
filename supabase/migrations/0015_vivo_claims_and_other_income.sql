-- Section 4.7 (Vivo claims) + 4.8 (other income). vivo_claims links to
-- other_income (not the reverse) to avoid a circular FK between two
-- tables created in the same migration — "linked to the other-income
-- line when refunded" only ever needs the one direction.
--
-- Rollback: drop vivo_claims, then other_income. Net profit (0017) loses
-- the "other income" addend and the delivery-shortfall-at-cost line on a
-- rollback, same as if neither existed yet.

create table other_income (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  category text not null check (category in ('vivo_shortage_refund', 'pressure_air', 'other')),
  description text,
  amount numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index other_income_date_idx on other_income (trading_date);

create table vivo_claims (
  id bigserial primary key,
  delivery_id bigint not null references deliveries(id),
  product text not null check (product in ('PMS', 'AGO', 'VP')),
  shortfall_litres numeric not null,
  shortfall_value numeric,
  status text not null default 'open' check (status in ('open', 'claimed', 'refunded')),
  other_income_id bigint references other_income(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index vivo_claims_delivery_idx on vivo_claims (delivery_id);

do $$
declare t text;
begin
  foreach t in array array['other_income', 'vivo_claims'] loop
    execute format('create trigger %I_set_created_by before insert on %I for each row execute function set_created_by();', t, t);
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row();', t, t);
    execute format('alter table %I enable row level security;', t);
    execute format('create policy %I_select on %I for select using (is_active_profile());', t, t);
    execute format('create policy %I_write on %I for insert with check (can_write_entries());', t, t);
    execute format('create policy %I_update on %I for update using (can_write_entries()) with check (can_write_entries());', t, t);
    execute format('create policy %I_delete_admin on %I for delete using (is_admin());', t, t);
  end loop;
end $$;

-- Back-fill: 645,320 UGX Vivo PMS shortage refund, 23/09/2026. Left
-- unlinked to a vivo_claims row — no invoice/delivery data exists yet to
-- confirm which shortfall it clears (PLAN.md §6). A director can link it
-- once that data is entered, by setting the matching claim's
-- other_income_id.
insert into other_income (trading_date, category, description, amount)
values ('2026-09-23', 'vivo_shortage_refund', 'Vivo PMS shortage refund', 645320);
