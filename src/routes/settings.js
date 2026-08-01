const express = require("express");
const multer = require("multer");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// PNG/JPEG only, so the same image works both in the web UI and embedded in
// PDFs (pdfkit only accepts PNG/JPEG). 4MB cap is plenty for a logo.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Logo must be a PNG or JPEG image."));
  }
});

// Read the single settings row. Any authenticated user can read it, since every
// page/header needs the company name + logo. The logo bytes are NOT returned
// here — only a flag plus a cache-busting token — so this stays lightweight;
// the image itself is served by the endpoint below.
router.get("/", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT "companyName", "logoMimetype", "updatedAt" FROM app_settings WHERE id = 1`
  )).rows[0] || { companyName: "Brookside Farms Corporation", logoMimetype: null, updatedAt: null };
  res.json({
    companyName: row.companyName,
    hasLogo: !!row.logoMimetype,
    // Token changes whenever settings are updated, so <img> URLs bust cache.
    logoVersion: row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
  });
});

// Serve the logo image. Authenticated (so it's protected like other assets),
// but any role can view it. Returns 404 when no logo is set, so the UI can fall
// back to the default mark.
router.get("/logo", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT "logoData", "logoMimetype" FROM app_settings WHERE id = 1`
  )).rows[0];
  if (!row || !row.logoData) return res.status(404).json({ error: "No logo set." });
  res.set("Content-Type", row.logoMimetype);
  res.set("Cache-Control", "no-cache");
  res.send(row.logoData);
});

// Update the company name. Admin only.
router.patch("/", requireAuth, requireRole("Admin"), async (req, res) => {
  const name = (req.body?.companyName || "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required." });
  await pool.query(
    `UPDATE app_settings SET "companyName" = $1, "updatedBy" = $2, "updatedAt" = now() WHERE id = 1`,
    [name, req.user.username]
  );
  res.json({ ok: true, companyName: name });
});

// Upload / replace the logo. Admin only.
router.post("/logo", requireAuth, requireRole("Admin"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    await pool.query(
      `UPDATE app_settings
       SET "logoData" = $1, "logoMimetype" = $2, "logoFilename" = $3, "updatedBy" = $4, "updatedAt" = now()
       WHERE id = 1`,
      [req.file.buffer, req.file.mimetype, req.file.originalname, req.user.username]
    );
    res.status(201).json({ ok: true });
  });
});

// Remove the logo (revert to default mark). Admin only.
router.delete("/logo", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query(
    `UPDATE app_settings SET "logoData" = NULL, "logoMimetype" = NULL, "logoFilename" = NULL, "updatedBy" = $1, "updatedAt" = now() WHERE id = 1`,
    [req.user.username]
  );
  res.json({ ok: true });
});

module.exports = router;
