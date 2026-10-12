-- PLAN_PHASE2.md section 4/7, item 11: the Absa Card decision, applied
-- symmetrically with Airtel Pay/MTN MoMo Pay's own 0009 precedent — a
-- real daily_entries column, a widened payment_channel_splits CHECK, and
-- the draft-side table.
--
-- v_daily_report is touched a second time (security_invoker was 0019's
-- reason) for the same reason 0017 itself already folds in Airtel/MoMo:
-- its header note says the pre-go-live cash-check formulas are
-- "extended only to count the two new payment channels this phase adds
-- ... otherwise a payment through either new channel would show as a
-- false 'unaccounted sales' discrepancy." Absa is a third such channel
-- and would open the exact same hole if left out — adding it here keeps
-- that promise rather than leaving a stale gap until 0034's go-live-dated
-- formula replaces this one anyway. Same CREATE OR REPLACE, same output
-- column list, one more coalesce() term in six places.
--
-- Rollback: drop draft_payment_channel_splits; CREATE OR REPLACE
-- v_daily_report back to 0019's version; restore payment_channel_splits'
-- CHECK without 'absa'; drop daily_entries.pay_absa.

alter table daily_entries
  add column if not exists pay_absa numeric;

alter table payment_channel_splits
  drop constraint payment_channel_splits_channel_check;
alter table payment_channel_splits
  add constraint payment_channel_splits_channel_check
  check (channel in ('cash', 'momo', 'shell', 'visa', 'airtel', 'momo_mtn', 'absa'));

create table draft_payment_channel_splits (
  id bigserial primary key,
  trading_date date not null references day_records(trading_date) on delete cascade,
  channel text not null check (channel in ('cash', 'momo', 'shell', 'visa', 'airtel', 'momo_mtn', 'absa')),
  department text not null check (department in ('forecourt', 'shop', 'lubes', 'lpg', 'other')),
  amount numeric not null,
  other_note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index draft_payment_channel_splits_date_idx on draft_payment_channel_splits (trading_date);

create trigger draft_payment_channel_splits_set_created_by
  before insert on draft_payment_channel_splits
  for each row execute function set_created_by();

create trigger draft_payment_channel_splits_audit
  after insert or update or delete on draft_payment_channel_splits
  for each row execute function audit_row();

alter table draft_payment_channel_splits enable row level security;

create policy draft_payment_channel_splits_select on draft_payment_channel_splits
  for select
  using (is_admin() or is_cashier_for(trading_date));

create policy draft_payment_channel_splits_write on draft_payment_channel_splits
  for insert
  with check (can_cashier_edit(trading_date));

create policy draft_payment_channel_splits_update on draft_payment_channel_splits
  for update
  using (can_cashier_edit(trading_date))
  with check (can_cashier_edit(trading_date));

create policy draft_payment_channel_splits_delete_admin on draft_payment_channel_splits
  for delete
  using (is_admin());

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
  case when e.non_fuel_cash_banked_with_forecourt then
    (f.forecourt_sales + nf.nf_sales)
      - (coalesce(e.pay_cash, 0) + coalesce(e.pay_momo, 0) + coalesce(e.pay_shell_card, 0) + coalesce(e.pay_visa, 0)
         + coalesce(e.pay_credit, 0) + coalesce(e.pay_airtel, 0) + coalesce(e.pay_momo_mtn, 0) + coalesce(e.pay_absa, 0))
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
