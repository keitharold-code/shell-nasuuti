// Adapters between Supabase rows and the internal shapes calc.js expects,
// plus the CRUD/realtime wiring that keeps the store in sync.

import { supabase } from "./supabase.js";
import { getState, setState } from "./store.js";
import { PRODUCTS } from "./calc.js";
import { has } from "./format.js";

const PKEY = { PMS: "pms", AGO: "ago", VP: "vp" };

export function rowToEntry(row) {
  const dips = {}, deliv = {}, sold = {}, genuse = {}, pumptest = {};
  PRODUCTS.forEach(({ k }) => {
    const p = PKEY[k];
    dips[k] = row[`dip_${p}`];
    deliv[k] = row[`deliv_${p}`];
    sold[k] = row[`sold_${p}`];
    genuse[k] = row[`genuse_${p}`];
    pumptest[k] = row[`pumptest_returned_${p}`];
  });
  return {
    date: row.trading_date,
    dips,
    deliv,
    sold,
    genuse,
    pumptest,
    forecourtCashDrop: row.forecourt_cash_drop,
    shop: row.shop_sales,
    lpg: row.lpg_sales,
    lubes: row.lubes_sales,
    payCash: row.pay_cash,
    payMomo: row.pay_momo,
    payShell: row.pay_shell_card,
    payVisa: row.pay_visa,
    payCredit: row.pay_credit,
    payAirtel: row.pay_airtel,
    payMomoMtn: row.pay_momo_mtn,
    bankCente: row.bank_centenary,
    bankExim: row.bank_exim,
    // expenses is read for display only going forward — it's kept in sync
    // by a trigger off expense_entries (0016) the moment any row exists
    // for the date, so the app never writes it directly for a new entry.
    // A day with no expense_entries rows (including every pre-Phase-1
    // historical day) keeps reading whatever flat value it always had.
    expenses: row.expenses,
    nonFuelCashBankedWithForecourt: row.non_fuel_cash_banked_with_forecourt,
    notes: row.notes,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

export function entryToRow(e) {
  const row = {
    trading_date: e.date,
    dip_pms: e.dips.PMS, dip_ago: e.dips.AGO, dip_vp: e.dips.VP,
    sold_pms: e.sold.PMS, sold_ago: e.sold.AGO, sold_vp: e.sold.VP,
    genuse_pms: e.genuse.PMS, genuse_ago: e.genuse.AGO, genuse_vp: e.genuse.VP,
    pumptest_returned_pms: e.pumptest.PMS, pumptest_returned_ago: e.pumptest.AGO, pumptest_returned_vp: e.pumptest.VP,
    forecourt_cash_drop: e.forecourtCashDrop,
    shop_sales: e.shop,
    lpg_sales: e.lpg,
    lubes_sales: e.lubes,
    pay_cash: e.payCash,
    pay_momo: e.payMomo,
    pay_shell_card: e.payShell,
    pay_visa: e.payVisa,
    pay_credit: e.payCredit,
    pay_airtel: e.payAirtel,
    pay_momo_mtn: e.payMomoMtn,
    bank_centenary: e.bankCente,
    // bank_exim is deliberately never written here — the app only ever
    // collects one banking field now. Omitting the key (rather than
    // sending null) means an upsert on an existing historical row leaves
    // whatever bank_exim it already has untouched, per the requirement
    // that old Exim amounts keep counting in "Total banked" unmigrated.
    non_fuel_cash_banked_with_forecourt: e.nonFuelCashBankedWithForecourt,
    notes: e.notes || null,
  };
  // deliv_pms/ago/vp and expenses are deliberately NOT sent on a fresh
  // upsert from this form — both are kept as live sums by triggers off
  // the deliveries (0014) and expense_entries (0016) child tables the
  // moment either has a row for the date, and sending a value here would
  // only matter for a date with NEITHER a deliveries row nor an
  // expense_entries row yet, where omitting the key leaves whatever the
  // column already holds (0, or a pre-Phase-1 flat figure) untouched —
  // exactly the "don't lose old data, don't fight the new trigger" case.
  return row;
}

export function rowToPriceSet(row) {
  return {
    id: row.id,
    from: row.effective_from,
    PMS: { price: row.pms_price, margin: row.pms_margin },
    AGO: { price: row.ago_price, margin: row.ago_margin },
    VP: { price: row.vp_price, margin: row.vp_margin },
  };
}

export function priceSetToRow(p) {
  return {
    effective_from: p.from,
    pms_price: p.PMS.price, pms_margin: p.PMS.margin,
    ago_price: p.AGO.price, ago_margin: p.AGO.margin,
    vp_price: p.VP.price, vp_margin: p.VP.margin,
  };
}

export function rowToNonFuelMargin(row) {
  return {
    id: row.id,
    from: row.effective_from,
    shop: row.shop_pct,
    lpg: row.lpg_pct,
    lubes: row.lubes_pct,
    endDate: row.end_date,
    reason: row.reason,
  };
}

export function nonFuelMarginToRow(m) {
  return {
    effective_from: m.from,
    shop_pct: m.shop,
    lpg_pct: m.lpg,
    lubes_pct: m.lubes,
    end_date: m.endDate || null,
    reason: m.reason || null,
  };
}

export function rowToSettings(priceRows, nonFuelMarginRows, settingsRow) {
  return {
    priceHistory: priceRows.map(rowToPriceSet),
    nonFuelMarginHistory: nonFuelMarginRows.map(rowToNonFuelMargin),
    tolerance: settingsRow?.stock_tolerance_pct ?? 0.5,
    bankingAccountName: settingsRow?.banking_account_name ?? "Centenary",
    singleAccountBankingFrom: settingsRow?.single_account_banking_from ?? "2026-09-29",
    fuelCostBasis: settingsRow?.fuel_cost_basis ?? "FIXED",
  };
}

async function reloadAll() {
  const [entriesRes, pricesRes, nonFuelRes, settingsRes] = await Promise.all([
    supabase.from("daily_entries").select("*").order("trading_date", { ascending: true }).limit(5000),
    supabase.from("price_sets").select("*"),
    supabase.from("nonfuel_margins").select("*"),
    supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
  ]);

  if (entriesRes.error || pricesRes.error || nonFuelRes.error || settingsRes.error) {
    setState({
      connectionError:
        entriesRes.error?.message || pricesRes.error?.message || nonFuelRes.error?.message || settingsRes.error?.message,
    });
    return;
  }

  const entries = {};
  entriesRes.data.forEach((row) => {
    entries[row.trading_date] = rowToEntry(row);
  });

  setState({
    entries,
    dates: Object.keys(entries).sort(),
    settings: rowToSettings(pricesRes.data, nonFuelRes.data, settingsRes.data),
    connectionError: null,
    dbReady: true,
  });
}

let channel = null;

export async function initData() {
  await reloadAll();
  if (channel) return;
  channel = supabase
    .channel("nasuuti-data")
    .on("postgres_changes", { event: "*", schema: "public", table: "daily_entries" }, reloadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "price_sets" }, reloadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "nonfuel_margins" }, reloadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, reloadAll)
    .subscribe();
}

export function teardownData() {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}

export async function saveEntry(entry) {
  const row = entryToRow(entry);
  const { error } = await supabase.from("daily_entries").upsert(row, { onConflict: "trading_date" });
  if (error) throw error;
  await reloadAll();
}

export async function deleteEntry(date) {
  const { error } = await supabase.from("daily_entries").delete().eq("trading_date", date);
  if (error) throw error;
  await reloadAll();
}

// Deliveries and expense_entries write daily_entries.deliv_*/expenses via a
// server-side trigger (0014/0016), not through saveEntry — so after adding
// or removing one of those child rows, the global entries store is stale
// until something refetches it. Waiting on the Realtime subscription to
// catch the trigger's own daily_entries UPDATE works eventually, but it's
// a race with no bound on it (confirmed live: the read-only Delivered
// field stayed blank well past 10s after a delivery insert). This fetches
// and patches just the one row directly instead, deterministically.
export async function refreshEntry(date) {
  const { data, error } = await supabase.from("daily_entries").select("*").eq("trading_date", date).maybeSingle();
  if (error) throw error;
  const { entries } = getState();
  const next = { ...entries };
  if (data) next[date] = rowToEntry(data);
  else delete next[date];
  setState({ entries: next, dates: Object.keys(next).sort() });
  return next[date] || null;
}

export async function addPriceSet(p) {
  const row = priceSetToRow(p);
  const { error } = await supabase.from("price_sets").upsert(row, { onConflict: "effective_from" });
  if (error) throw error;
  await reloadAll();
}

export async function removePriceSet(from) {
  const { error } = await supabase.from("price_sets").delete().eq("effective_from", from);
  if (error) throw error;
  await reloadAll();
}

export async function addNonFuelMargin(m) {
  const row = nonFuelMarginToRow(m);
  const { error } = await supabase.from("nonfuel_margins").upsert(row, { onConflict: "effective_from" });
  if (error) throw error;
  await reloadAll();
}

export async function removeNonFuelMargin(from) {
  const { error } = await supabase.from("nonfuel_margins").delete().eq("effective_from", from);
  if (error) throw error;
  await reloadAll();
}

export async function saveTolerance(tolerance) {
  const { error } = await supabase.from("settings").update({ stock_tolerance_pct: tolerance }).eq("id", 1);
  if (error) throw error;
  await reloadAll();
}

export async function saveFuelCostBasis(fuelCostBasis) {
  const { error } = await supabase.from("settings").update({ fuel_cost_basis: fuelCostBasis }).eq("id", 1);
  if (error) throw error;
  await reloadAll();
}

export async function saveBankingSettings({ bankingAccountName, singleAccountBankingFrom }) {
  const { error } = await supabase
    .from("settings")
    .update({
      banking_account_name: bankingAccountName,
      single_account_banking_from: singleAccountBankingFrom,
    })
    .eq("id", 1);
  if (error) throw error;
  await reloadAll();
}

export function hasAnyPaymentField(e) {
  return ["payCash", "payMomo", "payShell", "payVisa", "payCredit", "payAirtel", "payMomoMtn"].some((k) => has(e[k]));
}

// ---------------------------------------------------------------------------
// Server-computed reports (PLAN.md 2.1): the client never recomputes GP,
// stock variance, cost basis, delivery shortfall or net profit — it reads
// the already-computed figures straight off v_daily_report / v_fuel_by_product
// / v_discrepancies. Rows come back with their original snake_case column
// names; reports.js and the exports read those names directly rather than
// through another adapter layer, since there is no arithmetic left to hide
// behind one.
// ---------------------------------------------------------------------------

export async function fetchReportRows(from, to) {
  const { data, error } = await supabase
    .from("v_daily_report")
    .select("*")
    .gte("trading_date", from)
    .lte("trading_date", to)
    .order("trading_date", { ascending: true });
  if (error) throw error;
  return data;
}

export async function fetchDiscrepancies(from, to) {
  const { data, error } = await supabase
    .from("v_discrepancies")
    .select("*")
    .gte("trading_date", from)
    .lte("trading_date", to)
    .order("trading_date", { ascending: true });
  if (error) throw error;
  return data;
}

// The Daily Entry screen's "as last saved" readout: the one computed row
// for this date plus its per-product breakdown. Returns null fields when
// the date has no saved entry yet (the view's lateral joins simply have no
// row to return), which the UI reads as "nothing saved for this date."
export async function fetchDayReport(date) {
  const [reportRes, productsRes] = await Promise.all([
    supabase.from("v_daily_report").select("*").eq("trading_date", date).maybeSingle(),
    supabase.from("v_fuel_by_product").select("*").eq("trading_date", date).order("product"),
  ]);
  if (reportRes.error) throw reportRes.error;
  if (productsRes.error) throw productsRes.error;
  return { report: reportRes.data, products: productsRes.data || [] };
}

// ---------------------------------------------------------------------------
// Per-date child tables (deliveries, expenses, own-use, other income,
// customer transactions). Each is loaded on demand for the date currently
// open in the Daily Entry screen, not kept in the global store — there's no
// report or export that needs every date's child rows loaded at once.
// ---------------------------------------------------------------------------

export async function listDeliveries(date) {
  const { data, error } = await supabase.from("deliveries").select("*").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addDelivery(row) {
  const { error } = await supabase.from("deliveries").insert(row);
  if (error) throw error;
}

export async function deleteDelivery(id) {
  const { error } = await supabase.from("deliveries").delete().eq("id", id);
  if (error) throw error;
}

export async function listExpenses(date) {
  const { data, error } = await supabase.from("expense_entries").select("*").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addExpense(row) {
  const { error } = await supabase.from("expense_entries").insert(row);
  if (error) throw error;
}

export async function deleteExpense(id) {
  const { error } = await supabase.from("expense_entries").delete().eq("id", id);
  if (error) throw error;
}

export async function listOtherOwnUse(date) {
  const { data, error } = await supabase.from("other_own_use").select("*").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addOtherOwnUse(row) {
  const { error } = await supabase.from("other_own_use").insert(row);
  if (error) throw error;
}

export async function deleteOtherOwnUse(id) {
  const { error } = await supabase.from("other_own_use").delete().eq("id", id);
  if (error) throw error;
}

export async function listOtherIncome(date) {
  const { data, error } = await supabase.from("other_income").select("*").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addOtherIncome(row) {
  const { error } = await supabase.from("other_income").insert(row);
  if (error) throw error;
}

export async function deleteOtherIncome(id) {
  const { error } = await supabase.from("other_income").delete().eq("id", id);
  if (error) throw error;
}

export async function listCreditPrepaidDraws(date) {
  const { data, error } = await supabase.from("credit_prepaid_draws").select("*, customers(name)").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addCreditPrepaidDraw(row) {
  const { error } = await supabase.from("credit_prepaid_draws").insert(row);
  if (error) throw error;
}

export async function deleteCreditPrepaidDraw(id) {
  const { error } = await supabase.from("credit_prepaid_draws").delete().eq("id", id);
  if (error) throw error;
}

export async function listRecoveries(date) {
  const { data, error } = await supabase.from("recoveries").select("*, customers(name)").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addRecovery(row) {
  const { error } = await supabase.from("recoveries").insert(row);
  if (error) throw error;
}

export async function deleteRecovery(id) {
  const { error } = await supabase.from("recoveries").delete().eq("id", id);
  if (error) throw error;
}

export async function listPrepaidDeposits(date) {
  const { data, error } = await supabase.from("prepaid_deposits").select("*, customers(name)").eq("trading_date", date).order("id");
  if (error) throw error;
  return data;
}

export async function addPrepaidDeposit(row) {
  const { error } = await supabase.from("prepaid_deposits").insert(row);
  if (error) throw error;
}

export async function deletePrepaidDeposit(id) {
  const { error } = await supabase.from("prepaid_deposits").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Admin-plane master data and director-only cost records.
// ---------------------------------------------------------------------------

export async function listCustomers() {
  const { data, error } = await supabase.from("customers").select("*").order("name");
  if (error) throw error;
  return data;
}

export async function addCustomer({ name, phone, notes }) {
  const { error } = await supabase.from("customers").insert({ name, phone: phone || null, notes: notes || null });
  if (error) throw error;
}

export async function setCustomerActive(id, isActive) {
  const { error } = await supabase.from("customers").update({ is_active: isActive }).eq("id", id);
  if (error) throw error;
}

// vivo_invoices is RLS-restricted to admins only (no select policy at all
// for other roles) — a non-admin's query simply returns zero rows, not an
// error, so this is safe to call from anywhere but only ever shown in Admin.
export async function listVivoInvoices() {
  const { data, error } = await supabase.from("vivo_invoices").select("*").order("invoice_date", { ascending: false });
  if (error) throw error;
  return data;
}

export async function addVivoInvoice(row) {
  const { error } = await supabase.from("vivo_invoices").insert(row);
  if (error) throw error;
}

export async function deleteVivoInvoice(id) {
  const { error } = await supabase.from("vivo_invoices").delete().eq("id", id);
  if (error) throw error;
}

export async function linkVivoInvoiceToDelivery(invoiceId, deliveryId) {
  const { error } = await supabase.from("vivo_invoices").update({ delivery_id: deliveryId }).eq("id", invoiceId);
  if (error) throw error;
}

export async function listOpeningStock() {
  const { data, error } = await supabase.from("opening_stock").select("*").order("product");
  if (error) throw error;
  return data;
}

export async function setOpeningStock(product, dip) {
  const { error } = await supabase.from("opening_stock").upsert({ product, dip }, { onConflict: "product" });
  if (error) throw error;
}

// Deliveries with an unresolved wet-stock shortfall — read straight from
// the view, never recomputed here (same "no client arithmetic" rule as the
// reports above). Used by Admin to decide which deliveries are worth
// filing a Vivo claim against.
export async function listDeliveryShortfalls() {
  const { data, error } = await supabase
    .from("v_delivery_shortfall")
    .select("*")
    .neq("shortfall_litres", 0)
    .order("trading_date", { ascending: false });
  if (error) throw error;
  return data;
}

export async function listShortageRefunds() {
  const { data, error } = await supabase
    .from("other_income")
    .select("*")
    .eq("category", "vivo_shortage_refund")
    .order("trading_date", { ascending: false });
  if (error) throw error;
  return data;
}

export async function listVivoClaims() {
  const { data, error } = await supabase
    .from("vivo_claims")
    .select("*, other_income(trading_date, amount, description)")
    .order("id", { ascending: false });
  if (error) throw error;
  return data;
}

export async function fileVivoClaim(row) {
  const { error } = await supabase.from("vivo_claims").insert(row);
  if (error) throw error;
}

export async function updateVivoClaim(id, patch) {
  const { error } = await supabase.from("vivo_claims").update(patch).eq("id", id);
  if (error) throw error;
}
