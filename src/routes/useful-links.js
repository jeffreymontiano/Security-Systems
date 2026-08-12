const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { validateUrl } = require("../lib/urlSafety");

const router = express.Router();

const STATUSES = ["Active", "Inactive"];

function code(id) { return "UL-" + String(id).padStart(4, "0"); }

// Same shape as training.js / compliance.js: the module's own helper writing
// into the shared audit_log the Live Feed reads.
async function log(id, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [code(id), username, action, detail || null]
  );
}

async function fullRecord(id) {
  const r = (await pool.query("SELECT * FROM useful_links WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  r.code = code(r.id);
  return r;
}

/**
 * The category must be a value the list actually offers.
 *
 * Checked against dropdown_options on every write, never trusted from the form.
 * There is no active/inactive axis on a list value in CSOMS — a value either
 * exists or it does not — so "invalid or inactive" collapses to one question.
 */
async function categoryIsValid(value) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM dropdown_options WHERE list_key = 'url_category' AND value = $1", [value]
  );
  return rowCount > 0;
}

// List. Optional ?search= (name / url / description), ?category=, ?status=.
router.get("/", requireAuth, async (req, res) => {
  const { search, category, status } = req.query;
  const clauses = [];
  const params = [];
  if (category) { params.push(category); clauses.push(`"urlCategory" = $${params.length}`); }
  if (status)   { params.push(status);   clauses.push(`status = $${params.length}`); }
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    clauses.push(`(name ILIKE $${params.length} OR url ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM useful_links ${where} ORDER BY "urlCategory", name LIMIT 300`, params
  );
  res.json(rows.map(r => ({ ...r, code: code(r.id) })));
});

router.get("/:id", requireAuth, async (req, res) => {
  const r = await fullRecord(req.params.id);
  if (!r) return res.status(404).json({ error: "Useful link not found." });
  res.json(r);
});

router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};

  const name = (b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Link name is required." });

  const checked = validateUrl(b.url);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const category = (b.urlCategory || "").trim();
  if (!category) return res.status(400).json({ error: "URL category is required." });
  if (!(await categoryIsValid(category))) {
    return res.status(400).json({ error: "Selected URL Category is invalid or inactive. Please select another category." });
  }

  const status = STATUSES.includes(b.status) ? b.status : "Active";

  try {
    const { rows } = await pool.query(
      `INSERT INTO useful_links (name, url, "urlCategory", description, status, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
      [name, checked.url, category, (b.description || "").trim(), status, req.user.username]
    );
    await log(rows[0].id, req.user.username, "created", `${name} — ${checked.url}`);
    res.status(201).json(await fullRecord(rows[0].id));
  } catch (e) {
    // 23505 = the UNIQUE on url. Reported as the duplicate it is rather than as
    // a database error.
    if (e.code === "23505") return res.status(409).json({ error: "This URL already exists in Useful Links." });
    throw e;
  }
});

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM useful_links WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Useful link not found." });

  const b = req.body || {};
  const sets = [];
  const vals = [];
  const changes = [];
  let i = 1;

  if (b.name !== undefined) {
    const name = (b.name || "").trim();
    if (!name) return res.status(400).json({ error: "Link name is required." });
    if (name !== existing.name) { sets.push(`name = $${i++}`); vals.push(name); changes.push(`name "${existing.name}" → "${name}"`); }
  }

  if (b.url !== undefined) {
    const checked = validateUrl(b.url);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    if (checked.url !== existing.url) { sets.push(`url = $${i++}`); vals.push(checked.url); changes.push(`url ${existing.url} → ${checked.url}`); }
  }

  if (b.urlCategory !== undefined) {
    const category = (b.urlCategory || "").trim();
    if (!category) return res.status(400).json({ error: "URL category is required." });
    if (!(await categoryIsValid(category))) {
      return res.status(400).json({ error: "Selected URL Category is invalid or inactive. Please select another category." });
    }
    if (category !== existing.urlCategory) { sets.push(`"urlCategory" = $${i++}`); vals.push(category); changes.push(`category ${existing.urlCategory} → ${category}`); }
  }

  if (b.description !== undefined) {
    const d = (b.description || "").trim();
    if (d !== existing.description) { sets.push(`description = $${i++}`); vals.push(d); changes.push("description updated"); }
  }

  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "Status must be Active or Inactive." });
    if (b.status !== existing.status) { sets.push(`status = $${i++}`); vals.push(b.status); changes.push(`status ${existing.status} → ${b.status}`); }
  }

  // A save that changed nothing writes nothing and logs nothing, the rule
  // ops.js established — an audit trail of no-ops buries the real edits.
  if (sets.length === 0) return res.json(await fullRecord(existing.id));

  sets.push(`"updatedBy" = $${i++}`); vals.push(req.user.username);
  sets.push(`"updatedAt" = now()`);
  vals.push(existing.id);

  try {
    await pool.query(`UPDATE useful_links SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "This URL already exists in Useful Links." });
    throw e;
  }
  await log(existing.id, req.user.username, "updated", changes.join("; "));
  res.json(await fullRecord(existing.id));
});

// Hard delete, as every other module record is deleted. Nothing references a
// useful link, so there is no history to orphan — unlike the asset taxonomy,
// which deactivates for exactly that reason.
router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const existing = (await pool.query("SELECT * FROM useful_links WHERE id = $1", [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Useful link not found." });
  await pool.query("DELETE FROM useful_links WHERE id = $1", [existing.id]);
  // The particulars go in the log because afterwards it is the only place they
  // exist.
  await log(existing.id, req.user.username, "deleted",
    `${existing.name} — ${existing.url} (${existing.urlCategory})`);
  res.json({ ok: true });
});

module.exports = router;
