const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.error("\n[FATAL] DATABASE_URL is not set. Put your Neon connection string in .env\n");
  process.exit(1);
}

const useSsl = /sslmode=require|neon\.tech/i.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

const DEFAULT_CLASSIFICATIONS = ["Theft","Trespassing","Accidents","Property damage","Security breach","Safety violation"];
const DEFAULT_SITES = ["BBGC","RH","PFC","Brookdale","BFC","BFC Swine","Feedmill","Hatchery","Motorpool","Burot Egg Store","Saluyot Egg Store","Other"];

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('Admin','Investigator','Viewer')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS classifications (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      site TEXT NOT NULL,
      classification TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT,
      "reportedBy" TEXT,
      assigned TEXT,
      status TEXT NOT NULL DEFAULT 'Reported',
      "resolvedDate" TEXT,
      "rootCause" TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id SERIAL PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      type TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS witnesses (
      id SERIAL PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      statement TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      type TEXT,
      description TEXT NOT NULL,
      owner TEXT,
      "dueDate" TEXT,
      status TEXT DEFAULT 'Pending'
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      incident_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const classCount = (await pool.query("SELECT COUNT(*)::int c FROM classifications")).rows[0].c;
  if (classCount === 0) {
    for (const c of DEFAULT_CLASSIFICATIONS) {
      await pool.query("INSERT INTO classifications (name) VALUES ($1) ON CONFLICT DO NOTHING", [c]);
    }
  }
  const siteCount = (await pool.query("SELECT COUNT(*)::int c FROM sites")).rows[0].c;
  if (siteCount === 0) {
    for (const s of DEFAULT_SITES) {
      await pool.query("INSERT INTO sites (name) VALUES ($1) ON CONFLICT DO NOTHING", [s]);
    }
  }

  const userCount = (await pool.query("SELECT COUNT(*)::int c FROM users")).rows[0].c;
  if (userCount === 0) {
    const username = process.env.INITIAL_ADMIN_USERNAME || "admin";
    const password = process.env.INITIAL_ADMIN_PASSWORD || "changeme123";
    const name = process.env.INITIAL_ADMIN_NAME || "System Administrator";
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,'Admin')",
      [username, hash, name]
    );
    console.log(`\n[seed] Created initial Admin account -> username: "${username}"`);
    console.log(`[seed] Log in with the password from INITIAL_ADMIN_PASSWORD in your .env, then change it.\n`);
  }
}

const ready = migrate().catch(err => {
  console.error("[FATAL] Database migration/seed failed:", err.message);
  process.exit(1);
});

module.exports = { pool, ready };
