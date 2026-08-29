/**
 * Which rostered duty does a punch belong to?
 *
 * A punch carries an instant, not a duty date, and the two are NOT the same:
 * a night shift's ~06:00 time-out falls on the FOLLOWING calendar day, and a
 * straight duty's closing punch does too. Anything that answers "what was this
 * guard rostered to do when they punched" by looking up the punch's own PH date
 * asks the wrong day's roster.
 *
 * That is exactly what the site-mismatch stamp used to do, and on a rotation
 * week it produced a FALSE hold: the 06:00 OUT of Monday's night shift was
 * compared against Tuesday's day shift at another post, flagged as a mismatch,
 * and then dropped from the matching index by computeReport — so the duty lost
 * its own time-out and read "No time-out". One wrong date, two symptoms.
 *
 * WHY PROXIMITY, AND NOT "BOTH DAYS"
 * ----------------------------------
 * The obvious repair is to look at the previous day's crossing shifts AS WELL
 * as today's and accept a match against either. That is worse than the bug it
 * fixes. On a rotation week the guard is legitimately rostered at two different
 * posts on consecutive days, so a union accepts a punch at EITHER post — a real
 * wrong-site punch passes silently. It trades a visible false positive for an
 * invisible false negative, and an invisible one is the more expensive kind,
 * because the site is what billing bills.
 *
 * So the punch is resolved to exactly ONE duty and checked against that duty's
 * post alone, by the same rule computeReport's allocator uses: an IN is measured
 * against the scheduled start, an OUT against the scheduled end, nearest wins.
 *
 * Deliberately NOT re-implemented per caller — this bug exists because one site
 * diverged from how the rest of the system reads the roster.
 */

const { dateAtTime } = require("./phTime");

const CANDIDATE_DAYS = 1;   // the punch's PH date, and the day before it

/**
 * Does this assignment carry a SECOND time range? A broken (split) shift is ONE
 * duty worked in two non-contiguous stretches, both on the same row.
 *
 * This and scheduledSegments() below were local to routes/attendance-reports.js
 * and are here because the punch route needs the same answer. Re-deriving them
 * there would be a second implementation of the segment boundaries, which is
 * precisely the class of divergence this file was created to end.
 */
function brokenShift(a) {
  return !!(a && String(a.startTime2 || "").trim() && String(a.endTime2 || "").trim());
}

/**
 * The stretches a duty day is actually worked in, as [startMs, endMs] pairs.
 * One entry for an ordinary shift, two for a broken one.
 */
function scheduledSegments(a) {
  if (!a || !a.startTime || !a.endTime) return [];
  const first = [
    dateAtTime(a.dutyDate, a.startTime),
    dateAtTime(a.dutyDate, a.endTime, a.crossesMidnight ? 1 : 0),
  ];
  if (!brokenShift(a)) return [first];

  // The second range's own day offset: one day on if it wraps past midnight
  // relative to the first, plus another if it ends before it starts.
  const toMin = (t) => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };
  const dayOffset = a.crossesMidnight2 ? 1 : 0;
  const wrapsItself = toMin(a.endTime2) <= toMin(a.startTime2) ? 1 : 0;
  const second = [
    dateAtTime(a.dutyDate, a.startTime2, dayOffset),
    dateAtTime(a.dutyDate, a.endTime2, dayOffset + wrapsItself),
  ];
  return [first, second].sort((x, y) => x[0] - y[0]);
}

/**
 * PURE. Which SEGMENT of a duty does this punch belong to? 1-based.
 *
 * An ordinary shift has one segment and always answers 1. A broken shift has
 * two, and they are a genuine part of one duty: 06:00-12:00 then 00:00-06:00 is
 * TWO legitimate time-ins on one assignment row. A "one IN per duty" rule that
 * ignored this would refuse a guard's second clock-in for work they are rostered
 * to do — so the uniqueness key is (duty, SEGMENT, type), never (duty, type).
 *
 * Measured by the same rule as duty allocation: an IN against the segment's
 * scheduled start, an OUT against its scheduled end, nearest wins, earlier
 * segment on a tie.
 */
function pickSegment(punchAtMs, punchType, duty) {
  const segs = scheduledSegments(duty);
  if (segs.length < 2) return 1;
  const wantStart = punchType === "IN";
  let best = 1, bestDist = Infinity;
  segs.forEach(([sStart, sEnd], i) => {
    const anchor = wantStart ? sStart : sEnd;
    if (anchor == null) return;
    const dist = Math.abs(punchAtMs - anchor);
    if (dist < bestDist) { best = i + 1; bestDist = dist; }
  });
  return best;
}

/**
 * The PH calendar date an instant falls on. PH is UTC+8 with no DST, so a fixed
 * offset is exact — and this never routes through a local-timezone Date, which
 * is where every day-boundary defect in this system has come from.
 */
function phDateOfMs(ms) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The instant a duty's scheduled time falls on, in PH terms. */
function anchorMs(dutyDate, hhmm, addDay) {
  return new Date(`${dutyDate}T${hhmm}:00+08:00`).getTime() + (addDay ? 86400000 : 0);
}

/**
 * PURE. Pick the duty that owns this punch from a candidate list.
 *
 * `candidates` are rows shaped like shift_assignments: { id, dutyDate, site,
 * startTime, endTime, crossesMidnight }. A candidate missing either time cannot
 * be anchored and is skipped rather than guessed at.
 *
 * Tie-breaks are the allocator's, in the same order, so the two can never
 * disagree about the same punch: nearest anchor, then the EARLIER duty, then
 * the lower assignment id. Nothing depends on the order rows came back in.
 *
 * Returns the winning candidate, or null when nothing can be anchored — which
 * is the honest answer for a guard who was not rostered at all, and keeps the
 * long-standing rule that "not rostered is NOT a mismatch".
 */
function pickOwningDuty(punchAtMs, punchType, candidates) {
  const wantStart = punchType === "IN";
  let best = null, bestDist = Infinity, bestAnchor = Infinity;

  for (const c of candidates || []) {
    if (!c || !c.startTime || !c.endTime || !c.dutyDate) continue;
    const start = anchorMs(c.dutyDate, c.startTime, false);
    // An OUT is measured against the scheduled END, which lands on the next
    // calendar day when the shift crosses midnight. This is the whole point.
    const anchor = wantStart ? start : anchorMs(c.dutyDate, c.endTime, !!c.crossesMidnight);
    const dist = Math.abs(punchAtMs - anchor);

    if (best === null || dist < bestDist) {
      best = c; bestDist = dist; bestAnchor = start;
      continue;
    }
    if (dist !== bestDist) continue;
    if (start < bestAnchor || (start === bestAnchor && Number(c.id) < Number(best.id))) {
      best = c; bestAnchor = start;
    }
  }
  return best;
}

/**
 * Load the candidate duties for a punch and resolve it to one.
 *
 * Bounded to TWO days by construction — the punch's own PH date and the day
 * before — because only a duty starting on the previous day can still be
 * running when this punch happens. One query, never a scan.
 *
 * Matched on the normalised guard name, the same key computeReport and the
 * roster join already use, so a stray double space cannot hide a duty.
 */
async function dutyForPunch(pool, guardName, punchAt, punchType) {
  const ms = punchAt instanceof Date ? punchAt.getTime() : new Date(punchAt).getTime();
  if (!Number.isFinite(ms)) return { dutyDate: null, duty: null, candidates: [] };
  const phDate = phDateOfMs(ms);

  const { rows } = await pool.query(
    `SELECT id, site, "shiftName", "startTime", "endTime", "crossesMidnight",
            "startTime2", "endTime2", "crossesMidnight2",
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate"
       FROM shift_assignments
      WHERE "dutyDate" BETWEEN $1::date - ${CANDIDATE_DAYS} AND $1::date
        AND lower(regexp_replace(btrim("guardName"), '\\s+', ' ', 'g'))
          = lower(regexp_replace(btrim($2), '\\s+', ' ', 'g'))
      ORDER BY "dutyDate", id`,
    [phDate, guardName || ""]
  );

  const duty = pickOwningDuty(ms, punchType, rows);
  return {
    // Which stretch of that duty. 1 for every ordinary shift; a broken shift
    // legitimately has two, and they must not collide with each other.
    segment: duty ? pickSegment(ms, punchType, duty) : null,
    // The date the punch's DUTY is filed under — not the date the punch
    // happened. Null when the guard was not rostered on either day.
    dutyDate: duty ? duty.dutyDate : null,
    duty,
    candidates: rows,
    punchPhDate: phDate,
  };
}

module.exports = {
  dutyForPunch, pickOwningDuty, phDateOfMs,
  brokenShift, scheduledSegments, pickSegment,
};
