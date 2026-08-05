// Duty Detail Order logic.
//
// Pure — no database — for the same reason payrollEngine.js, billingEngine.js
// and assetHelpers.js are: several callers need these answers (the orders
// list, the issue check, the PDF) and a legal document cannot have two of them
// disagreeing.

const { phDateOf, addDays } = require("./phTime");

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const iso = (d) => (d ? String(d).slice(0, 10) : "");
const parts = (d) => iso(d).split("-").map(Number);
const today = () => phDateOf(Date.now());

// Next order number for a post: YYYY-MM-NNN, where NNN counts within that
// POST and that month. Two posts therefore both reach 2026-08-001, and a
// re-issue for one post in the same month becomes 2026-08-002 — which is what
// a second order in a month means, since a DDO is valid thirty days and is
// only replaced when the detail changes.
//
// `existing` is every ddoNo already used at this post; the series simply skips
// past anything already taken, so a hand-typed number cannot collide.
function nextDdoNo(orderDate, existingNos = []) {
  const [y, m] = parts(orderDate);
  if (!y || !m) return null;
  const prefix = `${y}-${String(m).padStart(2, "0")}`;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const n of existingNos) {
    const hit = re.exec(String(n || "").trim());
    if (hit) max = Math.max(max, parseInt(hit[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

// "From June 1-30, 2026" — the form's own wording, widening only as far as it
// must when the detail spans a month or a year boundary.
function periodPhrase(from, to) {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (!fy || !ty) return "";
  if (fy === ty && fm === tm) return `From ${MONTHS[fm - 1]} ${fd}-${td}, ${fy}`;
  if (fy === ty) return `From ${MONTHS[fm - 1]} ${fd} to ${MONTHS[tm - 1]} ${td}, ${fy}`;
  return `From ${MONTHS[fm - 1]} ${fd}, ${fy} to ${MONTHS[tm - 1]} ${td}, ${ty}`;
}

// "JUNE 1, 2026" — the date line under the letterhead, upper-cased as printed.
function longDateUpper(d) {
  const [y, m, day] = parts(d);
  if (!y) return "";
  return `${MONTHS[m - 1]} ${day}, ${y}`.toUpperCase();
}

// "0600H-1800H" from roster times. A shift with no times is a worded one —
// the source form carries "BROKEN" for a broken shift — so it passes through.
function militaryShift(startTime, endTime) {
  const pad = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "").trim());
    return m ? `${String(m[1]).padStart(2, "0")}${m[2]}H` : null;
  };
  const a = pad(startTime), b = pad(endTime);
  return a && b ? `${a}-${b}` : "";
}

// Draft / Issued / Expired / Cancelled.
//
// Expired is DERIVED, never stored: an order's validity is a fact about today,
// and an order that quietly went stale in the database is exactly the failure
// this document exists to prevent. Same reasoning as the asset alerts.
function orderState(order, now = null) {
  if (!order) return "Draft";
  if (order.status === "Cancelled") return "Cancelled";
  if (order.status !== "Issued") return "Draft";
  const d = now || today();
  return iso(order.toDate) && iso(order.toDate) < d ? "Expired" : "Issued";
}

// Days until an issued order lapses; negative once it has.
function daysRemaining(order, now = null) {
  const end = iso(order?.toDate);
  if (!end) return null;
  const a = Date.parse(`${now || today()}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Default validity window from an order date, honouring the configured term
// (the form itself says thirty days, renewable).
function defaultWindow(orderDate, validityDays = 30) {
  const from = iso(orderDate);
  if (!from) return { fromDate: "", toDate: "" };
  return { fromDate: from, toDate: addDays(from, Math.max(1, validityDays) - 1) };
}

// Problems that must not reach a printed order.
//
// The source workbook has serial RIA2950961 on both the HAT and the SALUYOT
// sheet. One firearm cannot be at two posts at once, and a DDO saying it is
// would be false on its face — so it is reported rather than reproduced.
function conflicts(lines = [], { otherIssued = [] } = {}) {
  const out = [];
  const norm = (s) => String(s || "").trim().toUpperCase();

  const bySerial = new Map();
  for (const l of lines) {
    const s = norm(l.firearmSerial);
    if (!s) continue;
    if (!bySerial.has(s)) bySerial.set(s, []);
    bySerial.get(s).push(l);
  }
  for (const [serial, group] of bySerial) {
    if (group.length > 1) {
      out.push({
        kind: "duplicate-firearm",
        message: `Firearm ${serial} is listed on ${group.length} lines of this order. One firearm cannot be borne by more than one guard.`,
        lines: group.map((l) => l.id),
      });
    }
  }

  const byGuard = new Map();
  for (const l of lines) {
    const g = norm(l.guardName);
    if (!g) continue;
    if (!byGuard.has(g)) byGuard.set(g, []);
    byGuard.get(g).push(l);
  }
  for (const [guard, group] of byGuard) {
    if (group.length > 1) {
      out.push({
        kind: "duplicate-guard",
        message: `${group[0].guardName} appears on ${group.length} lines of this order.`,
        lines: group.map((l) => l.id),
      });
    }
  }

  // The same firearm already authorised at another post on a live order.
  const mine = new Set(lines.map((l) => norm(l.firearmSerial)).filter(Boolean));
  for (const o of otherIssued) {
    const s = norm(o.firearmSerial);
    if (s && mine.has(s)) {
      out.push({
        kind: "firearm-on-another-order",
        message: `Firearm ${s} is already authorised at ${o.site} on order ${o.ddoNo}.`,
        lines: lines.filter((l) => norm(l.firearmSerial) === s).map((l) => l.id),
      });
    }
  }

  return out;
}

// Rank prefix inferred from an employment position, so a line starts as
// "SG Juan Dela Cruz" without anyone typing it. Editable afterwards — the 201
// File has no rank column, so this is a helpful guess, not a fact.
function rankFor(position) {
  const p = String(position || "").toLowerCase();
  if (p.includes("officer")) return "SO";
  if (p.includes("supervisor")) return "SS";
  if (p.includes("lady")) return "LG";
  return "SG";
}

module.exports = {
  MONTHS,
  nextDdoNo,
  periodPhrase,
  longDateUpper,
  militaryShift,
  orderState,
  daysRemaining,
  defaultWindow,
  conflicts,
  rankFor,
};
