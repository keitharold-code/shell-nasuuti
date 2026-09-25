// Adapters between Supabase rows and the internal shapes calc.js expects,
// plus the CRUD/realtime wiring that keeps the store in sync.

import { supabase } from "./supabase.js";
import { getState, setState } from "./store.js";
import { PRODUCTS } from "./calc.js";
import { has } from "./format.js";

const PKEY = { PMS: "pms", AGO: "ago", VP: "vp" };

export function rowToEntry(row) {
  const dips = {}, deliv = {}, sold = {};
  PRODUCTS.forEach(({ k }) => {
    const p = PKEY[k];
    dips[k] = row[`dip_${p}`];
    deliv[k] = row[`deliv_${p}`];
    sold[k] = row[`sold_${p}`];
  });
  return {
    date: row.trading_date,
    dips,
    deliv,
    sold,
    forecourt: row.forecourt_sales,
    shop: row.shop_sales,
    lpg: row.lpg_sales,
    lubes: row.lubes_sales,
    payCash: row.pay_cash,
    payMomo: row.pay_momo,
    payShell: row.pay_shell_card,
    payVisa: row.pay_visa,
    payCredit: row.pay_credit,
    bankCente: row.bank_centenary,
    bankExim: row.bank_exim,
    expenses: row.expenses,
    notes: row.notes,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

export function entryToRow(e) {
  return {
    trading_date: e.date,
    dip_pms: e.dips.PMS, dip_ago: e.dips.AGO, dip_vp: e.dips.VP,
    deliv_pms: e.deliv.PMS, deliv_ago: e.deliv.AGO, deliv_vp: e.deliv.VP,
    sold_pms: e.sold.PMS, sold_ago: e.sold.AGO, sold_vp: e.sold.VP,
    forecourt_sales: e.forecourt,
    shop_sales: e.shop,
    lpg_sales: e.lpg,
    lubes_sales: e.lubes,
    pay_cash: e.payCash,
    pay_momo: e.payMomo,
    pay_shell_card: e.payShell,
    pay_visa: e.payVisa,
    pay_credit: e.payCredit,
    bank_centenary: e.bankCente,
    bank_exim: e.bankExim,
    expenses: e.expenses,
    notes: e.notes || null,
  };
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

export function rowToSettings(priceRows, settingsRow) {
  return {
    priceHistory: priceRows.map(rowToPriceSet),
    nonFuel: {
      shop: settingsRow?.shop_margin_pct ?? 0,
      lpg: settingsRow?.lpg_margin_pct ?? 0,
      lubes: settingsRow?.lubes_margin_pct ?? 0,
    },
    tolerance: settingsRow?.stock_tolerance_pct ?? 0.5,
  };
}

async function reloadAll() {
  const [entriesRes, pricesRes, settingsRes] = await Promise.all([
    supabase.from("daily_entries").select("*").order("trading_date", { ascending: true }).limit(5000),
    supabase.from("price_sets").select("*"),
    supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
  ]);

  if (entriesRes.error || pricesRes.error || settingsRes.error) {
    setState({
      connectionError:
        entriesRes.error?.message || pricesRes.error?.message || settingsRes.error?.message,
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
    settings: rowToSettings(pricesRes.data, settingsRes.data),
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

export async function saveMargins({ shop, lpg, lubes, tolerance }) {
  const { error } = await supabase
    .from("settings")
    .update({
      shop_margin_pct: shop,
      lpg_margin_pct: lpg,
      lubes_margin_pct: lubes,
      stock_tolerance_pct: tolerance,
    })
    .eq("id", 1);
  if (error) throw error;
  await reloadAll();
}

export function hasAnyPaymentField(e) {
  return ["payCash", "payMomo", "payShell", "payVisa", "payCredit"].some((k) => has(e[k]));
}
