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
  const { rows } = await pool.query(
    `SELECT id, "employeeId", "employeeNo", "guardName", site,
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            "missingType", reason, status,
            to_char("approvedInAt", 'YYYY-MM-DD"T"HH24:MI') AS "approvedInAt",
            to_char("approvedOutAt", 'YYYY-MM-DD"T"HH24:MI') AS "approvedOutAt",
            "reviewedBy", "reviewNote", "createdAt"
     FROM missing_timelog_requests ${where} ORDER BY "createdAt" DESC`, vals
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
    async function createPunch(type, at) {
      await client.query(
        `INSERT INTO attendance_records
          ("employeeNo","guardName",site,"punchType","punchAt","createdBy")
         VALUES ($1,$2,$3,$4,$5::timestamp,$6)`,
        [rec.employeeNo || "", rec.guardName, rec.site || "", type, at, `correction:${req.user.username}`]
      );
    }
    if (needIn) await createPunch("IN", inAt);
    if (needOut) await createPunch("OUT", outAt);

    await client.query(
      `UPDATE missing_timelog_requests
       SET status='Approved', "approvedInAt"=$1::timestamp, "approvedOutAt"=$2::timestamp,
           "reviewedBy"=$3, "reviewedAt"=now(), "reviewNote"=$4 WHERE id=$5`,
      [needIn ? inAt : null, needOut ? outAt : null, req.user.username, note, req.params.id]
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
