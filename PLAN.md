# Shell Nasuuti — Reporting Fixes + Records Module: Phase 0 Plan

Status: **DRAFT — awaiting approval.** Nothing in Phase 1 or Phase 2 starts until
this is signed off, per the phasing in the brief.

### 0. v2 isolation from the live app
All work on this plan happens on the **`v2`** git branch (pushed from
`main` at `8db58ff`, the commit that carries this file). `main` stays
exactly where it is — the station's daily app keeps running from it,
deployed to its existing production Vercel URL, completely unaffected by
anything that happens on `v2` until a deliberate merge.

`v2` pushes get their own Vercel **preview** deployment, at a different URL
from production, auto-created by Vercel's GitHub integration — nothing to
configure. All Phase 1/2 migrations run against the **same** Supabase
project as today (not a second one): this is safe specifically because of
ground rule 1 (additive only) — every new table/column is inert to `main`'s
deployed code, since that code never queries anything this plan adds. The
one place this plan touches an *existing* RLS policy (§2.2, `daily_entries`/
`price_sets` SELECT, once manager/cashier roles exist) will be written so
the predicate evaluates identically to today for `admin`/`entry`/`viewer` —
new conditions only add access for the new roles, they don't remove or
narrow what today's roles already have. So even on the shared database,
`main`'s users see zero behaviour change, now or after merge.

---

## 1. Current state (as of this plan, HEAD `af3f3e1`)

### 1.1 Tables
- `profiles` — `id`, `full_name`, `role` (**CHECK** `admin|entry|viewer`), `is_active`.
- `price_sets` — one row per `effective_from` date: `pms_price`/`pms_margin`,
  `ago_price`/`ago_margin`, `vp_price`/`vp_margin`. This already *is* the
  "effective-dated margin" pattern section 4.1 asks to extend.
- `settings` — singleton (`id=1`): `shop_margin_pct`, `lpg_margin_pct`,
  `lubes_margin_pct`, `stock_tolerance_pct`, `banking_account_name`,
  `single_account_banking_from`.
- `daily_entries` — one row per `trading_date` (**primary key**), flat columns:
  `dip_*`, `deliv_*`, `sold_*` (PMS/AGO/VP), `forecourt_cash_drop`,
  `shop_sales`/`lpg_sales`/`lubes_sales`, `pay_cash`/`pay_momo`/
  `pay_shell_card`/`pay_visa`/`pay_credit`, `bank_centenary`/`bank_exim`,
  `expenses` (one scalar, not categorised), `notes`.
- `audit_log` — table/record/action/old/new/who/when, written only by a
  `SECURITY DEFINER` trigger (`audit_row()`) on `daily_entries`, `price_sets`,
  `settings`. No client-facing write path.

### 1.2 RLS, today
- `is_active_profile()`, `current_role_name()`, `is_admin()`,
  `can_write_entries()` (`admin`+`entry`) — all `SECURITY DEFINER`, reading
  `profiles` without recursing through its own policy.
- **`daily_entries` SELECT and `price_sets` SELECT are both `using
  (is_active_profile())`** — i.e. *any* active profile, including today's
  `entry` and `viewer` roles, can read every column of every day: dips,
  margins, payment splits, banking. There is no column- or field-level
  restriction anywhere in the schema.
- Write: `daily_entries` insert/update needs `can_write_entries()`, delete
  needs `is_admin()`. `price_sets`/`settings` write needs `is_admin()`.

### 1.3 Calculation architecture, today
**Every figure in this app — GP, forecourt sales, cash checks, stock
variance, cumulative stock chains, unaccounted sales, cash not banked — is
computed client-side**, in `src/lib/calc.js`, from rows fetched as-is from
Postgres. Nothing is stored or computed server-side. Reports, KPIs, and both
exports (Excel/PDF) all call the same client-side `compute()`/`totals()`/
`stockChain()`.

### 1.4 Front end
Four tabs (`entry`, `reports`, `admin`, `audit`), gated only by `isAdmin()` at
the tab-visibility level — not by RLS at the data level, because today there's
nothing to hide (everyone who's `is_active_profile()` sees the same full
rows). One `daily_entries` row = one form (`src/pages/entry.js`), filled in
by any `admin`/`entry` user, all fields together.

### 1.5 Edge function
`admin-users` (service-role, `SECURITY DEFINER` check via `profiles.role`):
invite, deactivate, reactivate. Pattern this plan reuses for manager/cashier
account creation and stand-in assignment.

---

## 2. Decisions this plan is making (flagging per your instruction, since
they're not fully determined by the prompt)

### 2.1 "Calculations live server-side" is a bigger change than it looks
Ground rule 1.3 says the client never computes stored values. Today **100%**
of GP/variance/cash-check logic is client-side. Taking this literally means
moving `compute()`/`totals()`/`stockChain()` into Postgres views/functions —
not just the *new* Phase 1 figures, all of them, since the new figures
(stock loss, net profit) are built on top of the existing ones (fuel GP,
forecourt sales) and splitting "old client-side" from "new server-side" would
mean two sources of truth disagreeing at the boundary.

**Decision:** Phase 1 replaces the client calculation engine with Postgres
views (`v_daily_report`, `v_period_discrepancies`, etc.) that the front end
reads instead of computing. This is the single largest piece of Phase 1 —
bigger than any individual line item in section 4 — and it's also what makes
Phase 2's "manager/cashier never see GP" enforceable at all (see 2.2). I'm
flagging it prominently rather than quietly doing a smaller version, because
the effort is materially different from "add some columns."

Existing exports (Excel/PDF) and the Reports screen get re-pointed at the
views' output instead of `calc.js`; the view logic is a direct SQL port of
the current JS so the numbers don't move for existing data. `calc.js` itself
becomes presentation formatting only (currency/litre display), not
arithmetic.

### 2.2 Role-blindness needs table/view separation, not column grants
Supabase/PostgREST authenticates every request as the single Postgres role
`authenticated`, distinguished only by `auth.uid()` inside RLS policies —
there's no per-app-role Postgres login to attach native column-level
`GRANT`/`REVOKE` to. So "manager sees pump price but not margin" or "station
roles never see cost" can't be done with column privileges; it has to be
either (a) separate tables so the sensitive columns simply aren't in
anything a manager/cashier table-level policy can reach, or (b) per-role
views with their own `security_invoker` and RLS. I'm using (a) as the
default — it maps naturally onto the fact that section 5.4/5.5 already
describe manager and cashier as writing to *separate forms* — and (b) only
where a read-only derived figure (like the manager's read-only pump price)
needs to come from a table a director also writes.

**This also forces a rewrite of today's `daily_entries`/`price_sets` SELECT
policies**, which currently grant any active profile the full row — that
blanket grant is correct for `admin`/`entry`/`viewer` but wrong the moment
`manager`/`cashier` exist. The rewritten policy is `is_admin() OR
(current_role_name() IN ('entry','viewer') AND is_active_profile()) OR
(<new, narrower condition for manager/cashier>)` — the first two arms are
exactly today's check, so `admin`/`entry`/`viewer` get identical access
before and after; only the third arm is new. This is the one existing
policy this plan rewrites rather than only adding to, but it's
behaviour-preserving for every role that exists today.

### 2.3 Repeatable rows need child tables; `daily_entries` stays the backbone
Deliveries (5.4.C), credit/prepaid draws (5.4.F/5.5.C/D), structured
expenses (4.9), department-split payment channels (4.3) are all 0–n per day.
They become child tables keyed on `trading_date` (+ product/customer/category
as applicable), not new flat columns on `daily_entries`. `daily_entries`
keeps the single-valued-per-day fields (meters/dips aggregated to litres,
Airtel/MoMo totals, safe count, banking) and gains new nullable columns for
those. Old flat columns (`deliv_*`, `expenses`) are **not dropped** — ground
rule 1 — but Phase 1 adds generated/view columns that aggregate the new
child tables, and new entries populate both old and new where a column still
feeds existing logic (e.g. `deliv_pms` continues to exist and is kept in
sync with the new `deliveries` rows via trigger, so nothing downstream that
still reads `deliv_pms` breaks).

### 2.4 "Additive" vs. two global settings being superseded
Two existing global settings are explicitly superseded by per-day/per-date
concepts in this prompt:
- `settings.single_account_banking_from` (just shipped) → section 4.4's
  per-day `non_fuel_cash_banked_with_forecourt` flag. Keeping both: the old
  column stays (unused going forward, not dropped), the new per-day flag is
  back-filled per your 4.4 instructions, and `calc.js`'s/the new view's
  "bankingApplicable" logic switches from reading the global date to reading
  the per-day flag.
- The current "Unaccounted sales" / "Cash not banked" checks (section 3's
  "Expected cash" / "Over/(Short)" / "Not banked" are *differently defined*
  — Expected cash adds other income and several more payment channels than
  today's formula subtracts) → superseded from the Phase 2 **Records
  go-live date** per section 5.5, with the current formula kept for dates
  before it. This means **three** cash-check formula eras end up coexisting
  in the same view: pre-single-account-banking (today's "—"), single-account
  banking but pre-Records (today's live formula), and post-Records-go-live
  (section 3's formula). The view carries this as an explicit era column
  rather than three copies of similar-looking logic, so it's auditable which
  formula produced which number.

### 2.5 `price_sets` vs. new margin-history needs
Section 4.1 asks to extend the existing dated-margin pattern rather than
duplicate it — agreed, and it already covers PMS/AGO/VP price+margin and
shop/LPG/lubes margin % (currently on the `settings` singleton, *not* dated).
This plan **moves shop/LPG/lubes margins off the `settings` singleton into a
new dated table** (`nonfuel_margins`, mirroring `price_sets`'s shape), since
section 4.1 explicitly asks for dated shop/lubes/LPG margins with add/end-
date/reason, which a singleton can't represent. `settings.shop_margin_pct`
etc. are **not dropped** (ground rule 1) but stop being read once the dated
table has a row covering a given date; a migration back-fills the dated
table from the current singleton value as its first "effective from
2026-09-01" row (matching the shop-margin change date you gave) so no day's
number moves.

---

## 3. Section 3 definitions vs. current code

Checked every definition in section 3 against `calc.js`:

| Definition | Current behaviour | Match? |
|---|---|---|
| Forecourt sales = Σ litres × price | `r.fuelExpected`, exactly this | ✅ |
| Total sales = forecourt + shop + lubes + LPG | `r.totalSales` | ✅ |
| Fuel GP (FIXED mode) = litres × margin | `r.fuelGP` | ✅, becomes the `FIXED` case of the new cost-basis switch |
| Non-fuel GP = Σ sales × margin % | `r.nfGP` | ✅ |
| Total GP = fuel + non-fuel | `r.totalGP` | ✅, "other income NOT included" already true |
| Book closing stock = open + delivered − sold | current daily stock check | ✅, own-use subtraction is new |
| Expected cash formula | **does not match** today's `cashExpected`/`unaccountedSales` | ❌ — see 2.4; new formula is additive (new era), old stays for its own dates |

No definition in section 3 conflicts with anything already built; the gaps
are additions (cost-basis modes, own-use, stock-loss-at-cost, net profit),
and the one formula change (cash) is handled by the era column in 2.4, not a
rewrite of history.

---

## 4. Phase 1 — item-by-item mapping

| § | Item | Schema change | Notes |
|---|---|---|---|
| 4.1 | Dated fuel margins | none — `price_sets` already covers this | Seed V-Power 108 eff. 09/09/2026 as a new `price_sets` row (price unchanged at 6855 unless you tell me otherwise — the prompt gives the *margin* change only) |
| 4.1 | Dated shop/lubes/LPG margins | new table `nonfuel_margins(effective_from, shop_pct, lpg_pct, lubes_pct, reason, created_by)` | Back-fill: shop 30%→22.4% eff. 01/09/2026 (the existing single value becomes two dated rows); lubes 8.4% and LPG 10.2% unchanged, one row each dated at or before 01/09/2026 |
| 4.2 | `vivo_invoices` | new table: invoice no., date, product, invoiced litres, cost/L, total, linked delivery (nullable FK once 5.4.C's `deliveries` table exists) | Director-only RLS from creation — no broadening needed later |
| 4.2 | Fuel cost basis setting | `settings.fuel_cost_basis` (`FIXED` default, `LATEST_INVOICE`, `WEIGHTED_AVG`) | Drives the GP view's unit-cost CTE; "no invoice data → fall back to FIXED and flag" is a view-level `CASE` + a `cost_basis_fallback` flag column in the report output, not stored on the entry |
| 4.3 | Airtel Pay, MTN MoMo Pay | new `daily_entries` columns `pay_airtel`, `pay_momo_mtn` | "Mobile money" legacy history stays in `pay_momo` untouched and keeps counting in totals (same pattern as `bank_exim`) |
| 4.3 | Credit sales, prepaid draws, recoveries, prepaid deposits | new tables, each `(trading_date, customer_id, amount/litres, mode?, created_by)` | `customer_id` FK to new `customers` table (director-maintained, per 5.4.F's "unknown customers blocked" — enforced here too even though Phase 1 has no manager role yet, since directors enter these in Phase 1) |
| 4.3 | Department split per channel | new table `payment_channel_splits(trading_date, channel, department, amount)`, optional | Absent split ⇒ view treats 100% as Forecourt, per spec |
| 4.4 | Per-day banking-mode flag | new `daily_entries.non_fuel_cash_banked_with_forecourt boolean not null default true` | Back-fill exactly as given: Y for 18/19/20/26–30 Sep 2026, N for every other date before 26/09/2026, Y (default) from 26/09 on except as listed — I'll write out the literal date list in the migration so it's checkable against your table, not inferred |
| 4.5 | Own-use, pump test fields | new `daily_entries` columns per product: `pumptest_returned_pms/ago/vp`, `genuse_pms/ago/vp`; new table `other_own_use(trading_date, product, litres, reason)` for the repeatable "other" case | |
| 4.6 | First-day opening dip | new table `opening_stock(product, dip, set_by, set_at)` (singleton-per-product, not per-date — it's the one-time baseline before any `daily_entries` row exists) | Back-fill PMS 1,089 / AGO 1,191 / V-Power 1,713. **09/09 closing dip is still missing — blocking, see §6.** |
| 4.7 | `deliveries` as rows | new table `deliveries(trading_date, product, invoice_no → vivo_invoices, invoiced_litres, dip_before, dip_after, litres_sold_during_offload, truck_reg)` | `deliv_pms/ago/vp` on `daily_entries` kept in sync by trigger (sum of that day's `deliveries.invoiced_litres` per product) so existing stock-chain code paths keep working unmodified during the transition |
| 4.7 | Wet-stock/shortfall columns, Vivo claims view | server-side view, `vivo_claims` view/table (status open/claimed/refunded) | |
| 4.8 | Other income | new table `other_income(trading_date, category, description, amount)` | Back-fill the 645,320 UGX 23/09/2026 Vivo refund row, linked to its claim if `deliveries`/`vivo_invoices` back-fill surfaces a matching shortfall — **I don't have invoice data to confirm a link yet, see §6** |
| 4.9 | Structured expenses | new table `expense_entries(trading_date, category, amount, description, paid_from, receipt_url, created_by)`; `daily_entries.expenses` kept as a generated/trigger-synced sum for backward compat | Staff-cost NSSF: `category='Staff costs'` entry stores gross pay entered; view/trigger adds the 10% and records gross+NSSF as described — need your confirmation this NSSF addition is *also* a stored `expense_entries` line (so it appears in the category breakdown) rather than a report-only adjustment, see §6 |
| 4.10 | Report columns | all come from the new views once 4.1–4.9 land | No new storage |

### Migration sequence (Phase 1, numbered from `0006`)
Each gets its own file so any one is revertable without touching the others.

1. `0006_nonfuel_margins.sql` — new table + back-fill. **Rollback:** drop table (settings columns untouched, so a rollback here doesn't lose current behaviour).
2. `0007_vivo_invoices.sql` — new table + RLS. **Rollback:** drop table.
3. `0008_fuel_cost_basis_setting.sql` — `settings` column + check constraint. **Rollback:** drop column.
4. `0009_payment_channels.sql` — `pay_airtel`, `pay_momo_mtn` columns + `payment_channel_splits` table. **Rollback:** drop column/table.
5. `0010_customers_and_credit_prepaid.sql` — `customers`, `credit_sales`, `prepaid_draws`, `recoveries`, `prepaid_deposits`. **Rollback:** drop tables (no existing code reads them yet).
6. `0011_per_day_banking_flag.sql` — `daily_entries` column + literal-date back-fill. **Rollback:** drop column (view falls back to the global `single_account_banking_from` date it already knows).
7. `0012_own_use_and_pump_tests.sql` — columns + `other_own_use` table. **Rollback:** drop column/table.
8. `0013_opening_stock.sql` — table + PMS/AGO/VP back-fill. **Rollback:** drop table (stock chain reverts to "first entry has no opening stock," today's behaviour).
9. `0014_deliveries.sql` — table + sync trigger onto `deliv_*`. **Rollback:** drop trigger, then table; `deliv_*` columns keep whatever value they already had.
10. `0015_vivo_claims.sql` — table/view linking deliveries, invoices, other_income. **Rollback:** drop.
11. `0016_expense_categories.sql` — `expense_entries` table + sync trigger onto `daily_entries.expenses`. **Rollback:** drop trigger, then table.
12. `0017_reporting_views.sql` — `v_daily_report`, `v_period_totals`, `v_vivo_claims`, etc. (the server-side calc engine, §2.1). **Rollback:** drop views; front end falls back to the current client-side `calc.js` build (kept in the repo, not deleted, until this view is proven correct in production — see §6 test-7 gate).

---

## 5. Phase 2 — item-by-item mapping

### 5.1–5.3 Roles and workflow
- `profiles.role` CHECK widened to `admin|entry|viewer|manager|cashier`
  (additive: existing rows/values unaffected).
- New table `day_records(trading_date primary key, status, manager_submitted_at/by, cashier_submitted_at/by, approved_at/by, returned_reason, returned_by, late_manager, late_cashier, edited_after_submit)`.
  One row per `trading_date`, created on first manager save (defaults `OPEN`).
- New table `role_standins(trading_date, role, standin_user_id, assigned_by)`.
- State machine enforced by a Postgres function (`transition_day_record()`),
  not just client-side checks — "cashier can submit only after manager has"
  etc. are `CHECK`/trigger-level, so a direct API call can't bypass them
  either, matching 5.9 test 2's "through the UI or direct API/RLS calls."

### 5.2 Access model
Per §2.2: manager and cashier get their own narrow tables to write into
(new, Phase 2) rather than reading/writing `daily_entries` directly:
- `manager_day_entries` — mirrors the fields in 5.4 (meters, dips, deliveries
  link, own-use, non-fuel sales, credit/prepaid, forecourt cash drops,
  remarks). RLS: a manager (or their stand-in) can `INSERT`/`UPDATE` their
  own-date rows while `day_records.status = OPEN`; can `SELECT` their own
  submissions list (date + status only, via a restricted view) but not the
  row contents of a submitted/approved day beyond what they entered.
  **Never** granted `SELECT` on `price_sets`, `nonfuel_margins`,
  `vivo_invoices`, or any reporting view.
- `cashier_day_entries` — mirrors 5.5's fields. Same shape of policy,
  gated additionally on `day_records.status >= MANAGER_SUBMITTED` for
  submission (drafts allowed earlier per 5.3).
- On `APPROVED`, a trigger copies/reconciles both into `daily_entries` (and
  the Phase 1 child tables) as the single source of truth reports read —
  so Reports/exports/views never need to know about `day_records` status at
  all; they just see the approved data land, same as a director typing it
  in today. A **Provisional** report view (director-only) reads straight
  from `manager_day_entries`/`cashier_day_entries` for not-yet-approved days.
- Manager's read-only pump price (5.4 "manager sees them read-only"): a
  narrow view `v_manager_prices(effective_from, pms_price, ago_price,
  vp_price)` — price only, no margin — RLS-readable by `manager`.
- Photos: Supabase Storage bucket per record (`day-records/{trading_date}/...`),
  policies mirroring the above (station roles upload, can't list/delete
  other days').

### 5.4–5.5 Forms
Each lettered subsection in 5.4/5.5 maps 1:1 to either a `manager_day_entries`/
`cashier_day_entries` column or one of the Phase 1 child tables reused here
(deliveries, other_own_use, credit_sales, prepaid_draws, recoveries,
prepaid_deposits, expense_entries for "payments from takings") — no new
storage concepts beyond what's already listed in §4, except:
- `nozzle_meters(trading_date, nozzle_id, opening, closing)` — new, since
  today's schema has no per-nozzle concept at all, only per-product totals.
  10 fixed nozzles per your list; `sold_*` on `daily_entries` becomes a
  trigger-maintained sum of (closing−opening) across that product's nozzles,
  minus pump-test-returned and own-use, per the section 3 "litres sold"
  formula — this is the one place a *formula*, not just a figure, changes
  how an existing column gets populated, so it's called out explicitly.
- `meter_reset_events(nozzle_id, new_opening, reason, set_by)` — director-only.
- `safe_counts(trading_date, shift, counted_amount, witness_name, locked_at)`.

### 5.7 WhatsApp copy + hash
No new table — generated client-side from the submitted record at
submission time, hash stored as `day_records.manager_text_hash` /
`cashier_text_hash` (SHA-256 of the normalised text, per your spec).
Verification is a stateless re-normalise-and-compare, no extra storage.

### 5.8 Integrity
`audit_row()` already covers insert/update/delete on any table it's attached
to — extended to every new table in §4 and §5 in the same migration that
creates each table, not bolted on afterward. Soft-delete: every new table
gets a `deleted_at`/`deleted_reason` pair instead of supporting real
deletes; existing `daily_entries`/`price_sets` keep their current
admin-delete behaviour unchanged (ground rule: don't rebuild existing
behaviour).

---

## 6. Open items I need from you before Phase 1 can finish (not blocking Phase 0 approval, but will block specific line items)
1. **09/09/2026 closing dip** — asked for in 4.6, not yet provided.
2. **V-Power price on 09/09/2026** — 4.1 gives the new *margin* (108) but not
   whether the *price* also changed that date; I'll assume price unchanged
   (6855) unless corrected.
3. **23/09/2026 Vivo refund linkage** — I don't have invoice/delivery data
   yet to confirm which shortfall (if any) it clears against; will land as
   an unlinked `other_income` row until invoice data arrives.
4. **NSSF booking** — confirm the auto-added 10% employer NSSF should post
   as its own `expense_entries` line (visible in the category breakdown)
   rather than a report-only addition on top of gross pay.
5. **Section 4.11 test 7** (September totals ≈ UGX 19.6m GP / 562 L stock
   loss) is explicitly gated on "data-entry corrections (provided
   separately)" — not run until that data arrives, per your own instruction.

None of these block approving this plan or starting the migrations in §4
that don't depend on them (everything except the 4.6/4.8 back-fill rows).

---

## 7. What I'm asking you to approve
- The architecture in §2 (server-side views replacing client-side `calc.js`;
  table-separation for role-blindness; child tables for repeatable data;
  the three-era cash-check view; moving shop/LPG/lubes margins to a dated
  table).
- The Phase 1 migration sequence in §4 and Phase 2 data model in §5.
- That I proceed with Phase 1 (§4) now, Phase 2 (§5) only after your
  separate sign-off on Phase 1's results (section 4.11), exactly as you
  specified.

Reply with changes, or "approved," and I'll start on migration `0006`.
