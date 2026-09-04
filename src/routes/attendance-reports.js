const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { dateAtTime, phDateOf, addDays: phAddDays } = require("../lib/phTime");
// brokenShift/scheduledSegments used to be defined here. They moved to the lib
// so the PUBLIC PUNCH ROUTE can key its duplicate rule on the same segment
// boundaries this report pays against: two copies of that arithmetic could
// disagree about which stretch a punch belongs to, which is the exact class of
// defect dutyForPunch.js was created to end.
const { brokenShift, scheduledSegments } = require("../lib/dutyForPunch");
const { buildDtr, checkDtr, periodTitle } = require("../lib/dtrReport");
const { ATTENDANCE_EDIT_ROLES } = require("../lib/permissions");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler — the
// request hangs with no response rather than erroring. Used by the routes added
// since; the older ones predate it.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[attendance-reports] ${req.method} ${req.originalUrl} failed:`, e);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Is this roster row a continuous 24-hour straight duty?
//
// The assignment states its kind (snapshotted from the template), which is the
// answer whenever it is present. The length fallback only matters for rows
// written before that column existed and not yet backfilled — a night shift
// and a straight duty both cross midnight, so the flag alone cannot tell them
// apart, but a 20-hour-or-longer span can.
//
// Mirrors shiftKindOf() in frontend/src/pages/SchedulingPage.jsx.
function straightDuty(a) {
  if (!a) return false;
  if (a.shiftKind) return a.shiftKind === "Straight";
  const toMin = (t) => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };
  const s = toMin(a.startTime), e = toMin(a.endTime);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e + (a.crossesMidnight ? 1440 : 0) - s >= 1200;
}

// A BROKEN (split) shift: one duty day worked in two non-contiguous stretches,
// e.g. 06:00-12:00 and then 00:00-06:00 the next morning. Identified by the
// presence of a second range, which is the only thing that distinguishes it.
// Shared computation used by both the JSON report and the PDF export.
async function computeReport({ from, to, site, guard, grace, otThreshold }) {
  const asnClauses = [`"dutyDate" >= $1`, `"dutyDate" <= $2`];
  const asnVals = [from, to];
  if (site) { asnVals.push(site); asnClauses.push(`site = $${asnVals.length}`); }
  const assignments = (await pool.query(
    `SELECT id, "employeeId", "guardName", site, "shiftName", "shiftKind",
            "startTime", "endTime", "crossesMidnight",
            "startTime2", "endTime2", "crossesMidnight2",
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate"
     FROM shift_assignments WHERE ${asnClauses.join(" AND ")}
     ORDER BY "dutyDate", site, "guardName"`, asnVals
  )).rows;

  // "AT TIME ZONE 'Asia/Manila'" is mandatory here. A timestamptz cast with a
  // bare ::date renders in the SESSION timezone, which is UTC on the server —
  // so a 06:00 PH punch (22:00 UTC the day before) landed on the PREVIOUS
  // calendar date and fell outside the window whenever it was the first day of
  // the range. Every morning punch on the first day of a payroll period was
  // therefore dropped, and the day read Absent. Night shifts were unaffected,
  // which is why it went unnoticed.
  const punches = (await pool.query(
    `SELECT id, "guardName", site, "punchType", "punchAt", "siteMismatch", "rosteredSite",
            "reliefDeclared"
     FROM attendance_records
     WHERE "deletedAt" IS NULL
       AND ("punchAt" AT TIME ZONE 'Asia/Manila')::date >= $1::date
       AND ("punchAt" AT TIME ZONE 'Asia/Manila')::date <= ($2::date + INTERVAL '1 day')
     ORDER BY "punchAt"`,
    [from, to]
  )).rows;

  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const punchIndex = new Map();
  // Punches whose chosen site disagrees with the roster, keyed guard|date.
  //
  // These are kept OUT of the matching index on purpose. Matching is by
  // guardName|site, so such a punch could never match its guard's rostered row
  // anyway — but leaving it in the index would let it match a DIFFERENT roster
  // row at the site punched, and quietly mark that post manned by someone who
  // was rostered elsewhere. The day is instead surfaced as "Pending site
  // review" on the rostered row below, and billing holds it out entirely.
  const mismatchedDays = new Map();   // "guard|date" -> punched site  (UNDECLARED)
  const reliefDays = new Map();       // "guard|date" -> punched site  (DECLARED)
  const phDate = (ms) =>
    new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);   // PH is UTC+8, no DST

  for (const p of punches) {
    const at = new Date(p.punchAt).getTime();
    // A DECLARED relief punch is a mismatch the guard owned at submission, so
    // it is NOT dropped: it stays in the index and pairs normally at the site
    // it names, which is where the hours were worked and where billing bills
    // them. Only the rostered post's own row is reclassified below, so the two
    // facts are both told -- somebody worked here, nobody worked there.
    if (p.siteMismatch === true && p.reliefDeclared === true) {
      reliefDays.set(`${norm(p.guardName)}|${phDate(at)}`, p.site || "");
    } else if (p.siteMismatch === true) {
      mismatchedDays.set(`${norm(p.guardName)}|${phDate(at)}`, p.site || "");
      continue;
    }
    const key = `${norm(p.guardName)}|${norm(p.site)}`;
    if (!punchIndex.has(key)) punchIndex.set(key, []);
    punchIndex.get(key).push({ id: p.id, type: p.punchType, at, guardName: p.guardName, site: p.site });
  }

  // Approved leave overlapping the report window. Used to reclassify a
  // scheduled-but-no-punch day as "On Leave" instead of "Absent" — this is the
  // link the leave_records schema was designed for. We match leave to a guard
  // by employee full name (normalized), since attendance is keyed by name while
  // leave is linked by employeeId. "employeeName" is stored on each leave row.
  const leaves = (await pool.query(
    `SELECT lr."employeeName", lr."leaveType",
            to_char(lr."fromDate", 'YYYY-MM-DD') AS "fromDate",
            to_char(lr."toDate", 'YYYY-MM-DD') AS "toDate"
     FROM leave_records lr
     WHERE lr.status = 'Approved'
       AND lr."toDate" >= $1::date AND lr."fromDate" <= $2::date`,
    [from, to]
  )).rows;
  // Index leaves by normalized employee name -> list of {from, to, type}.
  const leaveIndex = new Map();
  for (const lv of leaves) {
    const key = norm(lv.employeeName);
    if (!leaveIndex.has(key)) leaveIndex.set(key, []);
    leaveIndex.get(key).push({ from: lv.fromDate, to: lv.toDate, type: lv.leaveType });
  }
  // Returns the leave type if the guard has an approved leave covering dutyDate,
  // else null. String compare works because dates are zero-padded YYYY-MM-DD.
  function leaveOn(guardName, dutyDate) {
    const list = leaveIndex.get(norm(guardName));
    if (!list) return null;
    const hit = list.find((lv) => lv.from <= dutyDate && dutyDate <= lv.to);
    return hit ? hit.type : null;
  }

  // Explicit rest days overlapping the window, keyed by normalized guard name +
  // date, so a scheduled-but-no-punch day marked as a rest day reads "Rest Day"
  // rather than "Absent".
  const restRows = (await pool.query(
    `SELECT "employeeId", "guardName", site,
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate"
     FROM rest_days
     WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date
     ${site ? "AND site = $3" : ""}`,
    site ? [from, to, site] : [from, to]
  )).rows;
  const restSet = new Set(restRows.map((r) => `${norm(r.guardName)}|${r.dutyDate}`));
  function isRestDay(guardName, dutyDate) {
    return restSet.has(`${norm(guardName)}|${dutyDate}`);
  }

  // RETURN TO UNIT is no longer read here.
  //
  // It used to come from `rtu_records`, written by a DTR double-click, and this
  // engine turned it into a status the register, payroll and the DTR all read.
  // Disciplinary Stage C makes `disciplinary_cases` the single source of RTU
  // (and of Suspension and Termination), and the DTR applies all three itself
  // in `buildDtr` -- a client-facing PRESENTATION policy that must not reach
  // payroll, which is why it lives there and not in this shared ladder. So this
  // engine no longer emits an "RTU" status: a withdrawn guard's no-punch day
  // reads "Absent" here (same zero pay it always had), and the DTR overlays the
  // penalty on top. `summary.rtu` therefore stays 0; the DTR counts its own.

  // Approved Missing Time Log corrections, keyed by guard + duty date. An admin
  // approving one is an explicit statement that the guard worked that day, so
  // it is bound to the DUTY DATE it was filed for rather than re-matched by the
  // +/-2h punch window below. Previously an approved correction whose times fell
  // outside that window (e.g. a night shift corrected with day-shift times) was
  // silently ignored and the day still read "Absent".
  const correctionRows = (await pool.query(
    `SELECT "guardName", to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            "approvedInAt", "approvedOutAt"
     FROM missing_timelog_requests
     WHERE status = 'Approved' AND "dutyDate" >= $1::date AND "dutyDate" <= $2::date`,
    [from, to]
  )).rows;
  const correctionIndex = new Map(
    correctionRows.map((c) => [`${norm(c.guardName)}|${c.dutyDate}`, c])
  );
  function correctionFor(guardName, dutyDate) {
    return correctionIndex.get(`${norm(guardName)}|${dutyDate}`) || null;
  }

  const rows = [];
  const summary = { total: 0, present: 0, absent: 0, onLeave: 0, restDay: 0, late: 0, undertime: 0, overtime: 0,
    // Relief days are WORKED days recorded against another post. Counted here
    // so summary.total still equals the sum of its status buckets; a status
    // with no counter silently shrinks every rate derived from them.
    onRelief: 0,
    // Days whose punch names a site the guard is not rostered at. Counted
    // separately from `absent` on purpose: they are not absences, they are
    // days nobody can bill yet, and burying them in the absent figure would
    // both overstate absences and hide the thing needing action.
    siteReview: 0,
    // Return-to-unit days. Its own bucket for the same reason onRelief has one:
    // a status counted nowhere shrinks every rate derived from these counters,
    // and RTU days were previously reported as absences.
    rtu: 0 };

  // A 24-hour tour touches TWO calendar dates, and a roster commonly carries an
  // entry on both — 06:00 Mon->06:00 Tue, then another dated Tue. Processed
  // independently that produced two records for one tour, and the second was
  // worse than redundant: its own +/-2h window caught the tour's CLOSING punch
  // but no opening one, so it reported the guard "Absent" on a day they had in
  // fact worked, while still displaying a time-out. A false absence feeds
  // absence monitoring and the billing LESS deduction, so this is not cosmetic.
  //
  // The second entry is recognised by the only thing that identifies it: it is a
  // straight duty for the same guard at the same post that begins EXACTLY where
  // the previous day's straight duty ended. Two genuinely separate tours cannot
  // be told apart from one entered twice — but that would be a continuous
  // 48-hour duty, which is not a thing. Suppressed rather than merged: the first
  // entry already spans the whole tour and needs nothing from the second.
  const contKey = (g, s) => `${norm(g)}|${norm(s)}`;
  const tours = new Map();
  for (const a of assignments) {
    if (!straightDuty(a) || !a.startTime || !a.endTime) continue;
    const k = contKey(a.guardName, a.site);
    if (!tours.has(k)) tours.set(k, []);
    tours.get(k).push({
      startMs: dateAtTime(a.dutyDate, a.startTime),
      endMs: dateAtTime(a.dutyDate, a.endTime, a.crossesMidnight ? 1 : 0),
    });
  }
  const continuationIds = new Set();
  for (const a of assignments) {
    if (!straightDuty(a) || !a.startTime || !a.endTime) continue;
    const startMs = dateAtTime(a.dutyDate, a.startTime);
    const prior = tours.get(contKey(a.guardName, a.site)) || [];
    // Strictly earlier tour that finishes exactly as this entry begins.
    if (prior.some((t) => t.startMs < startMs && t.endMs === startMs)) {
      continuationIds.add(a.id);
    }
  }

  // ---------------------------------------------------------------------
  // PUNCH ALLOCATION: a punch belongs to exactly ONE duty.
  //
  // Each duty used to scan the punch stream through its own window with nothing
  // marking a punch as consumed, so two duties whose windows overlap both
  // claimed it. A night shift closing at 06:08 and a straight duty opening at
  // 06:11 is the case that surfaced it: the straight duty's window (start-2h to
  // end+6h) reached back over the night shift's closing punch, so the row read
  // IN 06:11 / OUT 06:08 and booked the difference as 1432 minutes of
  // undertime — which payrollEngine deducts as (late + undertime) x minuteRate,
  // roughly three days' pay off a guard who had worked the shift.
  //
  // A contested punch goes to the duty whose own schedule is NEAREST it: an IN
  // is measured against the scheduled start, an OUT against the scheduled end.
  // That is what "whose punch is this" actually asks. Ties go to the duty with
  // the earlier start, then to the lower assignment id, so the answer never
  // depends on the order rows came back in.
  //
  // AGGREGATION WITHIN A DUTY IS UNCHANGED — still the earliest IN and the
  // latest OUT of the punches allocated to it. Proximity ARBITRATES, it does
  // not replace: a guard who double-punches one duty reads exactly as before,
  // and only genuinely contested punches move. That keeps the behaviour change
  // confined to the overlap cases this exists to fix.
  // ---------------------------------------------------------------------
  const geom = new Map();
  const duties = [];
  for (const a of assignments) {
    if (continuationIds.has(a.id)) continue;
    const hasTimes = a.startTime && a.endTime;
    const startMs = hasTimes ? dateAtTime(a.dutyDate, a.startTime) : null;
    const endMs = hasTimes ? dateAtTime(a.dutyDate, a.endTime, a.crossesMidnight ? 1 : 0) : null;
    const pad = 2 * 60 * 60 * 1000;
    // A straight duty gets a longer TRAILING window. With the same 2h pad, a
    // tour that ran even 2h01 past its end had its closing punch fall outside
    // the window and be discarded — and the damage was not just a missing
    // time-out: built-in OT requires an OUT, so the guard silently lost all 8
    // hours of it as well, and excess OT could never be measured at all. The
    // leading edge stays at 2h; only the tail is widened. It can no longer
    // steal the previous tour's closing punch, because that punch sits nearer
    // the previous tour's own end and is allocated there.
    const tailPad = straightDuty(a) ? 6 * 60 * 60 * 1000 : pad;
    const winStart = startMs != null ? startMs - pad : null;
    // A broken shift's day ends with its LAST segment, not its first range, so
    // the window has to reach that far or the evening stretch falls outside it.
    const segs = brokenShift(a) ? scheduledSegments(a) : null;
    const lastScheduledEnd = segs && segs.length
      ? (segs.slice(-1)[0] || [null, endMs])[1]
      : endMs;
    const winEnd = lastScheduledEnd != null ? lastScheduledEnd + tailPad : null;
    // Pads never reach more than halfway into a gap, so a late punch-out from
    // the morning cannot be claimed as the evening's punch-in.
    const gap = segs && segs.length > 1 ? Math.max(0, segs[1][0] - segs[0][1]) : 0;
    const segPad = Math.min(pad, gap > 0 ? gap / 2 : pad);
    const g = {
      a, key: `${norm(a.guardName)}|${norm(a.site)}`,
      startMs, endMs, winStart, winEnd, lastScheduledEnd, segs, segPad,
      punches: [],
    };
    geom.set(a.id, g);
    duties.push(g);
  }

  // The anchors a punch of each type is measured against. A broken shift is
  // matched per SEGMENT, so every segment edge is an anchor and the nearest one
  // decides; anything else has the one scheduled start and end.
  function anchorsFor(g, type) {
    if (g.segs && g.segs.length) return g.segs.map((s) => (type === "IN" ? s[0] : s[1]));
    return [type === "IN" ? g.startMs : g.lastScheduledEnd];
  }
  function anchorDistance(g, p) {
    let best = Infinity;
    for (const t of anchorsFor(g, p.type)) {
      if (t == null) continue;
      const d = Math.abs(p.at - t);
      if (d < best) best = d;
    }
    return best;
  }

  const dutiesByKey = new Map();
  for (const g of duties) {
    if (!dutiesByKey.has(g.key)) dutiesByKey.set(g.key, []);
    dutiesByKey.get(g.key).push(g);
  }
  for (const [pkey, list] of dutiesByKey) {
    for (const p of punchIndex.get(pkey) || []) {
      let winner = null, bestDist = Infinity;
      for (const g of list) {
        // Outside the duty's window it was never a candidate, exactly as before.
        if (g.winStart == null || p.at < g.winStart || p.at > g.winEnd) continue;
        const d = anchorDistance(g, p);
        if (d === Infinity) continue;
        if (winner === null || d < bestDist) { winner = g; bestDist = d; continue; }
        if (d !== bestDist) continue;
        // Deterministic tie-breaks: the earlier duty, then the lower id.
        const ws = winner.startMs == null ? Infinity : winner.startMs;
        const gs = g.startMs == null ? Infinity : g.startMs;
        if (gs < ws || (gs === ws && g.a.id < winner.a.id)) winner = g;
      }
      if (winner) winner.punches.push(p);
    }
  }

  for (const a of assignments) {
    if (continuationIds.has(a.id)) continue;
    summary.total++;
    const g = geom.get(a.id);
    const { startMs, endMs, segs, segPad } = g;
    // Only the punches allocated to THIS duty. One a neighbouring duty won is
    // not visible here, which is the whole point of the pass above.
    const ownPunches = g.punches;

    let firstIn = null, lastOut = null;
    // The attendance_records rows that produced this line. A day row is DERIVED
    // (roster x date), so it cannot itself be deleted — but the punches behind
    // it can, which is what a correction actually means. Empty on an Absent day:
    // there is no record, only a roster entry saying someone was due.
    const punchIds = [];
    for (const p of ownPunches) {
      punchIds.push(p.id);
      if (p.type === "IN" && (firstIn == null || p.at < firstIn)) firstIn = p.at;
      if (p.type === "OUT" && (lastOut == null || p.at > lastOut)) lastOut = p.at;
    }

    // A broken shift is matched per SEGMENT. Taking the earliest IN and the
    // latest OUT across the whole day would swallow the off-duty gap — for
    // 06:00-12:00 plus 00:00-06:00 that reads as 24 hours worked instead of 12,
    // and would pay both the gap's regular hours and its night differential.
    let workedSegments = null;
    if (segs && segs.length) {
      workedSegments = segs.map(([sStart, sEnd]) => {
        let sIn = null, sOut = null;
        for (const p of ownPunches) {
          if (p.at < sStart - segPad || p.at > sEnd + segPad) continue;
          if (p.type === "IN" && (sIn == null || p.at < sIn)) sIn = p.at;
          if (p.type === "OUT" && (sOut == null || p.at > sOut)) sOut = p.at;
        }
        return { scheduled: [sStart, sEnd], in: sIn, out: sOut };
      });
      // The row still reports the day's true bounds.
      const ins = workedSegments.map((w) => w.in).filter((x) => x != null);
      const outs = workedSegments.map((w) => w.out).filter((x) => x != null);
      firstIn = ins.length ? Math.min(...ins) : null;
      lastOut = outs.length ? Math.max(...outs) : null;
    }

    // Fall back to an approved correction for whichever side the window didn't
    // find. Bound to the duty date, so a correction is honoured even when its
    // times sit outside the punch window.
    const correction = correctionFor(a.guardName, a.dutyDate);
    let wasCorrected = false;
    if (correction) {
      if (firstIn == null && correction.approvedInAt) {
        firstIn = new Date(correction.approvedInAt).getTime();
        wasCorrected = true;
      }
      if (lastOut == null && correction.approvedOutAt) {
        lastOut = new Date(correction.approvedOutAt).getTime();
        wasCorrected = true;
      }
    }

    // A time-out cannot precede its own time-in. When it does, the punch belongs
    // to a DIFFERENT duty and this row merely reached far enough to catch it.
    //
    // Exclusive allocation above is the CURE — a punch is now won by one duty
    // and invisible to the rest, so the overlap that produced this state cannot
    // recur through the punch stream. This stays as the BACKSTOP, because two
    // sources still reach the row after allocation: an approved Missing Time Log
    // correction is bound to the DUTY DATE rather than the punch window, so a
    // correction filed with the wrong times can supply an OUT that precedes the
    // punched IN, and a correction can be approved on one side only.
    //
    // Discarding the impossible time-out drops the row into the "No time-out"
    // path below, which is the truthful state: the duty has an opening punch and
    // no closing one. It is then held out of billing and picked up by Absence
    // Monitoring like any other, and a corrected request settles it.
    //
    // It costs nothing and makes the impossible state unrepresentable, so it is
    // kept even though the punch-side path to it is closed.
    if (firstIn != null && lastOut != null && lastOut < firstIn) {
      lastOut = null;
    }

    const rec = {
      // The punch records behind this row, so a correction can remove them.
      // Never an identifier for the ROW itself — the row is derived and comes
      // back on the next run regardless, as an Absent day.
      punchIds,
      dutyDate: a.dutyDate, guardName: a.guardName, site: a.site, employeeId: a.employeeId,
      shiftName: a.shiftName, startTime: a.startTime, endTime: a.endTime,
      crossesMidnight: a.crossesMidnight,
      // Stated on the row so a consumer does not have to re-derive it. Falls
      // back for assignments written before the column existed: a second range
      // can only be a broken shift, and the straight-duty test is the same one
      // the built-in OT split uses.
      shiftKind: a.shiftKind || (brokenShift(a) ? "Broken" : straightDuty(a) ? "Straight" : ""),
      startTime2: a.startTime2 || null,
      endTime2: a.endTime2 || null,
      crossesMidnight2: !!a.crossesMidnight2,
      // Surfaced on every row (not just unpunched ones) because a guard who
      // actually WORKS a marked rest day still reads status "Present" below —
      // without this the rest-day fact is lost to downstream consumers.
      isRestDay: isRestDay(a.guardName, a.dutyDate),
      timeIn: firstIn ? new Date(firstIn).toISOString() : null,
      timeOut: lastOut ? new Date(lastOut).toISOString() : null,
      wasCorrected,
      status: "Present", lateMin: 0, undertimeMin: 0, overtimeMin: 0, builtinOtMin: 0, flags: [],
      // How many regular shifts this duty day represents. 1 for a day or night
      // shift; 2 for a straight duty, which is a continuous 24-hour tour worked
      // as two consecutive shifts. Drives both the built-in OT split below and
      // the base pay in payrollEngine, so the two columns cannot describe the
      // same 24 hours differently.
      shiftUnits: straightDuty(a) ? 2 : 1,
    };
    if (wasCorrected) rec.flags.push("Corrected");

    // The guard punched that day, but named a site they are not rostered at.
    //
    // Checked BEFORE Absent, because that is exactly what this would otherwise
    // read as: the punch went to another site's key and matched nothing here,
    // so the post looks unmanned when in fact somebody worked. Calling it
    // Absent would bill the client a LESS and raise an absence follow-up
    // against a guard who was on duty.
    // DECLARED relief, checked before the undeclared case and before Absent.
    // The guard is elsewhere by arrangement, so this post is genuinely unmanned
    // -- billing sees that through the punches, which is correct -- but the
    // GUARD is not absent, and must not be fed to absence monitoring (which
    // filters on status === "Absent") or to disciplinary follow-up.
    const onReliefAt = reliefDays.get(`${norm(a.guardName)}|${a.dutyDate}`);
    if (firstIn == null && onReliefAt !== undefined) {
      rec.status = `On relief at ${onReliefAt}`;
      rec.reliefDeclared = true;
      rec.punchedSite = onReliefAt;
      rec.flags.push("On relief");
      summary.onRelief++;
    } else if (firstIn == null && (mismatchedDays.get(`${norm(a.guardName)}|${a.dutyDate}`) !== undefined)) {
      const punchedElsewhere = mismatchedDays.get(`${norm(a.guardName)}|${a.dutyDate}`);
      rec.status = "Pending site review";
      rec.siteReviewPending = true;
      rec.punchedSite = punchedElsewhere;
      rec.flags.push("Site mismatch");
      summary.siteReview++;
    } else if (firstIn == null) {
      // No punch on a scheduled day. Check legitimate reasons before Absent:
      // approved leave first, then an explicit rest day.
      const leaveType = leaveOn(a.guardName, a.dutyDate);
      if (leaveType) {
        rec.status = "On Leave";
        rec.leaveType = leaveType;
        rec.flags.push("On Leave");
        summary.onLeave++;
      } else if (isRestDay(a.guardName, a.dutyDate)) {
        rec.status = "Rest Day";
        rec.flags.push("Rest Day");
        summary.restDay++;
      } else {
        rec.status = "Absent"; rec.flags.push("Absent"); summary.absent++;
      }
    } else {
      summary.present++;
      if (startMs != null) {
        const lateBy = Math.round((firstIn - startMs) / 60000);
        if (lateBy > grace) { rec.lateMin = lateBy; rec.flags.push("Late"); summary.late++; }
      }

      // Determine shift completion first — built-in OT depends on it.
      let isUndertime = false, hasTimeOut = lastOut != null;

      // A broken shift is settled entirely here and skips the contiguous
      // arithmetic below, because none of it holds when there is a gap: elapsed
      // time is not time worked, and the 8-hour mark falls at a point in the
      // SECOND stretch rather than eight hours after the start.
      //
      // For 06:00-12:00 plus 00:00-06:00 — twelve hours of duty — the eighth
      // hour is reached two hours into the second stretch, at 02:00, so
      // 02:00-06:00 is built-in OT. That is arithmetic, not a special case, and
      // it lands wholly inside the 22:00-06:00 window so night differential
      // applies to it in payrollEngine.
      if (workedSegments) {
        const scheduledMin = workedSegments
          .reduce((n, w) => n + Math.round((w.scheduled[1] - w.scheduled[0]) / 60000), 0);
        const worked = workedSegments.filter((w) => w.in != null && w.out != null && w.out > w.in);
        const workedMin = worked.reduce((n, w) => n + Math.round((w.out - w.in) / 60000), 0);

        // Handed to payrollEngine so night differential and the regular/OT split
        // skip the gap. Without it the off-duty hours would be paid.
        rec.workedIntervals = worked.map((w) => [
          new Date(w.in).toISOString(), new Date(w.out).toISOString(),
        ]);
        rec.workedMinutes = workedMin;
        rec.scheduledMinutes = scheduledMin;

        const scheduledBuiltin = Math.max(0, scheduledMin - 8 * 60);
        rec.builtinOtMin = Math.max(0, Math.min(workedMin - 8 * 60, scheduledBuiltin));

        // Short of the rostered hours is undertime, whichever stretch was cut.
        const shortBy = scheduledMin - workedMin;
        if (worked.length < workedSegments.length || shortBy > 0) {
          if (shortBy > 0) {
            rec.undertimeMin = shortBy;
            rec.flags.push("Undertime");
            isUndertime = true;
            summary.undertime++;
          }
        }
        if (lastOut == null) rec.flags.push("No time-out");

        // Excess OT is time past the LAST stretch's rostered end — the split
        // itself never creates it.
        const lastEnd = workedSegments[workedSegments.length - 1].scheduled[1];
        if (lastOut != null) {
          const past = Math.round((lastOut - lastEnd) / 60000);
          if (past >= otThreshold) rec.overtimeMin = past;
        }

        rec.totalOtMin = (rec.builtinOtMin || 0) + (rec.overtimeMin || 0);
        if (rec.totalOtMin > 0) { rec.flags.push("Overtime"); summary.overtime++; }
        rows.push(rec);
        continue;
      }

      if (endMs != null && lastOut != null) {
        // Excess OT = time worked PAST the scheduled shift end, beyond the
        // threshold. This is the portion that needs approval.
        const diff = Math.round((lastOut - endMs) / 60000);
        if (diff < 0) { rec.undertimeMin = Math.abs(diff); rec.flags.push("Undertime"); isUndertime = true; summary.undertime++; }
        else if (diff >= otThreshold) { rec.overtimeMin = diff; }
      } else if (lastOut == null) {
        rec.flags.push("No time-out");
      }

      // Built-in OT: scheduled shift length beyond a regular 8-hour day is
      // auto-recognized (e.g. 12h shift = 8h regular + 4h built-in OT). It is
      // EARNED by actual time worked past the 8-hour mark, so:
      //   - a full shift earns the whole built-in amount (capped at scheduled)
      //   - leaving early prorates it: built-in = actual OUT − (start + 8h),
      //     e.g. 6AM shift left 5PM = 3h (2PM→5PM), left 6PM = 4h (full)
      //   - leaving before the 8-hour mark earns 0
      // Requires an actual time-out; no time-out / absent earn nothing (until a
      // Missing Time Log Request supplies the OUT, after which this recomputes).
      //
      // A STRAIGHT DUTY is not one long shift for this purpose. A continuous
      // 24-hour tour is worked as two consecutive regular shifts — 06:00-18:00
      // then 18:00-06:00 — so the SAME rule above is applied to each half and
      // the two results are added. Treating it as a single 24h shift would
      // instead recognise 16h of built-in OT against 8h of regular time, which
      // is not how the tour is actually staffed or paid.
      if (startMs != null && endMs != null && hasTimeOut) {
        // One segment for an ordinary shift; two equal halves for a straight
        // duty. Nothing else about the calculation differs.
        const segments = rec.shiftUnits === 2
          ? [[startMs, startMs + (endMs - startMs) / 2], [startMs + (endMs - startMs) / 2, endMs]]
          : [[startMs, endMs]];
        let builtin = 0;
        for (const [segStart, segEnd] of segments) {
          const scheduledBuiltin = Math.max(0, Math.round((segEnd - segStart) / 60000) - 8 * 60);
          if (scheduledBuiltin <= 0) continue;
          const eightHourMark = segStart + 8 * 60 * 60 * 1000;
          const workedPastEight = Math.round((lastOut - eightHourMark) / 60000);
          // Clamp between 0 and this segment's scheduled built-in amount.
          builtin += Math.max(0, Math.min(workedPastEight, scheduledBuiltin));
        }
        rec.builtinOtMin = builtin;
      }

      // Excess OT on a straight duty is measured from the guard's OWN time-in,
      // not from the rostered end: the tour is twenty-four hours of duty, so
      // starting an hour late means finishing an hour later before any of it is
      // overtime. Only what is worked past that 24-hour mark can be excess —
      // everything inside the tour is already recognised as built-in above, and
      // counting it twice would put the same minutes in the column that
      // requires approval.
      //
      // This replaces a blanket `overtimeMin = 0` for straight duties. That was
      // over-broad: the figure it discarded was `lastOut - endMs`, which is time
      // AFTER the tour finished, not inside it — so a guard who was genuinely
      // held over past a 24-hour tour was recorded as having worked no excess
      // overtime at all.
      //
      // Undertime is deliberately left measured against the ROSTERED end, as it
      // is for every other shift, so a late start still reads as short duty
      // rather than being silently forgiven.
      if (rec.shiftUnits === 2) {
        rec.overtimeMin = 0;
        if (firstIn != null && lastOut != null) {
          const tourEnd = firstIn + 24 * 60 * 60 * 1000;
          const past = Math.round((lastOut - tourEnd) / 60000);
          if (past >= otThreshold) rec.overtimeMin = past;
        }
      }

      // Flag and count overtime once BOTH kinds are known. Built-in OT is real
      // paid overtime (a 12h shift is 8h regular + 4h built-in), so a day that
      // earns it counts as an overtime day even with no approvable excess —
      // previously only excess OT was counted, so a full night shift showed no
      // overtime at all.
      rec.totalOtMin = (rec.builtinOtMin || 0) + (rec.overtimeMin || 0);
      if (rec.totalOtMin > 0) { rec.flags.push("Overtime"); summary.overtime++; }
    }
    rows.push(rec);
  }

  // Rest days no longer carry a shift row (a rest day replaces the shift), so
  // add a dedicated "Rest Day" row for each rest day that didn't already appear
  // above via a coexisting shift. This makes them visible in the report and
  // counted in the Rest Day KPI.
  const shiftRowKeys = new Set(rows.map((r) => `${norm(r.guardName)}|${r.dutyDate}`));
  for (const rd of restRows) {
    const key = `${norm(rd.guardName)}|${rd.dutyDate}`;
    if (shiftRowKeys.has(key)) continue; // already shown via a shift row
    summary.restDay++;
    rows.push({
      dutyDate: rd.dutyDate, guardName: rd.guardName, site: rd.site || "", employeeId: rd.employeeId,
      shiftName: "", startTime: null, endTime: null, crossesMidnight: false, isRestDay: true,
      timeIn: null, timeOut: null,
      status: "Rest Day", lateMin: 0, undertimeMin: 0, overtimeMin: 0, flags: ["Rest Day"],
    });
  }

  // Duty days that were WORKED but never rostered — a reliever, an extra post,
  // or simply a punch on a day nobody scheduled.
  //
  // Every row above comes from a shift_assignment, so before this a punch with
  // no matching assignment left NO trace on the report at all: the guard's own
  // Time IN sat in the Attendance Register while Daily Attendance showed
  // nothing, or showed a different day reading Absent. Billing already knew
  // about this hole and worked around it with its own query over the punches
  // (see routes/billing.js) — the report screen had no such workaround.
  //
  // These rows carry no scheduled times, because there was no schedule. That is
  // also what keeps billing correct: its "already rostered" test requires
  // startTime AND endTime, so these rows are ignored there and its ADD stays
  // derived from the punches exactly as before, with no double count.
  const rosteredDayKeys = new Set(
    rows.filter((r) => r.startTime && r.endTime)
      .map((r) => `${norm(r.guardName)}|${norm(r.site)}|${r.dutyDate}`)
  );
  // A punch already consumed by a rostered duty is not ALSO an unrostered day.
  // The date test above cannot see this: a night shift's closing punch and a
  // broken shift's evening stretch both land on the NEXT calendar date, which
  // carries no roster row of its own, so the punch was counted once on the duty
  // that owns it and again as a phantom "Unrostered" duty day — inflating
  // summary.present and showing the guard a duty they never worked. Measured on
  // the exclusive-allocation fixture: 3 of the 3 remaining double-claims.
  //
  // This is deliberately ADDITIVE to the date test rather than a replacement.
  // Suppressing by punch identity alone would let genuinely unclaimed punches on
  // a rostered date raise new rows, which is a wider change than this needs; as
  // written it can only ever remove a phantom, never create one.
  const claimedPunchIds = new Set();
  for (const r of rows) for (const id of r.punchIds || []) claimedPunchIds.add(id);

  const unrostered = new Map();
  for (const [key, list] of punchIndex) {
    const [gName, gSite] = key.split("|");
    // The punches query is not site-filtered (it feeds every row above, which
    // is already scoped by its assignment). These rows have no assignment to
    // inherit a site from, so the caller's filter has to be applied here — or a
    // site-scoped call, as billing makes, would pick up other sites' punches.
    if (site && gSite !== norm(site)) continue;
    for (const p of list) {
      if (claimedPunchIds.has(p.id)) continue;
      const dutyDate = phDateOf(p.at);
      if (dutyDate < from || dutyDate > to) continue;
      if (rosteredDayKeys.has(`${gName}|${gSite}|${dutyDate}`)) continue;
      const k = `${key}|${dutyDate}`;
      if (!unrostered.has(k)) unrostered.set(k, []);
      unrostered.get(k).push(p);
    }
  }
  for (const [, list] of unrostered) {
    const ins = list.filter((p) => p.type === "IN").map((p) => p.at);
    const outs = list.filter((p) => p.type === "OUT").map((p) => p.at);
    const firstIn = ins.length ? Math.min(...ins) : null;
    const lastOut = outs.length ? Math.max(...outs) : null;
    // Names and site are taken from the punch itself, not from the normalised
    // index key, so the report shows them as the guard actually entered them.
    const src = list[0];
    const flags = ["Unrostered"];
    if (firstIn != null && lastOut == null) flags.push("No time-out");
    summary.present++;
    rows.push({
      punchIds: list.map((p) => p.id),
      dutyDate: phDateOf((firstIn != null ? firstIn : lastOut)),
      guardName: src.guardName, site: src.site || "", employeeId: null,
      shiftName: "", startTime: null, endTime: null, crossesMidnight: false,
      shiftKind: "", startTime2: null, endTime2: null, crossesMidnight2: false,
      isRestDay: false, unrostered: true,
      timeIn: firstIn != null ? new Date(firstIn).toISOString() : null,
      timeOut: lastOut != null ? new Date(lastOut).toISOString() : null,
      // No schedule means nothing to be late for, nothing to leave early from,
      // and no shift length to measure overtime against. Stating zero is honest;
      // inventing a shift to compare with would not be.
      status: "Present", lateMin: 0, undertimeMin: 0,
      builtinOtMin: 0, overtimeMin: 0, totalOtMin: 0, shiftUnits: 1,
      flags,
    });
  }

  // Keep the report ordered by date, then site, then guard.
  rows.sort((x, y) =>
    x.dutyDate.localeCompare(y.dutyDate) ||
    (x.site || "").localeCompare(y.site || "") ||
    x.guardName.localeCompare(y.guardName)
  );

  // Optional guard filter (by exact name). Recompute the summary so KPIs match.
  if (guard) {
    const g = guard.trim().toLowerCase();
    const filtered = rows.filter((r) => (r.guardName || "").trim().toLowerCase() === g);
    const sm = { total: 0, present: 0, absent: 0, onLeave: 0, restDay: 0, late: 0, undertime: 0, overtime: 0,
      onRelief: 0 };
    for (const r of filtered) {
      if (r.status === "Rest Day") { sm.restDay++; continue; }
      sm.total++;
      if (r.status === "Absent") sm.absent++;
      else if (r.status === "On Leave") sm.onLeave++;
      else {
        sm.present++;
        if (r.lateMin > 0) sm.late++;
        if (r.undertimeMin > 0) sm.undertime++;
        if (r.overtimeMin > 0) sm.overtime++;
      }
    }
    return { summary: sm, rows: filtered };
  }

  return { summary, rows };
}

// dateAtTime (and the PH UTC+8 handling behind it) now lives in
// ../lib/phTime.js so the payroll engine's night-differential maths resolves
// PH local times through exactly the same code path.

// Daily Attendance + Late/Undertime/Overtime + Absence report (JSON).
router.get("/", requireAuth, async (req, res) => {
  const { from, to, site, guard } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });
  const { summary, rows } = await computeReport({ from, to, site, guard, grace, otThreshold });
  res.json({ from, to, site: site || null, guard: guard || null, grace, otThreshold, summary, rows });
});

/**
 * One guard's daily time record for one payroll period. READ-ONLY.
 *
 * Everything per-day comes from computeReport — status, late, undertime,
 * BUILT-IN OT and EXCESS OT — so this view can never disagree with the register,
 * the reports or payroll about the same day. Nothing is recomputed here:
 *
 *   builtinOtMin  overtime inherent to the SCHEDULED shift length beyond 8h
 *                 (a 12h shift earns 4h; a straight duty earns 8h).
 *   overtimeMin   EXCESS overtime — worked past the scheduled END, derived from
 *                 the actual punch-out against that end, past otThreshold.
 *
 * Bounded: THREE queries for the whole period regardless of its length — the
 * report, the employee's master record, and the period's Missing Time Log
 * filings. Nothing runs per day.
 */
router.get("/timesheet", requireAuth, wrap(async (req, res) => {
  const { from, to, guard } = req.query;
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });
  if (!guard) return res.status(400).json({ error: "Choose a guard first — a timesheet is per person." });
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);

  const { rows } = await computeReport({ from, to, guard, grace, otThreshold });

  // The master record behind the header. Matched on the same value the
  // register's guard dropdown carries — the employee's full name.
  const emp = (await pool.query(
    `SELECT "employeeNo", "fullName", position FROM employees
      WHERE lower(regexp_replace(btrim("fullName"), '\\s+', ' ', 'g'))
          = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
      LIMIT 1`, [guard]
  )).rows[0] || null;

  // Missing Time Log filings in the period, so a day can show that a correction
  // was filed and what became of it. One query, indexed by date below.
  const filings = (await pool.query(
    `SELECT id, to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", "missingType", status
     FROM missing_timelog_requests
     WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date
       AND lower(regexp_replace(btrim("guardName"), '\\s+', ' ', 'g'))
         = lower(regexp_replace(btrim($3), '\\s+', ' ', 'g'))
     ORDER BY id`, [from, to, guard]
  )).rows;
  const filingsByDate = new Map();
  for (const f of filings) {
    if (!filingsByDate.has(f.dutyDate)) filingsByDate.set(f.dutyDate, []);
    filingsByDate.get(f.dutyDate).push({ id: f.id, missingType: f.missingType, status: f.status });
  }

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.dutyDate)) byDate.set(r.dutyDate, []);
    byDate.get(r.dutyDate).push(r);
  }

  // HEADER SITE: the guard's MOST FREQUENT ROSTERED site across this period,
  // derived — never a stored "assigned site" column. It is period-relative on
  // purpose: a guard who moved posts mid-month reads differently for 1-15 than
  // for 16-31, which is where they actually were.
  //
  // Counted over ROSTERED days only (a row with both scheduled times), so an
  // unrostered punch cannot outvote the schedule. Ties break to the
  // alphabetically first site so the same guard and period always render the
  // same header rather than whichever row happened to come back first.
  const siteDays = new Map();
  for (const r of rows) {
    if (!r.startTime || !r.endTime || !r.site) continue;
    siteDays.set(r.site, (siteDays.get(r.site) || 0) + 1);
  }
  let headerSite = null;
  for (const [site, n] of [...siteDays.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    headerSite = site; void n; break;
  }

  // One entry per DATE in the period, including dates the roster never touched
  // — the reference form has a line for every day, and a missing line reads as
  // a rendering fault rather than "nothing was scheduled".
  const days = [];
  for (let d = from; d <= to; d = phAddDays(d, 1)) {
    days.push({
      dutyDate: d,
      entries: (byDate.get(d) || []).map((r) => ({
        site: r.site || "", shiftName: r.shiftName || "", shiftKind: r.shiftKind || "",
        startTime: r.startTime || null, endTime: r.endTime || null,
        crossesMidnight: !!r.crossesMidnight,
        startTime2: r.startTime2 || null, endTime2: r.endTime2 || null,
        timeIn: r.timeIn || null, timeOut: r.timeOut || null,
        status: r.status, isRestDay: !!r.isRestDay, leaveType: r.leaveType || null,
        lateMin: r.lateMin || 0, undertimeMin: r.undertimeMin || 0,
        // The two OT figures, kept SEPARATE all the way to the screen.
        builtinOtMin: r.builtinOtMin || 0,
        excessOtMin: r.overtimeMin || 0,
        flags: r.flags || [],
      })),
      filings: filingsByDate.get(d) || [],
    });
  }

  res.json({
    from, to, guard,
    employee: emp ? { employeeNo: emp.employeeNo || "", fullName: emp.fullName, position: emp.position || "" } : null,
    site: headerSite,
    days,
  });
}));

// Branded PDF export. tab = daily | late | overtime (filters which rows show).
router.get("/pdf", requireAuth, async (req, res) => {
  const { from, to, site, guard, tab = "daily" } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });

  const { summary, rows } = await computeReport({ from, to, site, guard, grace, otThreshold });
  let view = rows;
  if (tab === "late") view = rows.filter((r) => r.lateMin > 0 || r.undertimeMin > 0);
  else if (tab === "overtime") view = rows.filter((r) => r.overtimeMin > 0 || r.builtinOtMin > 0);
  const tabLabel = tab === "late" ? "Late & Undertime" : tab === "overtime" ? "Overtime" : "Daily Attendance";

  // Live branding.
  const settings = (await pool.query(
    `SELECT "companyName", "logoData", "logoMimetype" FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  const companyName = (settings.companyName || "").toUpperCase();
  const logoBuf = settings.logoData || null;

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="attendance-${tab}-${from}_${to}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
  const textX = logoBuf ? 96 : 40;
  if (logoBuf) { try { doc.image(logoBuf, 40, 20, { fit: [42, 42] }); } catch (e) { /* skip */ } }
  doc.fillColor(GOLD).fontSize(10).text(companyName, textX, 24, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(16).text(`Attendance Report — ${tabLabel}`, textX, 40);
  doc.fillColor("#C9D3E3").fontSize(9).text(`${from} to ${to}${site ? "  ·  " + site : ""}  ·  Grace ${grace}m / OT ${otThreshold}m  ·  Generated ${new Date().toLocaleDateString()}`, textX, 62);
  doc.y = 100;

  // Summary line
  doc.fillColor(NAVY).fontSize(10).text(
    // Site review is appended only when there is one, so an ordinary period's
    // summary line reads exactly as it always has.
    `Scheduled: ${summary.total}    Present: ${summary.present}    Absent: ${summary.absent}    On Leave: ${summary.onLeave}    Rest Day: ${summary.restDay}    Late: ${summary.late}    Undertime: ${summary.undertime}    Overtime: ${summary.overtime}` +
      (summary.siteReview ? `    Pending site review: ${summary.siteReview}` : ""),
    40, 100
  );
  doc.moveDown(1);

  // Table
  const cols = [
    { k: "dutyDate", label: "Date", w: 70 },
    { k: "guardName", label: "Guard", w: 130 },
    { k: "site", label: "Site", w: 80 },
    { k: "shiftName", label: "Shift", w: 90 },
    { k: "sched", label: "Scheduled", w: 90 },
    { k: "timeIn", label: "Time In", w: 95 },
    { k: "timeOut", label: "Time Out", w: 95 },
    { k: "lateMin", label: "Late", w: 45 },
    { k: "undertimeMin", label: "Under", w: 50 },
    { k: "overtimeMin", label: "OT", w: 40 },
    { k: "status", label: "Status", w: 75 },
  ];
  let x0 = 40, y = doc.y;
  function drawRow(vals, opts = {}) {
    let x = x0;
    if (opts.header) { doc.rect(x0, y - 2, cols.reduce((s, c) => s + c.w, 0), 16).fill("#EEF2F7"); }
    cols.forEach((c, i) => {
      doc.fillColor(opts.header ? NAVY : "#1a1a1a").fontSize(opts.header ? 8.5 : 8)
        .text(String(vals[i] ?? ""), x + 2, y + 1, { width: c.w - 4, ellipsis: true });
      x += c.w;
    });
    y += 15;
    if (y > doc.page.height - 40) { doc.addPage({ layout: "landscape", margin: 40 }); y = 40; }
  }
  drawRow(cols.map((c) => c.label), { header: true });
  const fmtT = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  if (view.length === 0) {
    doc.fillColor(MUTE).fontSize(9).text("No records for this view in the selected range.", 40, y + 4);
  }
  for (const r of view) {
    drawRow([
      r.dutyDate, r.guardName, r.site, r.shiftName || "",
      r.startTime && r.endTime ? `${r.startTime}-${r.endTime}` : "",
      fmtT(r.timeIn), fmtT(r.timeOut),
      r.lateMin || "", r.undertimeMin || "", ((r.builtinOtMin || 0) + (r.overtimeMin || 0)) || "",
      r.status === "Absent" ? "Absent"
        : r.status === "On Leave" ? `On Leave${r.leaveType ? ` (${r.leaveType})` : ""}`
        : r.status === "Rest Day" ? "Rest Day"
        : (r.flags.filter((f) => f !== "Absent" && f !== "On Leave" && f !== "Rest Day").join(", ") || "Present"),
    ]);
  }

  stampAuthorFooter(doc, companyName);

  doc.end();
});


// ---------------------------------------------------------------------------
// DAILY TIME RECORD (DTR)
//
// One document per detachment for one semi-monthly cutoff: a 16-day grid with
// guards as rows, two bands each (DS above, NS below), and a right-hand summary
// of DS / NS / Days / Hours. It is the sheet the agency's Operation Officer
// signs and the client's representative countersigns.
//
// ONE computeReport() CALL SERVES EVERY SITE. The grid is grouped by site
// afterwards, inside buildDtr(), rather than by calling the engine once per
// detachment: nine calls would be nine chances for one guard's day to be
// classified differently on two sheets, and the whole reason this reads
// computeReport at all is that the DTR must not disagree with the register,
// the reports or payroll about the same day.
// ---------------------------------------------------------------------------

/** Site -> printed detachment name, client name, id, and the client's signatory. */
async function dtrSiteMeta() {
  const { rows } = await pool.query(
    `SELECT bs.site, bs."detachmentName", bc.id AS "clientId", bc.name AS "clientName",
            bc."repName", bc."repTitle"
       FROM billing_sites bs
       JOIN billing_clients bc ON bc.id = bs."clientId"`
  );
  return rows;
}

/**
 * Active disciplinary penalties overlapping the window, matched to the guard's
 * CURRENT name by employeeId. A case with no employeeId does not resolve and is
 * invisible here -- deliberately, so a shared name never bars or marks the wrong
 * person (Known Gap 34). `suspensionEnd` is null for an RTU or a Termination;
 * the DTR runs those to the end of the cutoff.
 *
 * `clientId` is left null on every row. An RTU bars the CURRENT client's posts,
 * and the case's own `site` is immaterial to that -- the same scoping Stage B's
 * roster refusal uses. The agency serves one client today, so buildDtr reads a
 * null clientId as "every mapped detachment"; a second client is the deferred
 * case where a case would have to name which client the RTU is against.
 */
async function dtrPenalties(from, to) {
  const { rows } = await pool.query(
    `SELECT e."fullName" AS "guardName", dc.penalty,
            to_char(dc."suspensionStart", 'YYYY-MM-DD') AS "from",
            to_char(dc."suspensionEnd",   'YYYY-MM-DD') AS "to",
            NULL::int AS "clientId"
       FROM disciplinary_cases dc
       JOIN employees e ON e.id = dc."employeeId"
      WHERE dc.penalty IN ('Suspension','RTU','Termination')
        AND dc."suspensionStart" IS NOT NULL
        AND dc."suspensionStart" <= $2::date
        AND (dc."suspensionEnd" IS NULL OR dc."suspensionEnd" >= $1::date)`,
    [from, to]
  );
  return rows;
}

/** The agency letterhead and its own signatory, live from System Settings. */
async function dtrBranding() {
  const s = (await pool.query(
    `SELECT "companyName", "logoData", "agencyTagline", "agencyAddress",
            "agencyMobile", "agencyEmail",
            "operationHeadName", "operationHeadPosition"
       FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  return {
    companyName: s.companyName || "",
    tagline: s.agencyTagline || "",
    address: s.agencyAddress || "",
    mobile: s.agencyMobile || "",
    email: s.agencyEmail || "",
    // "Checked by" on the sheet. Blank when unset: the form is wet-signed, so an
    // empty signature line is ordinary — a fabricated name would not be.
    preparedName: s.operationHeadName || "",
    preparedTitle: s.operationHeadPosition || "",
    hasLogo: Boolean(s.logoData),
  };
}

async function dtrPayload(req) {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ""))) {
    return { error: "A from and to date (YYYY-MM-DD) are required." };
  }
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  const site = req.query.site || undefined;

  const { rows } = await computeReport({ from, to, site, grace, otThreshold });
  const meta = await dtrSiteMeta();
  const branding = await dtrBranding();
  const penalties = await dtrPenalties(from, to);
  const bySite = new Map(meta.map((m) => [m.site, m]));

  const dtr = buildDtr({ rows, from, to, siteMeta: meta, penalties });
  // The client's countersignatory rides on each site: it is a property of the
  // client that detachment belongs to, not of the report.
  for (const s of dtr.sites) {
    const m = bySite.get(s.site) || {};
    s.repName = m.repName || "";
    s.repTitle = m.repTitle || "";
  }
  return { dtr, branding, problems: checkDtr(dtr) };
}

router.get("/dtr", requireAuth, wrap(async (req, res) => {
  const out = await dtrPayload(req);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ ...out.dtr, branding: out.branding, problems: out.problems });
}));

router.get("/dtr.pdf", requireAuth, wrap(async (req, res) => {
  const out = await dtrPayload(req);
  if (out.error) return res.status(400).json({ error: out.error });
  const { dtr, branding } = out;

  const logoBuf = (await pool.query(`SELECT "logoData" FROM app_settings WHERE id = 1`)).rows[0]?.logoData || null;

  const NAVY = "#0B2545", MUTE = "#5B6B85", RULE = "#B9C4D4", SUN = "#B3261E";
  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 28 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="DTR-${dtr.from}_${dtr.to}.pdf"`);
  doc.pipe(res);

  const W = doc.page.width, L = 28, R = W - 28;
  const NAME_W = 150, SUM_W = 4 * 30, SIGN_W = 78;
  const gridW = R - L - NAME_W - SUM_W - SIGN_W;
  const colW = gridW / dtr.days.length;

  function letterhead() {
    let y = 22;
    if (logoBuf) { try { doc.image(logoBuf, L + 8, y, { fit: [52, 52] }); } catch (e) { /* skip a bad image */ } }
    doc.fillColor(NAVY).fontSize(14).font("Helvetica-Bold")
      .text(branding.companyName.toUpperCase(), L, y + 2, { width: R - L, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor(MUTE);
    const lines = [branding.tagline, branding.address,
      [branding.mobile && `Mobile: ${branding.mobile}`, branding.email && `Email: ${branding.email}`]
        .filter(Boolean).join("   ")].filter(Boolean);
    let ly = y + 20;
    for (const t of lines) { doc.text(t, L, ly, { width: R - L, align: "center" }); ly += 10; }
    return Math.max(ly + 6, y + 58);
  }

  function sitePage(s, first) {
    if (!first) doc.addPage({ size: "A4", layout: "landscape", margin: 28 });
    let y = letterhead();

    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10)
      .text(`DTR SUMMARY - PERIOD COVERED: ${periodTitle(dtr)}`, L, y);
    y += 13;
    doc.fontSize(9).text("DETACHMENT/POST: ", L, y, { continued: true })
      .font("Helvetica").text(s.detachmentName);
    y += 12;
    doc.font("Helvetica-Bold").fontSize(9).text("COMPANY NAME: ", L, y, { continued: true })
      .font("Helvetica").text(s.clientName || "—");
    y += 16;

    // --- header: weekday row, then day numbers
    const gx = L + NAME_W;
    doc.font("Helvetica-Bold").fontSize(6).fillColor(NAVY);
    doc.rect(L, y, R - L, 11).fillAndStroke("#EEF2F7", RULE);
    doc.fillColor(NAVY).text("No.  Name", L + 3, y + 3, { width: NAME_W - 6 });
    dtr.days.forEach((d, i) => {
      doc.fillColor(d.weekday === "SUN" ? SUN : NAVY)
        .text(d.weekday, gx + i * colW, y + 3, { width: colW, align: "center" });
    });
    const sx = gx + gridW;
    ["DS", "NS", "Days", "Hours"].forEach((h, i) => {
      doc.fillColor(NAVY).text(h, sx + i * 30, y + 3, { width: 30, align: "center" });
    });
    doc.text("Signature", sx + SUM_W, y + 3, { width: SIGN_W, align: "center" });
    y += 11;

    doc.rect(L, y, R - L, 11).fillAndStroke("#2F4A6D", RULE);
    dtr.days.forEach((d, i) => {
      doc.fillColor("#fff").fontSize(6.5).font("Helvetica-Bold")
        .text(String(d.day), gx + i * colW, y + 3, { width: colW, align: "center" });
    });
    y += 11;

    // --- guard rows, two bands each
    const BAND = 11;
    const drawBand = (label, cells, band, count, yy) => {
      doc.rect(L, yy, R - L, BAND).stroke(RULE);
      doc.font("Helvetica").fontSize(5.5).fillColor(MUTE)
        .text(label, L + NAME_W - 16, yy + 3, { width: 14, align: "right" });
      cells.forEach((c, i) => {
        const x = gx + i * colW;
        doc.moveTo(x, yy).lineTo(x, yy + BAND).stroke(RULE);
        const v = band === "DS" ? c.ds : c.ns;
        // A zero-duty code (DO / A / RTU / a leave code) describes the DAY, not
        // a band, so it is drawn ONCE in the upper band and only when nothing
        // was worked. A day that carries a 12 was worked, and its note — if the
        // engine produced one from a second row — must not sit beside it saying
        // otherwise.
        const worked = Boolean(c.ds || c.ns);
        const noteHere = !worked && band === "DS" && c.note;
        // A penalty on a punched-in day is flagged: drawn in red with a trailing
        // "!" so the anomaly reads off the grid, and also listed under the sheet.
        const flagged = noteHere && c.flagged;
        const text = v || (noteHere ? (flagged ? `${c.note}!` : c.note) : "");
        if (text) {
          doc.font(v ? "Helvetica-Bold" : "Helvetica").fontSize(6)
            .fillColor(flagged ? SUN : (v ? "#1a1a1a" : MUTE))
            .text(text, x, yy + 3, { width: colW, align: "center" });
        }
      });
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor(NAVY)
        .text(String(count), sx + (band === "DS" ? 0 : 30), yy + 3, { width: 30, align: "center" });
      return yy + BAND;
    };

    let n = 0;
    for (const g of s.guards) {
      const top = y;
      doc.font("Helvetica").fontSize(6.5).fillColor("#1a1a1a")
        .text(`${++n}. ${g.guardName}`, L + 3, top + 7, { width: NAME_W - 22, ellipsis: true });
      let yy = drawBand("DS", g.cells, "DS", g.ds, y);
      yy = drawBand("NS", g.cells, "NS", g.ns, yy);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY)
        .text(String(g.days), sx + 60, top + 7, { width: 30, align: "center" })
        .text(String(g.hours), sx + 90, top + 7, { width: 30, align: "center" });
      doc.rect(sx + SUM_W, top, SIGN_W, BAND * 2).stroke(RULE);
      y = yy;
    }
    for (let i = 0; i < s.blankSlots; i++) {
      doc.rect(L, y, R - L, BAND * 2).stroke(RULE);
      doc.font("Helvetica").fontSize(6.5).fillColor(MUTE)
        .text(`${++n}.`, L + 3, y + 7);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY)
        .text("0", sx + 60, y + 7, { width: 30, align: "center" })
        .text("0", sx + 90, y + 7, { width: 30, align: "center" });
      y += BAND * 2;
    }

    // --- per-day man-hour total row
    doc.rect(L, y, R - L, 12).fillAndStroke("#EEF2F7", RULE);
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(NAVY)
      .text("TOTAL man-hours", L + 3, y + 3, { width: NAME_W - 6 });
    s.perDayHours.forEach((h, i) => {
      doc.text(String(h), gx + i * colW, y + 3, { width: colW, align: "center" });
    });
    [s.totals.ds, s.totals.ns, s.totals.days, s.totals.hours].forEach((v, i) => {
      doc.fillColor(i >= 2 ? SUN : NAVY).text(String(v), sx + i * 30, y + 3, { width: 30, align: "center" });
    });
    y += 22;

    // --- penalty-on-a-worked-day conflicts for this detachment
    const conflicts = (dtr.penaltyConflicts || []).filter((c) => c.site === s.site);
    if (conflicts.length) {
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor(SUN)
        .text("Penalty on a worked day (verify before issuing):  "
          + conflicts.map((c) => `${c.guard} — ${c.date} (${c.code})`).join("    ·    "),
          L, y, { width: R - L });
      y += 16;
    }

    // --- legend
    doc.font("Helvetica").fontSize(5.5).fillColor(MUTE)
      .text("LEGEND:   " + dtr.legend.map(([c, m]) => `${c} = ${m}`).join("    ·    "),
        L, y, { width: R - L });
    y += 20;

    // --- signatures. The labels always print; the names may be blank.
    const colA = L + 60, colB = L + (R - L) / 2 + 40;
    doc.font("Helvetica").fontSize(8).fillColor("#1a1a1a")
      .text("Checked by:", colA, y).text("Certified correct by:", colB, y);
    y += 26;
    doc.moveTo(colA, y).lineTo(colA + 170, y).stroke(RULE);
    doc.moveTo(colB, y).lineTo(colB + 170, y).stroke(RULE);
    y += 3;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(NAVY)
      .text(branding.preparedName || " ", colA, y, { width: 170, align: "center" })
      .text(s.repName || " ", colB, y, { width: 170, align: "center" });
    y += 11;
    doc.font("Helvetica-Oblique").fontSize(7).fillColor(MUTE)
      .text(branding.preparedTitle || " ", colA, y, { width: 170, align: "center" })
      .text(s.repTitle || " ", colB, y, { width: 170, align: "center" });
  }

  if (!dtr.sites.length) {
    letterhead();
    doc.fillColor(MUTE).fontSize(10)
      .text("No attendance in this period.", L, 150, { width: R - L, align: "center" });
  } else {
    dtr.sites.forEach((s, i) => sitePage(s, i === 0));
  }

  stampAuthorFooter(doc, branding.companyName);
  doc.end();
}));

// RTU write routes were retired in Disciplinary Stage C. RTU is now recorded
// as a disciplinary penalty (disciplinary_cases.penalty = 'RTU') and the DTR
// reads it from there, so the rtu_records table and the double-click that
// wrote it are gone. Two ways to record one RTU was the drift this removed.

module.exports = router;
module.exports.computeReport = computeReport;
