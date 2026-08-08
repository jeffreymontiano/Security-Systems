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
const { ready } = require("./db"); // initializes DB + seeds default data / admin user

const app = express();
app.set("trust proxy", 1); // Render sits behind a reverse proxy; needed for correct https detection
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", modulePermission("users", { exempt: ["/login", "/change-password", "/me", "/logout"] }), require("./routes/auth"));
app.use("/api/meta", modulePermission("lists"), require("./routes/meta"));
app.use("/api/incidents", modulePermission("incidents"), require("./routes/incidents"));
app.use("/api/public", require("./routes/public"));
app.use("/api/ops", modulePermission("deployment"), require("./routes/ops"));
app.use("/api/dsr", modulePermission("dsr"), require("./routes/dsr"));
app.use("/api/disciplinary", modulePermission("disciplinary"), require("./routes/disciplinary"));
app.use("/api/performance", modulePermission("performance"), require("./routes/performance"));
app.use("/api/training", modulePermission("training"), require("./routes/training"));
app.use("/api/compliance", modulePermission("compliance"), require("./routes/compliance"));
app.use("/api/recruitment", modulePermission("recruitment"), require("./routes/recruitment"));
app.use("/api/employees", modulePermission("employees"), require("./routes/employees"));
app.use("/api/settings", modulePermission("settings"), require("./routes/settings"));
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

// The withdrawn public forms. Answered explicitly BEFORE the static handler and
// the catch-all below, which would otherwise serve the legacy app's index.html
// for these paths — so an old shared link would show a login page and look like
// a broken form rather than a withdrawn one. Their API routes are already gone
// from routes/public.js, so nothing could be submitted either way; this just
// says so plainly.
const WITHDRAWN_FORMS = ["/report.html", "/dsr-report.html"];
app.get(WITHDRAWN_FORMS, (req, res) => {
  res.status(410).type("html").send(
    `<!doctype html><meta charset="utf-8">` +
    `<title>Form withdrawn</title>` +
    `<div style="font-family:Calibri,Arial,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#0B2545">` +
    `<h1 style="font-size:1.3rem">This form is no longer available</h1>` +
    `<p style="line-height:1.7;color:#5B6B85">Incident reports and Daily Security Reports are now filed from inside ` +
    `CSOMS by a signed-in user. Please contact your administrator for access.</p></div>`
  );
});

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
ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Incident Reporting & Investigation system running on port ${PORT}`);
  });
});
