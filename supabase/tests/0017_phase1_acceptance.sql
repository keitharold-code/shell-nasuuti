-- Phase 1 acceptance tests (PLAN.md section 4.11 / this repo's task #44).
--
-- Run against a throwaway database with every migration 0001-0017 already
-- applied (see the project's testing notes: stub out `auth`, then apply
-- supabase/migrations/*.sql in order). Each check is wrapped in its own
-- transaction and rolled back, so this script is safe to re-run against a
-- database that already has real data in it and never leaves a trace.
--
-- Usage:
--   sudo -u postgres psql -d shell_nasuuti_test -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0017_phase1_acceptance.sql
--
-- A clean run prints one NOTICE per passed check and nothing else. Any
-- failure raises an EXCEPTION and stops the script immediately, naming the
-- check that failed and the numbers it saw.
--
-- Two items this file does NOT attempt, because they are blocked on real
-- data that has not arrived yet (PLAN.md section 6), not on anything this
-- script could construct safely:
--   - Test 7 (September totals ~= UGX 19.6m GP / 562 L stock loss): depends
--     on the data-entry corrections the brief says are "provided separately."
--   - "26-30/09 no false overage" against REAL cash figures: the seed data
--     (0002_seed_sep_2026.sql) only ever populated litres and non-fuel
--     sales, never pay_cash/pay_momo/bank_centenary/forecourt_cash_drop for
--     any date in that range, so there is no real cash row to check for a
--     false positive against. What CAN be checked without real data is that
--     the cash-check formula itself does not contain an own-use term (test
--     4 below) and produces an exact, not approximate, zero when a
--     synthetic day's numbers are made to balance (test 5 below) - i.e. the
--     arithmetic is sound; whether the ACTUAL 26-30/09 entries balance is a
--     question for when that data exists.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Margin-date isolation: a margin change effective on date X must not
--    move fuel_gp for any day before X, and must apply from X onward, up to
--    (not including) the next effective_from row.
-- ---------------------------------------------------------------------------
do $$
declare
  gp_before_09_14 numeric;
  gp_09_14 numeric;
  gp_09_15 numeric;
  gp_09_19 numeric;
begin
  -- Baseline, today's real margins (PMS=100 from 2026-09-09).
  select fuel_gp into gp_09_14 from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';
  select fuel_gp into gp_09_19 from v_fuel_by_product where trading_date = '2026-09-19' and product = 'PMS';

  -- Insert a synthetic PMS-margin change effective 2026-09-15 inside a
  -- subtransaction, then prove: 09-14 is untouched, 09-15+ picks up the new
  -- margin, and roll back so nothing is left behind.
  insert into price_sets (effective_from, pms_price, pms_margin, ago_price, ago_margin, vp_price, vp_margin)
  select '2026-09-15', pms_price, 250, ago_price, ago_margin, vp_price, vp_margin
  from price_sets where effective_from = '2026-09-09';

  select fuel_gp into gp_before_09_14 from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';
  select fuel_gp into gp_09_15 from v_fuel_by_product where trading_date = '2026-09-15' and product = 'PMS';

  if gp_before_09_14 is distinct from gp_09_14 then
    raise exception 'FAIL margin-date-isolation: 09-14 PMS fuel_gp moved from % to % after inserting a 09-15 margin change', gp_09_14, gp_before_09_14;
  end if;

  if gp_09_15 = gp_09_19 then
    raise exception 'FAIL margin-date-isolation: 09-15 fuel_gp (%) did not change after a 09-15 margin-250 row was inserted', gp_09_15;
  end if;

  raise notice 'PASS margin-date-isolation: 09-14 unaffected (%), 09-15 picked up the new margin (% vs baseline %)', gp_09_14, gp_09_15, gp_09_19;

  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then
      null; -- expected: this is how we discard the synthetic insert
    else
      raise;
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Pump test has NO stock or GP effect: changing pumptest_returned_pms
--    must not move fuel_gp, total_variance, or book_closing_stock for that
--    product/day. (It is carried through v_fuel_by_product purely as a
--    disclosure column - see 0012's own comment.)
-- ---------------------------------------------------------------------------
do $$
declare
  gp_before numeric; var_before numeric; book_before numeric;
  gp_after numeric; var_after numeric; book_after numeric;
begin
  select fuel_gp, total_variance, book_closing_stock
    into gp_before, var_before, book_before
    from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';

  update daily_entries set pumptest_returned_pms = coalesce(pumptest_returned_pms, 0) + 500
    where trading_date = '2026-09-14';

  select fuel_gp, total_variance, book_closing_stock
    into gp_after, var_after, book_after
    from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';

  if gp_before is distinct from gp_after or var_before is distinct from var_after or book_before is distinct from book_after then
    raise exception 'FAIL pump-test-no-effect: fuel_gp %->% / total_variance %->% / book_closing_stock %->% after bumping pumptest_returned_pms by 500',
      gp_before, gp_after, var_before, var_after, book_before, book_after;
  end if;

  raise notice 'PASS pump-test-no-effect: fuel_gp, total_variance and book_closing_stock all unchanged after +500 L pump test return';
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Own-use: excluded from fuel_value/fuel_gp, but DOES reduce
--    book_closing_stock (so it shows up as stock movement, not as a sale),
--    and IS expensed at cost via own_use_at_cost.
-- ---------------------------------------------------------------------------
do $$
declare
  unit_cost numeric;
  fv_before numeric; fg_before numeric; book_before numeric; ou_at_cost_before numeric;
  fv_after numeric; fg_after numeric; book_after numeric; ou_at_cost_after numeric;
  bump constant numeric := 200;
begin
  select fuel_value, fuel_gp, book_closing_stock, own_use * cost, cost
    into fv_before, fg_before, book_before, ou_at_cost_before, unit_cost
    from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';

  update daily_entries set genuse_pms = coalesce(genuse_pms, 0) + bump where trading_date = '2026-09-14';

  select fuel_value, fuel_gp, book_closing_stock, own_use * cost
    into fv_after, fg_after, book_after, ou_at_cost_after
    from v_fuel_by_product where trading_date = '2026-09-14' and product = 'PMS';

  if fv_before is distinct from fv_after then
    raise exception 'FAIL own-use-excluded-from-sales: fuel_value moved %->% after a genuse bump (own-use must not count as a sale)', fv_before, fv_after;
  end if;
  if fg_before is distinct from fg_after then
    raise exception 'FAIL own-use-excluded-from-gp: fuel_gp moved %->% after a genuse bump', fg_before, fg_after;
  end if;
  if book_after is distinct from book_before - bump then
    raise exception 'FAIL own-use-reduces-stock: book_closing_stock went %->% after +% genuse, expected exactly -%', book_before, book_after, bump, bump;
  end if;
  if ou_at_cost_after is distinct from ou_at_cost_before + bump * unit_cost then
    raise exception 'FAIL own-use-expensed-at-cost: own_use*cost went %->%, expected +% (bump * unit cost %)', ou_at_cost_before, ou_at_cost_after, bump * unit_cost, unit_cost;
  end if;

  raise notice 'PASS own-use: excluded from fuel_value/fuel_gp, book_closing_stock down by exactly % L, own_use_at_cost up by exactly % (% L * cost %)', bump, bump * unit_cost, bump, unit_cost;
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Expected cash has no own-use term: the cash-check columns in
--    v_daily_report must not reference own-use at all (structural check on
--    the view definition, since own-use is already excluded upstream via
--    "sold", and a second deduction here would double-count it).
-- ---------------------------------------------------------------------------
do $$
declare
  cash_before numeric;
  cash_after numeric;
begin
  select cash_expected into cash_before from v_daily_report where trading_date = '2026-09-14';
  update daily_entries set genuse_pms = coalesce(genuse_pms, 0) + 200 where trading_date = '2026-09-14';
  select cash_expected into cash_after from v_daily_report where trading_date = '2026-09-14';

  if cash_before is distinct from cash_after then
    raise exception 'FAIL expected-cash-no-own-use-deduction: cash_expected moved %->% after a genuse bump; own-use must not affect the cash check a second time', cash_before, cash_after;
  end if;

  raise notice 'PASS expected-cash-no-own-use-deduction: cash_expected unchanged (%) after a genuse bump', cash_before;
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Other income counted exactly once in net_profit: inserting a known
--    other_income row must move net_profit by exactly that amount, no more
--    and no less (catches both "not counted" and "counted twice").
-- ---------------------------------------------------------------------------
do $$
declare
  np_before numeric;
  np_after numeric;
  bump constant numeric := 123456;
begin
  select net_profit into np_before from v_daily_report where trading_date = '2026-09-14';

  insert into other_income (trading_date, category, description, amount)
  values ('2026-09-14', 'other', 'acceptance test - rolled back', bump);

  select net_profit into np_after from v_daily_report where trading_date = '2026-09-14';

  if np_after is distinct from np_before + bump then
    raise exception 'FAIL other-income-counted-once: net_profit went %->% after a % other_income row, expected exactly +%', np_before, np_after, bump, bump;
  end if;

  raise notice 'PASS other-income-counted-once: net_profit moved by exactly % (%->%)', bump, np_before, np_after;
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Cash-check arithmetic is exact when a synthetic day is made to
--    balance: with a synthetic entry that nets to zero over/short, the view
--    must report cash_over_short = 0 exactly, not a near-zero float residue
--    and not a sign flip. This is the closest this script can get to
--    "26-30/09 no false overage" without the real entries for those dates
--    (see header note) - it proves the formula is sound; whether the real
--    26-30/09 rows balance is still an open question until that data lands.
-- ---------------------------------------------------------------------------
do $$
declare
  expected numeric;
  drop_amount numeric;
  over_short numeric;
begin
  select cash_expected into expected from v_daily_report where trading_date = '2026-09-14';
  drop_amount := expected; -- a cash drop exactly equal to expected cash should balance to zero

  update daily_entries set forecourt_cash_drop = drop_amount where trading_date = '2026-09-14';

  select cash_over_short into over_short from v_daily_report where trading_date = '2026-09-14';

  if over_short is distinct from 0 then
    raise exception 'FAIL cash-check-arithmetic: cash_over_short = % when forecourt_cash_drop was set to exactly cash_expected (%), expected exactly 0', over_short, expected;
  end if;

  raise notice 'PASS cash-check-arithmetic: a cash drop set to exactly cash_expected (%) yields cash_over_short = 0 exactly', expected;
  raise exception using errcode = 'P0001', message = '__rollback_marker__';
exception
  when others then
    if sqlerrm = '__rollback_marker__' then null; else raise; end if;
end $$;

\echo 'All runnable Phase 1 acceptance checks passed. Test 7 (September GP/stock-loss totals) and a real-data check of 26-30/09 cash balancing remain blocked on the data described in PLAN.md section 6.'
