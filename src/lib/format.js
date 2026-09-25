// Formatting and date helpers — ported unchanged from the prototype
// (nasuuti-daily-gp.html) so display behaviour matches exactly.

export function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

export function has(v) {
  return v !== null && v !== undefined && v !== "";
}

export function ugx(n) {
  return Math.round(n).toLocaleString("en-US");
}

export function lit(n) {
  return (Math.round(n * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function sgn(n, f) {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + f(Math.abs(n));
}

export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

export function iso(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

export function addDays(s, n) {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function dmy(s) {
  const [y, m, d] = s.split("-");
  return d + "/" + m + "/" + y;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
}
