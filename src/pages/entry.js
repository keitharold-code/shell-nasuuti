import { PRODUCTS, NF, compute, stockChain } from "../lib/calc.js";
import { num, has, ugx, lit, sgn, iso, addDays, dmy, daysBetween } from "../lib/format.js";
import { kv } from "../lib/render-helpers.js";
import { getState, isAdmin, canWrite } from "../lib/store.js";
import { saveEntry, deleteEntry } from "../lib/data.js";
import { toast } from "../lib/toast.js";

const flat = [
  "forecourt", "shop", "lpg", "lubes",
  "payCash", "payMomo", "payShell", "payVisa", "payCredit",
  "bankCente", "bankExim", "expenses",
];

let dirty = false;
let loadedDate = null;

function $(root, id) {
  return root.querySelector("#" + id);
}

function buildFuelGridHtml() {
  let h = "<div></div>" + PRODUCTS.map((p) => `<div class="hd">${p.label}</div>`).join("");
  const rows = [
    ["dip", "Closing dip", "taken next morning"],
    ["deliv", "Delivered", "received into tank"],
    ["sold", "Litres sold", "from pump meters"],
  ];
  rows.forEach(([key, lab, sub]) => {
    h +=
      `<div class="rl">${lab}<span>${sub}</span></div>` +
      PRODUCTS.map(
        (p) =>
          `<input type="number" step="any" min="0" inputmode="decimal" id="${key}-${p.k}" aria-label="${lab} ${p.label}">`
      ).join("");
  });
  return h;
}

function readForm(root) {
  const e = { date: $(root, "date").value, dips: {}, deliv: {}, sold: {} };
  PRODUCTS.forEach(({ k }) => {
    ["dip", "deliv", "sold"].forEach((t) => {
      const v = $(root, t + "-" + k).value;
      (t === "dip" ? e.dips : e[t])[k] = v === "" ? null : num(v);
    });
  });
  flat.forEach((f) => {
    const v = $(root, f).value;
    e[f] = v === "" ? null : num(v);
  });
  e.notes = $(root, "notes").value.trim();
  return e;
}

function fillForm(root, e) {
  PRODUCTS.forEach(({ k }) => {
    $(root, "dip-" + k).value = e && e.dips && has(e.dips[k]) ? e.dips[k] : "";
    $(root, "deliv-" + k).value = e && e.deliv && has(e.deliv[k]) ? e.deliv[k] : "";
    $(root, "sold-" + k).value = e && e.sold && has(e.sold[k]) ? e.sold[k] : "";
  });
  flat.forEach((f) => {
    $(root, f).value = e && has(e[f]) ? e[f] : "";
  });
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
        </section>

        <section class="block">
          <h2>Sales value <small>UGX</small></h2>
          <div class="grid4">
            <label class="f">Forecourt sales<input type="number" step="any" min="0" inputmode="decimal" id="forecourt"></label>
            <label class="f">Shop<input type="number" step="any" min="0" inputmode="decimal" id="shop"></label>
            <label class="f">LPG<input type="number" step="any" min="0" inputmode="decimal" id="lpg"></label>
            <label class="f">Lubes<input type="number" step="any" min="0" inputmode="decimal" id="lubes"></label>
          </div>
        </section>

        <section class="block">
          <h2>How sales were paid <small>UGX · optional</small></h2>
          <div class="grid5">
            <label class="f">Cash<input type="number" step="any" min="0" inputmode="decimal" id="payCash"></label>
            <label class="f">Mobile money<input type="number" step="any" min="0" inputmode="decimal" id="payMomo"></label>
            <label class="f">Shell Card<input type="number" step="any" min="0" inputmode="decimal" id="payShell"></label>
            <label class="f">Visa<input type="number" step="any" min="0" inputmode="decimal" id="payVisa"></label>
            <label class="f">Credit (debtors)<input type="number" step="any" min="0" inputmode="decimal" id="payCredit"></label>
          </div>
        </section>

        <section class="block">
          <h2>Banking &amp; expenses <small>UGX · optional</small></h2>
          <div class="grid3">
            <label class="f">Banked — Centenary<input type="number" step="any" min="0" inputmode="decimal" id="bankCente"></label>
            <label class="f">Banked — Exim<input type="number" step="any" min="0" inputmode="decimal" id="bankExim"></label>
            <label class="f">Petty cash / expenses paid<input type="number" step="any" min="0" inputmode="decimal" id="expenses"></label>
          </div>
          <label class="f" style="margin-top:10px">Notes (deliveries, pump faults, incidents)
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
          <div class="lbl">Gross profit for the day</div>
          <div class="gp num"><small>UGX</small><span id="rGP">0</span></div>
          <div class="split">
            <div><span class="lbl">Fuel</span><b class="num" id="rFuelGP">0</b></div>
            <div><span class="lbl">Shop · LPG · Lubes</span><b class="num" id="rNfGP">0</b></div>
          </div>
        </div>
        <div class="checks">
          <h3>Forecourt cash check</h3>
          <div id="rCash"></div>
        </div>
        <div class="checks">
          <h3>Stock reconciliation</h3>
          <div id="rStock"></div>
        </div>
        <div class="checks">
          <h3>Totals</h3>
          <div id="rTotals"></div>
        </div>
      </aside>
    </div>
  `;

  $(root, "date").value = addDays(iso(new Date()), -1);
  loadedDate = null;

  root.addEventListener("input", (e) => {
    if (e.target.id !== "date") {
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

  applyWriteState(root);
  loadDate(root);
}

function applyWriteState(root) {
  const write = canWrite();
  root.querySelectorAll("#fuelGrid input, .grid4 input, .grid5 input, .grid3 input, textarea").forEach((el) => {
    el.disabled = !write;
  });
  $(root, "saveBtn").disabled = !write;
  $(root, "clearBtn").disabled = !write;
}

function loadDate(root) {
  const d = $(root, "date").value;
  const { entries } = getState();
  const e = entries[d];
  fillForm(root, e || null);
  dirty = false;
  loadedDate = d;
  $(root, "entryStatus").textContent = e
    ? "Saved entry" + (e.updatedAt ? " · last saved " + new Date(e.updatedAt).toLocaleString() : "")
    : "New entry";
  $(root, "saveBtn").textContent = e ? "Update entry" : "Save entry";
  $(root, "deleteBtn").classList.toggle("hidden", !(e && isAdmin()));
  renderCalc(root);
}

function renderCalc(root) {
  const e = readForm(root);
  if (!e.date) return;
  const { settings, entries, dates } = getState();
  const r = compute(e, { settings, entries, dates });

  $(root, "rGP").textContent = ugx(r.totalGP);
  $(root, "rFuelGP").textContent = ugx(r.fuelGP);
  $(root, "rNfGP").textContent = ugx(r.nfGP);

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
    c += kv("Expected forecourt sales", ugx(r.fuelExpected));
    c += kv("Declared forecourt sales", has(e.forecourt) ? ugx(r.declared) : "—");
    if (has(e.forecourt)) {
      const v = r.forecourtVar;
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
          ` <span class="hint">(${lit(x.open)} + ${lit(num(e.deliv[k]))} − ${lit(r.fuel[k].sold)} = ${lit(x.book)})</span>`,
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
  if (r.paidEntered)
    t +=
      kv("Payments recorded", ugx(r.paid)) +
      kv("Unaccounted vs sales", sgn(r.paid - r.totalSales, ugx), Math.abs(r.paid - r.totalSales) > 1 ? "neg" : "");
  if (r.bankEntered)
    t +=
      kv("Banked — Centenary", ugx(r.bankCente)) +
      kv("Banked — Exim", ugx(r.bankExim)) +
      kv("Total banked", ugx(r.banked));
  if (has(e.expenses)) t += kv("Expenses", ugx(r.expenses)) + kv("Gross profit after expenses", ugx(r.afterExp));
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
    toast("Entry saved for " + dmy(e.date) + ".");
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
    $(root, "entryStatus").textContent = e
      ? "Saved entry" + (e.updatedAt ? " · last saved " + new Date(e.updatedAt).toLocaleString() : "")
      : "New entry";
    $(root, "saveBtn").textContent = e ? "Update entry" : "Save entry";
    $(root, "deleteBtn").classList.toggle("hidden", !(e && isAdmin()));
  }
  if (!editing) renderCalc(root);
}
