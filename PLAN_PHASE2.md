# Shell Nasuuti — Phase 2 (Records Module) Implementation Plan

Status: **DRAFT — awaiting approval.** No Phase 2 migration starts until this
is signed off, per the same phase-gate rule PLAN.md was approved under.

This builds on PLAN.md §5, which sketched Phase 2 before the full spec
(`NASUUTI_Phase2_Section5.md`, sections 5.1–5.10) existed. Two things below
**supersede** that sketch, per your decisions:

1. **Absa Card** is added as a tracked cashier payment channel, symmetric
   with Shell Card / Centenary Visa / Airtel Pay / MTN MoMo Pay — its own
   column, its own department-split rows, its own line in the cashier
   WhatsApp template and the Expected-cash subtraction set.
2. **Parallel draft tables**, not direct writes into the real Phase 1
   tables with a status filter. Manager and cashier write into new tables
   that exist only for the Records workflow; a single director-approval
   step copies that data into the real tables (`daily_entries`,
   `deliveries`, `credit_prepaid_draws`, …) that Reports/exports/views
   already read. PLAN.md §5.4–5.5's line "maps 1:1 to … one of the Phase 1
   child tables reused here" is **superseded** — every repeatable section
   gets its own `draft_*` table instead of writing into the live one.

---

## 1. The one implementation consequence this forces

Every Phase 1 child table's `trading_date` is a foreign key to
`daily_entries(trading_date)` (see `credit_prepaid_draws`, `recoveries`,
`deliveries`, etc. — `0010`, `0014`). That FK means **a `daily_entries` row
must already exist before any of those tables can hold a row for that
date.**

Under direct-write-with-status-filter, that's fine — the director's Phase 1
flow already creates the `daily_entries` row first. Under parallel drafts,
it's a problem: a manager's first save for a new trading date must **not**
create a real `daily_entries` row (that would make the unapproved day show
up in every Phase 1 report, view, and export immediately — the whole reason
you picked drafts).

**Resolution:** every new `draft_*` table's `trading_date` is a foreign key
to `day_records(trading_date)`, never to `daily_entries(trading_date)`.
`daily_entries` is created for the first time — by the single approval
function, in the same transaction as everything else — only when a day
reaches `APPROVED`. This is the one place this plan makes a call PLAN.md's
Phase 2 sketch didn't anticipate; flagging it rather than doing it quietly,
same as PLAN.md §2 did for its own decisions.

One more consequence: `nozzle_meters`, `meter_reset_events`, `safe_counts`,
and the new `petty_cash_ledger` have **no Phase 1 table to mirror** — they
are brand-new primitives Phase 1 never had a flat-column or child-table
equivalent for. These are *not* `draft_*` tables; they exist once, anchored
to `day_records(trading_date)`, and are simply status-gated for who can
write to them and when (open while `OPEN`, read-only to the submitting role
once their part is submitted, director-unlockable). There's no "copy to the
real table" step for these because there is no older table to copy into —
Reports read them directly (joined against `daily_entries` by date) once a
day is `APPROVED`, exactly the way it will read everything else from that
point on.

---

## 2. State machine (5.1/5.3)

`day_records`:

```
trading_date        date primary key references daily_entries(trading_date) — NO,
                     see §1: no FK to daily_entries. Just `date not null unique`,
                     primary key on trading_date directly.
status               OPEN | MANAGER_SUBMITTED | CASHIER_SUBMITTED | APPROVED | RETURNED
manager_submitted_at/by, cashier_submitted_at/by, approved_at/by
returned_reason, returned_by, returned_at
late_manager bool, late_cashier bool
edited_after_submit bool
```

- Created on the manager's **first draft save** for a date (defaults
  `OPEN`). One row per `trading_date` — `UNIQUE`/PK enforced.
- Default date in both forms is **yesterday**; future dates are rejected by
  a `CHECK` on `day_records.trading_date <= current_date - 1` at the
  database layer, not only in the UI (same reasoning as 5.9 test 2 —
  direct API calls must be blocked too).
- Transitions enforced by a single `SECURITY DEFINER` function,
  `transition_day_record(trading_date, target_status, reason)`, called by
  the submit/return/approve RPCs — never a bare `UPDATE day_records SET
  status = ...` from the client. It checks the legal edge (`OPEN →
  MANAGER_SUBMITTED`, `MANAGER_SUBMITTED → CASHIER_SUBMITTED`,
  `CASHIER_SUBMITTED → APPROVED`, any non-`APPROVED` status → `RETURNED`
  by a director with a reason) and sets `late_manager`/`late_cashier` by
  comparing `now()` (Africa/Kampala) against 10:00/12:00 next-day.
- **`RETURNED` goes back to `OPEN`**, drafts intact (nothing is wiped —
  the director is asking for a correction, not a redo from scratch); the
  next manager/cashier submission re-enters the normal sequence and
  re-generates its own WhatsApp hash, since the content changed. This is
  my call, flagging it as one, since the spec says a day can be returned
  but doesn't say what state it lands in.
- Director unlock of an `APPROVED` day (to fix a mistake after the fact)
  requires a reason, sets `edited_after_submit = true`, and re-runs the
  same approval copy-step so `daily_entries` picks up the correction —
  it does **not** create a second `daily_entries` row or a duplicate
  `order_events`-style ledger entry; Phase 1's existing `audit_row()`
  trigger on `daily_entries` already records the before/after.
- `role_standins(trading_date, role, standin_user_id, assigned_by)` — a
  stand-in for a given date/role is treated identically to the real
  manager/cashier by every RLS check below (`OR` branch, not a separate
  code path).

---

## 3. Access model (5.2)

- `profiles.role` CHECK widened to add `manager`, `cashier` (additive,
  existing rows/values unaffected — same pattern as PLAN.md §5.1).
- New helpers, same `SECURITY DEFINER` style as `is_admin()`:
  `is_manager_for(trading_date)`, `is_cashier_for(trading_date)` — true for
  the profile whose role matches **or** who holds a `role_standins` row for
  that date/role.
- Every `draft_*` table and every new standalone table (`nozzle_meters`,
  `safe_counts`, `petty_cash_ledger`) gets the same shape of policy:
  - `INSERT`/`UPDATE` by the owning role's helper, **and** `day_records`
    is still in the status that role is allowed to edit at (`OPEN` for
    manager fields pre-submission, `MANAGER_SUBMITTED` or earlier for
    cashier drafts per 5.3's "drafts allowed earlier").
  - `SELECT` of **full row contents**: the owning role for their own
    not-yet-submitted work, plus `is_admin()` always. A submitted day's
    contents are visible to the submitting role only through the
    Provisional/approved report, not by re-querying their own draft table
    — satisfied by simply not granting `SELECT` past submission; the
    "date + status only" list view is a separate narrow view
    (`v_my_submissions`), not a relaxed policy on the draft tables.
  - **Never** granted `SELECT` on `price_sets`, `nonfuel_margins`,
    `vivo_invoices`, or any Phase 1 reporting view — unchanged from
    PLAN.md §5.2.
- `v_manager_prices(effective_from, pms_price, ago_price, vp_price)` —
  price only, no margin, `manager`-readable. Exactly as PLAN.md §5.2.
- `v_provisional_report` — director-only, reads `manager_day_entries` /
  `cashier_day_entries` / the `draft_*` tables / `nozzle_meters` directly
  for a date not yet `APPROVED`, applying the same arithmetic as
  `v_daily_report` so a director reviewing a submitted-but-unapproved day
  sees real figures, not a placeholder.
- Storage: one bucket `day-records`, paths
  `day-records/{trading_date}/{role}/{filename}`. Policies: the owning
  role can upload/read their own date's path while editable, `is_admin()`
  always, no cross-date or cross-role listing.

---

## 4. Tables, grouped by kind

**New state/workflow (no Phase 1 mirror):**
`day_records`, `role_standins`.

**New standalone primitives (no Phase 1 mirror, live permanently,
status-gated — see §1):**
`nozzle_meters(trading_date, nozzle_id, opening, closing)` — 10 fixed rows
per day: `PMS1..4`, `AGO1..4`, `VP1..2`.
`meter_reset_events(nozzle_id, new_opening, reason, set_by)` — director-only
write, any time.
`safe_counts(trading_date, shift, counted_amount, witness_name, locked_at)`
— shift in `('day','night')`; `locked_at` set the moment the cashier
confirms the blind count, after which it's read-only to them.
`petty_cash_ledger(trading_date, event_type, amount, note, created_by)` —
`event_type in ('opening','topup','spend','closing')`. No Phase 1 column
ever tracked petty cash, so there's nothing to copy into; this table *is*
the permanent record.

**Draft tables mirroring a Phase 1 table 1:1 (copied at approval, dropped
from "editable" once submitted, never read by Reports directly):**
`manager_day_entries` (dip_pms/ago/vp, shop/lpg/lubes sales figures,
remarks) · `cashier_day_entries` (pay_shell_card/visa/airtel/momo_mtn/
**absa**, bank_centenary, banking_slip_no, banking_slip_photo_url,
non_fuel_cash_banked_with_forecourt override + note) ·
`draft_forecourt_cash_drops(trading_date, shift, amount)` (shift split;
real `daily_entries.forecourt_cash_drop` stays a single summed column,
populated at approval — same "kept + trigger/approve-synced" pattern as
`deliv_pms/ago/vp`) · `draft_deliveries` · `draft_other_own_use` ·
`draft_credit_prepaid_draws` · `draft_recoveries` · `draft_prepaid_deposits`
· `draft_expense_entries` (manager's shop stock-purchases-from-takings +
cashier's payments-from-takings, both land here, `paid_from` distinguishes
them) · `draft_other_income` (shop-excess-over-takings, 5.4.G) ·
`draft_payment_channel_splits` (department split per cashier channel,
including Absa).

**Real-table additions (additive columns on tables that already exist):**
`daily_entries.banking_slip_no`, `daily_entries.banking_slip_photo_url` —
new, nothing wrote these before. `daily_entries.pay_absa` — new, mirrors
`pay_airtel`/`pay_momo_mtn`'s pattern from `0009`.
`payment_channel_splits.channel` CHECK widened to include `'absa'`.
`day_records.manager_text_hash`, `day_records.cashier_text_hash` — SHA-256
of the normalised WhatsApp text (5.7), generated client-side at submission,
stored for later paste-back verification.
`settings.records_go_live_date` — gates the Section 3 cash-check formula
(the third era in PLAN.md §2.4's era column); `null` until you set it.

Every new table gets `audit_row()` (insert/update/delete) and a
`deleted_at`/`deleted_reason` soft-delete pair, per PLAN.md §5.8 —
unchanged.

---

## 5. The approve step

One function, `approve_day_record(trading_date)`, `SECURITY DEFINER`,
callable only when `day_records.status = 'CASHIER_SUBMITTED'` (checked
inside the function, not left to the caller — same "guardrail the callee
owns" reasoning as the Qulr brief's payment-gate rule, applied here on our
own terms). In one transaction it:

1. Computes `sold_pms/ago/vp` from that date's `nozzle_meters`
   (Σ closing−opening per product) minus `pumptest_returned_*` and
   `genuse_*` for that date — the Section 3 "litres sold" formula from
   PLAN.md §5.4–5.5, run exactly once, here, rather than continuously
   (Provisional reporting pre-approval computes the same thing live in
   `v_provisional_report` without storing it).
2. Upserts the first-ever `daily_entries` row for that date from
   `manager_day_entries` + `cashier_day_entries` + the computed `sold_*` +
   the summed `draft_forecourt_cash_drops`.
3. Inserts every `draft_*` row into its real counterpart
   (`deliveries`, `other_own_use`, `credit_prepaid_draws`, `recoveries`,
   `prepaid_deposits`, `expense_entries`, `other_income`,
   `payment_channel_splits`), stamping `created_by` from the original
   draft row so attribution survives the copy.
4. Sets `day_records.status = 'APPROVED'`, `approved_at/by`.

A re-approval (director unlock → fix → re-approve) re-runs the same
function; it upserts `daily_entries` (same primary key) and re-inserts the
child rows rather than duplicating them — the child-table inserts are
guarded by deleting that date's previously-copied rows first, inside the
same transaction, so a correction never doubles a delivery or a credit
sale. `audit_row()` on `daily_entries` and each child table records the
before/after either way.

---

## 6. Screens

- **Manager — "Daily Operations"** (mobile-first): sections A–H exactly as
  5.4 — nozzle meters, tank dips (blind), deliveries (no cost fields),
  own-use/pump-tests, non-fuel sales, credit/prepaid draws (blocked on
  unknown customers), per-shift forecourt cash drops, remarks+photos.
  Server-side draft autosave + on-device backup (client-only, no schema).
  Submit button renders the exact WhatsApp template (5.7), computes its
  hash, stores it, and transitions the day via the RPC.
- **Cashier — "Daily Money"**: sections A–G per 5.5 — safe count (blind,
  locked, witness), payment channels incl. Absa (optional txn count/photo/
  dept split each), recoveries, prepaid deposits, payments from takings
  (incl. ticking the manager's shop purchases to confirm), petty cash
  (opening/top-ups/spend/closing), banking (slip no. + **required** slip
  photo + editable-with-note banking flag). After submit: Expected
  cash/Over(Short)/Not banked per Section 3, tolerance check (default
  UGX 5,000, from `settings`) requiring explanation + responsible person
  if exceeded.
- **Director — Records inbox**: list by status/date with late flags.
  **Day review**: side-by-side manager/cashier submissions plus the
  server's own checks (from `v_provisional_report`), Approve/Return
  (reason required) actions.
- **Director — Settings**: deadlines, tolerance, `records_go_live_date`.
- **Director — User management**: manager/cashier accounts and stand-ins,
  reusing the existing `admin-users` edge function pattern (PLAN.md §1.5).

---

## 7. Migration sequence (numbered from `0018`)

Small and revertible, same discipline as Phase 1's `0006`–`0017`:

1. `0018_day_records_and_roles.sql` — `day_records`, `role_standins`,
   `profiles.role` CHECK widened, `transition_day_record()`.
   **Rollback:** drop function/tables; CHECK widen is harmless to revert
   only if no manager/cashier row exists yet.
2. `0019_nozzle_meters.sql` — `nozzle_meters` + 10-row seed per date on
   first manager draft, `meter_reset_events`. **Rollback:** drop tables.
3. `0020_safe_counts.sql`. **Rollback:** drop table.
4. `0021_petty_cash_ledger.sql`. **Rollback:** drop table.
5. `0022_manager_day_entries.sql` — draft table + RLS.
6. `0023_cashier_day_entries.sql` — draft table incl. `pay_absa` + RLS.
7. `0024_draft_forecourt_cash_drops.sql`.
8. `0025_draft_deliveries_and_own_use.sql`.
9. `0026_draft_credit_prepaid_recoveries_deposits.sql`.
10. `0027_draft_expenses_and_other_income.sql`.
11. `0028_draft_payment_channel_splits.sql` — incl. widening the real
    `payment_channel_splits.channel` CHECK to add `'absa'`, and adding
    `daily_entries.pay_absa`.
12. `0029_banking_slip_fields.sql` — `daily_entries.banking_slip_no/_photo_url`
    + matching `cashier_day_entries` draft columns.
13. `0030_day_records_storage.sql` — `day-records` Storage bucket + RLS
    policies.
14. `0031_approve_day_record.sql` — the function in §5.
15. `0032_whatsapp_hash_columns.sql` — `day_records.manager_text_hash`,
    `cashier_text_hash`.
16. `0033_records_go_live_date.sql` — `settings.records_go_live_date` +
    `CREATE OR REPLACE` on `v_daily_report`/`v_period_discrepancies` to
    add the third cash-check era from PLAN.md §2.4.

Each gets its own commit, same as Phase 1. `tests/0034_phase2_acceptance.sql`
follows last, mirroring `0017_phase1_acceptance.sql`'s self-rolling-back
`DO $$` pattern, covering the 7 tests from 5.9 — including a replay of
04/10/2026 against the already-backfilled October data, which I cross-
checked by hand against this plan's Section 3 formula before writing any
of this.

---

## 8. What I'm asking you to approve

- §1's resolution (draft tables anchor on `day_records`, not
  `daily_entries`; `daily_entries` doesn't exist for a date until
  approval).
- §2's `RETURNED → OPEN`, drafts-intact call.
- The full table list in §4, the approve-function design in §5, the
  screen list in §6, and the migration sequence in §7.
- That I build Phase 2 in the numbered sequence above, one migration at a
  time, same small-reviewable-commit discipline as Phase 1 — and stop for
  your review at natural checkpoints (after §7 item 4, after item 11,
  after item 16) rather than only at the very end.

Reply with changes, or "approved," and I'll start on migration `0018`.
