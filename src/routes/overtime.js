const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// All overtime records (detected approvals + manual requests) in a date range,
// merged with any saved approval state. The Reports Overtime tab calls this to
// overlay approval status onto detected-OT rows; it also returns manual rows so
// they can be listed even if they have no matching detected row.
router.get("/", requireAuth, async (req, res) => {
  const { from, to, status } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (from) { clauses.push(`"dutyDate" >= $${i++}`); vals.push(from); }
  if (to) { clauses.push(`"dutyDate" <= $${i++}`); vals.push(to); }
  if (status) { clauses.push(`status = $${i++}`); vals.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, "employeeId", "employeeNo", "guardKey", "guardName", site,
            to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            source, "detectedMinutes", "requestedMinutes", "approvedMinutes",
            reason, status, "reviewedBy", "reviewNote",
            to_char("createdAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS "createdAt"
     FROM overtime_records ${where} ORDER BY "dutyDate" DESC, "guardName"`, vals
  );
  res.json(rows);
});

router.get("/_stats", requireAuth, async (req, res) => {
  const r = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='Pending')::int pending,
            COUNT(*) FILTER (WHERE status='Approved')::int approved,
            COUNT(*) FILTER (WHERE status='Rejected')::int rejected,
            COALESCE(SUM("approvedMinutes") FILTER (WHERE status='Approved'),0)::int "approvedMinutes"
     FROM overtime_records`
  )).rows[0];
  res.json(r);
});

// Approve or reject a DETECTED overtime day. The report gives us the guard +
// date + detected minutes; we upsert an approval row keyed by guardKey+date.
// Body: { guardName, employeeNo, site, dutyDate, detectedMinutes, decision, approvedMinutes, reviewNote }
router.put("/detected", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.guardName || !b.dutyDate) return res.status(400).json({ error: "Guard and date are required." });
  const decision = ["Approved", "Rejected"].includes(b.decision) ? b.decision : "Pending";
  const detected = Number.isFinite(+b.detectedMinutes) ? Math.round(+b.detectedMinutes) : null;
  // Approved amount defaults to detected; admin may override.
  let approved = null;
  if (decision === "Approved") {
    approved = Number.isFinite(+b.approvedMinutes) ? Math.round(+b.approvedMinutes) : detected;
    if (approved != null && approved < 0) approved = 0;
  }
  const guardKey = norm(b.guardName);

  const emp = (await pool.query(`SELECT id FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [b.employeeNo || ""])).rows[0];

  const { rows } = await pool.query(
    `INSERT INTO overtime_records
      ("employeeId","employeeNo","guardKey","guardName",site,"dutyDate",source,"detectedMinutes","approvedMinutes",status,"reviewedBy","reviewedAt","reviewNote","createdBy")
     VALUES ($1,$2,$3,$4,$5,$6::date,'detected',$7,$8,$9,$10,now(),$11,$12)
     ON CONFLICT ("guardKey","dutyDate",source)
     DO UPDATE SET status=EXCLUDED.status, "approvedMinutes"=EXCLUDED."approvedMinutes",
                   "detectedMinutes"=EXCLUDED."detectedMinutes", site=EXCLUDED.site,
                   "employeeNo"=EXCLUDED."employeeNo", "guardName"=EXCLUDED."guardName",
                   "reviewedBy"=EXCLUDED."reviewedBy", "reviewedAt"=now(), "reviewNote"=EXCLUDED."reviewNote"
     RETURNING id, status, "approvedMinutes"`,
    [emp ? emp.id : null, b.employeeNo || "", guardKey, b.guardName, b.site || "", b.dutyDate,
     detected, approved, decision, req.user.username, (b.reviewNote || "").trim(), req.user.username]
  );
  res.json({ ok: true, ...rows[0] });
});

// Review a MANUAL/guard-filed OT request (already a row). Sets approved minutes.
// Body: { decision, approvedMinutes, reviewNote }
router.patch("/:id/review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (!["Approved", "Rejected"].includes(decision)) return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  const rec = (await pool.query(`SELECT * FROM overtime_records WHERE id = $1`, [req.params.id])).rows[0];
  if (!rec) return res.status(404).json({ error: "Overtime request not found." });

  let approved = null;
  if (decision === "Approved") {
    approved = Number.isFinite(+req.body?.approvedMinutes) ? Math.round(+req.body.approvedMinutes)
      : (rec.requestedMinutes != null ? rec.requestedMinutes : rec.detectedMinutes);
    if (approved != null && approved < 0) approved = 0;
  }
  await pool.query(
    `UPDATE overtime_records
     SET status=$1, "approvedMinutes"=$2, "reviewedBy"=$3, "reviewedAt"=now(), "reviewNote"=$4 WHERE id=$5`,
    [decision, approved, req.user.username, (req.body?.reviewNote || "").trim(), req.params.id]
  );
  res.json({ ok: true, status: decision, approvedMinutes: approved });
});

// Admin files a manual OT record.
// Body: { employeeId, dutyDate, requestedMinutes, reason }
router.post("/manual", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });
  if (!b.dutyDate) return res.status(400).json({ error: "Date is required." });
  const reqMin = Math.round(+b.requestedMinutes);
  if (!Number.isFinite(reqMin) || reqMin <= 0) return res.status(400).json({ error: "Please enter the overtime minutes." });

  const emp = (await pool.query(`SELECT id, "fullName", "employeeNo", site FROM employees WHERE id = $1`, [b.employeeId])).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected guard not found." });

  try {
    const { rows } = await pool.query(
      `INSERT INTO overtime_records
        ("employeeId","employeeNo","guardKey","guardName",site,"dutyDate",source,"requestedMinutes",reason,status,"createdBy")
       VALUES ($1,$2,$3,$4,$5,$6::date,'manual',$7,$8,'Pending',$9)
       RETURNING id`,
      [emp.id, emp.employeeNo || "", norm(emp.fullName), emp.fullName, emp.site || "", b.dutyDate, reqMin, (b.reason || "").trim(), req.user.username]
    );
    res.status(201).json({ id: rows[0].id, ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "A manual OT record already exists for this guard and date." });
    throw e;
  }
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query("DELETE FROM overtime_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
