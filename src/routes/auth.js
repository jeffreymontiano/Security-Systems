const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );
}

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: "Invalid username or password." });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = sign(user);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  const user = rows[0];
  if (!bcrypt.compareSync(currentPassword || "", user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id]);
  res.json({ ok: true });
});

// --- Admin-only user management ---
router.get("/users", requireAuth, requireRole("Admin"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, username, name, role, active, created_at FROM users ORDER BY id"
  );
  res.json(rows);
});

router.post("/users", requireAuth, requireRole("Admin"), async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name || !role) return res.status(400).json({ error: "All fields are required." });
  if (!["Admin", "Investigator", "Viewer"].includes(role)) return res.status(400).json({ error: "Invalid role." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const exists = (await pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0];
  if (exists) return res.status(409).json({ error: "That username is already taken." });
  const hash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    "INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id",
    [username, hash, name, role]
  );
  res.status(201).json({ id: rows[0].id, username, name, role, active: 1 });
});

router.patch("/users/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { name, role, active, password } = req.body || {};
  const user = (await pool.query("SELECT * FROM users WHERE id = $1", [id])).rows[0];
  if (!user) return res.status(404).json({ error: "User not found." });
  if (name !== undefined) await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, id]);
  if (role !== undefined) {
    if (!["Admin", "Investigator", "Viewer"].includes(role)) return res.status(400).json({ error: "Invalid role." });
    await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
  }
  if (active !== undefined) await pool.query("UPDATE users SET active = $1 WHERE id = $2", [active ? 1 : 0, id]);
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [bcrypt.hashSync(password, 10), id]);
  }
  res.json({ ok: true });
});

module.exports = router;
