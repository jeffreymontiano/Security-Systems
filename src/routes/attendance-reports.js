const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { dateAtTime } = require("../lib/phTime");

const router = express.Router();

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

// Shared computation used by both the JSON report and the PDF export.
async function computeReport({ from, to, site, guard, grace, otThreshold }) {
  const asnClauses = [`"dutyDate" >= $1`, `"dutyDate" <= $2`];
  const asnVals = [from, to];
  if (site) { asnVals.push(site); asnClauses.push(`site = $${asnVals.length}`); }
  const assignments = (await pool.query(
    `SELECT id, "employeeId", "guardName", site, "shiftName", "shiftKind",
            "startTime", "endTime", "crossesMidnight",
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
    `SELECT "guardName", site, "punchType", "punchAt"
     FROM attendance_records
     WHERE ("punchAt" AT TIME ZONE 'Asia/Manila')::date >= $1::date
       AND ("punchAt" AT TIME ZONE 'Asia/Manila')::date <= ($2::date + INTERVAL '1 day')
     ORDER BY "punchAt"`,
    [from, to]
  )).rows;

  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const punchIndex = new Map();
  for (const p of punches) {
    const key = `${norm(p.guardName)}|${norm(p.site)}`;
    if (!punchIndex.has(key)) punchIndex.set(key, []);
    punchIndex.get(key).push({ type: p.punchType, at: new Date(p.punchAt).getTime() });
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
  const summary = { total: 0, present: 0, absent: 0, onLeave: 0, restDay: 0, late: 0, undertime: 0, overtime: 0 };

  for (const a of assignments) {
    summary.total++;
    const key = `${norm(a.guardName)}|${norm(a.site)}`;
    const guardPunches = punchIndex.get(key) || [];
    const hasTimes = a.startTime && a.endTime;
    const startMs = hasTimes ? dateAtTime(a.dutyDate, a.startTime) : null;
    const endMs = hasTimes ? dateAtTime(a.dutyDate, a.endTime, a.crossesMidnight ? 1 : 0) : null;
    const pad = 2 * 60 * 60 * 1000;
    const winStart = startMs != null ? startMs - pad : null;
    const winEnd = endMs != null ? endMs + pad : null;

    let firstIn = null, lastOut = null;
    for (const p of guardPunches) {
      if (winStart != null && (p.at < winStart || p.at > winEnd)) continue;
      if (p.type === "IN" && (firstIn == null || p.at < firstIn)) firstIn = p.at;
      if (p.type === "OUT" && (lastOut == null || p.at > lastOut)) lastOut = p.at;
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

    const rec = {
      dutyDate: a.dutyDate, guardName: a.guardName, site: a.site, employeeId: a.employeeId,
      shiftName: a.shiftName, startTime: a.startTime, endTime: a.endTime,
      crossesMidnight: a.crossesMidnight,
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

    if (firstIn == null) {
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

      // Excess OT does not apply to a straight duty. The whole 24 hours are the
      // scheduled tour, and the overtime inside it is already recognised as
      // built-in above; leaving the earlier calculation in place would classify
      // the same minutes twice, in the column that requires approval.
      if (rec.shiftUnits === 2) rec.overtimeMin = 0;

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
    const sm = { total: 0, present: 0, absent: 0, onLeave: 0, restDay: 0, late: 0, undertime: 0, overtime: 0 };
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
  const companyName = (settings.companyName || "Brookside Farms Corporation").toUpperCase();
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
    `Scheduled: ${summary.total}    Present: ${summary.present}    Absent: ${summary.absent}    On Leave: ${summary.onLeave}    Rest Day: ${summary.restDay}    Late: ${summary.late}    Undertime: ${summary.undertime}    Overtime: ${summary.overtime}`,
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

module.exports = router;
module.exports.computeReport = computeReport;
