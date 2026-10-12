-- PLAN_PHASE2.md section 5/7, section 5.7: no new table, per the plan —
-- the WhatsApp copy itself is generated client-side from the submitted
-- record at submission time; only its verification hash is stored.
-- SHA-256 of the normalised text (strip *_~, collapse whitespace, trim
-- lines), computed client-side at the same moment transition_day_record()
-- is called for that submission — this migration only gives it somewhere
-- to live.
--
-- Rollback: drop the two columns.

alter table day_records
  add column manager_text_hash text,
  add column cashier_text_hash text;
