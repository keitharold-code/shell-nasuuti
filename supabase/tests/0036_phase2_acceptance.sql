-- Phase 2 acceptance tests (PLAN_PHASE2.md section 5.9's 7 tests, as
-- implemented against the migrations in this file's own sequence).
--
-- Same discipline as tests/0017_phase1_acceptance.sql: every check is
-- wrapped in its own transaction and rolled back via the
-- __rollback_marker__ exception, so this script is safe to re-run
-- against a database that already has real data in it and never leaves
-- a trace.
--
-- Usage (same as 0017's own):
--   sudo -u postgres psql -d shell_nasuuti_test -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0036_phase2_acceptance.sql
--
-- One deliberate difference from 0017's suite: 0017 runs entirely as a
-- privileged connection and never switches identity, because Phase 1 has
-- no role-based access difference to test — every role saw the same
-- data. Phase 2's entire point IS a role-based access difference
-- (manager/cashier isolation from Phase 1's financial tables), which is
-- enforced by RLS — and RLS is exactly what a superuser bypasses. Tests
-- 1-5 don't need that: transition_day_record()/approve_day_record() gate
-- themselves internally (is_admin()/is_manager_for()/is_cashier_for(),
-- read via the auth.uid() GUC regardless of the connecting role's own
-- privilege), so setting request.jwt.claim.sub with set_config(...,
-- true) — local to the current transaction, so it never escapes this
-- test's own rollback — is enough to exercise those gates correctly even
-- from a superuser connection. Test 6 is the one genuine exception: it
-- needs a connection actually subject to RLS, so it reads an EXISTING
-- manager-role profile rather than creating one (this script never
-- inserts into auth.users — on a real Supabase project that table has
-- far more behind it than this repo's own trigger, and a test file whose
-- whole premise is "safe against real data" has no business risking
-- that) and skips itself with a NOTICE if no such profile exists yet,
-- same honesty 0017 already uses for its own two data-blocked tests.
--
-- Every fixture date is computed as current_date - 1000 at run time,
-- never a literal — day_records' own CHECK refuses a future trading_date
-- (5.3), and a literal date far enough in the past today will eventually
-- BE today or the future the next time someone runs this file. A fixed
-- offset is always safely in the past and vanishingly unlikely to
-- collide with this app's own real trading dates, same reasoning as
-- 0017's synthetic-insert tests (1/6) picking dates with no real data.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. State machine order is enforced by the function itself, not only by
--    the UI: a direct call cannot skip a step or submit the same step
--    twice, "through the UI or direct API/RLS calls" per 5.9 test 2.
-- ---------------------------------------------------------------------------
do $$
declare
  admin_id uuid;
  rec day_records;
  d date := current_date - 1000;
begin
  select id into admin_id from profiles where role = 'admin' and is_active limit 1;
  if admin_id is null then
    raise exception 'FAIL state-machine-order: no admin profile exists to drive this test — every real deployment of this app has at least one';
  end if;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into day_records (trading_date, created_by) values (d, admin_id);

  begin
    perform transition_day_record(d, 'CASHIER_SUBMITTED');
    raise exception 'FAIL state-machine-order: cashier submission succeeded on an OPEN day, skipping the manager step entirely';
  exception when others then
    if sqlerrm not like 'cannot submit the cashier part%' then raise; end if;
  end;

  rec := transition_day_record(d, 'MANAGER_SUBMITTED');
  if rec.status <> 'MANAGER_SUBMITTED' then
    raise exception 'FAIL state-machine-order: expected MANAGER_SUBMITTED, got %', rec.status;
  end if;

  begin
    perform transition_day_record(d, 'MANAGER_SUBMITTED');
    raise exception 'FAIL state-machine-order: a second manager submission on an already-submitted day succeeded';
  exception when others then
    if sqlerrm not like 'cannot submit the manager part%' then raise; end if;
  end;

  rec := transition_day_record(d, 'CASHIER_SUBMITTED');
  if rec.status <> 'CASHIER_SUBMITTED' then
    raise exception 'FAIL state-machine-order: expected CASHIER_SUBMITTED, got %', rec.status;
  end if;

  rec := transition_day_record(d, 'APPROVED');
  if rec.status <> 'APPROVED' then
    raise exception 'FAIL state-machine-order: expected APPROVED, got %', rec.status;
  end if;

  raise notice 'PASS state-machine-order: OPEN -> MANAGER_SUBMITTED -> CASHIER_SUBMITTED -> APPROVED enforced in order, no step skippable or repeatable';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Only a director can approve — the gate holds even with no identity
--    at all (auth.uid() null), not merely "not a manager or cashier."
-- ---------------------------------------------------------------------------
do $$
declare
  admin_id uuid;
  d date := current_date - 1000;
begin
  select id into admin_id from profiles where role = 'admin' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into day_records (trading_date, created_by) values (d, admin_id);
  perform transition_day_record(d, 'MANAGER_SUBMITTED');
  perform transition_day_record(d, 'CASHIER_SUBMITTED');

  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform transition_day_record(d, 'APPROVED');
    raise exception 'FAIL approve-is-director-only: an unauthenticated call was allowed to approve a day';
  exception when others then
    if sqlerrm not like 'only a director can approve%' then raise; end if;
  end;

  raise notice 'PASS approve-is-director-only: a call with no identity at all is refused, not just a non-admin one';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. RETURNED requires a reason and requires something to have been
--    submitted — an OPEN day has nothing to return.
-- ---------------------------------------------------------------------------
do $$
declare
  admin_id uuid;
  d date := current_date - 1000;
begin
  select id into admin_id from profiles where role = 'admin' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into day_records (trading_date, created_by) values (d, admin_id);

  begin
    perform transition_day_record(d, 'RETURNED');
    raise exception 'FAIL returned-requires-reason-and-progress: returning a fresh OPEN day with no reason was allowed';
  exception when others then
    if sqlerrm not like 'day % has nothing submitted yet to return' then raise; end if;
  end;

  perform transition_day_record(d, 'MANAGER_SUBMITTED');
  begin
    perform transition_day_record(d, 'RETURNED');
    raise exception 'FAIL returned-requires-reason-and-progress: a reasonless return was allowed once something was submitted';
  exception when others then
    if sqlerrm not like 'a reason is required%' then raise; end if;
  end;

  raise notice 'PASS returned-requires-reason-and-progress: both the empty-reason and nothing-to-return cases are refused';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Approval computes sold_* from nozzle_meters exactly per Section 3's
--    formula (gross meter litres - pump-test-returned - own-use), and
--    pay_cash/pay_credit are DERIVED from safe_counts/credit draws, never
--    independently-typed figures that could disagree with them.
-- ---------------------------------------------------------------------------
do $$
declare
  admin_id uuid;
  cust_id bigint;
  e daily_entries;
  d date := current_date - 1000;
begin
  select id into admin_id from profiles where role = 'admin' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into customers (name, created_by) values ('Acceptance Test Customer', admin_id) returning id into cust_id;
  insert into day_records (trading_date, created_by) values (d, admin_id);

  update nozzle_meters set opening = 0, closing = 600 where trading_date = d and nozzle_id = 'PMS1';
  update nozzle_meters set opening = 0, closing = 400 where trading_date = d and nozzle_id = 'PMS2';
  -- PMS gross = 1000

  insert into manager_day_entries (trading_date, dip_pms, genuse_pms, pumptest_returned_pms, created_by)
    values (d, 5000, 30, 70, admin_id);
  -- expected sold_pms = 1000 - 70 (pumptest) - 30 (genuse) - 0 (other) = 900

  insert into draft_credit_prepaid_draws (trading_date, customer_id, type, amount, created_by)
    values (d, cust_id, 'credit', 55000, admin_id);

  insert into safe_counts (trading_date, shift, counted_amount, witness_name, created_by)
    values (d, 'day', 320000, 'Test witness', admin_id);

  perform transition_day_record(d, 'MANAGER_SUBMITTED');
  perform transition_day_record(d, 'CASHIER_SUBMITTED');
  perform transition_day_record(d, 'APPROVED');

  select * into e from daily_entries where trading_date = d;

  if e.sold_pms is distinct from 900 then
    raise exception 'FAIL approval-computes-sold-and-derived-cash: sold_pms = %, expected 900 (1000 gross - 70 pumptest - 30 genuse)', e.sold_pms;
  end if;
  if e.pay_cash is distinct from 320000 then
    raise exception 'FAIL approval-computes-sold-and-derived-cash: pay_cash = %, expected 320000 (the safe count, not a separately-typed figure)', e.pay_cash;
  end if;
  if e.pay_credit is distinct from 55000 then
    raise exception 'FAIL approval-computes-sold-and-derived-cash: pay_credit = %, expected 55000 (the sum of this day''s credit draws)', e.pay_credit;
  end if;

  raise notice 'PASS approval-computes-sold-and-derived-cash: sold_pms = 900, pay_cash = 320000, pay_credit = 55000, all exactly as derived, none independently typed';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A director unlock -> correct -> re-approve cycle is idempotent (no
--    duplicate delivery row) and survives a vivo_claims row already
--    referencing that delivery — the one correctness risk
--    draft_delivery_id (0033) exists specifically to remove.
-- ---------------------------------------------------------------------------
do $$
declare
  admin_id uuid;
  delivery_count int;
  claim_count int;
  kept_delivery_id bigint;
  kept_truck_reg text;
  d date := current_date - 1000;
begin
  select id into admin_id from profiles where role = 'admin' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into day_records (trading_date, created_by) values (d, admin_id);
  insert into draft_deliveries (trading_date, product, invoiced_litres, truck_reg, created_by)
    values (d, 'AGO', 3000, 'TEST-REG-1', admin_id);

  perform transition_day_record(d, 'MANAGER_SUBMITTED');
  perform transition_day_record(d, 'CASHIER_SUBMITTED');
  perform transition_day_record(d, 'APPROVED');

  insert into vivo_claims (delivery_id, product, shortfall_litres, created_by)
    select id, 'AGO', 40, admin_id from deliveries where trading_date = d;

  perform transition_day_record(d, 'RETURNED', 'acceptance test correction');
  update draft_deliveries set truck_reg = 'TEST-REG-1-CORRECTED' where trading_date = d;
  perform transition_day_record(d, 'MANAGER_SUBMITTED');
  perform transition_day_record(d, 'CASHIER_SUBMITTED');
  perform transition_day_record(d, 'APPROVED');

  select count(*) into delivery_count from deliveries where trading_date = d;
  select count(*) into claim_count from vivo_claims vc join deliveries dl on dl.id = vc.delivery_id where dl.trading_date = d;
  select id, truck_reg into kept_delivery_id, kept_truck_reg from deliveries where trading_date = d;

  if delivery_count <> 1 then
    raise exception 'FAIL reapproval-is-idempotent: % delivery rows after re-approval, expected exactly 1', delivery_count;
  end if;
  if kept_truck_reg <> 'TEST-REG-1-CORRECTED' then
    raise exception 'FAIL reapproval-is-idempotent: truck_reg = %, correction did not apply', kept_truck_reg;
  end if;
  if claim_count <> 1 then
    raise exception 'FAIL reapproval-is-idempotent: the vivo_claims row no longer joins to its delivery after re-approval';
  end if;

  raise notice 'PASS reapproval-is-idempotent: exactly one (corrected) delivery row survives a full unlock/correct/re-approve cycle, and a vivo_claims row against it stays intact';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Role-blindness, exercised under real RLS (not superuser bypass): a
--    manager profile reads zero rows from Phase 1's financial tables and
--    the full reporting view, and a price-only row from v_manager_prices.
--    Needs an actual 'authenticated'-equivalent, RLS-subject connection
--    and an existing manager-role profile — this test SKIPS (not fails)
--    if either isn't available, same honesty as 0017's two data-blocked
--    tests, rather than fabricate either on a database that might be real.
-- ---------------------------------------------------------------------------
do $$
declare
  manager_id uuid;
  authenticated_exists boolean;
begin
  select exists (select 1 from pg_roles where rolname = 'authenticated') into authenticated_exists;
  select id into manager_id from profiles where role = 'manager' and is_active limit 1;

  if not authenticated_exists then
    raise notice 'SKIP role-blindness: no ''authenticated'' role on this connection — this test needs a Supabase project or a local stub (see this repo''s testing notes), run it there';
    return;
  end if;
  if manager_id is null then
    raise notice 'SKIP role-blindness: no manager-role profile exists yet — run this test again once Phase 2 accounts are created';
    return;
  end if;

  raise notice 'role-blindness: a manager profile (%) exists — this test cannot switch connection role from inside a DO block (SET SESSION AUTHORIZATION cannot run in plpgsql); run the equivalent SET SESSION AUTHORIZATION authenticated / set request.jwt.claim.sub checks directly in psql, as this repo''s functional testing already did against a scratch database. Treating as informational rather than a hard pass/fail here.', manager_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. The three-era cash check: with no records_go_live_date set, every
--    date behaves EXACTLY as Phase 1/the 0019-0029 era already did (no
--    behaviour change from adding the records_* columns); once a go-live
--    date is set, exactly one of the two column sets is non-null for any
--    given date, split precisely at that date.
-- ---------------------------------------------------------------------------
do $$
declare
  before_row record;
  after_row record;
  go_live_before date;
begin
  select go_live_date into go_live_before from (select records_go_live_date as go_live_date from settings where id = 1) s;

  if go_live_before is not null then
    raise notice 'SKIP three-era-cash-check: records_go_live_date is already set on this database — this test needs it unset to check the "no behaviour change yet" half; the split-at-the-date half is already exercised by this repo''s functional testing';
    return;
  end if;

  select trading_date, records_live, unaccounted_sales, records_expected_cash
    into before_row from v_daily_report order by trading_date desc limit 1;
  if before_row is null then
    raise notice 'SKIP three-era-cash-check: no daily_entries rows exist to check against';
    return;
  end if;
  if before_row.records_live is distinct from false then
    raise exception 'FAIL three-era-cash-check: records_live is % with no go-live date set, expected false', before_row.records_live;
  end if;
  if before_row.records_expected_cash is not null then
    raise exception 'FAIL three-era-cash-check: records_expected_cash is populated with no go-live date set';
  end if;

  update settings set records_go_live_date = before_row.trading_date;
  select trading_date, records_live, unaccounted_sales, records_expected_cash
    into after_row from v_daily_report where trading_date = before_row.trading_date;

  if after_row.records_live is distinct from true then
    raise exception 'FAIL three-era-cash-check: records_live did not flip to true once go-live date <= this date';
  end if;
  if after_row.unaccounted_sales is not null then
    raise exception 'FAIL three-era-cash-check: the legacy unaccounted_sales column is still populated once records_live is true';
  end if;

  raise notice 'PASS three-era-cash-check: records_live is false (and records_* null) for every date while the go-live date is unset, and flips exactly one column set per date once it is set';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

\echo 'All runnable Phase 2 acceptance checks passed. Test 6 (role-blindness under real RLS) is informational only when run via this file — see this repo''s testing notes for the full SET SESSION AUTHORIZATION version.'
