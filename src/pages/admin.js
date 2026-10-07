import { PRODUCTS } from "../lib/calc.js";
import { num, has, ugx, lit, dmy, iso } from "../lib/format.js";
import { getState } from "../lib/store.js";
import {
  addPriceSet, removePriceSet,
  addNonFuelMargin, removeNonFuelMargin, saveTolerance, saveFuelCostBasis,
  saveBankingSettings,
  listOpeningStock, setOpeningStock,
  listVivoInvoices, addVivoInvoice, deleteVivoInvoice,
  listCustomers, addCustomer, setCustomerActive,
  listDeliveryShortfalls, listVivoClaims, listShortageRefunds, fileVivoClaim, updateVivoClaim,
} from "../lib/data.js";
import { listProfiles, setUserRole, inviteUser, setUserActive } from "../lib/adminUsers.js";
import { toast } from "../lib/toast.js";

const PRODUCT_LABEL = Object.fromEntries(PRODUCTS.map((p) => [p.k, p.label]));

let openingStock = [];
let vivoInvoices = [];
let customers = [];
let shortfalls = [];
let vivoClaims = [];
let shortageRefunds = [];

function $(root, id) {
  return root.querySelector("#" + id);
}

function priceTableHtml(settings) {
  const list = [...(settings.priceHistory || [])].sort((a, b) => (a.from < b.from ? 1 : -1));
  let h =
    "<thead><tr><th>Effective from</th>" +
    PRODUCTS.map((p) => `<th>${p.label} price</th><th>${p.label} margin</th>`).join("") +
    "<th></th></tr></thead><tbody>";
  if (!list.length) h += '<tr><td colspan="8" class="empty">No prices yet. Add the current pump prices and margins below.</td></tr>';
  list.forEach((p) => {
    h +=
      `<tr style="cursor:default"><td>${dmy(p.from)}</td>` +
      PRODUCTS.map(({ k }) => `<td>${ugx(num(p[k].price))}</td><td>${ugx(num(p[k].margin))}</td>`).join("") +
      `<td><button class="btn danger" data-del="${p.from}" style="padding:4px 10px">Remove</button></td></tr>`;
  });
  return h + "</tbody>";
}

function priceFormHtml() {
  let f = '<label class="f">Effective from<input type="date" id="pf-from"></label>';
  PRODUCTS.forEach(({ k, label }) => {
    f += `<label class="f">${label} price<input type="number" step="any" inputmode="decimal" id="pf-${k}-price"></label><label class="f">${label} margin/L<input type="number" step="any" inputmode="decimal" id="pf-${k}-margin"></label>`;
  });
  return f;
}

function marginTableHtml(settings) {
  const list = [...(settings.nonFuelMarginHistory || [])].sort((a, b) => (a.from < b.from ? 1 : -1));
  let h = "<thead><tr><th>Effective from</th><th>Shop %</th><th>LPG %</th><th>Lubes %</th><th>Reason</th><th></th></tr></thead><tbody>";
  if (!list.length) h += '<tr><td colspan="6" class="empty">No margin history yet. Add the current margins below.</td></tr>';
  list.forEach((m) => {
    h += `<tr style="cursor:default"><td>${dmy(m.from)}</td><td>${m.shop}</td><td>${m.lpg}</td><td>${m.lubes}</td><td>${
      m.reason || ""
    }</td><td><button class="btn danger" data-delmargin="${m.from}" style="padding:4px 10px">Remove</button></td></tr>`;
  });
  return h + "</tbody>";
}

function openingStockTableHtml() {
  let h = "<thead><tr><th>Product</th><th>Opening dip (L)</th><th>Set</th></tr></thead><tbody>";
  PRODUCTS.forEach(({ k, label }) => {
    const row = openingStock.find((o) => o.product === k);
    h += `<tr><td>${label}</td><td>${row ? lit(row.dip) : "—"}</td><td><input type="number" step="any" min="0" inputmode="decimal" id="os-${k}" placeholder="${
      row ? row.dip : ""
    }" style="width:120px"> <button class="btn" data-setos="${k}" style="padding:4px 10px">Set</button></td></tr>`;
  });
  return h + "</tbody>";
}

function vivoInvoicesTableHtml() {
  if (!vivoInvoices.length) return '<tbody><tr><td class="empty">No invoices recorded yet.</td></tr></tbody>';
  let h = "<thead><tr><th>Date</th><th>Invoice no.</th><th>Product</th><th>Litres</th><th>Cost/L</th><th>Total</th><th>Linked delivery</th><th></th></tr></thead><tbody>";
  vivoInvoices.forEach((v) => {
    h += `<tr><td>${dmy(v.invoice_date)}</td><td>${v.invoice_no}</td><td>${PRODUCT_LABEL[v.product] || v.product}</td><td>${lit(
      v.invoiced_litres
    )}</td><td>${ugx(v.cost_per_litre)}</td><td>${ugx(v.total)}</td><td>${
      v.delivery_id || "—"
    }</td><td><button class="btn danger" data-delinv="${v.id}" style="padding:4px 10px">Remove</button></td></tr>`;
  });
  return h + "</tbody>";
}

function customersTableHtml() {
  if (!customers.length) return '<tbody><tr><td class="empty">No customers yet.</td></tr></tbody>';
  let h = "<thead><tr><th>Name</th><th>Phone</th><th>Notes</th><th></th></tr></thead><tbody>";
  customers.forEach((c) => {
    h += `<tr><td>${c.name}${c.is_active ? "" : ' <span class="badge inactive">Inactive</span>'}</td><td>${
      c.phone || "—"
    }</td><td>${c.notes || "—"}</td><td><button class="btn ${c.is_active ? "danger" : ""}" data-togglecust="${c.id}" data-active="${
      c.is_active
    }" style="padding:4px 10px">${c.is_active ? "Deactivate" : "Reactivate"}</button></td></tr>`;
  });
  return h + "</tbody>";
}

function shortfallsTableHtml() {
  const claimed = new Set(vivoClaims.map((c) => c.delivery_id));
  if (!shortfalls.length) return '<tbody><tr><td class="empty">No delivery shortfalls recorded.</td></tr></tbody>';
  let h = "<thead><tr><th>Date</th><th>Product</th><th>Invoice</th><th>Invoiced L</th><th>Shortfall L</th><th>At cost</th><th></th></tr></thead><tbody>";
  shortfalls.forEach((s) => {
    h += `<tr><td>${dmy(s.trading_date)}</td><td>${PRODUCT_LABEL[s.product] || s.product}</td><td>${s.invoice_no || "—"}</td><td>${lit(
      s.invoiced_litres
    )}</td><td class="${s.shortfall_litres < 0 ? "neg" : "pos"}">${lit(s.shortfall_litres)}</td><td>${ugx(
      s.shortfall_at_cost
    )}</td><td>${
      claimed.has(s.delivery_id)
        ? "Claim filed"
        : `<button class="btn" data-fileclaim="${s.delivery_id}" data-product="${s.product}" data-litres="${s.shortfall_litres}" data-value="${s.shortfall_at_cost}" style="padding:4px 10px">File claim</button>`
    }</td></tr>`;
  });
  return h + "</tbody>";
}

function vivoClaimsTableHtml() {
  if (!vivoClaims.length) return '<tbody><tr><td class="empty">No Vivo claims filed yet.</td></tr></tbody>';
  let h = "<thead><tr><th>Delivery</th><th>Product</th><th>Shortfall L</th><th>Value</th><th>Status</th><th>Linked refund</th></tr></thead><tbody>";
  vivoClaims.forEach((c) => {
    h += `<tr><td>#${c.delivery_id}</td><td>${PRODUCT_LABEL[c.product] || c.product}</td><td>${lit(c.shortfall_litres)}</td><td>${
      has(c.shortfall_value) ? ugx(c.shortfall_value) : "—"
    }</td><td><select data-claimstatus="${c.id}"><option value="open" ${c.status === "open" ? "selected" : ""}>open</option><option value="claimed" ${
      c.status === "claimed" ? "selected" : ""
    }>claimed</option><option value="refunded" ${c.status === "refunded" ? "selected" : ""}>refunded</option></select></td><td><select data-claimlink="${
      c.id
    }"><option value="">— none —</option>${shortageRefunds
      .map(
        (r) =>
          `<option value="${r.id}" ${c.other_income_id === r.id ? "selected" : ""}>${dmy(r.trading_date)} · ${ugx(r.amount)}</option>`
      )
      .join("")}</select></td></tr>`;
  });
  return h + "</tbody>";
}

function userRowHtml(u, isSelf) {
  return `
    <div class="userrow" data-user="${u.id}">
      <div>
        <div class="who">${u.full_name}${!u.is_active ? '<span class="badge inactive">Deactivated</span>' : ""}</div>
        <div class="role">${u.id}</div>
      </div>
      <div class="actions">
        <select data-role="${u.id}" ${isSelf ? "disabled" : ""}>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
          <option value="entry" ${u.role === "entry" ? "selected" : ""}>entry</option>
          <option value="viewer" ${u.role === "viewer" ? "selected" : ""}>viewer</option>
        </select>
        <button class="btn ${u.is_active ? "danger" : ""}" data-toggle="${u.id}" data-active="${u.is_active}" ${
    isSelf ? "disabled" : ""
  }>${u.is_active ? "Deactivate" : "Reactivate"}</button>
      </div>
    </div>`;
}

async function loadUsers(root) {
  const host = $(root, "userList");
  if (!host) return;
  try {
    const profiles = await listProfiles();
    const selfId = getState().profile?.id;
    host.innerHTML = profiles.map((u) => userRowHtml(u, u.id === selfId)).join("") || '<div class="empty">No users yet.</div>';
  } catch (err) {
    host.innerHTML = `<div class="notice err">Couldn't load users: ${err.message || ""}</div>`;
  }
}

async function loadPhase1Data(root) {
  try {
    [openingStock, vivoInvoices, customers, shortfalls, vivoClaims, shortageRefunds] = await Promise.all([
      listOpeningStock(), listVivoInvoices(), listCustomers(), listDeliveryShortfalls(), listVivoClaims(), listShortageRefunds(),
    ]);
  } catch (err) {
    toast("Couldn't load some admin data: " + (err.message || ""));
  }
  $(root, "openingStockTable").innerHTML = openingStockTableHtml();
  $(root, "vivoInvoicesTable").innerHTML = vivoInvoicesTableHtml();
  $(root, "customersTable").innerHTML = customersTableHtml();
  $(root, "shortfallsTable").innerHTML = shortfallsTableHtml();
  $(root, "vivoClaimsTable").innerHTML = vivoClaimsTableHtml();
}

function build(root) {
  root.innerHTML = `
    <section class="block">
      <h2>Fuel prices and margins <small>UGX per litre</small></h2>
      <p class="hint" style="margin-top:0">Each price change applies from its effective date onward, so past days keep the prices they were sold at.</p>
      <div class="tscroll" style="margin-bottom:14px"><table id="priceTable"></table></div>
      <h2 style="font-size:17px">Add a price change</h2>
      <div class="admin-grid" id="priceForm">${priceFormHtml()}</div>
      <button class="btn primary" id="addPriceBtn">Add price change</button>
    </section>

    <section class="block">
      <h2>Non-fuel margins <small>% of sales value, dated</small></h2>
      <p class="hint" style="margin-top:0">Each margin change applies from its effective date onward, same as fuel prices.</p>
      <div class="tscroll" style="margin-bottom:14px"><table id="marginTable"></table></div>
      <h2 style="font-size:17px">Add a margin change</h2>
      <div class="admin-grid">
        <label class="f">Effective from<input type="date" id="mf-from"></label>
        <label class="f">Shop %<input type="number" step="any" inputmode="decimal" id="mf-shop"></label>
        <label class="f">LPG %<input type="number" step="any" inputmode="decimal" id="mf-lpg"></label>
        <label class="f">Lubes %<input type="number" step="any" inputmode="decimal" id="mf-lubes"></label>
        <label class="f">Reason<input type="text" id="mf-reason"></label>
      </div>
      <button class="btn primary" id="addMarginBtn">Add margin change</button>
    </section>

    <section class="block">
      <h2>Stock &amp; cost settings</h2>
      <div class="admin-grid">
        <label class="f">Stock loss tolerance %<input type="number" step="any" inputmode="decimal" id="mTol"></label>
        <label class="f">Fuel cost basis
          <select id="costBasis">
            <option value="FIXED">Fixed (price − margin)</option>
            <option value="LATEST_INVOICE">Latest Vivo invoice</option>
            <option value="WEIGHTED_AVG">Weighted average</option>
          </select>
        </label>
      </div>
      <button class="btn primary" id="saveToleranceBtn">Save tolerance</button>
      <button class="btn primary" id="saveCostBasisBtn">Save cost basis</button>
      <p class="hint">Tolerance flags any day, and any run of days without a delivery, where the dip differs from book stock by more than this share of litres sold. Cost basis other than Fixed needs Vivo invoice data below to produce real numbers — it falls back to Fixed pricing for any product/day with none.</p>
    </section>

    <section class="block">
      <h2>Opening stock <small>one-time baseline, litres</small></h2>
      <p class="hint" style="margin-top:0">The closing dip the stock chain starts from, before any daily entry exists. Only needed once per product.</p>
      <div class="tscroll"><table id="openingStockTable"></table></div>
    </section>

    <section class="block">
      <h2>Vivo invoices <small>director-only cost data</small></h2>
      <p class="hint" style="margin-top:0">Station roles never see this — it only drives the Latest invoice / Weighted average cost basis above.</p>
      <div class="tscroll" style="margin-bottom:14px"><table id="vivoInvoicesTable"></table></div>
      <div class="admin-grid">
        <label class="f">Invoice no.<input type="text" id="vi-no"></label>
        <label class="f">Invoice date<input type="date" id="vi-date"></label>
        <label class="f">Product
          <select id="vi-product">${PRODUCTS.map((p) => `<option value="${p.k}">${p.label}</option>`).join("")}</select>
        </label>
        <label class="f">Invoiced litres<input type="number" step="any" inputmode="decimal" id="vi-litres"></label>
        <label class="f">Cost per litre<input type="number" step="any" inputmode="decimal" id="vi-cost"></label>
        <label class="f">Total<input type="number" step="any" inputmode="decimal" id="vi-total"></label>
      </div>
      <button class="btn primary" id="addInvoiceBtn">Add invoice</button>
    </section>

    <section class="block">
      <h2>Vivo wet-stock claims</h2>
      <p class="hint" style="margin-top:0">Deliveries whose dip-based shortfall doesn't match the invoice.</p>
      <div class="tscroll" style="margin-bottom:14px"><table id="shortfallsTable"></table></div>
      <h2 style="font-size:17px">Filed claims</h2>
      <div class="tscroll" id="vivoClaimsWrap"><table id="vivoClaimsTable"></table></div>
    </section>

    <section class="block">
      <h2>Customers <small>for credit sales &amp; prepaid draws</small></h2>
      <div class="tscroll" style="margin-bottom:14px"><table id="customersTable"></table></div>
      <div class="admin-grid">
        <label class="f">Name<input type="text" id="cust-name"></label>
        <label class="f">Phone<input type="text" id="cust-phone"></label>
        <label class="f">Notes<input type="text" id="cust-notes"></label>
      </div>
      <button class="btn primary" id="addCustomerBtn">Add customer</button>
    </section>

    <section class="block">
      <h2>Banking</h2>
      <div class="admin-grid">
        <label class="f">Banking account name<input type="text" id="bAcctName"></label>
        <label class="f">Single-account banking from<input type="date" id="bFrom"></label>
      </div>
      <button class="btn primary" id="saveBankingBtn">Save banking settings</button>
      <p class="hint">The per-day "banked together" flag on each entry now decides whether a day's cash checks apply — this date only sets the default for new entries.</p>
    </section>

    <section class="block">
      <h2>Users</h2>
      <div id="userList"></div>
      <h2 style="font-size:17px;margin-top:18px">Invite a user</h2>
      <div class="admin-grid">
        <label class="f">Full name<input type="text" id="inv-name"></label>
        <label class="f">Email<input type="email" id="inv-email"></label>
        <label class="f">Role
          <select id="inv-role">
            <option value="entry" selected>entry</option>
            <option value="admin">admin</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
      </div>
      <button class="btn primary" id="inviteBtn">Send invite</button>
      <p class="hint">The invite is emailed by Supabase Auth. The new user sets their own password from that link.</p>
    </section>
  `;

  $(root, "pf-from").value = iso(new Date());
  $(root, "mf-from").value = iso(new Date());
  $(root, "vi-date").value = iso(new Date());

  $(root, "addPriceBtn").addEventListener("click", () => onAddPrice(root));
  $(root, "priceTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onRemovePrice(b.dataset.del);
  });

  $(root, "addMarginBtn").addEventListener("click", () => onAddMargin(root));
  $(root, "marginTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-delmargin]");
    if (b) onRemoveMargin(b.dataset.delmargin);
  });

  $(root, "saveToleranceBtn").addEventListener("click", () => onSaveTolerance(root));
  $(root, "saveCostBasisBtn").addEventListener("click", () => onSaveCostBasis(root));
  $(root, "saveBankingBtn").addEventListener("click", () => onSaveBanking(root));

  $(root, "openingStockTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-setos]");
    if (b) onSetOpeningStock(root, b.dataset.setos);
  });

  $(root, "addInvoiceBtn").addEventListener("click", () => onAddInvoice(root));
  $(root, "vivoInvoicesTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-delinv]");
    if (b) onDeleteInvoice(root, Number(b.dataset.delinv));
  });
  ["vi-litres", "vi-cost"].forEach((id) =>
    $(root, id).addEventListener("input", () => {
      const l = num($(root, "vi-litres").value), c = num($(root, "vi-cost").value);
      if (l && c) $(root, "vi-total").value = l * c;
    })
  );

  $(root, "shortfallsTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fileclaim]");
    if (b) onFileClaim(root, b.dataset);
  });
  $(root, "vivoClaimsTable").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-claimstatus]");
    if (sel) onUpdateClaim(root, sel.dataset.claimstatus, { status: sel.value });
    const link = e.target.closest("[data-claimlink]");
    if (link) onUpdateClaim(root, link.dataset.claimlink, { other_income_id: link.value ? Number(link.value) : null });
  });

  $(root, "addCustomerBtn").addEventListener("click", () => onAddCustomer(root));
  $(root, "customersTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-togglecust]");
    if (b) onToggleCustomer(root, b.dataset.togglecust, b.dataset.active === "true");
  });

  $(root, "inviteBtn").addEventListener("click", () => onInvite(root));
  $(root, "userList").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-role]");
    if (sel) onSetRole(sel.dataset.role, sel.value);
  });
  $(root, "userList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-toggle]");
    if (b) onToggleActive(b.dataset.toggle, b.dataset.active === "true");
  });

  loadUsers(root);
  loadPhase1Data(root);
  // build() never populated priceTable/marginTable/etc. itself — until now
  // it relied on refresh() running later, triggered by whatever Supabase
  // Realtime event happened to fire next. That's usually fast enough to be
  // invisible, but "the price table is blank until something unrelated
  // changes" is exactly the kind of bug that stays hidden until the one
  // time it doesn't (Realtime briefly down, a slow network) and a director
  // can't see current prices. Populate it immediately instead.
  refresh(root);
}

function refresh(root) {
  const { settings } = getState();
  $(root, "priceTable").innerHTML = priceTableHtml(settings);
  $(root, "marginTable").innerHTML = marginTableHtml(settings);

  const active = document.activeElement;
  const editingTol = root.contains(active) && active.id === "mTol";
  if (!editingTol) $(root, "mTol").value = num(settings.tolerance);
  if (!(root.contains(active) && active.id === "costBasis")) $(root, "costBasis").value = settings.fuelCostBasis || "FIXED";

  const editingBanking = root.contains(active) && ["bAcctName", "bFrom"].includes(active.id);
  if (!editingBanking) {
    $(root, "bAcctName").value = settings.bankingAccountName || "Centenary";
    $(root, "bFrom").value = settings.singleAccountBankingFrom || "2026-09-29";
  }

  const list = [...(settings.priceHistory || [])].sort((a, b) => (a.from < b.from ? 1 : -1));
  const cur = list[0];
  if (cur) {
    PRODUCTS.forEach(({ k }) => {
      const priceEl = $(root, "pf-" + k + "-price");
      const marginEl = $(root, "pf-" + k + "-margin");
      if (priceEl && !priceEl.value && document.activeElement !== priceEl) priceEl.value = num(cur[k].price);
      if (marginEl && !marginEl.value && document.activeElement !== marginEl) marginEl.value = num(cur[k].margin);
    });
  }
}

async function onAddPrice(root) {
  const from = $(root, "pf-from").value;
  if (!from) {
    toast("Pick the effective date.");
    return;
  }
  const p = { from };
  for (const { k, label } of PRODUCTS) {
    const pr = $(root, "pf-" + k + "-price").value;
    const m = $(root, "pf-" + k + "-margin").value;
    if (pr === "" || m === "") {
      toast("Enter price and margin for " + label + ".");
      return;
    }
    p[k] = { price: num(pr), margin: num(m) };
  }
  try {
    await addPriceSet(p);
    toast("Prices from " + dmy(from) + " saved.");
  } catch (err) {
    toast(err.message?.includes("permission") || err.code === "42501" ? "Only station admins can change prices." : "Couldn't save: " + (err.message || ""));
  }
}

async function onRemovePrice(from) {
  if (!confirm("Remove the price set effective " + dmy(from) + "? Days in that period will use the earlier prices.")) return;
  try {
    await removePriceSet(from);
    toast("Price set removed.");
  } catch (err) {
    toast("Couldn't remove: " + (err.message || ""));
  }
}

async function onAddMargin(root) {
  const from = $(root, "mf-from").value;
  const shop = $(root, "mf-shop").value, lpg = $(root, "mf-lpg").value, lubes = $(root, "mf-lubes").value;
  if (!from || shop === "" || lpg === "" || lubes === "") {
    toast("Enter the effective date and all three margins.");
    return;
  }
  try {
    await addNonFuelMargin({ from, shop: num(shop), lpg: num(lpg), lubes: num(lubes), reason: $(root, "mf-reason").value.trim() });
    toast("Margins from " + dmy(from) + " saved.");
    ["mf-shop", "mf-lpg", "mf-lubes", "mf-reason"].forEach((id) => ($(root, id).value = ""));
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onRemoveMargin(from) {
  if (!confirm("Remove the margin set effective " + dmy(from) + "?")) return;
  try {
    await removeNonFuelMargin(from);
    toast("Margin set removed.");
  } catch (err) {
    toast("Couldn't remove: " + (err.message || ""));
  }
}

async function onSaveTolerance(root) {
  try {
    await saveTolerance(num($(root, "mTol").value));
    toast("Tolerance saved.");
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onSaveCostBasis(root) {
  try {
    await saveFuelCostBasis($(root, "costBasis").value);
    toast("Fuel cost basis saved.");
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onSaveBanking(root) {
  const name = $(root, "bAcctName").value.trim();
  const from = $(root, "bFrom").value;
  if (!name) {
    toast("Enter the banking account name.");
    return;
  }
  if (!from) {
    toast("Pick the single-account banking from date.");
    return;
  }
  try {
    await saveBankingSettings({ bankingAccountName: name, singleAccountBankingFrom: from });
    toast("Banking settings saved.");
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onSetOpeningStock(root, product) {
  const el = $(root, "os-" + product);
  const dip = el.value;
  if (dip === "") {
    toast("Enter the opening dip.");
    return;
  }
  try {
    await setOpeningStock(product, num(dip));
    toast("Opening stock for " + product + " saved.");
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't save: " + (err.message || ""));
  }
}

async function onAddInvoice(root) {
  const invoiceNo = $(root, "vi-no").value.trim();
  const litres = $(root, "vi-litres").value, cost = $(root, "vi-cost").value;
  if (!invoiceNo || litres === "" || cost === "") {
    toast("Enter invoice no., litres and cost per litre.");
    return;
  }
  const row = {
    invoice_no: invoiceNo,
    invoice_date: $(root, "vi-date").value,
    product: $(root, "vi-product").value,
    invoiced_litres: num(litres),
    cost_per_litre: num(cost),
    total: num($(root, "vi-total").value || num(litres) * num(cost)),
  };
  try {
    await addVivoInvoice(row);
    toast("Invoice added.");
    ["vi-no", "vi-litres", "vi-cost", "vi-total"].forEach((id) => ($(root, id).value = ""));
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't add invoice: " + (err.message || ""));
  }
}

async function onDeleteInvoice(root, id) {
  if (!confirm("Remove this invoice?")) return;
  try {
    await deleteVivoInvoice(id);
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't remove invoice: " + (err.message || ""));
  }
}

async function onFileClaim(root, { fileclaim, product, litres, value }) {
  try {
    await fileVivoClaim({
      delivery_id: Number(fileclaim),
      product,
      shortfall_litres: num(litres),
      shortfall_value: num(value),
    });
    toast("Claim filed.");
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't file claim: " + (err.message || ""));
  }
}

async function onUpdateClaim(root, id, patch) {
  try {
    await updateVivoClaim(Number(id), patch);
    toast("Claim updated.");
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't update claim: " + (err.message || ""));
  }
}

async function onAddCustomer(root) {
  const name = $(root, "cust-name").value.trim();
  if (!name) {
    toast("Enter the customer's name.");
    return;
  }
  try {
    await addCustomer({ name, phone: $(root, "cust-phone").value.trim(), notes: $(root, "cust-notes").value.trim() });
    toast("Customer added.");
    ["cust-name", "cust-phone", "cust-notes"].forEach((id) => ($(root, id).value = ""));
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't add customer: " + (err.message || ""));
  }
}

async function onToggleCustomer(root, id, currentlyActive) {
  try {
    await setCustomerActive(Number(id), !currentlyActive);
    await loadPhase1Data(root);
  } catch (err) {
    toast("Couldn't update customer: " + (err.message || ""));
  }
}

async function onInvite(root) {
  const email = $(root, "inv-email").value.trim();
  const name = $(root, "inv-name").value.trim();
  const role = $(root, "inv-role").value;
  if (!email) {
    toast("Enter the email to invite.");
    return;
  }
  const btn = $(root, "inviteBtn");
  btn.disabled = true;
  try {
    await inviteUser(email, name, role);
    toast("Invite sent to " + email + ".");
    $(root, "inv-email").value = "";
    $(root, "inv-name").value = "";
    loadUsers(root);
  } catch (err) {
    toast("Couldn't send invite: " + (err.message || ""));
  } finally {
    btn.disabled = false;
  }
}

async function onSetRole(userId, role) {
  try {
    await setUserRole(userId, role);
    toast("Role updated.");
  } catch (err) {
    toast("Couldn't update role: " + (err.message || ""));
  }
}

async function onToggleActive(userId, currentlyActive) {
  const verb = currentlyActive ? "deactivate" : "reactivate";
  if (!confirm(`Really ${verb} this user?`)) return;
  try {
    await setUserActive(userId, !currentlyActive);
    toast("User " + (currentlyActive ? "deactivated" : "reactivated") + ".");
    const root = document.getElementById("tabContent");
    if (root) loadUsers(root);
  } catch (err) {
    toast("Couldn't update user: " + (err.message || ""));
  }
}

export function renderAdmin(root) {
  const needsBuild = root.dataset.activePage !== "admin" || !root.querySelector("#priceTable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "admin";
    return;
  }
  refresh(root);
}
