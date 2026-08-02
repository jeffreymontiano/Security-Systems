const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// List attendance records (metadata only, no selfie blobs). Any authenticated
// user can view the register; selfie image is fetched on demand.
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, "employeeNo", "guardName", site, "punchType", "punchAt", "selfieMimetype",
            latitude, longitude, "createdBy", "createdAt"
     FROM attendance_records ORDER BY "punchAt" DESC`
  );
  // Attach a convenience Google Maps link (no external service needed).
  const withLinks = rows.map(r => ({
    ...r,
    hasSelfie: !!r.selfieMimetype,
    mapsUrl: (r.latitude != null && r.longitude != null)
      ? `https://maps.google.com/?q=${r.latitude},${r.longitude}`
      : null,
  }));
  res.json(withLinks);
});

// Summary stats for the register cards.
router.get("/_all/stats", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [totals, todayCounts, bySite] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int total FROM attendance_records`),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE "punchType" = 'IN')::int ins,
         COUNT(*) FILTER (WHERE "punchType" = 'OUT')::int outs
       FROM attendance_records WHERE "punchAt"::date = $1`, [today]
    ),
    pool.query(`SELECT site, COUNT(*)::int c FROM attendance_records GROUP BY site ORDER BY c DESC`),
  ]);
  res.json({
    total: totals.rows[0].total,
    todayIn: todayCounts.rows[0].ins,
    todayOut: todayCounts.rows[0].outs,
    bySite: bySite.rows,
  });
});

// Serve a selfie image. Authenticated (unlike the company logo, a guard selfie
// is personal data, so it stays behind auth and is loaded via the app's
// blob-fetch helper, not a bare <img src>).
router.get("/:id/selfie", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT "selfieData", "selfieMimetype" FROM attendance_records WHERE id = $1`, [req.params.id]
  );
  const row = rows[0];
  if (!row || !row.selfieData) return res.status(404).json({ error: "No selfie for this record." });
  res.set("Content-Type", row.selfieMimetype);
  res.set("Cache-Control", "no-cache");
  res.send(row.selfieData);
});

// Delete a record - Admin only.
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  if (req.user.role !== "Admin") return res.status(403).json({ error: "Only an Admin can delete attendance records." });
  await pool.query("DELETE FROM attendance_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
