const express = require("express");
const { pool } = require("../db");
const { countUsage, LIST_USAGE, scopeFor } = require("../lib/dropdownUsage");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/classifications", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT name FROM classifications ORDER BY id");
  res.json(rows.map(r => r.name));
});

router.post("/classifications", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });
  try {
    await pool.query("INSERT INTO classifications (name) VALUES ($1)", [name]);
  } catch (e) {
    return res.status(409).json({ error: "That classification already exists." });
  }
  res.status(201).json({ ok: true });
});

router.patch("/classifications/:oldName", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const oldName = decodeURIComponent(req.params.oldName);
  const newName = (req.body?.name || "").trim();
  if (!newName) return res.status(400).json({ error: "Name is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE classifications SET name = $1 WHERE name = $2", [newName, oldName]);
    await client.query('UPDATE incidents SET classification = $1 WHERE classification = $2', [newName, oldName]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Could not rename classification." });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

router.delete("/classifications/:name", requireAuth, requireRole("Admin"), async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const count = (await pool.query("SELECT COUNT(*)::int c FROM classifications")).rows[0].c;
  if (count <= 1) return res.status(400).json({ error: "At least one classification must remain." });
  await pool.query("DELETE FROM classifications WHERE name = $1", [name]);
  res.json({ ok: true });
});

router.get("/sites", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT name FROM sites ORDER BY id");
  res.json(rows.map(r => r.name));
});

router.post("/sites", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });
  try {
    await pool.query("INSERT INTO sites (name) VALUES ($1)", [name]);
  } catch (e) {
    return res.status(409).json({ error: "That site already exists." });
  }
  res.status(201).json({ ok: true });
});

router.patch("/sites/:oldName", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const oldName = decodeURIComponent(req.params.oldName);
  const newName = (req.body?.name || "").trim();
  if (!newName) return res.status(400).json({ error: "Name is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE sites SET name = $1 WHERE name = $2", [newName, oldName]);
    await client.query("UPDATE incidents SET site = $1 WHERE site = $2", [newName, oldName]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Could not rename site." });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

router.delete("/sites/:name", requireAuth, requireRole("Admin"), async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const count = (await pool.query("SELECT COUNT(*)::int c FROM sites")).rows[0].c;
  if (count <= 1) return res.status(400).json({ error: "At least one site must remain." });
  await pool.query("DELETE FROM sites WHERE name = $1", [name]);
  res.json({ ok: true });
});

// --- Generic configurable dropdown lists (Deployment & Post Management statuses, etc.) ---
const VALID_LISTS = [
  "deployment_status", "site_condition", "site_manning_status", "video_patrol_status", "post_type",
  "vacancy_tracking_status", "shift_assignments_status", "shift_assignments_shift",
  "reliever_management_status", "deployment_planning_status", "post_orders_status",
  "violation_type", "penalty_type", "promotion_recommendation",
  "training_type", "attendance_status", "exam_result",
  "compliance_area", "corrective_action_status",
  "position_title", "background_check_status", "license_verification_status",
  "medical_exam_status", "employment_status", "lesp_category",
  "url_category"
];
function checkList(req, res, next) {
  if (!VALID_LISTS.includes(req.params.listKey)) return res.status(400).json({ error: "Unknown list." });
  next();
}

router.get("/dropdown/:listKey", requireAuth, checkList, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT value FROM dropdown_options WHERE list_key = $1 ORDER BY id", [req.params.listKey]
  );
  res.json(rows.map(r => r.value));
});

// The same list WITH its compliance flags. A separate route on purpose: the
// plain one above returns a bare string[] and is read at eighteen call sites,
// so changing its shape to carry the flag would touch every one of them for the
// benefit of the few that care.
router.get("/dropdown/:listKey/detail", requireAuth, checkList, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value, "isCompliant" FROM dropdown_options WHERE list_key = $1 ORDER BY id`,
    [req.params.listKey]
  );
  res.json(rows);
});

// Rename a value, and carry the records with it.
//
// There was no rename before — only add and delete — so "renaming" meant
// deleting and re-adding, which left every record holding the old string while
// the list offered only the new one. That is the orphaning this whole change
// exists to stop, and it was the ONLY way an administrator could rename
// anything.
//
// The update and the propagation share one transaction: a rename that moved the
// list but not the records would recreate the exact fault it is meant to fix.
router.patch("/dropdown/:listKey/:value", requireAuth, requireRole("Admin"), checkList, async (req, res) => {
  const from = decodeURIComponent(req.params.value);
  const to = (req.body?.value || "").trim();
  const isCompliant = req.body?.isCompliant;
  if (!to) return res.status(400).json({ error: "A new value is required." });

  const exists = (await pool.query(
    "SELECT 1 FROM dropdown_options WHERE list_key = $1 AND value = $2", [req.params.listKey, from])).rowCount;
  if (!exists) return res.status(404).json({ error: "That value is not in this list." });

  if (to !== from) {
    const clash = (await pool.query(
      "SELECT 1 FROM dropdown_options WHERE list_key = $1 AND value = $2", [req.params.listKey, to])).rowCount;
    if (clash) return res.status(409).json({ error: "That value already exists in this list." });
  }

  const usage = LIST_USAGE[req.params.listKey];
  const client = await pool.connect();
  let moved = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE dropdown_options SET value = $3, "isCompliant" = COALESCE($4, "isCompliant")
        WHERE list_key = $1 AND value = $2`,
      [req.params.listKey, from, to, typeof isCompliant === "boolean" ? isCompliant : null]
    );
    // Only where the storage is verified. An unmapped list renames the option
    // and says so, rather than pretending records were carried across.
    //
    // The rows to move are chosen by the SAME scope the delete guard counts
    // with, so the two can never disagree about which records hold a value.
    if (usage && to !== from) {
      const { where, params } = scopeFor(usage, from);
      const r = await client.query(
        `UPDATE ${usage.table} SET ${usage.column} = $${params.length + 1} WHERE ${where}`,
        [...params, to]
      );
      moved = r.rowCount;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  res.json({ ok: true, recordsUpdated: moved, propagated: !!usage });
});

router.post("/dropdown/:listKey", requireAuth, requireRole("Admin", "Investigator"), checkList, async (req, res) => {
  const value = (req.body?.value || "").trim();
  if (!value) return res.status(400).json({ error: "Value is required." });
  try {
    await pool.query("INSERT INTO dropdown_options (list_key, value) VALUES ($1,$2)", [req.params.listKey, value]);
  } catch (e) {
    return res.status(409).json({ error: "That value already exists in this list." });
  }
  res.status(201).json({ ok: true });
});

// Deleting a value that records still hold ORPHANS them: the row keeps the old
// string, but the dropdown no longer offers it, so the table renders the list's
// FIRST option instead and the record appears to say something it does not.
// That is how a status reading "Complete" turned out not to be Complete, and it
// classified every affected row as an exception on the dashboard.
//
// The asset taxonomy already refuses this ("a level in use cannot be deleted —
// deactivate it instead"); the flat lists never did. Same rule now.
//
// A list whose storage is not yet verified answers "cannot check" rather than
// silently allowing OR silently blocking — see lib/dropdownUsage.js.
router.delete("/dropdown/:listKey/:value", requireAuth, requireRole("Admin"), checkList, async (req, res) => {
  const value = decodeURIComponent(req.params.value);
  const count = (await pool.query("SELECT COUNT(*)::int c FROM dropdown_options WHERE list_key = $1", [req.params.listKey])).rows[0].c;
  if (count <= 1) return res.status(400).json({ error: "At least one option must remain in this list." });

  const usage = await countUsage(pool, req.params.listKey, value);
  if (usage.known && usage.count > 0) {
    return res.status(409).json({
      error: `"${value}" is used by ${usage.count} record${usage.count === 1 ? "" : "s"} and cannot be deleted. ` +
             "Change those records to another value first, or leave this option in place.",
      inUse: usage.count,
    });
  }

  await pool.query("DELETE FROM dropdown_options WHERE list_key = $1 AND value = $2", [req.params.listKey, value]);
  res.json({ ok: true });
});

module.exports = router;
