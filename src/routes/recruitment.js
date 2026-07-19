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

const WORKFLOW_STAGES = ["Applied", "Screening", "Interview", "Background & Medical Checks", "Approved", "Hired", "Onboarded", "Rejected"];

function code(id) { return "APP-" + String(id).padStart(4, "0"); }

async function log(id, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(id), username, action, detail || null]
  );
}

async function fullApplicant(id) {
  const a = (await pool.query("SELECT * FROM applicants WHERE id = $1", [id])).rows[0];
  if (!a) return null;
  a.code = code(a.id);
  a.checklist = (await pool.query("SELECT * FROM applicant_checklist_items WHERE applicant_id = $1 ORDER BY id", [id])).rows;
  a.equipment = (await pool.query("SELECT * FROM applicant_equipment_issuance WHERE applicant_id = $1 ORDER BY id", [id])).rows;
  a.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM applicant_attachments WHERE applicant_id = $1 ORDER BY id", [id]
  )).rows;
  return a;
}

// List, newest application first. Any authenticated role. Optional ?site= / ?status= / ?position= / ?search=
router.get("/", requireAuth, async (req, res) => {
  const { site, status, position, search } = req.query;
  const clauses = [];
  const params = [];
  if (site) { params.push(site); clauses.push(`site = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (position) { params.push(position); clauses.push(`position = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`("fullName" ILIKE $${params.length} OR position ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM applicants ${where} ORDER BY "applicationDate" DESC, id DESC LIMIT 300`, params
  );
  res.json(rows.map(a => ({ ...a, code: code(a.id) })));
});

// KPIs computed from real stored data only (no fabricated numbers).
router.get("/_all/stats", requireAuth, async (req, res) => {
  const totals = (await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'Hired' OR status = 'Onboarded')::int AS hired,
      COUNT(*) FILTER (WHERE status = 'Rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE "hireDate" IS NOT NULL)::int AS ever_hired,
      COUNT(*) FILTER (WHERE "employmentStatus" = 'Separated')::int AS separated,
      ROUND(AVG(("hireDate"::date - "applicationDate"::date)) FILTER (WHERE "hireDate" IS NOT NULL))::int AS avg_time_to_hire_days
    FROM applicants
  `)).rows[0];

  const decided = totals.hired + totals.rejected;
  const hiringSuccessRate = decided > 0 ? Math.round((totals.hired / decided) * 1000) / 10 : null;
  const retentionRate = totals.ever_hired > 0
    ? Math.round(((totals.ever_hired - totals.separated) / totals.ever_hired) * 1000) / 10
    : null;

  res.json({
    total: totals.total,
    hired: totals.hired,
    rejected: totals.rejected,
    everHired: totals.ever_hired,
    separated: totals.separated,
    avgTimeToHireDays: totals.avg_time_to_hire_days,
    hiringSuccessRate,
    retentionRate
  });
});

router.get("/:id", requireAuth, async (req, res) => {
  const a = await fullApplicant(req.params.id);
  if (!a) return res.status(404).json({ error: "Applicant not found." });
  res.json(a);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.fullName || !b.fullName.trim()) return res.status(400).json({ error: "Applicant name is required." });
  if (!b.applicationDate) return res.status(400).json({ error: "Application date is required." });
  const { rows } = await pool.query(
    `INSERT INTO applicants ("fullName", position, site, "applicationDate", "createdBy")
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.fullName.trim(), b.position || "", b.site || "", b.applicationDate, req.user.username]
  );
  await log(rows[0].id, req.user.username, "created", `Application received from ${b.fullName.trim()}`);
  res.status(201).json(await fullApplicant(rows[0].id));
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM applicants WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Applicant not found." });

  const fieldMap = {
    fullName: '"fullName"', position: "position", site: "site", applicationDate: '"applicationDate"',
    interviewDate: '"interviewDate"', interviewNotes: '"interviewNotes"',
    backgroundCheckStatus: '"backgroundCheckStatus"', licenseStatus: '"licenseStatus"',
    medicalExamStatus: '"medicalExamStatus"', hireDate: '"hireDate"', contractIssuedDate: '"contractIssuedDate"',
    employmentStatus: '"employmentStatus"', notes: "notes"
  };
  const b = req.body || {};
  if (b.fullName !== undefined && !b.fullName.trim()) {
    return res.status(400).json({ error: "Applicant name is required." });
  }
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(b[f] === "" ? null : b[f]); }
  });
  if (setClauses.length === 0) return res.json(await fullApplicant(existing.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(existing.id);
  await pool.query(`UPDATE applicants SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(existing.id, req.user.username, "updated", "Applicant record updated");
  res.json(await fullApplicant(existing.id));
});

router.post("/:id/stage", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { stage } = req.body || {};
  if (!WORKFLOW_STAGES.includes(stage)) return res.status(400).json({ error: "Invalid stage." });
  const existing = (await pool.query("SELECT * FROM applicants WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Applicant not found." });

  const setClauses = [`status = $1`, `"updatedAt" = now()`];
  const vals = [stage];
  let i = 2;
  // Auto-stamp hireDate the first time an applicant reaches Hired, and default
  // employmentStatus to Active whenever it's not already set (handles both a
  // fresh auto-stamp and a hireDate that was entered manually beforehand).
  if (stage === "Hired") {
    if (!existing.hireDate) {
      setClauses.push(`"hireDate" = $${i++}`);
      vals.push(new Date().toISOString().slice(0, 10));
    }
    if (!existing.employmentStatus) {
      setClauses.push(`"employmentStatus" = $${i++}`);
      vals.push("Active");
    }
  }
  vals.push(existing.id);
  await pool.query(`UPDATE applicants SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(existing.id, req.user.username, "stage_change", stage);
  res.json(await fullApplicant(existing.id));
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT id FROM applicants WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Applicant not found." });
  await pool.query("DELETE FROM applicants WHERE id = $1", [existing.id]);
  await log(existing.id, req.user.username, "deleted", null);
  res.json({ ok: true });
});

// --- Onboarding checklist ---
router.post("/:id/checklist", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { itemText, completed, notes } = req.body || {};
  if (!itemText || !itemText.trim()) return res.status(400).json({ error: "Checklist item text is required." });
  const { rows } = await pool.query(
    `INSERT INTO applicant_checklist_items (applicant_id, "itemText", completed, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
    [req.params.id, itemText.trim(), completed || "No", notes || ""]
  );
  await log(req.params.id, req.user.username, "checklist_item_added", itemText.trim());
  res.status(201).json({ id: rows[0].id, itemText, completed, notes });
});

router.patch("/:id/checklist/:itemId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM applicant_checklist_items WHERE id = $1 AND applicant_id = $2", [req.params.itemId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Checklist item not found." });
  const { itemText, completed, notes } = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  if (itemText !== undefined) { setClauses.push(`"itemText" = $${i++}`); vals.push(itemText.trim()); }
  if (completed !== undefined) { setClauses.push(`completed = $${i++}`); vals.push(completed); }
  if (notes !== undefined) { setClauses.push(`notes = $${i++}`); vals.push(notes.trim()); }
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.itemId);
  const { rows } = await pool.query(
    `UPDATE applicant_checklist_items SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  res.json(rows[0]);
});

router.delete("/:id/checklist/:itemId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM applicant_checklist_items WHERE id = $1 AND applicant_id = $2", [req.params.itemId, req.params.id]);
  await log(req.params.id, req.user.username, "checklist_item_removed", req.params.itemId);
  res.json({ ok: true });
});

// --- Equipment issuance ---
router.post("/:id/equipment", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { itemName, issuedDate, notes } = req.body || {};
  if (!itemName || !itemName.trim()) return res.status(400).json({ error: "Item name is required." });
  const { rows } = await pool.query(
    `INSERT INTO applicant_equipment_issuance (applicant_id, "itemName", "issuedDate", notes) VALUES ($1,$2,$3,$4) RETURNING id`,
    [req.params.id, itemName.trim(), issuedDate || null, notes || ""]
  );
  await log(req.params.id, req.user.username, "equipment_issued", itemName.trim());
  res.status(201).json({ id: rows[0].id, itemName, issuedDate, notes });
});

router.delete("/:id/equipment/:itemId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM applicant_equipment_issuance WHERE id = $1 AND applicant_id = $2", [req.params.itemId, req.params.id]);
  await log(req.params.id, req.user.username, "equipment_removed", req.params.itemId);
  res.json({ ok: true });
});

// --- Attachments (resume, license copies, medical clearance, etc.) ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM applicants WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Applicant not found." });
    await pool.query(
      `INSERT INTO applicant_attachments (applicant_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM applicant_attachments WHERE id = $1 AND applicant_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM applicant_attachments WHERE id = $1 AND applicant_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM applicant_attachments WHERE id = $1", [req.params.attId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- PDF report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const a = await fullApplicant(req.params.id);
  if (!a) return res.status(404).json({ error: "Applicant not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${a.code}-applicant-record.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Recruitment & Onboarding Record", 50, 44);
  doc.fillColor("#C9D3E3").fontSize(10).text(`${a.code}  \u00b7  Generated ${new Date().toLocaleDateString()}`, 50, 68);
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

  heading("Applicant Overview");
  field("Status", a.status);
  field("Full name", a.fullName);
  field("Position applied for", a.position);
  field("Site", a.site);
  field("Application date", a.applicationDate);

  heading("Interview");
  field("Interview date", a.interviewDate);
  field("Notes", a.interviewNotes);

  heading("Screening & Clearances");
  field("Background check", a.backgroundCheckStatus);
  field("License / certification", a.licenseStatus);
  field("Medical examination", a.medicalExamStatus);

  heading("Hiring & Contract");
  field("Hire date", a.hireDate);
  field("Contract issued", a.contractIssuedDate);
  field("Employment status", a.employmentStatus);

  heading(`Onboarding Checklist (${a.checklist.length})`);
  if (a.checklist.length === 0) doc.fontSize(10).fillColor(MUTE).text("No checklist items recorded.");
  a.checklist.forEach(item => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 [${item.completed}] ${item.itemText}`);
    if (item.notes) doc.fillColor(MUTE).fontSize(9).text("   " + item.notes);
  });

  heading(`Uniform & Equipment Issuance (${a.equipment.length})`);
  if (a.equipment.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  a.equipment.forEach(item => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 ${item.itemName}${item.issuedDate ? " \u2014 issued " + item.issuedDate : ""}`);
  });

  heading("Notes");
  doc.fontSize(10).fillColor("#1a1a1a").text(a.notes || "None recorded.");

  heading(`Attachments (${a.attachments.length})`);
  if (a.attachments.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  a.attachments.forEach(att => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 ${att.filename} (${att.mimetype}, ${(att.size / 1024).toFixed(0)} KB) \u2014 uploaded by ${att.uploaded_by}`);
  });

  doc.moveDown(2);
  doc.fillColor(MUTE).fontSize(8).text(
    "This report was generated by the Brookside Farms CSOMS Recruitment, Hiring & Onboarding module.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
