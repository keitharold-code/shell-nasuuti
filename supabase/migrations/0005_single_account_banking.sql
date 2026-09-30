-- Single-account banking: from now on all sales (forecourt, shop, LPG,
-- lubes) are banked daily to one account. The account name is
-- admin-configurable rather than hardcoded, and the switchover date is
-- also admin-configurable so historical entries (which used two accounts,
-- Centenary and Exim) are never reinterpreted or migrated.
--
-- No daily_entries columns change: bank_centenary and bank_exim both
-- stay exactly as they are, so "Total banked" (their sum) keeps counting
-- historical Exim amounts correctly. The app simply stops writing to
-- bank_exim going forward — it becomes a read-only historical column.

alter table settings
  add column if not exists banking_account_name text not null default 'Centenary',
  add column if not exists single_account_banking_from date not null default '2026-09-29';
