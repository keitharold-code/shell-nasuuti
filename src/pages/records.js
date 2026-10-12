// Director's Records inbox + day review + approve/return —
// PLAN_PHASE2.md section 6. Reads straight from the draft tables for a
// not-yet-approved day (there is no v_provisional_report — see this
// file's own note below) and from the real v_daily_report once a day is
// APPROVED, since at that point it's the same row every other report
// reads.

import { dmy, ugx, lit, esc } from "../lib/format.js";
import { fetchDayReport } from "../lib/data.js";
import {
  listDayRecords, fetchDayRecord, approveDayRecord, returnDayRecord,
  listNozzleMeters, fetchManagerDayEntry, fetchCashierDayEntry,
  draftDeliveries, draftOtherOwnUse, listDraftCreditPrepaidDraws,
  listDraftRecoveries, listDraftPrepaidDeposits, listDraftExpenses, draftOtherIncome,
  draftForecourtCashDrops, listSafeCounts, pettyCashLedger,
} from "../lib/records.js";
import { toast } from "../lib/toast.js";

let records = [];
let statusFilter = "";
let openDate = null;

function $(root, id) {
  return root.querySelector("#" + id);
}

const STATUS_LABEL = {
  OPEN: "Open",
  MANAGER_SUBMITTED: "Manager submitted",
  CASHIER_SUBMITTED: "Awaiting approval",
  APPROVED: "Approved",
};

function build(root) {
  root.innerHTML = `
    <section class="block">
      <h2>Records inbox</h2>
      <label class="f" style="max-width:260px">Filter by status
        <select id="statusFilter">
          <option value="">All</option>
          <option value="CASHIER_SUBMITTED">Awaiting approval</option>
          <option value="MANAGER_SUBMITTED">Manager submitted</option>
          <option value="OPEN">Open</option>
          <option value="APPROVED">Approved</option>
        </select>
      </label>
      <div class="tscroll" style="margin-top:10px"><table id="inboxTable"></table></div>
    </section>
    <section class="block hidden" id="reviewBlock">
      <h2>Day review <small id="reviewDate"></small></h2>
      <div id="reviewBody"></div>
      <div class="actions" style="margin-top:14px">
        <button class="btn primary" id="approveBtn">Approve</button>
        <button class="btn danger" id="returnBtn">Return for correction</button>
        <button class="btn" id="closeReviewBtn">Close</button>
      </div>
    </section>
  `;
  $(root, "statusFilter").addEventListener("change", () => {
    statusFilter = $(root, "statusFilter").value;
    refreshInbox(root);
  });
  $(root, "inboxTable").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-date]");
    if (tr) openReview(root, tr.dataset.date);
  });
  $(root, "approveBtn").addEventListener("click", () => onApprove(root));
  $(root, "returnBtn").addEventListener("click", () => onReturn(root));
  $(root, "closeReviewBtn").addEventListener("click", () => closeReview(root));
  refreshInbox(root);
}

function inboxTableHtml() {
  if (!records.length) return '<tbody><tr><td class="empty">Nothing here.</td></tr></tbody>';
  let h = "<thead><tr><th>Date</th><th>Status</th><th>Manager</th><th>Cashier</th><th>Flags</th></tr></thead><tbody>";
  records.forEach((r) => {
    const flags = [
      r.late_manager ? "Manager late" : "",
      r.late_cashier ? "Cashier late" : "",
      r.returned_reason ? "Returned" : "",
      r.edited_after_submit ? "Edited after approval" : "",
    ].filter(Boolean).join(", ");
    h += `<tr data-date="${r.trading_date}" tabindex="0"><td>${dmy(r.trading_date)}</td><td>${STATUS_LABEL[r.status] || r.status}</td><td>${r.manager_submitted_at ? "✓" : "—"}</td><td>${r.cashier_submitted_at ? "✓" : "—"}</td><td class="${flags ? "neg" : ""}">${flags || "—"}</td></tr>`;
  });
  return h + "</tbody>";
}

async function refreshInbox(root) {
  try {
    records = await listDayRecords(statusFilter ? { statuses: [statusFilter] } : {});
  } catch (err) {
    toast("Couldn't load records: " + (err.message || ""));
    records = [];
  }
  $(root, "inboxTable").innerHTML = inboxTableHtml();
}

function kv(label, val, cls) {
  return `<div class="kv"><span>${label}</span><b class="num ${cls || ""}">${val}</b></div>`;
}

async function openReview(root, date) {
  openDate = date;
  $(root, "reviewBlock").classList.remove("hidden");
  $(root, "reviewDate").textContent = dmy(date);
  $(root, "reviewBody").innerHTML = '<div class="hint">Loading…</div>';

  const rec = await fetchDayRecord(date).catch(() => null);
  const approved = rec?.status === "APPROVED";

  if (approved) {
    const dayReport = await fetchDayReport(date).catch(() => null);
    const r = dayReport?.report;
    $(root, "reviewBody").innerHTML = r
      ? kv("Net profit", ugx(r.net_profit)) +
        kv("Total GP", ugx(r.total_gp)) +
        kv("Records expected cash", r.records_live ? ugx(r.records_expected_cash) : "—") +
        kv("Over/(Short)", r.records_live ? ugx(r.records_over_short) : "—", Math.abs(r.records_over_short || 0) > 1 ? "neg" : "") +
        kv("Not banked", r.records_live ? ugx(r.records_not_banked) : "—")
      : '<div class="hint">No approved report found for this date.</div>';
    $(root, "approveBtn").classList.add("hidden");
    $(root, "returnBtn").classList.remove("hidden");
    $(root, "returnBtn").textContent = "Unlock for correction";
    return;
  }

  $(root, "approveBtn").classList.toggle("hidden", rec?.status !== "CASHIER_SUBMITTED");
  $(root, "returnBtn").classList.remove("hidden");
  $(root, "returnBtn").textContent = "Return for correction";

  const [nozzles, manager, cashier, deliveries, ownUse, credits, recoveries, deposits, expenses, otherIncome, cashDrops, safeCounts, pettyCash] =
    await Promise.all([
      listNozzleMeters(date).catch(() => []),
      fetchManagerDayEntry(date).catch(() => null),
      fetchCashierDayEntry(date).catch(() => null),
      draftDeliveries.list(date).catch(() => []),
      draftOtherOwnUse.list(date).catch(() => []),
      listDraftCreditPrepaidDraws(date).catch(() => []),
      listDraftRecoveries(date).catch(() => []),
      listDraftPrepaidDeposits(date).catch(() => []),
      listDraftExpenses(date).catch(() => []),
      draftOtherIncome.list(date).catch(() => []),
      draftForecourtCashDrops.list(date).catch(() => []),
      listSafeCounts(date).catch(() => []),
      pettyCashLedger.list(date).catch(() => []),
    ]);

  let h = "<h3>Manager</h3>";
  h += kv("Status", rec?.manager_submitted_at ? "Submitted" + (rec.late_manager ? " (late)" : "") : "Not yet submitted");
  h += `<div class="hint">Nozzles: ${nozzles.map((n) => `${n.nozzle_id} ${lit(n.opening || 0)}→${lit(n.closing || 0)}`).join(", ") || "none"}</div>`;
  h += kv("Dips", `PMS ${lit(manager?.dip_pms || 0)} · AGO ${lit(manager?.dip_ago || 0)} · VP ${lit(manager?.dip_vp || 0)}`);
  h += kv("Non-fuel sales", `Shop ${ugx(manager?.shop_sales || 0)} · LPG ${ugx(manager?.lpg_sales || 0)} · Lubes ${ugx(manager?.lubes_sales || 0)}`);
  h += kv("Deliveries", deliveries.length ? deliveries.map((d) => `${d.product} ${lit(d.invoiced_litres)}L`).join(", ") : "None");
  h += kv("Own-use (other)", ownUse.length ? ownUse.map((o) => `${o.product} ${lit(o.litres)}L`).join(", ") : "None");
  h += kv("Credit/prepaid draws", credits.length ? credits.map((c) => ugx(c.amount)).join(", ") : "None");
  h += kv("Forecourt cash drops", cashDrops.map((c) => `${c.shift}: ${ugx(c.amount)}`).join(", ") || "None");
  h += `<div class="hint">Remarks: ${esc(manager?.remarks || "None")}</div>`;

  h += "<h3 style='margin-top:16px'>Cashier</h3>";
  h += kv("Status", rec?.cashier_submitted_at ? "Submitted" + (rec.late_cashier ? " (late)" : "") : "Not yet submitted");
  h += kv("Safe counts", safeCounts.map((s) => `${s.shift}: ${ugx(s.counted_amount)}${s.locked_at ? " (locked)" : ""}`).join(", ") || "None");
  h += kv("Payment channels", `Shell ${ugx(cashier?.pay_shell_card || 0)} · Visa ${ugx(cashier?.pay_visa || 0)} · Airtel ${ugx(cashier?.pay_airtel || 0)} · MoMo ${ugx(cashier?.pay_momo_mtn || 0)} · Absa ${ugx(cashier?.pay_absa || 0)}`);
  h += kv("Recoveries", recoveries.length ? recoveries.map((r) => ugx(r.amount)).join(", ") : "None");
  h += kv("Prepaid deposits", deposits.length ? deposits.map((d) => ugx(d.amount)).join(", ") : "None");
  h += kv("Payments from takings", expenses.length ? expenses.map((e) => `${e.category} ${ugx(e.amount)}${e.confirmed_at ? " ✓" : ""}`).join(", ") : "None");
  h += kv("Petty cash", pettyCash.length ? pettyCash.map((p) => `${p.event_type} ${ugx(p.amount)}`).join(", ") : "None");
  h += kv("Banking", `${ugx(cashier?.bank_centenary || 0)} — slip ${cashier?.banking_slip_no || "none"}`);
  if (rec?.returned_reason) h += `<div class="notice err">Previously returned: ${esc(rec.returned_reason)}</div>`;

  $(root, "reviewBody").innerHTML = h;
}

function closeReview(root) {
  openDate = null;
  $(root, "reviewBlock").classList.add("hidden");
}

async function onApprove(root) {
  if (!openDate) return;
  if (!confirm(`Approve ${dmy(openDate)}? This copies the submitted drafts into the permanent record.`)) return;
  try {
    await approveDayRecord(openDate);
    toast("Day approved.");
    closeReview(root);
    refreshInbox(root);
  } catch (err) {
    toast("Couldn't approve: " + (err.message || ""));
  }
}

async function onReturn(root) {
  if (!openDate) return;
  const reason = prompt("Reason for returning this day (required):");
  if (!reason || !reason.trim()) return;
  try {
    await returnDayRecord(openDate, reason.trim());
    toast("Day returned for correction.");
    closeReview(root);
    refreshInbox(root);
  } catch (err) {
    toast("Couldn't return: " + (err.message || ""));
  }
}

export function renderRecords(root) {
  const needsBuild = root.dataset.activePage !== "records" || !root.querySelector("#inboxTable");
  if (needsBuild) {
    build(root);
    root.dataset.activePage = "records";
  } else {
    refreshInbox(root);
  }
}
