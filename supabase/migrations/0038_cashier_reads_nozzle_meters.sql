-- Found wiring the cashier form: Section 3's Expected Cash needs
-- forecourt sales (litres sold x price), and litres sold comes from
-- nozzle_meters, which 0020 made manager/admin-readable only. A cashier
-- computing their own pre-approval preview (the real figure only exists
-- once the director approves, same as every other preview in this app)
-- needs to read it too.
--
-- Litres are not margin, cost, or payment data — nothing in PLAN_PHASE2.md's
-- role-blindness reasoning (section 3) was ever about hiding a litre
-- count, only margins/cost/cash. Widening this one SELECT policy to
-- include the cashier (read-only — the INSERT/UPDATE policies are
-- untouched, still manager-only via can_manager_edit) is a narrow,
-- justified exception, not a retreat from the principle.
--
-- Same reasoning applies one step further: the Expected Cash formula
-- also needs non-fuel sales VALUE and the litres deducted before "sold"
-- (genuse/pumptest), both on manager_day_entries (0023) — also manager/
-- admin-only until now. A sales VALUE is not a margin or a cost; widening
-- this one too for the same read-only reason.
--
-- Rollback: drop both policies, recreate with 0020/0023's original
-- predicates.

drop policy nozzle_meters_select on nozzle_meters;
create policy nozzle_meters_select on nozzle_meters
  for select
  using (is_admin() or is_manager_for(trading_date) or is_cashier_for(trading_date));

drop policy manager_day_entries_select on manager_day_entries;
create policy manager_day_entries_select on manager_day_entries
  for select
  using (is_admin() or is_manager_for(trading_date) or is_cashier_for(trading_date));
