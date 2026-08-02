const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { fullIncident, nextIncidentId, log } = require("../lib/incidentHelpers");
const { bucketFor } = require("../lib/leaveCredits");

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

// Company name for the public form headers, so they always match the name set
// in System Settings (CSOMS) instead of a hardcoded value. Token-gated to stay
// consistent with the other public routes. Falls back to the default if the
// settings row is missing.
router.get("/branding", requireFormToken, async (req, res) => {
  const row = (await pool.query(
    `SELECT "companyName" FROM app_settings WHERE id = 1`
  )).rows[0];
  res.json({ companyName: (row && row.companyName) || "Brookside Farms Corporation" });
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

// --- Public Attendance & Timekeeping submission ---
// The guard opens the shared link, picks Site + IN/OUT, takes a selfie (with a
// date/time stamp drawn on it client-side), and the browser captures GPS
// coordinates. Selfie + location are BOTH required. Coordinates are device-
// reported (not tamper-proof) but give a clickable Google Maps location.

// Public employee lookup by number, for the attendance form's confirmation
// step. Token-protected and privacy-minimal: returns ONLY the full name and
// site for a valid employee number — never IDs, government numbers, or other
// 201-File fields. Used so the guard can confirm "is this me?" before submitting.
// Also reused by the public Leave Request form below for the same purpose.
router.get("/employee-lookup", requireFormToken, async (req, res) => {
  const empNo = (req.query.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  const { rows } = await pool.query(
    `SELECT "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Employee number not found. Please check and try again." });
  res.json({ fullName: rows[0].fullName, site: rows[0].site || "" });
});

router.post("/attendance", requireFormToken, (req, res) => {
  upload.single("selfie")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};

    // Honeypot: bots that fill every field trip this hidden one.
    if (b.website) return res.status(201).json({ id: 0 });

    const empNo = (b.employeeNo || "").trim();
    if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
    if (b.punchType !== "IN" && b.punchType !== "OUT") return res.status(400).json({ error: "Please choose Time In or Time Out." });

    // Look up the employee — reject unknown numbers so bad data never enters.
    const emp = (await pool.query(
      `SELECT "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
    )).rows[0];
    if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

    // Both selfie and location are mandatory.
    if (!req.file) return res.status(400).json({ error: "A selfie photo is required to submit." });
    if (!/^image\/(png|jpe?g)$/.test(req.file.mimetype)) {
      return res.status(400).json({ error: "Selfie must be a PNG or JPEG image." });
    }
    const lat = parseFloat(b.latitude);
    const lng = parseFloat(b.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "Location is required. Please allow location access and try again." });
    }

    // Name and site come from the 201 File, not from user input.
    const guard = emp.fullName;
    const site = emp.site || "";
    const { rows } = await pool.query(
      `INSERT INTO attendance_records
        ("employeeNo", "guardName", site, "punchType", "punchAt", "selfieData", "selfieMimetype", latitude, longitude, "createdBy")
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9) RETURNING id`,
      [empNo, guard, site, b.punchType, req.file.buffer, req.file.mimetype, lat, lng, `public-form:${empNo}`]
    );
    res.status(201).json({ id: rows[0].id, ok: true });
  });
});

// --- Public Leave Request submission ---
// Guards/employees file a leave request from a shared link. Employee Number
// is the only identity input; Name and Site are always resolved server-side
// from the 201 File (via the same lookup as the attendance form) so they can
// never be spoofed by the client. Unknown employee numbers are rejected
// outright. Submissions land as Pending in leave_records — identical to a
// leave request created by staff in the app — so they show up immediately in
// the Leave Request List on the Leave Management page.

// Public leave-type list for the form's dropdown (the authenticated version
// of this lives at /api/leave/types; this is the same dropdown_options source,
// just reachable without login).
router.get("/leave-types", requireFormToken, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value FROM dropdown_options WHERE list_key = 'leave_records_type' ORDER BY id`
  );
  res.json(rows.map(r => r.value));
});

// Read-only leave balance lookup for the public form. After a guard verifies
// their employee number, the form shows their current Vacation/Sick balances
// for reference. Token-protected and privacy-minimal: returns only the two
// numeric balances for a valid employee number, nothing else.
router.get("/leave-balance", requireFormToken, async (req, res) => {
  const empNo = (req.query.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  const emp = (await pool.query(
    `SELECT id FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  const { rows } = await pool.query(
    `SELECT bucket, balance FROM leave_credits WHERE "employeeId" = $1`, [emp.id]
  );
  let vacation = 0, sick = 0;
  for (const r of rows) {
    if (r.bucket === "Vacation") vacation = Number(r.balance);
    else if (r.bucket === "Sick") sick = Number(r.balance);
  }
  res.json({ vacation, sick });
});

router.post("/leave", requireFormToken, async (req, res) => {
  const b = req.body || {};
  // Honeypot, same convention as the other public forms.
  if (b.website) return res.status(201).json({ id: 0, ok: true });

  const empNo = (b.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });

  // Reject unknown employee numbers before touching anything else — same
  // trust model as /attendance: name/site always come from the 201 File.
  const emp = (await pool.query(
    `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  if (!b.leaveType || !b.leaveType.trim()) return res.status(400).json({ error: "Please choose a leave type." });
  if (!b.fromDate || !b.toDate) return res.status(400).json({ error: "From and to dates are required." });
  if (b.toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const { rows } = await pool.query(
    `INSERT INTO leave_records
      ("employeeId","employeeName","employeeNo","leaveType","fromDate","toDate",reason,status,"createdBy")
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,'Pending',$8)
     RETURNING id`,
    [emp.id, emp.fullName, empNo, b.leaveType.trim(), b.fromDate, b.toDate, (b.reason || "").trim(), `public-form:${empNo}`]
  );
  res.status(201).json({ id: rows[0].id, ok: true });
});

module.exports = router;
