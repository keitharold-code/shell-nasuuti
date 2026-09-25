import { getState, subscribe, isAdmin } from "./lib/store.js";
import { signOut } from "./lib/session.js";
import { initData, teardownData } from "./lib/data.js";
import { renderEntry } from "./pages/entry.js";
import { renderReports } from "./pages/reports.js";
import { renderAdmin } from "./pages/admin.js";
import { renderAudit } from "./pages/audit.js";

const TABS = [
  { id: "entry", label: "Daily entry" },
  { id: "reports", label: "Reports" },
  { id: "admin", label: "Admin", adminOnly: true },
  { id: "audit", label: "Audit log", adminOnly: true },
];

function currentTab() {
  const h = (location.hash || "#entry").replace("#", "");
  return TABS.some((t) => t.id === h) ? h : "entry";
}

function noticeHtml() {
  const s = getState();
  let h = "";
  if (!s.dbReady && !s.connectionError) {
    h += '<div class="notice">Connecting to station records…</div>';
  }
  if (s.connectionError) {
    h += `<div class="notice err">Couldn't reach station records: ${s.connectionError}</div>`;
  }
  if (s.dbReady && !(s.settings.priceHistory || []).length) {
    h += `<div class="notice warn">${
      isAdmin()
        ? "Set fuel prices and margins in Admin before recording sales."
        : "Fuel prices haven't been set yet. Ask a director to set them in Admin."
    }</div>`;
  }
  if (s.profile && !s.profile.is_active) {
    h += '<div class="notice err">Your account is deactivated. Contact a director.</div>';
  } else if (s.profile && s.profile.role === "viewer") {
    h += '<div class="notice">You have view-only access.</div>';
  }
  return h;
}

let mounted = false;

export function mountApp(root) {
  const s = getState();
  const tab = currentTab();

  root.innerHTML = `
    <header class="bar">
      <div class="bar-in">
        <div class="brand">
          <h1>Shell Nasuuti · Daily sales &amp; gross profit</h1>
          <p class="who">${s.profile ? s.profile.full_name + " · " + s.profile.role : ""}</p>
        </div>
        <nav class="tabs" role="tablist">
          ${TABS.filter((t) => !t.adminOnly || isAdmin())
            .map(
              (t) =>
                `<button role="tab" aria-selected="${t.id === tab}" data-tab="${t.id}">${t.label}</button>`
            )
            .join("")}
          <button class="signout" data-signout="1">Sign out</button>
        </nav>
      </div>
    </header>
    <main>
      <div id="globalNotice">${noticeHtml()}</div>
      <div id="tabContent"></div>
    </main>
  `;

  root.querySelectorAll("nav.tabs button[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = "#" + b.dataset.tab;
    })
  );
  root.querySelector("[data-signout]").addEventListener("click", async () => {
    teardownData();
    await signOut();
  });

  renderTab(root, tab);

  if (!mounted) {
    mounted = true;
    window.addEventListener("hashchange", () => renderTab(root, currentTab()));
    initData();
  }
}

function renderTab(root, tab) {
  const content = root.querySelector("#tabContent");
  if (!content) return;
  if (tab === "admin" && !isAdmin()) {
    location.hash = "#entry";
    return;
  }
  if (tab === "audit" && !isAdmin()) {
    location.hash = "#entry";
    return;
  }
  if (tab === "entry") renderEntry(content);
  else if (tab === "reports") renderReports(content);
  else if (tab === "admin") renderAdmin(content);
  else if (tab === "audit") renderAudit(content);
}

subscribe(() => {
  const root = document.getElementById("app");
  if (!root || !root.querySelector("header.bar")) return; // not mounted yet
  const notice = root.querySelector("#globalNotice");
  if (notice) notice.innerHTML = noticeHtml();
  const who = root.querySelector(".brand .who");
  const s = getState();
  if (who) who.textContent = s.profile ? s.profile.full_name + " · " + s.profile.role : "";
  const nav = root.querySelector("nav.tabs");
  if (nav) {
    const tab = currentTab();
    nav.innerHTML =
      TABS.filter((t) => !t.adminOnly || isAdmin())
        .map((t) => `<button role="tab" aria-selected="${t.id === tab}" data-tab="${t.id}">${t.label}</button>`)
        .join("") + '<button class="signout" data-signout="1">Sign out</button>';
    nav.querySelectorAll("button[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        location.hash = "#" + b.dataset.tab;
      })
    );
    nav.querySelector("[data-signout]").addEventListener("click", async () => {
      teardownData();
      await signOut();
    });
  }
  // Re-render the active tab so it picks up fresh entries/settings.
  renderTab(root, currentTab());
});
