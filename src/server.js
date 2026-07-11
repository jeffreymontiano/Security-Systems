require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

// Fail fast with a clear message if JWT_SECRET wasn't configured
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-this-to-a-long-random-string") {
  console.error("\n[FATAL] Please set a real JWT_SECRET in your .env file before starting the server.");
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

const { ready } = require("./db"); // initializes DB + seeds default data / admin user

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/meta", require("./routes/meta"));
app.use("/api/incidents", require("./routes/incidents"));

// Serve the frontend
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
