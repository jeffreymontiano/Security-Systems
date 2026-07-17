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

const KPI_FIELDS = ["attendanceScore", "incidentResponseScore", "patrolComplianceScore", "dsrComplianceScore", "clientSatisfactionScore", "appearanceDisciplineScore"];

function code(id) { return "PA-" + String(id).padStart(4, "0"); }

async function log(id, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(id), username, action, detail || null]
  );
}

function overallScore(c) {
  const vals = KPI_FIELDS.map(f => c[f]).filter(v => v !== null && v !== undefined);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
}

async function fullAppraisal(id) {
  const c = (await pool.query("SELECT * FROM performance_appraisals WHERE id = $1", [id])).rows[0];
  if (!c) return null;
  c.code = code(c.id);
  c.overallScore = overallScore(c);
  c.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM performance_attachments WHERE appraisal_id = $1 ORDER BY id", [id]
  )).rows;
  return c;
}

// List, newest first. Any authenticated role. Optional ?site= / ?status= / ?search=
router.get("/", requireAuth, async (req, res) => {
  const { site, status, search } = req.query;
  const clauses = [];
  const params = [];
  if (site) { params.push(site); clauses.push(`site = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`("employeeName" ILIKE $${params.length} OR "evaluatorName" ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM performance_appraisals ${where} ORDER BY "evaluationDate" DESC, id DESC LIMIT 300`, params
  );
  res.json(rows.map(c => ({ ...c, code: code(c.id), overallScore: overallScore(c) })));
});

router.get("/:id", requireAuth, async (req, res) => {
  const c = await fullAppraisal(req.params.id);
  if (!c) return res.status(404).json({ error: "Appraisal not found." });
  res.json(c);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeName || !b.employeeName.trim()) return res.status(400).json({ error: "Employee name is required." });
  if (!b.evaluationDate) return res.status(400).json({ error: "Evaluation date is required." });
  const { rows } = await pool.query(
    `INSERT INTO performance_appraisals ("employeeName", site, "evaluationDate", "evaluatorName", "createdBy")
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.employeeName.trim(), b.site || "", b.evaluationDate, b.evaluatorName || "", req.user.username]
  );
  await log(rows[0].id, req.user.username, "created", `Appraisal opened for ${b.employeeName.trim()}`);
  res.status(201).json(await fullAppraisal(rows[0].id));
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Appraisal not found." });
  if (existing.status === "Finalized") {
    return res.status(400).json({ error: "This appraisal has been finalized and can no longer be edited. An Admin can reopen it first." });
  }

  const fieldMap = {
    employeeName: '"employeeName"', site: "site", evaluationDate: '"evaluationDate"', evaluatorName: '"evaluatorName"',
    supervisorComments: '"supervisorComments"', clientFeedback: '"clientFeedback"', competencyAssessment: '"competencyAssessment"',
    promotionRecommended: '"promotionRecommended"', promotionNotes: '"promotionNotes"'
  };
  KPI_FIELDS.forEach(f => { fieldMap[f] = `"${f}"`; });

  const b = req.body || {};
  if (b.employeeName !== undefined && !b.employeeName.trim()) {
    return res.status(400).json({ error: "Employee name is required." });
  }
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) {
      let v = b[f];
      if (KPI_FIELDS.includes(f)) v = (v === "" || v === null) ? null : parseInt(v, 10);
      setClauses.push(`${fieldMap[f]} = $${i++}`);
      vals.push(v);
    }
  });
  if (setClauses.length === 0) return res.json(await fullAppraisal(existing.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(existing.id);
  await pool.query(`UPDATE performance_appraisals SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(existing.id, req.user.username, "updated", "Appraisal details updated");
  res.json(await fullAppraisal(existing.id));
});

// --- Workflow: Draft -> Submitted -> Finalized (Admin only), with reopen ---
router.post("/:id/submit", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Appraisal not found." });
  if (existing.status !== "Draft") return res.status(400).json({ error: "Only draft appraisals can be submitted." });
  await pool.query(`UPDATE performance_appraisals SET status = 'Submitted', "updatedAt" = now() WHERE id = $1`, [existing.id]);
  await log(existing.id, req.user.username, "appraisal_submitted", "Submitted for finalization");
  res.json(await fullAppraisal(existing.id));
});

router.post("/:id/finalize", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Appraisal not found." });
  if (existing.status !== "Submitted") return res.status(400).json({ error: "Only submitted appraisals can be finalized." });
  await pool.query(
    `UPDATE performance_appraisals SET status = 'Finalized', "finalizedBy" = $1, "finalizedAt" = now(), "updatedAt" = now() WHERE id = $2`,
    [req.user.username, existing.id]
  );
  await log(existing.id, req.user.username, "appraisal_finalized", "Finalized");
  res.json(await fullAppraisal(existing.id));
});

router.post("/:id/reopen", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Appraisal not found." });
  await pool.query(
    `UPDATE performance_appraisals SET status = 'Draft', "finalizedBy" = NULL, "finalizedAt" = NULL, "updatedAt" = now() WHERE id = $1`,
    [existing.id]
  );
  await log(existing.id, req.user.username, "appraisal_reopened", "Reopened for editing");
  res.json(await fullAppraisal(existing.id));
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT id FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Appraisal not found." });
  await pool.query("DELETE FROM performance_appraisals WHERE id = $1", [existing.id]);
  await log(existing.id, req.user.username, "deleted", null);
  res.json({ ok: true });
});

// --- Attachments ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM performance_appraisals WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Appraisal not found." });
    await pool.query(
      `INSERT INTO performance_attachments (appraisal_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM performance_attachments WHERE id = $1 AND appraisal_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM performance_attachments WHERE id = $1 AND appraisal_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM performance_attachments WHERE id = $1", [req.params.attId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- PDF report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const c = await fullAppraisal(req.params.id);
  if (!c) return res.status(404).json({ error: "Appraisal not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${c.code}-performance-appraisal.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Performance Appraisal Report", 50, 44);
  doc.fillColor("#C9D3E3").fontSize(10).text(`${c.code}  \u00b7  Generated ${new Date().toLocaleDateString()}`, 50, 68);
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
    doc.fillColor("#1a1a1a").fontSize(11).text(value === null || value === undefined || value === "" ? "\u2014" : String(value));
    doc.moveDown(0.4);
  }
  function block(label, value) {
    doc.fillColor(NAVY).fontSize(11).text(label);
    doc.fillColor("#1a1a1a").fontSize(10).text(value || "Not recorded.");
    doc.moveDown(0.6);
  }

  heading("Appraisal Overview");
  field("Status", c.status);
  field("Employee", c.employeeName);
  field("Site", c.site);
  field("Evaluation date", c.evaluationDate);
  field("Evaluator", c.evaluatorName);
  field("Overall score", c.overallScore !== null ? `${c.overallScore} / 5` : "Not yet scored");
  if (c.finalizedBy) field("Finalized by", `${c.finalizedBy} on ${new Date(c.finalizedAt).toLocaleDateString()}`);

  heading("KPI Scores (out of 5)");
  field("Attendance", c.attendanceScore);
  field("Incident response", c.incidentResponseScore);
  field("Patrol compliance", c.patrolComplianceScore);
  field("DSR submission compliance", c.dsrComplianceScore);
  field("Client satisfaction", c.clientSatisfactionScore);
  field("Appearance and discipline", c.appearanceDisciplineScore);

  heading("Supervisor / Operation Officer Rating");
  block("Comments", c.supervisorComments);

  heading("Client Feedback");
  block("Feedback", c.clientFeedback);

  heading("Competency Assessment");
  block("Assessment", c.competencyAssessment);

  heading("Promotion Recommendation");
  field("Recommendation", c.promotionRecommended);
  block("Notes", c.promotionNotes);

  heading(`Attachments (${c.attachments.length})`);
  if (c.attachments.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  c.attachments.forEach(a => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 ${a.filename} (${a.mimetype}, ${(a.size / 1024).toFixed(0)} KB) \u2014 uploaded by ${a.uploaded_by}`);
  });

  doc.moveDown(2);
  doc.fillColor(MUTE).fontSize(8).text(
    "This report was generated by the Brookside Farms CSOMS Performance Appraisal module. Confidential HR record.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
