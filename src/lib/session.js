import { supabase } from "./supabase.js";
import { setState } from "./store.js";

export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function refreshSession() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  let profile = null;
  if (session) {
    try {
      profile = await fetchProfile(session.user.id);
    } catch {
      profile = null;
    }
  }
  setState({ session, profile });
  return { session, profile };
}

export function watchAuth(onChange) {
  supabase.auth.onAuthStateChange(async (event, session) => {
    let profile = null;
    if (session) {
      try {
        profile = await fetchProfile(session.user.id);
      } catch {
        profile = null;
      }
    }
    // Called before setState so a caller reacting to the event (e.g. to
    // flag a PASSWORD_RECOVERY session as needing a password screen) runs
    // ahead of the re-render setState triggers, not after it.
    onChange?.({ event, session, profile });
    setState({ session, profile });
  });
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  setState({ session: null, profile: null });
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}
