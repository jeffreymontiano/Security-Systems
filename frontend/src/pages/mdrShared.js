// Shared helpers for the Security Reports module (Monthly Disposition Report).
//
// Deliberately contains NO validation and NO verdict about whether a return may
// be filed. Every such judgement comes from src/lib/mdrHelpers.js on the
// server and arrives on the payload as `issues` and `verdict`; this screen
// renders what it is given. Re-deriving any of it here is exactly how a UI
// starts disagreeing with the API about whether a document can be filed.

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Parsed by hand rather than through Date, which would re-read a bare date in
// the browser's timezone and can shift it a day.
const parts = (d) => String(d || "").slice(0, 10).split("-").map(Number);

export function shortDate(iso) {
  const [y, m, d] = parts(iso);
  if (!y || !m || !d) return "—";
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

// "2026-02" -> "February 2026". Mirrors monthPhrases().label on the server.
export function monthLabel(periodMonth) {
  const [y, m] = String(periodMonth || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return "—";
  return `${MONTHS[m - 1]} ${y}`;
}

// Today in PH terms (UTC+8), so a default month reads the same wherever the
// browser is.
export function phToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The month a new return most likely covers: the one just gone. An MDR is
// filed after the month it reports on.
export function defaultPeriodMonth() {
  const t = phToday();
  const [y, m] = parts(t);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function monthOptions(count = 18) {
  const [y0, m0] = parts(phToday());
  const out = [];
  let y = y0;
  let m = m0;
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export function mdrStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Finalised") return "badge-progress";
  if (status === "Submitted") return "badge-resolved";
  return "badge-closed";
}

// A finding's colour. Blocking findings are the ones that stop a filing, so
// they read as the same alarm an open incident does.
export function severityBadgeClass(severity) {
  return severity === "blocking" ? "badge-open" : "badge-progress";
}

// Ranks the source return uses. Free text stays allowed — a post may need a
// wording nobody anticipated — so this feeds a datalist, not a select.
export const RANKS = ["SG", "SO", "LG"];

export const FIREARM_CLASSES = ["Small Arms", "Light Weapons"];

// Only these two statuses can still be edited... which is to say only Draft.
// Kept as a helper so every screen asks the same question the API answers.
export const isEditable = (report) => !!report && report.status === "Draft";
