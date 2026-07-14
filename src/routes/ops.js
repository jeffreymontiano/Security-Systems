const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const VALID_TYPES = [
  "guard_deployment", "site_status", "duty_roster", "gps_monitoring",
  "visitor_count", "vehicle_count", "daily_metrics"
];

function checkType(req, res, next) {
  if (!VALID_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: "Unknown record type." });
  }
  next();
}

const PERIOD_TRUNC = { daily: "day", weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };
const PERIOD_LIMIT = { daily: 14, weekly: 12, monthly: 12, quarterly: 8, yearly: 5 };

// Time-bucketed counts/sums for column charts (site status activity, visitor/vehicle counts).
// Registered before "/:type" so "timeseries" as a second path segment never gets swallowed by it
// (they're different segment counts anyway, but keeping related routes together for clarity).
router.get("/:type/timeseries", requireAuth, checkType, async (req, res) => {
  const period = req.query.period || "daily";
  const trunc = PERIOD_TRUNC[period];
  if (!trunc) return res.status(400).json({ error: "Invalid period. Use daily, weekly, monthly, quarterly, or yearly." });
  const limit = PERIOD_LIMIT[period];
  const site = (req.query.site || "").trim();

  const params = [trunc, req.params.type];
  let siteClause = "";
  if (site) {
    params.push(site);
    siteClause = ` AND site = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT to_char(date_trunc($1, date::date), 'YYYY-MM-DD') AS bucket,
            COUNT(*)::int AS count,
            SUM(CASE WHEN value ~ '^[0-9]+(\\.[0-9]+)?$' THEN value::numeric ELSE 0 END) AS total_value
     FROM ops_records
     WHERE record_type = $2${siteClause}
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows.reverse());
});

// List records of a given type — any authenticated role, newest first.
// Optional ?limit= to cap results (defaults to 200).
router.get("/:type", requireAuth, checkType, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const { rows } = await pool.query(
    `SELECT * FROM ops_records WHERE record_type = $1 ORDER BY date DESC, id DESC LIMIT $2`,
    [req.params.type, limit]
  );
  res.json(rows);
});

router.post("/:type", requireAuth, requireRole("Admin", "Investigator"), checkType, async (req, res) => {
  const b = req.body || {};
  if (!b.label || !b.label.trim()) return res.status(400).json({ error: "This field is required." });
  const { rows } = await pool.query(
    `INSERT INTO ops_records (record_type, date, site, label, status, value, notes, "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      req.params.type, b.date || new Date().toISOString().slice(0, 10), b.site || "",
      b.label.trim(), b.status || "", b.value || "", b.notes || "", req.user.username
    ]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:type/:id", requireAuth, requireRole("Admin", "Investigator"), checkType, async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM ops_records WHERE id = $1 AND record_type = $2", [req.params.id, req.params.type]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Record not found." });

  const fieldMap = { date: "date", site: "site", label: "label", status: "status", value: "value", notes: "notes" };
  const b = req.body || {};
  if (b.label !== undefined && !b.label.trim()) {
    return res.status(400).json({ error: "This field is required." });
  }
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(typeof b[f] === "string" ? b[f].trim() : b[f]); }
  });
  if (setClauses.length === 0) return res.json(existing);
  setClauses.push(`"updatedAt" = now()`);
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE ops_records SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  res.json(rows[0]);
});

router.delete("/:type/:id", requireAuth, requireRole("Admin"), checkType, async (req, res) => {
  const existing = (await pool.query(
    "SELECT id FROM ops_records WHERE id = $1 AND record_type = $2", [req.params.id, req.params.type]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Record not found." });
  await pool.query("DELETE FROM ops_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
