import { signIn, sendPasswordReset } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { supabaseConfigured } from "../lib/supabase.js";

export function renderLogin(root) {
  root.innerHTML = `
    <div class="loginwrap">
      <div class="loginbox">
        <h1>Shell Nasuuti</h1>
        <p class="sub">Daily sales &amp; gross profit — sign in to continue.</p>
        ${!supabaseConfigured ? '<p class="err">App isn\'t connected to Supabase yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.</p>' : ""}
        <div id="loginErr" class="err hidden"></div>
        <form id="loginForm">
          <label class="f">Email
            <input type="email" id="email" autocomplete="username" required>
          </label>
          <label class="f">Password
            <input type="password" id="password" autocomplete="current-password" required>
          </label>
          <button class="btn primary" type="submit" style="width:100%" id="loginBtn">Sign in</button>
        </form>
        <p style="margin-top:14px;text-align:center">
          <button class="linklike" id="forgotBtn">Forgot your password?</button>
        </p>
      </div>
    </div>
  `;

  const form = root.querySelector("#loginForm");
  const errBox = root.querySelector("#loginErr");
  const btn = root.querySelector("#loginBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await signIn(root.querySelector("#email").value.trim(), root.querySelector("#password").value);
    } catch (err) {
      errBox.textContent = err.message || "Couldn't sign in. Check your email and password.";
      errBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  root.querySelector("#forgotBtn").addEventListener("click", async () => {
    const email = root.querySelector("#email").value.trim();
    if (!email) {
      toast("Enter your email above first, then tap this again.");
      return;
    }
    try {
      await sendPasswordReset(email);
      toast("Password reset link sent to " + email + ".");
    } catch (err) {
      toast("Couldn't send reset link: " + (err.message || ""));
    }
  });
}
