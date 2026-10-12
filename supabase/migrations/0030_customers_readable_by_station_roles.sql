-- Bug found while functionally testing 0026/0027: 0019 swept customers'
-- SELECT policy into the same is_legacy_role() narrowing it applied to
-- every financial Phase 1 table. customers (name/phone/notes) carries no
-- margin, cost, or payment figure — there was never a reason to exclude
-- manager/cashier from it, and doing so broke something real: a manager
-- logging a credit draw (draft_credit_prepaid_draws, 0027) or a cashier
-- logging a recovery/prepaid deposit (same migration) needs to read this
-- table to pick a customer_id at all. Caught by actually running the
-- insert-from-customers statements a manager/cashier form would issue,
-- not by inspecting the policy text.
--
-- Fix: revert to is_active_profile() — the original, correct predicate
-- for this specific table (any active profile, no role restriction),
-- same as it was before 0019 ever touched it. This is deliberately NOT
-- the same fix as the genuinely sensitive tables; customers is simply
-- the wrong table to have swept in.
--
-- Rollback: drop policy, recreate with is_legacy_role().

drop policy customers_select on customers;
create policy customers_select on customers for select using (is_active_profile());
