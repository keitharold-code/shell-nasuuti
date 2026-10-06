// This file has two, deliberately separate, halves — see PLAN.md section
// 2.1 ("calc.js becomes presentation formatting only, not arithmetic").
//
// 1. A LIVE, UNSAVED-DRAFT PREVIEW for the Daily Entry screen (compute(),
//    stockChain(), priceFor(), nonFuelMarginFor()). This is the only
//    arithmetic left in the client, and it is never the source of a
//    reported or exported number — nothing it produces is written to the
//    database. It exists purely so a user typing into the form sees an
//    instant estimate before saving. It intentionally does NOT replicate
//    the server's cost-basis switch (FIXED/LATEST_INVOICE/WEIGHTED_AVG) —
//    that needs invoice/delivery data the entry screen doesn't load — so it
//    always previews on FIXED pricing and says so plainly when the station
//    is actually running a different mode. The authoritative numbers
//    (including cost-basis-aware GP, delivery shortfall, stock loss at
//    cost, net profit) come from the server views via data.js the moment
//    there's a saved entry for the date, and that is what Reports and the
//    exports read exclusively.
// 2. FORMATTING-ONLY helpers for rows that already came back fully
//    computed from v_daily_report / v_discrepancies (COLS, rowVals,
//    totVals, isLit, isSgn, isBankingCheck). These touch no business
//    logic at all — totVals sums figures the server already computed per
//    day, the same kind of presentation-layer aggregation a spreadsheet's
//    own Total row would do, not a second implementation of GP/variance
//    rules.

import { num, has } from "./format.js";

export const PRODUCTS = [
  { k: "PMS", label: "PMS (ULG)" },
  { k: "AGO", label: "AGO" },
  { k: "VP", label: "V-Power" },
];
export const NF = [
  { k: "shop", label: "Shop" },
  { k: "lpg", label: "LPG" },
  { k: "lubes", label: "Lubes" },
];

// =============================================================================
// 1. Live, unsaved-draft preview (Daily Entry screen only)
// =============================================================================

export function priceFor(settings, date) {
  const list = (settings.priceHistory || [])
    .filter((p) => p.from <= date)
    .sort((a, b) => (a.from < b.from ? 1 : -1));
  return list[0] || null;
}

export function nonFuelMarginFor(settings, date) {
  const list = (settings.nonFuelMarginHistory || [])
    .filter((m) => m.from <= date)
    .sort((a, b) => (a.from < b.from ? 1 : -1));
  return list[0] || null;
}

export function prevEntryDate(dates, date) {
  let p = null;
  for (const d of dates) {
    if (d < date) p = d;
    else break;
  }
  return p;
}

/* Cumulative stock check preview: for each product, runs of consecutive
   entries with no delivery. Book stock is carried from the first dip of
   the run; the dip should fall by exactly the litres sold plus own-use. */
export function stockChain(map, settings) {
  const ds = Object.keys(map).sort();
  const out = {};
  const tol = num(settings.tolerance);
  PRODUCTS.forEach(({ k }) => {
    let run = null;
    ds.forEach((d, i) => {
      const e = map[d];
      out[d] = out[d] || {};
      const dip = e.dips && e.dips[k];
      const del = num(e.deliv && e.deliv[k]);
      const sold = num(e.sold && e.sold[k]);
      const ownUse = num(e.genuse && e.genuse[k]);
      const prev = i > 0 ? map[ds[i - 1]] : null;
      const prevDip = prev && prev.dips ? prev.dips[k] : null;
      if (del > 0 || !has(dip) || !has(prevDip)) {
        // delivery day or missing dips: start a fresh run from this day's dip
        out[d][k] = { reset: true, delivery: del > 0 };
        run = has(dip) ? { since: d, startDip: num(dip), cumSold: 0, days: 0 } : null;
        return;
      }
      if (!run) run = { since: ds[i - 1], startDip: num(prevDip), cumSold: 0, days: 0 };
      run.cumSold += sold + ownUse;
      run.days++;
      const book = run.startDip - run.cumSold;
      const cumVar = num(dip) - book;
      const pct = (cumVar / (run.cumSold || 1)) * 100;
      out[d][k] = {
        since: run.since,
        days: run.days,
        book,
        dip: num(dip),
        cumSold: run.cumSold,
        cumVar,
        pct,
        flag: Math.abs(pct) > tol && Math.abs(cumVar) >= 0.5,
      };
    });
  });
  return out;
}

export function compute(e, { settings, entries, dates }) {
  const p = priceFor(settings, e.date);
  const nfm = nonFuelMarginFor(settings, e.date);
  const r = {
    price: p,
    nonFuelMargin: nfm,
    costBasisPreviewOnly: (settings.fuelCostBasis || "FIXED") !== "FIXED",
    fuel: {},
    fuelExpected: 0,
    fuelGP: 0,
    litres: 0,
    ownUseAtCost: 0,
    nf: {},
    nfSales: 0,
    nfGP: 0,
    stock: {},
    stockVarL: 0,
    stockFlags: 0,
  };
  PRODUCTS.forEach(({ k }) => {
    const sold = num(e.sold && e.sold[k]);
    const ownUse = num(e.genuse && e.genuse[k]);
    const pr = p ? num(p[k] && p[k].price) : 0;
    const m = p ? num(p[k] && p[k].margin) : 0;
    const cost = pr - m;
    r.fuel[k] = { sold, value: sold * pr, gp: sold * m, ownUse };
    r.fuelExpected += sold * pr;
    r.fuelGP += sold * m;
    r.litres += sold;
    r.ownUseAtCost += ownUse * cost;
  });
  NF.forEach(({ k }) => {
    const v = num(e[k]);
    const pct = nfm ? num(nfm[k]) : 0;
    const g = (v * pct) / 100;
    r.nf[k] = { sales: v, gp: g };
    r.nfSales += v;
    r.nfGP += g;
  });
  r.totalGP = r.fuelGP + r.nfGP;
  // Expenses are no longer typed as one flat figure (0016) — they're
  // whatever the station has already saved as expense_entries rows for
  // this date, loaded separately by entry.js. This preview simply doesn't
  // guess at a number that lives in a child table it hasn't fetched.
  r.expenses = num(e.expenses);
  r.afterExp = r.totalGP - r.expenses;
  // Forecourt sales, used everywhere in reports/totals, is always the
  // computed litres x price figure (r.fuelExpected) — never blank for a
  // day that has litres and a price in force.
  r.totalSales = r.fuelExpected + r.nfSales;
  const PK = ["payCash", "payMomo", "payShell", "payVisa", "payCredit", "payAirtel", "payMomoMtn"];
  r.paid = PK.reduce((a, k) => a + num(e[k]), 0);
  r.paidEntered = PK.some((k) => has(e[k]));
  r.cashCollected = num(e.payCash);
  // Cash-specific check: what should be left as physical cash is forecourt
  // sales minus what already came in through electronic channels (cash
  // itself is deliberately excluded from this subtraction — it's the thing
  // being checked, not a channel netted out of it). Only meaningful once a
  // cash drop is actually declared. Own-use is already excluded from
  // forecourt sales via "sold", so it never appears here either.
  const electronicPaid =
    num(e.payMomo) + num(e.payShell) + num(e.payVisa) + num(e.payCredit) + num(e.payAirtel) + num(e.payMomoMtn);
  r.cashExpected = r.fuelExpected - electronicPaid;
  r.cashDrop = num(e.forecourtCashDrop);
  r.cashDropEntered = has(e.forecourtCashDrop);
  r.cashOverShort = r.cashDropEntered ? r.cashDrop - r.cashExpected : 0;
  // bankExim is never written by the app for entries dated on/after the
  // single-account switchover, but stays summed for continuity: entries
  // from before the switch were genuinely banked across two accounts, and
  // that history must keep reading correctly.
  r.bankCente = num(e.bankCente);
  r.bankExim = num(e.bankExim);
  r.banked = r.bankCente + r.bankExim;
  r.bankEntered = has(e.bankCente) || has(e.bankExim);

  // Per-day banking flag (0011) replaces the old single global switchover
  // date as the source of "is this day's banking checkable" — it defaults
  // true for a fresh entry but can be set false for a day the station
  // genuinely couldn't bank as one drop.
  r.bankingApplicable = has(e.nonFuelCashBankedWithForecourt)
    ? e.nonFuelCashBankedWithForecourt
    : e.date >= settings.singleAccountBankingFrom;
  r.unaccountedSales = r.bankingApplicable ? r.totalSales - r.paid : null;
  r.cashNotBanked = r.bankingApplicable ? r.cashCollected - r.expenses - r.banked : null;
  const pd = prevEntryDate(dates, e.date);
  const prev = pd ? entries[pd] : null;
  r.prevDate = pd;
  const tol = num(settings.tolerance);
  PRODUCTS.forEach(({ k }) => {
    const dip = e.dips && e.dips[k];
    if (!prev || !prev.dips || !has(prev.dips[k]) || !has(dip)) {
      r.stock[k] = null;
      return;
    }
    const open = num(prev.dips[k]);
    const ownUse = num(e.genuse && e.genuse[k]);
    const book = open + num(e.deliv && e.deliv[k]) - r.fuel[k].sold - ownUse;
    const v = num(dip) - book;
    const delivered = num(e.deliv && e.deliv[k]) > 0;
    const base = r.fuel[k].sold || 1;
    const pct = (v / base) * 100;
    const flag = Math.abs(pct) > tol && Math.abs(v) >= 0.5;
    r.stock[k] = { open, book, dip: num(dip), v, pct, flag, delivered, ownUse };
    r.stockVarL += v;
    if (flag) r.stockFlags++;
  });
  return r;
}

// =============================================================================
// 2. Formatting-only helpers for server-computed report rows
// =============================================================================
// rows here are plain v_daily_report rows (snake_case, already summed/
// computed by Postgres) — nothing in this section performs GP, variance,
// cost-basis or cash-check arithmetic. totVals' sums are a presentation
// Total row over numbers the server already produced per day, exactly like
// a spreadsheet's own Total row — not a second calculation of what those
// numbers should be.

export const COLS = [
  "Date",
  "PMS L",
  "AGO L",
  "V-Power L",
  "Total L",
  "Forecourt sales",
  "Fuel GP",
  "Shop",
  "LPG",
  "Lubes",
  "Non-fuel GP",
  "Total GP",
  "Stock var L",
  "Stock gain/(loss) at cost",
  "Delivery shortfall L",
  "Delivery shortfall at cost",
  "Own-use at cost",
  "Expenses",
  "Other income",
  "Net profit",
  "Cash over/short",
  "Unaccounted sales",
  "Cash not banked",
];

export function rowVals(row) {
  return [
    row.trading_date,
    row.litres_pms,
    row.litres_ago,
    row.litres_vp,
    row.litres_total,
    row.forecourt_sales,
    row.fuel_gp,
    row.shop_sales,
    row.lpg_sales,
    row.lubes_sales,
    row.nf_gp,
    row.total_gp,
    row.stock_var_total,
    row.stock_gain_loss_at_cost,
    row.delivery_shortfall_litres,
    row.delivery_shortfall_at_cost,
    row.own_use_at_cost,
    row.expenses_total,
    row.other_income_total,
    row.net_profit,
    row.cash_over_short,
    row.banking_applicable ? row.unaccounted_sales : null,
    row.banking_applicable ? row.cash_not_banked : null,
  ];
}

// Pure presentation aggregation over already-computed rows — see the file
// header. T starts at 0 for every numeric field and totVals lays it out in
// the same column order as rowVals.
export function totals(rows) {
  const T = {
    days: rows.length,
    pms: 0, ago: 0, vp: 0, litres: 0,
    forecourtSales: 0, fuelGP: 0,
    shop: 0, lpg: 0, lubes: 0, nfGP: 0,
    totalGP: 0, totalSales: 0,
    stockVarTotal: 0, stockGainLossAtCost: 0,
    deliveryShortfallLitres: 0, deliveryShortfallAtCost: 0,
    ownUseAtCost: 0, expensesTotal: 0, otherIncomeTotal: 0, netProfit: 0,
    cashOverShort: 0, unaccountedSales: 0, cashNotBanked: 0,
    bankingChecksApplicable: false,
  };
  rows.forEach((row) => {
    T.pms += num(row.litres_pms);
    T.ago += num(row.litres_ago);
    T.vp += num(row.litres_vp);
    T.litres += num(row.litres_total);
    T.forecourtSales += num(row.forecourt_sales);
    T.fuelGP += num(row.fuel_gp);
    T.shop += num(row.shop_sales);
    T.lpg += num(row.lpg_sales);
    T.lubes += num(row.lubes_sales);
    T.nfGP += num(row.nf_gp);
    T.totalGP += num(row.total_gp);
    T.totalSales += num(row.total_sales);
    T.stockVarTotal += num(row.stock_var_total);
    T.stockGainLossAtCost += num(row.stock_gain_loss_at_cost);
    T.deliveryShortfallLitres += num(row.delivery_shortfall_litres);
    T.deliveryShortfallAtCost += num(row.delivery_shortfall_at_cost);
    T.ownUseAtCost += num(row.own_use_at_cost);
    T.expensesTotal += num(row.expenses_total);
    T.otherIncomeTotal += num(row.other_income_total);
    T.netProfit += num(row.net_profit);
    T.cashOverShort += num(row.cash_over_short);
    if (row.banking_applicable) {
      T.unaccountedSales += num(row.unaccounted_sales);
      T.cashNotBanked += num(row.cash_not_banked);
      T.bankingChecksApplicable = true;
    }
  });
  return T;
}

export function totVals(T) {
  return [
    "Total",
    T.pms, T.ago, T.vp, T.litres,
    T.forecourtSales, T.fuelGP,
    T.shop, T.lpg, T.lubes, T.nfGP, T.totalGP,
    T.stockVarTotal, T.stockGainLossAtCost,
    T.deliveryShortfallLitres, T.deliveryShortfallAtCost,
    T.ownUseAtCost, T.expensesTotal, T.otherIncomeTotal, T.netProfit,
    T.cashOverShort,
    T.bankingChecksApplicable ? T.unaccountedSales : null,
    T.bankingChecksApplicable ? T.cashNotBanked : null,
  ];
}

// Litres columns (plain, 2dp display).
export const isLit = (i) => [1, 2, 3, 4, 12, 14].includes(i);
// Columns where both a positive and a negative value are meaningful and
// get a +/− sign rather than being read as a plain magnitude: Stock var L,
// Stock gain/(loss) at cost, Delivery shortfall L, Delivery shortfall at
// cost, Net profit, Cash over/short.
export const isSgn = (i) => [12, 13, 14, 15, 19, 20].includes(i);
// Unaccounted sales / Cash not banked: can be null — not applicable before
// the per-day banking flag turns banking checks on — and must render as an
// em dash rather than 0, which would read as "checked, fine."
export const isBankingCheck = (i) => i === 21 || i === 22;
