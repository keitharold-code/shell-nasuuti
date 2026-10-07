import { PRODUCTS, compute, stockChain } from "../lib/calc.js";
import { num, has, ugx, lit, sgn, iso, addDays, dmy, daysBetween } from "../lib/format.js";
import { kv } from "../lib/render-helpers.js";
import { getState, isAdmin, canWrite } from "../lib/store.js";
import {
  saveEntry, deleteEntry, fetchDayReport, refreshEntry,
  listDeliveries, addDelivery, deleteDelivery,
  listExpenses, addExpense, deleteExpense,
  listOtherOwnUse, addOtherOwnUse, deleteOtherOwnUse,
  listOtherIncome, addOtherIncome, deleteOtherIncome,
  listCustomers,
  listCreditPrepaidDraws, addCreditPrepaidDraw, deleteCreditPrepaidDraw,
  listRecoveries, addRecovery, deleteRecovery,
  listPrepaidDeposits, addPrepaidDeposit, deletePrepaidDeposit,
} from "../lib/data.js";
import { toast } from "../lib/toast.js";

const EXPENSE_CATEGORIES = [
  "Staff costs", "Electricity", "Water", "Generator fuel", "Stationery",
  "Housekeeping", "Repairs", "Transport", "Bank charges", "Shop expenses", "Other",
];

const OTHER_INCOME_CATEGORIES = [
  { k: "vivo_shortage_refund", label: "Vivo shortage refund" },
  { k: "pressure_air", label: "Pressure/air" },
  { k: "other", label: "Other" },
];

const TXN_TYPES = [
  { k: "credit", label: "Credit sale" },
  { k: "prepaid_draw", label: "Prepaid draw" },
  { k: "recovery", label: "Recovery (payment against credit)" },
  { k: "prepaid_deposit", label: "Prepaid deposit" },
];

const flat = [
  "shop", "lpg", "lubes",
  "payCash", "payMomo", "payShell", "payVisa", "payCredit", "payAirtel", "payMomoMtn",
  "forecourtCashDrop", "bankCente",
];

let dirty = false;
let loadedDate = null;
let loadedEntryExists = false;
let dayReport = null; // last fetchDayReport() result for the loaded date
let deliveries = [];
let expenses = [];
let otherOwnUse = [];
let otherIncome = [];
let creditPrepaidDraws = [];
let recoveries = [];
let prepaidDeposits = [];
let customers = []; // refetched on each buildForm(), not per date

function $(root, id) {
  return root.querySelector("#" + id);
}

function buildFuelGridHtml() {
  let h = "<div></div>" + PRODUCTS.map((p) => `<div class="hd">${p.label}</div>`).join("");
  const rows = [
    ["dip", "Closing dip", "taken next morning"],
    ["sold", "Litres sold", "from pump meters"],
    ["genuse", "Own-use (generator etc.)", "litres, excluded from sales"],
    ["pumptest", "Pump test returned", "litres, poured back — no effect"],
  ];
  rows.forEach(([key, lab, sub]) => {
    h +=
      `<div class="rl">${lab}<span>${sub}</span></div>` +
      PRODUCTS.map(
        (p) =>
          `<input type="number" step="any" min="0" inputmode="decimal" id="${key}-${p.k}" aria-label="${lab} ${p.label}">`
      ).join("");
  });
  h +=
    `<div class="rl">Delivered<span>from Deliveries, below</span></div>` +
    PRODUCTS.map((p) => `<input type="number" step="any" disabled id="deliv-${p.k}" aria-label="Delivered ${p.label}">`).join("");
  return h;
}

function readForm(root) {
  const e = { date: $(root, "date").value, dips: {}, sold: {}, genuse: {}, pumptest: {}, deliv: {} };
  PRODUCTS.forEach(({ k }) => {
    ["dip", "sold", "genuse", "pumptest"].forEach((t) => {
      const v = $(root, t + "-" + k).value;
      (t === "dip" ? e.dips : e[t])[k] = v === "" ? null : num(v);
    });
    const { entries } = getState();
    const saved = entries[e.date];
    e.deliv[k] = saved ? saved.deliv[k] : null;
  });
  flat.forEach((f) => {
    const v = $(root, f).value;
    e[f] = v === "" ? null : num(v);
  });
  e.nonFuelCashBankedWithForecourt = $(root, "bankingFlag").checked;
  e.notes = $(root, "notes").value.trim();
  const { entries } = getState();
  e.expenses = (entries[e.date] && entries[e.date].expenses) || 0;
  return e;
}

function fillForm(root, e) {
  PRODUCTS.forEach(({ k }) => {
    $(root, "dip-" + k).value = e && e.dips && has(e.dips[k]) ? e.dips[k] : "";
    $(root, "sold-" + k).value = e && e.sold && has(e.sold[k]) ? e.sold[k] : "";
    $(root, "genuse-" + k).value = e && e.genuse && has(e.genuse[k]) ? e.genuse[k] : "";
    $(root, "pumptest-" + k).value = e && e.pumptest && has(e.pumptest[k]) ? e.pumptest[k] : "";
    $(root, "deliv-" + k).value = e && e.deliv && has(e.deliv[k]) ? e.deliv[k] : "";
  });
  flat.forEach((f) => {
    $(root, f).value = e && has(e[f]) ? e[f] : "";
  });
  $(root, "bankingFlag").checked = e && has(e.nonFuelCashBankedWithForecourt) ? e.nonFuelCashBankedWithForecourt : true;
  $(root, "notes").value = (e && e.notes) || "";
}

function buildForm(root) {
  root.innerHTML = `
    <div class="entry">
      <div>
        <section class="block">
          <div class="daterow">
            <label class="f">Trading date
              <input type="date" id="date">
            </label>
            <div class="status" id="entryStatus"></div>
          </div>
        </section>

        <section class="block">
          <h2>Fuel <small>litres</small></h2>
          <div class="fuelgrid" id="fuelGrid">${buildFuelGridHtml()}</div>
          <p class="hint">Own-use and pump-test litres don't count as sales — they're excluded from sales/GP but still move stock (own-use) or have no effect at all (pump test, since it's poured back).</p>
        </section>

        <section class="block">
          <h2>Deliveries today</h2>
          <p class="hint" style="margin-top:0" id="deliveriesGateHint"></p>
          <div class="tscroll" style="margin-bottom:10px"><table id="deliveriesTable"></table></div>
          <div class="admin-grid" id="deliveryForm">
            <label class="f">Product
              <select id="dv-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select>
            </label>
            <label class="f">Invoiced litres<input type="number" step="any" min="0" inputmode="decimal" id="dv-litres"></label>
            <label class="f">Dip before<input type="number" step="any" min="0" inputmode="decimal" id="dv-dipbefore"></label>
            <label class="f">Dip after<input type="number" step="any" min="0" inputmode="decimal" id="dv-dipafter"></label>
            <label class="f">Sold during offload<input type="number" step="any" min="0" inputmode="decimal" id="dv-soldduring"></label>
            <label class="f">Truck reg<input type="text" id="dv-truck"></label>
            <label class="f">Invoice no.<input type="text" id="dv-invoice"></label>
          </div>
          <button class="btn primary" id="addDeliveryBtn">Add delivery</button>
          <p class="hint">Delivered litres above update automatically from this list.</p>
        </section>

        <section class="block">
          <h2>Non-fuel sales value <small>UGX</small></h2>
          <div class="grid3">
            <label class="f">Shop<input type="number" step="any" min="0" inputmode="decimal" id="shop"></label>
            <label class="f">LPG<input type="number" step="any" min="0" inputmode="decimal" id="lpg"></label>
            <label class="f">Lubes<input type="number" step="any" min="0" inputmode="decimal" id="lubes"></label>
          </div>
          <p class="hint">Fuel sales aren't entered here — they're calculated from litres sold × the pump price in force.</p>
        </section>

        <section class="block">
          <h2>How sales were paid <small>UGX · optional</small></h2>
          <div class="grid5">
            <label class="f">Cash collected (forecourt + shop, LPG, lubes)<input type="number" step="any" min="0" inputmode="decimal" id="payCash"></label>
            <label class="f">Mobile money<input type="number" step="any" min="0" inputmode="decimal" id="payMomo"></label>
            <label class="f">Shell Card<input type="number" step="any" min="0" inputmode="decimal" id="payShell"></label>
            <label class="f">Visa<input type="number" step="any" min="0" inputmode="decimal" id="payVisa"></label>
            <label class="f">Credit (debtors)<input type="number" step="any" min="0" inputmode="decimal" id="payCredit"></label>
            <label class="f">Airtel Pay<input type="number" step="any" min="0" inputmode="decimal" id="payAirtel"></label>
            <label class="f">MTN MoMo Pay<input type="number" step="any" min="0" inputmode="decimal" id="payMomoMtn"></label>
          </div>
        </section>

        <section class="block">
          <h2>Cash drop <small>UGX · optional</small></h2>
          <label class="f">Forecourt cash physically dropped
            <input type="number" step="any" min="0" inputmode="decimal" id="forecourtCashDrop">
          </label>
          <p class="hint">Compared against cash expected (fuel sales minus electronic payment channels) — not against total sales.</p>
        </section>

        <section class="block">
          <h2>Banking <small>UGX · optional</small></h2>
          <div class="grid3">
            <label class="f">Banked — <span id="bankAcctLabel">Centenary</span><input type="number" step="any" min="0" inputmode="decimal" id="bankCente"></label>
          </div>
          <label class="f" style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-direction:row">
            <input type="checkbox" id="bankingFlag" style="width:auto">
            Non-fuel cash banked together with forecourt today
          </label>
          <p class="hint">Turn this off for a day the station genuinely couldn't bank as one drop — "Unaccounted sales" and "Cash not banked" show "—" for that day instead of a false flag.</p>
        </section>

        <section class="block">
          <h2>Expenses today <small>UGX</small></h2>
          <p class="hint" style="margin-top:0" id="expensesGateHint"></p>
          <div class="tscroll" style="margin-bottom:10px"><table id="expensesTable"></table></div>
          <div class="admin-grid" id="expenseForm">
            <label class="f">Category
              <select id="ex-category">${EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
            </label>
            <label class="f" id="ex-grosswrap">Gross pay (staff costs)<input type="number" step="any" min="0" inputmode="decimal" id="ex-gross"></label>
            <label class="f" id="ex-amountwrap">Amount<input type="number" step="any" min="0" inputmode="decimal" id="ex-amount"></label>
            <label class="f">Paid from
              <select id="ex-paidfrom"><option value="takings">Takings</option><option value="petty_cash">Petty cash</option><option value="bank">Bank</option></select>
            </label>
            <label class="f">Description<input type="text" id="ex-desc"></label>
          </div>
          <button class="btn primary" id="addExpenseBtn">Add expense</button>
          <p class="hint">Staff costs: enter gross pay — the 10% employer NSSF is added automatically and shown in the list below.</p>
        </section>

        <section class="block">
          <h2>Own-use (other) <small>litres</small></h2>
          <p class="hint" style="margin-top:0" id="ownUseGateHint"></p>
          <div class="tscroll" style="margin-bottom:10px"><table id="otherOwnUseTable"></table></div>
          <div class="admin-grid" id="ownUseForm">
            <label class="f">Product
              <select id="ou-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select>
            </label>
            <label class="f">Litres<input type="number" step="any" min="0" inputmode="decimal" id="ou-litres"></label>
            <label class="f">Reason<input type="text" id="ou-reason"></label>
          </div>
          <button class="btn primary" id="addOwnUseBtn">Add own-use</button>
          <p class="hint">For own-use that isn't the generator (which has its own field above) — e.g. a company vehicle fill-up.</p>
        </section>

        <section class="block">
          <h2>Other income <small>UGX</small></h2>
          <p class="hint" style="margin-top:0" id="otherIncomeGateHint"></p>
          <div class="tscroll" style="margin-bottom:10px"><table id="otherIncomeTable"></table></div>
          <div class="admin-grid" id="otherIncomeForm">
            <label class="f">Category
              <select id="oi-category">${OTHER_INCOME_CATEGORIES.map((c) => `<option value="${c.k}">${c.label}</option>`).join("")}</select>
            </label>
            <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="oi-amount"></label>
            <label class="f">Description<input type="text" id="oi-desc"></label>
          </div>
          <button class="btn primary" id="addOtherIncomeBtn">Add other income</button>
        </section>

        <section class="block">
          <h2>Customer transactions <small>credit, prepaid, recoveries, deposits</small></h2>
          <p class="hint" style="margin-top:0" id="txnGateHint"></p>
          <div class="tscroll" style="margin-bottom:10px"><table id="txnTable"></table></div>
          <div class="admin-grid" id="txnForm">
            <label class="f">Type
              <select id="tx-type">${TXN_TYPES.map((t) => `<option value="${t.k}">${t.label}</option>`).join("")}</select>
            </label>
            <label class="f">Customer
              <select id="tx-customer"></select>
            </label>
            <label class="f" id="tx-productwrap">Product
              <select id="tx-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select>
            </label>
            <label class="f" id="tx-litreswrap">Litres<input type="number" step="any" min="0" inputmode="decimal" id="tx-litres"></label>
            <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="tx-amount"></label>
            <label class="f" id="tx-vehiclewrap">Vehicle reg<input type="text" id="tx-vehicle"></label>
            <label class="f" id="tx-modewrap">Mode<input type="text" id="tx-mode" placeholder="cash, momo, etc."></label>
          </div>
          <button class="btn primary" id="addTxnBtn">Add transaction</button>
          <p class="hint">Customers are added in Admin. Credit sale / prepaid draw take a product and litres; recovery / prepaid deposit take a mode instead.</p>
        </section>

        <section class="block">
          <label class="f">Notes (deliveries, pump faults, incidents)
            <textarea id="notes" rows="2"></textarea>
          </label>
        </section>

        <div class="actions">
          <button class="btn primary" id="saveBtn">Save entry</button>
          <button class="btn" id="clearBtn">Clear form</button>
          <button class="btn danger hidden" id="deleteBtn">Delete entry</button>
        </div>
      </div>

      <aside class="readout">
        <div class="pump">
          <div class="lbl">Gross profit (preview)</div>
          <div class="gp num"><small>UGX</small><span id="rGP">0</span></div>
          <div class="split">
            <div><span class="lbl">Fuel</span><b class="num" id="rFuelGP">0</b></div>
            <div><span class="lbl">Shop · LPG · Lubes</span><b class="num" id="rNfGP">0</b></div>
          </div>
          <p class="hint" id="rCostBasisNote"></p>
        </div>
        <div class="checks">
          <h3>Forecourt cash check <small>preview</small></h3>
          <div id="rCash"></div>
        </div>
        <div class="checks">
          <h3>Stock reconciliation <small>preview</small></h3>
          <div id="rStock"></div>
        </div>
        <div class="checks">
          <h3>Totals <small>preview</small></h3>
          <div id="rTotals"></div>
        </div>
        <div class="checks" id="savedReportWrap" style="display:none">
          <h3>Saved report <small>server-computed</small></h3>
          <div id="rSaved"></div>
        </div>
      </aside>
    </div>
  `;

  $(root, "date").value = addDays(iso(new Date()), -1);
  loadedDate = null;

  // This listener is attached to #tabContent, which every page reuses by
  // replacing its innerHTML rather than being remounted — it is never
  // removed on tab switch, so it stays live for the Admin/Reports/Audit
  // markup too unless it checks it's still looking at entry.js's own DOM
  // (confirmed live: typing in Admin after visiting Entry threw "Cannot
  // read properties of null" from readForm() reaching for a #date that
  // Admin's HTML doesn't have).
  root.addEventListener("input", (e) => {
    if (root.dataset.activePage === "entry" && e.target.id !== "date") {
      dirty = true;
      renderCalc(root);
    }
  });
  $(root, "date").addEventListener("change", () => loadDate(root));
  $(root, "saveBtn").addEventListener("click", () => onSave(root));
  $(root, "clearBtn").addEventListener("click", () => {
    fillForm(root, null);
    dirty = true;
    renderCalc(root);
  });
  $(root, "deleteBtn").addEventListener("click", () => onDelete(root));

  $(root, "addDeliveryBtn").addEventListener("click", () => onAddDelivery(root));
  $(root, "deliveriesTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteDelivery(root, Number(b.dataset.del));
  });

  $(root, "ex-category").addEventListener("change", () => updateExpenseFormVisibility(root));
  $(root, "addExpenseBtn").addEventListener("click", () => onAddExpense(root));
  $(root, "expensesTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteExpense(root, Number(b.dataset.del));
  });

  $(root, "addOwnUseBtn").addEventListener("click", () => onAddOwnUse(root));
  $(root, "otherOwnUseTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteOwnUse(root, Number(b.dataset.del));
  });

  $(root, "addOtherIncomeBtn").addEventListener("click", () => onAddOtherIncome(root));
  $(root, "otherIncomeTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteOtherIncome(root, Number(b.dataset.del));
  });

  $(root, "tx-type").addEventListener("change", () => updateTxnFormVisibility(root));
  $(root, "addTxnBtn").addEventListener("click", () => onAddTxn(root));
  $(root, "txnTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteTxn(root, b.dataset.del, b.dataset.deltype);
  });

  applyWriteState(root);
  updateExpenseFormVisibility(root);
  updateTxnFormVisibility(root);
  loadCustomers(root);
  loadDate(root);
}

function applyWriteState(root) {
  const write = canWrite();
  root.querySelectorAll("#fuelGrid input:not([disabled]), .grid4 input, .grid5 input, .grid3 input, textarea").forEach((el) => {
    el.disabled = !write;
  });
  $(root, "bankingFlag").disabled = !write;
  $(root, "saveBtn").disabled = !write;
  $(root, "clearBtn").disabled = !write;
  const canAddChildRows = write && loadedEntryExists;
  ["deliveryForm", "expenseForm", "ownUseForm", "otherIncomeForm", "txnForm"].forEach((id) => {
    root.querySelectorAll("#" + id + " input, #" + id + " select").forEach((el) => (el.disabled = !canAddChildRows));
  });
  $(root, "addDeliveryBtn").disabled = !canAddChildRows;
  $(root, "addExpenseBtn").disabled = !canAddChildRows;
  $(root, "addOwnUseBtn").disabled = !canAddChildRows;
  $(root, "addOtherIncomeBtn").disabled = !canAddChildRows;
  $(root, "addTxnBtn").disabled = !canAddChildRows;
  const gateMsg = write && !loadedEntryExists ? "Save the entry first, then add rows here for this date." : "";
  $(root, "deliveriesGateHint").textContent = gateMsg;
  $(root, "expensesGateHint").textContent = gateMsg;
  $(root, "ownUseGateHint").textContent = gateMsg;
  $(root, "otherIncomeGateHint").textContent = gateMsg;
  $(root, "txnGateHint").textContent = gateMsg;
}

function updateExpenseFormVisibility(root) {
  const isStaff = $(root, "ex-category").value === "Staff costs";
  $(root, "ex-grosswrap").style.display = isStaff ? "" : "none";
  $(root, "ex-amountwrap").style.display = isStaff ? "none" : "";
}

function updateTxnFormVisibility(root) {
  const type = $(root, "tx-type").value;
  const takesProduct = type === "credit" || type === "prepaid_draw";
  $(root, "tx-productwrap").style.display = takesProduct ? "" : "none";
  $(root, "tx-litreswrap").style.display = takesProduct ? "" : "none";
  $(root, "tx-vehiclewrap").style.display = takesProduct ? "" : "none";
  $(root, "tx-modewrap").style.display = takesProduct ? "none" : "";
}

async function loadCustomers(root) {
  // Refetched every time this page is (re)built, not cached for the
  // session — a customer added in Admin must show up in this dropdown the
  // next time someone lands back on Daily Entry, not only after a full
  // page reload. buildForm() only calls this on an actual tab (re)visit,
  // not on every render, so this stays cheap.
  try {
    customers = await listCustomers();
  } catch (err) {
    customers = [];
  }
  renderCustomerOptions(root);
}

function renderCustomerOptions(root) {
  const sel = $(root, "tx-customer");
  if (!sel) return;
  sel.innerHTML = customers.filter((c) => c.is_active).map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
}

function deliveriesTableHtml() {
  if (!deliveries.length) return '<tbody><tr><td class="empty">No deliveries recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Product</th><th>Invoiced L</th><th>Dip before</th><th>Dip after</th><th>Sold during</th><th>Truck</th><th>Invoice</th><th></th></tr></thead><tbody>";
  deliveries.forEach((d) => {
    h += `<tr><td>${d.product}</td><td>${lit(d.invoiced_litres)}</td><td>${has(d.dip_before) ? lit(d.dip_before) : "—"}</td><td>${
      has(d.dip_after) ? lit(d.dip_after) : "—"
    }</td><td>${lit(d.litres_sold_during_offload || 0)}</td><td>${d.truck_reg || "—"}</td><td>${
      d.invoice_no || "—"
    }</td><td>${isAdmin() ? `<button class="btn danger" data-del="${d.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function expensesTableHtml() {
  if (!expenses.length) return '<tbody><tr><td class="empty">No expenses recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Category</th><th>Gross pay</th><th>NSSF</th><th>Amount</th><th>Paid from</th><th>Description</th><th></th></tr></thead><tbody>";
  expenses.forEach((x) => {
    h += `<tr><td>${x.category}</td><td>${has(x.gross_pay) ? ugx(x.gross_pay) : "—"}</td><td>${
      has(x.nssf_amount) ? ugx(x.nssf_amount) : "—"
    }</td><td>${ugx(x.amount)}</td><td>${x.paid_from}</td><td>${x.description || "—"}</td><td>${
      isAdmin() ? `<button class="btn danger" data-del="${x.id}" style="padding:3px 8px">Remove</button>` : ""
    }</td></tr>`;
  });
  return h + "</tbody>";
}

function otherOwnUseTableHtml() {
  if (!otherOwnUse.length) return '<tbody><tr><td class="empty">No other own-use recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Product</th><th>Litres</th><th>Reason</th><th></th></tr></thead><tbody>";
  otherOwnUse.forEach((o) => {
    h += `<tr><td>${o.product}</td><td>${lit(o.litres)}</td><td>${o.reason}</td><td>${
      isAdmin() ? `<button class="btn danger" data-del="${o.id}" style="padding:3px 8px">Remove</button>` : ""
    }</td></tr>`;
  });
  return h + "</tbody>";
}

function otherIncomeTableHtml() {
  if (!otherIncome.length) return '<tbody><tr><td class="empty">No other income recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Category</th><th>Amount</th><th>Description</th><th></th></tr></thead><tbody>";
  otherIncome.forEach((o) => {
    h += `<tr><td>${o.category}</td><td>${ugx(o.amount)}</td><td>${o.description || "—"}</td><td>${
      isAdmin() ? `<button class="btn danger" data-del="${o.id}" style="padding:3px 8px">Remove</button>` : ""
    }</td></tr>`;
  });
  return h + "</tbody>";
}

function txnTableHtml() {
  const rows = [
    ...creditPrepaidDraws.map((x) => ({
      type: x.type === "credit" ? "Credit sale" : "Prepaid draw",
      deltype: "credit_prepaid_draws",
      customer: x.customers?.name || "—",
      detail: (x.product ? x.product + " · " + lit(x.litres || 0) + " L" : "—"),
      amount: x.amount,
      extra: x.vehicle_reg || "—",
      id: x.id,
    })),
    ...recoveries.map((x) => ({
      type: "Recovery",
      deltype: "recoveries",
      customer: x.customers?.name || "—",
      detail: "—",
      amount: x.amount,
      extra: x.mode || "—",
      id: x.id,
    })),
    ...prepaidDeposits.map((x) => ({
      type: "Prepaid deposit",
      deltype: "prepaid_deposits",
      customer: x.customers?.name || "—",
      detail: "—",
      amount: x.amount,
      extra: x.mode || "—",
      id: x.id,
    })),
  ];
  if (!rows.length) return '<tbody><tr><td class="empty">No customer transactions recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Type</th><th>Customer</th><th>Product/litres</th><th>Amount</th><th>Vehicle/mode</th><th></th></tr></thead><tbody>";
  rows.forEach((r) => {
    h += `<tr><td>${r.type}</td><td>${r.customer}</td><td>${r.detail}</td><td>${ugx(r.amount)}</td><td>${r.extra}</td><td>${
      isAdmin() ? `<button class="btn danger" data-del="${r.id}" data-deltype="${r.deltype}" style="padding:3px 8px">Remove</button>` : ""
    }</td></tr>`;
  });
  return h + "</tbody>";
}

async function refreshChildTables(root, date) {
  try {
    [deliveries, expenses, otherOwnUse, otherIncome, creditPrepaidDraws, recoveries, prepaidDeposits] = await Promise.all([
      listDeliveries(date), listExpenses(date), listOtherOwnUse(date), listOtherIncome(date),
      listCreditPrepaidDraws(date), listRecoveries(date), listPrepaidDeposits(date),
    ]);
  } catch (err) {
    deliveries = []; expenses = []; otherOwnUse = []; otherIncome = []; creditPrepaidDraws = []; recoveries = []; prepaidDeposits = [];
    toast("Couldn't load the day's records: " + (err.message || ""));
  }
  $(root, "deliveriesTable").innerHTML = deliveriesTableHtml();
  $(root, "expensesTable").innerHTML = expensesTableHtml();
  $(root, "otherOwnUseTable").innerHTML = otherOwnUseTableHtml();
  $(root, "otherIncomeTable").innerHTML = otherIncomeTableHtml();
  $(root, "txnTable").innerHTML = txnTableHtml();
}

async function refreshSavedReport(root, date) {
  try {
    dayReport = await fetchDayReport(date);
  } catch (err) {
    dayReport = null;
  }
  renderSavedReport(root);
}

function renderSavedReport(root) {
  const wrap = $(root, "savedReportWrap");
  const r = dayReport && dayReport.report;
  if (!r) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  let h = "";
  (dayReport.products || []).forEach((p) => {
    h += kv(
      p.product + " · " + lit(p.sold) + " L × cost " + ugx(p.cost) + (p.cost_is_fallback ? " (FIXED fallback)" : ""),
      ugx(p.fuel_gp)
    );
  });
  h += kv("Fuel GP", ugx(r.fuel_gp)) + kv("Non-fuel GP", ugx(r.nf_gp)) + kv("Total GP", ugx(r.total_gp));
  if (r.cost_fallback_used) h += `<div class="hint neg">Cost basis fell back to FIXED pricing for at least one product today — see Admin.</div>`;
  h += kv("Stock variance (L)", sgn(r.stock_var_total, lit), r.stock_var_total < 0 ? "neg" : r.stock_var_total > 0 ? "pos" : "");
  h += kv("Stock gain/(loss) at cost", sgn(r.stock_gain_loss_at_cost, ugx), r.stock_gain_loss_at_cost < 0 ? "neg" : r.stock_gain_loss_at_cost > 0 ? "pos" : "");
  if (has(r.delivery_shortfall_litres) && Math.abs(r.delivery_shortfall_litres) > 0.5)
    h += kv("Delivery shortfall", sgn(r.delivery_shortfall_litres, lit) + " L / " + sgn(r.delivery_shortfall_at_cost, ugx));
  h += kv("Own-use at cost", ugx(r.own_use_at_cost));
  h += kv("Expenses", ugx(r.expenses_total));
  h += kv("Other income", ugx(r.other_income_total));
  h += kv("Net profit", ugx(r.net_profit), r.net_profit < 0 ? "neg" : "pos");
  h += kv("Cash over/short", r.cash_drop_entered ? sgn(r.cash_over_short, ugx) : "—", r.cash_drop_entered && Math.abs(r.cash_over_short) > 1 ? (r.cash_over_short < 0 ? "neg" : "pos") : "");
  h += kv("Unaccounted sales", r.banking_applicable ? sgn(r.unaccounted_sales, ugx) : "—", r.banking_applicable && Math.abs(r.unaccounted_sales) > 0.5 ? "neg" : "");
  h += kv("Cash not banked", r.banking_applicable ? sgn(r.cash_not_banked, ugx) : "—", r.banking_applicable && Math.abs(r.cash_not_banked) > 0.5 ? "neg" : "");
  $(root, "rSaved").innerHTML = h;
}

function loadDate(root) {
  const d = $(root, "date").value;
  const { entries } = getState();
  const e = entries[d];
  fillForm(root, e || null);
  dirty = false;
  loadedDate = d;
  loadedEntryExists = Boolean(e);
  $(root, "entryStatus").textContent = e
    ? "Saved entry" + (e.updatedAt ? " · last saved " + new Date(e.updatedAt).toLocaleString() : "")
    : "New entry";
  $(root, "saveBtn").textContent = e ? "Update entry" : "Save entry";
  $(root, "deleteBtn").classList.toggle("hidden", !(e && isAdmin()));
  applyWriteState(root);
  renderCalc(root);
  refreshChildTables(root, d);
  refreshSavedReport(root, d);
}

function renderCalc(root) {
  const e = readForm(root);
  if (!e.date) return;
  const { settings, entries, dates } = getState();
  const r = compute(e, { settings, entries, dates });

  $(root, "rGP").textContent = ugx(r.totalGP);
  $(root, "rFuelGP").textContent = ugx(r.fuelGP);
  $(root, "rNfGP").textContent = ugx(r.nfGP);
  $(root, "bankAcctLabel").textContent = settings.bankingAccountName || "Centenary";
  $(root, "rCostBasisNote").textContent = r.costBasisPreviewOnly
    ? `Preview uses FIXED pricing. The station's cost basis is set to ${settings.fuelCostBasis} — the actual GP will be computed server-side once saved and may differ.`
    : "";

  let c = "";
  if (!r.price) {
    c = '<div class="hint">No fuel prices set for this date. An admin needs to add prices.</div>';
  } else {
    PRODUCTS.forEach(({ k, label }) => {
      c += kv(
        label + " · " + lit(r.fuel[k].sold) + " L × " + ugx(num(r.price[k] && r.price[k].price)),
        ugx(r.fuel[k].value)
      );
    });
    c += kv("Forecourt sales (litres × price)", ugx(r.fuelExpected));
    if (r.paidEntered) c += kv("Cash expected (sales − electronic payments)", ugx(r.cashExpected));
    c += kv("Cash drop declared", r.cashDropEntered ? ugx(r.cashDrop) : "—");
    if (r.cashDropEntered) {
      const v = r.cashOverShort;
      c += kv(v < 0 ? "Shortage" : "Over", sgn(v, ugx), v < -1 ? "neg" : v > 1 ? "pos" : "");
    }
  }
  $(root, "rCash").innerHTML = c;

  let s = "";
  if (!r.prevDate) {
    s = '<div class="hint">Opening stock comes from the previous day\'s dip. It will show once an earlier day is saved.</div>';
  } else {
    const overlay = Object.assign({}, entries);
    overlay[e.date] = e;
    const ch = stockChain(overlay, settings)[e.date] || {};
    PRODUCTS.forEach(({ k, label }) => {
      const x = r.stock[k];
      if (!x) {
        s += kv(label, "—");
        return;
      }
      s += kv(
        label +
          ` <span class="hint">(${lit(x.open)} + ${lit(num(e.deliv[k]))} − ${lit(r.fuel[k].sold)} − ${lit(x.ownUse)} = ${lit(x.book)})</span>`,
        sgn(x.v, lit) + " L" + (x.flag ? `<span class="flag">${x.pct.toFixed(2)}%</span>` : ""),
        x.v < 0 ? "neg" : x.v > 0 ? "pos" : ""
      );
      const cc = ch[k];
      if (x.flag && !x.delivered)
        s += `<div class="hint neg">${label}: no delivery recorded, but the dip doesn't match litres sold.</div>`;
      if (cc && !cc.reset && cc.days > 1)
        s += kv(
          `<span class="hint">${label} since ${dmy(cc.since)} (${cc.days} days, no delivery)</span>`,
          sgn(cc.cumVar, lit) + " L" + (cc.flag ? `<span class="flag">${cc.pct.toFixed(2)}%</span>` : ""),
          cc.flag ? "neg" : ""
        );
    });
    const gap = daysBetween(r.prevDate, e.date);
    s += `<div class="hint">Opening stock from ${dmy(r.prevDate)}${
      gap > 1 ? " — " + (gap - 1) + " day(s) missing in between, so this variance covers several days." : "."
    }</div>`;
  }
  $(root, "rStock").innerHTML = s;

  let t = kv("Total sales", ugx(r.totalSales)) + kv("Litres sold", lit(r.litres));
  if (r.paidEntered) t += kv("Payments recorded", ugx(r.paid));
  if (r.bankEntered) {
    t += kv("Banked — " + (settings.bankingAccountName || "Centenary"), ugx(r.bankCente));
    if (has(e.bankExim)) t += kv("Banked — Exim (legacy)", ugx(r.bankExim));
    t += kv("Total banked", ugx(r.banked));
  }
  t += kv("Expenses (from Expenses list)", ugx(r.expenses)) + kv("Gross profit after expenses", ugx(r.afterExp));
  t +=
    kv(
      "Unaccounted sales",
      r.bankingApplicable ? sgn(r.unaccountedSales, ugx) : "—",
      r.bankingApplicable && Math.abs(r.unaccountedSales) > 0.5 ? "neg" : ""
    ) +
    kv(
      "Cash not banked",
      r.bankingApplicable ? sgn(r.cashNotBanked, ugx) : "—",
      r.bankingApplicable && Math.abs(r.cashNotBanked) > 0.5 ? "neg" : ""
    );
  $(root, "rTotals").innerHTML = t;
}

async function onSave(root) {
  const e = readForm(root);
  if (!e.date) {
    toast("Pick the trading date.");
    return;
  }
  if (!PRODUCTS.some(({ k }) => has(e.sold[k]))) {
    toast("Enter litres sold for at least one product.");
    return;
  }
  const btn = $(root, "saveBtn");
  btn.disabled = true;
  try {
    await saveEntry(e);
    dirty = false;
    loadedEntryExists = true;
    applyWriteState(root);
    toast("Entry saved for " + dmy(e.date) + ".");
    refreshSavedReport(root, e.date);
  } catch (err) {
    toast("Couldn't save: " + (err.message || "try again."));
  } finally {
    btn.disabled = !canWrite();
  }
}

async function onDelete(root) {
  const d = $(root, "date").value;
  const { entries } = getState();
  if (!entries[d]) return;
  if (!confirm("Delete the entry for " + dmy(d) + "? This can't be undone.")) return;
  try {
    await deleteEntry(d);
    toast("Entry for " + dmy(d) + " deleted.");
  } catch (err) {
    toast("Couldn't delete: " + (err.message || ""));
  }
}

async function onAddDelivery(root) {
  const date = $(root, "date").value;
  const litres = $(root, "dv-litres").value;
  if (litres === "" || num(litres) <= 0) {
    toast("Enter the invoiced litres.");
    return;
  }
  const row = {
    trading_date: date,
    product: $(root, "dv-product").value,
    invoiced_litres: num(litres),
    dip_before: $(root, "dv-dipbefore").value === "" ? null : num($(root, "dv-dipbefore").value),
    dip_after: $(root, "dv-dipafter").value === "" ? null : num($(root, "dv-dipafter").value),
    litres_sold_during_offload: num($(root, "dv-soldduring").value || 0),
    truck_reg: $(root, "dv-truck").value.trim() || null,
    invoice_no: $(root, "dv-invoice").value.trim() || null,
  };
  try {
    await addDelivery(row);
    ["dv-litres", "dv-dipbefore", "dv-dipafter", "dv-soldduring", "dv-truck", "dv-invoice"].forEach((id) => ($(root, id).value = ""));
    toast("Delivery added.");
    await refreshChildTables(root, date);
    // deliv_pms/ago/vp is trigger-synced server-side — refetch this one
    // row directly rather than waiting on the Realtime subscription to
    // catch the trigger's own daily_entries UPDATE (unbounded race).
    const updated = await refreshEntry(date);
    if (updated) fillForm(root, updated);
    renderCalc(root);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't add delivery: " + (err.message || ""));
  }
}

async function onDeleteDelivery(root, id) {
  if (!confirm("Remove this delivery?")) return;
  const date = $(root, "date").value;
  try {
    await deleteDelivery(id);
    await refreshChildTables(root, date);
    const updated = await refreshEntry(date);
    if (updated) fillForm(root, updated);
    renderCalc(root);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't remove delivery: " + (err.message || ""));
  }
}

async function onAddExpense(root) {
  const date = $(root, "date").value;
  const category = $(root, "ex-category").value;
  const isStaff = category === "Staff costs";
  const row = {
    trading_date: date,
    category,
    paid_from: $(root, "ex-paidfrom").value,
    description: $(root, "ex-desc").value.trim() || null,
  };
  if (isStaff) {
    const gross = $(root, "ex-gross").value;
    if (gross === "" || num(gross) <= 0) {
      toast("Enter the gross pay.");
      return;
    }
    row.gross_pay = num(gross);
    row.amount = num(gross); // overwritten server-side (gross + 10% NSSF) by the Staff-costs trigger
  } else {
    const amount = $(root, "ex-amount").value;
    if (amount === "" || num(amount) <= 0) {
      toast("Enter the amount.");
      return;
    }
    row.amount = num(amount);
  }
  try {
    await addExpense(row);
    ["ex-gross", "ex-amount", "ex-desc"].forEach((id) => ($(root, id).value = ""));
    toast("Expense added.");
    await refreshChildTables(root, date);
    const updated = await refreshEntry(date);
    if (updated) fillForm(root, updated);
    renderCalc(root);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't add expense: " + (err.message || ""));
  }
}

async function onDeleteExpense(root, id) {
  if (!confirm("Remove this expense?")) return;
  const date = $(root, "date").value;
  try {
    await deleteExpense(id);
    await refreshChildTables(root, date);
    const updated = await refreshEntry(date);
    if (updated) fillForm(root, updated);
    renderCalc(root);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't remove expense: " + (err.message || ""));
  }
}

async function onAddOwnUse(root) {
  const date = $(root, "date").value;
  const litres = $(root, "ou-litres").value;
  const reason = $(root, "ou-reason").value.trim();
  if (litres === "" || num(litres) <= 0) {
    toast("Enter the litres.");
    return;
  }
  if (!reason) {
    toast("Enter the reason.");
    return;
  }
  try {
    await addOtherOwnUse({ trading_date: date, product: $(root, "ou-product").value, litres: num(litres), reason });
    $(root, "ou-litres").value = "";
    $(root, "ou-reason").value = "";
    toast("Own-use added.");
    await refreshChildTables(root, date);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't add own-use: " + (err.message || ""));
  }
}

async function onDeleteOwnUse(root, id) {
  if (!confirm("Remove this own-use entry?")) return;
  const date = $(root, "date").value;
  try {
    await deleteOtherOwnUse(id);
    await refreshChildTables(root, date);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't remove: " + (err.message || ""));
  }
}

async function onAddOtherIncome(root) {
  const date = $(root, "date").value;
  const amount = $(root, "oi-amount").value;
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    await addOtherIncome({
      trading_date: date,
      category: $(root, "oi-category").value,
      amount: num(amount),
      description: $(root, "oi-desc").value.trim() || null,
    });
    $(root, "oi-amount").value = "";
    $(root, "oi-desc").value = "";
    toast("Other income added.");
    await refreshChildTables(root, date);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't add other income: " + (err.message || ""));
  }
}

async function onDeleteOtherIncome(root, id) {
  if (!confirm("Remove this other income entry?")) return;
  const date = $(root, "date").value;
  try {
    await deleteOtherIncome(id);
    await refreshChildTables(root, date);
    refreshSavedReport(root, date);
  } catch (err) {
    toast("Couldn't remove: " + (err.message || ""));
  }
}

async function onAddTxn(root) {
  const date = $(root, "date").value;
  const type = $(root, "tx-type").value;
  const customerId = $(root, "tx-customer").value;
  const amount = $(root, "tx-amount").value;
  if (!customerId) {
    toast("Pick a customer. Add one in Admin if the list is empty.");
    return;
  }
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    if (type === "credit" || type === "prepaid_draw") {
      await addCreditPrepaidDraw({
        trading_date: date,
        customer_id: Number(customerId),
        type,
        product: $(root, "tx-product").value,
        litres: $(root, "tx-litres").value === "" ? null : num($(root, "tx-litres").value),
        amount: num(amount),
        vehicle_reg: $(root, "tx-vehicle").value.trim() || null,
      });
    } else if (type === "recovery") {
      await addRecovery({ trading_date: date, customer_id: Number(customerId), amount: num(amount), mode: $(root, "tx-mode").value.trim() || null });
    } else {
      await addPrepaidDeposit({ trading_date: date, customer_id: Number(customerId), amount: num(amount), mode: $(root, "tx-mode").value.trim() || null });
    }
    ["tx-litres", "tx-amount", "tx-vehicle", "tx-mode"].forEach((id) => ($(root, id).value = ""));
    toast("Transaction added.");
    await refreshChildTables(root, date);
  } catch (err) {
    toast("Couldn't add transaction: " + (err.message || ""));
  }
}

async function onDeleteTxn(root, id, deltype) {
  if (!confirm("Remove this transaction?")) return;
  const date = $(root, "date").value;
  const fn = { credit_prepaid_draws: deleteCreditPrepaidDraw, recoveries: deleteRecovery, prepaid_deposits: deletePrepaidDeposit }[deltype];
  if (!fn) return;
  try {
    await fn(Number(id));
    await refreshChildTables(root, date);
  } catch (err) {
    toast("Couldn't remove: " + (err.message || ""));
  }
}

export function openDate(container, date) {
  buildForm(container);
  container.dataset.activePage = "entry";
  $(container, "date").value = date;
  loadDate(container);
  window.scrollTo(0, 0);
}

export function renderEntry(root) {
  const needsBuild = root.dataset.activePage !== "entry" || !root.querySelector("#fuelGrid");
  if (needsBuild) {
    buildForm(root);
    root.dataset.activePage = "entry";
    return;
  }
  applyWriteState(root);
  const active = document.activeElement;
  const editing = root.contains(active) && active.id !== "date";
  if (!editing && !dirty) {
    const d = $(root, "date").value;
    const { entries } = getState();
    const e = entries[d];
    fillForm(root, e || null);
    loadedEntryExists = Boolean(e);
    $(root, "entryStatus").textContent = e
      ? "Saved entry" + (e.updatedAt ? " · last saved " + new Date(e.updatedAt).toLocaleString() : "")
      : "New entry";
    $(root, "saveBtn").textContent = e ? "Update entry" : "Save entry";
    $(root, "deleteBtn").classList.toggle("hidden", !(e && isAdmin()));
    applyWriteState(root);
  }
  if (!editing) renderCalc(root);
}
