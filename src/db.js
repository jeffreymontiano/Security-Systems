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

    CREATE TABLE IF NOT EXISTS dsr_reports (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      site TEXT,
      shift TEXT,
      "submittedBy" TEXT,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted','Approved','Rejected')),
      "shiftTurnover" TEXT DEFAULT '',
      "visitorLog" TEXT DEFAULT '',
      "vehicleLog" TEXT DEFAULT '',
      "patrolReport" TEXT DEFAULT '',
      "securityObservations" TEXT DEFAULT '',
      "siteIssues" TEXT DEFAULT '',
      "approvedBy" TEXT,
      "approvedAt" TIMESTAMPTZ,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dsr_attachments (
      id SERIAL PRIMARY KEY,
      dsr_id INTEGER NOT NULL REFERENCES dsr_reports(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dropdown_options (
      id SERIAL PRIMARY KEY,
      list_key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(list_key, value)
    );

    CREATE TABLE IF NOT EXISTS disciplinary_cases (
      id SERIAL PRIMARY KEY,
      "employeeName" TEXT NOT NULL,
      site TEXT,
      "violationType" TEXT,
      "violationDate" TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Under Review','Resolved','Closed')),
      "nteDate" TEXT,
      "nteDetails" TEXT DEFAULT '',
      "employeeExplanation" TEXT DEFAULT '',
      "hearingDate" TEXT,
      "hearingNotes" TEXT DEFAULT '',
      penalty TEXT,
      "suspensionStart" TEXT,
      "suspensionEnd" TEXT,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS disciplinary_attachments (
      id SERIAL PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES disciplinary_cases(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS performance_appraisals (
      id SERIAL PRIMARY KEY,
      "employeeName" TEXT NOT NULL,
      site TEXT,
      "evaluationDate" TEXT NOT NULL,
      "evaluatorName" TEXT,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted','Finalized')),
      "attendanceScore" INTEGER,
      "incidentResponseScore" INTEGER,
      "patrolComplianceScore" INTEGER,
      "dsrComplianceScore" INTEGER,
      "clientSatisfactionScore" INTEGER,
      "appearanceDisciplineScore" INTEGER,
      "supervisorComments" TEXT DEFAULT '',
      "clientFeedback" TEXT DEFAULT '',
      "competencyAssessment" TEXT DEFAULT '',
      "promotionRecommended" TEXT DEFAULT 'Not Yet',
      "promotionNotes" TEXT DEFAULT '',
      "finalizedBy" TEXT,
      "finalizedAt" TIMESTAMPTZ,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS performance_attachments (
      id SERIAL PRIMARY KEY,
      appraisal_id INTEGER NOT NULL REFERENCES performance_appraisals(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS training_records (
      id SERIAL PRIMARY KEY,
      "employeeName" TEXT NOT NULL,
      site TEXT,
      "courseName" TEXT,
      "scheduledDate" TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','In Progress','Completed','Cancelled')),
      "attendanceStatus" TEXT,
      "examScore" TEXT,
      "examResult" TEXT,
      "certificationName" TEXT DEFAULT '',
      "certificationIssueDate" TEXT,
      "certificationExpiryDate" TEXT,
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS training_attachments (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL REFERENCES training_records(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS compliance_audits (
      id SERIAL PRIMARY KEY,
      site TEXT,
      "complianceArea" TEXT,
      "auditDate" TEXT NOT NULL,
      "auditorName" TEXT,
      status TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','In Progress','Completed','Cancelled')),
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS compliance_checklist_items (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES compliance_audits(id) ON DELETE CASCADE,
      "itemText" TEXT NOT NULL,
      compliant TEXT NOT NULL DEFAULT 'N/A' CHECK (compliant IN ('Yes','No','N/A')),
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS compliance_corrective_actions (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES compliance_audits(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      owner TEXT,
      "dueDate" TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','In Progress','Completed'))
    );

    CREATE TABLE IF NOT EXISTS compliance_attachments (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES compliance_audits(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const DROPDOWN_SEEDS = {
    vacancy_tracking_status:    ["Open","Filled","Escalated"],
    shift_assignments_status:   ["Scheduled","Completed","No-show","Cancelled"],
    shift_assignments_shift:    ["Day Shift","Night Shift"],
    reliever_management_status: ["Assigned","Completed","Cancelled"],
    deployment_planning_status: ["Planned","Confirmed","Deployed","Cancelled"],
    post_orders_status:         ["Draft","Active","Under Review","Retired"],
    violation_type: ["Absenteeism","Negligence","Sleeping on Duty","Improper Frisking","Post Abandonment","Insubordination","Unprofessional Conduct","Other"],
    penalty_type:   ["None","Verbal Warning","Written Warning","Suspension","Termination"],
    promotion_recommendation: ["Not Yet","Recommended","Not Recommended","Recommended with Conditions"],
    training_type: ["Security Officer Training","CCTV Operations","Fire Safety","First Aid","Emergency Response"],
    attendance_status: ["Attended","No-show","Excused"],
    exam_result: ["N/A","Pass","Fail"],
    compliance_area: ["Company SOPs","Security Protocols","Client Requirements","Labor Compliance"],
    corrective_action_status: ["Pending","In Progress","Completed"]
  };
  for (const [listKey, values] of Object.entries(DROPDOWN_SEEDS)) {
    const existingCount = (await pool.query("SELECT COUNT(*)::int c FROM dropdown_options WHERE list_key = $1", [listKey])).rows[0].c;
    if (existingCount === 0) {
      for (const v of values) {
        await pool.query("INSERT INTO dropdown_options (list_key, value) VALUES ($1,$2) ON CONFLICT DO NOTHING", [listKey, v]);
      }
    }
  }

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
