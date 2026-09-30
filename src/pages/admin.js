import { PRODUCTS } from "../lib/calc.js";
import { num, ugx, dmy, iso } from "../lib/format.js";
import { getState } from "../lib/store.js";
import { addPriceSet, removePriceSet, saveMargins, saveBankingSettings } from "../lib/data.js";
import { listProfiles, setUserRole, inviteUser, setUserActive } from "../lib/adminUsers.js";
import { toast } from "../lib/toast.js";

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
      <h2>Non-fuel margins <small>% of sales value</small></h2>
      <div class="admin-grid">
        <label class="f">Shop margin %<input type="number" step="any" inputmode="decimal" id="mShop"></label>
        <label class="f">LPG margin %<input type="number" step="any" inputmode="decimal" id="mLpg"></label>
        <label class="f">Lubes margin %<input type="number" step="any" inputmode="decimal" id="mLubes"></label>
        <label class="f">Stock loss tolerance %<input type="number" step="any" inputmode="decimal" id="mTol"></label>
      </div>
      <button class="btn primary" id="saveMarginsBtn">Save margins</button>
      <p class="hint">Tolerance flags any day, and any run of days without a delivery, where the dip differs from book stock by more than this share of litres sold. Gains are flagged as well as losses.</p>
    </section>
    <section class="block">
      <h2>Banking</h2>
      <div class="admin-grid">
        <label class="f">Banking account name<input type="text" id="bAcctName"></label>
        <label class="f">Single-account banking from<input type="date" id="bFrom"></label>
      </div>
      <button class="btn primary" id="saveBankingBtn">Save banking settings</button>
      <p class="hint">All sales are banked daily to this one account. "Unaccounted sales" and "Cash not banked" are only checked from this date onward — entries before it show "—" for both, since the station banked to two accounts before and the split isn't checkable that way.</p>
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

  $(root, "addPriceBtn").addEventListener("click", () => onAddPrice(root));
  $(root, "priceTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (b) onRemovePrice(b.dataset.del);
  });
  $(root, "saveMarginsBtn").addEventListener("click", () => onSaveMargins(root));
  $(root, "saveBankingBtn").addEventListener("click", () => onSaveBanking(root));

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
}

function refresh(root) {
  const { settings } = getState();
  $(root, "priceTable").innerHTML = priceTableHtml(settings);

  const active = document.activeElement;
  const editingMargins = root.contains(active) && ["mShop", "mLpg", "mLubes", "mTol"].includes(active.id);
  if (!editingMargins) {
    $(root, "mShop").value = num(settings.nonFuel.shop);
    $(root, "mLpg").value = num(settings.nonFuel.lpg);
    $(root, "mLubes").value = num(settings.nonFuel.lubes);
    $(root, "mTol").value = num(settings.tolerance);
  }

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

async function onSaveMargins(root) {
  try {
    await saveMargins({
      shop: num($(root, "mShop").value),
      lpg: num($(root, "mLpg").value),
      lubes: num($(root, "mLubes").value),
      tolerance: num($(root, "mTol").value),
    });
    toast("Margins saved.");
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
