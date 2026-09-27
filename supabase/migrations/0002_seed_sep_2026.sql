-- One-time data load: Sep 9-26, 2026 trading history, from
-- ShellNasuuti_Sales_9-26Sep.xlsx. Margins per Keith (flat across both
-- price periods): PMS 100/L, AGO 98/L, V-Power 102/L, Shop 30%, LPG 10.2%,
-- Lubes 8.4%. Prices per the sheet, which shows a price change on 20/09.
--
-- Not in the source file (left NULL): dips, delivered litres, declared
-- forecourt cash, payment method breakdown, banking, expenses, notes.
-- Safe to re-run: prices/settings/entries are all upserted.

-- ---------------------------------------------------------------------------
-- Prices and margins
-- ---------------------------------------------------------------------------

insert into price_sets (effective_from, pms_price, pms_margin, ago_price, ago_margin, vp_price, vp_margin)
values
  ('2026-09-09', 6680, 100, 6710, 98, 6755, 102),
  ('2026-09-20', 6780, 100, 6870, 98, 6855, 102)
on conflict (effective_from) do update set
  pms_price = excluded.pms_price, pms_margin = excluded.pms_margin,
  ago_price = excluded.ago_price, ago_margin = excluded.ago_margin,
  vp_price = excluded.vp_price, vp_margin = excluded.vp_margin;

update settings
set shop_margin_pct = 30, lpg_margin_pct = 10.2, lubes_margin_pct = 8.4
where id = 1;

-- ---------------------------------------------------------------------------
-- Daily entries (litres sold + non-fuel sales value only)
-- ---------------------------------------------------------------------------

insert into daily_entries (trading_date, sold_pms, sold_ago, sold_vp, shop_sales, lpg_sales, lubes_sales)
values
  ('2026-09-09', 1039.82,  275.39,  130.55,  660200,  817000,  427000),
  ('2026-09-10', 2742.71,  805.15,    0.00, 1059700,  798000,  580000),
  ('2026-09-11', 3425.60,  766.99,  218.86,  807500,  680000,   46500),
  ('2026-09-12', 4242.02, 1333.76,  430.93, 2095200,  740000,  459000),
  ('2026-09-13', 4693.94, 1079.87,  586.69, 1893300,  396000,  940500),
  ('2026-09-14', 3268.84, 1396.20,  958.81,  974900,  284000,  954000),
  ('2026-09-15',   30.68, 1485.56, 3228.71,  903800,  806000, 1364100),
  ('2026-09-16', 2517.91,  988.36, 1114.54,  995100,  292000,  772500),
  ('2026-09-17', 2675.75,  702.32,  553.53,  856700,  412000,  537000),
  ('2026-09-18', 3005.31, 1264.98,  540.93,  959800,  550000,  658500),
  ('2026-09-19', 3871.59,  916.39,  487.66, 1132000,  795000, 1553000),
  ('2026-09-20', 3128.36,  910.66,  414.51, 2152200,  868000,  557000),
  ('2026-09-21', 3068.54, 1503.44,  305.00, 1223300,  713000, 1794000),
  ('2026-09-22', 2578.33,  758.64,  293.68,  869700,  753000,  601000),
  ('2026-09-23', 2828.44,  759.12,  265.90, 1267200,  552000, 1427500),
  ('2026-09-24', 2601.44, 1573.38,  386.79,  955800,  790000, 1206500),
  ('2026-09-25', 2906.55,  931.63,  632.33, 1527800,  912000, 1026000),
  ('2026-09-26', 2694.74, 1036.05,  642.83,     null,    null,    null)
on conflict (trading_date) do update set
  sold_pms = excluded.sold_pms, sold_ago = excluded.sold_ago, sold_vp = excluded.sold_vp,
  shop_sales = excluded.shop_sales, lpg_sales = excluded.lpg_sales, lubes_sales = excluded.lubes_sales;
