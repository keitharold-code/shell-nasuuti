import { PRODUCTS, COLS, rowVals, totVals, totals, isLit, isSgn, isBankingCheck } from "../lib/calc.js";
import { ugx, lit, dmy, sgn, esc, iso, addDays } from "../lib/format.js";
import { getState } from "../lib/store.js";
import { fetchReportRows, fetchDiscrepancies } from "../lib/data.js";
import { exportXlsx } from "../exports/xlsx.js";
import { exportPdf } from "../exports/pdf.js";
import { openDate } from "./entry.js";
import { toast } from "../lib/toast.js";

const PRODUCT_LABEL = Object.fromEntries(PRODUCTS.map((p) => [p.k, p.label]));

function $(root, id) {
  return root.querySelector("#" + id);
}

function setPreset(root) {
  const p = $(root, "preset").value;
  const { dates } = getState();
  const today = iso(new Date());
  if (p === "7") {
    $(root, "from").value = addDays(today, -7);
    $(root, "to").value = addDays(today, -1);
  } else if (p === "month") {
    $(root, "from").value = today.slice(0, 8) + "01";
    $(root, "to").value = today;
  } else if (p === "lastmonth") {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const f = iso(d);
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    $(root, "from").value = f;
    $(root, "to").value = iso(e);
  } else if (p === "all") {
    $(root, "from").value = dates[0] || today;
    $(root, "to").value = dates[dates.length - 1] || today;
  }
}

function cell(v, i) {
  if (i === 0) return esc(dmy(v));
  if (v == null) return "—";
  const f = isLit(i) ? lit : ugx;
  if (isBankingCheck(i)) {
    // Unaccounted sales / Cash not banked: flagged red whenever nonzero,
    // in either direction — unlike the checks below, a positive value
    // here isn't a good sign, just the sign of a different problem.
    return `<span class="${Math.abs(v) > 0.5 ? "neg" : ""}">${sgn(v, f)}</span>`;
  }
  if (isSgn(i)) return `<span class="${v < -0.5 ? "neg" : v > 0.5 ? "pos" : ""}">${sgn(v, f)}</span>`;
  return f(v);
}

function buildChart(rows) {
  if (!rows.length) return '<div class="empty">No entries in this period.</div>';
  const W = Math.max(600, rows.length * 34), H = 200, pad = 24;
  const max = Math.max(1, ...rows.map((r) => r.total_gp));
  const bw = (W - pad * 2) / rows.length;
  let svg = `<svg viewBox="0 0 ${W} ${H + 22}" width="100%" role="img" aria-label="Daily gross profit chart" style="max-height:260px">`;
  rows.forEach((r, i) => {
    const hf = (r.fuel_gp / max) * (H - 10);
    const hn = (r.nf_gp / max) * (H - 10);
    const bx = pad + i * bw + bw * 0.15, w = bw * 0.7;
    svg += `<g><title>${dmy(r.trading_date)}: UGX ${ugx(r.total_gp)}</title><rect x="${bx}" y="${H - hf}" width="${w}" height="${hf}" fill="var(--petrol-2)"/><rect x="${bx}" y="${H - hf - hn}" width="${w}" height="${hn}" fill="var(--canopy)"/></g>`;
    if (rows.length <= 31)
      svg += `<text x="${bx + w / 2}" y="${H + 16}" font-size="11" text-anchor="middle" fill="var(--muted)">${r.trading_date.slice(8)}</text>`;
  });
  svg += `<line x1="${pad}" x2="${W - pad}" y1="${H}" y2="${H}" stroke="var(--line)"/></svg>`;
  return `<div style="overflow-x:auto">${svg}</div>`;
}

async function refresh(root) {
  if ($(root, "preset").value === "all") setPreset(root);
  const from = $(root, "from").value, to = $(root, "to").value;
  if (!from || !to) return;

  let rows, D;
  try {
    [rows, D] = await Promise.all([fetchReportRows(from, to), fetchDiscrepancies(from, to)]);
  } catch (err) {
    $(root, "kpis").innerHTML = `<div class="notice err">Couldn't load the report: ${err.message || ""}</div>`;
    return;
  }

  const T = totals(rows);

  const kp = [
    ["Net profit", ugx(T.netProfit), true],
    ["Total gross profit", ugx(T.totalGP)],
    ["Fuel GP", ugx(T.fuelGP)],
    ["Non-fuel GP", ugx(T.nfGP)],
    ["Stock gain/(loss) at cost", sgn(T.stockGainLossAtCost, ugx)],
    ["Delivery shortfall at cost", sgn(T.deliveryShortfallAtCost, ugx)],
    ["Own-use at cost", ugx(T.ownUseAtCost)],
    ["Expenses", ugx(T.expensesTotal)],
    ["Other income", ugx(T.otherIncomeTotal)],
    ["Litres sold", lit(T.litres)],
    ["Total sales", ugx(T.totalSales)],
    ["Cash over/short", sgn(T.cashOverShort, ugx)],
    ["Unaccounted sales", T.bankingChecksApplicable ? sgn(T.unaccountedSales, ugx) : "—"],
    ["Cash not banked", T.bankingChecksApplicable ? sgn(T.cashNotBanked, ugx) : "—"],
    ["Stock discrepancies flagged", String(D.length)],
  ];
  $(root, "kpis").innerHTML = kp
    .map(([l, v, h]) => `<div class="kpi${h ? " hero" : ""}"><span>${l}</span><b class="num">${v}</b></div>`)
    .join("");

  $(root, "chart").innerHTML = buildChart(rows);

  $(root, "disc").innerHTML = !D.length
    ? '<tbody><tr><td class="empty">No stock discrepancies in this period.</td></tr></tbody>'
    : '<thead><tr><th>Date</th><th>Product</th><th>Issue</th><th>Delivery</th><th>Litres sold</th><th>Day variance L</th><th>Since</th><th>Days</th><th>Cumulative variance L</th><th>Cumulative %</th></tr></thead><tbody>' +
      D.map(
        (x) =>
          `<tr data-d="${x.trading_date}"><td>${dmy(x.trading_date)}</td><td>${PRODUCT_LABEL[x.product] || x.product}</td><td style="text-align:left">${x.reason}</td><td>${
            x.delivered ? "Yes" : "No"
          }</td><td>${lit(x.sold)}</td><td class="${x.day_var < 0 ? "neg" : "pos"}">${sgn(x.day_var, lit)}</td><td>${
            x.since ? dmy(x.since) : "—"
          }</td><td>${x.days || "—"}</td><td class="${x.cum_var < 0 ? "neg" : x.cum_var > 0 ? "pos" : ""}">${
            x.cum_var == null ? "—" : sgn(x.cum_var, lit)
          }</td><td>${x.cum_pct == null ? "—" : Number(x.cum_pct).toFixed(2) + "%"}</td></tr>`
      ).join("") +
      "</tbody>";

  if (!rows.length) {
    $(root, "rtable").innerHTML = '<tbody><tr><td class="empty">No entries in this period. Save a daily entry to see it here.</td></tr></tbody>';
    root._exportState = null;
    return;
  }
  let h = "<thead><tr>" + COLS.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
  rows.forEach((row) => {
    h += `<tr data-d="${row.trading_date}" tabindex="0">` + rowVals(row).map((v, i) => `<td>${cell(v, i)}</td>`).join("") + "</tr>";
  });
  h += "</tbody><tfoot><tr>" + totVals(T).map((v, i) => `<td>${i === 0 ? "Total" : cell(v, i)}</td>`).join("") + "</tr></tfoot>";
  $(root, "rtable").innerHTML = h;

  root._exportState = { rows, discrepancies: D, from, to };
}

function build(root) {
  root.innerHTML = `
    <div class="rangebar">
      <label class="f">Period
        <select id="preset">
          <option value="7">Last 7 days</option>
          <option value="month" selected>This month</option>
          <option value="lastmonth">Last month</option>
          <option value="all">All entries</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label class="f">From<input type="date" id="from"></label>
      <label class="f">To<input type="date" id="to"></label>
      <div class="actions">
        <button class="btn yellow" id="xlsxBtn">Export Excel</button>
        <button class="btn" id="pdfBtn">Export PDF</button>
      </div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="chartwrap">
      <h3>Daily gross profit</h3>
      <div class="legend"><span><i style="background:var(--petrol-2)"></i>Fuel</span><span><i style="background:var(--canopy)"></i>Shop, LPG, lubes</span></div>
      <div id="chart"></div>
    </div>
    <div class="tscroll"><table id="rtable"></table></div>
    <p class="hint">Select a row to open that day's entry.</p>
    <section class="block" style="margin-top:16px">
      <h2>Stock discrepancies</h2>
      <p class="hint" style="margin-top:0">Flags any day, and any run of days without a delivery, where the dips don't tally with litres sold beyond the tolerance set in Admin.</p>
      <div class="tscroll" id="discWrap"><table id="disc"></table></div>
    </section>
  `;

  setPreset(root);
  root.querySelector("#preset").addEventListener("change", () => {
    setPreset(root);
    refresh(root);
  });
  ["from", "to"].forEach((id) =>
    $(root, id).addEventListener("change", () => {
      $(root, "preset").value = "custom";
      refresh(root);
    })
  );

  const openDay = (d) => {
    location.hash = "#entry";
    // Wait a tick so app.js swaps the tab content before we build the form.
    setTimeout(() => {
      const content = document.getElementById("tabContent");
      if (content) openDate(content, d);
    }, 0);
  };
  $(root, "disc").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-d]");
    if (tr) openDay(tr.dataset.d);
  });
  $(root, "rtable").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-d]");
    if (tr) openDay(tr.dataset.d);
  });
  $(root, "rtable").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const tr = e.target.closest("tr[data-d]");
      if (tr) openDay(tr.dataset.d);
    }
  });

  $(root, "xlsxBtn").addEventListener("click", () => {
    const s = root._exportState;
    if (s) exportXlsx(s.rows, s.discrepancies, getState().settings, s.from, s.to);
    else toast("No report loaded yet.");
  });
  $(root, "pdfBtn").addEventListener("click", () => {
    const s = root._exportState;
    if (s) exportPdf(s.rows, s.discrepancies, getState().settings, s.from, s.to);
    else toast("No report loaded yet.");
  });
}

export function renderReports(root) {
  const needsBuild = root.dataset.activePage !== "reports" || !root.querySelector("#rtable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "reports";
  }
  refresh(root);
}
