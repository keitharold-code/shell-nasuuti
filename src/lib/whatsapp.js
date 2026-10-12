// PLAN_PHASE2.md section 5.7 / 0034's own migration note: the WhatsApp
// copy is generated client-side at submission time; only its hash is
// stored (day_records.manager_text_hash/cashier_text_hash), so a director
// can later paste the actual WhatsApp message back in and confirm it
// matches what was submitted.
//
// FLAGGED, not guessed quietly: the exact wording below is built to the
// documented shape (a "*DSR — SHELL NASUUTI*" header, a Manager part and
// a Cashier part) but this file does not have the original spec's
// literal line-by-line copy in front of it. Treat buildManagerText()/
// buildCashierText() as a working placeholder in the right shape, not a
// transcription — swap in the exact wording from NASUUTI_Phase2_Section5.md
// section 5.7 before relying on hash verification against a real
// pasted-back message from a director who has that original text.
//
// normalise()/hashText() themselves are NOT placeholders — "strip
// *_~, collapse whitespace, trim lines" is implemented exactly as
// specified and is what makes verification robust to WhatsApp's own
// reformatting (e.g. collapsing blank lines), independent of the exact
// wording above.

import { ugx, lit, dmy } from "./format.js";

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
  const lines = [
    `*DSR — SHELL NASUUTI* (Manager part)`,
    `Date: ${dmy(date)}`,
    "",
    "*Nozzle meters*",
    ...nozzles.map((n) => `${n.nozzle_id}: ${lit(n.opening ?? 0)} → ${lit(n.closing ?? 0)}`),
    "",
    "*Tank dips*",
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
    "*Expected cash (Section 3)*",
    `Expected: UGX ${ugx(expected?.records_expected_cash ?? 0)}`,
    `Over/(Short): UGX ${ugx(expected?.records_over_short ?? 0)}`,
    `Not banked: UGX ${ugx(expected?.records_not_banked ?? 0)}`,
  ];
  return lines.join("\n");
}
