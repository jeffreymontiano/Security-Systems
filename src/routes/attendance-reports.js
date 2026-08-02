const express = require("express");
const PDFDocument = require("pdfkit");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Shared computation used by both the JSON report and the PDF export.
async function computeReport({ from, to, site, grace, otThreshold }) {
  const asnClauses = [`"dutyDate" >= $1`, `"dutyDate" <= $2`];
  const asnVals = [from, to];
  if (site) { asnVals.push(site); asnClauses.push(`site = $${asnVals.length}`); }
  const assignments = (await pool.query(
    `SELECT id, "employeeId", "guardName", site, "shiftName",
            "startTime", "endTime", "crossesMidnight",
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate"
     FROM shift_assignments WHERE ${asnClauses.join(" AND ")}
     ORDER BY "dutyDate", site, "guardName"`, asnVals
  )).rows;

  const punches = (await pool.query(
    `SELECT "guardName", site, "punchType", "punchAt"
     FROM attendance_records
     WHERE "punchAt"::date >= $1::date AND "punchAt"::date <= ($2::date + INTERVAL '1 day')
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

  const rows = [];
  const summary = { total: 0, present: 0, absent: 0, late: 0, undertime: 0, overtime: 0 };

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

    const rec = {
      dutyDate: a.dutyDate, guardName: a.guardName, site: a.site,
      shiftName: a.shiftName, startTime: a.startTime, endTime: a.endTime,
      crossesMidnight: a.crossesMidnight,
      timeIn: firstIn ? new Date(firstIn).toISOString() : null,
      timeOut: lastOut ? new Date(lastOut).toISOString() : null,
      status: "Present", lateMin: 0, undertimeMin: 0, overtimeMin: 0, flags: [],
    };

    if (firstIn == null) {
      rec.status = "Absent"; rec.flags.push("Absent"); summary.absent++;
    } else {
      summary.present++;
      if (startMs != null) {
        const lateBy = Math.round((firstIn - startMs) / 60000);
        if (lateBy > grace) { rec.lateMin = lateBy; rec.flags.push("Late"); summary.late++; }
      }
      if (endMs != null && lastOut != null) {
        const diff = Math.round((lastOut - endMs) / 60000);
        if (diff < 0) { rec.undertimeMin = Math.abs(diff); rec.flags.push("Undertime"); summary.undertime++; }
        else if (diff >= otThreshold) { rec.overtimeMin = diff; rec.flags.push("Overtime"); summary.overtime++; }
      } else if (lastOut == null) {
        rec.flags.push("No time-out");
      }
    }
    rows.push(rec);
  }
  return { summary, rows };
}

// Convert "HH:MM" to minutes since midnight.
function hhmmToMin(t) {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Given a duty date (YYYY-MM-DD) and an HH:MM time, build a JS Date in the
// Build the expected shift time as an epoch millisecond value, interpreting the
// HH:MM as PHILIPPINE local time (UTC+8) — because guards punch in PH time and
// punches are stored as real UTC moments. Treating the shift time as UTC caused
// an 8-hour mismatch that made every punch fall outside its window (all Absent).
// For night shifts, the end time is on the NEXT day (addDays = 1).
const PH_OFFSET_MIN = 8 * 60; // UTC+8, no DST in the Philippines
function dateAtTime(dateStr, hhmm, addDays = 0) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  // 06:00 PH == 06:00 UTC minus 8h. Subtract the offset from the UTC construction.
  return Date.UTC(y, mo - 1, d + addDays, h, m) - PH_OFFSET_MIN * 60 * 1000;
}

// Daily Attendance + Late/Undertime/Overtime + Absence report (JSON).
router.get("/", requireAuth, async (req, res) => {
  const { from, to, site } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });
  const { summary, rows } = await computeReport({ from, to, site, grace, otThreshold });
  res.json({ from, to, site: site || null, grace, otThreshold, summary, rows });
});

// Branded PDF export. tab = daily | late | overtime (filters which rows show).
router.get("/pdf", requireAuth, async (req, res) => {
  const { from, to, site, tab = "daily" } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });

  const { summary, rows } = await computeReport({ from, to, site, grace, otThreshold });
  let view = rows;
  if (tab === "late") view = rows.filter((r) => r.lateMin > 0 || r.undertimeMin > 0);
  else if (tab === "overtime") view = rows.filter((r) => r.overtimeMin > 0);
  const tabLabel = tab === "late" ? "Late & Undertime" : tab === "overtime" ? "Overtime" : "Daily Attendance";

  // Live branding.
  const settings = (await pool.query(
    `SELECT "companyName", "logoData", "logoMimetype" FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  const companyName = (settings.companyName || "Brookside Farms Corporation").toUpperCase();
  const logoBuf = settings.logoData || null;

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 40 });
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
    `Scheduled: ${summary.total}    Present: ${summary.present}    Absent: ${summary.absent}    Late: ${summary.late}    Undertime: ${summary.undertime}    Overtime: ${summary.overtime}`,
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
      r.lateMin || "", r.undertimeMin || "", r.overtimeMin || "",
      r.status === "Absent" ? "Absent" : (r.flags.filter((f) => f !== "Absent").join(", ") || "Present"),
    ]);
  }

  doc.end();
});

module.exports = router;
