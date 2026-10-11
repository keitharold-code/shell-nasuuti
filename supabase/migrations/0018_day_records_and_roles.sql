-- PLAN_PHASE2.md section 2/3/7 item 1: the Records workflow's state machine
-- and the manager/cashier roles it runs for. Deliberately does NOT touch
-- any Phase 1 table's data columns or RLS yet — that's 0019, kept separate
-- so this migration stays reviewable as "just the workflow skeleton."
--
-- day_records has NO foreign key to daily_entries (unlike every Phase 1
-- child table). That's deliberate, per PLAN_PHASE2.md section 1: a
-- day_records row is created the moment a manager starts a draft, which
-- must NOT create a real daily_entries row yet (that would make an
-- unapproved day show up in every Phase 1 report immediately). A real
-- daily_entries row for a date is only ever created by approve_day_record()
-- (0031), once CASHIER_SUBMITTED -> APPROVED.
--
-- Rollback: drop transition_day_record(), is_cashier_for(), is_manager_for(),
-- is_cashier(), is_manager(), role_standins, day_records, then restore
-- profiles' original role CHECK. Nothing from Phase 1 references any of
-- this yet, so a rollback here is fully inert to the existing app.

-- ---------------------------------------------------------------------------
-- profiles.role widened (additive: existing admin/entry/viewer rows and
-- the CHECK's own existing three values are untouched, just extended).
-- ---------------------------------------------------------------------------

alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'entry', 'viewer', 'manager', 'cashier'));

-- ---------------------------------------------------------------------------
-- day_records
-- ---------------------------------------------------------------------------

create table day_records (
  trading_date date primary key,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'MANAGER_SUBMITTED', 'CASHIER_SUBMITTED', 'APPROVED')),
  manager_submitted_at timestamptz,
  manager_submitted_by uuid references profiles(id),
  cashier_submitted_at timestamptz,
  cashier_submitted_by uuid references profiles(id),
  approved_at timestamptz,
  approved_by uuid references profiles(id),
  returned_reason text,
  returned_by uuid references profiles(id),
  returned_at timestamptz,
  late_manager boolean not null default false,
  late_cashier boolean not null default false,
  edited_after_submit boolean not null default false,
  deleted_at timestamptz,
  deleted_reason text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  -- "Future dates disallowed" (5.3) — enforced here too, not only in the
  -- UI, so a direct API call can't create a record for a date that hasn't
  -- happened yet.
  check (trading_date <= current_date)
);

-- ---------------------------------------------------------------------------
-- role_standins — deliberately NOT keyed to day_records: a director must
-- be able to assign a stand-in for a date before anyone has started that
-- day's draft (e.g. arranging cover ahead of a manager's known absence).
-- ---------------------------------------------------------------------------

create table role_standins (
  id bigserial primary key,
  trading_date date not null,
  role text not null check (role in ('manager', 'cashier')),
  standin_user_id uuid not null references profiles(id),
  assigned_by uuid references profiles(id),
  assigned_at timestamptz not null default now(),
  unique (trading_date, role)
);

create index role_standins_date_idx on role_standins (trading_date);

create function set_assigned_by()
returns trigger
language plpgsql
as $$
begin
  if new.assigned_by is null then
    new.assigned_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger role_standins_set_assigned_by
  before insert on role_standins
  for each row execute function set_assigned_by();

create trigger day_records_set_created_by
  before insert on day_records
  for each row execute function set_created_by();

create trigger day_records_audit
  after insert or update or delete on day_records
  for each row execute function audit_row();

create trigger role_standins_audit
  after insert or update or delete on role_standins
  for each row execute function audit_row();

-- ---------------------------------------------------------------------------
-- Role helpers, same SECURITY DEFINER style as is_admin()/can_write_entries().
-- is_manager_for()/is_cashier_for() fold the stand-in case in as an OR, not
-- a separate code path — a stand-in is treated identically to the role
-- holder, everywhere.
-- ---------------------------------------------------------------------------

create function is_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() = 'manager';
$$;

create function is_cashier()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() = 'cashier';
$$;

create function is_manager_for(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_manager() or exists (
    select 1 from role_standins
    where trading_date = d and role = 'manager' and standin_user_id = auth.uid()
  );
$$;

create function is_cashier_for(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_cashier() or exists (
    select 1 from role_standins
    where trading_date = d and role = 'cashier' and standin_user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table day_records enable row level security;
alter table role_standins enable row level security;

-- A manager/cashier (or their stand-in) can see the status of their own
-- date's record; a director sees everything. Full row contents of
-- manager_day_entries/cashier_day_entries are a separate, narrower grant
-- (0022/0023) — this table only ever carries workflow metadata, nothing
-- sensitive, so one SELECT policy covers it.
create policy day_records_select on day_records
  for select
  using (is_admin() or is_manager_for(trading_date) or is_cashier_for(trading_date));

-- A manager creates their own date's row by inserting it directly (status
-- defaults to OPEN) — this is the one write day_records grants outside the
-- transition function, since "start a draft" isn't a state TRANSITION, it's
-- the row coming into existence.
create policy day_records_insert on day_records
  for insert
  with check (is_admin() or is_manager_for(trading_date));

-- No UPDATE policy for manager/cashier at all. Every status change — submit,
-- return, approve — goes through transition_day_record() below, which is
-- SECURITY DEFINER and so runs as the table owner regardless of the
-- caller's own grants. That is the enforcement: there is no RLS path by
-- which a client can set day_records.status directly, matching 5.9 test 2
-- ("through the UI or direct API/RLS calls").
create policy day_records_update_admin on day_records
  for update
  using (is_admin())
  with check (is_admin());

create policy role_standins_select on role_standins
  for select
  using (is_admin() or standin_user_id = auth.uid());

create policy role_standins_write_admin on role_standins
  for all
  using (is_admin())
  with check (is_admin());

-- ---------------------------------------------------------------------------
-- transition_day_record(): the ONLY way day_records.status changes.
-- SECURITY DEFINER so it can perform the UPDATE regardless of the caller's
-- own grants; it does its OWN authorisation check per edge rather than
-- relying on the (nonexistent) client-side UPDATE policy.
--
-- CASHIER_SUBMITTED -> APPROVED is deliberately NOT handled here yet — it
-- needs approve_day_record() (0031) to exist first, since approving a day
-- means copying every draft_* table into its real counterpart, not just
-- flipping a status column. 0031 adds that branch via CREATE OR REPLACE
-- FUNCTION, same signature, so every existing call site keeps working.
-- ---------------------------------------------------------------------------

create function transition_day_record(p_trading_date date, p_target text, p_reason text default null)
returns day_records
language plpgsql
security definer
set search_path = public
as $$
declare
  rec day_records;
  kampala_now timestamp;
  deadline timestamp;
begin
  select * into rec from day_records where trading_date = p_trading_date for update;
  if rec is null then
    raise exception 'day_records row for % does not exist yet', p_trading_date;
  end if;

  kampala_now := now() at time zone 'Africa/Kampala';

  if p_target = 'MANAGER_SUBMITTED' then
    if rec.status <> 'OPEN' then
      raise exception 'cannot submit the manager part for %: status is %, not OPEN', p_trading_date, rec.status;
    end if;
    if not (is_manager_for(p_trading_date) or is_admin()) then
      raise exception 'not authorised to submit the manager part for %', p_trading_date;
    end if;
    -- Deadline: 10:00 Kampala time on the day AFTER the trading date.
    deadline := (p_trading_date + 1) + time '10:00';
    update day_records set
      status = 'MANAGER_SUBMITTED',
      manager_submitted_at = now(),
      manager_submitted_by = auth.uid(),
      late_manager = (kampala_now > deadline)
    where trading_date = p_trading_date;

  elsif p_target = 'CASHIER_SUBMITTED' then
    if rec.status <> 'MANAGER_SUBMITTED' then
      raise exception 'cannot submit the cashier part for %: status is %, not MANAGER_SUBMITTED', p_trading_date, rec.status;
    end if;
    if not (is_cashier_for(p_trading_date) or is_admin()) then
      raise exception 'not authorised to submit the cashier part for %', p_trading_date;
    end if;
    -- Deadline: 12:00 Kampala time on the day AFTER the trading date.
    deadline := (p_trading_date + 1) + time '12:00';
    update day_records set
      status = 'CASHIER_SUBMITTED',
      cashier_submitted_at = now(),
      cashier_submitted_by = auth.uid(),
      late_cashier = (kampala_now > deadline)
    where trading_date = p_trading_date;

  elsif p_target = 'RETURNED' then
    if not is_admin() then
      raise exception 'only a director can return a day for correction';
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'a reason is required to return %', p_trading_date;
    end if;
    if rec.status = 'OPEN' then
      raise exception 'day % has nothing submitted yet to return', p_trading_date;
    elsif rec.status = 'APPROVED' then
      raise exception 'an approved day cannot be returned this way — unlock and correct it instead';
    end if;
    -- Goes back to OPEN, not to a separate RETURNED resting state: drafts
    -- are left exactly as submitted (nothing wiped), and the next
    -- manager/cashier submission re-enters the normal sequence from
    -- scratch, including a fresh WhatsApp hash for the corrected content.
    -- returned_reason/by/at stay on the row as the audit trail of why.
    update day_records set
      status = 'OPEN',
      returned_reason = p_reason,
      returned_by = auth.uid(),
      returned_at = now()
    where trading_date = p_trading_date;

  else
    raise exception 'unknown or not-yet-supported transition target: %', p_target;
  end if;

  select * into rec from day_records where trading_date = p_trading_date;
  return rec;
end;
$$;
