-- PLAN_PHASE2.md section 4/7 (renumbered +1 for 0019's insertion — see
-- 0019's own header). Section 5.4.A's ten fixed nozzles, and the
-- director-only reset log from the same section.
--
-- Standalone primitive per PLAN_PHASE2.md section 1: nozzle_meters has no
-- Phase 1 table to mirror, so it is NOT a draft_* table — it's anchored on
-- day_records(trading_date) and lives there permanently, status-gated by
-- can_manager_edit() (added here, reused by every manager-written table
-- from this point on).
--
-- Deliberately NOT auto-filling tomorrow's opening reading from today's
-- closing: a meter is physically cumulative so that continuity usually
-- holds, but a reset (meter_reset_events) breaks it, and resolving "was
-- there a reset between these two readings" from set_at timestamps vs.
-- trading dates is a judgment call the spec doesn't make. Ten blank rows
-- are seeded; the manager types both figures, same as every other field
-- in their form. The app can still show last night's closing as a
-- read-only hint by querying this table directly — that's a read, not a
-- stored assumption.
--
-- Rollback: drop meter_reset_events, nozzle_meters (and its seed trigger
-- on day_records), can_manager_edit(), fn_nozzle_product(). Nothing from
-- Phase 1 or 0018/0019 references any of this.

create function fn_nozzle_product(nozzle_id text)
returns text
language sql
immutable
as $$
  select regexp_replace(nozzle_id, '[0-9]+$', '');
$$;

-- Reused by every manager-written draft/standalone table from here on:
-- the manager (or their stand-in) may write only while the day is still
-- OPEN. No is_admin() bypass — a director who needs a submitted draft
-- changed returns the day (0018's RETURNED transition, reason required)
-- rather than hand-editing it, so every correction stays in the audit
-- trail transition_day_record() already writes.
create function can_manager_edit(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_manager_for(d) and exists (
    select 1 from day_records where trading_date = d and status = 'OPEN'
  );
$$;

create table nozzle_meters (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  nozzle_id text not null check (nozzle_id in
    ('PMS1', 'PMS2', 'PMS3', 'PMS4', 'AGO1', 'AGO2', 'AGO3', 'AGO4', 'VP1', 'VP2')),
  opening numeric,
  closing numeric,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trading_date, nozzle_id)
);

create index nozzle_meters_date_idx on nozzle_meters (trading_date);

create trigger nozzle_meters_set_created_by
  before insert on nozzle_meters
  for each row execute function set_created_by();

create trigger nozzle_meters_set_updated_meta
  before update on nozzle_meters
  for each row execute function set_updated_meta();

create trigger nozzle_meters_audit
  after insert or update or delete on nozzle_meters
  for each row execute function audit_row();

-- Seed all ten rows the moment a day_records row is created — same moment
-- a manager's draft starts, so the form always has exactly its ten rows
-- to fill in, never a dynamic add/remove list.
create function seed_nozzle_meters()
returns trigger
language plpgsql
as $$
begin
  insert into nozzle_meters (trading_date, nozzle_id)
  select new.trading_date, n
  from unnest(array['PMS1', 'PMS2', 'PMS3', 'PMS4', 'AGO1', 'AGO2', 'AGO3', 'AGO4', 'VP1', 'VP2']) as n;
  return new;
end;
$$;

create trigger day_records_seed_nozzle_meters
  after insert on day_records
  for each row execute function seed_nozzle_meters();

alter table nozzle_meters enable row level security;

create policy nozzle_meters_select on nozzle_meters
  for select
  using (is_admin() or is_manager_for(trading_date));

create policy nozzle_meters_write on nozzle_meters
  for insert
  with check (can_manager_edit(trading_date));

create policy nozzle_meters_update on nozzle_meters
  for update
  using (can_manager_edit(trading_date))
  with check (can_manager_edit(trading_date));

-- No delete policy at all: these ten rows are seeded, never removed, only
-- corrected — matches the "nothing wiped" principle the whole workflow
-- is built on.

-- ---------------------------------------------------------------------------
-- meter_reset_events — director-only, any time, not gated by day_records
-- at all: a physical meter reset happens when it happens, independent of
-- which day's draft is currently open.
-- ---------------------------------------------------------------------------

create table meter_reset_events (
  id bigserial primary key,
  nozzle_id text not null check (nozzle_id in
    ('PMS1', 'PMS2', 'PMS3', 'PMS4', 'AGO1', 'AGO2', 'AGO3', 'AGO4', 'VP1', 'VP2')),
  new_opening numeric not null,
  reason text not null,
  set_by uuid references profiles(id) default auth.uid(),
  set_at timestamptz not null default now()
);

create index meter_reset_events_nozzle_idx on meter_reset_events (nozzle_id);

create trigger meter_reset_events_audit
  after insert or update or delete on meter_reset_events
  for each row execute function audit_row();

alter table meter_reset_events enable row level security;

create policy meter_reset_events_admin on meter_reset_events
  for all
  using (is_admin())
  with check (is_admin());
