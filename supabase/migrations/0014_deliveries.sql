-- Section 4.7 / 5.4.C: deliveries as their own rows (one per product per
-- delivery), replacing the flat deliv_pms/ago/vp scalars as the source of
-- truth for "litres received" — but deliv_pms/ago/vp are NOT dropped
-- (ground rule), and a trigger keeps them as a live sum of this table's
-- rows so every existing stock-chain code path that still reads them
-- keeps working unmodified. invoice_no here is whatever the manager
-- copies off the delivery note at the time — not a DB-enforced link to
-- vivo_invoices, since the director creates the actual costed invoice
-- record separately (invoice cost doesn't exist at delivery time).
--
-- Rollback: drop the sync trigger, then the table; drop the delivery_id
-- FK added onto vivo_invoices. deliv_* columns keep whatever value the
-- trigger last wrote — not reverted, consistent with "don't lose data on
-- rollback."

create table deliveries (
  id bigserial primary key,
  trading_date date not null references daily_entries(trading_date) on delete cascade,
  product text not null check (product in ('PMS', 'AGO', 'VP')),
  invoice_no text,
  invoiced_litres numeric not null,
  dip_before numeric,
  dip_after numeric,
  litres_sold_during_offload numeric not null default 0,
  truck_reg text,
  photo_url text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index deliveries_date_product_idx on deliveries (trading_date, product);

alter table vivo_invoices
  add constraint vivo_invoices_delivery_id_fkey foreign key (delivery_id) references deliveries(id);

create function sync_deliv_totals()
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
    deliv_pms = (select coalesce(sum(invoiced_litres), 0) from deliveries where trading_date = d and product = 'PMS'),
    deliv_ago = (select coalesce(sum(invoiced_litres), 0) from deliveries where trading_date = d and product = 'AGO'),
    deliv_vp  = (select coalesce(sum(invoiced_litres), 0) from deliveries where trading_date = d and product = 'VP')
  where trading_date = d;
  return coalesce(new, old);
end;
$$;

create trigger deliveries_sync_deliv_totals
  after insert or update or delete on deliveries
  for each row execute function sync_deliv_totals();

create trigger deliveries_set_created_by
  before insert on deliveries
  for each row execute function set_created_by();

create trigger deliveries_audit
  after insert or update or delete on deliveries
  for each row execute function audit_row();

alter table deliveries enable row level security;

create policy deliveries_select on deliveries
  for select
  using (is_active_profile());

create policy deliveries_write on deliveries
  for insert
  with check (can_write_entries());

create policy deliveries_update on deliveries
  for update
  using (can_write_entries())
  with check (can_write_entries());

create policy deliveries_delete_admin on deliveries
  for delete
  using (is_admin());
