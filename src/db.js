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

    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ops_records (
      id SERIAL PRIMARY KEY,
      record_type TEXT NOT NULL CHECK (record_type IN (
        'guard_deployment','site_status','duty_roster','gps_monitoring',
        'visitor_count','vehicle_count','daily_metrics',
        'site_profiles','post_orders','deployment_planning','reliever_management',
        'vacancy_tracking','shift_assignments','manpower_requirements'
      )),
      date TEXT NOT NULL,
      site TEXT,
      label TEXT NOT NULL,
      status TEXT,
      value TEXT,
      notes TEXT,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Module 11 added new record types after ops_records already existed in production —
  // CREATE TABLE IF NOT EXISTS won't touch an existing table's constraints, so update it explicitly.
  await pool.query(`ALTER TABLE ops_records DROP CONSTRAINT IF EXISTS ops_records_record_type_check`);
  await pool.query(`
    ALTER TABLE ops_records ADD CONSTRAINT ops_records_record_type_check CHECK (record_type IN (
      'guard_deployment','site_status','duty_roster','gps_monitoring','visitor_count','vehicle_count','daily_metrics',
      'site_profiles','post_orders','deployment_planning','reliever_management','vacancy_tracking','shift_assignments','manpower_requirements'
    ))
  `);

  // Migrate old default status values from the previous 6-stage workflow
  // to the simplified Open -> Under Investigation -> Resolved -> Closed flow.
  await pool.query(`UPDATE incidents SET status = 'Open' WHERE status = 'Reported'`);
  await pool.query(`UPDATE incidents SET status = 'Under Investigation' WHERE status IN ('Root Cause Identified','Corrective Action Planned')`);
  await pool.query(`ALTER TABLE incidents ALTER COLUMN status SET DEFAULT 'Open'`);

  // Sequence-backed incident numbering: atomic under concurrency, which matters
  // now that incidents can be created both from the authenticated app and the
  // public (unauthenticated) report form at the same time.
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS incident_id_seq`);
  const maxRow = await pool.query(`SELECT MAX(substring(id from 'INC-(\\d+)')::int) AS maxn FROM incidents`);
  const maxN = maxRow.rows[0].maxn || 0;
  if (maxN > 0) {
    await pool.query(`SELECT setval('incident_id_seq', $1, true)`, [maxN]);
  } else {
    await pool.query(`SELECT setval('incident_id_seq', 1, false)`);
  }

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
