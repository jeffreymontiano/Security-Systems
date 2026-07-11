const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument|^text\/plain$/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: images, PDF, Word docs, text files."));
  }
});

const WORKFLOW_STAGES = ["Open", "Under Investigation", "Resolved", "Closed"];

async function fullIncident(id) {
  const inc = (await pool.query("SELECT * FROM incidents WHERE id = $1", [id])).rows[0];
  if (!inc) return null;
  inc.evidence = (await pool.query("SELECT * FROM evidence WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.witnesses = (await pool.query("SELECT * FROM witnesses WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.actions = (await pool.query("SELECT * FROM actions WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM attachments WHERE incident_id = $1 ORDER BY id", [id]
  )).rows;
  return inc;
}

async function nextIncidentId() {
  const row = (await pool.query("SELECT id FROM incidents ORDER BY id DESC LIMIT 1")).rows[0];
  let n = 1;
  if (row) {
    const m = /INC-(\d+)/.exec(row.id);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return "INC-" + String(n).padStart(4, "0");
}

async function log(incidentId, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [incidentId, username, action, detail || null]
  );
}

// List all incidents (with sub-lists) - any authenticated user (Viewer included)
router.get("/", requireAuth, async (req, res) => {
  const rows = (await pool.query("SELECT * FROM incidents ORDER BY date DESC")).rows;
  const withSub = await Promise.all(rows.map(i => fullIncident(i.id)));
  res.json(withSub);
});

router.get("/:id", requireAuth, async (req, res) => {
  const inc = await fullIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: "Incident not found." });
  res.json(inc);
});

// Create - Admin or Investigator
router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.title.trim()) return res.status(400).json({ error: "Title is required." });
  const id = await nextIncidentId();
  await pool.query(
    `INSERT INTO incidents
      (id, title, date, site, classification, severity, description, "reportedBy", assigned, status, "resolvedDate", "rootCause", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Open',NULL,$10,$11)`,
    [
      id, b.title.trim(), b.date || new Date().toISOString().slice(0, 10), b.site || "Other",
      b.classification || "Other", b.severity || "High", b.description || "", b.reportedBy || "",
      b.assigned || "", (b.rootCause || "").trim(), req.user.username
    ]
  );
  await log(id, req.user.username, "created", b.title.trim());
  res.status(201).json(await fullIncident(id));
});

// Update core fields - Admin or Investigator
router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const inc = (await pool.query("SELECT * FROM incidents WHERE id = $1", [req.params.id])).rows[0];
  if (!inc) return res.status(404).json({ error: "Incident not found." });
  const fieldMap = {
    title: "title", date: "date", site: "site", classification: "classification",
    severity: "severity", description: "description", reportedBy: '"reportedBy"',
    assigned: "assigned", rootCause: '"rootCause"'
  };
  const b = req.body || {};
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(b[f]); }
  });
  if (setClauses.length === 0) return res.json(await fullIncident(inc.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(inc.id);
  await pool.query(`UPDATE incidents SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  await log(inc.id, req.user.username, "updated", Object.keys(b).join(", "));
  res.json(await fullIncident(inc.id));
});

// Change workflow stage - Admin or Investigator
router.post("/:id/stage", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { stage } = req.body || {};
  if (!WORKFLOW_STAGES.includes(stage)) return res.status(400).json({ error: "Invalid stage." });
  const inc = (await pool.query("SELECT * FROM incidents WHERE id = $1", [req.params.id])).rows[0];
  if (!inc) return res.status(404).json({ error: "Incident not found." });
  const resolvedDate = (stage === "Resolved" || stage === "Closed")
    ? (inc.resolvedDate || new Date().toISOString().slice(0, 10))
    : null;
  await pool.query(
    `UPDATE incidents SET status = $1, "resolvedDate" = $2, "updatedAt" = now() WHERE id = $3`,
    [stage, resolvedDate, inc.id]
  );
  await log(inc.id, req.user.username, "stage_change", stage);
  res.json(await fullIncident(inc.id));
});

// Delete - Admin only
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  if (req.user.role !== "Admin") return res.status(403).json({ error: "Only an Admin can delete incidents." });
  const inc = (await pool.query("SELECT id FROM incidents WHERE id = $1", [req.params.id])).rows[0];
  if (!inc) return res.status(404).json({ error: "Incident not found." });
  await pool.query("DELETE FROM incidents WHERE id = $1", [inc.id]);
  await log(inc.id, req.user.username, "deleted", null);
  res.json({ ok: true });
});

// --- Evidence / Witnesses / Actions sub-resources ---
router.post("/:id/evidence", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { title, type, note } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Evidence title is required." });
  const { rows } = await pool.query(
    "INSERT INTO evidence (incident_id, title, type, note) VALUES ($1,$2,$3,$4) RETURNING id",
    [req.params.id, title.trim(), type || "", note || ""]
  );
  await log(req.params.id, req.user.username, "evidence_added", title.trim());
  res.status(201).json({ id: rows[0].id, title, type, note });
});

router.post("/:id/witnesses", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { name, statement } = req.body || {};
  if (!name || !statement) return res.status(400).json({ error: "Witness name and statement are required." });
  const { rows } = await pool.query(
    "INSERT INTO witnesses (incident_id, name, statement) VALUES ($1,$2,$3) RETURNING id",
    [req.params.id, name.trim(), statement.trim()]
  );
  await log(req.params.id, req.user.username, "witness_added", name.trim());
  res.status(201).json({ id: rows[0].id, name, statement });
});

router.post("/:id/actions", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { type, description, owner, dueDate, status } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: "Action description is required." });
  const { rows } = await pool.query(
    `INSERT INTO actions (incident_id, type, description, owner, "dueDate", status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.id, type || "Corrective", description.trim(), owner || "", dueDate || null, status || "Pending"]
  );
  await log(req.params.id, req.user.username, "action_added", description.trim());
  res.status(201).json({ id: rows[0].id, type, description, owner, dueDate, status });
});

router.patch("/:id/actions/:actionId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM actions WHERE id = $1 AND incident_id = $2", [req.params.actionId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Action not found." });

  const fieldMap = { description: "description", status: "status", owner: "owner", dueDate: '"dueDate"', type: "type" };
  const b = req.body || {};
  if (b.description !== undefined && !b.description.trim()) {
    return res.status(400).json({ error: "Action description is required." });
  }
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(typeof b[f] === "string" ? b[f].trim() : b[f]); }
  });
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.actionId);
  const { rows } = await pool.query(
    `UPDATE actions SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  await log(req.params.id, req.user.username, "action_updated", rows[0].description);
  res.json(rows[0]);
});

const subTables = { evidence: "evidence", witnesses: "witnesses", actions: "actions" };
router.delete("/:id/:list/:entryId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const table = subTables[req.params.list];
  if (!table) return res.status(400).json({ error: "Unknown list." });
  await pool.query(`DELETE FROM ${table} WHERE id = $1 AND incident_id = $2`, [req.params.entryId, req.params.id]);
  await log(req.params.id, req.user.username, `${req.params.list}_removed`, req.params.entryId);
  res.json({ ok: true });
});

// --- Attachments (photos & documents) ---
router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const inc = (await pool.query("SELECT id FROM incidents WHERE id = $1", [req.params.id])).rows[0];
    if (!inc) return res.status(404).json({ error: "Incident not found." });
    const { rows } = await pool.query(
      `INSERT INTO attachments (incident_id, filename, mimetype, size, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mimetype, size, uploaded_by, uploaded_at`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json(rows[0]);
  });
});

router.get("/:id/attachments/:attId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM attachments WHERE id = $1 AND incident_id = $2", [req.params.attId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM attachments WHERE id = $1 AND incident_id = $2", [req.params.attId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found." });
  await pool.query("DELETE FROM attachments WHERE id = $1", [req.params.attId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// --- Audit trail ---
// System-wide activity feed (Admin only) — must be registered before the
// wildcard "/:id/audit" route below, otherwise "_all" would be treated as an incident id.
router.get("/_all/audit", requireAuth, requireRole("Admin"), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const { rows } = await pool.query(
    "SELECT * FROM audit_log ORDER BY at DESC LIMIT $1", [limit]
  );
  res.json(rows);
});

// --- Dashboard / KPI stats --- (also registered before "/:id" wildcards)
router.get("/_all/stats", requireAuth, async (req, res) => {
  const [byStatus, bySite, byClassification, bySeverity, monthly, totals] = await Promise.all([
    pool.query("SELECT status, COUNT(*)::int c FROM incidents GROUP BY status"),
    pool.query("SELECT site, COUNT(*)::int c FROM incidents GROUP BY site ORDER BY c DESC"),
    pool.query("SELECT classification, COUNT(*)::int c FROM incidents GROUP BY classification ORDER BY c DESC"),
    pool.query("SELECT severity, COUNT(*)::int c FROM incidents GROUP BY severity"),
    pool.query(`
      SELECT to_char(date::date, 'YYYY-MM') ym, COUNT(*)::int c
      FROM incidents
      WHERE date::date > (CURRENT_DATE - INTERVAL '6 months')
      GROUP BY ym ORDER BY ym
    `),
    pool.query(`
      SELECT
        COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Closed'))::int open,
        COUNT(*) FILTER (WHERE status = 'Closed')::int closed,
        ROUND(AVG(("resolvedDate"::date - date::date)) FILTER (WHERE "resolvedDate" IS NOT NULL))::int avg_resolution_days
      FROM incidents
    `)
  ]);
  res.json({
    totals: totals.rows[0],
    byStatus: byStatus.rows,
    bySite: bySite.rows,
    byClassification: byClassification.rows,
    bySeverity: bySeverity.rows,
    monthly: monthly.rows
  });
});

router.get("/:id/audit", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM audit_log WHERE incident_id = $1 ORDER BY at DESC", [req.params.id]
  );
  res.json(rows);
});

// --- PDF incident report ---
router.get("/:id/report.pdf", requireAuth, async (req, res) => {
  const inc = await fullIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: "Incident not found." });

  const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${inc.id}-incident-report.pdf"`);
  doc.pipe(res);

  // Header
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).fontSize(10).text("BROOKSIDE FARMS CORPORATION", 50, 28, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(18).text("Incident Investigation Report", 50, 44);
  doc.fillColor("#C9D3E3").fontSize(10).text(`${inc.id}  ·  Generated ${new Date().toLocaleDateString()}`, 50, 68);
  doc.moveDown(3);
  doc.y = 110;

  function heading(text) {
    doc.moveDown(0.8);
    doc.fillColor(NAVY).fontSize(13).text(text, { underline: false });
    doc.moveTo(50, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.moveDown(0.5);
    doc.fillColor("#1a1a1a").fontSize(10);
  }
  function field(label, value) {
    doc.fillColor(MUTE).fontSize(9).text(label.toUpperCase(), { continued: false });
    doc.fillColor("#1a1a1a").fontSize(11).text(value || "—");
    doc.moveDown(0.4);
  }

  heading("Overview");
  field("Title", inc.title);
  field("Status", inc.status);
  field("Date reported", inc.date);
  field("Site", inc.site);
  field("Classification", inc.classification);
  field("Severity", inc.severity);
  field("Reported by", inc.reportedBy);
  field("Assigned investigator", inc.assigned);
  field("Resolved date", inc.resolvedDate);

  heading("Description");
  doc.fontSize(10).text(inc.description || "No description provided.", { align: "left" });

  heading("Root Cause");
  doc.fontSize(10).text(inc.rootCause || "Not yet determined.");

  heading(`Evidence (${inc.evidence.length})`);
  if (inc.evidence.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  inc.evidence.forEach(e => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`• ${e.title}${e.type ? " (" + e.type + ")" : ""}`);
    if (e.note) doc.fillColor(MUTE).fontSize(9).text("   " + e.note);
  });

  heading(`Witnesses (${inc.witnesses.length})`);
  if (inc.witnesses.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  inc.witnesses.forEach(w => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`• ${w.name}`);
    doc.fillColor(MUTE).fontSize(9).text("   " + w.statement);
  });

  heading(`Corrective / Preventive Actions (${inc.actions.length})`);
  if (inc.actions.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  inc.actions.forEach(a => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`• [${a.status}] ${a.description}`);
    doc.fillColor(MUTE).fontSize(9).text(`   Owner: ${a.owner || "—"}   Due: ${a.dueDate || "—"}   Type: ${a.type || "—"}`);
  });

  heading(`Attachments (${inc.attachments.length})`);
  if (inc.attachments.length === 0) doc.fontSize(10).fillColor(MUTE).text("None recorded.");
  inc.attachments.forEach(a => {
    doc.fillColor("#1a1a1a").fontSize(10).text(`• ${a.filename} (${a.mimetype}, ${(a.size / 1024).toFixed(0)} KB) — uploaded by ${a.uploaded_by}`);
  });

  doc.moveDown(2);
  doc.fillColor(MUTE).fontSize(8).text(
    "This report was generated by the Brookside Farms CSOMS Incident Reporting & Investigation module.",
    { align: "center" }
  );

  doc.end();
});

module.exports = router;
