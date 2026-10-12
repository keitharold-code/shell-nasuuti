-- Found while starting the front-end work: PLAN_PHASE2.md section 6 lists
-- "deadlines" as something the Director Settings screen configures, but
-- 0018/0033's transition_day_record() hardcoded 10:00/12:00 Kampala
-- directly in the function body. Making the screen offer a control that
-- does nothing would be worse than not building it; this makes the
-- deadlines real settings, read at submission time, same place that
-- already reads fuel_cost_basis/stock_tolerance_pct.
--
-- Rollback: CREATE OR REPLACE transition_day_record() back to 0033's
-- version (literal 10:00/12:00); drop the two settings columns.

alter table settings
  add column manager_deadline_time time not null default '10:00',
  add column cashier_deadline_time time not null default '12:00';

create or replace function transition_day_record(p_trading_date date, p_target text, p_reason text default null)
returns day_records
language plpgsql
security definer
set search_path = public
as $$
declare
  rec day_records;
  kampala_now timestamp;
  deadline timestamp;
  manager_deadline time;
  cashier_deadline time;
begin
  select * into rec from day_records where trading_date = p_trading_date for update;
  if rec is null then
    raise exception 'day_records row for % does not exist yet', p_trading_date;
  end if;

  kampala_now := now() at time zone 'Africa/Kampala';
  select manager_deadline_time, cashier_deadline_time into manager_deadline, cashier_deadline from settings where id = 1;

  if p_target = 'MANAGER_SUBMITTED' then
    if rec.status <> 'OPEN' then
      raise exception 'cannot submit the manager part for %: status is %, not OPEN', p_trading_date, rec.status;
    end if;
    if not (is_manager_for(p_trading_date) or is_admin()) then
      raise exception 'not authorised to submit the manager part for %', p_trading_date;
    end if;
    deadline := (p_trading_date + 1) + manager_deadline;
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
    deadline := (p_trading_date + 1) + cashier_deadline;
    update day_records set
      status = 'CASHIER_SUBMITTED',
      cashier_submitted_at = now(),
      cashier_submitted_by = auth.uid(),
      late_cashier = (kampala_now > deadline)
    where trading_date = p_trading_date;

  elsif p_target = 'APPROVED' then
    perform approve_day_record(p_trading_date);

  elsif p_target = 'RETURNED' then
    if not is_admin() then
      raise exception 'only a director can return a day for correction';
    end if;
    if rec.status = 'OPEN' then
      raise exception 'day % has nothing submitted yet to return', p_trading_date;
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'a reason is required to return %', p_trading_date;
    end if;
    update day_records set
      status = 'OPEN',
      returned_reason = p_reason,
      returned_by = auth.uid(),
      returned_at = now(),
      edited_after_submit = (edited_after_submit or rec.status = 'APPROVED')
    where trading_date = p_trading_date;

  else
    raise exception 'unknown or not-yet-supported transition target: %', p_target;
  end if;

  select * into rec from day_records where trading_date = p_trading_date;
  return rec;
end;
$$;
