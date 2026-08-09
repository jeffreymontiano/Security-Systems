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

// Whether a shift runs past midnight is fully determined by its times: an end
// time at or before the start time can only mean the next day (18:00 -> 06:00).
// It used to rely solely on an admin ticking a checkbox, and an untidied box
// silently produced a NEGATIVE-length shift — which zeroed built-in OT, turned
// the whole shift into "excess" overtime, and inverted the punch-matching
// window so every day read Absent. Derived here so it cannot be got wrong; an
// explicit true from the client is still honoured for same-time 24h shifts.
function derivesCrossesMidnight(startTime, endTime, explicit) {
  if (!startTime || !endTime) return !!explicit;
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
  const s = toMin(startTime), e = toMin(endTime);
  if (Number.isNaN(s) || Number.isNaN(e)) return !!explicit;
  if (e < s) return true;            // 18:00 -> 06:00
  if (e === s) return !!explicit;    // 24h shift only if the admin says so
  return false;                      // 06:00 -> 18:00
}

// Day, Night or Straight Duty. Derived from the times the same way
// crossesMidnight is, so it cannot be got wrong by omission — but an explicit
// choice from the admin always wins, because only they know whether a tour
// booked 06:00-06:00 is a genuine 24-hour straight duty.
//
// A Straight Duty crosses midnight exactly as a night shift does, which is why
// crossesMidnight alone cannot tell the two apart and this column exists.
const SHIFT_KINDS = ["Day", "Night", "Straight"];
function deriveShiftKind(startTime, endTime, crossesMidnight, name, explicit) {
  if (SHIFT_KINDS.includes(explicit)) return explicit;
  const toMin = (t) => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };
  const s = toMin(startTime), e = toMin(endTime);
  if (!Number.isNaN(s) && !Number.isNaN(e)) {
    // 20 hours or more is a straight duty; the threshold sits below 24 so a
    // tour booked 06:00-05:00 is not miscalled a night shift.
    const span = e + (crossesMidnight ? 1440 : 0) - s;
    if (span >= 1200) return "Straight";
  }
  if (crossesMidnight || /night/i.test(String(name || ""))) return "Night";
  return "Day";
}

router.post("/templates", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: "Shift name is required." });
  if (!b.startTime || !b.endTime) return res.status(400).json({ error: "Start and end times are required." });
  if (b.shiftKind !== undefined && b.shiftKind !== "" && !SHIFT_KINDS.includes(b.shiftKind)) {
    return res.status(400).json({ error: "Shift kind must be Day, Night or Straight." });
  }
  const crosses = derivesCrossesMidnight(b.startTime, b.endTime, b.crossesMidnight);
  const kind = deriveShiftKind(b.startTime, b.endTime, crosses, b.name, b.shiftKind);
  const { rows } = await pool.query(
    `INSERT INTO shift_templates (name, site, "startTime", "endTime", "crossesMidnight", "shiftKind", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.name.trim(), b.site || "", b.startTime, b.endTime, crosses, kind, req.user.username]
  );
  res.status(201).json(rows[0]);
});

router.patch("/templates/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM shift_templates WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Shift template not found." });
  const map = { name: "name", site: "site", startTime: '"startTime"', endTime: '"endTime"', crossesMidnight: '"crossesMidnight"', shiftKind: '"shiftKind"' };
  const b = req.body || {};
  if (b.shiftKind !== undefined && b.shiftKind !== "" && !SHIFT_KINDS.includes(b.shiftKind)) {
    return res.status(400).json({ error: "Shift kind must be Day, Night or Straight." });
  }
  // Re-derive whenever either time changes, so editing a day shift into a night
  // shift can't leave a stale crossesMidnight behind.
  if (b.startTime !== undefined || b.endTime !== undefined) {
    b.crossesMidnight = derivesCrossesMidnight(
      b.startTime !== undefined ? b.startTime : existing.startTime,
      b.endTime !== undefined ? b.endTime : existing.endTime,
      b.crossesMidnight !== undefined ? b.crossesMidnight : existing.crossesMidnight
    );
    // Re-derive the kind too, for the same reason — unless this request states
    // one, in which case the admin's choice stands.
    b.shiftKind = deriveShiftKind(
      b.startTime !== undefined ? b.startTime : existing.startTime,
      b.endTime !== undefined ? b.endTime : existing.endTime,
      b.crossesMidnight,
      b.name !== undefined ? b.name : existing.name,
      b.shiftKind
    );
  }
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
            sa."startTime", sa."endTime", sa."crossesMidnight", sa."shiftKind",
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
        ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "shiftKind", "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12)
       RETURNING id, "employeeId", "guardName", site, "shiftTemplateId", "shiftName",
                 "startTime", "endTime", "crossesMidnight", "shiftKind",
                 to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes`,
      (() => {
        const startTime = tmpl ? tmpl.startTime : (b.startTime || null);
        const endTime = tmpl ? tmpl.endTime : (b.endTime || null);
        const crosses = derivesCrossesMidnight(
          startTime, endTime, tmpl ? tmpl.crossesMidnight : b.crossesMidnight);
        const name = tmpl ? tmpl.name : (b.shiftName || "");
        return [
          emp.id, emp.fullName, b.site || (tmpl ? tmpl.site : "") || "",
          tmpl ? tmpl.id : null, name, startTime, endTime, crosses,
          // Snapshotted from the template, exactly as the name and times are:
          // re-timing or retiring a template must not reclassify a roster entry
          // that has already been worked.
          deriveShiftKind(startTime, endTime, crosses, name,
            tmpl ? tmpl.shiftKind : b.shiftKind),
          b.dutyDate, b.notes || "", req.user.username,
        ];
      })()
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
    // shiftKind is snapshotted here exactly as the single-assignment route
    // does. It used to be omitted, so every assignment made by a range fill
    // carried an empty kind until the next boot backfilled it — and that
    // backfill can only guess from the times, so a template an admin had
    // deliberately classified was silently reclassified. The roster colours
    // and the legend both read this column.
    const rangeStart = tmpl ? tmpl.startTime : (b.startTime || null);
    const rangeEnd = tmpl ? tmpl.endTime : (b.endTime || null);
    const rangeName = tmpl ? tmpl.name : (b.shiftName || "");
    const rangeCrosses = derivesCrossesMidnight(
      rangeStart, rangeEnd, tmpl ? tmpl.crossesMidnight : b.crossesMidnight);
    await pool.query(
      `INSERT INTO shift_assignments
        ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "shiftKind", "dutyDate", notes, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12)`,
      [
        emp.id, emp.fullName, site,
        tmpl ? tmpl.id : null, rangeName, rangeStart, rangeEnd, rangeCrosses,
        deriveShiftKind(rangeStart, rangeEnd, rangeCrosses, rangeName, tmpl ? tmpl.shiftKind : b.shiftKind),
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
        // The SOURCE row's kind is carried across rather than re-derived: if
        // an admin classified last week deliberately, the copy must agree.
        `INSERT INTO shift_assignments
          ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "shiftKind", "dutyDate", notes, "createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ($10::date + INTERVAL '7 days'), $11,$12)`,
        [a.employeeId, a.guardName, a.site, a.shiftTemplateId, a.shiftName, a.startTime, a.endTime, a.crossesMidnight,
         deriveShiftKind(a.startTime, a.endTime, a.crossesMidnight, a.shiftName, a.shiftKind),
         a.dutyDate, a.notes, req.user.username]
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
            rd."prevShiftName",
            (rd."prevShiftName" IS NOT NULL OR rd."prevStartTime" IS NOT NULL OR rd."prevShiftTemplateId" IS NOT NULL) AS "hasPrevShift",
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
    // Capture any shift on this date so removing the rest day can restore it.
    const prev = (await client.query(
      `SELECT "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", notes, site
       FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date
       ORDER BY id LIMIT 1`,
      [emp.id, b.dutyDate]
    )).rows[0] || null;
    // Remove the shift(s) — a rest day replaces the shift.
    await client.query(
      `DELETE FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, b.dutyDate]
    );
    const { rows } = await client.query(
      `INSERT INTO rest_days
        ("employeeId", "guardName", site, "dutyDate", notes, "createdBy",
         "prevShiftTemplateId", "prevShiftName", "prevStartTime", "prevEndTime", "prevCrossesMidnight", "prevNotes", "prevSite", "prevShiftKind")
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT ("employeeId", "dutyDate") DO NOTHING
       RETURNING id, "employeeId", "guardName", site,
                 to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes`,
      [
        emp.id, emp.fullName, site, b.dutyDate, b.notes || "", req.user.username,
        prev ? prev.shiftTemplateId : null, prev ? prev.shiftName : null,
        prev ? prev.startTime : null, prev ? prev.endTime : null,
        prev ? prev.crossesMidnight : null, prev ? prev.notes : null,
        prev ? prev.site : null, prev ? prev.shiftKind : null
      ]
    );
    await client.query("COMMIT");
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
    // Capture any shift on this date so removing the rest day can restore it.
    const prev = (await pool.query(
      `SELECT "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", notes, site
       FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date
       ORDER BY id LIMIT 1`,
      [emp.id, day]
    )).rows[0] || null;
    // Remove any shift on this date — a day can't be both a shift and a rest day.
    await pool.query(
      `DELETE FROM shift_assignments WHERE "employeeId" = $1 AND "dutyDate" = $2::date`,
      [emp.id, day]
    );
    await pool.query(
      `INSERT INTO rest_days
        ("employeeId", "guardName", site, "dutyDate", notes, "createdBy",
         "prevShiftTemplateId", "prevShiftName", "prevStartTime", "prevEndTime", "prevCrossesMidnight", "prevNotes", "prevSite", "prevShiftKind")
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        emp.id, emp.fullName, site, day, b.notes || "", req.user.username,
        prev ? prev.shiftTemplateId : null, prev ? prev.shiftName : null,
        prev ? prev.startTime : null, prev ? prev.endTime : null,
        prev ? prev.crossesMidnight : null, prev ? prev.notes : null,
        prev ? prev.site : null
      ]
    );
    created++;
  }
  res.status(201).json({ created, skipped, days: days.length });
});

router.delete("/rest-days/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rd = (await client.query(
      `SELECT "employeeId", "guardName", "dutyDate", "prevSite", site,
              "prevShiftTemplateId", "prevShiftName", "prevStartTime", "prevEndTime", "prevShiftKind",
              "prevCrossesMidnight", "prevNotes"
       FROM rest_days WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!rd) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Rest day not found." }); }

    await client.query("DELETE FROM rest_days WHERE id = $1", [req.params.id]);

    // If this rest day had displaced a shift, restore it.
    let restored = null;
    const hadShift = rd.prevShiftName || rd.prevStartTime || rd.prevShiftTemplateId;
    if (hadShift && rd.employeeId) {
      const ins = await client.query(
        // The kind is restored from what was displaced, falling back to the
        // derivation only for a rest day recorded before prevShiftKind existed.
        `INSERT INTO shift_assignments
          ("employeeId", "guardName", site, "shiftTemplateId", "shiftName", "startTime", "endTime", "crossesMidnight", "shiftKind", "dutyDate", notes, "createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12)
         ON CONFLICT ("employeeId", "dutyDate", "shiftTemplateId") DO NOTHING
         RETURNING id, "employeeId", "guardName", site, "shiftTemplateId", "shiftName",
                   "startTime", "endTime", "crossesMidnight", "shiftKind",
                   to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", notes`,
        [
          rd.employeeId, rd.guardName, rd.prevSite || rd.site,
          rd.prevShiftTemplateId, rd.prevShiftName,
          rd.prevStartTime, rd.prevEndTime, !!rd.prevCrossesMidnight,
          deriveShiftKind(rd.prevStartTime, rd.prevEndTime, !!rd.prevCrossesMidnight, rd.prevShiftName, rd.prevShiftKind),
          rd.dutyDate, rd.prevNotes || "", req.user.username
        ]
      );
      restored = ins.rows[0] || null;
    }
    await client.query("COMMIT");
    res.json({ ok: true, restored });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

module.exports = router;
