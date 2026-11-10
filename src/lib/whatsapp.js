// PLAN_PHASE2.md section 5.7 / 0034's own migration note: the WhatsApp
// copy is generated client-side at submission time; only its hash is
// stored (day_records.manager_text_hash/cashier_text_hash), so a director
// can later paste the actual WhatsApp message back in and confirm it
// matches what was submitted.
//
// The original spec document (NASUUTI_Phase2_Section5.md) this was meant
// to transcribe was never in this repo and is no longer available, so
// this wording is NOT a transcription of it — it's a deliberate redesign,
// settled directly with Keith, after comparing against what the station
// actually sends day to day (a single combined reconciliation message,
// not two role-split ones). Two decisions from that conversation:
// 1. Nozzle meters are still captured in full on the manager's form
//    (section A) — that's what makes sold_pms/ago/vp trustworthy and
//    catches a meter reset. But the real daily message never lists
//    individual nozzles, only aggregate litres sold per product, so
//    that's what buildManagerText() shows too — litresSoldByProduct()
//    below computes it client-side using the exact same
//    sum(closing - opening) formula approve_day_record() (0033) later
//    uses server-side, so the figure shown here always matches what the
//    system will actually compute at approval.
// 2. The two-message-per-day shape (manager part + cashier part, each
//    independently hashed and verifiable) is kept rather than switched
//    to one combined message — that's what the Records workflow's
//    submit/verify steps are built around.
//
// normalise()/hashText() are NOT part of this redesign — "strip *_~,
// collapse whitespace, trim lines" is implemented exactly as originally
// specified and is what makes verification robust to WhatsApp's own
// reformatting (e.g. collapsing blank lines), independent of the wording
// above or below.

import { ugx, lit, dmy } from "./format.js";
import { nozzleProduct } from "./records.js";
import { PRODUCTS } from "./calc.js";

// Mirrors approve_day_record()'s (0033) own sum(coalesce(closing,0) -
// coalesce(opening,0)) per product exactly, so the litres-sold figure a
// director sees in the WhatsApp text is never out of step with what
// gets written to daily_entries.sold_* at approval.
function litresSoldByProduct(nozzles) {
  const totals = { PMS: 0, AGO: 0, VP: 0 };
  nozzles.forEach((n) => {
    const product = nozzleProduct(n.nozzle_id);
    if (product in totals) totals[product] += (n.closing ?? 0) - (n.opening ?? 0);
  });
  return totals;
}

export function normalise(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[*_~]/g, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function hashText(text) {
  const bytes = new TextEncoder().encode(normalise(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildManagerText({ date, nozzles, manager, deliveries, ownUse, creditDraws, cashDrops }) {
  const sold = litresSoldByProduct(nozzles);
  const lines = [
    `*DSR — SHELL NASUUTI* (Manager part)`,
    `Date: ${dmy(date)}`,
    "",
    "*Litres sold*",
    ...PRODUCTS.map((p) => `${p.label}: ${lit(sold[p.k] ?? 0)} L`),
    "",
    "*Tank dips (closing)*",
    `PMS: ${lit(manager?.dip_pms ?? 0)} L`,
    `AGO: ${lit(manager?.dip_ago ?? 0)} L`,
    `VP: ${lit(manager?.dip_vp ?? 0)} L`,
    "",
    "*Deliveries*",
    ...(deliveries.length ? deliveries.map((d) => `${d.product}: ${lit(d.invoiced_litres)} L (${d.truck_reg || "no reg"})`) : ["None"]),
    "",
    "*Own-use / pump test*",
    `Generator — PMS ${lit(manager?.genuse_pms ?? 0)} / AGO ${lit(manager?.genuse_ago ?? 0)} / VP ${lit(manager?.genuse_vp ?? 0)} L`,
    `Pump test returned — PMS ${lit(manager?.pumptest_returned_pms ?? 0)} / AGO ${lit(manager?.pumptest_returned_ago ?? 0)} / VP ${lit(manager?.pumptest_returned_vp ?? 0)} L`,
    ...ownUse.map((o) => `Other: ${o.product} ${lit(o.litres)} L — ${o.reason}`),
    "",
    "*Non-fuel sales*",
    `Shop: UGX ${ugx(manager?.shop_sales ?? 0)}`,
    `LPG: UGX ${ugx(manager?.lpg_sales ?? 0)}`,
    `Lubes: UGX ${ugx(manager?.lubes_sales ?? 0)}`,
    "",
    "*Credit / prepaid draws*",
    ...(creditDraws.length ? creditDraws.map((c) => `${c.customers?.name || "customer"}: UGX ${ugx(c.amount)} (${c.type})`) : ["None"]),
    "",
    "*Forecourt cash drops*",
    ...cashDrops.map((c) => `${c.shift}: UGX ${ugx(c.amount)}`),
    "",
    `Remarks: ${manager?.remarks || "None"}`,
  ];
  return lines.join("\n");
}

export function buildCashierText({ date, safeCounts, cashier, recoveries, deposits, pettyCash, expected }) {
  const lines = [
    `*DSR — SHELL NASUUTI* (Cashier part)`,
    `Date: ${dmy(date)}`,
    "",
    "*Safe count*",
    ...safeCounts.map((s) => `${s.shift}: UGX ${ugx(s.counted_amount)} (witness: ${s.witness_name})`),
    "",
    "*Payment channels*",
    `Shell Card: UGX ${ugx(cashier?.pay_shell_card ?? 0)}`,
    `Centenary Visa: UGX ${ugx(cashier?.pay_visa ?? 0)}`,
    `Airtel Pay: UGX ${ugx(cashier?.pay_airtel ?? 0)}`,
    `MTN MoMo Pay: UGX ${ugx(cashier?.pay_momo_mtn ?? 0)}`,
    `Absa Card: UGX ${ugx(cashier?.pay_absa ?? 0)}`,
    "",
    "*Recoveries*",
    ...(recoveries.length ? recoveries.map((r) => `${r.customers?.name || "customer"}: UGX ${ugx(r.amount)}`) : ["None"]),
    "",
    "*Prepaid deposits*",
    ...(deposits.length ? deposits.map((d) => `${d.customers?.name || "customer"}: UGX ${ugx(d.amount)}`) : ["None"]),
    "",
    "*Petty cash*",
    ...(pettyCash.length ? pettyCash.map((p) => `${p.event_type}: UGX ${ugx(p.amount)}${p.note ? " — " + p.note : ""}`) : ["None"]),
    "",
    "*Banking*",
    `Banked: UGX ${ugx(cashier?.bank_centenary ?? 0)}`,
    `Slip no.: ${cashier?.banking_slip_no || "—"}`,
    "",
    "*Expected cash*",
    `Expected: UGX ${ugx(expected?.records_expected_cash ?? 0)}`,
    `Over/(Short): UGX ${ugx(expected?.records_over_short ?? 0)}`,
    `Not banked: UGX ${ugx(expected?.records_not_banked ?? 0)}`,
  ];
  return lines.join("\n");
}
