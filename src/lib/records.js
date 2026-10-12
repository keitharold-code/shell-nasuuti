// Phase 2 (Records module) data access — day_records workflow, nozzle
// meters, the manager/cashier single-valued tables, every repeatable
// draft_* table, safe counts, petty cash, stand-ins, and Storage photo
// upload/signed-url helpers. Kept separate from data.js (Phase 1) rather
// than folded in, same reasoning as calc.js/data.js already being split
// by concern — Phase 1's tables and RLS are untouched by any of this.

import { supabase } from "./supabase.js";

export const NOZZLES = ["PMS1", "PMS2", "PMS3", "PMS4", "AGO1", "AGO2", "AGO3", "AGO4", "VP1", "VP2"];

export function nozzleProduct(nozzleId) {
  return nozzleId.replace(/[0-9]+$/, "");
}

// ---------------------------------------------------------------------------
// day_records workflow
// ---------------------------------------------------------------------------

export async function fetchDayRecord(date) {
  const { data, error } = await supabase.from("day_records").select("*").eq("trading_date", date).maybeSingle();
  if (error) throw error;
  return data;
}

// A manager's first save for a date creates this row directly (RLS:
// is_manager_for(trading_date)) — not through an RPC, since "start a
// draft" is the row coming into existence, not a status transition.
export async function startDayRecord(date) {
  const { error } = await supabase.from("day_records").insert({ trading_date: date });
  if (error && error.code !== "23505") throw error; // 23505 = already exists, fine
}

export async function listDayRecords({ statuses } = {}) {
  let q = supabase.from("day_records").select("*").order("trading_date", { ascending: false });
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function transition(date, target, reason) {
  const { data, error } = await supabase.rpc("transition_day_record", {
    p_trading_date: date,
    p_target: target,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data;
}

export const submitManagerPart = (date) => transition(date, "MANAGER_SUBMITTED");
export const submitCashierPart = (date) => transition(date, "CASHIER_SUBMITTED");
export const approveDayRecord = (date) => transition(date, "APPROVED");
export const returnDayRecord = (date, reason) => transition(date, "RETURNED", reason);

export async function saveManagerTextHash(date, hash) {
  const { error } = await supabase.from("day_records").update({ manager_text_hash: hash }).eq("trading_date", date);
  if (error) throw error;
}

export async function saveCashierTextHash(date, hash) {
  const { error } = await supabase.from("day_records").update({ cashier_text_hash: hash }).eq("trading_date", date);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// role_standins
// ---------------------------------------------------------------------------

export async function listStandins(fromDate) {
  const { data, error } = await supabase
    .from("role_standins")
    .select("*, profiles:standin_user_id(full_name)")
    .gte("trading_date", fromDate)
    .order("trading_date", { ascending: true });
  if (error) throw error;
  return data;
}

export async function assignStandin({ trading_date, role, standin_user_id }) {
  const { error } = await supabase
    .from("role_standins")
    .upsert({ trading_date, role, standin_user_id }, { onConflict: "trading_date,role" });
  if (error) throw error;
}

export async function removeStandin(id) {
  const { error } = await supabase.from("role_standins").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Nozzle meters (seeded to all ten the moment day_records is created —
// this only ever UPDATEs existing rows, never inserts).
// ---------------------------------------------------------------------------

export async function listNozzleMeters(date) {
  const { data, error } = await supabase.from("nozzle_meters").select("*").eq("trading_date", date).order("nozzle_id");
  if (error) throw error;
  return data;
}

export async function saveNozzleMeter(date, nozzleId, { opening, closing }) {
  const patch = {};
  if (opening !== undefined) patch.opening = opening;
  if (closing !== undefined) patch.closing = closing;
  const { error } = await supabase.from("nozzle_meters").update(patch).eq("trading_date", date).eq("nozzle_id", nozzleId);
  if (error) throw error;
}

// director-only (RLS)
export async function addMeterResetEvent({ nozzle_id, new_opening, reason }) {
  const { error } = await supabase.from("meter_reset_events").insert({ nozzle_id, new_opening, reason });
  if (error) throw error;
}

export async function listMeterResetEvents() {
  const { data, error } = await supabase.from("meter_reset_events").select("*").order("set_at", { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Manager's single-valued fields (dips, own-use/pump-test, non-fuel
// sales, remarks+photos)
// ---------------------------------------------------------------------------

export async function fetchManagerDayEntry(date) {
  const { data, error } = await supabase.from("manager_day_entries").select("*").eq("trading_date", date).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveManagerDayEntry(date, patch) {
  const { error } = await supabase
    .from("manager_day_entries")
    .upsert({ trading_date: date, ...patch }, { onConflict: "trading_date" });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Cashier's single-valued fields (payment channels, banking)
// ---------------------------------------------------------------------------

export async function fetchCashierDayEntry(date) {
  const { data, error } = await supabase.from("cashier_day_entries").select("*").eq("trading_date", date).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveCashierDayEntry(date, patch) {
  const { error } = await supabase
    .from("cashier_day_entries")
    .upsert({ trading_date: date, ...patch }, { onConflict: "trading_date" });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Repeatable draft tables — one list/add/delete trio each, same shape as
// Phase 1's own child-table helpers in data.js.
// ---------------------------------------------------------------------------

function draftTable(table, { orderBy = "id" } = {}) {
  return {
    list: async (date) => {
      const { data, error } = await supabase.from(table).select("*").eq("trading_date", date).order(orderBy);
      if (error) throw error;
      return data;
    },
    add: async (row) => {
      const { error } = await supabase.from(table).insert(row);
      if (error) throw error;
    },
    remove: async (id) => {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
    },
  };
}

export const draftForecourtCashDrops = draftTable("draft_forecourt_cash_drops", { orderBy: "shift" });

// unique(trading_date, shift) means a plain insert would collide on a
// second save for the same shift — this upserts instead, so re-saving
// the cash-drops section updates rather than erroring.
export async function saveForecourtCashDrop({ trading_date, shift, amount }) {
  const { error } = await supabase
    .from("draft_forecourt_cash_drops")
    .upsert({ trading_date, shift, amount }, { onConflict: "trading_date,shift" });
  if (error) throw error;
}
export const draftDeliveries = draftTable("draft_deliveries");
export const draftOtherOwnUse = draftTable("draft_other_own_use");
export const draftOtherIncome = draftTable("draft_other_income");
export const draftPaymentChannelSplits = draftTable("draft_payment_channel_splits");

// Customer-linked drafts join the customer name, same as data.js's
// Phase 1 equivalents.
export async function listDraftCreditPrepaidDraws(date) {
  const { data, error } = await supabase
    .from("draft_credit_prepaid_draws")
    .select("*, customers(name)")
    .eq("trading_date", date)
    .order("id");
  if (error) throw error;
  return data;
}
export async function addDraftCreditPrepaidDraw(row) {
  const { error } = await supabase.from("draft_credit_prepaid_draws").insert(row);
  if (error) throw error;
}
export async function deleteDraftCreditPrepaidDraw(id) {
  const { error } = await supabase.from("draft_credit_prepaid_draws").delete().eq("id", id);
  if (error) throw error;
}

export async function listDraftRecoveries(date) {
  const { data, error } = await supabase.from("draft_recoveries").select("*, customers(name)").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}
export async function addDraftRecovery(row) {
  const { error } = await supabase.from("draft_recoveries").insert(row);
  if (error) throw error;
}
export async function deleteDraftRecovery(id) {
  const { error } = await supabase.from("draft_recoveries").delete().eq("id", id);
  if (error) throw error;
}

export async function listDraftPrepaidDeposits(date) {
  const { data, error } = await supabase.from("draft_prepaid_deposits").select("*, customers(name)").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}
export async function addDraftPrepaidDeposit(row) {
  const { error } = await supabase.from("draft_prepaid_deposits").insert(row);
  if (error) throw error;
}
export async function deleteDraftPrepaidDeposit(id) {
  const { error } = await supabase.from("draft_prepaid_deposits").delete().eq("id", id);
  if (error) throw error;
}

// draft_expense_entries: the one table both manager and cashier write to
// (manager logs a stock purchase, cashier confirms it) — see 0028.
export async function listDraftExpenses(date) {
  const { data, error } = await supabase.from("draft_expense_entries").select("*").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}
export async function addDraftExpense(row) {
  const { error } = await supabase.from("draft_expense_entries").insert(row);
  if (error) throw error;
}
export async function deleteDraftExpense(id) {
  const { error } = await supabase.from("draft_expense_entries").delete().eq("id", id);
  if (error) throw error;
}
export async function confirmDraftExpense(id) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("draft_expense_entries")
    .update({ confirmed_by: user?.id, confirmed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Safe counts (per shift, blind, locked once confirmed) and petty cash
// ---------------------------------------------------------------------------

export async function listSafeCounts(date) {
  const { data, error } = await supabase.from("safe_counts").select("*").eq("trading_date", date).order("shift");
  if (error) throw error;
  return data;
}

export async function saveSafeCount({ trading_date, shift, counted_amount, witness_name }) {
  const { error } = await supabase
    .from("safe_counts")
    .upsert({ trading_date, shift, counted_amount, witness_name }, { onConflict: "trading_date,shift" });
  if (error) throw error;
}

export async function lockSafeCount(date, shift) {
  const { error } = await supabase
    .from("safe_counts")
    .update({ locked_at: new Date().toISOString() })
    .eq("trading_date", date)
    .eq("shift", shift);
  if (error) throw error;
}

export const pettyCashLedger = draftTable("petty_cash_ledger");

// ---------------------------------------------------------------------------
// Manager's read-only price view (5.4: price, never margin)
// ---------------------------------------------------------------------------

export async function fetchManagerPrices() {
  const { data, error } = await supabase.from("v_manager_prices").select("*").order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Storage — day-records/{trading_date}/{role}/{filename}, private bucket
// ---------------------------------------------------------------------------

export async function uploadDayRecordPhoto(date, role, file) {
  const path = `${date}/${role}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage.from("day-records").upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

export async function signedPhotoUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from("day-records").createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Records settings (deadlines, tolerance already exists, go-live date)
// ---------------------------------------------------------------------------

export async function fetchRecordsSettings() {
  const { data, error } = await supabase
    .from("settings")
    .select("records_go_live_date, manager_deadline_time, cashier_deadline_time")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveRecordsSettings(patch) {
  const { error } = await supabase.from("settings").update(patch).eq("id", 1);
  if (error) throw error;
}
