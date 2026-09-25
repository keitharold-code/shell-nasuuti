// Minimal state store — no framework, so pages subscribe and re-render
// themselves when relevant state changes.

const state = {
  dbReady: false,
  session: null,
  profile: null, // { id, full_name, role, is_active }
  settings: { priceHistory: [], nonFuel: { shop: 0, lpg: 0, lubes: 0 }, tolerance: 0.5 },
  entries: {}, // { [date]: entry }
  dates: [], // sorted ascending
  connectionError: null,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isAdmin() {
  return state.profile?.role === "admin" && state.profile?.is_active;
}

export function canWrite() {
  return (
    state.profile?.is_active &&
    (state.profile?.role === "admin" || state.profile?.role === "entry")
  );
}
