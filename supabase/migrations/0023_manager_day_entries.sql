-- PLAN_PHASE2.md section 4/6 (renumbered — see 0019's header note on the
-- +1 shift). The manager's single-valued-per-day draft fields: sections
-- 5.4.B (tank dips, blind), 5.4.G (non-fuel sales), 5.4.H (remarks +
-- photos). The per-day repeatable sections (deliveries, own-use,
-- credit/prepaid, forecourt cash drops) are their own draft_* tables
-- later in this sequence, not columns here.
--
-- One row per trading_date, same shape as daily_entries itself but
-- anchored on day_records per PLAN_PHASE2.md section 1 — this is a
-- draft_* table in spirit (it mirrors daily_entries' dip_*/shop_sales/
-- etc. columns) even though it doesn't carry a draft_ prefix, since
-- "manager_day_entries" is PLAN_PHASE2.md's own name for it (section 2/4).
-- approve_day_record() (0032) copies it into daily_entries.
--
-- photo_urls is a plain text[] of Storage paths — the bucket itself
-- doesn't exist until 0031, but the column can exist now; it's just
-- nullable until then.
--
-- Rollback: drop manager_day_entries. Nothing references it yet.

create table manager_day_entries (
  trading_date date primary key references day_records(trading_date) on delete cascade,
  dip_pms numeric,
  dip_ago numeric,
  dip_vp numeric,
  shop_sales numeric,
  lpg_sales numeric,
  lubes_sales numeric,
  remarks text,
  photo_urls text[],
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger manager_day_entries_set_created_by
  before insert on manager_day_entries
  for each row execute function set_created_by();

create trigger manager_day_entries_set_updated_meta
  before update on manager_day_entries
  for each row execute function set_updated_meta();

create trigger manager_day_entries_audit
  after insert or update or delete on manager_day_entries
  for each row execute function audit_row();

alter table manager_day_entries enable row level security;

create policy manager_day_entries_select on manager_day_entries
  for select
  using (is_admin() or is_manager_for(trading_date));

create policy manager_day_entries_write on manager_day_entries
  for insert
  with check (can_manager_edit(trading_date));

create policy manager_day_entries_update on manager_day_entries
  for update
  using (can_manager_edit(trading_date))
  with check (can_manager_edit(trading_date));
