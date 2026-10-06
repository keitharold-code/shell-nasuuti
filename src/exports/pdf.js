import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { PRODUCTS, COLS, rowVals, totVals, totals, isLit } from "../lib/calc.js";
import { ugx, lit, dmy } from "../lib/format.js";
import { downloadFile } from "../lib/download.js";
import { toast } from "../lib/toast.js";

const PRODUCT_LABEL = Object.fromEntries(PRODUCTS.map((p) => [p.k, p.label]));

// jsPDF's built-in Helvetica font doesn't have a glyph for the proper
// minus sign (U+2212) format.js's sgn() uses — it renders as a broken
// character, and in a narrow autoTable column that forces the whole cell
// to wrap vertically, one character per line. A plain ASCII hyphen has no
// such problem. The web UI and Excel export both render U+2212 fine, so
// this stays local to the PDF export rather than changing sgn() itself.
function sgn(n, f) {
  return (n > 0 ? "+" : n < 0 ? "-" : "") + f(Math.abs(n));
}

export function exportPdf(rows, discrepancies, settings, from, to) {
  if (!rows.length) {
    toast("No entries in this period to export.");
    return;
  }
  const T = totals(rows);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const petrol = [15, 59, 82], canopy = [242, 183, 5];

  doc.setFillColor(...petrol); doc.rect(0, 0, 842, 58, "F");
  doc.setFillColor(...canopy); doc.rect(0, 58, 842, 4, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(18);
  doc.text("Shell Nasuuti — Gross profit report", 32, 34);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  doc.text(
    dmy(from) + " to " + dmy(to) + "   ·   " + T.days + " day(s) recorded   ·   Generated " + new Date().toLocaleString(),
    32,
    50
  );
  doc.setTextColor(23, 32, 39);

  doc.autoTable({
    startY: 78, theme: "grid", styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: petrol }, margin: { left: 32, right: 32 }, tableWidth: 380,
    head: [["Summary", "UGX"]],
    body: [
      ["Net profit", ugx(T.netProfit)],
      ["Total gross profit", ugx(T.totalGP)],
      ["Average GP per day", T.days ? ugx(T.totalGP / T.days) : "0"],
      ["Fuel GP", ugx(T.fuelGP)],
      ["Non-fuel GP", ugx(T.nfGP)],
      ["Stock gain/(loss) at cost", sgn(T.stockGainLossAtCost, ugx)],
      ["Delivery shortfall at cost", sgn(T.deliveryShortfallAtCost, ugx)],
      ["Own-use at cost", ugx(T.ownUseAtCost)],
      ["Expenses", ugx(T.expensesTotal)],
      ["Other income", ugx(T.otherIncomeTotal)],
      ["Total sales", ugx(T.totalSales)],
      ["Forecourt sales (litres × price)", ugx(T.forecourtSales)],
      ["Cash over/short", sgn(T.cashOverShort, ugx)],
      ["Unaccounted sales", T.bankingChecksApplicable ? sgn(T.unaccountedSales, ugx) : "—"],
      ["Cash not banked", T.bankingChecksApplicable ? sgn(T.cashNotBanked, ugx) : "—"],
    ],
    columnStyles: { 1: { halign: "right" } },
  });
  const summaryFinalY = doc.lastAutoTable.finalY;

  doc.autoTable({
    startY: 78, theme: "grid", styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: petrol }, margin: { left: 430, right: 32 },
    head: [["Product", "Litres sold"]],
    body: [
      ...PRODUCTS.map(({ k, label }) => [label, lit(T[k.toLowerCase()])]),
      ["Total", lit(T.litres)],
    ],
    columnStyles: { 1: { halign: "right" } },
  });
  const productFinalY = doc.lastAutoTable.finalY;

  // The two tables above sit side by side from the same startY, so the
  // next section must clear whichever one actually ran taller — not just
  // the one that happened to be drawn last (doc.lastAutoTable only knows
  // about that most recent call).
  const y = Math.max(summaryFinalY, productFinalY, 78) + 60;
  const fmt = (v, i) => {
    if (i === 0) return dmy(v);
    if (v == null) return "—";
    // Stock var L / stock gain-loss at cost / delivery shortfall (L, at
    // cost) / net profit / cash over-short / unaccounted sales / cash not
    // banked — see calc.js's isSgn/isBankingCheck for the same column
    // indices split across two helpers there; this table has no separate
    // null-as-dash branch (handled just above), so both groups share one
    // signed-formatting list here.
    if ([12, 13, 14, 15, 19, 20, 21, 22].includes(i)) return sgn(v, isLit(i) ? lit : ugx);
    return isLit(i) ? lit(v) : ugx(v);
  };
  doc.autoTable({
    startY: Math.max(y, 250), theme: "striped", styles: { fontSize: 7, cellPadding: 2.5, halign: "right" },
    headStyles: { fillColor: petrol, halign: "right", fontSize: 6.5 },
    footStyles: { fillColor: canopy, textColor: [29, 26, 12], halign: "right" },
    margin: { left: 24, right: 24 }, columnStyles: { 0: { halign: "left" } },
    // Without this, autoTable repeats the Total row on every page the
    // table spans — showing the full-period total after only a partial
    // set of rows on page 1, which reads as if those rows alone summed
    // to it. It should appear once, after the actual last row.
    showFoot: "lastPage",
    head: [COLS],
    body: rows.map((row) => rowVals(row).map(fmt)),
    foot: [totVals(T).map((v, i) => (i === 0 ? "Total" : fmt(v, i)))],
  });

  doc.setFontSize(12); doc.setTextColor(23, 32, 39);
  let yy = doc.lastAutoTable.finalY + 28;
  if (yy > 520) { doc.addPage(); yy = 40; }
  doc.text("Stock discrepancies", 24, yy);
  doc.autoTable({
    startY: yy + 8, theme: "grid", styles: { fontSize: 8, cellPadding: 3, halign: "right" },
    headStyles: { fillColor: [184, 55, 43], halign: "right" }, margin: { left: 24, right: 24 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "left" }, 2: { halign: "left" } },
    head: [["Date", "Product", "Issue", "Delivery", "Litres sold", "Day var L", "Since", "Days", "Cum. var L", "Cum. %"]],
    body: discrepancies.length
      ? discrepancies.map((x) => [
          dmy(x.trading_date), PRODUCT_LABEL[x.product] || x.product, x.reason, x.delivered ? "Yes" : "No", lit(x.sold), sgn(x.day_var, lit),
          x.since ? dmy(x.since) : "—", x.days || "—", x.cum_var == null ? "—" : sgn(x.cum_var, lit),
          x.cum_pct == null ? "—" : Number(x.cum_pct).toFixed(2) + "%",
        ])
      : [["No stock discrepancies in this period.", "", "", "", "", "", "", "", "", ""]],
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text("Page " + i + " of " + pages, 810, 585, { align: "right" });
  }

  downloadFile("ShellNasuuti_GP_" + from + "_to_" + to + ".pdf", doc.output("arraybuffer"), "application/pdf");
}
