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

const CANDIDATE_DAYS = 1;   // the punch's PH date, and the day before it

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
    // The date the punch's DUTY is filed under — not the date the punch
    // happened. Null when the guard was not rostered on either day.
    dutyDate: duty ? duty.dutyDate : null,
    duty,
    candidates: rows,
    punchPhDate: phDate,
  };
}

module.exports = { dutyForPunch, pickOwningDuty, phDateOfMs };
