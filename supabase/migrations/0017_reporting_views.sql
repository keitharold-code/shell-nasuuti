-- Section 2.1 of PLAN.md: moves the calculation engine server-side. This
-- is the single largest migration in Phase 1. Built as layered
-- views/functions so each piece is independently readable and testable,
-- not one monolithic query.
--
-- Two scope notes, since the brief doesn't fully pin these down:
--
-- 1. "Litres sold" (section 3) = meter litres - pump test returned -
--    own-use. Phase 1 has no nozzle-meter capture yet (that's Phase 2,
--    section 5.4.A) — sold_pms/ago/vp is still a single admin-typed
--    number, exactly as it always has been, and that number has always
--    MEANT "litres sold" (net), never a gross meter reading. So own-use
--    and pump-test are NOT subtracted a second time from sold_* here —
--    doing so would double-count them. They're excluded from sales/GP
--    and included in stock reconciliation and expensed at cost purely
--    through this view's own arithmetic. Once Phase 2 lands nozzle
--    meters, sold_* becomes trigger-derived from gross readings minus
--    these same deductions (the literal section-3 formula), and this
--    view's "litres sold" input simply starts coming from a different
--    column — no change needed here.
--
-- 2. Section 3's new "Expected cash" / "Over/(Short)" / "Not banked"
--    definitions are explicitly tied to "the Records go-live date"
--    (section 5.5), a Phase 2 setting that doesn't exist yet. Phase 1
--    keeps the existing (now per-day-flag-driven, from 0011) cash check
--    unchanged in shape, extended only to count the two new payment
--    channels this phase adds (Airtel, MTN MoMo) as "accounted for" —
--    otherwise a payment through either new channel would show as a
--    false "unaccounted sales" discrepancy. The full section-3 formula
--    (other income, recoveries, prepaid deposits, more channels) is
--    Phase 2 work, switched on by records_go_live_date when that
--    migration lands.
--
-- WEIGHTED_AVG cost basis (fn_weighted_avg_cost below) has zero real
-- data to validate against right now — no vivo_invoices rows exist yet.
-- It's implemented to the letter of section 3's definition and exercised
-- with synthetic test data, but flagging it plainly: this is the
-- least-verified piece in Phase 1, and deserves a dedicated look once
-- real invoice data exists. FIXED mode (today's default and actual
-- behaviour) is the one with real numbers behind it.
--
-- Rollback: drop everything this file creates, in reverse order. The
-- front end's fallback is the existing client-side calc.js, kept in the
-- repo unmodified until these views are proven against production data.

-- ---------------------------------------------------------------------------
-- Price / margin in force (direct SQL port of calc.js's priceFor())
-- ---------------------------------------------------------------------------

create function fn_price_in_force(d date)
returns price_sets
language sql stable
set search_path = public
as $$
  select * from price_sets where effective_from <= d order by effective_from desc limit 1;
$$;

create function fn_nonfuel_margin_in_force(d date)
returns nonfuel_margins
language sql stable
set search_path = public
as $$
  select * from nonfuel_margins where effective_from <= d order by effective_from desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Unit cost per the "Fuel cost basis" switch (section 3)
-- ---------------------------------------------------------------------------

create type unit_cost_result as (cost numeric, is_fallback boolean, mode_used text);

create function fn_fixed_cost(ps price_sets, p text)
returns numeric
language sql immutable
as $$
  select case p
    when 'PMS' then ps.pms_price - ps.pms_margin
    when 'AGO' then ps.ago_price - ps.ago_margin
    when 'VP'  then ps.vp_price  - ps.vp_margin
  end;
$$;

-- Runs SECURITY DEFINER so it can read vivo_invoices (director-only RLS)
-- for any caller — but only ever returns a derived cost number, never a
-- raw invoice row, invoice_no, or per-invoice cost. "Station roles never
-- see cost" (4.2) means the vivo_invoices table stays admin-only; the
-- computed effect of cost on GP is report-wide, same as today.
create function fn_weighted_avg_cost(d date, p text, ps price_sets)
returns unit_cost_result
language plpgsql stable
security definer
set search_path = public
as $$
declare
  running_qty numeric;
  running_cost numeric;
  rec record;
  result unit_cost_result;
begin
  select dip into running_qty from opening_stock where product = p;
  running_qty := coalesce(running_qty, 0);
  running_cost := null;

  for rec in
    select
      e.trading_date,
      (case p when 'PMS' then e.sold_pms when 'AGO' then e.sold_ago when 'VP' then e.sold_vp end
        + case p when 'PMS' then coalesce(e.genuse_pms, 0) when 'AGO' then coalesce(e.genuse_ago, 0) when 'VP' then coalesce(e.genuse_vp, 0) end
        + coalesce((select sum(o.litres) from other_own_use o where o.trading_date = e.trading_date and o.product = p), 0)
      ) as outflow,
      (select coalesce(sum(del.invoiced_litres), 0) from deliveries del where del.trading_date = e.trading_date and del.product = p) as delivered_litres,
      -- Simplification, flagged: more than one same-day same-product
      -- delivery with different invoice costs averages them unweighted
      -- rather than weighting by each delivery's own litres. Untested
      -- against real data either way.
      (select avg(vi.cost_per_litre) from deliveries del join vivo_invoices vi on vi.delivery_id = del.id
         where del.trading_date = e.trading_date and del.product = p) as delivered_cost
    from daily_entries e
    where e.trading_date <= d
    order by e.trading_date asc
  loop
    running_qty := running_qty - coalesce(rec.outflow, 0);
    if rec.delivered_litres > 0 then
      if rec.delivered_cost is not null then
        if running_cost is null then
          running_cost := rec.delivered_cost;
        else
          running_cost := ((greatest(running_qty, 0) * running_cost) + (rec.delivered_litres * rec.delivered_cost))
                           / nullif(greatest(running_qty, 0) + rec.delivered_litres, 0);
        end if;
      end if;
      running_qty := running_qty + rec.delivered_litres;
    end if;
  end loop;

  if running_cost is null then
    result.cost := fn_fixed_cost(ps, p);
    result.is_fallback := true;
    result.mode_used := 'FIXED (fallback: no costed delivery yet)';
  else
    result.cost := running_cost;
    result.is_fallback := false;
    result.mode_used := 'WEIGHTED_AVG';
  end if;
  return result;
end;
$$;

create function fn_unit_cost(d date, p text)
returns unit_cost_result
language plpgsql stable
security definer
set search_path = public
as $$
declare
  basis text;
  ps price_sets;
  result unit_cost_result;
  inv_cost numeric;
begin
  select fuel_cost_basis into basis from settings where id = 1;
  ps := fn_price_in_force(d);

  if ps is null then
    result.cost := null; result.is_fallback := true; result.mode_used := 'NO PRICE SET';
    return result;
  end if;

  if basis = 'LATEST_INVOICE' then
    select cost_per_litre into inv_cost
    from vivo_invoices
    where product = p and invoice_date <= d
    order by invoice_date desc, id desc
    limit 1;

    if inv_cost is null then
      result.cost := fn_fixed_cost(ps, p);
      result.is_fallback := true;
      result.mode_used := 'FIXED (fallback: no invoice)';
    else
      result.cost := inv_cost;
      result.is_fallback := false;
      result.mode_used := 'LATEST_INVOICE';
    end if;
    return result;
  end if;

  if basis = 'WEIGHTED_AVG' then
    return fn_weighted_avg_cost(d, p, ps);
  end if;

  -- FIXED, or any unrecognised value: fail safe to FIXED rather than error.
  result.cost := fn_fixed_cost(ps, p);
  result.is_fallback := (basis is distinct from 'FIXED');
  result.mode_used := case when basis = 'FIXED' then 'FIXED' else 'FIXED (fallback: unknown basis)' end;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Unpivoted per-product daily base: one row per (trading_date, product).
-- LAG() gives "previous entry's dip" in one pass instead of correlated
-- subqueries; the very first entry per product falls back to
-- opening_stock.
-- ---------------------------------------------------------------------------

create view v_product_days as
with unpivoted as (
  -- deliv is coalesced to 0 here, not left NULL: a day with no delivery
  -- IS a delivery of zero (calc.js: num(e.deliv && e.deliv[k])), unlike
  -- dip, which stays NULL to mean "no reading taken" — collapsing that
  -- distinction would wrongly zero out a real missing-dip day instead of
  -- a genuinely-no-delivery one. Un-coalesced deliv silently NULLed every
  -- downstream sum it touched (total_variance, is_reset, day_flag,
  -- cum_var...) on every no-delivery day — caught by querying this view
  -- directly against the test database and finding day_flag/cum_flag
  -- blank (NULL) instead of true/false on far more rows than the known
  -- flagged days.
  select e.trading_date, 'PMS' as product, e.sold_pms as sold, e.dip_pms as dip, coalesce(e.deliv_pms, 0) as deliv,
         coalesce(e.genuse_pms, 0) as genuse,
         coalesce(e.pumptest_returned_pms, 0) as pumptest_returned
  from daily_entries e
  union all
  select e.trading_date, 'AGO', e.sold_ago, e.dip_ago, coalesce(e.deliv_ago, 0),
         coalesce(e.genuse_ago, 0), coalesce(e.pumptest_returned_ago, 0)
  from daily_entries e
  union all
  select e.trading_date, 'VP', e.sold_vp, e.dip_vp, coalesce(e.deliv_vp, 0),
         coalesce(e.genuse_vp, 0), coalesce(e.pumptest_returned_vp, 0)
  from daily_entries e
),
with_lag as (
  select u.*,
    lag(u.dip) over (partition by u.product order by u.trading_date) as lag_dip,
    row_number() over (partition by u.product order by u.trading_date) = 1 as is_first_entry
  from unpivoted u
)
select
  w.trading_date,
  w.product,
  w.sold,
  w.deliv,
  w.dip,
  w.genuse + coalesce((select sum(o.litres) from other_own_use o
    where o.trading_date = w.trading_date and o.product = w.product), 0) as own_use,
  w.pumptest_returned,
  -- Only the TRUE first entry for a product falls back to opening_stock.
  -- A later entry whose immediate predecessor simply has no recorded dip
  -- (09/09/2026 -> 10/09/2026, specifically — see PLAN.md section 6)
  -- correctly gets NULL here too, same as lag_dip, rather than being
  -- silently reset to the opening baseline as if nothing came before it.
  case when w.is_first_entry
    then (select os.dip from opening_stock os where os.product = w.product)
    else w.lag_dip
  end as prev_dip
from with_lag w;

-- ---------------------------------------------------------------------------
-- Per delivery: shortfall per section 4.7's own-line formula.
-- shortfall = (dip after - dip before + litres sold during offload) -
-- invoiced litres. Only computable when both dips were actually taken.
-- ---------------------------------------------------------------------------

create view v_delivery_shortfall as
select
  d.id as delivery_id,
  d.trading_date,
  d.product,
  d.invoice_no,
  d.invoiced_litres,
  d.dip_before,
  d.dip_after,
  d.litres_sold_during_offload,
  (d.dip_after - d.dip_before + d.litres_sold_during_offload) as actual_received,
  (d.dip_after - d.dip_before + d.litres_sold_during_offload) - d.invoiced_litres as shortfall_litres,
  (uc.rec).cost as unit_cost,
  ((d.dip_after - d.dip_before + d.litres_sold_during_offload) - d.invoiced_litres) * (uc.rec).cost as shortfall_at_cost
from deliveries d
cross join lateral (select fn_unit_cost(d.trading_date, d.product) as rec) as uc
where d.dip_before is not null and d.dip_after is not null;

-- ---------------------------------------------------------------------------
-- Per product per day: ties litres/stock (v_product_days) to price/cost,
-- GP, and that day's delivery shortfall.
-- ---------------------------------------------------------------------------

create view v_fuel_by_product as
select
  pd.trading_date,
  pd.product,
  pd.sold,
  pd.own_use,
  pd.pumptest_returned,
  pd.deliv,
  pd.dip,
  pd.prev_dip,
  prm.price,
  prm.margin,
  uc.cost,
  uc.is_fallback as cost_is_fallback,
  uc.mode_used as cost_mode_used,
  pd.sold * prm.price as fuel_value,
  pd.sold * (prm.price - uc.cost) as fuel_gp,
  case when pd.prev_dip is not null
    then pd.prev_dip + pd.deliv - pd.sold - pd.own_use
  end as book_closing_stock,
  case when pd.prev_dip is not null and pd.dip is not null
    then pd.dip - (pd.prev_dip + pd.deliv - pd.sold - pd.own_use)
  end as total_variance,
  -- Percentage base is sold-litres-or-1 (never a bare divide-by-sold),
  -- matching calc.js's `base = sold || 1` exactly: a zero-sales day with
  -- any dip movement is exactly the case most worth flagging, not one to
  -- silently treat as 0% variance by dividing by a sold of zero.
  case when pd.prev_dip is not null and pd.dip is not null
    then (pd.dip - (pd.prev_dip + pd.deliv - pd.sold - pd.own_use)) / (case when pd.sold = 0 then 1 else pd.sold end) * 100
  end as day_pct,
  case when pd.prev_dip is not null and pd.dip is not null
    then abs((pd.dip - (pd.prev_dip + pd.deliv - pd.sold - pd.own_use)) / (case when pd.sold = 0 then 1 else pd.sold end) * 100) > st.stock_tolerance_pct
      and abs(pd.dip - (pd.prev_dip + pd.deliv - pd.sold - pd.own_use)) >= 0.5
    else false
  end as day_flag,
  coalesce(ds.shortfall_litres_sum, 0) as delivery_shortfall_litres,
  coalesce(ds.shortfall_at_cost_sum, 0) as delivery_shortfall_at_cost,
  case when pd.prev_dip is not null and pd.dip is not null
    then (pd.dip - (pd.prev_dip + pd.deliv - pd.sold - pd.own_use)) - coalesce(ds.shortfall_litres_sum, 0)
  end as operational_variance
from v_product_days pd
cross join (select stock_tolerance_pct from settings where id = 1) st
cross join lateral (select fn_price_in_force(pd.trading_date) as rec) as pf
cross join lateral (select (pf.rec).* ) as ps
cross join lateral (select
    case pd.product when 'PMS' then ps.pms_price when 'AGO' then ps.ago_price when 'VP' then ps.vp_price end as price,
    case pd.product when 'PMS' then ps.pms_margin when 'AGO' then ps.ago_margin when 'VP' then ps.vp_margin end as margin
  ) as prm
cross join lateral (select fn_unit_cost(pd.trading_date, pd.product) as rec) as ucf
cross join lateral (select (ucf.rec).*) as uc
left join lateral (
  select sum(shortfall_litres) as shortfall_litres_sum, sum(shortfall_at_cost) as shortfall_at_cost_sum
  from v_delivery_shortfall s
  where s.trading_date = pd.trading_date and s.product = pd.product
) as ds on true;

-- ---------------------------------------------------------------------------
-- Cumulative stock chain (direct port of calc.js's stockChain()): runs of
-- consecutive entries since the last delivery/reset. Uses the count of
-- reset events up to and including each row as the run identifier — a
-- standard "gaps and islands" pattern.
-- ---------------------------------------------------------------------------

create view v_stock_chain as
with base as (
  select
    pd.trading_date, pd.product, pd.sold, pd.dip, pd.deliv,
    (pd.deliv > 0 or pd.dip is null or pd.prev_dip is null) as is_reset
  from v_product_days pd
),
runs as (
  select b.*,
    sum(case when b.is_reset then 1 else 0 end) over (partition by b.product order by b.trading_date) as run_id
  from base b
),
run_start as (
  select product, run_id, min(trading_date) as since, (array_agg(dip order by trading_date))[1] as start_dip
  from runs
  where not is_reset or trading_date = (select min(trading_date) from runs r2 where r2.product = runs.product and r2.run_id = runs.run_id)
  group by product, run_id
),
numbered as (
  select r.*,
    -- Counts entries within the run, reset row included as 0 — the reset
    -- row itself is day 0, the first real day of the run is 1, matching
    -- the JS's run.days++ (starts at 0, increments once per non-reset
    -- day processed). A plain count, not calendar-day arithmetic, since
    -- a missing entry's date gap must not inflate the day count.
    row_number() over (partition by r.product, r.run_id order by r.trading_date) - 1 as days_in_run,
    sum(r.sold) over (partition by r.product, r.run_id order by r.trading_date) as running_sold
  from runs r
)
select
  n.trading_date,
  n.product,
  n.is_reset,
  n.deliv > 0 as is_delivery,
  case when not n.is_reset then rs.since end as since,
  case when not n.is_reset then n.days_in_run end as days,
  case when not n.is_reset then n.running_sold end as cum_sold,
  case when not n.is_reset then rs.start_dip - n.running_sold end as cum_book,
  case when not n.is_reset then n.dip - (rs.start_dip - n.running_sold) end as cum_var,
  -- Same sold-or-1 percentage base as v_fuel_by_product.day_pct, applied
  -- to the run's cumulative sold litres instead of the day's — direct
  -- port of calc.js's `pct = cumVar / (run.cumSold || 1) * 100`.
  case when not n.is_reset then
    (n.dip - (rs.start_dip - n.running_sold))
      / (case when n.running_sold = 0 then 1 else n.running_sold end) * 100
  end as cum_pct,
  case when not n.is_reset then
    abs((n.dip - (rs.start_dip - n.running_sold))
      / (case when n.running_sold = 0 then 1 else n.running_sold end) * 100) > st.stock_tolerance_pct
    and abs(n.dip - (rs.start_dip - n.running_sold)) >= 0.5
  else false
  end as cum_flag
from numbered n
join run_start rs on rs.product = n.product and rs.run_id = n.run_id
cross join (select stock_tolerance_pct from settings where id = 1) st;

-- ---------------------------------------------------------------------------
-- Discrepancies (direct port of calc.js's discrepancies()): a flagged row
-- per product per day where either the daily or cumulative check trips
-- the tolerance, with the reason text matching the existing app exactly.
-- ---------------------------------------------------------------------------

-- Reads day_flag/cum_flag straight off v_fuel_by_product/v_stock_chain
-- rather than recomputing the percentage here — a second copy of the
-- sold-or-1 formula is a second place for the same bug to creep back in.
create view v_discrepancies as
select
  f.trading_date,
  f.product,
  f.sold,
  (f.deliv > 0) as delivered,
  f.total_variance as day_var,
  f.day_pct,
  sc.since,
  sc.days,
  sc.cum_var,
  sc.cum_pct,
  case
    when f.day_flag and f.deliv = 0
      then 'Dip doesn''t match sales, no delivery'
    when f.day_flag
      then 'Variance on delivery day — check delivery quantity'
    else 'Cumulative variance since last delivery'
  end as reason
from v_fuel_by_product f
join v_stock_chain sc on sc.trading_date = f.trading_date and sc.product = f.product
where f.day_flag or sc.cum_flag;

-- ---------------------------------------------------------------------------
-- Non-fuel GP per day.
-- ---------------------------------------------------------------------------

create view v_nonfuel_gp as
select
  e.trading_date,
  e.shop_sales, e.lpg_sales, e.lubes_sales,
  coalesce(e.shop_sales, 0) + coalesce(e.lpg_sales, 0) + coalesce(e.lubes_sales, 0) as nf_sales,
  coalesce(e.shop_sales, 0) * nm.shop_pct / 100
    + coalesce(e.lpg_sales, 0) * nm.lpg_pct / 100
    + coalesce(e.lubes_sales, 0) * nm.lubes_pct / 100 as nf_gp
from daily_entries e
cross join lateral (select fn_nonfuel_margin_in_force(e.trading_date) as rec) as nmf
cross join lateral (select (nmf.rec).*) as nm;

-- ---------------------------------------------------------------------------
-- The main daily report — what the app's Reports screen and both exports
-- read. Ties fuel, non-fuel, stock loss, delivery shortfall, other
-- income, structured expenses (+ own-use at cost, synthetic — see this
-- file's header note), and the cash checks together into one row per day.
-- ---------------------------------------------------------------------------

create view v_daily_report as
select
  e.trading_date,
  f.litres_pms, f.litres_ago, f.litres_vp, f.litres_total,
  f.forecourt_sales,
  f.fuel_gp,
  f.cost_fallback_used,
  nf.shop_sales, nf.lpg_sales, nf.lubes_sales, nf.nf_sales, nf.nf_gp,
  (f.fuel_gp + nf.nf_gp) as total_gp,
  (f.forecourt_sales + nf.nf_sales) as total_sales,
  f.stock_var_pms, f.stock_var_ago, f.stock_var_vp, f.stock_var_total,
  f.operational_var_total,
  f.stock_gain_loss_at_cost,
  (f.fuel_gp + nf.nf_gp + f.stock_gain_loss_at_cost) as gp_after_stock_loss,
  f.delivery_shortfall_litres, f.delivery_shortfall_at_cost,
  f.own_use_at_cost,
  coalesce(e.expenses, 0) as expenses_stored,
  coalesce(e.expenses, 0) + f.own_use_at_cost as expenses_total,
  coalesce(oi.other_income_total, 0) as other_income_total,
  (f.fuel_gp + nf.nf_gp + f.stock_gain_loss_at_cost)
    - f.delivery_shortfall_at_cost
    + coalesce(oi.other_income_total, 0)
    - (coalesce(e.expenses, 0) + f.own_use_at_cost) as net_profit,
  -- Cash checks: unchanged shape from the existing app, extended to the
  -- two new payment channels this phase adds (see this file's header,
  -- note 2 — the section-3 Expected-cash formula is Phase 2 work).
  e.pay_cash as cash_collected,
  (coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0) + coalesce(e.pay_credit, 0)
    + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0)) as electronic_paid,
  (coalesce(e.pay_cash, 0) + coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
    + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0)) as total_paid,
  (f.forecourt_sales - (coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
    + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0))) as cash_expected,
  e.forecourt_cash_drop as cash_drop,
  (e.forecourt_cash_drop is not null) as cash_drop_entered,
  case when e.forecourt_cash_drop is not null then
    e.forecourt_cash_drop - (f.forecourt_sales - (coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
      + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0)))
  end as cash_over_short,
  (coalesce(e.bank_centenary, 0) + coalesce(e.bank_exim, 0)) as banked,
  e.non_fuel_cash_banked_with_forecourt as banking_applicable,
  case when e.non_fuel_cash_banked_with_forecourt then
    (f.forecourt_sales + nf.nf_sales)
      - (coalesce(e.pay_cash, 0) + coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
         + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0))
  end as unaccounted_sales,
  case when e.non_fuel_cash_banked_with_forecourt then
    coalesce(e.pay_cash, 0) - coalesce(e.expenses, 0) - (coalesce(e.bank_centenary, 0) + coalesce(e.bank_exim, 0))
  end as cash_not_banked
from daily_entries e
join lateral (
  select
    sum(case when pf.product = 'PMS' then pf.sold end) as litres_pms,
    sum(case when pf.product = 'AGO' then pf.sold end) as litres_ago,
    sum(case when pf.product = 'VP' then pf.sold end) as litres_vp,
    sum(pf.sold) as litres_total,
    sum(pf.fuel_value) as forecourt_sales,
    sum(pf.fuel_gp) as fuel_gp,
    bool_or(pf.cost_is_fallback) as cost_fallback_used,
    sum(case when pf.product = 'PMS' then pf.total_variance end) as stock_var_pms,
    sum(case when pf.product = 'AGO' then pf.total_variance end) as stock_var_ago,
    sum(case when pf.product = 'VP' then pf.total_variance end) as stock_var_vp,
    sum(pf.total_variance) as stock_var_total,
    sum(pf.operational_variance) as operational_var_total,
    sum(pf.operational_variance * pf.cost) as stock_gain_loss_at_cost,
    sum(pf.delivery_shortfall_litres) as delivery_shortfall_litres,
    sum(pf.delivery_shortfall_at_cost) as delivery_shortfall_at_cost,
    sum(pf.own_use * pf.cost) as own_use_at_cost
  from v_fuel_by_product pf
  where pf.trading_date = e.trading_date
) as f on true
join lateral (select nf0.nf_sales, nf0.nf_gp, nf0.shop_sales, nf0.lpg_sales, nf0.lubes_sales
  from v_nonfuel_gp nf0 where nf0.trading_date = e.trading_date) as nf on true
left join lateral (select sum(amount) as other_income_total from other_income oi0
  where oi0.trading_date = e.trading_date) as oi on true;
