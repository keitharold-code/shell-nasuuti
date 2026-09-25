import "./style.css";
import { getState, subscribe } from "./lib/store.js";
import { refreshSession, watchAuth } from "./lib/session.js";
import { renderLogin } from "./pages/login.js";
import { mountApp } from "./app.js";
import { teardownData } from "./lib/data.js";

const root = document.getElementById("app");
let lastSessionUserId = undefined;

function render() {
  const { session } = getState();
  const userId = session?.user?.id ?? null;
  if (userId === lastSessionUserId) return; // avoid tearing down the app on unrelated store updates
  lastSessionUserId = userId;

  if (!session) {
    teardownData();
    renderLogin(root);
  } else {
    mountApp(root);
  }
}

subscribe(render);

watchAuth();
refreshSession().then(render);
