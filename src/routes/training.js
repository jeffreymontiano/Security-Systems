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

const WORKFLOW_STAGES = ["Scheduled", "In Progress", "Completed", "Cancelled"];

function code(id) { return "TR-" + String(id).padStart(4, "0"); }

async function log(id, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(id), username, action, detail || null]
  );
}

async function fullRecord(id) {
  const c = (await pool.query("SELECT * FROM training_records WHERE id = $1", [id])).rows[0];
  if (!c) return null;
  c.code = code(c.id);
  c.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM training_attachments WHERE record_id = $1 ORDER BY id", [id]
  )).rows;
  return c;
}

// List, newest scheduled first. Any authenticated role. Optional ?site= / ?status= / ?search= / ?expiry=expiring|expired
router.get("/", requireAuth, async (req, res) => {
  const { site, status, search, expiry } = req.query;
  const clauses = [];
  const params = [];
  if (site) { params.push(site); clauses.push(`site = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`("employeeName" ILIKE $${params.length} OR "courseName" ILIKE $${params.length} OR "certificationName" ILIKE $${params.length})`);
  }
  if (expiry === "expired") {
    clauses.push(`"certificationExpiryDate" IS NOT NULL AND "certificationExpiryDate"::date < CURRENT_DATE`);
  } else if (expiry === "expiring") {
    clauses.push(`"certificationExpiryDate" IS NOT NULL AND "certificationExpiryDate"::date >= CURRENT_DATE AND "certificationExpiryDate"::date <= (CURRENT_DATE + INTERVAL '30 days')`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM training_records ${where} ORDER BY "scheduledDate" DESC, id DESC LIMIT 300`, params
  );
  res.json(rows.map(c => ({ ...c, code: code(c.id) })));
});

router.get("/:id", requireAuth, async (req, res) => {
  const c = await fullRecord(req.params.id);
  if (!c) return res.status(404).json({ error: "Training record not found." });
  res.json(c);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeName || !b.employeeName.trim()) return res.status(400).json({ error: "Employee name is required." });
  if (!b.scheduledDate) return res.status(400).json({ error: "Scheduled date is required." });
  const { rows } = await pool.query(
    `INSERT INTO training_records ("employeeName", site, "courseName", "scheduledDate", "createdBy")
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.employeeName.trim(), b.site || "", b.courseName || "", b.scheduledDate, req.user.username]
  );
  await log(rows[0].id, req.user.username, "created", `Training assigned to ${b.employeeName.trim()}`);
  res.status(201).json(await fullRecord(rows[0].id));
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM training_records WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Training record not found." });

  const fieldMap = {
    employeeName: '"employeeName"', site: "site", courseName: '"courseName"', scheduledDate: '"scheduledDate"',
    attendanceStatus: '"attendanceStatus"', examScore: '"examScore"', examResult: '"examResult"',
    certificationName: '"certificationName"', certificationIssueDate: '"certificationIssueDate"',
    certificationExpiryDate: '"certificationExpiryDate"', notes: "notes"
  };
  const b = req.body || {};
  if (b.employeeName !== undefined && !b.employeeName.trim()) {
    return res.status(400).json({ error: "Employee name is required." });
  }
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(b[f]); }
  });
  if (setClauses.length === 0) return res.json(await fullRecord(existing.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(existing.id);
  await pool.query(`UPDATE training_records SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(existing.id, req.user.username, "updated", "Training record updated");
  res.json(await fullRecord(existing.id));
});

router.post("/:id/stage", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { stage } = req.body || {};
  if (!WORKFLOW_STAGES.includes(stage)) return res.status(400).json({ error: "Invalid stage." });
  const existing = (await pool.query("SELECT id FROM training_records WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Training record not found." });
  await pool.query(`UPDATE training_records SET status = $1, "updatedAt" = now() WHERE id = $2`, [stage, existing.id]);
  await log(existing.id, req.user.username, "stage_change", stage);
  res.json(await fullRecord(existing.id));
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT id FROM training_records WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Training record not found." });
  await pool.query("DELETE FROM training_records WHERE id = $1", [existing.id]);
  await log(existing.id, req.user.username, "deleted", null);
  res.json({ ok: true });
});

// --- Attachments ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM training_records WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Training record not found." });
    await pool.query(
      `INSERT INTO training_attachments (record_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM training_attachments WHERE id = $1 AND record_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM training_attachments WHERE id = $1 AND record_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM training_attachments WHERE id = $1", [req.params.attId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- PDF report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const c = await fullRecord(req.params.id);
  if (!c) return res.status(404).json({ error: "Training record not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${c.code}-training-record.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Training & Certification Record", 50, 44);
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
    doc.fillColor("#1a1a1a").fontSize(11).text(value || "\u2014");
    doc.moveDown(0.4);
  }
  function block(label, value) {
    doc.fillColor(NAVY).fontSize(11).text(label);
    doc.fillColor("#1a1a1a").fontSize(10).text(value || "Not recorded.");
    doc.moveDown(0.6);
  }

  heading("Training Overview");
  field("Status", c.status);
  field("Employee", c.employeeName);
  field("Site", c.site);
  field("Course / training", c.courseName);
  field("Scheduled date", c.scheduledDate);
  field("Attendance", c.attendanceStatus);

  heading("Competency Exam");
  field("Score", c.examScore);
  field("Result", c.examResult);

  heading("Certification");
  field("Certification name", c.certificationName);
  field("Issue date", c.certificationIssueDate);
  field("Expiry date", c.certificationExpiryDate);

  heading("Notes");
  block("Notes", c.notes);

  heading(`Attachments (${c.attachments.length})`);
  if (c.attachments.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  c.attachments.forEach(a => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 ${a.filename} (${a.mimetype}, ${(a.size / 1024).toFixed(0)} KB) \u2014 uploaded by ${a.uploaded_by}`);
  });

  doc.moveDown(2);
  doc.fillColor(MUTE).fontSize(8).text(
    "This report was generated by the Brookside Farms CSOMS Training & Certification Management module.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
