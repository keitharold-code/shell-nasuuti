-- PLAN_PHASE2.md section 4/7. Section 5.5.G: the bank deposit slip number
-- and its (required) photo. "Required" is enforced at the UI layer, at
-- the moment the cashier tries to submit — same treatment as the
-- tolerance-exceeded explanation in the same section, and as this
-- table's own banking_flag_note (0024): neither is a figure a CHECK
-- constraint can usefully police, and a NOT NULL here would block
-- legitimate partial saves while the cashier is still filling in earlier
-- sections.
--
-- Rollback: drop the two columns from both tables.

alter table daily_entries
  add column if not exists banking_slip_no text,
  add column if not exists banking_slip_photo_url text;

alter table cashier_day_entries
  add column banking_slip_no text,
  add column banking_slip_photo_url text;
