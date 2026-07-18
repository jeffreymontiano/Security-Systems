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

function code(id) { return "AUD-" + String(id).padStart(4, "0"); }

async function log(id, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(id), username, action, detail || null]
  );
}

// Audit score = % of checklist items marked "Yes" out of items marked Yes or No (N/A items excluded).
function computeScore(items) {
  const scored = items.filter(i => i.compliant === "Yes" || i.compliant === "No");
  if (scored.length === 0) return null;
  const compliant = scored.filter(i => i.compliant === "Yes").length;
  return Math.round((compliant / scored.length) * 100);
}

async function fullAudit(id) {
  const a = (await pool.query("SELECT * FROM compliance_audits WHERE id = $1", [id])).rows[0];
  if (!a) return null;
  a.code = code(a.id);
  a.checklist = (await pool.query("SELECT * FROM compliance_checklist_items WHERE audit_id = $1 ORDER BY id", [id])).rows;
  a.correctiveActions = (await pool.query("SELECT * FROM compliance_corrective_actions WHERE audit_id = $1 ORDER BY id", [id])).rows;
  a.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM compliance_attachments WHERE audit_id = $1 ORDER BY id", [id]
  )).rows;
  a.score = computeScore(a.checklist);
  return a;
}

// List, newest audit date first. Any authenticated role. Optional ?site= / ?status= / ?area= / ?search=
router.get("/", requireAuth, async (req, res) => {
  const { site, status, area, search } = req.query;
  const clauses = [];
  const params = [];
  if (site) { params.push(site); clauses.push(`site = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (area) { params.push(area); clauses.push(`"complianceArea" = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`("auditorName" ILIKE $${params.length} OR notes ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM compliance_audits ${where} ORDER BY "auditDate" DESC, id DESC LIMIT 300`, params
  );
  const withScores = await Promise.all(rows.map(async a => {
    const items = (await pool.query("SELECT compliant FROM compliance_checklist_items WHERE audit_id = $1", [a.id])).rows;
    return { ...a, code: code(a.id), score: computeScore(items) };
  }));
  res.json(withScores);
});

router.get("/:id", requireAuth, async (req, res) => {
  const a = await fullAudit(req.params.id);
  if (!a) return res.status(404).json({ error: "Audit not found." });
  res.json(a);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.auditDate) return res.status(400).json({ error: "Audit date is required." });
  const { rows } = await pool.query(
    `INSERT INTO compliance_audits (site, "complianceArea", "auditDate", "auditorName", "createdBy")
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.site || "", b.complianceArea || "", b.auditDate, b.auditorName || "", req.user.username]
  );
  await log(rows[0].id, req.user.username, "created", `Audit scheduled for ${b.site || "a site"}`);
  res.status(201).json(await fullAudit(rows[0].id));
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM compliance_audits WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Audit not found." });

  const fieldMap = { site: "site", complianceArea: '"complianceArea"', auditDate: '"auditDate"', auditorName: '"auditorName"', notes: "notes" };
  const b = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(b[f]); }
  });
  if (setClauses.length === 0) return res.json(await fullAudit(existing.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(existing.id);
  await pool.query(`UPDATE compliance_audits SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(existing.id, req.user.username, "updated", "Audit details updated");
  res.json(await fullAudit(existing.id));
});

router.post("/:id/stage", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { stage } = req.body || {};
  if (!WORKFLOW_STAGES.includes(stage)) return res.status(400).json({ error: "Invalid stage." });
  const existing = (await pool.query("SELECT id FROM compliance_audits WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Audit not found." });
  await pool.query(`UPDATE compliance_audits SET status = $1, "updatedAt" = now() WHERE id = $2`, [stage, existing.id]);
  await log(existing.id, req.user.username, "stage_change", stage);
  res.json(await fullAudit(existing.id));
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT id FROM compliance_audits WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Audit not found." });
  await pool.query("DELETE FROM compliance_audits WHERE id = $1", [existing.id]);
  await log(existing.id, req.user.username, "deleted", null);
  res.json({ ok: true });
});

// --- Checklist items ---
router.post("/:id/checklist", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { itemText, compliant, notes } = req.body || {};
  if (!itemText || !itemText.trim()) return res.status(400).json({ error: "Checklist item text is required." });
  const { rows } = await pool.query(
    `INSERT INTO compliance_checklist_items (audit_id, "itemText", compliant, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
    [req.params.id, itemText.trim(), compliant || "N/A", notes || ""]
  );
  await log(req.params.id, req.user.username, "checklist_item_added", itemText.trim());
  res.status(201).json({ id: rows[0].id, itemText, compliant, notes });
});

router.patch("/:id/checklist/:itemId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM compliance_checklist_items WHERE id = $1 AND audit_id = $2", [req.params.itemId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Checklist item not found." });
  const { itemText, compliant, notes } = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  if (itemText !== undefined) { setClauses.push(`"itemText" = $${i++}`); vals.push(itemText.trim()); }
  if (compliant !== undefined) { setClauses.push(`compliant = $${i++}`); vals.push(compliant); }
  if (notes !== undefined) { setClauses.push(`notes = $${i++}`); vals.push(notes.trim()); }
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.itemId);
  const { rows } = await pool.query(
    `UPDATE compliance_checklist_items SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  res.json(rows[0]);
});

router.delete("/:id/checklist/:itemId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM compliance_checklist_items WHERE id = $1 AND audit_id = $2", [req.params.itemId, req.params.id]);
  await log(req.params.id, req.user.username, "checklist_item_removed", req.params.itemId);
  res.json({ ok: true });
});

// --- Corrective actions ---
router.post("/:id/actions", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { description, owner, dueDate, status } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: "Action description is required." });
  const { rows } = await pool.query(
    `INSERT INTO compliance_corrective_actions (audit_id, description, owner, "dueDate", status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.params.id, description.trim(), owner || "", dueDate || null, status || "Pending"]
  );
  await log(req.params.id, req.user.username, "corrective_action_added", description.trim());
  res.status(201).json({ id: rows[0].id, description, owner, dueDate, status });
});

router.patch("/:id/actions/:actionId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM compliance_corrective_actions WHERE id = $1 AND audit_id = $2", [req.params.actionId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Corrective action not found." });
  const { description, owner, dueDate, status } = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  if (description !== undefined) { setClauses.push(`description = $${i++}`); vals.push(description.trim()); }
  if (owner !== undefined) { setClauses.push(`owner = $${i++}`); vals.push(owner.trim()); }
  if (dueDate !== undefined) { setClauses.push(`"dueDate" = $${i++}`); vals.push(dueDate); }
  if (status !== undefined) { setClauses.push(`status = $${i++}`); vals.push(status); }
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.actionId);
  const { rows } = await pool.query(
    `UPDATE compliance_corrective_actions SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  res.json(rows[0]);
});

router.delete("/:id/actions/:actionId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query("DELETE FROM compliance_corrective_actions WHERE id = $1 AND audit_id = $2", [req.params.actionId, req.params.id]);
  await log(req.params.id, req.user.username, "corrective_action_removed", req.params.actionId);
  res.json({ ok: true });
});

// --- Attachments ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM compliance_audits WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Audit not found." });
    await pool.query(
      `INSERT INTO compliance_attachments (audit_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM compliance_attachments WHERE id = $1 AND audit_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM compliance_attachments WHERE id = $1 AND audit_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM compliance_attachments WHERE id = $1", [req.params.attId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- PDF report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const a = await fullAudit(req.params.id);
  if (!a) return res.status(404).json({ error: "Audit not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${a.code}-compliance-audit.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Compliance & Audit Report", 50, 44);
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

  heading("Audit Overview");
  field("Status", a.status);
  field("Site", a.site);
  field("Compliance area", a.complianceArea);
  field("Audit date", a.auditDate);
  field("Auditor", a.auditorName);
  field("Audit score", a.score !== null ? `${a.score}%` : "Not yet scored");

  heading(`Compliance Checklist (${a.checklist.length})`);
  if (a.checklist.length === 0) doc.fontSize(10).fillColor(MUTE).text("No checklist items recorded.");
  a.checklist.forEach(item => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 [${item.compliant}] ${item.itemText}`);
    if (item.notes) doc.fillColor(MUTE).fontSize(9).text("   " + item.notes);
  });

  heading(`Corrective Actions (${a.correctiveActions.length})`);
  if (a.correctiveActions.length === 0) doc.fontSize(10).fillColor(MUTE).text("No corrective actions recorded.");
  a.correctiveActions.forEach(act => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`\u2022 [${act.status}] ${act.description}`);
    doc.fillColor(MUTE).fontSize(9).text(`   Owner: ${act.owner || "\u2014"}   Due: ${act.dueDate || "\u2014"}`);
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
    "This report was generated by the Brookside Farms CSOMS Compliance & Audit module.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
