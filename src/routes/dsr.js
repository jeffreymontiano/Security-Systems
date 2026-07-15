const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

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

function code(id) { return "DSR-" + String(id).padStart(4, "0"); }

async function logDsr(dsrId, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(dsrId), username, action, detail || null]
  );
}

async function fullReport(id) {
  const r = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  r.code = code(r.id);
  r.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM dsr_attachments WHERE dsr_id = $1 ORDER BY id", [id]
  )).rows;
  return r;
}

const PERIOD_RANGE = {
  daily:   "CURRENT_DATE",
  weekly:  "date_trunc('week', CURRENT_DATE)",
  monthly: "date_trunc('month', CURRENT_DATE)",
  annual:  "date_trunc('year', CURRENT_DATE)"
};

// List reports, newest first. Optional ?period=daily|weekly|monthly|annual and ?site=
router.get("/", requireAuth, async (req, res) => {
  const period = req.query.period;
  const site = (req.query.site || "").trim();
  const clauses = [];
  const params = [];
  if (period && PERIOD_RANGE[period]) {
    clauses.push(`date::date >= ${PERIOD_RANGE[period]}`);
  }
  if (site) {
    params.push(site);
    clauses.push(`site = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM dsr_reports ${where} ORDER BY date DESC, id DESC LIMIT 300`, params
  );
  res.json(rows.map(r => ({ ...r, code: code(r.id) })));
});

router.get("/:id", requireAuth, async (req, res) => {
  const r = await fullReport(req.params.id);
  if (!r) return res.status(404).json({ error: "Report not found." });
  res.json(r);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.date) return res.status(400).json({ error: "Date is required." });
  const { rows } = await pool.query(
    `INSERT INTO dsr_reports
      (date, site, shift, "submittedBy", "shiftTurnover", "visitorLog", "vehicleLog", "patrolReport", "securityObservations", "siteIssues", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      b.date, b.site || "", b.shift || "", b.submittedBy || "", b.shiftTurnover || "",
      b.visitorLog || "", b.vehicleLog || "", b.patrolReport || "", b.securityObservations || "",
      b.siteIssues || "", req.user.username
    ]
  );
  await logDsr(rows[0].id, req.user.username, "created", `Daily Security Report for ${b.date}`);
  res.status(201).json(await fullReport(rows[0].id));
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  if (existing.status === "Approved" || existing.status === "Rejected") {
    return res.status(400).json({ error: "This report has already been reviewed and can no longer be edited. An Admin can reopen it first." });
  }
  const fieldMap = {
    date: "date", site: "site", shift: "shift", submittedBy: '"submittedBy"',
    shiftTurnover: '"shiftTurnover"', visitorLog: '"visitorLog"', vehicleLog: '"vehicleLog"',
    patrolReport: '"patrolReport"', securityObservations: '"securityObservations"', siteIssues: '"siteIssues"'
  };
  const b = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(b[f]); }
  });
  if (setClauses.length === 0) return res.json(await fullReport(existing.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(existing.id);
  await pool.query(`UPDATE dsr_reports SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await logDsr(existing.id, req.user.username, "updated", "Report details updated");
  res.json(await fullReport(existing.id));
});

// --- Approval workflow ---
router.post("/:id/submit", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  if (existing.status !== "Draft") return res.status(400).json({ error: "Only draft reports can be submitted." });
  await pool.query(`UPDATE dsr_reports SET status = 'Submitted', "updatedAt" = now() WHERE id = $1`, [existing.id]);
  await logDsr(existing.id, req.user.username, "dsr_submitted", "Submitted for approval");
  res.json(await fullReport(existing.id));
});

router.post("/:id/reopen", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  await pool.query(`UPDATE dsr_reports SET status = 'Draft', "approvedBy" = NULL, "approvedAt" = NULL, "updatedAt" = now() WHERE id = $1`, [existing.id]);
  await logDsr(existing.id, req.user.username, "dsr_reopened", "Reopened for editing");
  res.json(await fullReport(existing.id));
});

router.post("/:id/approve", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  if (existing.status !== "Submitted") return res.status(400).json({ error: "Only submitted reports can be approved." });
  await pool.query(
    `UPDATE dsr_reports SET status = 'Approved', "approvedBy" = $1, "approvedAt" = now(), "updatedAt" = now() WHERE id = $2`,
    [req.user.username, existing.id]
  );
  await logDsr(existing.id, req.user.username, "dsr_approved", "Approved");
  res.json(await fullReport(existing.id));
});

router.post("/:id/reject", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  if (existing.status !== "Submitted") return res.status(400).json({ error: "Only submitted reports can be rejected." });
  await pool.query(
    `UPDATE dsr_reports SET status = 'Rejected', "approvedBy" = $1, "approvedAt" = now(), "updatedAt" = now() WHERE id = $2`,
    [req.user.username, existing.id]
  );
  await logDsr(existing.id, req.user.username, "dsr_rejected", (req.body && req.body.reason) || "Rejected");
  res.json(await fullReport(existing.id));
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT id FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Report not found." });
  await pool.query("DELETE FROM dsr_reports WHERE id = $1", [existing.id]);
  await logDsr(existing.id, req.user.username, "dsr_deleted", null);
  res.json({ ok: true });
});

// --- Attachments ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Report not found." });
    await pool.query(
      `INSERT INTO dsr_attachments (dsr_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await logDsr(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM dsr_attachments WHERE id = $1 AND dsr_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM dsr_attachments WHERE id = $1 AND dsr_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM dsr_attachments WHERE id = $1", [req.params.attId]);
  await logDsr(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- PDF report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const r = await fullReport(req.params.id);
  if (!r) return res.status(404).json({ error: "Report not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${r.code}-daily-security-report.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Daily Security Report", 50, 44);
  doc.fillColor("#C9D3E3").fontSize(10).text(`${r.code}  \u00b7  Generated ${new Date().toLocaleDateString()}`, 50, 68);
  doc.y = 110;

  function heading(text) {
    doc.moveDown(0.8);
    doc.fillColor(NAVY).fontSize(13).text(text);
    doc.moveTo(50, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.moveDown(0.5);
    doc.fillColor("#1a1a1a").fontSize(10);
  }
  function field(label, value) {
    doc.fillColor(MUTE).fontSize(9).text(label.toUpperCase());
    doc.fillColor("#1a1a1a").fontSize(11).text(value || "\u2014");
    doc.moveDown(0.4);
  }
  function block(label, value) {
    doc.fillColor(NAVY).fontSize(11).text(label);
    doc.fillColor("#1a1a1a").fontSize(10).text(value || "None recorded.");
    doc.moveDown(0.6);
  }

  heading("Overview");
  field("Status", r.status);
  field("Date", r.date);
  field("Site", r.site);
  field("Shift", r.shift);
  field("Submitted by", r.submittedBy);
  if (r.approvedBy) field(r.status === "Rejected" ? "Rejected by" : "Approved by", `${r.approvedBy} on ${new Date(r.approvedAt).toLocaleDateString()}`);

  heading("Report Details");
  block("Shift Turnover Notes", r.shiftTurnover);
  block("Visitor Log", r.visitorLog);
  block("Vehicle Log", r.vehicleLog);
  block("Patrol Report", r.patrolReport);
  block("Security Observations", r.securityObservations);
  block("Site Issues", r.siteIssues);

  heading(`Attachments (${r.attachments.length})`);
  if (r.attachments.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  r.attachments.forEach(a => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 ${a.filename} (${a.mimetype}, ${(a.size / 1024).toFixed(0)} KB) \u2014 uploaded by ${a.uploaded_by}`);
  });

  doc.moveDown(2);
  doc.fillColor(MUTE).fontSize(8).text(
    "This report was generated by the Brookside Farms CSOMS Daily Security Report module.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
