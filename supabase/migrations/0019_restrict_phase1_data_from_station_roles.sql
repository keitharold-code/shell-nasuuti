-- Not in PLAN_PHASE2.md's numbered sequence — found while implementing
-- 0018, flagging it here rather than folding it in silently.
--
-- Every Phase 1 table's SELECT policy is `using (is_active_profile())`,
-- i.e. "any active profile" — it was written back when the only roles
-- were admin/entry/viewer, all of whom are supposed to see everything.
-- It does NOT check role at all. Now that 0018 allows 'manager' and
-- 'cashier' profiles to exist, the moment one is created it would see
-- every margin, cost, and payment figure in the business — exactly the
-- leak PLAN.md section 2.2 already flagged needing a fix for, but that
-- note only named daily_entries/price_sets; in fact EVERY Phase 1 table
-- shares the same bare `is_active_profile()` policy, so the fix is
-- the same swap everywhere, not just those two.
--
-- Fix: a new helper, is_legacy_role(), true for exactly the three
-- Phase 1 roles — functionally identical to is_active_profile() for
-- admin/entry/viewer (behaviour-preserving, per PLAN.md section 0's "no
-- behaviour change" promise) and false for manager/cashier/anyone else.
-- Every affected SELECT policy is dropped and recreated with this
-- predicate in place of is_active_profile(). Write policies are untouched
-- — can_write_entries() already only matches admin/entry, so manager/
-- cashier could never write to these tables anyway.
--
-- Second half: the 7 views in 0017 are, by default, evaluated with the
-- VIEW OWNER's row-security standing, not the querying session's — the
-- standard Postgres mechanism for building a "restricted view" (see
-- CREATE VIEW's security_invoker option). That's irrelevant while every
-- active profile has full access anyway, but it means narrowing the
-- table policies above would NOT, by itself, stop a manager/cashier from
-- reading full figures through v_daily_report etc. — the view would keep
-- running as its owner and ignore their narrower table grants entirely.
-- `security_invoker = true` makes each view evaluate against the ACTUAL
-- calling role instead, so the table-level narrowing above take effect
-- through the view too. For admin/entry/viewer this changes nothing
-- (their own policies already grant the same full access the owner-based
-- bypass was providing) — it only closes the gap for manager/cashier.
--
-- v_manager_prices is the deliberate exception: it's created WITHOUT
-- security_invoker specifically so it keeps working for a role whose own
-- price_sets policy is now false — that's the whole point of a
-- price-only, no-margin view (PLAN_PHASE2.md section 3).
--
-- Rollback: drop is_legacy_role(); recreate all 15 policies with
-- is_active_profile(); CREATE OR REPLACE each of the 7 views without
-- security_invoker; drop v_manager_prices. Fully inert to Phase 1 — no
-- column, row, or figure changes, only who else (if anyone, today) can
-- read them.

create function is_legacy_role()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() in ('admin', 'entry', 'viewer');
$$;

-- ---------------------------------------------------------------------------
-- Narrow every Phase 1 table's SELECT policy.
-- ---------------------------------------------------------------------------

drop policy price_sets_select on price_sets;
create policy price_sets_select on price_sets for select using (is_legacy_role());

drop policy settings_select on settings;
create policy settings_select on settings for select using (is_legacy_role());

drop policy daily_entries_select on daily_entries;
create policy daily_entries_select on daily_entries for select using (is_legacy_role());

drop policy nonfuel_margins_select on nonfuel_margins;
create policy nonfuel_margins_select on nonfuel_margins for select using (is_legacy_role());

drop policy payment_channel_splits_select on payment_channel_splits;
create policy payment_channel_splits_select on payment_channel_splits for select using (is_legacy_role());

drop policy customers_select on customers;
create policy customers_select on customers for select using (is_legacy_role());

drop policy other_own_use_select on other_own_use;
create policy other_own_use_select on other_own_use for select using (is_legacy_role());

drop policy opening_stock_select on opening_stock;
create policy opening_stock_select on opening_stock for select using (is_legacy_role());

drop policy deliveries_select on deliveries;
create policy deliveries_select on deliveries for select using (is_legacy_role());

drop policy expense_entries_select on expense_entries;
create policy expense_entries_select on expense_entries for select using (is_legacy_role());

do $$
declare t text;
begin
  foreach t in array array['credit_prepaid_draws', 'recoveries', 'prepaid_deposits', 'other_income', 'vivo_claims'] loop
    execute format('drop policy %I_select on %I;', t, t);
    execute format('create policy %I_select on %I for select using (is_legacy_role());', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Recreate the Phase 1 reporting views with security_invoker = true.
-- Same SELECT list as 0017 — this is a storage-option change only.
-- ---------------------------------------------------------------------------

create or replace view v_product_days with (security_invoker = true) as
with unpivoted as (
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
  case when w.is_first_entry
    then (select os.dip from opening_stock os where os.product = w.product)
    else w.lag_dip
  end as prev_dip
from with_lag w;

create or replace view v_delivery_shortfall with (security_invoker = true) as
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

create or replace view v_fuel_by_product with (security_invoker = true) as
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

create or replace view v_stock_chain with (security_invoker = true) as
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

create or replace view v_discrepancies with (security_invoker = true) as
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

create or replace view v_nonfuel_gp with (security_invoker = true) as
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

create or replace view v_daily_report with (security_invoker = true) as
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

-- ---------------------------------------------------------------------------
-- v_manager_prices — the one deliberate exception: NO security_invoker, so
-- it keeps resolving against the view owner's standing even though
-- price_sets_select is now false for 'manager'. Price only, no margin —
-- 5.4's "manager sees pump price read-only".
-- ---------------------------------------------------------------------------

create view v_manager_prices as
select effective_from, pms_price, ago_price, vp_price
from price_sets;
