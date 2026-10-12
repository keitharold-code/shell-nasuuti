-- PLAN_PHASE2.md section 4/7. Section 5.5.A: cashier's blind, locked,
-- per-shift safe count with a witness name. Standalone primitive (no
-- Phase 1 mirror), anchored on day_records(trading_date).
--
-- "Blind" is a UI concern (the cashier form never shows expected cash
-- before this is locked) — nothing in this table depends on or reveals
-- any figure that would make it otherwise, so there's no DB-side
-- enforcement needed for that half. "Locked" IS enforced here: once
-- locked_at is set, the UPDATE policy's USING clause (checked against the
-- OLD row) stops matching, so no further edit — including by the cashier
-- who set it — can go through RLS. The only way back is the same
-- director-return path as everything else.
--
-- Rollback: drop safe_counts, can_cashier_edit(). Nothing references
-- either yet.

-- Reused by every cashier-written draft/standalone table from here on,
-- same shape and same no-admin-bypass reasoning as can_manager_edit()
-- (0020) — a cashier (or stand-in) may write while the day is still OPEN
-- or MANAGER_SUBMITTED; once CASHIER_SUBMITTED, corrections go through
-- the director RETURNED transition, not a direct edit.
create function can_cashier_edit(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_cashier_for(d) and exists (
    select 1 from day_records where trading_date = d and status in ('OPEN', 'MANAGER_SUBMITTED')
  );
$$;

create table safe_counts (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  shift text not null check (shift in ('day', 'night')),
  counted_amount numeric not null,
  witness_name text not null,
  locked_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (trading_date, shift)
);

create index safe_counts_date_idx on safe_counts (trading_date);

create trigger safe_counts_set_created_by
  before insert on safe_counts
  for each row execute function set_created_by();

create trigger safe_counts_audit
  after insert or update or delete on safe_counts
  for each row execute function audit_row();

alter table safe_counts enable row level security;

create policy safe_counts_select on safe_counts
  for select
  using (is_admin() or is_cashier_for(trading_date));

create policy safe_counts_write on safe_counts
  for insert
  with check (can_cashier_edit(trading_date));

create policy safe_counts_update on safe_counts
  for update
  using (can_cashier_edit(trading_date) and locked_at is null)
  with check (can_cashier_edit(trading_date));

create policy safe_counts_delete_admin on safe_counts
  for delete
  using (is_admin());
