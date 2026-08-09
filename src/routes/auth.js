const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth, requireRole, permissionsFor, invalidatePermissions } = require("../middleware/auth");
const { ALL_ROLES, MODULES, MODULE_KEYS, ACTIONS, ROLE_DEFAULTS, effectivePermissions } = require("../lib/permissions");

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
  if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role." });
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
    if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role." });
    await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
    // The role supplies the permission defaults, so a role change is a
    // permission change — drop the cached copy at once rather than letting a
    // demoted user keep their old privileges for the rest of the cache window.
    invalidatePermissions(id);
  }
  if (active !== undefined) await pool.query("UPDATE users SET active = $1 WHERE id = $2", [active ? 1 : 0, id]);
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [bcrypt.hashSync(password, 10), id]);
  }
  res.json({ ok: true });
});

// --- Access privileges ---------------------------------------------------

// The catalogue the Manage Users screen renders: which modules exist, which
// actions are grantable, and what each role starts with. Served rather than
// duplicated in the frontend so the screen can never offer a module the server
// does not know about.
router.get("/permission-catalog", requireAuth, requireRole("Admin"), (req, res) => {
  res.json({
    modules: MODULES.map((m) => ({ key: m.key, label: m.label })),
    actions: ACTIONS,
    roles: ALL_ROLES,
    roleDefaults: ROLE_DEFAULTS,
  });
});

// What THIS user may do. Read by the UI to hide actions it would be refused —
// a convenience, never the control: the backend decides independently on every
// write, and hiding a button is not security.
router.get("/my-permissions", requireAuth, async (req, res) => {
  res.json({ role: req.user.role, permissions: await permissionsFor(req.user) });
});

router.get("/users/:id/permissions", requireAuth, requireRole("Admin"), async (req, res) => {
  const id = Number(req.params.id);
  const user = (await pool.query("SELECT id, role FROM users WHERE id = $1", [id])).rows[0];
  if (!user) return res.status(404).json({ error: "User not found." });
  const overrides = (await pool.query(
    `SELECT "moduleKey", "canAdd", "canEdit", "canDelete"
     FROM user_module_permissions WHERE "userId" = $1`, [id]
  )).rows;
  res.json({
    role: user.role,
    // The role's starting point and the per-user rows are both returned, so the
    // screen can show which cells are a deliberate override and which are
    // simply the role default.
    roleDefaults: ROLE_DEFAULTS[user.role] || {},
    overrides,
    effective: effectivePermissions(user.role, overrides),
  });
});

// Replace a user's overrides wholesale. A module absent from the body reverts
// to the role default rather than being silently left as it was — the screen
// sends the full matrix, so "not present" is a deliberate reset.
router.put("/users/:id/permissions", requireAuth, requireRole("Admin"), async (req, res) => {
  const id = Number(req.params.id);
  const user = (await pool.query("SELECT id, role FROM users WHERE id = $1", [id])).rows[0];
  if (!user) return res.status(404).json({ error: "User not found." });

  const incoming = Array.isArray((req.body || {}).permissions) ? req.body.permissions : null;
  if (!incoming) return res.status(400).json({ error: "A permissions array is required." });
  for (const p of incoming) {
    if (!p || !MODULE_KEYS.includes(p.moduleKey)) {
      return res.status(400).json({ error: `Unknown module: ${p && p.moduleKey}` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM user_module_permissions WHERE "userId" = $1`, [id]);
    for (const p of incoming) {
      await client.query(
        `INSERT INTO user_module_permissions ("userId","moduleKey","canAdd","canEdit","canDelete","updatedBy")
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, p.moduleKey, !!p.canAdd, !!p.canEdit, !!p.canDelete, req.user.username]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Drop the cached copy immediately: an administrator who has just removed a
  // privilege expects it gone now, not when a cache window happens to lapse.
  invalidatePermissions(id);
  const overrides = (await pool.query(
    `SELECT "moduleKey", "canAdd", "canEdit", "canDelete"
     FROM user_module_permissions WHERE "userId" = $1`, [id]
  )).rows;
  res.json({ ok: true, effective: effectivePermissions(user.role, overrides) });
});

// Lets Admins retrieve (and share) the public, no-login report form links.
router.get("/public-form-link", requireAuth, requireRole("Admin"), (req, res) => {
  const token = process.env.PUBLIC_FORM_TOKEN;
  if (!token) return res.json({ enabled: false, url: null, dsrUrl: null });
  const base = `${req.protocol}://${req.get("host")}`;
  // `url` (incident) and `dsrUrl` were dropped in Stage A when those two forms
  // were withdrawn, and are REINSTATED (2026-08). They are shared from their
  // own module now — Incidents and Daily Security Report — rather than from
  // Manage Users. Every link is token-bearing, so none of them work unless
  // PUBLIC_FORM_TOKEN is set on the server.
  res.json({
    enabled: true,
    url: `${base}/report.html?token=${encodeURIComponent(token)}`,
    dsrUrl: `${base}/dsr-report.html?token=${encodeURIComponent(token)}`,
    attendanceUrl: `${base}/attendance.html?token=${encodeURIComponent(token)}`,
    leaveUrl: `${base}/leave-request.html?token=${encodeURIComponent(token)}`,
    missingUrl: `${base}/missing-timelog.html?token=${encodeURIComponent(token)}`,
    myAttendanceUrl: `${base}/my-attendance.html?token=${encodeURIComponent(token)}`,
    overtimeUrl: `${base}/overtime-request.html?token=${encodeURIComponent(token)}`
  });
});

module.exports = router;
