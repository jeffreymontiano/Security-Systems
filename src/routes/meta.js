const express = require("express");
const { pool } = require("../db");
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

module.exports = router;
