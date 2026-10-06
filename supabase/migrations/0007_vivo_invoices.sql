-- Section 4.2: Vivo invoices — cost data, director-only from creation.
-- delivery_id is added as a real FK in 0014, once the deliveries table
-- exists; kept here as a plain nullable bigint so this migration doesn't
-- depend on one that comes later.
--
-- Rollback: drop table vivo_invoices. The fuel_cost_basis setting (0008)
-- falls back to FIXED when there's no invoice data for a date, so losing
-- this table doesn't break GP reporting — it just removes the
-- LATEST_INVOICE/WEIGHTED_AVG modes' data source.

create table vivo_invoices (
  id bigserial primary key,
  invoice_no text not null unique,
  invoice_date date not null,
  product text not null check (product in ('PMS', 'AGO', 'VP')),
  invoiced_litres numeric not null,
  cost_per_litre numeric not null,
  total numeric not null,
  delivery_id bigint,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index vivo_invoices_date_product_idx on vivo_invoices (invoice_date, product);

create trigger vivo_invoices_set_created_by
  before insert on vivo_invoices
  for each row execute function set_created_by();

create trigger vivo_invoices_audit
  after insert or update or delete on vivo_invoices
  for each row execute function audit_row();

alter table vivo_invoices enable row level security;

-- Director-only, full stop — "Station roles never see cost" (section 4.2).
-- No select policy for is_active_profile() at all.
create policy vivo_invoices_admin_only on vivo_invoices
  for all
  using (is_admin())
  with check (is_admin());
