// Supabase Edge Function: admin-only user management.
//
// Inviting a user and truly locking a user out of auth (not just hiding
// them in the app) both need the service-role key, which must never ship
// in the client bundle. This function holds that key as a Supabase secret
// (set with `supabase secrets set`, never committed) and checks the
// caller's own JWT resolves to an admin profile before doing anything
// privileged.
//
// Deploy: supabase functions deploy admin-users
// Secrets (server-side only, already present in every Supabase project):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — set automatically by the
//   platform for edge functions; no manual step needed.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: profile } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", userData.user.id)
    .single();

  if (!profile || profile.role !== "admin" || !profile.is_active) {
    return json({ error: "Admin access required" }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = payload.action;

  if (action === "invite") {
    const email = String(payload.email ?? "").trim();
    const fullName = String(payload.full_name ?? "").trim();
    const role = String(payload.role ?? "entry");
    if (!email) return json({ error: "email is required" }, 400);
    if (!["admin", "entry", "viewer"].includes(role)) {
      return json({ error: "invalid role" }, 400);
    }

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName || email },
    });
    if (error) return json({ error: error.message }, 400);

    // The auth trigger creates the profile row with role 'entry'; correct
    // it to the requested role right away.
    if (data.user && role !== "entry") {
      await admin.from("profiles").update({ role }).eq("id", data.user.id);
    }
    return json({ ok: true, user_id: data.user?.id });
  }

  if (action === "deactivate" || action === "reactivate") {
    const userId = String(payload.user_id ?? "");
    if (!userId) return json({ error: "user_id is required" }, 400);
    if (userId === userData.user.id) {
      return json({ error: "You cannot deactivate your own account" }, 400);
    }

    const banned = action === "deactivate";
    const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: banned ? "876000h" : "none", // ~100 years / lift the ban
    });
    if (banErr) return json({ error: banErr.message }, 400);

    const { error: profErr } = await admin
      .from("profiles")
      .update({ is_active: !banned })
      .eq("id", userId);
    if (profErr) return json({ error: profErr.message }, 400);

    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
