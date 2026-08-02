const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// List leave records, optional filters: ?status=&from=&to=&employeeId=
router.get("/", requireAuth, async (req, res) => {
  const { status, from, to, employeeId } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (status) { clauses.push(`status = $${i++}`); vals.push(status); }
  if (employeeId) { clauses.push(`"employeeId" = $${i++}`); vals.push(employeeId); }
  // Overlap: a record overlaps [from,to] if it starts on/before `to` and ends on/after `from`.
  if (from) { clauses.push(`"toDate" >= $${i++}`); vals.push(from); }
  if (to) { clauses.push(`"fromDate" <= $${i++}`); vals.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, "employeeId", "employeeName", "employeeNo", "leaveType",
            to_char("fromDate", 'YYYY-MM-DD') AS "fromDate",
            to_char("toDate", 'YYYY-MM-DD') AS "toDate",
            reason, status, "reviewedBy", "reviewedAt", "reviewNote", "createdBy", "createdAt"
     FROM leave_records ${where} ORDER BY "createdAt" DESC`, vals
  );
  res.json(rows);
});

// Summary counts for the cards.
router.get("/_all/stats", requireAuth, async (req, res) => {
  const r = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'Pending')::int pending,
       COUNT(*) FILTER (WHERE status = 'Approved')::int approved,
       COUNT(*) FILTER (WHERE status = 'Rejected')::int rejected,
       COUNT(*)::int total
     FROM leave_records`
  )).rows[0];
  res.json(r);
});

// Employee picker (active, from 201 File).
router.get("/employees", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, "fullName", "employeeNo", site FROM employees
     WHERE "employmentStatus" = 'Active' ORDER BY "fullName"`
  );
  res.json(rows);
});

// Leave types (from Manage Lists dropdown_options).
router.get("/types", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value FROM dropdown_options WHERE list_key = 'leave_records_type' ORDER BY id`
  );
  res.json(rows.map(r => r.value));
});

// Create a leave request (defaults to Pending).
router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId) return res.status(400).json({ error: "Please select an employee." });
  if (!b.leaveType || !b.leaveType.trim()) return res.status(400).json({ error: "Please choose a leave type." });
  if (!b.fromDate || !b.toDate) return res.status(400).json({ error: "From and to dates are required." });
  if (b.toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const emp = (await pool.query(
    `SELECT "fullName", "employeeNo" FROM employees WHERE id = $1`, [b.employeeId]
  )).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected employee not found." });

  const { rows } = await pool.query(
    `INSERT INTO leave_records
      ("employeeId","employeeName","employeeNo","leaveType","fromDate","toDate",reason,status,"createdBy")
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,'Pending',$8)
     RETURNING id`,
    [b.employeeId, emp.fullName, emp.employeeNo || "", b.leaveType.trim(), b.fromDate, b.toDate, (b.reason || "").trim(), req.user.username]
  );
  res.status(201).json({ id: rows[0].id, ok: true });
});

// Approve or reject. Admin/Investigator only.
router.patch("/:id/review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "Approved" && decision !== "Rejected") {
    return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  }
  const note = (req.body?.reviewNote || "").trim();
  const { rowCount } = await pool.query(
    `UPDATE leave_records
     SET status = $1, "reviewedBy" = $2, "reviewedAt" = now(), "reviewNote" = $3
     WHERE id = $4`,
    [decision, req.user.username, note, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: "Leave record not found." });
  res.json({ ok: true, status: decision });
});

// Edit a pending record (dates/type/reason). Once reviewed, it's locked.
router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT status FROM leave_records WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Leave record not found." });
  if (existing.status !== "Pending") return res.status(400).json({ error: "Only pending requests can be edited." });

  const b = req.body || {};
  const map = { leaveType: '"leaveType"', fromDate: '"fromDate"', toDate: '"toDate"', reason: "reason" };
  const set = []; const vals = []; let i = 1;
  for (const k of Object.keys(map)) {
    if (b[k] !== undefined) {
      set.push(k === "fromDate" || k === "toDate" ? `${map[k]} = $${i++}::date` : `${map[k]} = $${i++}`);
      vals.push(b[k]);
    }
  }
  if (set.length === 0) return res.json({ ok: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE leave_records SET ${set.join(", ")} WHERE id = $${i}`, vals);
  res.json({ ok: true });
});

// Delete. Admin only.
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  if (req.user.role !== "Admin") return res.status(403).json({ error: "Only an Admin can delete leave records." });
  await pool.query("DELETE FROM leave_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
