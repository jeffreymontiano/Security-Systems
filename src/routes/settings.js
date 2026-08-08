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
    `SELECT "companyName", "logoMimetype", "updatedAt",
            "agencyTagline", "agencyAddress", "agencyMobile", "agencyEmail",
            "ownerName", "ownerPosition",
            "agencyLtoNo", "adminHeadName", "adminHeadPosition",
            to_char("agencyLtoExpiry",'YYYY-MM-DD') AS "agencyLtoExpiry",
            "agencyContactPerson", "agencyContactMobile",
            "agencyRegion", "agencyRcsuAddressee", "agencyRcsuAttention"
     FROM app_settings WHERE id = 1`
  )).rows[0] || { companyName: "Brookside Farms Corporation", logoMimetype: null, updatedAt: null };
  res.json({
    companyName: row.companyName,
    hasLogo: !!row.logoMimetype,
    // Token changes whenever settings are updated, so <img> URLs bust cache.
    logoVersion: row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
    // Letterhead, used by the Statement of Account. Every field is optional —
    // a blank one simply omits its line from the document.
    agencyTagline: row.agencyTagline || "",
    agencyAddress: row.agencyAddress || "",
    agencyMobile: row.agencyMobile || "",
    agencyEmail: row.agencyEmail || "",
    ownerName: row.ownerName || "",
    ownerPosition: row.ownerPosition || "",
    // Duty Detail Order letterhead: the LTO licence number a PNP inspector
    // checks, and the Admin/Operation head who signs a DDO rather than the
    // owner who signs a Statement of Account.
    agencyLtoNo: row.agencyLtoNo || "",
    adminHeadName: row.adminHeadName || "",
    adminHeadPosition: row.adminHeadPosition || "",
    // Monthly Disposition Report letterhead and filing defaults. The region
    // and addressee are pre-filled onto every new return so they are not
    // re-typed each month; they stay editable on the return itself for a
    // filing that goes to a different region.
    agencyLtoExpiry: row.agencyLtoExpiry || "",
    agencyContactPerson: row.agencyContactPerson || "",
    agencyContactMobile: row.agencyContactMobile || "",
    agencyRegion: row.agencyRegion || "",
    agencyRcsuAddressee: row.agencyRcsuAddressee || "",
    agencyRcsuAttention: row.agencyRcsuAttention || "",
  });
});

// Serve the logo image. PUBLIC (no auth) so a plain <img src> can load it —
// browser image requests can't attach the bearer token. A company logo is
// non-sensitive branding (it also appears on shareable PDF reports), so serving
// it unauthenticated is intentional. Returns 404 when no logo is set, so the UI
// falls back to the default mark.
router.get("/logo", async (req, res) => {
  const row = (await pool.query(
    `SELECT "logoData", "logoMimetype" FROM app_settings WHERE id = 1`
  )).rows[0];
  if (!row || !row.logoData) return res.status(404).json({ error: "No logo set." });
  res.set("Content-Type", row.logoMimetype);
  res.set("Cache-Control", "no-cache");
  res.send(row.logoData);
});

// Update the company name and letterhead. Admin only. Letterhead fields are
// only written when present in the body, so an older client that sends just
// the company name doesn't blank them.
router.patch("/", requireAuth, requireRole("Admin"), async (req, res) => {
  const b = req.body || {};
  const name = (b.companyName || "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required." });
  const field = (k) =>
    (Object.prototype.hasOwnProperty.call(b, k) ? String(b[k] ?? "").trim() : null);
  await pool.query(
    `UPDATE app_settings SET
       "companyName"   = $1,
       "agencyTagline" = COALESCE($2, "agencyTagline"),
       "agencyAddress" = COALESCE($3, "agencyAddress"),
       "agencyMobile"  = COALESCE($4, "agencyMobile"),
       "agencyEmail"   = COALESCE($5, "agencyEmail"),
       "ownerName"     = COALESCE($6, "ownerName"),
       "ownerPosition" = COALESCE($7, "ownerPosition"),
       "agencyLtoNo" = COALESCE($8, "agencyLtoNo"),
       "adminHeadName" = COALESCE($9, "adminHeadName"),
       "adminHeadPosition" = COALESCE($10, "adminHeadPosition"),
       -- NULLIF so clearing the date in the UI stores NULL rather than
       -- failing the DATE cast on an empty string.
       "agencyLtoExpiry" = COALESCE(NULLIF($11,'')::date, "agencyLtoExpiry"),
       "agencyContactPerson" = COALESCE($12, "agencyContactPerson"),
       "agencyContactMobile" = COALESCE($13, "agencyContactMobile"),
       "agencyRegion" = COALESCE($14, "agencyRegion"),
       "agencyRcsuAddressee" = COALESCE($15, "agencyRcsuAddressee"),
       "agencyRcsuAttention" = COALESCE($16, "agencyRcsuAttention"),
       "updatedBy" = $17, "updatedAt" = now()
     WHERE id = 1`,
    [name, field("agencyTagline"), field("agencyAddress"), field("agencyMobile"),
     field("agencyEmail"), field("ownerName"), field("ownerPosition"),
     field("agencyLtoNo"), field("adminHeadName"), field("adminHeadPosition"),
     field("agencyLtoExpiry"), field("agencyContactPerson"), field("agencyContactMobile"),
     field("agencyRegion"), field("agencyRcsuAddressee"), field("agencyRcsuAttention"),
     req.user.username]
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
