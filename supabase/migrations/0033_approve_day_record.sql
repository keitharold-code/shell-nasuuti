-- PLAN_PHASE2.md section 5/7: the single function that turns an
-- approved draft into the real daily_entries row (and real child rows)
-- that Reports/exports/views have always read — the moment this
-- migration's whole premise (drafts don't touch the real tables until
-- approval, section 1) pays off.
--
-- Found while writing this migration's own acceptance tests (0036), not
-- by inspection: a real authorisation bypass. is_admin()/is_manager_for()/
-- is_cashier_for() (0018) return NULL, not false, for an unauthenticated
-- caller — current_role_name() finds no matching profile and the `=`
-- comparisons that build on it follow SQL's three-valued logic, so the
-- result is NULL rather than FALSE. That's harmless in every RLS policy
-- that already uses these helpers, since Postgres treats a NULL
-- USING/WITH CHECK result as "deny," same as FALSE — but it is NOT
-- harmless in a plpgsql `IF NOT (...) THEN RAISE EXCEPTION`: plpgsql
-- treats a NULL condition as "don't take this branch," the opposite of
-- fail-safe for a guard clause. Concretely: `set_config('request.jwt.
-- claim.sub', '', true)` (no identity at all) then calling
-- transition_day_record() for MANAGER_SUBMITTED/CASHIER_SUBMITTED, or
-- approve_day_record() directly, sailed through every one of these
-- checks uncaught — confirmed by an acceptance test that expected the
-- call to fail and it didn't.
--
-- Fixed at the source, once, rather than wrapping every call site in
-- coalesce(): the five role helpers below are CREATE OR REPLACE'd to
-- never return anything but true/false. Every existing RLS policy using
-- them is unaffected (NULL and FALSE already denied identically there);
-- every plpgsql `IF NOT helper() THEN RAISE` from here on is correct
-- without needing its own coalesce.
--
-- Two ALTERs land after that, both needed for the copy step below:
--
-- 1. deliveries.draft_delivery_id — a stable link back to the draft row
--    it came from. Every other copied table below is deleted-then-
--    reinserted wholesale on each approval, which is safe only because
--    nothing references their rows by id. deliveries is the one
--    exception: vivo_claims.delivery_id is a plain (RESTRICT) FK to it,
--    so a director who unlocks and re-approves a day AFTER a claim was
--    raised against one of its deliveries would have the delete half of
--    "delete-then-reinsert" fail outright. draft_delivery_id lets the
--    copy be an UPSERT keyed on that stable link instead, so a
--    delivery's real id — and any claim pointing at it — survives a
--    correction. Orphan cleanup (a draft delivery the manager removed
--    before resubmitting) still deletes, but only rows no claim
--    references; one still claimed is left in place for a director to
--    sort out by hand, rather than silently deleting evidence or
--    failing the whole approval.
--
-- 2. expense_entries.confirmed_by/_at — draft_expense_entries' cashier-
--    confirmation pair (0028) has nowhere to land in the real table
--    without this; dropping it at copy time would throw away a genuine
--    accountability signal, not just draft scaffolding.
--
-- Rollback: CREATE OR REPLACE transition_day_record() back to 0018's
-- version (drop the APPROVED branch); drop approve_day_record(); drop
-- the two ALTERs. Any day already APPROVED keeps its daily_entries row
-- — a rollback here doesn't touch data already copied.

create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(current_role_name() = 'admin', false);
$$;

create or replace function is_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(current_role_name() = 'manager', false);
$$;

create or replace function is_cashier()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(current_role_name() = 'cashier', false);
$$;

create or replace function is_manager_for(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(is_manager() or exists (
    select 1 from role_standins
    where trading_date = d and role = 'manager' and standin_user_id = auth.uid()
  ), false);
$$;

create or replace function is_cashier_for(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(is_cashier() or exists (
    select 1 from role_standins
    where trading_date = d and role = 'cashier' and standin_user_id = auth.uid()
  ), false);
$$;

alter table deliveries
  add column draft_delivery_id bigint unique;

alter table expense_entries
  add column confirmed_by uuid references profiles(id),
  add column confirmed_at timestamptz;

create function approve_day_record(p_trading_date date)
returns day_records
language plpgsql
security definer
set search_path = public
as $$
declare
  rec day_records;
  m manager_day_entries;
  c cashier_day_entries;
  sold_pms numeric;
  sold_ago numeric;
  sold_vp numeric;
  summed_cash_drop numeric;
  summed_pay_credit numeric;
  summed_safe_cash numeric;
begin
  select * into rec from day_records where trading_date = p_trading_date for update;
  if rec is null then
    raise exception 'day_records row for % does not exist', p_trading_date;
  end if;
  if not is_admin() then
    raise exception 'only a director can approve a day';
  end if;
  if rec.status <> 'CASHIER_SUBMITTED' then
    raise exception 'cannot approve %: status is %, not CASHIER_SUBMITTED', p_trading_date, rec.status;
  end if;

  select * into m from manager_day_entries where trading_date = p_trading_date;
  select * into c from cashier_day_entries where trading_date = p_trading_date;

  -- Section 3's own "litres sold" formula (0017's header note 1, written
  -- before nozzle_meters existed to compute it from): gross meter litres
  -- minus pump-test-returned minus own-use — own-use here meaning BOTH
  -- the fixed genuse_* figure and any draft_other_own_use rows, matching
  -- how v_product_days (0017) already defines "own_use" for the stock
  -- reconciliation these same litres feed into.
  select
    sum(case when fn_nozzle_product(nozzle_id) = 'PMS' then coalesce(closing, 0) - coalesce(opening, 0) end),
    sum(case when fn_nozzle_product(nozzle_id) = 'AGO' then coalesce(closing, 0) - coalesce(opening, 0) end),
    sum(case when fn_nozzle_product(nozzle_id) = 'VP'  then coalesce(closing, 0) - coalesce(opening, 0) end)
  into sold_pms, sold_ago, sold_vp
  from nozzle_meters where trading_date = p_trading_date;

  sold_pms := coalesce(sold_pms, 0) - coalesce(m.pumptest_returned_pms, 0) - coalesce(m.genuse_pms, 0)
    - coalesce((select sum(litres) from draft_other_own_use where trading_date = p_trading_date and product = 'PMS'), 0);
  sold_ago := coalesce(sold_ago, 0) - coalesce(m.pumptest_returned_ago, 0) - coalesce(m.genuse_ago, 0)
    - coalesce((select sum(litres) from draft_other_own_use where trading_date = p_trading_date and product = 'AGO'), 0);
  sold_vp := coalesce(sold_vp, 0) - coalesce(m.pumptest_returned_vp, 0) - coalesce(m.genuse_vp, 0)
    - coalesce((select sum(litres) from draft_other_own_use where trading_date = p_trading_date and product = 'VP'), 0);

  select coalesce(sum(amount), 0) into summed_cash_drop
    from draft_forecourt_cash_drops where trading_date = p_trading_date;

  -- pay_credit and pay_cash are no longer independently typed figures in
  -- Phase 2 — they're what the repeatable/witnessed capture for each
  -- already implies. A manually-typed pay_credit could silently disagree
  -- with the sum of that day's own credit draws; deriving it removes the
  -- chance of the two drifting. Same reasoning for pay_cash <- safe_counts:
  -- the whole point of a blind, witnessed safe count is that it IS the
  -- cash figure, not a second number next to it.
  select coalesce(sum(amount), 0) into summed_pay_credit
    from draft_credit_prepaid_draws where trading_date = p_trading_date and type = 'credit';

  select coalesce(sum(counted_amount), 0) into summed_safe_cash
    from safe_counts where trading_date = p_trading_date;

  insert into daily_entries (
    trading_date, dip_pms, dip_ago, dip_vp, sold_pms, sold_ago, sold_vp,
    genuse_pms, genuse_ago, genuse_vp, pumptest_returned_pms, pumptest_returned_ago, pumptest_returned_vp,
    shop_sales, lpg_sales, lubes_sales, notes,
    pay_cash, pay_credit, pay_shell_card, pay_visa, pay_airtel, pay_momo_mtn, pay_absa, bank_centenary,
    non_fuel_cash_banked_with_forecourt, banking_slip_no, banking_slip_photo_url,
    forecourt_cash_drop
  ) values (
    p_trading_date, m.dip_pms, m.dip_ago, m.dip_vp, sold_pms, sold_ago, sold_vp,
    m.genuse_pms, m.genuse_ago, m.genuse_vp, m.pumptest_returned_pms, m.pumptest_returned_ago, m.pumptest_returned_vp,
    m.shop_sales, m.lpg_sales, m.lubes_sales, m.remarks,
    summed_safe_cash, summed_pay_credit, c.pay_shell_card, c.pay_visa, c.pay_airtel, c.pay_momo_mtn, c.pay_absa, c.bank_centenary,
    coalesce(c.non_fuel_cash_banked_with_forecourt, true), c.banking_slip_no, c.banking_slip_photo_url,
    summed_cash_drop
  )
  on conflict (trading_date) do update set
    dip_pms = excluded.dip_pms, dip_ago = excluded.dip_ago, dip_vp = excluded.dip_vp,
    sold_pms = excluded.sold_pms, sold_ago = excluded.sold_ago, sold_vp = excluded.sold_vp,
    genuse_pms = excluded.genuse_pms, genuse_ago = excluded.genuse_ago, genuse_vp = excluded.genuse_vp,
    pumptest_returned_pms = excluded.pumptest_returned_pms,
    pumptest_returned_ago = excluded.pumptest_returned_ago,
    pumptest_returned_vp = excluded.pumptest_returned_vp,
    shop_sales = excluded.shop_sales, lpg_sales = excluded.lpg_sales, lubes_sales = excluded.lubes_sales,
    notes = excluded.notes,
    pay_cash = excluded.pay_cash, pay_credit = excluded.pay_credit,
    pay_shell_card = excluded.pay_shell_card, pay_visa = excluded.pay_visa,
    pay_airtel = excluded.pay_airtel, pay_momo_mtn = excluded.pay_momo_mtn, pay_absa = excluded.pay_absa,
    bank_centenary = excluded.bank_centenary,
    non_fuel_cash_banked_with_forecourt = excluded.non_fuel_cash_banked_with_forecourt,
    banking_slip_no = excluded.banking_slip_no, banking_slip_photo_url = excluded.banking_slip_photo_url,
    forecourt_cash_drop = excluded.forecourt_cash_drop;

  -- deliveries: UPSERT on the stable draft link (see this file's header),
  -- not delete-then-insert. Orphan cleanup only removes a real delivery
  -- no vivo_claims row references — one that IS claimed is left as-is
  -- for a director to resolve by hand; that is a rare enough correction
  -- path that failing loudly there is better than guessing.
  insert into deliveries (
    trading_date, product, invoice_no, invoiced_litres, dip_before, dip_after,
    litres_sold_during_offload, truck_reg, photo_url, created_by, draft_delivery_id
  )
  select trading_date, product, invoice_no, invoiced_litres, dip_before, dip_after,
    litres_sold_during_offload, truck_reg, photo_url, created_by, id
  from draft_deliveries where trading_date = p_trading_date
  on conflict (draft_delivery_id) do update set
    product = excluded.product, invoice_no = excluded.invoice_no, invoiced_litres = excluded.invoiced_litres,
    dip_before = excluded.dip_before, dip_after = excluded.dip_after,
    litres_sold_during_offload = excluded.litres_sold_during_offload,
    truck_reg = excluded.truck_reg, photo_url = excluded.photo_url;

  delete from deliveries d
  where d.trading_date = p_trading_date
    and d.draft_delivery_id is not null
    and not exists (select 1 from draft_deliveries dd where dd.id = d.draft_delivery_id)
    and not exists (select 1 from vivo_claims vc where vc.delivery_id = d.id);

  -- Every table below has nothing referencing its rows by id, so a plain
  -- delete-then-reinsert for this date is safe and simple, unlike
  -- deliveries above.
  delete from other_own_use where trading_date = p_trading_date;
  insert into other_own_use (trading_date, product, litres, reason, created_by)
    select trading_date, product, litres, reason, created_by
    from draft_other_own_use where trading_date = p_trading_date;

  delete from credit_prepaid_draws where trading_date = p_trading_date;
  insert into credit_prepaid_draws (trading_date, customer_id, type, product, litres, amount, vehicle_reg, created_by)
    select trading_date, customer_id, type, product, litres, amount, vehicle_reg, created_by
    from draft_credit_prepaid_draws where trading_date = p_trading_date;

  delete from recoveries where trading_date = p_trading_date;
  insert into recoveries (trading_date, customer_id, amount, mode, created_by)
    select trading_date, customer_id, amount, mode, created_by
    from draft_recoveries where trading_date = p_trading_date;

  delete from prepaid_deposits where trading_date = p_trading_date;
  insert into prepaid_deposits (trading_date, customer_id, amount, mode, created_by)
    select trading_date, customer_id, amount, mode, created_by
    from draft_prepaid_deposits where trading_date = p_trading_date;

  delete from expense_entries where trading_date = p_trading_date;
  insert into expense_entries (
    trading_date, category, amount, gross_pay, nssf_amount, description, paid_from,
    receipt_url, confirmed_by, confirmed_at, created_by
  )
  select trading_date, category, amount, gross_pay, nssf_amount, description, paid_from,
    receipt_url, confirmed_by, confirmed_at, created_by
  from draft_expense_entries where trading_date = p_trading_date;

  delete from other_income where trading_date = p_trading_date;
  insert into other_income (trading_date, category, description, amount, created_by)
    select trading_date, category, description, amount, created_by
    from draft_other_income where trading_date = p_trading_date;

  delete from payment_channel_splits where trading_date = p_trading_date;
  insert into payment_channel_splits (trading_date, channel, department, amount, other_note, created_by)
    select trading_date, channel, department, amount, other_note, created_by
    from draft_payment_channel_splits where trading_date = p_trading_date;

  update day_records set
    status = 'APPROVED',
    approved_at = now(),
    approved_by = auth.uid()
  where trading_date = p_trading_date;

  select * into rec from day_records where trading_date = p_trading_date;
  return rec;
end;
$$;

-- transition_day_record() (0018) deliberately left the CASHIER_SUBMITTED
-- -> APPROVED edge unhandled until this function existed. Same signature,
-- so no caller changes; CREATE OR REPLACE adds the missing APPROVED
-- branch AND widens RETURNED to also accept APPROVED as a source state —
-- 0018's version refused that case with "unlock and correct it instead"
-- because nothing existed yet to do the unlocking. There is no separate
-- unlock_day_record(): a director unlocking an approved day for
-- correction IS a return to OPEN, same mechanism, same reason
-- requirement, same "nothing wiped" guarantee — the manager/cashier see
-- their last-submitted drafts exactly as approved and correct from
-- there, then resubmit through the normal MANAGER_SUBMITTED ->
-- CASHIER_SUBMITTED -> APPROVED sequence, which is also what makes
-- deliveries.draft_delivery_id's upsert path (above) ever actually run.
-- edited_after_submit is set HERE, at unlock time, per PLAN_PHASE2.md
-- section 2 ("director unlock ... sets edited_after_submit = true") —
-- not inside approve_day_record(), since unlocking is the moment the
-- system knows a previously-approved day is being reopened, and the flag
-- is sticky (OR'd, never cleared) so it still reads true after any later
-- re-approval.
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
    deadline := (p_trading_date + 1) + time '12:00';
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
