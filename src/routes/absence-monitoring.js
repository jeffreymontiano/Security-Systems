const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { computeReport } = require("./attendance-reports");

const router = express.Router();

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Main absence-monitoring payload for a date range:
//  - absences: true unexplained absences (missed shift, no IN punch)
//  - noTimeouts: timed in but never out
//  - patterns: repeat absentees, per-guard counts, per-site concentration
//  - each item is merged with any saved follow-up (status + remark)
router.get("/", requireAuth, async (req, res) => {
  const { from, to, site, guard } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });

  // Reuse the shared attendance classification engine (same source of truth as
  // the attendance report), then derive the two absence categories from it.
  const { rows } = await computeReport({ from, to, site, guard, grace, otThreshold });

  const absences = rows
    .filter((r) => r.status === "Absent")
    .map((r) => ({ dutyDate: r.dutyDate, guardName: r.guardName, site: r.site, shiftName: r.shiftName, kind: "absence" }));

  const noTimeouts = rows
    .filter((r) => r.status !== "Absent" && r.status !== "On Leave" && r.status !== "Rest Day"
      && Array.isArray(r.flags) && r.flags.includes("No time-out"))
    .map((r) => ({
      dutyDate: r.dutyDate, guardName: r.guardName, site: r.site, shiftName: r.shiftName,
      timeIn: r.timeIn, kind: "no_timeout"
    }));

  // Merge saved follow-ups for everything in range.
  const followupRows = (await pool.query(
    `SELECT "guardKey", to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", kind, status, remark, "updatedBy",
            to_char("updatedAt", 'YYYY-MM-DD HH24:MI') AS "updatedAt"
     FROM absence_followups
     WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date`,
    [from, to]
  )).rows;
  const fMap = new Map();
  for (const f of followupRows) fMap.set(`${f.guardKey}|${f.dutyDate}|${f.kind}`, f);
  function attach(item) {
    const f = fMap.get(`${norm(item.guardName)}|${item.dutyDate}|${item.kind}`);
    return { ...item, status: f ? f.status : "Pending", remark: f ? f.remark : "", updatedBy: f ? f.updatedBy : null, updatedAt: f ? f.updatedAt : null };
  }
  const absencesOut = absences.map(attach);
  const noTimeoutsOut = noTimeouts.map(attach);

  // Patterns (absences only — the actionable category).
  const byGuard = new Map();
  const bySite = new Map();
  for (const a of absences) {
    byGuard.set(a.guardName, (byGuard.get(a.guardName) || 0) + 1);
    const s = a.site || "(no site)";
    bySite.set(s, (bySite.get(s) || 0) + 1);
  }
  const repeatAbsentees = [...byGuard.entries()]
    .map(([guardName, count]) => ({ guardName, count }))
    .sort((a, b) => b.count - a.count);
  const siteConcentration = [...bySite.entries()]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    from, to, site: site || null, guard: guard || null,
    summary: {
      absences: absencesOut.length,
      noTimeouts: noTimeoutsOut.length,
      pendingAbsences: absencesOut.filter((a) => a.status === "Pending").length,
      repeatAbsenteeCount: repeatAbsentees.filter((r) => r.count > 1).length,
    },
    absences: absencesOut,
    noTimeouts: noTimeoutsOut,
    patterns: { repeatAbsentees, siteConcentration },
  });
});

// Upsert a follow-up for one absence/no-timeout item.
// Body: { guardName, dutyDate, kind, site, status, remark }
router.put("/followup", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.guardName || !b.dutyDate) return res.status(400).json({ error: "Guard and date are required." });
  const kind = b.kind === "no_timeout" ? "no_timeout" : "absence";
  const status = ["Pending", "Excused", "Actioned"].includes(b.status) ? b.status : "Pending";
  const guardKey = norm(b.guardName);

  const { rows } = await pool.query(
    `INSERT INTO absence_followups ("guardKey", "guardName", site, "dutyDate", kind, status, remark, "updatedBy", "updatedAt")
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8, now())
     ON CONFLICT ("guardKey", "dutyDate", kind)
     DO UPDATE SET status = EXCLUDED.status, remark = EXCLUDED.remark, site = EXCLUDED.site,
                   "guardName" = EXCLUDED."guardName", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()
     RETURNING id, status, remark`,
    [guardKey, b.guardName, b.site || "", b.dutyDate, kind, status, (b.remark || "").trim(), req.user.username]
  );
  res.json({ ok: true, ...rows[0] });
});

// ---- Missing Time Log Requests (admin review) -----------------------------

// List requests, optional ?status= filter.
router.get("/missing-timelog", requireAuth, async (req, res) => {
  const { status } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (status) { clauses.push(`status = $${i++}`); vals.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // The guard's SCHEDULED shift for that duty date comes back with each row so
  // the approval form can default the corrected times to the shift actually
  // rostered. Without it the form guessed a day shift, and approving a night
  // shift with 06:00/18:00 produced punches outside the shift's matching
  // window — the day stayed "Absent" despite an approved correction.
  // Matched on normalized guard name, the same key the attendance report uses.
  const { rows } = await pool.query(
    `SELECT m.id, m."employeeId", m."employeeNo", m."guardName", m.site,
            to_char(m."dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            m."missingType", m.reason, m.status,
            to_char(m."approvedInAt", 'YYYY-MM-DD"T"HH24:MI') AS "approvedInAt",
            to_char(m."approvedOutAt", 'YYYY-MM-DD"T"HH24:MI') AS "approvedOutAt",
            m."reviewedBy", m."reviewNote", m."createdAt",
            s."shiftName"       AS "shiftName",
            s."startTime"       AS "shiftStart",
            s."endTime"         AS "shiftEnd",
            s."crossesMidnight" AS "shiftCrossesMidnight"
     FROM missing_timelog_requests m
     LEFT JOIN LATERAL (
       SELECT sa."shiftName", sa."startTime", sa."endTime", sa."crossesMidnight"
       FROM shift_assignments sa
       WHERE sa."dutyDate" = m."dutyDate"
         AND lower(regexp_replace(btrim(sa."guardName"), '\\s+', ' ', 'g'))
           = lower(regexp_replace(btrim(m."guardName"), '\\s+', ' ', 'g'))
       ORDER BY sa.id LIMIT 1
     ) s ON true
     ${where.replace(/\bstatus\b/g, 'm.status')} ORDER BY m."createdAt" DESC`, vals
  );
  res.json(rows);
});

router.get("/missing-timelog/_stats", requireAuth, async (req, res) => {
  const r = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='Pending')::int pending,
            COUNT(*) FILTER (WHERE status='Approved')::int approved,
            COUNT(*) FILTER (WHERE status='Rejected')::int rejected,
            COUNT(*)::int total
     FROM missing_timelog_requests`
  )).rows[0];
  res.json(r);
});

// Approve or reject. On approval the admin supplies the actual time(s), and we
// create the corresponding attendance punch record(s). Datetimes are local
// 'YYYY-MM-DDTHH:MM' strings from the admin form.
// Body: { decision: 'Approved'|'Rejected', inAt, outAt, reviewNote }
router.patch("/missing-timelog/:id/review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "Approved" && decision !== "Rejected") {
    return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  }
  const note = (req.body?.reviewNote || "").trim();

  const rec = (await pool.query(
    `SELECT * FROM missing_timelog_requests WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Request not found." });
  if (rec.status !== "Pending") return res.status(400).json({ error: "This request has already been reviewed." });

  if (decision === "Rejected") {
    await pool.query(
      `UPDATE missing_timelog_requests
       SET status='Rejected', "reviewedBy"=$1, "reviewedAt"=now(), "reviewNote"=$2 WHERE id=$3`,
      [req.user.username, note, req.params.id]
    );
    return res.json({ ok: true, status: "Rejected" });
  }

  // Approval: validate the required time(s) for the missing type, then create
  // the attendance punch record(s).
  const needIn = rec.missingType === "IN" || rec.missingType === "BOTH";
  const needOut = rec.missingType === "OUT" || rec.missingType === "BOTH";
  const inAt = req.body?.inAt || null;
  const outAt = req.body?.outAt || null;
  if (needIn && !inAt) return res.status(400).json({ error: "Please set the Time In for approval." });
  if (needOut && !outAt) return res.status(400).json({ error: "Please set the Time Out for approval." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The admin enters times as PH-local 'YYYY-MM-DDTHH:MM' (datetime-local).
    // Attendance punches are stored as UTC instants (real punches use now()), and
    // the report builds shift windows in UTC from PH-local times. So we must
    // convert the admin's local value to the matching UTC instant — otherwise the
    // corrected punch lands 8h off and the report won't match it to the shift.
    const PH_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8, no DST
    function toUtcInstant(local) {
      // local = "2026-08-03T18:00" (PH time). Build the UTC instant it represents.
      const [datePart, timePart] = String(local).split("T");
      const [y, mo, d] = datePart.split("-").map(Number);
      const [h, m] = (timePart || "00:00").split(":").map(Number);
      return new Date(Date.UTC(y, mo - 1, d, h, m) - PH_OFFSET_MS);
    }
    async function createPunch(type, at) {
      await client.query(
        `INSERT INTO attendance_records
          ("employeeNo","guardName",site,"punchType","punchAt","createdBy")
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rec.employeeNo || "", rec.guardName, rec.site || "", type, toUtcInstant(at), `correction:${req.user.username}`]
      );
    }
    if (needIn) await createPunch("IN", inAt);
    if (needOut) await createPunch("OUT", outAt);

    await client.query(
      `UPDATE missing_timelog_requests
       SET status='Approved', "approvedInAt"=$1, "approvedOutAt"=$2, "timesNormalized"=true,
           "reviewedBy"=$3, "reviewedAt"=now(), "reviewNote"=$4 WHERE id=$5`,
      // Store the SAME UTC instants written to attendance_records. Previously
      // these were cast with ::timestamp, which hands Postgres a naive local
      // string and stamps it as UTC — leaving the recorded times 8h ahead of
      // the PH times the admin actually entered.
      [needIn ? toUtcInstant(inAt) : null, needOut ? toUtcInstant(outAt) : null, req.user.username, note, req.params.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, status: "Approved" });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Could not apply the correction. Please try again." });
  } finally {
    client.release();
  }
});

router.delete("/missing-timelog/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query("DELETE FROM missing_timelog_requests WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
