import * as XLSX from "xlsx";
import { PRODUCTS, COLS, rowVals, totVals, totals, isLit } from "../lib/calc.js";
import { num, dmy } from "../lib/format.js";
import { getState } from "../lib/store.js";
import { downloadFile } from "../lib/download.js";
import { toast } from "../lib/toast.js";

const PRODUCT_LABEL = Object.fromEntries(PRODUCTS.map((p) => [p.k, p.label]));

export function exportXlsx(rows, discrepancies, settings, from, to) {
  if (!rows.length) {
    toast("No entries in this period to export.");
    return;
  }
  const T = totals(rows);
  const { entries } = getState();

  const summary = [
    ["Shell Nasuuti — Gross profit report"],
    ["Period", dmy(from) + " to " + dmy(to)],
    ["Days recorded", T.days],
    [],
    ["Metric", "Value"],
    ["Net profit (UGX)", Math.round(T.netProfit)],
    ["Total gross profit (UGX)", Math.round(T.totalGP)],
    ["Average GP per day (UGX)", T.days ? Math.round(T.totalGP / T.days) : 0],
    ["Fuel GP (UGX)", Math.round(T.fuelGP)],
    ["Non-fuel GP (UGX)", Math.round(T.nfGP)],
    ["Stock gain/(loss) at cost (UGX)", Math.round(T.stockGainLossAtCost)],
    ["Delivery shortfall (L)", +T.deliveryShortfallLitres.toFixed(2)],
    ["Delivery shortfall at cost (UGX)", Math.round(T.deliveryShortfallAtCost)],
    ["Own-use at cost (UGX)", Math.round(T.ownUseAtCost)],
    ["Expenses (UGX)", Math.round(T.expensesTotal)],
    ["Other income (UGX)", Math.round(T.otherIncomeTotal)],
    ["Total sales (UGX)", Math.round(T.totalSales)],
    ["Forecourt sales — litres × price (UGX)", Math.round(T.forecourtSales)],
    ["Cash over/short (UGX)", Math.round(T.cashOverShort)],
    ["Unaccounted sales (UGX)", T.bankingChecksApplicable ? Math.round(T.unaccountedSales) : "—"],
    ["Cash not banked (UGX)", T.bankingChecksApplicable ? Math.round(T.cashNotBanked) : "—"],
    [],
    ["Product", "Litres sold"],
    ...PRODUCTS.map(({ k, label }) => [label, +T[k.toLowerCase()].toFixed(2)]),
    ["Total", +T.litres.toFixed(2)],
  ];

  const roundCell = (v, i) => (i === 0 ? dmy(v) : v == null ? "—" : isLit(i) ? +Number(v).toFixed(2) : Math.round(v));
  const daily = [
    COLS,
    ...rows.map((row) => rowVals(row).map(roundCell)),
    totVals(T).map((v, i) => (i === 0 ? "Total" : roundCell(v, i))),
  ];

  // v_daily_report carries only computed figures, not every raw input —
  // this sheet reads the raw dips/deliveries/own-use/payments straight from
  // the entries already loaded in the global store, same rows the Daily
  // Entry screen edits.
  const detail = [
    [
      "Date", "PMS dip", "AGO dip", "V-Power dip", "PMS delivered", "AGO delivered", "V-Power delivered",
      "PMS own-use", "AGO own-use", "V-Power own-use",
      "Cash collected", "Mobile money", "Shell Card", "Visa", "Credit", "Airtel", "MTN MoMo", "Cash drop",
      "Banked " + (settings.bankingAccountName || "Centenary"), "Banked Exim (legacy)", "Expenses", "Notes",
    ],
    ...rows.map((row) => {
      const e = entries[row.trading_date] || {};
      return [
        dmy(row.trading_date),
        e.dips?.PMS, e.dips?.AGO, e.dips?.VP,
        e.deliv?.PMS, e.deliv?.AGO, e.deliv?.VP,
        e.genuse?.PMS, e.genuse?.AGO, e.genuse?.VP,
        e.payCash, e.payMomo, e.payShell, e.payVisa, e.payCredit, e.payAirtel, e.payMomoMtn, e.forecourtCashDrop,
        e.bankCente, e.bankExim, e.expenses, e.notes || "",
      ].map((v) => (v == null ? "" : v));
    }),
  ];

  const stock = [
    [
      "Date", "Product", "Issue", "Delivery", "Litres sold", "Day variance L", "Day variance %",
      "Run since", "Days in run", "Cumulative variance L", "Cumulative %",
    ],
    ...discrepancies.map((x) => [
      dmy(x.trading_date), PRODUCT_LABEL[x.product] || x.product, x.reason, x.delivered ? "Yes" : "No", +Number(x.sold).toFixed(2),
      +Number(x.day_var).toFixed(2), x.day_pct == null ? "" : +Number(x.day_pct).toFixed(2),
      x.since ? dmy(x.since) : "", x.days || "",
      x.cum_var == null ? "" : +Number(x.cum_var).toFixed(2), x.cum_pct == null ? "" : +Number(x.cum_pct).toFixed(2),
    ]),
  ];
  if (!discrepancies.length) stock.push(["No stock discrepancies in this period."]);

  const prices = [
    ["Effective from", "PMS price", "PMS margin", "AGO price", "AGO margin", "V-Power price", "V-Power margin"],
    ...[...settings.priceHistory]
      .sort((a, b) => (a.from < b.from ? -1 : 1))
      .map((p) => [dmy(p.from), ...PRODUCTS.flatMap(({ k }) => [num(p[k].price), num(p[k].margin)])]),
  ];

  const margins = [
    ["Effective from", "Shop %", "LPG %", "Lubes %", "Reason"],
    ...[...(settings.nonFuelMarginHistory || [])]
      .sort((a, b) => (a.from < b.from ? -1 : 1))
      .map((m) => [dmy(m.from), m.shop, m.lpg, m.lubes, m.reason || ""]),
  ];

  const wb = XLSX.utils.book_new();
  const add = (aoa, name, w) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = w.map((x) => ({ wch: x }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(summary, "Summary", [34, 18]);
  add(daily, "Daily", COLS.map((c, i) => (i === 0 ? 12 : 16)));
  add(detail, "Dips & cash", Array(22).fill(13));
  add(stock, "Stock check", [12, 12, 40, 10, 12, 14, 14, 12, 12, 18, 14]);
  add(prices, "Prices", Array(7).fill(15));
  add(margins, "Non-fuel margins", [15, 10, 10, 10, 40]);

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  downloadFile(
    "ShellNasuuti_GP_" + from + "_to_" + to + ".xlsx",
    new Uint8Array(buf),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}
