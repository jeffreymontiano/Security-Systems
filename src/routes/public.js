const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { fullIncident, nextIncidentId, log } = require("../lib/incidentHelpers");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument|^text\/plain$/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: images, PDF, Word docs, text files."));
  }
});

// Fairly generous, but enough to blunt casual abuse of a public, unauthenticated endpoint.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions from this network. Please try again later." }
});

// The public form is only reachable at all if an admin has explicitly set a
// share token in the environment. No token configured = feature is off.
function requireFormToken(req, res, next) {
  const configured = process.env.PUBLIC_FORM_TOKEN;
  if (!configured) {
    return res.status(503).json({ error: "The public report form has not been enabled on this server." });
  }
  const supplied = req.query.token || req.body.token || req.headers["x-form-token"];
  if (supplied !== configured) {
    return res.status(403).json({ error: "Invalid or missing form link. Please request a fresh link." });
  }
  next();
}

router.use(publicLimiter);

// Read-only lookups so the public form can populate its Site/Classification dropdowns.
router.get("/meta", requireFormToken, async (req, res) => {
  const [sites, classifications] = await Promise.all([
    pool.query("SELECT name FROM sites ORDER BY id"),
    pool.query("SELECT name FROM classifications ORDER BY id")
  ]);
  res.json({
    sites: sites.rows.map(r => r.name),
    classifications: classifications.rows.map(r => r.name)
  });
});

router.post("/incidents", requireFormToken, async (req, res) => {
  const b = req.body || {};
  // Honeypot: a real browser leaves this hidden field empty; bots that fill
  // every field tend to fill it too. Fail silently-ish so bots don't learn.
  if (b.website) return res.status(201).json({ id: "INC-0000" });

  if (!b.title || !b.title.trim()) return res.status(400).json({ error: "Please describe what happened." });
  if (!b.reporterName || !b.reporterName.trim()) return res.status(400).json({ error: "Please enter your name." });

  const reportedBy = b.reporterContact
    ? `${b.reporterName.trim()} (${b.reporterContact.trim()})`
    : b.reporterName.trim();

  const id = await nextIncidentId();
  await pool.query(
    `INSERT INTO incidents
      (id, title, date, site, classification, severity, description, "reportedBy", assigned, status, "resolvedDate", "rootCause", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'','Open',NULL,'',$9)`,
    [
      id, b.title.trim(), b.date || new Date().toISOString().slice(0, 10), b.site || "Other",
      b.classification || "Other", b.severity || "Medium", b.description || "", reportedBy,
      `public-form:${b.reporterName.trim()}`
    ]
  );
  await log(id, `public-form:${b.reporterName.trim()}`, "created", `${b.title.trim()} (submitted via public report form)`);
  res.status(201).json({ id });
});

router.post("/incidents/:id/attachments", requireFormToken, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const inc = (await pool.query("SELECT id FROM incidents WHERE id = $1", [req.params.id])).rows[0];
    if (!inc) return res.status(404).json({ error: "Incident not found." });
    await pool.query(
      `INSERT INTO attachments (incident_id, filename, mimetype, size, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, "public-form"]
    );
    await log(req.params.id, "public-form", "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

// --- Public Daily Security Report submission ---
function dsrCode(id) { return "DSR-" + String(id).padStart(4, "0"); }

router.post("/dsr", requireFormToken, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ id: 0, code: "DSR-0000" });

  if (!b.date) return res.status(400).json({ error: "Please choose a date." });
  if (!b.submittedBy || !b.submittedBy.trim()) return res.status(400).json({ error: "Please enter your name." });

  const { rows } = await pool.query(
    `INSERT INTO dsr_reports
      (date, site, shift, "submittedBy", "shiftTurnover", "visitorLog", "vehicleLog", "patrolReport", "securityObservations", "siteIssues", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      b.date, b.site || "", b.shift || "", b.submittedBy.trim(), b.shiftTurnover || "",
      b.visitorLog || "", b.vehicleLog || "", b.patrolReport || "", b.securityObservations || "",
      b.siteIssues || "", `public-form:${b.submittedBy.trim()}`
    ]
  );
  const id = rows[0].id;
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [dsrCode(id), `public-form:${b.submittedBy.trim()}`, "created", `Daily Security Report for ${b.date} (submitted via public report form)`]
  );
  res.status(201).json({ id, code: dsrCode(id) });
});

router.post("/dsr/:id/attachments", requireFormToken, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Report not found." });
    await pool.query(
      `INSERT INTO dsr_attachments (dsr_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, "public-form"]
    );
    await pool.query(
      "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
      [dsrCode(req.params.id), "public-form", "attachment_added", req.file.originalname]
    );
    res.status(201).json({ ok: true });
  });
});

module.exports = router;
