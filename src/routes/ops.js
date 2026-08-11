const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Must stay in step with the ops_records record_type CHECK constraint in
// db.js. The retired tabs (duty_roster, gps_monitoring, daily_metrics) are
// still listed: their rows remain in the table, and a type removed from here
// answers "Unknown record type" for data that is already stored.
const VALID_TYPES = [
  "guard_deployment", "site_manning", "patrol_video", "site_status", "duty_roster", "gps_monitoring",
  "visitor_count", "vehicle_count", "daily_metrics",
  "site_profiles", "post_orders", "deployment_planning", "reliever_management",
  "vacancy_tracking", "shift_assignments", "manpower_requirements"
];

// Record types whose rows carry no label. Kept beside VALID_TYPES so the two
// cannot drift: a type added to the tabs without a label field would otherwise
// be rejected on save with "This field is required" and no field to fill.
const LABEL_OPTIONAL = new Set(["site_manning"]);

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

// Per-bucket counts SPLIT BY STATUS, for the stacked trend on Daily Manning
// (on duty vs everything else). The plain timeseries above cannot answer this:
// it returns one row per bucket with no status dimension.
//
// The bucket window is chosen FIRST and joined to, rather than applying LIMIT
// to the grouped rows. Limiting (bucket, status) pairs would cut the oldest
// buckets off mid-way and silently under-report whichever status sorts last.
router.get("/:type/timeseries-by-status", requireAuth, checkType, async (req, res) => {
  const period = req.query.period || "daily";
  const trunc = PERIOD_TRUNC[period];
  if (!trunc) return res.status(400).json({ error: "Invalid period. Use daily, weekly, monthly, quarterly, or yearly." });
  const site = (req.query.site || "").trim();

  const params = [trunc, req.params.type];
  let siteClause = "";
  if (site) { params.push(site); siteClause = ` AND site = $${params.length}`; }
  params.push(PERIOD_LIMIT[period]);

  const { rows } = await pool.query(
    `WITH buckets AS (
       SELECT DISTINCT to_char(date_trunc($1, date::date), 'YYYY-MM-DD') AS bucket
         FROM ops_records
        WHERE record_type = $2${siteClause}
        ORDER BY bucket DESC
        LIMIT $${params.length}
     )
     SELECT b.bucket,
            COALESCE(NULLIF(TRIM(r.status), ''), '(none)') AS status,
            COUNT(*)::int AS count
       FROM ops_records r
       JOIN buckets b
         ON b.bucket = to_char(date_trunc($1, r.date::date), 'YYYY-MM-DD')
      WHERE r.record_type = $2${siteClause.replace(/site =/g, "r.site =")}
      GROUP BY b.bucket, 2
      ORDER BY b.bucket, 2`,
    params
  );
  res.json(rows);
});

// Totals for the analytics header: how many records, how they split by status,
// how they split by site, and the sum of the numeric ones.
//
// Computed in SQL rather than in the browser, because GET /:type caps at 200
// rows. Daily Manning writes one row per guard per day — eleven guards clear
// that inside a month — so a client-side count would quietly describe a
// truncated window and read as though it were the whole period.
//
// `value` is TEXT and holds a NUMBER on visitor/vehicle but a Post Type on
// patrol video, so the sum is guarded by the same regex the timeseries uses.
// Dates are compared as strings: they are stored 'YYYY-MM-DD', which sorts
// correctly, and a ::date cast would throw on any legacy row that is not.
router.get("/:type/summary", requireAuth, checkType, async (req, res) => {
  const site = (req.query.site || "").trim();
  const from = (req.query.from || "").trim();
  const to = (req.query.to || "").trim();

  const where = ["record_type = $1"];
  const params = [req.params.type];
  if (site) { params.push(site); where.push(`site = $${params.length}`); }
  if (from) { params.push(from); where.push(`date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date <= $${params.length}`); }
  const clause = where.join(" AND ");

  const [totals, byStatus, bySite] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN value ~ '^[0-9]+(\\.[0-9]+)?$'
                                THEN value::numeric ELSE 0 END), 0)::float AS "numericTotal"
         FROM ops_records WHERE ${clause}`, params),
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(status), ''), '(none)') AS status, COUNT(*)::int AS count
         FROM ops_records WHERE ${clause}
        GROUP BY 1 ORDER BY count DESC, 1`, params),
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(site), ''), '(no site)') AS site,
              COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN value ~ '^[0-9]+(\\.[0-9]+)?$'
                                THEN value::numeric ELSE 0 END), 0)::float AS "numericTotal"
         FROM ops_records WHERE ${clause}
        GROUP BY 1 ORDER BY count DESC, 1`, params),
  ]);

  res.json({
    total: totals.rows[0].total,
    numericTotal: totals.rows[0].numericTotal,
    byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    bySite: bySite.rows,
  });
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
  // Site Manning Status has no label field: the record IS a site's manning
  // state on a date, and the site has its own column. Every other type still
  // requires one, so a blank label on those is still refused.
  if (!LABEL_OPTIONAL.has(req.params.type) && (!b.label || !b.label.trim())) {
    return res.status(400).json({ error: "This field is required." });
  }
  const { rows } = await pool.query(
    `INSERT INTO ops_records (record_type, date, site, label, status, value, notes, "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      req.params.type, b.date || new Date().toISOString().slice(0, 10), b.site || "",
      (b.label || "").trim(), b.status || "", b.value || "", b.notes || "", req.user.username
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
  if (!LABEL_OPTIONAL.has(req.params.type) && b.label !== undefined && !b.label.trim()) {
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
