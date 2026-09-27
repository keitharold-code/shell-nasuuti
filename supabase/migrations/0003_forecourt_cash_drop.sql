-- BUILD_BRIEF.md section 5: forecourt sales, used everywhere in reports and
-- totals, is now always the computed litres x price figure and is never
-- stored — it's derived at read time from sold_* and the price in force.
-- The manually-declared figure becomes forecourt_cash_drop: cash only,
-- used solely for the cash-over/short check (cash drop vs. forecourt sales
-- minus electronic payments).
--
-- Safe as a straight rename: no entry has ever had this column populated
-- (the app only just went live), so there's no data to reinterpret.

alter table daily_entries rename column forecourt_sales to forecourt_cash_drop;
