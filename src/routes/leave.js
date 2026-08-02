const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { isGuardPosition, bucketFor, countLeaveDays } = require("../lib/leaveCredits");

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
            reason, status, "reviewedBy", "reviewedAt", "reviewNote", "createdBy", "createdAt",
            "totalDays", "paidDays", "lwopDays", "creditBucket", "isLwop"
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

// Employee picker (active, from 201 File) with current VL/SL credit balances,
// so the New Leave Request modal can show them once an employee is selected.
router.get("/employees", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.id, e."fullName", e."employeeNo", e.site, e.position,
            COALESCE(v.balance, 0) AS "vacationBalance",
            COALESCE(s.balance, 0) AS "sickBalance"
     FROM employees e
     LEFT JOIN leave_credits v ON v."employeeId" = e.id AND v.bucket = 'Vacation'
     LEFT JOIN leave_credits s ON s."employeeId" = e.id AND s.bucket = 'Sick'
     WHERE e."employmentStatus" = 'Active'
     ORDER BY e."fullName"`
  );
  res.json(rows.map(r => ({
    ...r,
    vacationBalance: Number(r.vacationBalance),
    sickBalance: Number(r.sickBalance),
  })));
});

// Leave types (from Manage Lists dropdown_options).
router.get("/types", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value FROM dropdown_options WHERE list_key = 'leave_records_type' ORDER BY id`
  );
  res.json(rows.map(r => r.value));
});

// ---- Leave credits --------------------------------------------------------

// Credit balances for all active employees, with both buckets always present
// (0 when no row exists yet) so the Admin UI can render a complete table.
router.get("/credits", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.id AS "employeeId", e."fullName", e."employeeNo", e.site, e.position,
            COALESCE(v.balance, 0) AS "vacationBalance",
            COALESCE(s.balance, 0) AS "sickBalance"
     FROM employees e
     LEFT JOIN leave_credits v ON v."employeeId" = e.id AND v.bucket = 'Vacation'
     LEFT JOIN leave_credits s ON s."employeeId" = e.id AND s.bucket = 'Sick'
     WHERE e."employmentStatus" = 'Active'
     ORDER BY e."fullName"`
  );
  // NUMERIC comes back as string from pg; coerce to Number for the UI.
  res.json(rows.map(r => ({
    ...r,
    vacationBalance: Number(r.vacationBalance),
    sickBalance: Number(r.sickBalance),
  })));
});

// Set (absolute) or top-up (delta) a single bucket for one employee. Admin only.
// Body: { bucket: 'Vacation'|'Sick', mode: 'set'|'add', amount: number }
router.put("/credits/:employeeId", requireAuth, requireRole("Admin"), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const bucket = req.body?.bucket;
  const mode = req.body?.mode === "add" ? "add" : "set";
  const amount = Number(req.body?.amount);

  if (bucket !== "Vacation" && bucket !== "Sick") {
    return res.status(400).json({ error: "Bucket must be Vacation or Sick." });
  }
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "Amount must be a number." });

  const emp = (await pool.query(`SELECT id FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee not found." });

  // Resolve the new balance. For 'set' it's the amount; for 'add' it's current + amount.
  const existing = (await pool.query(
    `SELECT balance FROM leave_credits WHERE "employeeId" = $1 AND bucket = $2`, [employeeId, bucket]
  )).rows[0];
  const current = existing ? Number(existing.balance) : 0;
  let next = mode === "add" ? current + amount : amount;
  if (next < 0) next = 0; // never store a negative balance

  await pool.query(
    `INSERT INTO leave_credits ("employeeId", bucket, balance, "updatedBy", "updatedAt")
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT ("employeeId", bucket)
     DO UPDATE SET balance = EXCLUDED.balance, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()`,
    [employeeId, bucket, next, req.user.username]
  );
  res.json({ ok: true, bucket, balance: next });
});

// ---- Create -------------------------------------------------------------

// Create a leave request (defaults to Pending). No credits touched here —
// deduction happens on approval.
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

// ---- Review (approve / reject) -----------------------------------------

// Approve or reject. Admin/Investigator only. On APPROVAL we compute the
// number of leave days (by the employee's position), deduct from the correct
// credit bucket, and split any shortfall into Leave Without Pay — all inside a
// transaction so a mid-way failure can't leave credits half-deducted.
router.patch("/:id/review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "Approved" && decision !== "Rejected") {
    return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  }
  const note = (req.body?.reviewNote || "").trim();

  // Rejection is simple: no credit math.
  if (decision === "Rejected") {
    const { rowCount } = await pool.query(
      `UPDATE leave_records
       SET status = 'Rejected', "reviewedBy" = $1, "reviewedAt" = now(), "reviewNote" = $2
       WHERE id = $3`,
      [req.user.username, note, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Leave record not found." });
    return res.json({ ok: true, status: "Rejected" });
  }

  // Approval: do the credit math atomically.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the leave row for this transaction.
    const rec = (await client.query(
      `SELECT id, "employeeId", "leaveType", status,
              to_char("fromDate",'YYYY-MM-DD') AS "fromDate",
              to_char("toDate",'YYYY-MM-DD') AS "toDate"
       FROM leave_records WHERE id = $1 FOR UPDATE`, [req.params.id]
    )).rows[0];
    if (!rec) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Leave record not found." }); }
    if (rec.status === "Approved") { await client.query("ROLLBACK"); return res.status(400).json({ error: "This request is already approved." }); }

    // Position drives the day-count method (guard = calendar, else Mon-Sat).
    const emp = rec.employeeId
      ? (await client.query(`SELECT position FROM employees WHERE id = $1`, [rec.employeeId])).rows[0]
      : null;
    const guard = isGuardPosition(emp?.position);
    const totalDays = countLeaveDays(rec.fromDate, rec.toDate, guard);

    const bucket = bucketFor(rec.leaveType);

    let paidDays = 0, lwopDays = 0, isLwop = false;

    if (bucket === null) {
      // Always-allowed leave (Maternity/Paternity): fully paid, no credits.
      paidDays = totalDays;
    } else {
      // Lock this employee's bucket row (if any) so concurrent approvals can't
      // both spend the same credits.
      const creditRow = rec.employeeId ? (await client.query(
        `SELECT balance FROM leave_credits WHERE "employeeId" = $1 AND bucket = $2 FOR UPDATE`,
        [rec.employeeId, bucket]
      )).rows[0] : null;
      const balance = creditRow ? Number(creditRow.balance) : 0;

      paidDays = Math.min(balance, totalDays);
      lwopDays = totalDays - paidDays;
      isLwop = lwopDays > 0;

      if (paidDays > 0 && rec.employeeId) {
        const newBalance = balance - paidDays;
        await client.query(
          `INSERT INTO leave_credits ("employeeId", bucket, balance, "updatedBy", "updatedAt")
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT ("employeeId", bucket)
           DO UPDATE SET balance = $3, "updatedBy" = $4, "updatedAt" = now()`,
          [rec.employeeId, bucket, newBalance, req.user.username]
        );
      }
    }

    await client.query(
      `UPDATE leave_records
       SET status = 'Approved', "reviewedBy" = $1, "reviewedAt" = now(), "reviewNote" = $2,
           "totalDays" = $3, "paidDays" = $4, "lwopDays" = $5, "creditBucket" = $6, "isLwop" = $7
       WHERE id = $8`,
      [req.user.username, note, totalDays, paidDays, lwopDays, bucket, isLwop, req.params.id]
    );

    await client.query("COMMIT");
    res.json({ ok: true, status: "Approved", totalDays, paidDays, lwopDays, creditBucket: bucket, isLwop });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Could not approve the request. Please try again." });
  } finally {
    client.release();
  }
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

// Delete. Admin only. Note: deleting an approved leave does NOT auto-restore
// credits (approvals are treated as final); an Admin can top the bucket back
// up manually from the Leave Credits section if a correction is needed.
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  if (req.user.role !== "Admin") return res.status(403).json({ error: "Only an Admin can delete leave records." });
  await pool.query("DELETE FROM leave_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
