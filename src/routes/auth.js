const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth, requireRole, permissionsFor, invalidatePermissions, invalidatePasswordStamp } = require("../middleware/auth");
const { ALL_ROLES, MODULES, MODULE_KEYS, ACTIONS, ROLE_DEFAULTS, ROLE_LABELS, VIEW_RESTRICTED, effectivePermissions } = require("../lib/permissions");

const router = express.Router();

// Account events go in the same audit_log the Live Feed reads. incident_id is
// null: the column predates this table being used for anything but incidents.
// A password is NEVER written here, not even a generated temporary one.
async function logAuth(username, action, detail) {
  try {
    await pool.query(
      "INSERT INTO audit_log (incident_id, username, action, detail) VALUES (NULL,$1,$2,$3)",
      [username || null, action, detail || null]
    );
  } catch (e) {
    // An audit write must never break the action it is recording.
    console.error("[auth] audit write failed:", e.message);
  }
}

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
  res.json({
    token,
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
    // Set when an administrator reset this account. The app sends them straight
    // to Change Password, so a handed-over temporary password cannot quietly
    // become the permanent one.
    mustChangePassword: !!user.mustChangePassword,
  });
});

// The token carries the identity; the forced-change flag is read live, because
// it can be set by an administrator after this session started and a stale
// "false" baked into the token would let a reset account carry on unprompted.
router.get("/me", requireAuth, async (req, res) => {
  let mustChangePassword = false;
  try {
    const { rows } = await pool.query(`SELECT "mustChangePassword" FROM users WHERE id = $1`, [req.user.id]);
    mustChangePassword = !!(rows[0] && rows[0].mustChangePassword);
  } catch (e) {
    console.error("[auth/me]", e.message);
  }
  res.json({ user: req.user, mustChangePassword });
});

// Self-service only. The account changed is ALWAYS req.user.id, taken from the
// verified token — a username or id from the body is never consulted, so this
// route cannot be turned into "change someone else's password".
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Not authenticated." });
    if (!bcrypt.compareSync(currentPassword || "", user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    // Comparing against the stored HASH rather than the submitted current
    // password: the two are the same thing here, but this still holds if the
    // account was reset and the "current" is a temporary one.
    if (bcrypt.compareSync(newPassword, user.password_hash)) {
      return res.status(400).json({ error: "The new password must be different from the current one." });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, "passwordChangedAt" = now(), "mustChangePassword" = false
        WHERE id = $2`, [hash, user.id]
    );
    // Ends every OTHER session for this account at once, rather than up to the
    // cache window later.
    invalidatePasswordStamp(user.id);
    await logAuth(user.username, "password_changed", "Changed their own password");

    // The caller's own token predates the change and is now refused, so the
    // client has to log in again. Said explicitly rather than left for the next
    // request to discover as a confusing 401.
    res.json({ ok: true, reauthenticate: true });
  } catch (e) {
    console.error("[auth/change-password]", e);
    res.status(500).json({ error: "Could not change the password." });
  }
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
    // Stamped and audited exactly as the reset route is. This path predates it
    // and set the hash alone, which meant a password changed here did NOT end
    // the account's existing sessions — the one thing changing it is for.
    await pool.query(
      `UPDATE users SET password_hash = $1, "passwordChangedAt" = now() WHERE id = $2`,
      [bcrypt.hashSync(password, 10), id]
    );
    invalidatePasswordStamp(id);
    await logAuth(req.user.username, "password_set",
      `Set a new password for ${user.username} (${user.name})`);
  }
  res.json({ ok: true });
});

// Characters a temporary password is built from. No 0/O, 1/l/I: this password
// gets read aloud or copied off a screen, and an ambiguous glyph turns a reset
// into a support call.
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generateTempPassword(length = 14) {
  const bytes = crypto.randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Rejection sampling — taking bytes modulo the alphabet length would make
    // the earliest characters fractionally likelier than the rest.
    const v = bytes[i];
    if (v < 256 - (256 % TEMP_ALPHABET.length)) out += TEMP_ALPHABET[v % TEMP_ALPHABET.length];
  }
  return out.length === length ? out : generateTempPassword(length);
}

// Reset ANOTHER user's password. System Administrator only, enforced here and
// not merely by hiding the button — the UI check is a convenience.
//
// A dedicated route rather than the existing PATCH /users/:id, which also
// accepts a password: a reset earns its own audit line and returns something
// PATCH does not, and overloading PATCH would have made "renamed a user" and
// "reset their credentials" indistinguishable in the log.
router.post("/users/:id/reset-password", requireAuth, requireRole("Admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = (await pool.query("SELECT * FROM users WHERE id = $1", [id])).rows[0];
    if (!target) return res.status(404).json({ error: "User not found." });

    // Resetting yourself here would hand you a temporary password and end your
    // own session on the next request — confusing, and there is a proper route
    // for it that asks for the current password first.
    if (Number(req.user.id) === id) {
      return res.status(400).json({
        error: "Use Change password to set your own. This resets somebody else's.",
      });
    }

    const temp = generateTempPassword();
    await pool.query(
      `UPDATE users SET password_hash = $1, "passwordChangedAt" = now(), "mustChangePassword" = true
        WHERE id = $2`,
      [bcrypt.hashSync(temp, 10), id]
    );
    // Ends the target's sessions immediately. This is the point of a reset when
    // an account is suspected compromised: without it the holder of a stolen
    // token carries on for up to twelve hours.
    invalidatePasswordStamp(id);

    await logAuth(
      req.user.username,
      "password_reset",
      `Reset the password for ${target.username} (${target.name}). They must set their own at next login.`
    );

    // Shown to the admin ONCE and never stored in the clear — not in the audit
    // log, not anywhere. If it is lost, reset again.
    res.json({
      ok: true,
      username: target.username,
      name: target.name,
      temporaryPassword: temp,
      mustChangePassword: true,
    });
  } catch (e) {
    console.error("[auth/reset-password]", e);
    res.status(500).json({ error: "Could not reset the password." });
  }
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
    // Display names only. `roles` stays the stored keys, which is what the
    // client must send back on a PATCH.
    roleLabels: ROLE_LABELS,
    // Modules whose READING is restricted. The Privileges screen shows a View
    // column only for these — offering it on the other eighteen would imply a
    // control that does nothing, since every other module is readable by any
    // signed-in user.
    viewRestricted: [...VIEW_RESTRICTED],
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
    `SELECT "moduleKey", "canAdd", "canEdit", "canDelete", "canView"
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
        `INSERT INTO user_module_permissions ("userId","moduleKey","canAdd","canEdit","canDelete","canView","updatedBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, p.moduleKey, !!p.canAdd, !!p.canEdit, !!p.canDelete, !!p.canView, req.user.username]
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
