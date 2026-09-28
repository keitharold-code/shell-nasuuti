import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { PRODUCTS, COLS, rowVals, totVals, isLit, totals, discrepancies } from "../lib/calc.js";
import { ugx, lit, dmy } from "../lib/format.js";
import { downloadFile } from "../lib/download.js";
import { toast } from "../lib/toast.js";

// jsPDF's built-in Helvetica font doesn't have a glyph for the proper
// minus sign (U+2212) format.js's sgn() uses — it renders as a broken
// character, and in a narrow autoTable column that forces the whole cell
// to wrap vertically, one character per line. A plain ASCII hyphen has no
// such problem. The web UI and Excel export both render U+2212 fine, so
// this stays local to the PDF export rather than changing sgn() itself.
function sgn(n, f) {
  return (n > 0 ? "+" : n < 0 ? "-" : "") + f(Math.abs(n));
}

export function exportPdf(rows, settings, from, to) {
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
      ["Total gross profit", ugx(T.totalGP)],
      ["Average GP per day", T.days ? ugx(T.totalGP / T.days) : "0"],
      ["Fuel GP", ugx(T.fuelGP)],
      ["Non-fuel GP", ugx(T.nfGP)],
      ["Total sales", ugx(T.totalSales)],
      ["Forecourt sales (litres × price)", ugx(T.fuelExpected)],
      ["Cash expected / drop declared", ugx(T.cashExpected) + " / " + ugx(T.cashDrop)],
      ["Cash over/short", sgn(T.cashOverShort, ugx)],
      ["Expenses", ugx(T.expenses)],
      ["Gross profit after expenses", ugx(T.totalGP - T.expenses)],
      ["Banked — Centenary / Exim", ugx(T.bankCente) + " / " + ugx(T.bankExim)],
      ["Shell Card / Visa", ugx(T.payShell) + " / " + ugx(T.payVisa)],
    ],
    columnStyles: { 1: { halign: "right" } },
  });
  const summaryFinalY = doc.lastAutoTable.finalY;

  doc.autoTable({
    startY: 78, theme: "grid", styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: petrol }, margin: { left: 430, right: 32 },
    head: [["Product", "Litres sold", "Stock var (L)"]],
    body: [
      ...PRODUCTS.map(({ k, label }) => [label, lit(T[k]), sgn(T.stockVar[k], lit)]),
      ["Total", lit(T.litres), sgn(T.stockVar.PMS + T.stockVar.AGO + T.stockVar.VP, lit)],
    ],
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });
  const productFinalY = doc.lastAutoTable.finalY;

  // The two tables above sit side by side from the same startY, so the
  // next section must clear whichever one actually ran taller — not just
  // the one that happened to be drawn last (doc.lastAutoTable only knows
  // about that most recent call).
  const y = Math.max(summaryFinalY, productFinalY, 78) + 60;
  const fmt = (v, i) => (i === 0 ? v : i === 12 || i === 13 ? sgn(v, isLit(i) ? lit : ugx) : isLit(i) ? lit(v) : ugx(v));
  doc.autoTable({
    startY: Math.max(y, 250), theme: "striped", styles: { fontSize: 7.5, cellPadding: 3, halign: "right" },
    headStyles: { fillColor: petrol, halign: "right" },
    footStyles: { fillColor: canopy, textColor: [29, 26, 12], halign: "right" },
    margin: { left: 24, right: 24 }, columnStyles: { 0: { halign: "left" } },
    // Without this, autoTable repeats the Total row on every page the
    // table spans — showing the full-period total after only a partial
    // set of rows on page 1, which reads as if those rows alone summed
    // to it. It should appear once, after the actual last row.
    showFoot: "lastPage",
    head: [COLS], body: rows.map(({ d, r }) => rowVals(d, r).map(fmt)), foot: [totVals(T).map(fmt)],
  });

  const D = discrepancies(rows, Object.fromEntries(rows.map(({ d, e }) => [d, e])), settings);
  doc.setFontSize(12); doc.setTextColor(23, 32, 39);
  let yy = doc.lastAutoTable.finalY + 28;
  if (yy > 520) { doc.addPage(); yy = 40; }
  doc.text("Stock discrepancies", 24, yy);
  doc.autoTable({
    startY: yy + 8, theme: "grid", styles: { fontSize: 8, cellPadding: 3, halign: "right" },
    headStyles: { fillColor: [184, 55, 43], halign: "right" }, margin: { left: 24, right: 24 },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "left" }, 2: { halign: "left" } },
    head: [["Date", "Product", "Issue", "Delivery", "Litres sold", "Day var L", "Since", "Days", "Cum. var L", "Cum. %"]],
    body: D.length
      ? D.map((x) => [
          dmy(x.d), x.label, x.reason, x.delivered ? "Yes" : "No", lit(x.sold), sgn(x.dayVar, lit),
          x.since ? dmy(x.since) : "—", x.days || "—", x.cumVar == null ? "—" : sgn(x.cumVar, lit),
          x.cumPct == null ? "—" : x.cumPct.toFixed(2) + "%",
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
