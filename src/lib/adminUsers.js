import { supabase } from "./supabase.js";

export async function listProfiles() {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name", { ascending: true });
  if (error) throw error;
  return data;
}

export async function setUserRole(userId, role) {
  const { error } = await supabase.from("profiles").update({ role }).eq("id", userId);
  if (error) throw error;
}

async function callAdminUsers(body) {
  const { data, error } = await supabase.functions.invoke("admin-users", { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export function inviteUser(email, fullName, role) {
  return callAdminUsers({ action: "invite", email, full_name: fullName, role });
}

export function setUserActive(userId, active) {
  return callAdminUsers({ action: active ? "reactivate" : "deactivate", user_id: userId });
}
