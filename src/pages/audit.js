import { supabase } from "../lib/supabase.js";
import { esc } from "../lib/format.js";
import { listProfiles } from "../lib/adminUsers.js";

function $(root, id) {
  return root.querySelector("#" + id);
}

let profilesById = {};

function fmtVal(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return String(v);
  return esc(String(v));
}

function diffRows(oldData, newData) {
  const keys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
  const rows = [];
  keys.forEach((k) => {
    if (["created_at", "updated_at", "created_by", "updated_by"].includes(k)) return;
    const ov = oldData ? oldData[k] : undefined;
    const nv = newData ? newData[k] : undefined;
    if (JSON.stringify(ov) === JSON.stringify(nv)) return;
    rows.push(`<tr><td style="text-align:left">${esc(k)}</td><td style="text-align:left">${fmtVal(ov)}</td><td style="text-align:left">${fmtVal(nv)}</td></tr>`);
  });
  return rows.join("") || '<tr><td colspan="3" class="empty">No field-level changes recorded.</td></tr>';
}

async function loadLog(root) {
  const table = $(root, "logTable");
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';

  let query = supabase.from("audit_log").select("*").order("changed_at", { ascending: false }).limit(500);
  const from = $(root, "auditFrom").value;
  const to = $(root, "auditTo").value;
  const who = $(root, "auditUser").value;
  if (from) query = query.gte("changed_at", from + "T00:00:00");
  if (to) query = query.lte("changed_at", to + "T23:59:59");
  if (who) query = query.eq("changed_by", who);

  const { data, error } = await query;
  if (error) {
    table.innerHTML = `<tbody><tr><td class="empty">Couldn't load audit log: ${esc(error.message)}</td></tr></tbody>`;
    return;
  }
  if (!data.length) {
    table.innerHTML = '<tbody><tr><td class="empty">No audit entries match this filter.</td></tr></tbody>';
    return;
  }

  let h =
    '<thead><tr><th style="text-align:left">When</th><th style="text-align:left">Table</th><th style="text-align:left">Record</th><th style="text-align:left">Action</th><th style="text-align:left">Changed by</th></tr></thead><tbody>';
  data.forEach((row) => {
    const who = profilesById[row.changed_by]?.full_name || row.changed_by || "—";
    h += `<tr class="auditRow" data-id="${row.id}" style="cursor:pointer">
      <td style="text-align:left">${new Date(row.changed_at).toLocaleString()}</td>
      <td style="text-align:left">${esc(row.table_name)}</td>
      <td style="text-align:left">${esc(row.record_key)}</td>
      <td style="text-align:left">${esc(row.action)}</td>
      <td style="text-align:left">${esc(who)}</td>
    </tr>
    <tr class="auditDetail hidden" data-detail="${row.id}"><td colspan="5">
      <table style="width:100%"><thead><tr><th style="text-align:left">Field</th><th style="text-align:left">Old</th><th style="text-align:left">New</th></tr></thead>
      <tbody>${diffRows(row.old_data, row.new_data)}</tbody></table>
    </td></tr>`;
  });
  h += "</tbody>";
  table.innerHTML = h;

  table.querySelectorAll(".auditRow").forEach((tr) =>
    tr.addEventListener("click", () => {
      const detail = table.querySelector(`[data-detail="${tr.dataset.id}"]`);
      if (detail) detail.classList.toggle("hidden");
    })
  );
}

async function build(root) {
  root.innerHTML = `
    <section class="block">
      <h2>Audit log</h2>
      <div class="rangebar">
        <label class="f">From<input type="date" id="auditFrom"></label>
        <label class="f">To<input type="date" id="auditTo"></label>
        <label class="f">Changed by
          <select id="auditUser"><option value="">Everyone</option></select>
        </label>
        <button class="btn primary" id="auditFilterBtn">Filter</button>
      </div>
      <p class="hint" style="margin-top:0">Select a row to see the old and new values for that change.</p>
      <div class="tscroll"><table id="logTable"></table></div>
    </section>
  `;

  try {
    const profiles = await listProfiles();
    profilesById = Object.fromEntries(profiles.map((p) => [p.id, p]));
    const sel = $(root, "auditUser");
    profiles.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.full_name;
      sel.appendChild(opt);
    });
  } catch {
    // Non-fatal — the log still loads, just without friendly names.
  }

  $(root, "auditFilterBtn").addEventListener("click", () => loadLog(root));
  loadLog(root);
}

export function renderAudit(root) {
  const needsBuild = root.dataset.activePage !== "audit" || !root.querySelector("#logTable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "audit";
  }
  // Data changes elsewhere (entries/prices/settings) don't need to force a
  // reload of the log here; the admin re-opens the tab or hits Filter.
}
