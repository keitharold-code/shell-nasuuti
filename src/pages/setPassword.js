import { updatePassword, signOut } from "../lib/session.js";
import { toast } from "../lib/toast.js";

export function renderSetPassword(root, onDone) {
  root.innerHTML = `
    <div class="loginwrap">
      <div class="loginbox">
        <h1>Shell Nasuuti</h1>
        <p class="sub">Set a password for your account to continue.</p>
        <div id="setPwErr" class="err hidden"></div>
        <form id="setPwForm">
          <label class="f">New password
            <input type="password" id="newPassword" autocomplete="new-password" required minlength="8">
          </label>
          <label class="f">Confirm password
            <input type="password" id="confirmPassword" autocomplete="new-password" required minlength="8">
          </label>
          <button class="btn primary" type="submit" style="width:100%" id="setPwBtn">Set password</button>
        </form>
        <p style="margin-top:14px;text-align:center">
          <button class="linklike" id="cancelSetPwBtn">Sign out instead</button>
        </p>
      </div>
    </div>
  `;

  const form = root.querySelector("#setPwForm");
  const errBox = root.querySelector("#setPwErr");
  const btn = root.querySelector("#setPwBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.add("hidden");
    const pw = root.querySelector("#newPassword").value;
    const confirm = root.querySelector("#confirmPassword").value;
    if (pw !== confirm) {
      errBox.textContent = "Passwords don't match.";
      errBox.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Setting password…";
    try {
      await updatePassword(pw);
      toast("Password set.");
      onDone();
    } catch (err) {
      errBox.textContent = err.message || "Couldn't set password.";
      errBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Set password";
    }
  });

  root.querySelector("#cancelSetPwBtn").addEventListener("click", async () => {
    await signOut();
  });
}
