// Manager "Daily Operations" — PLAN_PHASE2.md section 6 / spec 5.4,
// sections A-H. Writes only to day_records-anchored draft tables; never
// touches daily_entries or any Phase 1 table directly (section 1).

import { PRODUCTS } from "../lib/calc.js";
import { num, has, ugx, lit, dmy, iso, addDays, esc } from "../lib/format.js";
import { listCustomers } from "../lib/data.js";
import {
  NOZZLES, nozzleProduct,
  fetchDayRecord, startDayRecord, submitManagerPart, saveManagerTextHash,
  listNozzleMeters, saveNozzleMeter,
  fetchManagerDayEntry, saveManagerDayEntry,
  draftDeliveries, draftOtherOwnUse,
  listDraftCreditPrepaidDraws, addDraftCreditPrepaidDraw, deleteDraftCreditPrepaidDraw,
  draftForecourtCashDrops, saveForecourtCashDrop,
  listDraftExpenses, addDraftExpense, deleteDraftExpense,
  fetchManagerPrices,
} from "../lib/records.js";
import { buildManagerText, hashText } from "../lib/whatsapp.js";
import { toast } from "../lib/toast.js";

let currentDate = null;
let dayRecord = null;
let managerEntry = null;
let nozzles = [];
let deliveries = [];
let ownUse = [];
let creditDraws = [];
let cashDrops = [];
let stockPurchases = []; // draft_expense_entries, category 'Shop expenses', paid_from 'takings'
let customers = [];
let prices = null;

function $(root, id) {
  return root.querySelector("#" + id);
}

function isEditable() {
  return dayRecord && dayRecord.status === "OPEN";
}

function build(root) {
  root.innerHTML = `
    <section class="block">
      <div class="daterow">
        <label class="f">Trading date<input type="date" id="date"></label>
        <div class="status" id="mStatus"></div>
      </div>
      <p class="hint" id="mLateHint"></p>
    </section>

    <section class="block" id="priceBlock">
      <h2>Pump prices <small>read-only</small></h2>
      <div id="priceReadout"></div>
    </section>

    <section class="block">
      <h2>A · Nozzle meters <small>litres</small></h2>
      <div class="tscroll"><table id="nozzleTable"></table></div>
    </section>

    <section class="block">
      <h2>B · Tank dips <small>litres, closing dip taken next morning</small></h2>
      <div class="grid3">
        ${PRODUCTS.map((p) => `<label class="f">${p.label}<input type="number" step="any" min="0" inputmode="decimal" id="dip-${p.k}"></label>`).join("")}
      </div>
    </section>

    <section class="block">
      <h2>C · Deliveries today</h2>
      <div class="tscroll" style="margin-bottom:10px"><table id="deliveriesTable"></table></div>
      <div class="admin-grid" id="deliveryForm">
        <label class="f">Product<select id="dv-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select></label>
        <label class="f">Invoiced litres<input type="number" step="any" min="0" inputmode="decimal" id="dv-litres"></label>
        <label class="f">Dip before<input type="number" step="any" min="0" inputmode="decimal" id="dv-dipbefore"></label>
        <label class="f">Dip after<input type="number" step="any" min="0" inputmode="decimal" id="dv-dipafter"></label>
        <label class="f">Sold during offload<input type="number" step="any" min="0" inputmode="decimal" id="dv-soldduring"></label>
        <label class="f">Truck reg<input type="text" id="dv-truck"></label>
      </div>
      <button class="btn primary" id="addDeliveryBtn">Add delivery</button>
    </section>

    <section class="block">
      <h2>D · Own-use / pump test <small>litres</small></h2>
      <div class="grid3">
        <label class="f">Generator — PMS<input type="number" step="any" min="0" inputmode="decimal" id="genuse-PMS"></label>
        <label class="f">Generator — AGO<input type="number" step="any" min="0" inputmode="decimal" id="genuse-AGO"></label>
        <label class="f">Generator — VP<input type="number" step="any" min="0" inputmode="decimal" id="genuse-VP"></label>
        <label class="f">Pump test returned — PMS<input type="number" step="any" min="0" inputmode="decimal" id="pumptest-PMS"></label>
        <label class="f">Pump test returned — AGO<input type="number" step="any" min="0" inputmode="decimal" id="pumptest-AGO"></label>
        <label class="f">Pump test returned — VP<input type="number" step="any" min="0" inputmode="decimal" id="pumptest-VP"></label>
      </div>
      <p class="hint">Own-use is excluded from sales but still moves stock. Pump test is poured back — no effect either way.</p>
      <div class="tscroll" style="margin:10px 0"><table id="ownUseTable"></table></div>
      <div class="admin-grid" id="ownUseForm">
        <label class="f">Product<select id="ou-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select></label>
        <label class="f">Litres<input type="number" step="any" min="0" inputmode="decimal" id="ou-litres"></label>
        <label class="f">Reason<input type="text" id="ou-reason"></label>
      </div>
      <button class="btn primary" id="addOwnUseBtn">Add other own-use</button>
    </section>

    <section class="block">
      <h2>E · Non-fuel sales <small>UGX</small></h2>
      <div class="grid3">
        <label class="f">Shop<input type="number" step="any" min="0" inputmode="decimal" id="shop"></label>
        <label class="f">LPG<input type="number" step="any" min="0" inputmode="decimal" id="lpg"></label>
        <label class="f">Lubes<input type="number" step="any" min="0" inputmode="decimal" id="lubes"></label>
      </div>
      <h3 style="margin:14px 0 6px">Stock purchases from takings</h3>
      <div class="tscroll" style="margin-bottom:10px"><table id="stockPurchaseTable"></table></div>
      <div class="admin-grid" id="stockPurchaseForm">
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="sp-amount"></label>
        <label class="f">Description<input type="text" id="sp-desc"></label>
      </div>
      <button class="btn primary" id="addStockPurchaseBtn">Add stock purchase</button>
      <p class="hint">Shop stock bought with cash from today's takings — the cashier confirms these when they submit.</p>
    </section>

    <section class="block">
      <h2>F · Credit / prepaid draws</h2>
      <div class="tscroll" style="margin-bottom:10px"><table id="creditTable"></table></div>
      <div class="admin-grid" id="creditForm">
        <label class="f">Type<select id="cr-type"><option value="credit">Credit sale</option><option value="prepaid_draw">Prepaid draw</option></select></label>
        <label class="f">Customer<select id="cr-customer"></select></label>
        <label class="f">Product<select id="cr-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select></label>
        <label class="f">Litres<input type="number" step="any" min="0" inputmode="decimal" id="cr-litres"></label>
        <label class="f">Amount<input type="number" step="any" min="0" inputmode="decimal" id="cr-amount"></label>
        <label class="f">Vehicle reg<input type="text" id="cr-vehicle"></label>
      </div>
      <button class="btn primary" id="addCreditBtn">Add draw</button>
      <p class="hint">Customers are maintained by a director in Admin — an unlisted customer can't be selected here.</p>
    </section>

    <section class="block">
      <h2>G · Forecourt cash drops <small>UGX, per shift</small></h2>
      <div class="grid3">
        <label class="f">Day shift<input type="number" step="any" min="0" inputmode="decimal" id="drop-day"></label>
        <label class="f">Night shift<input type="number" step="any" min="0" inputmode="decimal" id="drop-night"></label>
      </div>
      <button class="btn primary" id="saveDropsBtn">Save cash drops</button>
      <div id="dropsReadout" style="margin-top:8px"></div>
    </section>

    <section class="block">
      <h2>H · Remarks</h2>
      <label class="f"><textarea id="remarks" rows="3"></textarea></label>
    </section>

    <div class="actions">
      <button class="btn primary" id="saveBtn">Save draft</button>
      <button class="btn primary" id="submitBtn">Submit manager part</button>
    </div>
    <div id="whatsappPreview" style="margin-top:14px"></div>
  `;

  $(root, "date").value = addDays(iso(new Date()), -1);
  root.addEventListener("input", (e) => {
    if (root.dataset.activePage === "manager" && e.target.id !== "date") {
      // live fields only — nothing computed here (no client arithmetic to preview; the manager form has no GP figure to show)
    }
  });
  $(root, "date").addEventListener("change", () => loadDate(root));
  $(root, "saveBtn").addEventListener("click", () => onSaveDraft(root));
  $(root, "submitBtn").addEventListener("click", () => onSubmit(root));
  $(root, "addDeliveryBtn").addEventListener("click", () => onAddDelivery(root));
  $(root, "deliveriesTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteDelivery(root, Number(b.dataset.del));
  });
  $(root, "addOwnUseBtn").addEventListener("click", () => onAddOwnUse(root));
  $(root, "ownUseTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteOwnUse(root, Number(b.dataset.del));
  });
  $(root, "addStockPurchaseBtn").addEventListener("click", () => onAddStockPurchase(root));
  $(root, "stockPurchaseTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteStockPurchase(root, Number(b.dataset.del));
  });
  $(root, "addCreditBtn").addEventListener("click", () => onAddCredit(root));
  $(root, "creditTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onDeleteCredit(root, Number(b.dataset.del));
  });
  $(root, "saveDropsBtn").addEventListener("click", () => onSaveDrops(root));

  loadCustomers(root);
  loadDate(root);
}

async function loadCustomers(root) {
  try {
    customers = await listCustomers();
  } catch {
    customers = [];
  }
  const sel = $(root, "cr-customer");
  if (sel) sel.innerHTML = customers.filter((c) => c.is_active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
}

function nozzleTableHtml() {
  let h = "<thead><tr><th>Nozzle</th><th>Opening</th><th>Closing</th></tr></thead><tbody>";
  NOZZLES.forEach((id) => {
    const row = nozzles.find((n) => n.nozzle_id === id) || {};
    h += `<tr><td>${id}</td><td><input type="number" step="any" min="0" inputmode="decimal" id="noz-open-${id}" value="${has(row.opening) ? row.opening : ""}"></td><td><input type="number" step="any" min="0" inputmode="decimal" id="noz-close-${id}" value="${has(row.closing) ? row.closing : ""}"></td></tr>`;
  });
  return h + "</tbody>";
}

function deliveriesTableHtml() {
  if (!deliveries.length) return '<tbody><tr><td class="empty">No deliveries recorded for this date.</td></tr></tbody>';
  let h = "<thead><tr><th>Product</th><th>Invoiced L</th><th>Dip before</th><th>Dip after</th><th>Truck</th><th></th></tr></thead><tbody>";
  deliveries.forEach((d) => {
    h += `<tr><td>${d.product}</td><td>${lit(d.invoiced_litres)}</td><td>${has(d.dip_before) ? lit(d.dip_before) : "—"}</td><td>${has(d.dip_after) ? lit(d.dip_after) : "—"}</td><td>${d.truck_reg || "—"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${d.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function ownUseTableHtml() {
  if (!ownUse.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Product</th><th>Litres</th><th>Reason</th><th></th></tr></thead><tbody>";
  ownUse.forEach((o) => {
    h += `<tr><td>${o.product}</td><td>${lit(o.litres)}</td><td>${esc(o.reason)}</td><td>${isEditable() ? `<button class="btn danger" data-del="${o.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function stockPurchaseTableHtml() {
  if (!stockPurchases.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Amount</th><th>Description</th><th>Cashier confirmed</th><th></th></tr></thead><tbody>";
  stockPurchases.forEach((s) => {
    h += `<tr><td>${ugx(s.amount)}</td><td>${s.description || "—"}</td><td>${s.confirmed_at ? "Yes" : "Not yet"}</td><td>${isEditable() ? `<button class="btn danger" data-del="${s.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function creditTableHtml() {
  if (!creditDraws.length) return '<tbody><tr><td class="empty">None.</td></tr></tbody>';
  let h = "<thead><tr><th>Type</th><th>Customer</th><th>Amount</th><th></th></tr></thead><tbody>";
  creditDraws.forEach((c) => {
    h += `<tr><td>${c.type === "credit" ? "Credit sale" : "Prepaid draw"}</td><td>${c.customers?.name || "—"}</td><td>${ugx(c.amount)}</td><td>${isEditable() ? `<button class="btn danger" data-del="${c.id}" style="padding:3px 8px">Remove</button>` : ""}</td></tr>`;
  });
  return h + "</tbody>";
}

function dropsReadoutHtml() {
  if (!cashDrops.length) return "";
  return cashDrops.map((c) => `<span class="badge">${c.shift}: UGX ${ugx(c.amount)}</span>`).join(" ");
}

function applyEditableState(root) {
  const editable = isEditable();
  root.querySelectorAll("input, textarea, select, button").forEach((el) => {
    if (el.id === "date") return;
    el.disabled = !editable;
  });
  const submitBtn = $(root, "submitBtn");
  if (submitBtn) submitBtn.disabled = !editable || !dayRecord;
  const saveBtn = $(root, "saveBtn");
  if (saveBtn) saveBtn.disabled = !editable;
}

async function loadDate(root) {
  const date = $(root, "date").value;
  currentDate = date;
  dayRecord = await fetchDayRecord(date).catch(() => null);
  if (!dayRecord) {
    try {
      await startDayRecord(date);
      dayRecord = await fetchDayRecord(date);
    } catch (err) {
      toast("Couldn't start a draft for this date: " + (err.message || ""));
    }
  }

  const [m, n, dv, ou, cr, drops, sp, prc] = await Promise.all([
    fetchManagerDayEntry(date).catch(() => null),
    listNozzleMeters(date).catch(() => []),
    draftDeliveries.list(date).catch(() => []),
    draftOtherOwnUse.list(date).catch(() => []),
    listDraftCreditPrepaidDraws(date).catch(() => []),
    draftForecourtCashDrops.list(date).catch(() => []),
    listDraftExpenses(date).catch(() => []),
    fetchManagerPrices().catch(() => null),
  ]);
  managerEntry = m;
  nozzles = n;
  deliveries = dv;
  ownUse = ou;
  creditDraws = cr;
  cashDrops = drops;
  stockPurchases = sp.filter((x) => x.category === "Shop expenses" && x.paid_from === "takings");
  prices = prc;

  fillForm(root);
  renderTables(root);
  renderStatus(root);
  applyEditableState(root);
}

function fillForm(root) {
  PRODUCTS.forEach((p) => {
    $(root, "dip-" + p.k).value = managerEntry && has(managerEntry["dip_" + p.k.toLowerCase()]) ? managerEntry["dip_" + p.k.toLowerCase()] : "";
    $(root, "genuse-" + p.k).value = managerEntry && has(managerEntry["genuse_" + p.k.toLowerCase()]) ? managerEntry["genuse_" + p.k.toLowerCase()] : "";
    $(root, "pumptest-" + p.k).value = managerEntry && has(managerEntry["pumptest_returned_" + p.k.toLowerCase()]) ? managerEntry["pumptest_returned_" + p.k.toLowerCase()] : "";
  });
  $(root, "shop").value = managerEntry && has(managerEntry.shop_sales) ? managerEntry.shop_sales : "";
  $(root, "lpg").value = managerEntry && has(managerEntry.lpg_sales) ? managerEntry.lpg_sales : "";
  $(root, "lubes").value = managerEntry && has(managerEntry.lubes_sales) ? managerEntry.lubes_sales : "";
  $(root, "remarks").value = (managerEntry && managerEntry.remarks) || "";
  const dayDrop = cashDrops.find((c) => c.shift === "day");
  const nightDrop = cashDrops.find((c) => c.shift === "night");
  $(root, "drop-day").value = dayDrop ? dayDrop.amount : "";
  $(root, "drop-night").value = nightDrop ? nightDrop.amount : "";
  $(root, "priceReadout").innerHTML = prices
    ? `<div class="kv"><span>PMS</span><b class="num">${ugx(prices.pms_price)}</b></div><div class="kv"><span>AGO</span><b class="num">${ugx(prices.ago_price)}</b></div><div class="kv"><span>V-Power</span><b class="num">${ugx(prices.vp_price)}</b></div>`
    : '<div class="hint">No prices set yet.</div>';
}

function renderTables(root) {
  $(root, "nozzleTable").innerHTML = nozzleTableHtml();
  $(root, "deliveriesTable").innerHTML = deliveriesTableHtml();
  $(root, "ownUseTable").innerHTML = ownUseTableHtml();
  $(root, "stockPurchaseTable").innerHTML = stockPurchaseTableHtml();
  $(root, "creditTable").innerHTML = creditTableHtml();
  $(root, "dropsReadout").innerHTML = dropsReadoutHtml();
}

function renderStatus(root) {
  const s = dayRecord?.status || "OPEN";
  const labels = { OPEN: "Open — editable", MANAGER_SUBMITTED: "Submitted — awaiting cashier", CASHIER_SUBMITTED: "Submitted — awaiting approval", APPROVED: "Approved" };
  $(root, "mStatus").textContent = labels[s] || s;
  $(root, "mLateHint").textContent = dayRecord?.returned_reason
    ? `Returned for correction: ${dayRecord.returned_reason}`
    : "";
}

async function onSaveDraft(root) {
  if (!isEditable()) return;
  const patch = {};
  PRODUCTS.forEach((p) => {
    const k = p.k.toLowerCase();
    patch["dip_" + k] = numOrNull($(root, "dip-" + p.k).value);
    patch["genuse_" + k] = numOrNull($(root, "genuse-" + p.k).value);
    patch["pumptest_returned_" + k] = numOrNull($(root, "pumptest-" + p.k).value);
  });
  patch.shop_sales = numOrNull($(root, "shop").value);
  patch.lpg_sales = numOrNull($(root, "lpg").value);
  patch.lubes_sales = numOrNull($(root, "lubes").value);
  patch.remarks = $(root, "remarks").value.trim() || null;

  try {
    await saveManagerDayEntry(currentDate, patch);
    await Promise.all(
      NOZZLES.map((id) => {
        const open = $(root, "noz-open-" + id).value;
        const close = $(root, "noz-close-" + id).value;
        return saveNozzleMeter(currentDate, id, { opening: numOrNull(open), closing: numOrNull(close) });
      })
    );
    toast("Draft saved.");
    loadDate(root);
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

function numOrNull(v) {
  return v === "" || v === undefined || v === null ? null : num(v);
}

async function onSubmit(root) {
  await onSaveDraft(root);
  const [n, m, dv, ou, cr, drops] = await Promise.all([
    listNozzleMeters(currentDate),
    fetchManagerDayEntry(currentDate),
    draftDeliveries.list(currentDate),
    draftOtherOwnUse.list(currentDate),
    listDraftCreditPrepaidDraws(currentDate),
    draftForecourtCashDrops.list(currentDate),
  ]);
  const text = buildManagerText({ date: currentDate, nozzles: n, manager: m, deliveries: dv, ownUse: ou, creditDraws: cr, cashDrops: drops });
  const hash = await hashText(text);
  try {
    await saveManagerTextHash(currentDate, hash);
    await submitManagerPart(currentDate);
    toast("Manager part submitted.");
    $(root, "whatsappPreview").innerHTML = `<h3>WhatsApp copy — paste this into the station group</h3><pre style="white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px">${esc(text)}</pre>`;
    loadDate(root);
  } catch (err) {
    toast("Couldn't submit: " + (err.message || ""));
  }
}

async function onAddDelivery(root) {
  const litres = $(root, "dv-litres").value;
  if (litres === "" || num(litres) <= 0) {
    toast("Enter the invoiced litres.");
    return;
  }
  try {
    await draftDeliveries.add({
      trading_date: currentDate,
      product: $(root, "dv-product").value,
      invoiced_litres: num(litres),
      dip_before: numOrNull($(root, "dv-dipbefore").value),
      dip_after: numOrNull($(root, "dv-dipafter").value),
      litres_sold_during_offload: num($(root, "dv-soldduring").value || 0),
      truck_reg: $(root, "dv-truck").value.trim() || null,
    });
    ["dv-litres", "dv-dipbefore", "dv-dipafter", "dv-soldduring", "dv-truck"].forEach((id) => ($(root, id).value = ""));
    deliveries = await draftDeliveries.list(currentDate);
    $(root, "deliveriesTable").innerHTML = deliveriesTableHtml();
    toast("Delivery added.");
  } catch (err) {
    toast("Couldn't add delivery: " + (err.message || ""));
  }
}

async function onDeleteDelivery(root, id) {
  if (!confirm("Remove this delivery?")) return;
  await draftDeliveries.remove(id);
  deliveries = await draftDeliveries.list(currentDate);
  $(root, "deliveriesTable").innerHTML = deliveriesTableHtml();
}

async function onAddOwnUse(root) {
  const litres = $(root, "ou-litres").value;
  const reason = $(root, "ou-reason").value.trim();
  if (litres === "" || num(litres) <= 0 || !reason) {
    toast("Enter the litres and reason.");
    return;
  }
  try {
    await draftOtherOwnUse.add({ trading_date: currentDate, product: $(root, "ou-product").value, litres: num(litres), reason });
    $(root, "ou-litres").value = "";
    $(root, "ou-reason").value = "";
    ownUse = await draftOtherOwnUse.list(currentDate);
    $(root, "ownUseTable").innerHTML = ownUseTableHtml();
    toast("Own-use added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteOwnUse(root, id) {
  if (!confirm("Remove this entry?")) return;
  await draftOtherOwnUse.remove(id);
  ownUse = await draftOtherOwnUse.list(currentDate);
  $(root, "ownUseTable").innerHTML = ownUseTableHtml();
}

async function onAddStockPurchase(root) {
  const amount = $(root, "sp-amount").value;
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    await addDraftExpense({
      trading_date: currentDate,
      category: "Shop expenses",
      paid_from: "takings",
      amount: num(amount),
      description: $(root, "sp-desc").value.trim() || null,
    });
    $(root, "sp-amount").value = "";
    $(root, "sp-desc").value = "";
    const all = await listDraftExpenses(currentDate);
    stockPurchases = all.filter((x) => x.category === "Shop expenses" && x.paid_from === "takings");
    $(root, "stockPurchaseTable").innerHTML = stockPurchaseTableHtml();
    toast("Stock purchase added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteStockPurchase(root, id) {
  if (!confirm("Remove this entry?")) return;
  await deleteDraftExpense(id);
  const all = await listDraftExpenses(currentDate);
  stockPurchases = all.filter((x) => x.category === "Shop expenses" && x.paid_from === "takings");
  $(root, "stockPurchaseTable").innerHTML = stockPurchaseTableHtml();
}

async function onAddCredit(root) {
  const customerId = $(root, "cr-customer").value;
  const amount = $(root, "cr-amount").value;
  if (!customerId) {
    toast("Pick a customer. Add one in Admin if the list is empty.");
    return;
  }
  if (amount === "" || num(amount) <= 0) {
    toast("Enter the amount.");
    return;
  }
  try {
    await addDraftCreditPrepaidDraw({
      trading_date: currentDate,
      customer_id: Number(customerId),
      type: $(root, "cr-type").value,
      product: $(root, "cr-product").value,
      litres: numOrNull($(root, "cr-litres").value),
      amount: num(amount),
      vehicle_reg: $(root, "cr-vehicle").value.trim() || null,
    });
    ["cr-litres", "cr-amount", "cr-vehicle"].forEach((id) => ($(root, id).value = ""));
    creditDraws = await listDraftCreditPrepaidDraws(currentDate);
    $(root, "creditTable").innerHTML = creditTableHtml();
    toast("Draw added.");
  } catch (err) {
    toast("Couldn't add: " + (err.message || ""));
  }
}

async function onDeleteCredit(root, id) {
  if (!confirm("Remove this draw?")) return;
  await deleteDraftCreditPrepaidDraw(id);
  creditDraws = await listDraftCreditPrepaidDraws(currentDate);
  $(root, "creditTable").innerHTML = creditTableHtml();
}

async function onSaveDrops(root) {
  const day = $(root, "drop-day").value;
  const night = $(root, "drop-night").value;
  try {
    if (day !== "") await saveForecourtCashDrop({ trading_date: currentDate, shift: "day", amount: num(day) });
    if (night !== "") await saveForecourtCashDrop({ trading_date: currentDate, shift: "night", amount: num(night) });
    cashDrops = await draftForecourtCashDrops.list(currentDate);
    $(root, "dropsReadout").innerHTML = dropsReadoutHtml();
    toast("Cash drops saved.");
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

export function renderManager(root) {
  const needsBuild = root.dataset.activePage !== "manager" || !root.querySelector("#nozzleTable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "manager";
  }
}
