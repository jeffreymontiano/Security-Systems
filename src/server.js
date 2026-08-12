require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// Fail fast with a clear message if JWT_SECRET wasn't configured
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-this-to-a-long-random-string") {
  console.error("\n[FATAL] Please set a real JWT_SECRET in your .env file before starting the server.");
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

const { modulePermission } = require("./middleware/auth");
const { opsModuleFor } = require("./lib/permissions");
const { ready } = require("./db"); // initializes DB + seeds default data / admin user

const app = express();
app.set("trust proxy", 1); // Render sits behind a reverse proxy; needed for correct https detection
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Startup: the port opens FIRST, migrations run after -------------------
//
// app.listen() used to sit inside ready.then(), so the port only opened once
// db.js had finished all 37 of its migration queries. Nothing in that path had
// a timeout, so a Neon connection that stalled rather than failed left the
// promise pending forever, the port never opened, and Render's port scan timed
// out with no error logged anywhere — the process looked healthy and simply
// never bound. A deploy failing that way gives nothing to diagnose.
//
// The port is bound unconditionally now. Requests that need the database are
// answered 503 until migrations finish, which is a truthful "not yet" instead
// of a query against half-built schema.
let dbReady = false;
ready.then(() => {
  dbReady = true;
  console.log("[startup] Database ready — API serving.");
});
// A rejection is already fatal in db.js (it logs and exits), so there is
// nothing to add here; the container dies visibly rather than hanging.

// Cheap liveness endpoint that never touches the database, so a health check
// answers during migrations too.
app.get("/healthz", (req, res) => {
  res.json({ ok: true, db: dbReady ? "ready" : "starting" });
});

// Only /api is gated. The React bundle and the login screen are static and load
// fine while the database is still coming up.
app.use("/api", (req, res, next) => {
  if (dbReady) return next();
  res.set("Retry-After", "5");
  res.status(503).json({ error: "The server is still starting up. Please try again in a moment." });
});

app.use("/api/auth", modulePermission("users", { exempt: ["/login", "/change-password", "/me", "/logout"] }), require("./routes/auth"));
app.use("/api/meta", modulePermission("lists", { openRead: true }), require("./routes/meta"));
app.use("/api/incidents", modulePermission("incidents"), require("./routes/incidents"));
app.use("/api/public", require("./routes/public"));
// Shared by two modules. The record type in the path says which page a request
// belongs to, so the module is resolved per request — see opsModuleFor().
app.use("/api/ops", modulePermission(opsModuleFor), require("./routes/ops"));
app.use("/api/dsr", modulePermission("dsr"), require("./routes/dsr"));
app.use("/api/disciplinary", modulePermission("disciplinary"), require("./routes/disciplinary"));
app.use("/api/performance", modulePermission("performance"), require("./routes/performance"));
app.use("/api/training", modulePermission("training"), require("./routes/training"));
app.use("/api/compliance", modulePermission("compliance"), require("./routes/compliance"));
app.use("/api/recruitment", modulePermission("recruitment"), require("./routes/recruitment"));
app.use("/api/employees", modulePermission("employees"), require("./routes/employees"));
app.use("/api/settings", modulePermission("settings", { openRead: true }), require("./routes/settings"));
// Read-only leadership view. modulePermission enforces the view privilege on
// GET because "executive" is in VIEW_RESTRICTED - see lib/permissions.js.
app.use("/api/executive-summary", modulePermission("executive"), require("./routes/executive-summary"));
app.use("/api/attendance", modulePermission("attendance"), require("./routes/attendance"));
app.use("/api/scheduling", modulePermission("scheduling"), require("./routes/scheduling"));
app.use("/api/attendance-reports", modulePermission("attendance"), require("./routes/attendance-reports"));
app.use("/api/absence-monitoring", modulePermission("attendance"), require("./routes/absence-monitoring"));
app.use("/api/overtime", modulePermission("attendance"), require("./routes/overtime"));
app.use("/api/leave", modulePermission("leave"), require("./routes/leave"));
app.use("/api/payroll", modulePermission("payroll"), require("./routes/payroll"));
app.use("/api/billing", modulePermission("billing"), require("./routes/billing"));
app.use("/api/assets", modulePermission("assets"), require("./routes/assets"));
app.use("/api/ddo", modulePermission("deployment"), require("./routes/ddo"));
app.use("/api/security-reports", modulePermission("securityReports"), require("./routes/securityReports"));
app.use("/api/useful-links", modulePermission("usefulLinks"), require("./routes/useful-links"));

// --- React migration (in progress) ---
// Served at /app so the current production app at / is completely
// untouched while the React version is built out module by module.
// See REACT-MIGRATION-PLAN.md. Once the migration reaches Phase 6, this
// becomes the only frontend and the block below it (the legacy app) is removed.
const reactDist = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(reactDist)) {
  app.use("/app", express.static(reactDist));
  app.get("/app/*", (req, res) => {
    res.sendFile(path.join(reactDist, "index.html"));
  });
} else {
  console.log("[react] frontend/dist not found yet — run `npm run build` inside frontend/ to enable /app. Skipping for now.");
}

// report.html and dsr-report.html were withdrawn in Stage A and answered 410
// here. Both are REINSTATED (2026-08) and are served by the static handler
// below like every other public form, so the 410 is gone with them. Their POST
// routes are back in routes/public.js behind requireFormToken.

// Serve the current (legacy) frontend at /
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Express 4 does not catch errors thrown from async route handlers, so a
// single failed query used to reject unhandled and — under Node's default
// behaviour — take the whole process down, dropping every other user's
// session. These keep the service alive and leave a diagnosable log line
// instead. They are a safety net, not a substitute for handling errors in the
// route: a request that lands here still gets no response and will time out.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled promise rejection:", reason && reason.stack ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception:", err && err.stack ? err.stack : err);
});

// Catches anything routed through next(err) or thrown synchronously.
app.use((err, req, res, next) => {
  console.error("[error]", req.method, req.originalUrl, "-", err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 3000;
// Bound immediately, and to 0.0.0.0 explicitly: Render's port scan has to find
// an open port on every interface, and a host argument left to Node's default
// is one fewer thing to reason about when a deploy fails.
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Incident Reporting & Investigation system listening on 0.0.0.0:${PORT}`);
  console.log("[startup] Running database migrations…");
});

// A failed bind MUST be fatal. Without this the uncaughtException guard above
// catches EADDRINUSE, logs it, and lets the process carry on with no listening
// socket — a container that is up, answers nothing, and reports no error, which
// is the same "no open ports detected" a port scan sees. Observed while testing
// this very change, on a port that was already taken.
server.on("error", (err) => {
  console.error(`[FATAL] Could not bind port ${PORT}:`, err && err.message ? err.message : err);
  process.exit(1);
});
