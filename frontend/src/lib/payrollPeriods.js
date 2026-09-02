/**
 * Semi-monthly cutoff periods, derived rather than stored.
 *
 * CSOMS runs `periodsPerMonth = 2`: the 1st-15th and the 16th-end of each month.
 * `payroll_periods` rows exist for the payroll module but are deliberately NOT
 * consulted here, so a period is always available to look at — a timesheet or a
 * DTR must render for a cutoff even before payroll has been set up for it.
 *
 * Lifted out of AttendanceRecordModal when the DTR became the third consumer.
 * Two copies of this arithmetic would eventually disagree about where a period
 * boundary falls, and both feed documents that go to a client.
 */

/**
 * The most recent `count` semi-monthly periods, newest first.
 * Each entry is { from, to, label } with dates as 'YYYY-MM-DD' strings.
 */
export function halvesEndingNow(count = 12) {
  const now = new Date();
  // Work in PH time: a period boundary read in the browser's zone would flip a
  // day early or late for anyone outside UTC+8.
  const ph = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  let y = ph.getFullYear(), m = ph.getMonth() + 1;
  let second = ph.getDate() >= 16;
  const out = [];
  for (let i = 0; i < count; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${y}-${String(m).padStart(2, "0")}-${second ? "16" : "01"}`;
    const to = `${y}-${String(m).padStart(2, "0")}-${String(second ? last : 15).padStart(2, "0")}`;
    out.push({ from, to, label: `${from} to ${to}` });
    if (second) second = false;
    else { second = true; m -= 1; if (m === 0) { m = 12; y -= 1; } }
  }
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * "AUGUST 16-31, 2026" — the wording the DTR prints.
 *
 * Formatted from the 'YYYY-MM-DD' STRINGS, never through a Date. Every timezone
 * defect in this system has come from parsing a date into an instant and reading
 * it back somewhere else, and there is nothing here that needs converting.
 */
export function periodTitle({ from, to }) {
  if (!from || !to) return "";
  const [fy, fm, fd] = from.split("-");
  const [ty, tm, td] = to.split("-");
  const month = MONTHS[Number(fm) - 1] || fm;
  if (fy === ty && fm === tm) {
    return `${month.toUpperCase()} ${Number(fd)}-${Number(td)}, ${fy}`;
  }
  const month2 = MONTHS[Number(tm) - 1] || tm;
  return `${month.toUpperCase()} ${Number(fd)}, ${fy} - ${month2.toUpperCase()} ${Number(td)}, ${ty}`;
}
