// Cashier "Daily Money" — PLAN_PHASE2.md section 6 / spec 5.5, sections
// A-G. Same draft-table-only discipline as manager.js.

import { PRODUCTS } from "../lib/calc.js";
import { num, has, ugx, lit, dmy, iso, addDays, esc } from "../lib/format.js";
import { listCustomers } from "../lib/data.js";
import {
  fetchDayRecord, submitCashierPart, saveCashierTextHash,
  listNozzleMeters, fetchManagerDayEntry, fetchManagerPrices,
  fetchCashierDayEntry, saveCashierDayEntry,
  listSafeCounts, saveSafeCount, lockSafeCount,
  listDraftRecoveries, addDraftRecovery, deleteDraftRecovery,
  listDraftPrepaidDeposits, addDraftPrepaidDeposit, deleteDraftPrepaidDeposit,
  listDraftExpenses, addDraftExpense, deleteDraftExpense, confirmDraftExpense,
  listDraftCreditPrepaidDraws,
  draftOtherIncome,
  pettyCashLedger,
  uploadDayRecordPhoto,
} from "../lib/records.js";
import { buildCashierText, hashText } from "../lib/whatsapp.js";
import { toast } from "../lib/toast.js";

let currentDate = null;
let dayRecord = null;
let cashierEntry = null;
let safeCounts = [];
let recoveries = [];
let deposits = [];
let takingsPayments = []; // draft_expense_entries, paid_from in (takings, petty_cash) that the cashier itself logs
let stockPurchases = []; // the manager's own takings-paid entries, for confirming
let pettyCash = [];
let customers = [];
let previewInputs = null; // { prices, grossByProduct, manager, creditSum, otherIncomeSum }

function $(root, id) {
  return root.querySelector("#" + id);
}

function isEditable() {
  return dayRecord && (dayRecord.status === "OPEN" || dayRecord.status === "MANAGER_SUBMITTED");
}

function build(root) {
  root.innerHTML = `
    <section class="block">
      <div class="daterow">
        <label class="f">Trading date<input type="date" id="date"></label>
        <div class="status" id="cStatus"></div>
      </div>
      <p class="hint" id="cLateHint"></p>
    </section>

    <section class="block">
      <h2>A · Safe count <small>blind — count before looking at anything else</small></h2>
      <div class="grid3">
        <label class="f">Day shift — counted<input type="number" step="any" min="0" inputmode="decimal" id="safe-day-amount"></label>
        <label class="f">Day shift — witness<input type="text" id="safe-day-witness"></label>
        <label class="f">Day shift<button class="btn" id="lockDayBtn">Lock count</button></label>
      </div>
      <div class="grid3" style="margin-top:8px">
        <label class="f">Night shift — counted<input type="number" step="any" min="0" inputmode="decimal" id="safe-night-amount"></label>
        <label class="f">Night shift — witness<input type="text" id="safe-night-witness"></label>
        <label class="f">Night shift<button class="btn" id="lockNightBtn">Lock count</button></label>
      </div>
      <button class="btn primary" id="saveSafeBtn">Save safe count</button>
      <p class="hint" id="safeLockHint"></p>
    </section>

    <section class="block">
      <h2>B · Payment channels <small>UGX</small></h2>
      <div class="grid5">
        <label class="f">Shell Card<input type="number" step="any" min="0" inputmode="decimal" id="pay-shell"></label>
        <label class="f">Centenary Visa<input type="number" step="any" min="0" inputmode="decimal" id="pay-visa"></label>
        <label class="f">Airtel Pay<input type="number" step="any" min="0" inputmode="decimal" id="pay-airtel"></label>
        <label class="f">MTN MoMo Pay<input type="number" step="any" min="0" inputmode="decimal" id="pay-momo"></label>
        <label class="f">Absa Card<input type="number" step="any" min="0" inputmode="decimal" id="pay-absa"></label>
      </div>
      <button class="btn primary" id="savePaymentsBtn">Save payment channels</button>
    </section>

    <section class="block">
      <h2>C · Recoveries</h2>
      <div class="tscroll" style="margin-bottom:10px"><table id="recoveriesTable"></table></div>
      <div class="admin-grid" id="recoveryForm">
        <label class="f">Customer<select id="rc-customer"></select></label>
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="rc-amount"></label>
        <label class="f">Mode<input type="text" id="rc-mode" placeholder="cash, momo, etc."></label>
      </div>
      <button class="btn primary" id="addRecoveryBtn">Add recovery</button>
    </section>

    <section class="block">
      <h2>D · Prepaid deposits</h2>
      <div class="tscroll" style="margin-bottom:10px"><table id="depositsTable"></table></div>
      <div class="admin-grid" id="depositForm">
        <label class="f">Customer<select id="dp-customer"></select></label>
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="dp-amount"></label>
        <label class="f">Mode<input type="text" id="dp-mode"></label>
      </div>
      <button class="btn primary" id="addDepositBtn">Add deposit</button>
    </section>

    <section class="block">
      <h2>E · Payments from takings</h2>
      <h3 style="margin:0 0 6px">Manager's stock purchases — confirm</h3>
      <div class="tscroll" style="margin-bottom:10px"><table id="stockPurchaseConfirmTable"></table></div>
      <h3 style="margin:14px 0 6px">Other payments from takings</h3>
      <div class="tscroll" style="margin-bottom:10px"><table id="takingsTable"></table></div>
      <div class="admin-grid" id="takingsForm">
        <label class="f">Category
          <select id="tk-category">
            <option>Electricity</option><option>Water</option><option>Generator fuel</option>
            <option>Stationery</option><option>Housekeeping</option><option>Repairs</option>
            <option>Transport</option><option>Bank charges</option><option>Other</option>
          </select>
        </label>
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="tk-amount"></label>
        <label class="f">Description<input type="text" id="tk-desc"></label>
      </div>
      <button class="btn primary" id="addTakingsBtn">Add payment</button>
    </section>

    <section class="block">
      <h2>F · Petty cash</h2>
      <div class="tscroll" style="margin-bottom:10px"><table id="pettyCashTable"></table></div>
      <div class="admin-grid" id="pettyCashForm">
        <label class="f">Event
          <select id="pc-type"><option value="opening">Opening</option><option value="topup">Top-up</option><option value="spend">Spend</option><option value="closing">Closing</option></select>
        </label>
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="pc-amount"></label>
        <label class="f">Note<input type="text" id="pc-note"></label>
      </div>
      <button class="btn primary" id="addPettyCashBtn">Add entry</button>
    </section>

    <section class="block">
      <h2>G · Banking</h2>
      <div class="grid3">
        <label class="f">Banked<input type="number" step="any" min="0" inputmode="decimal" id="bank-amount"></label>
        <label class="f">Slip no.<input type="text" id="bank-slip"></label>
        <label class="f">Slip photo<input type="file" id="bank-slip-photo" accept="image/*"></label>
      </div>
      <label class="f" style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-direction:row">
        <input type="checkbox" id="bankingFlag" style="width:auto">
        Non-fuel cash banked together with forecourt today
      </label>
      <label class="f" style="margin-top:6px">Note (if different from usual)<input type="text" id="bankingFlagNote"></label>
      <button class="btn primary" id="saveBankingBtn">Save banking</button>
    </section>

    <section class="block" id="previewBlock">
      <h2>Expected cash <small>preview — not yet the server's figure</small></h2>
      <div id="previewReadout"></div>
      <p class="hint">This is computed here for a sanity check before you submit. The figure that counts is the one the server computes once the director approves the day.</p>
    </section>

    <div class="actions">
      <button class="btn primary" id="submitBtn">Submit cashier part</button>
    </div>
    <div id="whatsappPreview" style="margin-top:14px"></div>
  `;

  $(root, "date").value = addDays(iso(new Date()), -1);
  $(root, "date").addEventListener("change", () => loadDate(root));
  $(root, "saveSafeBtn").addEventListener("click", () => onSaveSafeCounts(root));
  $(root, "lockDayBtn").addEventListener("click", () => onLockSafeCount(root, "day"));
  $(root, "lockNightBtn").addEventListener("click", () => onLockSafeCount(root, "night"));
  $(root, "savePaymentsBtn").addEventListener("click", () => onSavePayments(root));
  $(root, "addRecoveryBtn").addEventListener("click", () => onAddRecovery(root));
  $(root, "recoveriesTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteRecovery(root, Number(b.dataset.del));
  });
  $(root, "addDepositBtn").addEventListener("click", () => onAddDeposit(root));
  $(root, "depositsTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteDeposit(root, Number(b.dataset.del));
  });
  $(root, "stockPurchaseConfirmTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-confirm]");
    if (b) onConfirmStockPurchase(root, Number(b.dataset.confirm));
  });
  $(root, "addTakingsBtn").addEventListener("click", () => onAddTakings(root));
  $(root, "takingsTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteTakings(root, Number(b.dataset.del));
  });
  $(root, "addPettyCashBtn").addEventListener("click", () => onAddPettyCash(root));
  $(root, "pettyCashTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeletePettyCash(root, Number(b.dataset.del));
  });
  $(root, "saveBankingBtn").addEventListener("click", () => onSaveBanking(root));
  $(root, "submitBtn").addEventListener("click", () => onSubmit(root));

  loadCustomers(root);
  loadDate(root);
}

async function loadCustomers(root) {
  try {
    customers = await listCustomers();
  } catch {
    customers = [];
  }
  const opts = customers.filter((c) => c.is_active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  if ($(root, "rc-customer")) $(root, "rc-customer").innerHTML = opts;
  if ($(root, "dp-customer")) $(root, "dp-customer").innerHTML = opts;
}

function safeCountsTableHtml() {
  const day = safeCounts.find((s) => s.shift === "day");
  const night = safeCounts.find((s) => s.shift === "night");
  return `Day: ${day ? ugx(day.counted_amount) + (day.locked_at ? " (locked)" : "") : "—"} · Night: ${night ? ugx(night.counted_amount) + (night.locked_at ? " (locked)" : "") : "—"}`;
}

function recoveriesTableHtml() {
  if (!recoveries.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Customer</th><th>Amount</th><th>Mode</th><th></th></tr></thead><tbody>";
  recoveries.forEach((r) => {
    h += `<tr><td>${r.customers?.name || "—"}</td><td>${ugx(r.amount)}</td><td>${r.mode || "—"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${r.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function depositsTableHtml() {
  if (!deposits.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Customer</th><th>Amount</th><th>Mode</th><th></th></tr></thead><tbody>";
  deposits.forEach((d) => {
    h += `<tr><td>${d.customers?.name || "—"}</td><td>${ugx(d.amount)}</td><td>${d.mode || "—"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${d.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function stockPurchaseConfirmTableHtml() {
  if (!stockPurchases.length) return '<tbody><tr><td class="empty">None logged by the manager today.</td></tr></tbody>';
  let h = "<thead><tr><th>Amount</th><th>Description</th><th></th></tr></thead><tbody>";
  stockPurchases.forEach((s) => {
    h += `<tr><td>${ugx(s.amount)}</td><td>${s.description || "—"}</td><td>${
      s.confirmed_at ? "Confirmed" : isEditable() ? `<button class="btn primary" data-confirm="${s.id}" style="padding:3px 8px">Confirm</button>` : "Not confirmed"
    }</td></tr>`;
  });
  return h + "</tbody>";
}

function takingsTableHtml() {
  if (!takingsPayments.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Category</th><th>Amount</th><th>Description</th><th></th></tr></thead><tbody>";
  takingsPayments.forEach((t) => {
    h += `<tr><td>${t.category}</td><td>${ugx(t.amount)}</td><td>${t.description || "—"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${t.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function pettyCashTableHtml() {
  if (!pettyCash.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Event</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>";
  pettyCash.forEach((p) => {
    h += `<tr><td>${p.event_type}</td><td>${ugx(p.amount)}</td><td>${p.note || "—"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${p.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function applyEditableState(root) {
  const editable = isEditable();
  root.querySelectorAll("input, textarea, select, button").forEach((el) => {
    if (el.id === "date") return;
    el.disabled = !editable;
  });
  const submitBtn = $(root, "submitBtn");
  if (submitBtn) submitBtn.disabled = !editable || !dayRecord || dayRecord.status !== "MANAGER_SUBMITTED";
}

function numOrNull(v) {
  return v === "" || v === undefined || v === null ? null : num(v);
}

async function loadDate(root) {
  const date = $(root, "date").value;
  currentDate = date;
  dayRecord = await fetchDayRecord(date).catch(() => null);

  const [c, safe, rec, dep, draftExp, pc, prices, nozzles, manager, credits] = await Promise.all([
    fetchCashierDayEntry(date).catch(() => null),
    listSafeCounts(date).catch(() => []),
    listDraftRecoveries(date).catch(() => []),
    listDraftPrepaidDeposits(date).catch(() => []),
    listDraftExpenses(date).catch(() => []),
    pettyCashLedger.list(date).catch(() => []),
    fetchManagerPrices().catch(() => null),
    listNozzleMeters(date).catch(() => []),
    fetchManagerDayEntry(date).catch(() => null),
    listDraftCreditPrepaidDraws(date).catch(() => []),
  ]);
  cashierEntry = c;
  safeCounts = safe;
  recoveries = rec;
  deposits = dep;
  stockPurchases = draftExp.filter((x) => x.category === "Shop expenses" && x.paid_from === "takings");
  takingsPayments = draftExp.filter((x) => !(x.category === "Shop expenses" && x.paid_from === "takings"));
  pettyCash = pc;
  const otherIncome = await draftOtherIncome.list(date).catch(() => []);

  previewInputs = { prices, nozzles, manager, credits, otherIncome };

  fillForm(root);
  renderTables(root);
  renderStatus(root);
  renderPreview(root);
  applyEditableState(root);
}

function fillForm(root) {
  const day = safeCounts.find((s) => s.shift === "day");
  const night = safeCounts.find((s) => s.shift === "night");
  $(root, "safe-day-amount").value = day ? day.counted_amount : "";
  $(root, "safe-day-witness").value = day ? day.witness_name : "";
  $(root, "safe-night-amount").value = night ? night.counted_amount : "";
  $(root, "safe-night-witness").value = night ? night.witness_name : "";
  $(root, "safeLockHint").textContent = safeCountsTableHtml();
  $(root, "lockDayBtn").disabled = !isEditable() || !day || Boolean(day?.locked_at);
  $(root, "lockNightBtn").disabled = !isEditable() || !night || Boolean(night?.locked_at);
  if (day?.locked_at) { $(root, "safe-day-amount").disabled = true; $(root, "safe-day-witness").disabled = true; }
  if (night?.locked_at) { $(root, "safe-night-amount").disabled = true; $(root, "safe-night-witness").disabled = true; }

  $(root, "pay-shell").value = cashierEntry && has(cashierEntry.pay_shell_card) ? cashierEntry.pay_shell_card : "";
  $(root, "pay-visa").value = cashierEntry && has(cashierEntry.pay_visa) ? cashierEntry.pay_visa : "";
  $(root, "pay-airtel").value = cashierEntry && has(cashierEntry.pay_airtel) ? cashierEntry.pay_airtel : "";
  $(root, "pay-momo").value = cashierEntry && has(cashierEntry.pay_momo_mtn) ? cashierEntry.pay_momo_mtn : "";
  $(root, "pay-absa").value = cashierEntry && has(cashierEntry.pay_absa) ? cashierEntry.pay_absa : "";
  $(root, "bank-amount").value = cashierEntry && has(cashierEntry.bank_centenary) ? cashierEntry.bank_centenary : "";
  $(root, "bank-slip").value = (cashierEntry && cashierEntry.banking_slip_no) || "";
  $(root, "bankingFlag").checked = cashierEntry ? Boolean(cashierEntry.non_fuel_cash_banked_with_forecourt) : true;
  $(root, "bankingFlagNote").value = (cashierEntry && cashierEntry.banking_flag_note) || "";
}

function renderTables(root) {
  $(root, "recoveriesTable").innerHTML = recoveriesTableHtml();
  $(root, "depositsTable").innerHTML = depositsTableHtml();
  $(root, "stockPurchaseConfirmTable").innerHTML = stockPurchaseConfirmTableHtml();
  $(root, "takingsTable").innerHTML = takingsTableHtml();
  $(root, "pettyCashTable").innerHTML = pettyCashTableHtml();
}

function renderStatus(root) {
  const s = dayRecord?.status || "OPEN";
  const labels = {
    OPEN: "Not yet submitted by the manager",
    MANAGER_SUBMITTED: "Manager submitted — your turn",
    CASHIER_SUBMITTED: "Submitted — awaiting approval",
    APPROVED: "Approved",
  };
  $(root, "cStatus").textContent = labels[s] || s;
  $(root, "cLateHint").textContent = dayRecord?.returned_reason ? `Returned for correction: ${dayRecord.returned_reason}` : "";
}

// Preview only — same "never the source of truth" discipline as Phase
// 1's calc.js. Approximates Section 3's formula from draft tables this
// session can read; skips other_own_use's rare "other" bucket (own-use
// beyond the generator figure) since that table stays manager-only and
// this is a sanity check, not the final figure.
function renderPreview(root) {
  const { prices, nozzles, manager, credits, otherIncome } = previewInputs || {};
  if (!prices || !nozzles?.length) {
    $(root, "previewReadout").innerHTML = '<div class="hint">Not enough data yet to preview — the manager needs to fill in meters and prices need to be set.</div>';
    return;
  }
  const grossByProduct = { PMS: 0, AGO: 0, VP: 0 };
  nozzles.forEach((n) => {
    const p = n.nozzle_id.replace(/[0-9]+$/, "");
    grossByProduct[p] += (n.closing || 0) - (n.opening || 0);
  });
  const sold = {
    PMS: grossByProduct.PMS - (manager?.pumptest_returned_pms || 0) - (manager?.genuse_pms || 0),
    AGO: grossByProduct.AGO - (manager?.pumptest_returned_ago || 0) - (manager?.genuse_ago || 0),
    VP: grossByProduct.VP - (manager?.pumptest_returned_vp || 0) - (manager?.genuse_vp || 0),
  };
  const forecourtSales = sold.PMS * (prices.pms_price || 0) + sold.AGO * (prices.ago_price || 0) + sold.VP * (prices.vp_price || 0);
  const nonFuelSales = (manager?.shop_sales || 0) + (manager?.lpg_sales || 0) + (manager?.lubes_sales || 0);
  const otherIncomeSum = (otherIncome || []).reduce((s, o) => s + Number(o.amount || 0), 0);
  const creditSum = (credits || []).filter((c) => c.type === "credit").reduce((s, c) => s + Number(c.amount || 0), 0);
  const channels =
    num($(root, "pay-shell").value) + num($(root, "pay-visa").value) + num($(root, "pay-airtel").value) +
    num($(root, "pay-momo").value) + num($(root, "pay-absa").value) + creditSum;
  const expected = forecourtSales + nonFuelSales + otherIncomeSum - channels;
  const countedCash = safeCounts.reduce((s, c) => s + Number(c.counted_amount || 0), 0);
  const overShort = countedCash - expected;
  const banked = num($(root, "bank-amount").value);
  const notBanked = countedCash - banked;

  $(root, "previewReadout").innerHTML =
    `<div class="kv"><span>Forecourt sales (preview)</span><b class="num">${ugx(forecourtSales)}</b></div>` +
    `<div class="kv"><span>Non-fuel sales</span><b class="num">${ugx(nonFuelSales)}</b></div>` +
    `<div class="kv"><span>Other income</span><b class="num">${ugx(otherIncomeSum)}</b></div>` +
    `<div class="kv"><span>Expected cash</span><b class="num">${ugx(expected)}</b></div>` +
    `<div class="kv"><span>Counted cash (safe counts)</span><b class="num">${ugx(countedCash)}</b></div>` +
    `<div class="kv"><span>Over/(Short)</span><b class="num ${overShort < -1 ? "neg" : overShort > 1 ? "pos" : ""}">${ugx(overShort)}</b></div>` +
    `<div class="kv"><span>Not banked</span><b class="num ${Math.abs(notBanked) > 1 ? "neg" : ""}">${ugx(notBanked)}</b></div>`;
}

async function onSaveSafeCounts(root) {
  const dayAmount = $(root, "safe-day-amount").value;
  const dayWitness = $(root, "safe-day-witness").value.trim();
  const nightAmount = $(root, "safe-night-amount").value;
  const nightWitness = $(root, "safe-night-witness").value.trim();
  try {
    if (dayAmount !== "") {
      if (!dayWitness) { toast("Enter the day-shift witness name."); return; }
      await saveSafeCount({ trading_date: currentDate, shift: "day", counted_amount: num(dayAmount), witness_name: dayWitness });
    }
    if (nightAmount !== "") {
      if (!nightWitness) { toast("Enter the night-shift witness name."); return; }
      await saveSafeCount({ trading_date: currentDate, shift: "night", counted_amount: num(nightAmount), witness_name: nightWitness });
    }
    safeCounts = await listSafeCounts(currentDate);
    fillForm(root);
    renderPreview(root);
    toast("Safe count saved.");
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onLockSafeCount(root, shift) {
  if (!confirm(`Lock the ${shift}-shift count? You won't be able to change it afterward.`)) return;
  try {
    await lockSafeCount(currentDate, shift);
    safeCounts = await listSafeCounts(currentDate);
    fillForm(root);
    toast("Count locked.");
  } catch (err) {
    toast("Couldn't lock: " + (err.message || ""));
  }
}

async function onSavePayments(root) {
  try {
    await saveCashierDayEntry(currentDate, {
      pay_shell_card: numOrNull($(root, "pay-shell").value),
      pay_visa: numOrNull($(root, "pay-visa").value),
      pay_airtel: numOrNull($(root, "pay-airtel").value),
      pay_momo_mtn: numOrNull($(root, "pay-momo").value),
      pay_absa: numOrNull($(root, "pay-absa").value),
    });
    toast("Payment channels saved.");
    renderPreview(root);
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onAddRecovery(root) {
  const customerId = $(root, "rc-customer").value;
  const amount = $(root, "rc-amount").value;
  if (!customerId || amount === "" || num(amount) <= 0) {
    toast("Pick a customer and enter the amount.");
    return;
  }
  try {
    await addDraftRecovery({ trading_date: currentDate, customer_id: Number(customerId), amount: num(amount), mode: $(root, "rc-mode").value.trim() || null });
    $(root, "rc-amount").value = "";
    $(root, "rc-mode").value = "";
    recoveries = await listDraftRecoveries(currentDate);
    $(root, "recoveriesTable").innerHTML = recoveriesTableHtml();
    toast("Recovery added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteRecovery(root, id) {
  if (!confirm("Remove this recovery?")) return;
  await deleteDraftRecovery(id);
  recoveries = await listDraftRecoveries(currentDate);
  $(root, "recoveriesTable").innerHTML = recoveriesTableHtml();
}

async function onAddDeposit(root) {
  const customerId = $(root, "dp-customer").value;
  const amount = $(root, "dp-amount").value;
  if (!customerId || amount === "" || num(amount) <= 0) {
    toast("Pick a customer and enter the amount.");
    return;
  }
  try {
    await addDraftPrepaidDeposit({ trading_date: currentDate, customer_id: Number(customerId), amount: num(amount), mode: $(root, "dp-mode").value.trim() || null });
    $(root, "dp-amount").value = "";
    $(root, "dp-mode").value = "";
    deposits = await listDraftPrepaidDeposits(currentDate);
    $(root, "depositsTable").innerHTML = depositsTableHtml();
    toast("Deposit added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteDeposit(root, id) {
  if (!confirm("Remove this deposit?")) return;
  await deleteDraftPrepaidDeposit(id);
  deposits = await listDraftPrepaidDeposits(currentDate);
  $(root, "depositsTable").innerHTML = depositsTableHtml();
}

async function onConfirmStockPurchase(root, id) {
  try {
    await confirmDraftExpense(id);
    const all = await listDraftExpenses(currentDate);
    stockPurchases = all.filter((x) => x.category === "Shop expenses" && x.paid_from === "takings");
    takingsPayments = all.filter((x) => !(x.category === "Shop expenses" && x.paid_from === "takings"));
    $(root, "stockPurchaseConfirmTable").innerHTML = stockPurchaseConfirmTableHtml();
    toast("Confirmed.");
  } catch (err) {
    toast("Couldn't confirm: " + (err.message || ""));
  }
}

async function onAddTakings(root) {
  const amount = $(root, "tk-amount").value;
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    await addDraftExpense({
      trading_date: currentDate,
      category: $(root, "tk-category").value,
      paid_from: "takings",
      amount: num(amount),
      description: $(root, "tk-desc").value.trim() || null,
    });
    $(root, "tk-amount").value = "";
    $(root, "tk-desc").value = "";
    const all = await listDraftExpenses(currentDate);
    takingsPayments = all.filter((x) => !(x.category === "Shop expenses" && x.paid_from === "takings"));
    $(root, "takingsTable").innerHTML = takingsTableHtml();
    toast("Payment added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteTakings(root, id) {
  if (!confirm("Remove this payment?")) return;
  await deleteDraftExpense(id);
  const all = await listDraftExpenses(currentDate);
  takingsPayments = all.filter((x) => !(x.category === "Shop expenses" && x.paid_from === "takings"));
  $(root, "takingsTable").innerHTML = takingsTableHtml();
}

async function onAddPettyCash(root) {
  const amount = $(root, "pc-amount").value;
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    await pettyCashLedger.add({ trading_date: currentDate, event_type: $(root, "pc-type").value, amount: num(amount), note: $(root, "pc-note").value.trim() || null });
    $(root, "pc-amount").value = "";
    $(root, "pc-note").value = "";
    pettyCash = await pettyCashLedger.list(currentDate);
    $(root, "pettyCashTable").innerHTML = pettyCashTableHtml();
    toast("Entry added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeletePettyCash(root, id) {
  if (!confirm("Remove this entry?")) return;
  await pettyCashLedger.remove(id);
  pettyCash = await pettyCashLedger.list(currentDate);
  $(root, "pettyCashTable").innerHTML = pettyCashTableHtml();
}

async function onSaveBanking(root) {
  try {
    let photoPath = cashierEntry?.banking_slip_photo_url || null;
    const file = $(root, "bank-slip-photo").files[0];
    if (file) photoPath = await uploadDayRecordPhoto(currentDate, "cashier", file);
    await saveCashierDayEntry(currentDate, {
      bank_centenary: numOrNull($(root, "bank-amount").value),
      banking_slip_no: $(root, "bank-slip").value.trim() || null,
      banking_slip_photo_url: photoPath,
      non_fuel_cash_banked_with_forecourt: $(root, "bankingFlag").checked,
      banking_flag_note: $(root, "bankingFlagNote").value.trim() || null,
    });
    cashierEntry = await fetchCashierDayEntry(currentDate);
    toast("Banking saved.");
    renderPreview(root);
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onSubmit(root) {
  if (!cashierEntry?.banking_slip_no) {
    if (!confirm("No banking slip number entered yet. Submit anyway?")) return;
  }
  await onSaveBanking(root);
  const [cEntry, safe, rec, dep, pc] = await Promise.all([
    fetchCashierDayEntry(currentDate),
    listSafeCounts(currentDate),
    listDraftRecoveries(currentDate),
    listDraftPrepaidDeposits(currentDate),
    pettyCashLedger.list(currentDate),
  ]);
  const { prices, nozzles, manager, credits, otherIncome } = previewInputs || {};
  const grossByProduct = { PMS: 0, AGO: 0, VP: 0 };
  (nozzles || []).forEach((n) => {
    const p = n.nozzle_id.replace(/[0-9]+$/, "");
    grossByProduct[p] += (n.closing || 0) - (n.opening || 0);
  });
  const forecourtSales =
    (grossByProduct.PMS - (manager?.pumptest_returned_pms || 0) - (manager?.genuse_pms || 0)) * (prices?.pms_price || 0) +
    (grossByProduct.AGO - (manager?.pumptest_returned_ago || 0) - (manager?.genuse_ago || 0)) * (prices?.ago_price || 0) +
    (grossByProduct.VP - (manager?.pumptest_returned_vp || 0) - (manager?.genuse_vp || 0)) * (prices?.vp_price || 0);
  const nonFuelSales = (manager?.shop_sales || 0) + (manager?.lpg_sales || 0) + (manager?.lubes_sales || 0);
  const otherIncomeSum = (otherIncome || []).reduce((s, o) => s + Number(o.amount || 0), 0);
  const creditSum = (credits || []).filter((c) => c.type === "credit").reduce((s, c) => s + Number(c.amount || 0), 0);
  const channels = (cEntry?.pay_shell_card || 0) + (cEntry?.pay_visa || 0) + (cEntry?.pay_airtel || 0) + (cEntry?.pay_momo_mtn || 0) + (cEntry?.pay_absa || 0) + creditSum;
  const recordsExpectedCash = forecourtSales + nonFuelSales + otherIncomeSum - channels;
  const countedCash = safe.reduce((s, c) => s + Number(c.counted_amount || 0), 0);
  const expected = {
    records_expected_cash: recordsExpectedCash,
    records_over_short: countedCash - recordsExpectedCash,
    records_not_banked: countedCash - (cEntry?.bank_centenary || 0),
  };

  const text = buildCashierText({ date: currentDate, safeCounts: safe, cashier: cEntry, recoveries: rec, deposits: dep, pettyCash: pc, expected });
  const hash = await hashText(text);
  try {
    await saveCashierTextHash(currentDate, hash);
    await submitCashierPart(currentDate);
    toast("Cashier part submitted.");
    $(root, "whatsappPreview").innerHTML = `<h3>WhatsApp copy — paste this into the station group</h3><pre style="white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px">${esc(text)}</pre>`;
    loadDate(root);
  } catch (err) {
    toast("Couldn't submit: " + (err.message || ""));
  }
}

export function renderCashier(root) {
  const needsBuild = root.dataset.activePage !== "cashier" || !root.querySelector("#recoveriesTable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "cashier";
  }
}
