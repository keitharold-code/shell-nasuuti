-- PLAN_PHASE2.md section 4/6/7. Section 5.4.C (deliveries, no cost
-- fields — already true of the real `deliveries` table itself: it never
-- had a cost/price column, only invoice_no as a free-text label and
-- invoiced_litres as a quantity, cost being computed elsewhere via
-- vivo_invoices) and 5.4.D (own-use/pump-tests).
--
-- Gap found while writing this migration, not in PLAN_PHASE2.md's table
-- list: section 4.5's per-product own-use/pump-test figures
-- (genuse_pms/ago/vp, pumptest_returned_pms/ago/vp) are single-valued-
-- per-day columns on daily_entries (0012), same shape as dip_pms/ago/vp
-- — they belong on manager_day_entries (0023) alongside the dips, and
-- PLAN_PHASE2.md section 4's table list only named the repeatable
-- "other own-use" case (draft_other_own_use, below), not these six.
-- 0023 is already committed, so this is an ALTER, not an edit to it.
--
-- Rollback: drop draft_deliveries, draft_other_own_use, then the six
-- columns this migration adds to manager_day_entries.

alter table manager_day_entries
  add column genuse_pms numeric,
  add column genuse_ago numeric,
  add column genuse_vp numeric,
  add column pumptest_returned_pms numeric,
  add column pumptest_returned_ago numeric,
  add column pumptest_returned_vp numeric;

create table draft_deliveries (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
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

create index draft_deliveries_date_product_idx on draft_deliveries (trading_date, product);

create table draft_other_own_use (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  product text not null check (product in ('PMS', 'AGO', 'VP')),
  litres numeric not null,
  reason text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_other_own_use_date_idx on draft_other_own_use (trading_date);

do $$
declare t text;
begin
  foreach t in array array['draft_deliveries', 'draft_other_own_use'] loop
    execute format('create trigger %I_set_created_by before insert on %I for each row execute function set_created_by();', t, t);
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row();', t, t);
    execute format('alter table %I enable row level security;', t);
    execute format('create policy %I_select on %I for select using (is_admin() or is_manager_for(trading_date));', t, t);
    execute format('create policy %I_write on %I for insert with check (can_manager_edit(trading_date));', t, t);
    execute format('create policy %I_update on %I for update using (can_manager_edit(trading_date)) with check (can_manager_edit(trading_date));', t, t);
    execute format('create policy %I_delete_admin on %I for delete using (is_admin());', t, t);
  end loop;
end $$;
