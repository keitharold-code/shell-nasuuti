-- PLAN_PHASE2.md section 4/7, closing out PLAN.md section 2.4's
-- three-era cash check: `records_go_live_date` is the switch, null until
-- you set it (nothing in Records is authoritative before then).
--
-- The existing unaccounted_sales/cash_not_banked pair (0017) already
-- encodes eras 1 and 2 via the per-day non_fuel_cash_banked_with_forecourt
-- flag (0011) — null/"—" before single-account banking applied, the live
-- formula once it did. This migration adds era 3 as a SEPARATE set of
-- columns (records_expected_cash/records_over_short/records_not_banked),
-- using the exact Section 3 formula cross-verified by hand against the
-- already-backfilled October 2026 data before any Phase 2 code existed —
-- rather than overwriting cash_expected/cash_over_short/unaccounted_sales/
-- cash_not_banked in place, which would silently change what those four
-- names mean for every pre-Records date still read by existing exports.
-- The two old columns are gated to go null (not both-populated) once
-- records_live is true, so a report never shows two disagreeing "is cash
-- accounted for" answers for the same day — exactly one era's figures
-- are ever non-null for any given trading_date.
--
-- pay_credit and pay_cash feed this the same way they feed every other
-- figure once Records is live: derived at approval time (0033) from the
-- day's own credit draws and safe counts, not typed free figures that
-- could disagree with them.
--
-- Rollback: CREATE OR REPLACE v_daily_report back to 0029's version;
-- drop settings.records_go_live_date.

alter table settings
  add column records_go_live_date date;

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
    + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0)) as electronic_paid,
  (coalesce(e.pay_cash, 0) + coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
    + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0)) as total_paid,
  (f.forecourt_sales - (coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
    + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0))) as cash_expected,
  e.forecourt_cash_drop as cash_drop,
  (e.forecourt_cash_drop is not null) as cash_drop_entered,
  case when e.forecourt_cash_drop is not null then
    e.forecourt_cash_drop - (f.forecourt_sales - (coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
      + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0)))
  end as cash_over_short,
  (coalesce(e.bank_centenary, 0) + coalesce(e.bank_exim, 0)) as banked,
  e.non_fuel_cash_banked_with_forecourt as banking_applicable,
  case when e.non_fuel_cash_banked_with_forecourt
    and not (s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date) then
    (f.forecourt_sales + nf.nf_sales)
      - (coalesce(e.pay_cash, 0) + coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
         + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0))
  end as unaccounted_sales,
  case when e.non_fuel_cash_banked_with_forecourt
    and not (s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date) then
    coalesce(e.pay_cash, 0) - coalesce(e.expenses, 0) - (coalesce(e.bank_centenary, 0) + coalesce(e.bank_exim, 0))
  end as cash_not_banked,
  -- New output columns from here on — appended at the end so
  -- CREATE OR REPLACE VIEW doesn't have to move any existing column.
  (s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date) as records_live,
  -- Section 3, era 3: forecourt + non-fuel + other income, minus the
  -- channels that already moved the money out of the till. No legacy
  -- pay_momo term — by the time this era applies, cashier_day_entries
  -- never populates it, so it is correctly always zero here, not merely
  -- omitted for convenience.
  case when s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date then
    (f.forecourt_sales + nf.nf_sales) + coalesce(oi.other_income_total, 0)
      - (coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0) + coalesce(e.pay_airtel, 0)
         + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0) + coalesce(e.pay_credit, 0))
  end as records_expected_cash,
  case when s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date then
    coalesce(e.pay_cash, 0) - (
      (f.forecourt_sales + nf.nf_sales) + coalesce(oi.other_income_total, 0)
      - (coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0) + coalesce(e.pay_airtel, 0)
         + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0) + coalesce(e.pay_credit, 0))
    )
  end as records_over_short,
  case when s.records_go_live_date is not null and e.trading_date >= s.records_go_live_date then
    coalesce(e.pay_cash, 0) - (coalesce(e.bank_centenary, 0) + coalesce(e.bank_exim, 0))
  end as records_not_banked
from daily_entries e
cross join (select records_go_live_date from settings where id = 1) s
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
