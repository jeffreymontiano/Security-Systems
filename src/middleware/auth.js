const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { actionFor, isWorkflowPath, effectivePermissions, can, isSuperUser, VIEW_RESTRICTED } = require("../lib/permissions");

// Populate req.user from the bearer token if there is a valid one, without
// deciding anything. Returns true when the request is identified.
//
// Needed because modulePermission() is mounted BEFORE a module's router and so
// runs before that router's own requireAuth — without this it would see no
// req.user and wave every write through, which is the one failure mode an
// authorisation check must not have.
function identify(req) {
  if (req.user) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return false;
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, username, name, role }
    return true;
  } catch {
    return false;
  }
}

// When each account's password last changed, so a token issued before that can
// be refused. Cached like the permissions above, and for the same reason: this
// runs on EVERY authenticated request, and a query per request to answer
// "nothing has changed" would be a poor trade.
//
// Invalidated the moment a password is written, so a reset takes effect at once
// rather than up to the cache window later.
const PWD_CACHE_MS = 10 * 1000;
const pwdCache = new Map();   // userId -> { at, changedAt }

function invalidatePasswordStamp(userId) {
  if (userId === undefined || userId === null) pwdCache.clear();
  else pwdCache.delete(Number(userId));
}

async function passwordChangedAt(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const hit = pwdCache.get(id);
  if (hit && Date.now() - hit.at < PWD_CACHE_MS) return hit.changedAt;
  const { rows } = await pool.query(`SELECT "passwordChangedAt" FROM users WHERE id = $1`, [id]);
  const changedAt = rows[0] ? rows[0].passwordChangedAt : null;
  pwdCache.set(id, { at: Date.now(), changedAt });
  return changedAt;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  // A password change ends every session that predates it — including this one
  // if it is the old one. `iat` is in seconds; a token issued in the same second
  // as the change is treated as still valid, since it can only be the new one.
  try {
    const changedAt = await passwordChangedAt(payload.id);
    if (changedAt && payload.iat && payload.iat * 1000 < new Date(changedAt).getTime() - 1000) {
      return res.status(401).json({ error: "Your password was changed. Please log in again." });
    }
  } catch (e) {
    // A failure to check must not become a failure to authenticate an otherwise
    // valid, signed token — that would lock everyone out on a database blip.
    console.error("[auth] could not read password stamp:", e.message);
  }

  req.user = payload; // { id, username, name, role }
  next();
}

// Roles allowed to call the route. Admin can always do everything.
//
// A role list names the roles that MAY do something; it is not the only way to
// earn the right. When modulePermission() has already checked this exact write
// against the user's Add/Edit/Delete matrix and allowed it, that IS the
// authorisation decision, and this check defers to it — otherwise granting
// "delete on Asset Management" to an Admin Officer would be silently overruled
// by a requireRole("Admin") further down, and the whole privilege screen would
// do nothing.
//
// The deference is deliberately narrow. `req.moduleGrant` is only ever set for
// a WRITE that the matrix explicitly permits, so reads and unmatched routes
// behave exactly as they always have.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated." });
    if (req.user.role === "Admin" || roles.includes(req.user.role)) return next();
    if (req.moduleGrant === true) return next();
    return res.status(403).json({ error: "You don't have permission to do that." });
  };
}

// ---------------------------------------------------------------------------
// Per-module Add / Edit / Delete
// ---------------------------------------------------------------------------

// Resolved per REQUEST, never embedded in the JWT. A permission baked into a
// token cannot be revoked until the user logs in again, which is the wrong
// behaviour for an authorisation change an administrator has just made.
//
// Cached briefly so a burst of requests costs one query rather than dozens.
// Deliberately short: an administrator changing a permission expects it to
// take effect while they are still watching, and the cache is dropped outright
// whenever a user's permissions are written (see invalidatePermissions).
const CACHE_MS = 10 * 1000;
const cache = new Map();   // userId -> { at, rows }

function invalidatePermissions(userId) {
  if (userId === undefined || userId === null) cache.clear();
  else cache.delete(Number(userId));
}

async function overridesFor(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return [];
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const { rows } = await pool.query(
    `SELECT "moduleKey", "canAdd", "canEdit", "canDelete", "canView"
     FROM user_module_permissions WHERE "userId" = $1`, [id]
  );
  cache.set(id, { at: Date.now(), rows });
  return rows;
}

async function permissionsFor(user) {
  if (!user) return {};
  if (isSuperUser(user.role)) return effectivePermissions(user.role, []);
  return effectivePermissions(user.role, await overridesFor(user.id));
}

// Guards every write on a module's routes, mounted once per router in
// server.js rather than repeated at 200 call sites — one place to be right,
// and impossible for a new route in an existing module to be added without it.
//
// Reads pass straight through: this matrix is Add / Edit / Delete, and what a
// user may SEE is still governed by requireAuth and the existing role checks,
// which all still run.
//
// `exempt` lists paths within the module that must not be gated — the
// self-service endpoints on /api/auth, where a user changing their own password
// is not "adding a user".
function modulePermission(moduleKey, { exempt = [] } = {}) {
  const exemptRe = exempt.length
    ? new RegExp(`^(${exempt.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(/|$)`, "i")
    : null;

  return async (req, res, next) => {
    try {
      const action = actionFor(req.method, req.path);

      // Reads are open everywhere EXCEPT the handful of modules in
      // VIEW_RESTRICTED — today only Executive Summary, a leadership view that
      // is closed by default and opened per user. Checked here so the rule sits
      // beside the write rule rather than being scattered through the routes.
      if (!action && VIEW_RESTRICTED.has(moduleKey)) {
        if (exemptRe && exemptRe.test(req.path)) return next();
        if (!identify(req)) return next();          // let requireAuth answer 401
        if (isSuperUser(req.user.role)) return next();
        const perms = await permissionsFor(req.user);
        if (can(perms, moduleKey, "view")) return next();
        return res.status(403).json({
          error: "You do not have access to this view. An administrator can grant it in Manage Users.",
        });
      }

      if (!action) return next();                                  // a read
      if (exemptRe && exemptRe.test(req.path)) return next();      // self-service

      // No valid token: fall through so the route's own requireAuth answers
      // 401. Refusing here with 403 would tell an anonymous caller "you lack a
      // permission" when the real answer is "you are not logged in".
      if (!identify(req)) return next();
      if (isSuperUser(req.user.role)) return next();

      const perms = await permissionsFor(req.user);
      if (can(perms, moduleKey, action)) {
        // Record that THIS write was authorised by the matrix, so the route's
        // own requireRole() defers rather than overruling a privilege an
        // administrator deliberately granted.
        //
        // NOT for a workflow step. Finalising a return, issuing an order or
        // marking a period paid keeps whatever role its route demands: holding
        // "edit" on a module should let someone build a document, not file it.
        // Both checks then have to pass.
        if (!isWorkflowPath(req.path)) req.moduleGrant = true;
        return next();
      }

      return res.status(403).json({
        error: `You don't have permission to ${action} in this module.`,
        module: moduleKey,
        action,
      });
    } catch (e) {
      // A failure to establish permission must never be read as permission.
      console.error("[permissions]", e);
      return res.status(500).json({ error: "Could not verify your permissions." });
    }
  };
}

module.exports = {
  requireAuth, requireRole,
  modulePermission, permissionsFor, invalidatePermissions,
  invalidatePasswordStamp,
};
