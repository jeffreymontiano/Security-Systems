const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// ---- Shift templates -------------------------------------------------------

router.get("/templates", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM shift_templates WHERE active = true ORDER BY site, "startTime"`
  );
  res.json(rows);
});

router.post("/templates", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: "Shift name is required." });
  if (!b.startTime || !b.endTime) return res.status(400).json({ error: "Start and end times are required." });
  const crosses = !!b.crossesMidnight;
  const { rows } = await pool.query(
    `INSERT INTO shift_templates (name, site, "startTime", "endTime", "crossesMidnight", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.name.trim(), b.site || "", b.startTime, b.endTime, crosses, req.user.username]
  );
  res.status(201).json(rows[0]);
});

router.patch("/templates/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM shift_templates WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Shift template not found." });
  const map = { name: "name", site: "site", startTime: '"startTime"', endTime: '"endTime"', crossesMidnight: '"crossesMidnight"' };
  const b = req.body || {};
  const set = []; const vals = []; let i = 1;
  Object.keys(map).forEach((f) => { if (b[f] !== undefined) { set.push(`${map[f]} = $${i++}`); vals.push(b[f]); } });
  if (set.length === 0) return res.json(existing);
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE shift_templates SET ${set.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  res.json(rows[0]);
});

// Soft-delete (deactivate) so historical assignments keep their reference.
router.delete("/templates/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("UPDATE shift_templates SET active = false WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Employee picker (from the 201 File) -----------------------------------
// Lightweight list for the "assign guard" dropdown.
router.get("/employees", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, "fullName", "employeeNo", site FROM employees
     WHERE "employmentStatus" = 'Active' ORDER BY "fullName"`
  );
  res.json(rows);
});

// ---- Assignments (the per-day roster) --------------------------------------

// List assignments, optionally filtered by a date range and/or site.
router.get("/assignments", requireAuth, async (req, res) => {
  const { from, to, site } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (from) { clauses.push(`sa."dutyDate" >= $${i++}`); vals.push(from); }
  if (to)   { clauses.push(`sa."dutyDate" <= $${i++}`); vals.push(to); }
  if (site) { clauses.push(`sa.site = $${i++}`); vals.push(site); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT sa.id, sa."employeeId", sa."guardName", sa.site, sa."shiftTemplateId", sa."shiftName",
            sa."startTime", sa."endTime", sa."crossesMidnight",
            to_char(sa."dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            sa.notes, sa."createdBy", sa."createdAt",
            e."employeeNo" AS "employeeNo"
     FROM shift_assignments sa
     LEFT JOIN employees e ON e.id = sa."employeeId"
     ${where} ORDER BY sa."dutyDate", sa.site, sa."startTime"`, vals
  );
  res.json(rows);
});

// Create an assignment. Snapshots the template's name/times onto the row so the
// roster stays accurate even if the template is later edited or deactivated.
router.post("/assignments", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.dutyDate) return res.status(400).json({ error: "Duty date is required." });
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });

  const emp = (await pool.query(`SELECT id, "fullName" FROM employees WHERE id = $1`, [b.employeeId])).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected guard not found." });

  let tmpl = null;
  if (b.shiftTemplateId) {
    tmpl = (await pool.query("SELECT * FROM shift_templates WHERE id = $1", [b.shiftTemplateId])).rows[0];
    if (!tmpl) return res.status(400).json({ error: "Selected shift not found." });
  }

  // Explicit duplicate pre-check (same guard, same day, same shift). Compares on
  // the normalized date so a timezone-shifted stored value can't cause a
  // confusing collision. Clearer than relying on the DB constraint alone.
  const dupe = (await pool.query(
    `SELECT id FROM shift_assignments
     WHERE "employeeId" = $1
       AND "dutyDate" = $2::date
       AND "shiftTemplateId" IS NOT DISTINCT FROM $3`,
    [emp.id, b.dutyDate, tmpl ? tmpl.id : null]
  )).rows[0];
  if (dupe) return res.status(409).json({ error: "This guard is already assigned to that shift on that date." });

  try {
    // A shift and a rest day can't coexist on the same date — remove any rest
    // day for this guard+date so assigning a shift replaces it.
    await pool.query(
      `DELETE FROM rest_days WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, b.dutyDate]
    );
    const { rows } = await pool.query(
      `INSERT INTO shift_assignments
        ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11)
       RETURNING id, "employeeId", "guardName", site, "shiftTemplateId", "shiftName",
                 "startTime", "endTime", "crossesMidnight",
                 to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes`,
      [
        emp.id, emp.fullName, b.site || (tmpl ? tmpl.site : "") || "",
        tmpl ? tmpl.id : null, tmpl ? tmpl.name : (b.shiftName || ""),
        tmpl ? tmpl.startTime : (b.startTime || null),
        tmpl ? tmpl.endTime : (b.endTime || null),
        tmpl ? tmpl.crossesMidnight : !!b.crossesMidnight,
        b.dutyDate, b.notes || "", req.user.username
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "This guard is already assigned to that shift on that date." });
    throw e;
  }
});

router.delete("/assignments/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM shift_assignments WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// Assign a guard to a shift across a date range (inclusive). Creates one row per
// day; days already assigned to that guard+shift are skipped (not errored), so
// overlapping ranges are safe. Returns counts of created vs skipped.
router.post("/assignments/range", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });
  if (!b.fromDate) return res.status(400).json({ error: "A start date is required." });
  const toDate = b.toDate || b.fromDate;
  if (toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const emp = (await pool.query(`SELECT id, "fullName" FROM employees WHERE id = $1`, [b.employeeId])).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected guard not found." });

  let tmpl = null;
  if (b.shiftTemplateId) {
    tmpl = (await pool.query("SELECT * FROM shift_templates WHERE id = $1", [b.shiftTemplateId])).rows[0];
    if (!tmpl) return res.status(400).json({ error: "Selected shift not found." });
  }

  // Guard against an accidentally huge range.
  const span = (await pool.query(`SELECT ($1::date - $2::date) AS days`, [toDate, b.fromDate])).rows[0].days;
  if (span > 366) return res.status(400).json({ error: "That date range is too large (max 1 year)." });

  const site = b.site || (tmpl ? tmpl.site : "") || "";
  let created = 0, skipped = 0;
  // Iterate day by day using a generated date series in SQL for correctness.
  const days = (await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series($1::date, $2::date, INTERVAL '1 day') d`,
    [b.fromDate, toDate]
  )).rows.map((r) => r.day);

  for (const day of days) {
    const dupe = (await pool.query(
      `SELECT id FROM shift_assignments
       WHERE "employeeId" = $1 AND "dutyDate" = $2::date AND "shiftTemplateId" IS NOT DISTINCT FROM $3`,
      [emp.id, day, tmpl ? tmpl.id : null]
    )).rows[0];
    if (dupe) { skipped++; continue; }
    // Remove any rest day on this date — a day can't be both a shift and a rest day.
    await pool.query(
      `DELETE FROM rest_days WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, day]
    );
    await pool.query(
      `INSERT INTO shift_assignments
        ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11)`,
      [
        emp.id, emp.fullName, site,
        tmpl ? tmpl.id : null, tmpl ? tmpl.name : (b.shiftName || ""),
        tmpl ? tmpl.startTime : (b.startTime || null),
        tmpl ? tmpl.endTime : (b.endTime || null),
        tmpl ? tmpl.crossesMidnight : !!b.crossesMidnight,
        day, b.notes || "", req.user.username
      ]
    );
    created++;
  }
  res.status(201).json({ created, skipped, days: days.length });
});

// Remove all of a guard's assignments within a date range (inclusive).
router.post("/assignments/remove-range", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });
  if (!b.fromDate) return res.status(400).json({ error: "A start date is required." });
  const toDate = b.toDate || b.fromDate;
  if (toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const result = await pool.query(
    `DELETE FROM shift_assignments
     WHERE "employeeId" = $1 AND "dutyDate" >= $2::date AND "dutyDate" <= $3::date`,
    [b.employeeId, b.fromDate, toDate]
  );
  res.json({ removed: result.rowCount });
});

// "Copy previous week": duplicate every assignment in [fromStart, fromStart+6]
// forward by 7 days. Skips rows that would collide with an existing assignment
// (same guard/date/shift), so it's safe to run repeatedly.
router.post("/assignments/copy-week", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { fromStart } = req.body || {};
  if (!fromStart) return res.status(400).json({ error: "A source week start date is required." });

  const src = (await pool.query(
    `SELECT * FROM shift_assignments WHERE "dutyDate" >= $1 AND "dutyDate" < ($1::date + INTERVAL '7 days')`,
    [fromStart]
  )).rows;
  if (src.length === 0) return res.json({ copied: 0, skipped: 0, message: "No assignments found in that week." });

  let copied = 0, skipped = 0;
  for (const a of src) {
    try {
      await pool.query(
        `INSERT INTO shift_assignments
          ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "dutyDate", notes, "createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ($9::date + INTERVAL '7 days'), $10,$11)`,
        [a.employeeId, a.guardName, a.site, a.shiftTemplateId, a.shiftName, a.startTime, a.endTime, a.crossesMidnight, a.dutyDate, a.notes, req.user.username]
      );
      copied++;
    } catch (e) {
      if (e.code === "23505") { skipped++; continue; }
      throw e;
    }
  }
  res.json({ copied, skipped });
});

// ---- Rest days -------------------------------------------------------------
// Explicit rest days (separate from shift assignments). A day with no shift is
// already an implicit rest day; these records let an admin mark one intentionally
// so it shows on the roster and reads "Rest Day" in attendance reports.

// List rest days in a date range, optionally by site.
router.get("/rest-days", requireAuth, async (req, res) => {
  const { from, to, site } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (from) { clauses.push(`rd."dutyDate" >= $${i++}`); vals.push(from); }
  if (to)   { clauses.push(`rd."dutyDate" <= $${i++}`); vals.push(to); }
  if (site) { clauses.push(`rd.site = $${i++}`); vals.push(site); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT rd.id, rd."employeeId", rd."guardName", rd.site,
            to_char(rd."dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            rd.notes, rd."createdBy", rd."createdAt",
            e."employeeNo" AS "employeeNo"
     FROM rest_days rd
     LEFT JOIN employees e ON e.id = rd."employeeId"
     ${where} ORDER BY rd."dutyDate", rd.site, rd."guardName"`, vals
  );
  res.json(rows);
});

// Mark a single rest day for a guard. If a shift already exists for that
// guard+date, the caller should remove it first (a day can't be both).
router.post("/rest-days", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.dutyDate) return res.status(400).json({ error: "Duty date is required." });
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });

  const emp = (await pool.query(`SELECT id, "fullName", site FROM employees WHERE id = $1`, [b.employeeId])).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected guard not found." });

  const site = b.site || emp.site || "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A rest day and a shift can't coexist on the same date — remove any shift
    // for this guard+date first, so marking a rest day replaces the shift.
    await client.query(
      `DELETE FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, b.dutyDate]
    );
    const { rows } = await client.query(
      `INSERT INTO rest_days ("employeeId", "guardName", site, "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4::date,$5,$6)
       ON CONFLICT ("employeeId", "dutyDate") DO NOTHING
       RETURNING id, "employeeId", "guardName", site,
                 to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes`,
      [emp.id, emp.fullName, site, b.dutyDate, b.notes || "", req.user.username]
    );
    await client.query("COMMIT");
    // If ON CONFLICT skipped the insert, the rest day already existed — fetch it.
    if (rows.length === 0) {
      const existing = (await pool.query(
        `SELECT id, "employeeId", "guardName", site,
                to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes
         FROM rest_days WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
        [emp.id, b.dutyDate]
      )).rows[0];
      return res.status(200).json(existing);
    }
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// Mark rest days across a date range (inclusive). Days already marked are
// skipped (not errored). Returns counts of created vs skipped.
router.post("/rest-days/range", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId) return res.status(400).json({ error: "Please select a guard." });
  if (!b.fromDate) return res.status(400).json({ error: "A start date is required." });
  const toDate = b.toDate || b.fromDate;
  if (toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const emp = (await pool.query(`SELECT id, "fullName", site FROM employees WHERE id = $1`, [b.employeeId])).rows[0];
  if (!emp) return res.status(400).json({ error: "Selected guard not found." });

  const span = (await pool.query(`SELECT ($1::date - $2::date) AS days`, [toDate, b.fromDate])).rows[0].days;
  if (span > 366) return res.status(400).json({ error: "That date range is too large (max 1 year)." });

  const site = b.site || emp.site || "";
  const days = (await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series($1::date, $2::date, INTERVAL '1 day') d`,
    [b.fromDate, toDate]
  )).rows.map((r) => r.day);

  let created = 0, skipped = 0;
  for (const day of days) {
    const dupe = (await pool.query(
      `SELECT id FROM rest_days WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, day]
    )).rows[0];
    if (dupe) { skipped++; continue; }
    // Remove any shift on this date first — a day can't be both a shift and a rest day.
    await pool.query(
      `DELETE FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, day]
    );
    await pool.query(
      `INSERT INTO rest_days ("employeeId", "guardName", site, "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4::date,$5,$6)`,
      [emp.id, emp.fullName, site, day, b.notes || "", req.user.username]
    );
    created++;
  }
  res.status(201).json({ created, skipped, days: days.length });
});

router.delete("/rest-days/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM rest_days WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
