// Shared leave-credit logic. Kept in one place so the authenticated approval
// flow (routes/leave.js) and the public balance lookup (routes/public.js) use
// identical rules and can never drift apart.

// Position titles treated as guard/security -> leave is counted in CALENDAR
// days (weekends included). Everything else (CCTV Operator, admin/office
// staff, blank/unknown) is counted in WORKING days, Mon-Sat, excluding Sunday.
const GUARD_POSITIONS = new Set([
  "Security Guard",
  "Shift Supervisor",
  "Security Officer",
  "Detachment Commander",
]);

function isGuardPosition(position) {
  return GUARD_POSITIONS.has((position || "").trim());
}

// Which credit bucket a leave type draws from. Vacation/Emergency/Bereavement
// all consume the Vacation bucket; Sick consumes Sick. Anything that returns
// null is "always allowed" and never touches credits or gets tagged LWOP
// (Maternity/Paternity, and any unmapped type by default).
function bucketFor(leaveType) {
  const t = (leaveType || "").trim().toLowerCase();
  if (t === "sick leave") return "Sick";
  if (t === "vacation leave" || t === "emergency leave" || t === "bereavement leave") return "Vacation";
  return null; // Maternity/Paternity and anything unmapped: always allowed
}

// Count leave days in an inclusive [from, to] range.
//  - guard/security: every calendar day counts (weekends included)
//  - non-guard: Mon-Sat count, Sunday excluded
// Dates are 'YYYY-MM-DD' strings. Parsed as UTC to avoid timezone drift.
function countLeaveDays(fromDate, toDate, isGuard) {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;

  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0 = Sunday ... 6 = Saturday
    if (isGuard) {
      days += 1;
    } else if (dow !== 0) {
      days += 1; // non-guard: skip Sundays only
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

module.exports = { GUARD_POSITIONS, isGuardPosition, bucketFor, countLeaveDays };
