const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// List attendance records (metadata only, no selfie blobs). Any authenticated
// user can view the register; selfie image is fetched on demand.
router.get("/", requireAuth, async (req, res) => {
  // The LATERAL join answers one question the register cannot answer alone: a
  // punch created by an approved correction has no selfie of its own, but the
  // REQUEST behind it may carry one — plus coordinates and attachments. Both
  // are optional on that form, so a correction request may equally carry
  // nothing, and the register must not offer a link to an empty page.
  const { rows } = await pool.query(
    `SELECT a.id, a."employeeNo", a."guardName", a.site, a."punchType", a."punchAt", a."selfieMimetype",
            a.latitude, a.longitude, a."createdBy", a."createdAt", a."correctionRequestId",
            src."hasEvidence" AS "correctionHasEvidence"
     FROM attendance_records a
     LEFT JOIN LATERAL (
       SELECT (m."selfieMimetype" IS NOT NULL
               OR m.latitude IS NOT NULL
               OR EXISTS (SELECT 1 FROM missing_timelog_attachments t WHERE t.request_id = m.id)
              ) AS "hasEvidence"
       FROM missing_timelog_requests m WHERE m.id = a."correctionRequestId"
     ) src ON true
     ORDER BY a."punchAt" DESC`
  );
  // Attach a convenience Google Maps link (no external service needed).
  const withLinks = rows.map(r => ({
    ...r,
    hasSelfie: !!r.selfieMimetype,
    // Only true when the punch came from a correction AND that request really
    // holds something to look at. Anything else keeps the plain empty state.
    correctionHasEvidence: !!r.correctionRequestId && r.correctionHasEvidence === true,
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
  // Deletion is Admin-only UNLESS an administrator has explicitly granted
  // this user the delete privilege for this module (req.moduleGrant, set by
  // modulePermission). Without that, the Access Privileges screen could
  // grant a delete that this line would silently overrule.
  if (req.user.role !== "Admin" && req.moduleGrant !== true) return res.status(403).json({ error: "Only an Admin can delete attendance records." });
  await pool.query("DELETE FROM attendance_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
