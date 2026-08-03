// Philippine-time helpers, shared by the attendance report and the payroll
// engine. Extracted so the two can never drift apart — the same reasoning that
// put the leave-credit rules in leaveCredits.js.
//
// Guards punch in PH local time but punches are stored as real UTC moments, so
// every "06:00" in a shift template has to be resolved against UTC+8. Treating
// shift times as UTC previously caused an 8-hour mismatch that pushed every
// punch outside its window and flagged the whole roster Absent.

const PH_OFFSET_MIN = 8 * 60; // UTC+8, no DST in the Philippines
const MS_PER_MIN = 60 * 1000;

// Given a duty date (YYYY-MM-DD) and an HH:MM time, return the epoch
// millisecond value of that PHILIPPINE local moment. For night shifts the end
// time lands on the next calendar day (addDays = 1).
function dateAtTime(dateStr, hhmm, addDays = 0) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  // 06:00 PH == 06:00 UTC minus 8h. Subtract the offset from the UTC construction.
  return Date.UTC(y, mo - 1, d + addDays, h, m) - PH_OFFSET_MIN * MS_PER_MIN;
}

// Convert "HH:MM" to minutes since midnight.
function hhmmToMin(t) {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// The PH calendar date (YYYY-MM-DD) an epoch millisecond value falls on.
function phDateOf(ms) {
  return new Date(ms + PH_OFFSET_MIN * MS_PER_MIN).toISOString().slice(0, 10);
}

// Add whole days to a YYYY-MM-DD string, staying in UTC so DST can never skew it.
function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// Minutes of [startMs, endMs] that fall inside the nightly night-differential
// window, expressed in PH local time. The window wraps midnight (default
// 22:00 -> 06:00 next day), so rather than special-casing the wrap we walk each
// candidate window overlapping the interval and sum the intersections. Starting
// one day early covers a shift that began inside the previous night's window.
//
// nightStartHour/nightEndHour are whole PH-local hours; when they're equal the
// window is empty (not 24h), which keeps a misconfiguration from silently
// paying a differential on every hour worked.
function nightMinutesIn(startMs, endMs, { nightStartHour = 22, nightEndHour = 6 } = {}) {
  if (startMs == null || endMs == null || endMs <= startMs) return 0;
  if (nightStartHour === nightEndHour) return 0;

  const pad = (n) => String(n).padStart(2, "0");
  const startTime = `${pad(nightStartHour)}:00`;
  const endTime = `${pad(nightEndHour)}:00`;
  // Window ends next day only when it wraps midnight (22:00 -> 06:00).
  const wraps = nightEndHour <= nightStartHour;

  let total = 0;
  let day = addDays(phDateOf(startMs), -1);
  const lastDay = addDays(phDateOf(endMs), 1);

  while (day <= lastDay) {
    const winStart = dateAtTime(day, startTime);
    const winEnd = dateAtTime(day, endTime, wraps ? 1 : 0);
    const overlap = Math.min(endMs, winEnd) - Math.max(startMs, winStart);
    if (overlap > 0) total += overlap;
    day = addDays(day, 1);
  }
  return Math.round(total / MS_PER_MIN);
}

module.exports = { PH_OFFSET_MIN, dateAtTime, hhmmToMin, phDateOf, addDays, nightMinutesIn };
