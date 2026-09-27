// Calculation engine — ported from the prototype (nasuuti-daily-gp.html)
// per BUILD_BRIEF.md section 5, with one deliberate deviation from that
// prototype: forecourt sales (used everywhere in reports/totals) is always
// the computed litres × price figure, never a manually-typed one — so it's
// never blank for a day that has litres and a price in force. The
// manually-typed field is `forecourtCashDrop`: cash physically dropped,
// used only for the cash-specific over/short check against cash expected
// (forecourt sales minus electronic payments). Do not "improve" this
// further without also updating the acceptance tests in BUILD_BRIEF.md
// section 10; this file is the reference implementation the brief points to.
//
// Shapes:
//   entry e = {
//     date, dips:{PMS,AGO,VP}, deliv:{PMS,AGO,VP}, sold:{PMS,AGO,VP},
//     forecourtCashDrop, shop, lpg, lubes,
//     payCash, payMomo, payShell, payVisa, payCredit,
//     bankCente, bankExim, expenses, notes
//   }
//   priceSet p = { from, PMS:{price,margin}, AGO:{...}, VP:{...} }
//   settings = { priceHistory:[priceSet], nonFuel:{shop,lpg,lubes}, tolerance }

import { num, has, dmy } from "./format.js";

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

export function priceFor(settings, date) {
  const list = (settings.priceHistory || [])
    .filter((p) => p.from <= date)
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

/* Cumulative stock check: for each product, runs of consecutive entries
   with no delivery. Book stock is carried from the first dip of the run;
   the dip should fall by exactly the litres sold. */
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
      const prev = i > 0 ? map[ds[i - 1]] : null;
      const prevDip = prev && prev.dips ? prev.dips[k] : null;
      if (del > 0 || !has(dip) || !has(prevDip)) {
        // delivery day or missing dips: start a fresh run from this day's dip
        out[d][k] = { reset: true, delivery: del > 0 };
        run = has(dip) ? { since: d, startDip: num(dip), cumSold: 0, days: 0 } : null;
        return;
      }
      if (!run) run = { since: ds[i - 1], startDip: num(prevDip), cumSold: 0, days: 0 };
      run.cumSold += sold;
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
  const r = {
    price: p,
    fuel: {},
    fuelExpected: 0,
    fuelGP: 0,
    litres: 0,
    nf: {},
    nfSales: 0,
    nfGP: 0,
    stock: {},
    stockVarL: 0,
    stockFlags: 0,
  };
  PRODUCTS.forEach(({ k }) => {
    const sold = num(e.sold && e.sold[k]);
    const pr = p ? num(p[k] && p[k].price) : 0;
    const m = p ? num(p[k] && p[k].margin) : 0;
    r.fuel[k] = { sold, value: sold * pr, gp: sold * m };
    r.fuelExpected += sold * pr;
    r.fuelGP += sold * m;
    r.litres += sold;
  });
  NF.forEach(({ k }) => {
    const v = num(e[k]);
    const g = (v * num(settings.nonFuel && settings.nonFuel[k])) / 100;
    r.nf[k] = { sales: v, gp: g };
    r.nfSales += v;
    r.nfGP += g;
  });
  r.totalGP = r.fuelGP + r.nfGP;
  r.expenses = num(e.expenses);
  r.afterExp = r.totalGP - r.expenses;
  // Forecourt sales, used everywhere in reports/totals, is always the
  // computed litres x price figure (r.fuelExpected) — never blank for a
  // day that has litres and a price in force.
  r.totalSales = r.fuelExpected + r.nfSales;
  const PK = ["payCash", "payMomo", "payShell", "payVisa", "payCredit"];
  r.paid = PK.reduce((a, k) => a + num(e[k]), 0);
  r.paidEntered = PK.some((k) => has(e[k]));
  // Cash-specific check: what should be left as physical cash is forecourt
  // sales minus what already came in through electronic channels (cash
  // itself is deliberately excluded from this subtraction — it's the thing
  // being checked, not a channel netted out of it). Only meaningful once a
  // cash drop is actually declared.
  const electronicPaid = num(e.payMomo) + num(e.payShell) + num(e.payVisa) + num(e.payCredit);
  r.cashExpected = r.fuelExpected - electronicPaid;
  r.cashDrop = num(e.forecourtCashDrop);
  r.cashDropEntered = has(e.forecourtCashDrop);
  r.cashOverShort = r.cashDropEntered ? r.cashDrop - r.cashExpected : 0;
  r.bankCente = num(e.bankCente);
  r.bankExim = num(e.bankExim);
  r.banked = r.bankCente + r.bankExim;
  r.bankEntered = has(e.bankCente) || has(e.bankExim);
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
    const book = open + num(e.deliv && e.deliv[k]) - r.fuel[k].sold;
    const v = num(dip) - book;
    const delivered = num(e.deliv && e.deliv[k]) > 0;
    const base = r.fuel[k].sold || 1;
    const pct = (v / base) * 100;
    const flag = Math.abs(pct) > tol && Math.abs(v) >= 0.5;
    r.stock[k] = { open, book, dip: num(dip), v, pct, flag, delivered };
    r.stockVarL += v;
    if (flag) r.stockFlags++;
  });
  return r;
}

export function reportRows(dates, entries, settings, from, to) {
  return dates
    .filter((d) => d >= from && d <= to)
    .map((d) => ({ d, e: entries[d], r: compute(entries[d], { settings, entries, dates }) }));
}

export function discrepancies(rows, entries, settings) {
  const ch = stockChain(entries, settings);
  const list = [];
  rows.forEach(({ d, r }) =>
    PRODUCTS.forEach(({ k, label }) => {
      const x = r.stock[k],
        c = ch[d] && ch[d][k];
      const cumFlag = c && !c.reset && c.flag;
      if ((x && x.flag) || cumFlag)
        list.push({
          d,
          label,
          sold: r.fuel[k].sold,
          delivered: x ? x.delivered : false,
          dayVar: x ? x.v : 0,
          dayPct: x ? x.pct : 0,
          since: c && !c.reset ? c.since : null,
          days: c && !c.reset ? c.days : 0,
          cumVar: c && !c.reset ? c.cumVar : null,
          cumPct: c && !c.reset ? c.pct : null,
          reason:
            x && x.flag && !x.delivered
              ? "Dip doesn't match sales, no delivery"
              : x && x.flag
              ? "Variance on delivery day — check delivery quantity"
              : "Cumulative variance since last delivery",
        });
    })
  );
  return list;
}

export function totals(rows) {
  const T = {
    days: rows.length,
    PMS: 0,
    AGO: 0,
    VP: 0,
    litres: 0,
    fuelExpected: 0,
    fuelGP: 0,
    shop: 0,
    lpg: 0,
    lubes: 0,
    nfSales: 0,
    nfGP: 0,
    totalGP: 0,
    cashExpected: 0,
    cashDrop: 0,
    cashOverShort: 0,
    stockVar: { PMS: 0, AGO: 0, VP: 0 },
    expenses: 0,
    banked: 0,
    bankCente: 0,
    bankExim: 0,
    payCash: 0,
    payMomo: 0,
    payShell: 0,
    payVisa: 0,
    payCredit: 0,
    totalSales: 0,
  };
  rows.forEach(({ r }) => {
    PRODUCTS.forEach(({ k }) => {
      T[k] += r.fuel[k].sold;
      if (r.stock[k]) T.stockVar[k] += r.stock[k].v;
    });
    T.litres += r.litres;
    T.fuelExpected += r.fuelExpected;
    T.fuelGP += r.fuelGP;
    NF.forEach(({ k }) => {
      T[k] += r.nf[k].sales;
    });
    T.nfSales += r.nfSales;
    T.nfGP += r.nfGP;
    T.totalGP += r.totalGP;
    T.cashExpected += r.cashExpected;
    T.cashDrop += r.cashDrop;
    T.cashOverShort += r.cashOverShort;
    T.expenses += r.expenses;
    T.banked += r.banked;
    T.bankCente += r.bankCente;
    T.bankExim += r.bankExim;
    T.totalSales += r.totalSales;
  });
  rows.forEach(({ e }) => {
    ["payCash", "payMomo", "payShell", "payVisa", "payCredit"].forEach((k) => {
      T[k] += num(e[k]);
    });
  });
  return T;
}

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
  "Cash over/short",
  "Stock var L",
];

export function rowVals(d, r) {
  const sv = PRODUCTS.reduce((a, { k }) => a + (r.stock[k] ? r.stock[k].v : 0), 0);
  return [
    dmy(d),
    r.fuel.PMS.sold,
    r.fuel.AGO.sold,
    r.fuel.VP.sold,
    r.litres,
    r.fuelExpected,
    r.fuelGP,
    r.nf.shop.sales,
    r.nf.lpg.sales,
    r.nf.lubes.sales,
    r.nfGP,
    r.totalGP,
    r.cashOverShort,
    sv,
  ];
}

export function totVals(T) {
  return [
    "Total",
    T.PMS,
    T.AGO,
    T.VP,
    T.litres,
    T.fuelExpected,
    T.fuelGP,
    T.shop,
    T.lpg,
    T.lubes,
    T.nfGP,
    T.totalGP,
    T.cashOverShort,
    T.stockVar.PMS + T.stockVar.AGO + T.stockVar.VP,
  ];
}

export const isLit = (i) => [1, 2, 3, 4, 13].includes(i);
