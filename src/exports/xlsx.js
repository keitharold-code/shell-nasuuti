import * as XLSX from "xlsx";
import { PRODUCTS, NF, COLS, rowVals, totVals, isLit, totals, discrepancies } from "../lib/calc.js";
import { num, dmy } from "../lib/format.js";
import { downloadFile } from "../lib/download.js";
import { toast } from "../lib/toast.js";

export function exportXlsx(rows, settings, from, to) {
  if (!rows.length) {
    toast("No entries in this period to export.");
    return;
  }
  const T = totals(rows);
  const summary = [
    ["Shell Nasuuti — Gross profit report"],
    ["Period", dmy(from) + " to " + dmy(to)],
    ["Days recorded", T.days],
    [],
    ["Metric", "Value"],
    ["Total gross profit (UGX)", Math.round(T.totalGP)],
    ["Average GP per day (UGX)", T.days ? Math.round(T.totalGP / T.days) : 0],
    ["Fuel GP (UGX)", Math.round(T.fuelGP)],
    ["Non-fuel GP (UGX)", Math.round(T.nfGP)],
    ["Total sales (UGX)", Math.round(T.totalSales)],
    ["Forecourt sales — litres × price (UGX)", Math.round(T.fuelExpected)],
    ["Cash expected — sales minus electronic payments (UGX)", Math.round(T.cashExpected)],
    ["Cash drop declared (UGX)", Math.round(T.cashDrop)],
    ["Cash over/short (UGX)", Math.round(T.cashOverShort)],
    ["Unaccounted sales (UGX)", T.bankingChecksApplicable ? Math.round(T.unaccountedSales) : "—"],
    ["Cash not banked (UGX)", T.bankingChecksApplicable ? Math.round(T.cashNotBanked) : "—"],
    [],
    ["Product", "Litres sold", "Stock variance (L)"],
    ...PRODUCTS.map(({ k, label }) => [label, +T[k].toFixed(2), +T.stockVar[k].toFixed(2)]),
    ["Total", +T.litres.toFixed(2), +(T.stockVar.PMS + T.stockVar.AGO + T.stockVar.VP).toFixed(2)],
    [],
    ["Non-fuel", "Sales (UGX)", "Margin %"],
    ...NF.map(({ k, label }) => [label, Math.round(T[k]), num(settings.nonFuel[k])]),
    [],
    ["Expenses (UGX)", Math.round(T.expenses)],
    ["Banked — " + (settings.bankingAccountName || "Centenary") + " (UGX)", Math.round(T.bankCente)],
    ["Banked — Exim, legacy (UGX)", Math.round(T.bankExim)],
    ["Total banked (UGX)", Math.round(T.banked)],
    [],
    ["Payments", "UGX"],
    ["Cash collected", Math.round(T.payCash)],
    ["Mobile money", Math.round(T.payMomo)],
    ["Shell Card", Math.round(T.payShell)],
    ["Visa", Math.round(T.payVisa)],
    ["Credit (debtors)", Math.round(T.payCredit)],
  ];

  const roundCell = (v, i) => (i === 0 ? v : v == null ? "—" : isLit(i) ? +v.toFixed(2) : Math.round(v));
  const daily = [
    COLS,
    ...rows.map(({ d, r }) => rowVals(d, r).map(roundCell)),
    totVals(T).map(roundCell),
  ];

  const detail = [
    [
      "Date", "PMS dip", "AGO dip", "V-Power dip", "PMS delivered", "AGO delivered", "V-Power delivered",
      "Cash collected", "Mobile money", "Shell Card", "Visa", "Credit", "Cash drop",
      "Banked " + (settings.bankingAccountName || "Centenary"), "Banked Exim (legacy)", "Expenses", "Notes",
    ],
    ...rows.map(({ d, e }) =>
      [
        dmy(d), e.dips.PMS, e.dips.AGO, e.dips.VP,
        e.deliv && e.deliv.PMS, e.deliv && e.deliv.AGO, e.deliv && e.deliv.VP,
        e.payCash, e.payMomo, e.payShell, e.payVisa, e.payCredit, e.forecourtCashDrop,
        e.bankCente, e.bankExim, e.expenses, e.notes || "",
      ].map((v) => (v == null ? "" : v))
    ),
  ];

  const D = discrepancies(rows, Object.fromEntries(rows.map(({ d, e }) => [d, e])), settings);
  const stock = [
    [
      "Date", "Product", "Issue", "Delivery", "Litres sold", "Day variance L", "Day variance %",
      "Run since", "Days in run", "Cumulative variance L", "Cumulative %",
    ],
    ...D.map((x) => [
      dmy(x.d), x.label, x.reason, x.delivered ? "Yes" : "No", +x.sold.toFixed(2),
      +x.dayVar.toFixed(2), +x.dayPct.toFixed(2), x.since ? dmy(x.since) : "", x.days || "",
      x.cumVar == null ? "" : +x.cumVar.toFixed(2), x.cumPct == null ? "" : +x.cumPct.toFixed(2),
    ]),
  ];
  if (!D.length) stock.push(["No stock discrepancies in this period."]);

  const prices = [
    ["Effective from", "PMS price", "PMS margin", "AGO price", "AGO margin", "V-Power price", "V-Power margin"],
    ...[...settings.priceHistory]
      .sort((a, b) => (a.from < b.from ? -1 : 1))
      .map((p) => [dmy(p.from), ...PRODUCTS.flatMap(({ k }) => [num(p[k].price), num(p[k].margin)])]),
  ];

  const wb = XLSX.utils.book_new();
  const add = (aoa, name, w) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = w.map((x) => ({ wch: x }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(summary, "Summary", [34, 18, 18]);
  add(daily, "Daily", COLS.map((c, i) => (i === 0 ? 12 : 15)));
  add(detail, "Dips & cash", Array(17).fill(14));
  add(stock, "Stock check", [12, 12, 40, 10, 12, 14, 14, 12, 12, 18, 14]);
  add(prices, "Prices", Array(7).fill(15));

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  downloadFile(
    "ShellNasuuti_GP_" + from + "_to_" + to + ".xlsx",
    new Uint8Array(buf),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}
