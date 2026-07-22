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

const { ready } = require("./db"); // initializes DB + seeds default data / admin user

const app = express();
app.set("trust proxy", 1); // Render sits behind a reverse proxy; needed for correct https detection
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/meta", require("./routes/meta"));
app.use("/api/incidents", require("./routes/incidents"));
app.use("/api/public", require("./routes/public"));
app.use("/api/ops", require("./routes/ops"));
app.use("/api/dsr", require("./routes/dsr"));
app.use("/api/disciplinary", require("./routes/disciplinary"));
app.use("/api/performance", require("./routes/performance"));
app.use("/api/training", require("./routes/training"));
app.use("/api/compliance", require("./routes/compliance"));
app.use("/api/recruitment", require("./routes/recruitment"));

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

// Serve the current (legacy) frontend at /
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Incident Reporting & Investigation system running on port ${PORT}`);
  });
});
