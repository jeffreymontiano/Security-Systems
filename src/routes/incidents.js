const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const WORKFLOW_STAGES = ["Reported", "Under Investigation", "Root Cause Identified", "Corrective Action Planned", "Resolved", "Closed"];

async function fullIncident(id) {
  const inc = (await pool.query("SELECT * FROM incidents WHERE id = $1", [id])).rows[0];
  if (!inc) return null;
  inc.evidence = (await pool.query("SELECT * FROM evidence WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.witnesses = (await pool.query("SELECT * FROM witnesses WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.actions = (await pool.query("SELECT * FROM actions WHERE incident_id = $1 ORDER BY id", [id])).rows;
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Reported',NULL,'',$10)`,
    [
      id, b.title.trim(), b.date || new Date().toISOString().slice(0, 10), b.site || "Other",
      b.classification || "Other", b.severity || "High", b.description || "", b.reportedBy || "",
      b.assigned || "", req.user.username
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

const subTables = { evidence: "evidence", witnesses: "witnesses", actions: "actions" };
router.delete("/:id/:list/:entryId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const table = subTables[req.params.list];
  if (!table) return res.status(400).json({ error: "Unknown list." });
  await pool.query(`DELETE FROM ${table} WHERE id = $1 AND incident_id = $2`, [req.params.entryId, req.params.id]);
  await log(req.params.id, req.user.username, `${req.params.list}_removed`, req.params.entryId);
  res.json({ ok: true });
});

module.exports = router;
