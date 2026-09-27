-- Backfill closing dips and delivered litres for Sep 9-26, 2026, from
-- Keith's paper/other records. Rows already exist from the earlier sales
-- import (0002); this only fills the dip_*/deliv_* columns, leaving
-- everything else on each row untouched.
--
-- 09/09 has no dip on record (blank in the source) — left NULL rather
-- than 0, so the app correctly treats it as "not recorded" rather than
-- an empty tank. That means the stock chain has nothing to check 09/09
-- against and effectively starts from 09/10 onward, same as the
-- prototype's "opening stock will show once an earlier day is saved"
-- behaviour for any first entry.

update daily_entries d set
  dip_pms = v.dip_pms, dip_ago = v.dip_ago, dip_vp = v.dip_vp,
  deliv_pms = v.deliv_pms, deliv_ago = v.deliv_ago, deliv_vp = v.deliv_vp
from (values
  ('2026-09-09'::date,  null,  null,  null, 20000, 10000,  null),
  ('2026-09-10'::date, 17223, 10125,  1565,  null,  null,  null),
  ('2026-09-11'::date, 13782,  9353, 11312,  null,  null, 10000),
  ('2026-09-12'::date,  9500,  7977, 10871,  null,  null,  null),
  ('2026-09-13'::date,  4833,  6953, 10282,  null,  null,  null),
  ('2026-09-14'::date,  1548,  5533,  9320,  null,  null,  null),
  ('2026-09-15'::date,  1516,  4052,  6236,  null,  null,  null),
  ('2026-09-16'::date, 18871, 13039,  4989, 20000, 10000,  null),
  ('2026-09-17'::date, 16217, 12315,  4446,  null,  null,  null),
  ('2026-09-18'::date, 13189, 11089,  3911,  null,  null,  null),
  ('2026-09-19'::date,  9290, 10162,  3415,  null,  null,  null),
  ('2026-09-20'::date,  6214,  9256,  3018,  null,  null,  null),
  ('2026-09-21'::date,  3120,  7722,  2722,  null,  null,  null),
  ('2026-09-22'::date, 10486,  7011,  2403, 10000,  null,  null),
  ('2026-09-23'::date,  7677,  6238,  7069,  null,  null,  5000),
  ('2026-09-24'::date,  5053,  4659,  6727,  null,  null,  null),
  ('2026-09-25'::date,  9104,  3714,  6090,  7000,  null,  null),
  ('2026-09-26'::date, 11402,  2688,  5431,  5000,  null,  null)
) as v(trading_date, dip_pms, dip_ago, dip_vp, deliv_pms, deliv_ago, deliv_vp)
where d.trading_date = v.trading_date;
