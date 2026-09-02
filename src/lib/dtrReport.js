/**
 * The Daily Time Record (DTR) — pure presentation over computeReport()'s rows.
 *
 * The DTR is the per-detachment summary the agency signs and the client
 * countersigns: one page per post, a 16-day cutoff grid, guards as rows, and a
 * right-hand summary of Days / Hours / DS / NS. Nothing here touches the
 * database and nothing here re-derives attendance — every cell comes from a row
 * `computeReport()` already produced, so the DTR can never disagree with the
 * register, the reports or payroll about the same day.
 *
 * TWO BANDS PER GUARD. Each guard occupies two sub-rows, DS above and NS below,
 * exactly as the agency's own approved DTRs lay it out. That is not decoration:
 * it is what lets one guard hold two duties on one date without the cells
 * contending, and it is what makes the DS/NS summary columns readable off the
 * grid rather than computed separately from it.
 *
 * A STRAIGHT DUTY RENDERS BOTH ITS 12s ON ITS START DATE — DS 12 for the
 * 06:00-18:00 half and NS 12 for the 18:00-06:00 half, counting 2.0 days and 24
 * hours. The alternative, carrying the second 12 onto the following date, was
 * built and measured first and is wrong in three ways at once:
 *
 *   - It MANUFACTURES a collision. A tour's night half is 18:00-06:00, and the
 *     duty it lands beside on the next date is typically a night shift, also
 *     18:00-06:00. Two night duties cannot be separated by a day/night split, so
 *     both contend for one band. Measured on the Aug 16-31 2026 production
 *     window: 2 of 2 collisions were same-band, and the loser was silently
 *     dropped — 12 hours understated per collision, on 2 of 9 detachments.
 *   - It MISSTATES the split. The tour's night half is worked on the night the
 *     tour began; counting it against the following date credits it to a night
 *     the guard may have spent elsewhere.
 *   - It creates a CUTOFF-BOUNDARY case with no good answer. A tour beginning on
 *     the last day of a cutoff would carry half of itself into the next DTR, so
 *     neither document states the tour completely.
 *
 * Keeping both 12s on the start date removes all three at once: a tour never
 * touches another date, so contention is impossible rather than merely absorbed,
 * the split is hour-accurate, and no lookback or lookahead window is needed.
 *
 * ZERO-DUTY CODES (DO, A, RTU and the six leave codes) occupy neither band and
 * count toward neither Days nor Hours. They are facts about a day nobody worked.
 *
 * NOTE ON THE MEASUREMENTS ABOVE: they were taken on the Aug 16-31 2026 window
 * BEFORE the agency repaired it in production (missing punches supplied, absent
 * schedules added, wrong sites reassigned, duplicate filings removed). They do
 * not reproduce against today's data -- that window now yields 3 tours and 0
 * collisions. They were real when taken and are why this shape was chosen; the
 * unit suite exercises each path directly so the behaviour stays covered.
 */

const HOURS_PER_DUTY = 12;

/** The legend, in the order the approved DTRs print it. */
const LEGEND = [
  ["12", "12-hour shift (a straight duty shows 12 in each band on its start date)"],
  ["DO", "Rest day"],
  ["A", "Absent"],
  ["RTU", "Return to unit"],
  ["VL", "Vacation leave"],
  ["SL", "Sick leave"],
  ["EL", "Emergency leave"],
  ["PL", "Paternity leave"],
  ["ML", "Maternity leave"],
  ["BL", "Bereavement leave"],
];

/**
 * Leave type -> grid code. Keyed on the Manage Lists values, so a list value
 * renamed there stops resolving and falls back to the raw type rather than
 * silently printing somebody else's code.
 */
const LEAVE_CODES = {
  "Vacation Leave": "VL",
  "Sick Leave": "SL",
  "Emergency Leave": "EL",
  "Paternity Leave": "PL",
  "Maternity Leave": "ML",
  "Bereavement Leave": "BL",
  // Retired in favour of the two codes above, but rows filed under it keep it
  // for ever -- a record must read as it was filed. Rendered under one combined
  // code rather than being guessed into ML or PL.
  "Maternity/Paternity Leave": "M/P",
};

/**
 * A guard on an 18:00 shift routinely clocks in at 17:42-17:52, so an 18:00
 * boundary would read those early arrivals as day shifts. Measured on the
 * production window: 5 of 6 unrostered days were misclassified at 18:00 and
 * classify correctly at 17:00.
 */
const NIGHT_IN_FROM = "17:00";
const NIGHT_IN_BEFORE = "04:00";
const NIGHT_OUT_BEFORE = "12:00";

const pad2 = (n) => String(n).padStart(2, "0");

/** PH (UTC+8) wall-clock HH:MM for an instant. */
function phHourMinute(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const ph = new Date(t.getTime() + 8 * 3600 * 1000);
  return `${pad2(ph.getUTCHours())}:${pad2(ph.getUTCMinutes())}`;
}

/** Every YYYY-MM-DD from `from` to `to` inclusive. Dates are strings throughout. */
function dateRange(from, to) {
  const out = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Sun..Sat for a YYYY-MM-DD, read in UTC so it cannot drift with the server zone. */
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * "AUGUST 16-31, 2026" -- the wording the approved DTRs print.
 *
 * Mirrors periodTitle() in frontend/src/lib/payrollPeriods.js, which the cutoff
 * PICKER needs before any request is made (its option labels are built from
 * halvesEndingNow() client-side). The frontend cannot import from src/, so the
 * two are asserted identical by scripts/attendance/dtr-report.js rather than
 * left to drift -- the same arrangement PENDING_TOTAL_TEXT has.
 *
 * Formatted from the YYYY-MM-DD STRINGS, never through a Date: every timezone
 * defect in this system has come from parsing a date into an instant and
 * reading it back somewhere else, and there is nothing here to convert.
 */
function periodTitle({ from, to }) {
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

/**
 * Which band a worked day belongs to: "DS", "NS", or "STRAIGHT" for a tour that
 * fills both.
 *
 * A rostered duty answers from its own snapshotted `shiftKind`. An UNROSTERED
 * one — a punch on a day with no roster row — carries neither a kind nor
 * scheduled times, so the punch itself decides; that is the only evidence there
 * is, and defaulting such days to DS misfiled 5 of 6 of them in the production
 * window.
 */
function bandOf(row) {
  const kind = row.shiftKind || "";
  if (kind === "Day") return "DS";
  if (kind === "Night") return "NS";
  if (kind === "Straight") return "STRAIGHT";
  // A broken shift is ONE duty day worked in two stretches, so it is one 12 on
  // its start date. Its first stretch decides the band. UNVERIFIED against real
  // data: the production window contained no broken shift.
  if (kind === "Broken") {
    return row.startTime && row.startTime >= NIGHT_IN_FROM ? "NS" : "DS";
  }
  if (row.startTime) {
    return (row.crossesMidnight || row.startTime >= NIGHT_IN_FROM) ? "NS" : "DS";
  }
  const tin = phHourMinute(row.timeIn);
  if (tin) return (tin >= NIGHT_IN_FROM || tin < NIGHT_IN_BEFORE) ? "NS" : "DS";
  const tout = phHourMinute(row.timeOut);
  if (tout) return tout < NIGHT_OUT_BEFORE ? "NS" : "DS";
  return "DS";
}

/** The zero-duty code for a non-worked row, or null when the row was worked. */
function zeroDutyCode(row) {
  const status = String(row.status || "");
  if (status === "Rest Day") return "DO";
  if (status === "RTU") return "RTU";
  if (status === "Absent") return "A";
  if (status === "On Leave") return LEAVE_CODES[row.leaveType] || row.leaveType || "L";
  // A guard on declared relief worked ANOTHER post that day; their hours are
  // counted on that post's DTR. The home post states the fact rather than
  // leaving a blank that reads as an unexplained gap -- and never "A", which
  // would book an absence against a guard who worked.
  if (status.startsWith("On relief")) return "REL";
  // An undeclared site mismatch is held out of billing pending review; the same
  // day must not read as worked here either.
  if (status === "Pending site review") return "SR";
  return null;
}

/**
 * Build the DTR for one window.
 *
 * @param rows      computeReport() rows for exactly this window.
 * @param from,to   YYYY-MM-DD cutoff bounds.
 * @param siteMeta  Map | array of { site, detachmentName, clientName }. A site
 *                  with no entry prints its raw roster name and no client, so a
 *                  DTR always generates -- an attendance document must not
 *                  refuse to print because a BILLING mapping is missing.
 * @param guardSlots minimum guard rows per page (the paper form has 8).
 */
function buildDtr({ rows, from, to, siteMeta, guardSlots = 8 }) {
  const days = dateRange(from, to);
  const meta = siteMeta instanceof Map
    ? siteMeta
    : new Map((siteMeta || []).map((m) => [m.site, m]));

  const bySite = new Map();
  const contention = [];
  const straightTours = [];

  const cellFor = (site, guard, date) => {
    if (!bySite.has(site)) bySite.set(site, new Map());
    const guards = bySite.get(site);
    if (!guards.has(guard)) guards.set(guard, new Map());
    const cells = guards.get(guard);
    if (!cells.has(date)) cells.set(date, { DS: null, NS: null, note: null });
    return cells.get(date);
  };

  const work = (site, guard, date, band, why) => {
    const cell = cellFor(site, guard, date);
    // Recorded, never silently overwritten: a lost duty is understated hours on
    // a document the client countersigns. With tours held on their start date
    // this is not reachable from any shape seen in production, but a rule that
    // drops data must say so if it ever does.
    if (cell[band]) {
      contention.push({ site, guard, date, band, kept: cell[band].why, dropped: why });
      return;
    }
    cell[band] = { code: String(HOURS_PER_DUTY), why };
  };

  for (const row of rows) {
    if (!row || !row.dutyDate) continue;
    if (row.dutyDate < from || row.dutyDate > to) continue;
    const site = row.site || "";
    const guard = row.guardName || "";
    if (!guard) continue;

    if (String(row.status) === "Present") {
      const band = bandOf(row);
      if (band === "STRAIGHT") {
        work(site, guard, row.dutyDate, "DS", "straight duty 06:00-18:00");
        work(site, guard, row.dutyDate, "NS", "straight duty 18:00-06:00");
        straightTours.push({ site, guard, date: row.dutyDate });
      } else {
        work(site, guard, row.dutyDate, band, row.shiftKind || "unrostered");
      }
      continue;
    }
    const code = zeroDutyCode(row);
    if (!code) continue;
    const cell = cellFor(site, guard, row.dutyDate);
    if (!cell.note) cell.note = code;
  }

  const sites = [];
  for (const [site, guards] of [...bySite].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = meta.get(site) || {};
    const perDay = Object.create(null);
    for (const d of days) perDay[d] = 0;
    const totals = { ds: 0, ns: 0, days: 0, hours: 0 };
    const guardRows = [];

    for (const [guard, cells] of [...guards].sort((a, b) => a[0].localeCompare(b[0]))) {
      let ds = 0, ns = 0;
      const grid = days.map((date) => {
        const cell = cells.get(date) || { DS: null, NS: null, note: null };
        if (cell.DS) { ds++; perDay[date] += HOURS_PER_DUTY; }
        if (cell.NS) { ns++; perDay[date] += HOURS_PER_DUTY; }
        return {
          date,
          ds: cell.DS ? cell.DS.code : null,
          ns: cell.NS ? cell.NS.code : null,
          // A zero-duty code belongs to the day, not to a band. It renders in
          // whichever band is free so it is never hidden behind a 12.
          note: cell.note || null,
        };
      });
      const dayCount = ds + ns;
      const hours = dayCount * HOURS_PER_DUTY;
      totals.ds += ds; totals.ns += ns; totals.days += dayCount; totals.hours += hours;
      guardRows.push({ guardName: guard, cells: grid, ds, ns, days: dayCount, hours });
    }

    sites.push({
      site,
      detachmentName: m.detachmentName || site,
      clientName: m.clientName || "",
      mapped: Boolean(m.detachmentName),
      guards: guardRows,
      blankSlots: Math.max(0, guardSlots - guardRows.length),
      perDayHours: days.map((d) => perDay[d]),
      totals,
    });
  }

  return {
    from, to,
    days: days.map((date) => ({ date, day: Number(date.slice(8)), weekday: weekdayOf(date) })),
    sites,
    legend: LEGEND,
    straightTours,
    contention,
  };
}

/**
 * The invariants the printed document must satisfy, returned rather than thrown
 * so a caller can surface them. `Hours = Days x 12` and `Days = DS + NS` are
 * what the agency and the client both foot the page against, and the per-day
 * man-hour row is what a detachment's coverage is read from.
 */
function checkDtr(dtr) {
  const problems = [];
  for (const s of dtr.sites) {
    const t = s.totals;
    if (t.days !== t.ds + t.ns) {
      problems.push(`${s.detachmentName}: Days ${t.days} != DS ${t.ds} + NS ${t.ns}`);
    }
    if (t.hours !== t.days * HOURS_PER_DUTY) {
      problems.push(`${s.detachmentName}: Hours ${t.hours} != Days ${t.days} x ${HOURS_PER_DUTY}`);
    }
    const rowSum = s.perDayHours.reduce((a, b) => a + b, 0);
    if (rowSum !== t.hours) {
      problems.push(`${s.detachmentName}: per-day man-hours ${rowSum} != Hours ${t.hours}`);
    }
    for (const g of s.guards) {
      if (g.days !== g.ds + g.ns || g.hours !== g.days * HOURS_PER_DUTY) {
        problems.push(`${s.detachmentName} / ${g.guardName}: row does not foot`);
      }
    }
  }
  for (const c of dtr.contention) {
    problems.push(`${c.site} / ${c.guard} ${c.date}: two duties in the ${c.band} band — "${c.dropped}" was dropped`);
  }
  return problems;
}

module.exports = {
  HOURS_PER_DUTY, LEGEND, LEAVE_CODES,
  NIGHT_IN_FROM, NIGHT_IN_BEFORE, NIGHT_OUT_BEFORE,
  phHourMinute, dateRange, weekdayOf, periodTitle, bandOf, zeroDutyCode,
  buildDtr, checkDtr,
};
