import { getState, subscribe, isAdmin, isManager, isCashier } from "./lib/store.js";
import { signOut } from "./lib/session.js";
import { initData, teardownData } from "./lib/data.js";
import { renderEntry } from "./pages/entry.js";
import { renderReports } from "./pages/reports.js";
import { renderAdmin } from "./pages/admin.js";
import { renderAudit } from "./pages/audit.js";
import { renderManager } from "./pages/manager.js";
import { renderCashier } from "./pages/cashier.js";
import { renderRecords } from "./pages/records.js";

// Manager/cashier are role-exclusive: the Records workflow is their
// whole job, so they see only their one tab, not Phase 1's admin/entry/
// viewer tabs (which RLS already blocks them from reading anyway —
// this just keeps the nav honest about that rather than showing a tab
// that would load empty).
const TABS = [
  { id: "entry", label: "Daily entry", roles: ["admin", "entry", "viewer"] },
  { id: "reports", label: "Reports", roles: ["admin", "entry", "viewer"] },
  { id: "records", label: "Records", roles: ["admin"] },
  { id: "admin", label: "Admin", roles: ["admin"] },
  { id: "audit", label: "Audit log", roles: ["admin"] },
  { id: "manager", label: "Daily Operations", roles: ["manager"] },
  { id: "cashier", label: "Daily Money", roles: ["cashier"] },
];

function visibleTabs() {
  const role = getState().profile?.role;
  return TABS.filter((t) => t.roles.includes(role));
}

function defaultTabFor() {
  const v = visibleTabs();
  return v[0]?.id || "entry";
}

function currentTab() {
  const h = (location.hash || "").replace("#", "");
  const allowed = visibleTabs();
  return allowed.some((t) => t.id === h) ? h : defaultTabFor();
}

// Phase 1's global data store (daily_entries/price_sets/settings) is
// RLS-closed to manager/cashier (0019) — initData() would just fetch
// nothing useful for them, and the "no prices set" notice below is about
// a Phase 1 concern they have no tab for. Both are skipped for those two
// roles rather than shown wrong or empty.
function usesPhase1Store() {
  return !isManager() && !isCashier();
}

function noticeHtml() {
  const s = getState();
  if (!usesPhase1Store()) {
    return s.profile && !s.profile.is_active
      ? '<div class="notice err">Your account is deactivated. Contact a director.</div>'
      : "";
  }
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
          ${visibleTabs()
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
    if (usesPhase1Store()) initData();
  }
}

function renderTab(root, tab) {
  const content = root.querySelector("#tabContent");
  if (!content) return;
  if (!visibleTabs().some((t) => t.id === tab)) {
    location.hash = "#" + defaultTabFor();
    return;
  }
  syncNavSelection(root, tab);
  if (tab === "entry") renderEntry(content);
  else if (tab === "reports") renderReports(content);
  else if (tab === "admin") renderAdmin(content);
  else if (tab === "audit") renderAudit(content);
  else if (tab === "records") renderRecords(content);
  else if (tab === "manager") renderManager(content);
  else if (tab === "cashier") renderCashier(content);
}

// The yellow active-tab highlight is driven by aria-selected (see
// style.css's nav.tabs button[aria-selected="true"]). A tab click only
// ever fires hashchange -> renderTab(), which swaps #tabContent - it never
// touched the nav buttons, so the highlight only moved on some unrelated
// state change (the subscribe() callback below rebuilding the whole nav).
// Keeping it in sync is cheap, so do it on every renderTab() call instead
// of relying on that to eventually catch up.
function syncNavSelection(root, tab) {
  root.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
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
      visibleTabs()
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
