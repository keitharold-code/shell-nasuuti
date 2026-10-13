import "./style.css";
import { getState, subscribe } from "./lib/store.js";
import { refreshSession, watchAuth } from "./lib/session.js";
import { renderLogin } from "./pages/login.js";
import { renderSetPassword } from "./pages/setPassword.js";
import { mountApp } from "./app.js";
import { teardownData } from "./lib/data.js";

const root = document.getElementById("app");
let lastRenderKey;

// Supabase's invite and password-recovery emails land here with
// #access_token=...&type=invite|recovery in the URL; the client parses
// that into a real session before any of our code runs. Without this
// check that session looks identical to an ordinary signed-in one, and
// render() below would drop the user straight into the app with no
// chance to ever set a password.
let needsPasswordSetup = /type=invite|type=recovery/.test(window.location.hash);

function render() {
  const { session } = getState();
  const userId = session?.user?.id ?? null;
  const key = `${userId}:${needsPasswordSetup}`;
  if (key === lastRenderKey) return; // avoid tearing down the app on unrelated store updates
  lastRenderKey = key;

  if (!session) {
    teardownData();
    renderLogin(root);
  } else if (needsPasswordSetup) {
    renderSetPassword(root, () => {
      needsPasswordSetup = false;
      lastRenderKey = undefined;
      render();
    });
  } else {
    mountApp(root);
  }
}

subscribe(render);

watchAuth(({ event }) => {
  if (event === "PASSWORD_RECOVERY") needsPasswordSetup = true;
});
refreshSession().then(render);
