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
  ssl: useSsl ? { rejectUnauthorized: false } : false,

  // Nothing here had a timeout, which is how a deploy failed with no error at
  // all: Neon autosuspends, a cold connection stalled instead of refusing, and
  // every await below waited forever. A stall now becomes a rejection, and
  // migrate()'s .catch turns that into a logged exit — a failure someone can
  // read, rather than a process that looks alive and never finishes starting.
  connectionTimeoutMillis: 15000,

  // Generous on purpose: the whole migration is ~10s across 37 statements, and
  // the slowest report queries are well under this. It exists to end a hung
  // statement, not to police normal work.
  statement_timeout: 60000,
});

// A connection dropped while idle in the pool is normal with a serverless
// Postgres; without a listener it would be an unhandled 'error' event and take
// the process down.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err && err.message ? err.message : err);
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

    -- The role list grew from three to seven. The CHECK is widened rather than
    -- replaced piecemeal, and the two legacy roles stay VALID so no existing
    -- user row becomes illegal or loses access on upgrade — they are simply no
    -- longer offered for a new user.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
      'Admin',
      'Owner / President / General Manager',
      'Operation Manager / Operation Officer / Supervisor',
      'HR',
      'Accounting / Payroll',
      'Admin Officer',
      'Inspector / Investigator',
      -- legacy, still honoured
      'Investigator',
      'Viewer'
    ));

    -- Per-user, per-module Add / Edit / Delete privileges.
    --
    -- A row here OVERRIDES the role's default for that one module; absence
    -- means "use the role default". That is what makes the upgrade a no-op:
    -- with no rows at all, every user behaves exactly as they did before, and
    -- an administrator opts into finer control one cell at a time.
    --
    -- Read access is deliberately NOT modelled. This matrix is Add / Edit /
    -- Delete, as specified; what a user may see is still governed by
    -- requireAuth and the existing role checks.
    CREATE TABLE IF NOT EXISTS user_module_permissions (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "moduleKey" TEXT NOT NULL,
      "canAdd" BOOLEAN NOT NULL DEFAULT false,
      "canEdit" BOOLEAN NOT NULL DEFAULT false,
      "canDelete" BOOLEAN NOT NULL DEFAULT false,
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("userId", "moduleKey")
    );
    -- When this account's password last changed. A JWT here is stateless and
    -- signed for 12 hours, and requireAuth only ever checked the signature — so
    -- resetting a compromised account's password did NOT end the attacker's
    -- session, it just stopped them logging in again. Tokens issued before this
    -- moment are now refused, which is what makes a reset an actual control.
    -- Nullable: an account that has never changed its password has nothing to
    -- compare against, and every existing token stays valid.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ;

    -- Set when an administrator resets someone's password, cleared when that
    -- person sets their own. Without it a handed-over temporary password
    -- quietly becomes the permanent one.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

    CREATE INDEX IF NOT EXISTS idx_user_module_permissions_user
      ON user_module_permissions ("userId");

    -- Read access, and ONLY for the modules named in VIEW_RESTRICTED
    -- (permissions.js) — today just Executive Summary. Every other module stays
    -- readable by any signed-in user, as it always has been, so this column is
    -- meaningless for them and effectivePermissions() forces their view to true
    -- regardless of what a row says. Defaults to false: a leadership view must
    -- be granted, never inherited.
    ALTER TABLE user_module_permissions ADD COLUMN IF NOT EXISTS "canView" BOOLEAN NOT NULL DEFAULT false;

    -- "Security Admin Officer" (stored key: 'Admin Officer') was re-scoped to
    -- six modules. Its ROLE_DEFAULTS entry is read LIVE on every request, not
    -- snapshotted when a user is created, so narrowing it would have silently
    -- stripped access from every existing holder on the next request.
    --
    -- This freezes what they hold TODAY into explicit rows first. After it runs
    -- each existing account keeps exactly its current access, and the new,
    -- narrower default applies only to users given the role from now on —
    -- which is what was asked for. An admin can still widen or narrow any of
    -- them by hand afterwards; these are ordinary override rows.
    --
    -- The old grants are written out literally rather than read from
    -- permissions.js, because that file already carries the NEW default by the
    -- time this runs. Reading it would freeze the new scope and defeat the
    -- whole point. Old default was:
    --     assets, lists                     add+edit+delete
    --     employees, deployment, settings   add+edit
    --
    -- EVERY module is written, including the ones the old scope did not grant,
    -- which are pinned to false/false/false. That is not padding. Overrides are
    -- layered ON TOP of the role default, so a module left without a row falls
    -- through to whatever the default says — and the new default grants
    -- Compliance, Recruitment and Security Reports. Freezing only the five
    -- granted modules would therefore have silently WIDENED every existing
    -- holder into three modules they never had. Re-scoping upward is still
    -- re-scoping; pinning all nineteen makes the frozen row set complete, so
    -- the account is decided entirely by its own rows.
    --
    -- ON CONFLICT DO NOTHING so an admin's existing explicit override always
    -- wins over the frozen default, and so re-running is harmless. The flag
    -- makes it run once: without it, a later deliberate narrowing by an admin
    -- would be undone on the next boot.
    CREATE TABLE IF NOT EXISTS migration_flags (
      key TEXT PRIMARY KEY,
      "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO user_module_permissions ("userId", "moduleKey", "canAdd", "canEdit", "canDelete", "updatedBy")
    SELECT u.id, m."moduleKey", m."canAdd", m."canEdit", m."canDelete",
           'migration:freeze-admin-officer'
      FROM users u
      CROSS JOIN (VALUES
        -- granted by the OLD default
        ('assets',          true,  true,  true ),
        ('lists',           true,  true,  true ),
        ('employees',       true,  true,  false),
        ('deployment',      true,  true,  false),
        ('settings',        true,  true,  false),
        -- everything else the old default did NOT grant, pinned closed
        ('attendance',      false, false, false),
        ('leave',           false, false, false),
        ('payroll',         false, false, false),
        ('billing',         false, false, false),
        ('recruitment',     false, false, false),
        ('incidents',       false, false, false),
        ('scheduling',      false, false, false),
        ('dsr',             false, false, false),
        ('securityReports', false, false, false),
        ('disciplinary',    false, false, false),
        ('performance',     false, false, false),
        ('training',        false, false, false),
        ('compliance',      false, false, false),
        ('users',           false, false, false)
      ) AS m("moduleKey", "canAdd", "canEdit", "canDelete")
     WHERE u.role = 'Admin Officer'
       AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'freeze-admin-officer-scope')
    ON CONFLICT ("userId", "moduleKey") DO NOTHING;

    INSERT INTO migration_flags (key) VALUES ('freeze-admin-officer-scope')
    ON CONFLICT (key) DO NOTHING;

    -- The agency's access matrix replaced every business role's defaults, and
    -- it is meant to govern EXISTING accounts too. The freeze above pinned each
    -- Admin Officer's old scope into explicit rows, and an explicit row beats a
    -- default — so without this, exactly the accounts the matrix re-scopes are
    -- the ones it would not reach. Those rows are released so the account falls
    -- through to its role's matrix defaults again.
    --
    -- Only rows still carrying the migration's own marker are removed. The
    -- privileges PUT stamps "updatedBy" with the acting admin's username, so a
    -- deliberate per-user override set since the freeze is untouched — this
    -- undoes the migration, not an administrator's decision.
    DELETE FROM user_module_permissions
     WHERE "updatedBy" = 'migration:freeze-admin-officer'
       AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'apply-agency-access-matrix');

    INSERT INTO migration_flags (key) VALUES ('apply-agency-access-matrix')
    ON CONFLICT (key) DO NOTHING;

    -- Visitor Count and Vehicle Count lost their "Description" field: each
    -- record is a number for a site on a date, and Notes carries anything worth
    -- writing about it. The label stopped being displayed but stayed on the
    -- row, so this clears it at the agency's request.
    --
    -- DESTRUCTIVE and one-way: the text is not copied anywhere first. Guarded by
    -- migration_flags so a later entry — there is no field to type one in, but a
    -- direct write could — is not silently wiped on the next boot.
    --
    -- Scoped to these two record types. Every other tab still shows its label
    -- (a guard's name on Daily Manning, the site note on Site Status), and
    -- clearing those would erase what the record is about.
    UPDATE ops_records
       SET label = ''
     WHERE record_type IN ('visitor_count', 'vehicle_count')
       AND COALESCE(label, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'clear-count-descriptions');

    INSERT INTO migration_flags (key) VALUES ('clear-count-descriptions')
    ON CONFLICT (key) DO NOTHING;

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

    CREATE TABLE IF NOT EXISTS applicants (
      id SERIAL PRIMARY KEY,
      "fullName" TEXT NOT NULL,
      position TEXT,
      site TEXT,
      "applicationDate" TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Applied' CHECK (status IN (
        'Applied','Screening','Interview','Background & Medical Checks','Approved','Hired','Onboarded','Rejected'
      )),
      "interviewDate" TEXT,
      "interviewNotes" TEXT DEFAULT '',
      "backgroundCheckStatus" TEXT,
      "licenseStatus" TEXT,
      "medicalExamStatus" TEXT,
      "hireDate" TEXT,
      "contractIssuedDate" TEXT,
      "employmentStatus" TEXT,
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS applicant_checklist_items (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
      "itemText" TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT 'No' CHECK (completed IN ('Yes','No')),
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS applicant_equipment_issuance (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
      "itemName" TEXT NOT NULL,
      "issuedDate" TEXT,
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS applicant_attachments (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      "employeeNo" TEXT UNIQUE,
      "fullName" TEXT NOT NULL,
      position TEXT,
      site TEXT,
      "dateHired" TEXT,
      "employmentStatus" TEXT NOT NULL DEFAULT 'Active'
        CHECK ("employmentStatus" IN ('Active','Separated','Suspended','On Leave')),
      "birthDate" TEXT,
      gender TEXT,
      "civilStatus" TEXT,
      address TEXT DEFAULT '',
      "contactNumber" TEXT,
      email TEXT,
      "sssNo" TEXT,
      "philhealthNo" TEXT,
      "pagibigNo" TEXT,
      "tinNo" TEXT,
      "emergencyContactName" TEXT,
      "emergencyContactNumber" TEXT,
      "emergencyContactRelation" TEXT,
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- License to Exercise Security Profession (LESP) — the PNP/SOSIA licence
    -- a security guard must hold to work a post. Sits with the other
    -- government IDs on the 201 File rather than with documents, because it is
    -- a number carried on the person, not a file.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lespNo" TEXT NOT NULL DEFAULT '';

    -- When that licence lapses. Reported to RCSU beside the number on every
    -- Monthly Disposition Report, so it belongs on the person's record and is
    -- captured once — not re-keyed onto each month's return.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lespExpiry" DATE;

    -- The category the licence is issued under (Security Guard, Security
    -- Officer, K9 Handler, …). Free TEXT rather than a CHECK constraint,
    -- because the option list is admin-maintainable from Manage Lists
    -- (dropdown list "lesp_category") and a constraint here would mean a
    -- migration every time SOSIA revises the categories.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lespCategory" TEXT NOT NULL DEFAULT '';

    -- Clearance and examination dates a guard must keep current.
    --
    -- These are DATEs on the person, distinct from the employee_documents rows
    -- that hold the scanned certificate and its own expiry: a guard can have
    -- taken a medical last March with no scan uploaded, and the agency still
    -- needs to know when it was. NULLABLE with no default, so every existing
    -- record stays valid and simply reads "not recorded".
    --
    -- Real DATE columns, so they are rendered with to_char in
    -- lib/employeeHelpers.js — node-postgres turns a DATE into a JS Date at
    -- UTC midnight, which JSON-serialises to the PREVIOUS day at UTC+8.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "policeClearanceExpiry" DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lastMedicalExam" DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lastNeuroExam" DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lastDrugTestExam" DATE;

    -- Where this employee's net pay is sent. Captured on the 201 File and
    -- consumed by the payroll disbursement run.
    --
    -- The stored channel is the HUMAN choice (GCASH / PAYMAYA / GOTYME /
    -- BANK), never a payment provider's code. Provider codes belong in
    -- src/lib/xenditChannels.js so switching or re-coding a provider is a
    -- one-file change and no employee record has to be rewritten.
    --
    -- "payoutAccountNumber" means different things by channel: a mobile
    -- number (09XXXXXXXXX) for the GCash/PayMaya wallets, a bank account
    -- number for GoTyme and banks. GoTyme is a digital BANK, not an e-wallet.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "payoutChannel" TEXT NOT NULL DEFAULT '';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "payoutAccountNumber" TEXT NOT NULL DEFAULT '';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "payoutAccountName" TEXT NOT NULL DEFAULT '';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "payoutBankCode" TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS employee_documents (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "docType" TEXT,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      "issueDate" TEXT,
      "expiryDate" TEXT,
      notes TEXT DEFAULT '',
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS employee_education (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "level" TEXT,
      "schoolName" TEXT NOT NULL,
      "courseOrStrand" TEXT DEFAULT '',
      "yearGraduated" TEXT,
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS employee_employment_history (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "companyName" TEXT NOT NULL,
      position TEXT,
      "employmentType" TEXT,
      "yearsEmployed" TEXT,
      "dateResigned" TEXT,
      notes TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_employee_documents_employee
      ON employee_documents (employee_id);
    CREATE INDEX IF NOT EXISTS idx_employee_education_employee
      ON employee_education (employee_id);
    CREATE INDEX IF NOT EXISTS idx_employee_employment_history_employee
      ON employee_employment_history (employee_id);

    -- Additive column for employment type/status on history rows. Runs safely
    -- whether the table was just created or already existed from a prior deploy.
    ALTER TABLE employee_employment_history ADD COLUMN IF NOT EXISTS "employmentType" TEXT;

    -- Global branding/settings. Single-row config (enforced by the id=1 CHECK):
    -- company name shown across the app + exports, and the logo stored as BYTEA
    -- so it survives redeploys, like attachments. PNG/JPEG only (validated in
    -- the route) so the same image works in the web UI and embedded in PDFs.
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      "companyName" TEXT NOT NULL DEFAULT 'Brookside Farms Corporation',
      "logoData" BYTEA,
      "logoMimetype" TEXT,
      "logoFilename" TEXT,
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Letterhead fields. The Statement of Account prints a full agency
    -- letterhead — tagline, address, contact details, and the signatory who
    -- prepares it — none of which the company name and logo alone can supply.
    -- They live here rather than in the billing module because they identify
    -- the agency, not the billing run, and any future document can reuse them.
    --
    -- Values carry the agency's current letterhead as the column DEFAULT
    -- rather than as a separate backfill: ADD COLUMN IF NOT EXISTS applies it
    -- to the existing row exactly once and can never re-apply, so no guard
    -- flag is needed. Labels ("Main Office:", "Mobile No.") are NOT stored —
    -- the PDF renders them — so each field holds one editable value.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyTagline" TEXT NOT NULL DEFAULT '(THE EAGLE KING MARATHON)';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyAddress" TEXT NOT NULL DEFAULT 'BLK 9F LOT 45 Marina Homes, Brgy. Burot, Tarlac City';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyMobile" TEXT NOT NULL DEFAULT '0998-411-1107 / 0956-246-1891';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyEmail" TEXT NOT NULL DEFAULT 'theeaglekingpsa122021@gmail.com';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "ownerName" TEXT NOT NULL DEFAULT '2nd Lt. Peregrino C. Antoque (Retired) PA';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "ownerPosition" TEXT NOT NULL DEFAULT 'General Manager / Owner';

    -- Duty Detail Order letterhead. A DDO shows the agency's LTO licence
    -- number (a PNP inspector checks it) and is signed by the Admin/Operation
    -- head, NOT by the owner who signs a Statement of Account — so these are
    -- separate fields rather than a reuse of "ownerName".
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyLtoNo" TEXT NOT NULL DEFAULT 'PSA-WGS-M00701-2024';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "adminHeadName" TEXT NOT NULL DEFAULT '2LT WILLIAM A. APOLINARIO (RET) PA';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "adminHeadPosition" TEXT NOT NULL DEFAULT 'ADMIN/OPERATION HEAD';

    -- The single "Admin/Operation head" above is being separated into the two
    -- distinct officers an agency actually has. The old pair is DELIBERATELY
    -- kept rather than dropped: documents already issued reference it, and a
    -- dropped column cannot be rolled back.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "adminOfficerName" TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "adminOfficerPosition" TEXT NOT NULL DEFAULT 'Admin Officer';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "operationHeadName" TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "operationHeadPosition" TEXT NOT NULL DEFAULT 'Operation Head';

    -- Carry the existing single signatory across to the OPERATION HEAD, which
    -- is who signs a Duty Detail Order — so no already-configured agency sees
    -- its DDO signatory change or blank out. The Admin Officer starts empty for
    -- them to fill in.
    --
    -- Guarded by its own flag, not by "is the target blank": an admin who
    -- deliberately clears the Operation Head must not have it silently
    -- refilled on the next boot.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "signatoriesSplit" BOOLEAN NOT NULL DEFAULT false;
    UPDATE app_settings
       SET "operationHeadName"     = "adminHeadName",
           "operationHeadPosition" = COALESCE(NULLIF("adminHeadPosition", ''), 'Operation Head'),
           "signatoriesSplit"      = true
     WHERE "signatoriesSplit" = false;

    -- Monthly Disposition Report letterhead and filing defaults.
    --
    -- The MDR letterhead prints the LTO licence number AND the date it
    -- expires, plus a named contact person -- an RCSU reader needs to know
    -- whom to call, which the agency's general mobile number does not say.
    -- "agencyContactMobile" falls back to "agencyMobile" when left blank.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyLtoExpiry" DATE;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyContactPerson" TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyContactMobile" TEXT NOT NULL DEFAULT '';

    -- Where the agency files, and to whom. An agency files with the same
    -- regional unit every month, so these are configured once and every new
    -- report is pre-filled from them; they stay editable on the report for the
    -- month a return goes to a different region.
    --
    -- The SUBJECT LINE is deliberately NOT stored: it is composed from the
    -- region and the report's own month, so it can never name a month the
    -- body and the certification line disagree with -- the exact defect the
    -- source workbook carries.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyRegion" TEXT NOT NULL DEFAULT 'Region 3';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyRcsuAddressee" TEXT NOT NULL DEFAULT 'C, RCSU 3';
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS "agencyRcsuAttention" TEXT NOT NULL DEFAULT '(Attn: C, SAGS)';

    -- Attendance & Timekeeping capture. One row per IN or OUT punch, submitted
    -- from the public selfie form. Selfie stored as BYTEA (PNG/JPEG) like other
    -- attachments; lat/lng captured from the device at punch time (device-
    -- reported, not tamper-proof). "createdBy" records the guard name entered on
    -- the public form (prefixed like other public submissions).
    CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "punchType" TEXT NOT NULL CHECK ("punchType" IN ('IN','OUT')),
      "punchAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "selfieData" BYTEA,
      "selfieMimetype" TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS "employeeNo" TEXT;

    -- Reusable shift definitions per site (e.g. "BFC Day 06:00-18:00"). Times
    -- are stored as HH:MM strings; "crossesMidnight" flags night shifts whose
    -- end time is on the next calendar day (e.g. 18:00-06:00) so late/OT math
    -- can handle the wrap correctly.
    CREATE TABLE IF NOT EXISTS shift_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      site TEXT,
      "startTime" TEXT NOT NULL,
      "endTime" TEXT NOT NULL,
      "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Per-day roster: one row per guard assigned to a shift on a date. This is
    -- the schedule that drives late/undertime/overtime and absence reporting.
    -- References a real employee (201 File) and a shift template; both use
    -- ON DELETE SET NULL so deleting an employee/template doesn't wipe history.
    CREATE TABLE IF NOT EXISTS shift_assignments (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "shiftTemplateId" INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL,
      "shiftName" TEXT,
      "startTime" TEXT,
      "endTime" TEXT,
      "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
      "dutyDate" DATE NOT NULL,
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("employeeId", "dutyDate", "shiftTemplateId")
    );

    CREATE INDEX IF NOT EXISTS idx_shift_assignments_date ON shift_assignments ("dutyDate");
    CREATE INDEX IF NOT EXISTS idx_shift_assignments_employee ON shift_assignments ("employeeId");

    -- What KIND of shift this is, so the roster can show Day, Night and
    -- Straight Duty as three distinct things rather than inferring two from
    -- "crossesMidnight". A Straight Duty is a continuous 24-hour tour
    -- (06:00 to 06:00 the next day); it crosses midnight like a night shift
    -- does, so the flag alone cannot tell them apart.
    --
    -- Stated on the template AND snapshotted onto the assignment, exactly as
    -- shiftName/startTime/endTime already are: retiring or re-timing a template
    -- must not reclassify a roster entry already worked.
    ALTER TABLE shift_templates   ADD COLUMN IF NOT EXISTS "shiftKind" TEXT NOT NULL DEFAULT '';
    ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS "shiftKind" TEXT NOT NULL DEFAULT '';

    -- A BROKEN (split) shift is one duty day worked in two non-contiguous
    -- stretches, e.g. 06:00-12:00 and then 00:00-06:00 the next morning. The
    -- second range lives on the SAME row rather than in a second assignment:
    -- one duty day stays one attendance record, which is what billing, absence
    -- monitoring and payroll all read, and it keeps the 8-hour built-in
    -- threshold spanning the whole duty instead of being tested twice against
    -- two short halves that would each earn nothing.
    --
    -- Null on every other kind of shift, which is how a broken shift is
    -- recognised. crossesMidnight2 says the second range lands on the day
    -- after the FIRST range's date, exactly as crossesMidnight does for one.
    ALTER TABLE shift_templates   ADD COLUMN IF NOT EXISTS "startTime2" TEXT;
    ALTER TABLE shift_templates   ADD COLUMN IF NOT EXISTS "endTime2" TEXT;
    ALTER TABLE shift_templates   ADD COLUMN IF NOT EXISTS "crossesMidnight2" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS "startTime2" TEXT;
    ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS "endTime2" TEXT;
    ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS "crossesMidnight2" BOOLEAN NOT NULL DEFAULT false;
    -- So the second range survives the rest-day round trip too.
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevStartTime2" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevEndTime2" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevCrossesMidnight2" BOOLEAN;

    -- Classify the rows that predate the column. Self-guarding: it only touches
    -- rows still holding the empty default, so an admin who reclassifies a
    -- template is never overwritten on the next boot, and no flag is needed.
    --
    -- Times are HH:MM strings. A shift that runs 20 hours or more is a Straight
    -- Duty; anything else crossing midnight is a Night shift; the rest are Day.
    -- The 20-hour threshold rather than exactly 24 tolerates a tour booked as
    -- 06:00-05:00 or similar without miscalling it a night shift.
    UPDATE shift_templates SET "shiftKind" =
      CASE WHEN (
             (split_part("endTime", ':', 1)::int * 60 + split_part("endTime", ':', 2)::int)
             + (CASE WHEN "crossesMidnight" THEN 1440 ELSE 0 END)
             - (split_part("startTime", ':', 1)::int * 60 + split_part("startTime", ':', 2)::int)
           ) >= 1200 THEN 'Straight'
           WHEN "crossesMidnight" OR name ILIKE '%night%' THEN 'Night'
           ELSE 'Day' END
     WHERE "shiftKind" = ''
       AND "startTime" ~ '^[0-9]{1,2}:[0-9]{2}$'
       AND "endTime"   ~ '^[0-9]{1,2}:[0-9]{2}$';

    UPDATE shift_assignments SET "shiftKind" =
      CASE WHEN (
             (split_part("endTime", ':', 1)::int * 60 + split_part("endTime", ':', 2)::int)
             + (CASE WHEN "crossesMidnight" THEN 1440 ELSE 0 END)
             - (split_part("startTime", ':', 1)::int * 60 + split_part("startTime", ':', 2)::int)
           ) >= 1200 THEN 'Straight'
           WHEN "crossesMidnight" OR COALESCE("shiftName", '') ILIKE '%night%' THEN 'Night'
           ELSE 'Day' END
     WHERE "shiftKind" = ''
       AND "startTime" ~ '^[0-9]{1,2}:[0-9]{2}$'
       AND "endTime"   ~ '^[0-9]{1,2}:[0-9]{2}$';

    -- Explicit rest days. A day with no shift is already an implicit rest day,
    -- but marking one here records it intentionally so the roster shows a
    -- "Rest Day" chip and the attendance report can label it "Rest Day" rather
    -- than leaving the cell blank / risking an "Absent" flag.
    CREATE TABLE IF NOT EXISTS rest_days (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "dutyDate" DATE NOT NULL,
      notes TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("employeeId", "dutyDate")
    );

    -- Snapshot of a shift this rest day replaced, so removing the rest day can
    -- restore the exact shift. NULL when the rest day was marked on an empty day.
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevShiftTemplateId" INTEGER;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevShiftName" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevStartTime" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevEndTime" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevCrossesMidnight" BOOLEAN;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevNotes" TEXT;
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevSite" TEXT;
    -- The displaced shift's KIND, so removing the rest day restores what was
    -- actually there. Without it the restore had to re-derive from the times,
    -- which silently reclassifies a template an admin had deliberately marked —
    -- the same defect the range-fill and copy-week paths carried.
    ALTER TABLE rest_days ADD COLUMN IF NOT EXISTS "prevShiftKind" TEXT;

    CREATE INDEX IF NOT EXISTS idx_rest_days_date ON rest_days ("dutyDate");
    CREATE INDEX IF NOT EXISTS idx_rest_days_employee ON rest_days ("employeeId");

    -- Follow-up tracking for absence monitoring. One row per (guard, date, kind)
    -- where kind is 'absence' (missed shift) or 'no_timeout' (timed in, never
    -- out). Keyed by normalized guard name since attendance is name-based.
    -- Status drives the workflow: Pending -> Excused/Actioned, with an optional
    -- free-text remark (reason / action taken).
    CREATE TABLE IF NOT EXISTS absence_followups (
      id SERIAL PRIMARY KEY,
      "guardKey" TEXT NOT NULL,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "dutyDate" DATE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'absence' CHECK (kind IN ('absence','no_timeout')),
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Excused','Actioned')),
      remark TEXT DEFAULT '',
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("guardKey", "dutyDate", kind)
    );

    CREATE INDEX IF NOT EXISTS idx_absence_followups_date ON absence_followups ("dutyDate");
    CREATE INDEX IF NOT EXISTS idx_absence_followups_guard ON absence_followups ("guardKey");

    -- Missing Time Log Requests: a guard explains a missing Time In and/or Time
    -- Out so an admin can correct attendance. Guard submits the explanation only;
    -- the admin sets the actual time(s) on approval, which then creates the
    -- attendance punch record(s). Workflow: Pending -> Approved/Rejected.
    CREATE TABLE IF NOT EXISTS missing_timelog_requests (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "dutyDate" DATE NOT NULL,
      "missingType" TEXT NOT NULL CHECK ("missingType" IN ('IN','OUT','BOTH')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      "approvedInAt" TIMESTAMPTZ,
      "approvedOutAt" TIMESTAMPTZ,
      "reviewedBy" TEXT,
      "reviewedAt" TIMESTAMPTZ,
      "reviewNote" TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_missing_timelog_date ON missing_timelog_requests ("dutyDate");
    CREATE INDEX IF NOT EXISTS idx_missing_timelog_status ON missing_timelog_requests (status);

    -- Marks rows whose approved times are true UTC instants. Approvals used to
    -- be written with ::timestamp, which stamps a naive PH-local string as UTC
    -- and leaves the stored time 8h ahead of what the admin entered. The
    -- backfill below corrects the old rows exactly once; this flag is what
    -- makes it idempotent, since a blanket shift would keep re-applying on
    -- every boot.
    ALTER TABLE missing_timelog_requests ADD COLUMN IF NOT EXISTS "timesNormalized" BOOLEAN NOT NULL DEFAULT false;

    -- Overtime approval. Holds two kinds of rows:
    --  - approvals attached to auto-detected OT (source='detected'), keyed by
    --    guardKey + dutyDate so the report can look them up
    --  - manual/guard-filed OT requests (source='manual'), which carry their own
    --    requested minutes + reason
    -- detectedMinutes is what the report computed at approval time (audit);
    -- approvedMinutes is the admin's final figure (defaults to detected).
    CREATE TABLE IF NOT EXISTS overtime_records (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT,
      "guardKey" TEXT NOT NULL,
      "guardName" TEXT NOT NULL,
      site TEXT,
      "dutyDate" DATE NOT NULL,
      source TEXT NOT NULL DEFAULT 'detected' CHECK (source IN ('detected','manual')),
      "detectedMinutes" INTEGER,
      "requestedMinutes" INTEGER,
      "approvedMinutes" INTEGER,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      "reviewedBy" TEXT,
      "reviewedAt" TIMESTAMPTZ,
      "reviewNote" TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("guardKey", "dutyDate", source)
    );

    CREATE INDEX IF NOT EXISTS idx_overtime_date ON overtime_records ("dutyDate");
    CREATE INDEX IF NOT EXISTS idx_overtime_status ON overtime_records (status);

    -- Leave records: employee requests time off (type + date range), reviewed
    -- via Pending -> Approved/Rejected. Approved leave feeds the attendance
    -- reports so those days show "On Leave" instead of "Absent". Linked to a 201
    -- File employee; ON DELETE SET NULL keeps history if an employee is removed.
    CREATE TABLE IF NOT EXISTS leave_records (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeName" TEXT NOT NULL,
      "employeeNo" TEXT,
      "leaveType" TEXT NOT NULL,
      "fromDate" DATE NOT NULL,
      "toDate" DATE NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      "reviewedBy" TEXT,
      "reviewedAt" TIMESTAMPTZ,
      "reviewNote" TEXT DEFAULT '',
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_leave_records_employee ON leave_records ("employeeId");
    CREATE INDEX IF NOT EXISTS idx_leave_records_dates ON leave_records ("fromDate", "toDate");
    CREATE INDEX IF NOT EXISTS idx_leave_records_status ON leave_records (status);

    -- Per-employee leave credit balances, one row per (employee, bucket).
    -- Vacation bucket covers Vacation/Emergency/Bereavement; Sick covers Sick;
    -- Maternity/Paternity never touches credits. Admin-managed on the Leave page.
    CREATE TABLE IF NOT EXISTS leave_credits (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL CHECK (bucket IN ('Vacation','Sick')),
      balance NUMERIC(6,1) NOT NULL DEFAULT 0,
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("employeeId", bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_leave_credits_employee ON leave_credits ("employeeId");

    -- Outcome of the paid/LWOP split, written at approval time.
    ALTER TABLE leave_records ADD COLUMN IF NOT EXISTS "totalDays"    NUMERIC(6,1);
    ALTER TABLE leave_records ADD COLUMN IF NOT EXISTS "paidDays"     NUMERIC(6,1);
    ALTER TABLE leave_records ADD COLUMN IF NOT EXISTS "lwopDays"     NUMERIC(6,1);
    ALTER TABLE leave_records ADD COLUMN IF NOT EXISTS "creditBucket" TEXT;
    ALTER TABLE leave_records ADD COLUMN IF NOT EXISTS "isLwop"       BOOLEAN NOT NULL DEFAULT false;

    -- Payroll & Benefits ------------------------------------------------------

    -- Per-employee pay rate. An employee is paid either Daily (guards, the
    -- common case) or Monthly (office/admin staff); only the matching field is
    -- used by the payroll engine. Both columns exist on every employee so
    -- switching payType later doesn't lose the other rate.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "payType" TEXT NOT NULL DEFAULT 'Daily';
    ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_paytype_check;
    ALTER TABLE employees ADD CONSTRAINT employees_paytype_check CHECK ("payType" IN ('Daily','Monthly'));
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "dailyRate" NUMERIC(10,2);
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "monthlyRate" NUMERIC(10,2);

    -- Per-employee income-tax exemption. Minimum-wage earners are exempt from
    -- tax on basic pay, holiday pay, overtime, and night differential under
    -- RA 9504, and many security agencies' guards qualify while their office
    -- staff do not — so this is per-person rather than only a global switch.
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS "taxExempt" BOOLEAN NOT NULL DEFAULT false;

    -- Admin-editable statutory contribution tables + payroll computation
    -- knobs, one JSONB row per key. These change periodically (SSS/PhilHealth/
    -- Pag-IBIG/BIR issuances) so they're never hardcoded into the engine —
    -- seeded with reasonable current defaults below, but the UI carries a
    -- "verify against the latest official issuance" notice.
    CREATE TABLE IF NOT EXISTS payroll_statutory_config (
      key TEXT PRIMARY KEY CHECK (key IN ('sss','philhealth','pagibig','withholding_tax','pay_rules')),
      config JSONB NOT NULL,
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per semi-monthly cutoff run.
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id SERIAL PRIMARY KEY,
      "periodStart" DATE NOT NULL,
      "periodEnd" DATE NOT NULL,
      "payDate" DATE,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Computed','Approved','Paid')),
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("periodStart","periodEnd")
    );

    -- One row per employee per period — the computed payslip. Names/position/
    -- site are snapshotted (like overtime_records/leave_records) so history
    -- survives later employee edits.
    CREATE TABLE IF NOT EXISTS payroll_lines (
      id SERIAL PRIMARY KEY,
      "periodId" INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT, "employeeName" TEXT NOT NULL, position TEXT, site TEXT,
      "payType" TEXT, "rateUsed" NUMERIC(10,2),
      "presentDays" NUMERIC(6,2) NOT NULL DEFAULT 0, "absentDays" NUMERIC(6,2) NOT NULL DEFAULT 0,
      "paidLeaveDays" NUMERIC(6,2) NOT NULL DEFAULT 0, "lwopDays" NUMERIC(6,2) NOT NULL DEFAULT 0,
      "lateMinutes" INTEGER NOT NULL DEFAULT 0, "undertimeMinutes" INTEGER NOT NULL DEFAULT 0,
      "builtinOtMinutes" INTEGER NOT NULL DEFAULT 0, "approvedOtMinutes" INTEGER NOT NULL DEFAULT 0,
      "regularPay" NUMERIC(12,2) NOT NULL DEFAULT 0, "otPay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "lateUndertimeDeduction" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "otherEarnings" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "grossPay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "sssEe" NUMERIC(12,2) NOT NULL DEFAULT 0, "sssEr" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "philhealthEe" NUMERIC(12,2) NOT NULL DEFAULT 0, "philhealthEr" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "pagibigEe" NUMERIC(12,2) NOT NULL DEFAULT 0, "pagibigEr" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "withholdingTax" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "otherDeductions" NUMERIC(12,2) NOT NULL DEFAULT 0, "otherDeductionsNote" TEXT DEFAULT '',
      "netPay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "computedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("periodId","employeeId")
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_period ON payroll_lines ("periodId");
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_employee ON payroll_lines ("employeeId");

    -- Admin-managed catalog of earnings/benefits and deductions/loans beyond
    -- base pay, OT, and the four statutory deductions (those stay dedicated
    -- columns above since their math is bracket-driven, not a flat amount).
    -- Seeded inactive — Brookside's admin turns on and prices only what they
    -- actually offer. Managed from Manage Lists, not this module, so it lives
    -- alongside every other admin-editable list.
    CREATE TABLE IF NOT EXISTS payroll_components (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('Earning','Deduction')),
      category TEXT NOT NULL DEFAULT 'Other' CHECK (category IN
        ('Allowance','Incentive','Bonus','Benefit','Loan','Government','Other')),
      taxable BOOLEAN NOT NULL DEFAULT false,
      frequency TEXT NOT NULL DEFAULT 'Per Period' CHECK (frequency IN
        ('Per Period','Monthly (1st cutoff)','One-time','Annual')),
      "defaultAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Info-only non-cash benefit enrollment (HMO, Group Life/Accident
    -- Insurance) — no pay impact, just a record of what coverage an employee has.
    CREATE TABLE IF NOT EXISTS payroll_employee_benefits (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "benefitName" TEXT NOT NULL, provider TEXT DEFAULT '',
      "effectiveDate" DATE, "expiryDate" DATE, notes TEXT DEFAULT '',
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_employee_benefits_employee ON payroll_employee_benefits ("employeeId");

    -- Recurring per-employee assignment of a catalog component: an ongoing
    -- allowance, or a loan being paid down (balanceRemaining decrements each
    -- time it's applied and the row auto-deactivates at 0).
    CREATE TABLE IF NOT EXISTS payroll_employee_components (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "componentId" INTEGER NOT NULL REFERENCES payroll_components(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      "totalOwed" NUMERIC(12,2),
      "balanceRemaining" NUMERIC(12,2),
      active BOOLEAN NOT NULL DEFAULT true,
      note TEXT DEFAULT '',
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("employeeId","componentId")
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_employee_components_employee ON payroll_employee_components ("employeeId");

    -- The actual applied earning/deduction instances per employee per period
    -- (auto-applied recurring ones + one-off manual additions). Snapshots
    -- name/kind/taxable so later catalog edits don't rewrite history. "auto"
    -- marks a row as compute-applied (replaced wholesale on every recompute,
    -- so a manual one-off never gets duplicated); "employeeComponentId" links
    -- an auto row back to the recurring assignment it came from, so mark-paid
    -- knows which loan balance to decrement — exactly once, at Paid time, not
    -- on every recompute.
    CREATE TABLE IF NOT EXISTS payroll_line_components (
      id SERIAL PRIMARY KEY,
      "lineId" INTEGER NOT NULL REFERENCES payroll_lines(id) ON DELETE CASCADE,
      "componentId" INTEGER REFERENCES payroll_components(id) ON DELETE SET NULL,
      "employeeComponentId" INTEGER REFERENCES payroll_employee_components(id) ON DELETE SET NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('Earning','Deduction')),
      taxable BOOLEAN NOT NULL DEFAULT false,
      auto BOOLEAN NOT NULL DEFAULT false,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_line_components_line ON payroll_line_components ("lineId");

    -- Holiday calendar. Modelled on two independent axes: "type" drives the
    -- pay multiplier (Regular vs Special Non-Working), "sites" drives WHO it
    -- applies to. A LOCAL holiday is not a third type — it's an ordinary
    -- Regular/Special holiday whose sites list is populated, e.g. a city
    -- charter day that only pays guards posted in that city. NULL/empty sites
    -- means nationwide.
    CREATE TABLE IF NOT EXISTS payroll_holidays (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('Regular','Special Non-Working')),
      sites TEXT[],
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (date, name)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_holidays_date ON payroll_holidays (date);

    -- Per-day audit breakdown behind each payslip line. Payroll disputes are
    -- day-level ("why was the 25th paid at that rate?"), and once the premium
    -- stack is summed into the line it can't be reconstructed — so each day's
    -- classification, minutes, and pay components are kept.
    CREATE TABLE IF NOT EXISTS payroll_line_days (
      id SERIAL PRIMARY KEY,
      "lineId" INTEGER NOT NULL REFERENCES payroll_lines(id) ON DELETE CASCADE,
      "dutyDate" DATE NOT NULL,
      "dayType" TEXT NOT NULL,
      "holidayName" TEXT,
      "isRestDay" BOOLEAN NOT NULL DEFAULT false,
      worked BOOLEAN NOT NULL DEFAULT false,
      "regularMinutes" INTEGER NOT NULL DEFAULT 0,
      "otMinutes" INTEGER NOT NULL DEFAULT 0,
      "nightMinutes" INTEGER NOT NULL DEFAULT 0,
      "nightOtMinutes" INTEGER NOT NULL DEFAULT 0,
      "basePay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "otPay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "nightDiffPay" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "holidayPremium" NUMERIC(12,2) NOT NULL DEFAULT 0,
      UNIQUE ("lineId","dutyDate")
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_line_days_line ON payroll_line_days ("lineId");

    -- Premium totals rolled up onto the payslip line so the register and PDFs
    -- can itemise them without re-reading payroll_line_days.
    -- OT pay split into its two kinds. Built-in comes from shift length beyond
    -- 8h and needs no approval; excess is worked past shift end and does. They
    -- price at the same multiplier but are reported separately on the salary
    -- computation list. "otPay" remains their sum.
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "builtinOtPay" NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "excessOtPay" NUMERIC(12,2) NOT NULL DEFAULT 0;

    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "nightDiffMinutes" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "nightDiffPay" NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "holidayPremiumPay" NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "holidayUnworkedPay" NUMERIC(12,2) NOT NULL DEFAULT 0;

    -- Deduction arrears. When a cutoff's gross can't cover the full statutory
    -- bill (e.g. a guard who worked one day still owes a whole month of
    -- SSS/PhilHealth/Pag-IBIG), net pay floors at zero and the shortfall is
    -- carried here instead of driving the payslip negative. One running
    -- balance row per employee; the ledger below records how it moved.
    CREATE TABLE IF NOT EXISTS payroll_employee_arrears (
      "employeeId" INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Audit trail of every deferral and recovery, written at mark-paid time so
    -- a balance can always be explained. periodId is SET NULL on delete so the
    -- history survives a period being removed.
    CREATE TABLE IF NOT EXISTS payroll_arrears_ledger (
      id SERIAL PRIMARY KEY,
      "employeeId" INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      "periodId" INTEGER REFERENCES payroll_periods(id) ON DELETE SET NULL,
      "periodLabel" TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('deferred','recovered')),
      amount NUMERIC(12,2) NOT NULL,
      "balanceAfter" NUMERIC(12,2) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_arrears_ledger_employee ON payroll_arrears_ledger ("employeeId");

    -- What this payslip deferred / recovered. Held on the line (not applied to
    -- the running balance) until the period is marked Paid, so recomputing a
    -- Draft period can never double-count — same discipline as loan balances.
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "arrearsOpening" NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "arrearsRecovered" NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS "deductionsDeferred" NUMERIC(12,2) NOT NULL DEFAULT 0;

    -- ---- Payroll disbursement --------------------------------------------
    -- One batch per approved pay period: the instruction to pay each guard's
    -- net pay out to their e-wallet or bank.
    --
    -- Stage 1 ends at Exported (a file the finance person uploads to the
    -- provider). Submitted/Reconciled are Stage 2, when the provider's payout
    -- API is called directly — the statuses are in the CHECK now so Stage 2
    -- needs no migration.
    CREATE TABLE IF NOT EXISTS disbursement_batches (
      id SERIAL PRIMARY KEY,
      "payPeriodId" INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft','Exported','Submitted','Reconciled')),
      "totalNet" NUMERIC(14,2) NOT NULL DEFAULT 0,
      "employeeCount" INTEGER NOT NULL DEFAULT 0,
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "exportedBy" TEXT,
      "exportedAt" TIMESTAMPTZ,
      -- One batch per period: "prepare disbursement" opens the existing batch
      -- rather than quietly creating a second instruction to pay the same
      -- payroll twice. Regenerating means deleting and rebuilding.
      UNIQUE ("payPeriodId")
    );

    -- One row per guard per batch. Payout details are SNAPSHOTTED off the 201
    -- File: the file that was exported must stay explainable even after a
    -- guard changes their wallet number, and Stage 2's provider references
    -- will hang off these rows.
    CREATE TABLE IF NOT EXISTS disbursement_items (
      id SERIAL PRIMARY KEY,
      "batchId" INTEGER NOT NULL REFERENCES disbursement_batches(id) ON DELETE CASCADE,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT NOT NULL DEFAULT '',
      "guardName" TEXT NOT NULL,
      "payoutChannel" TEXT NOT NULL DEFAULT '',
      "payoutAccountNumber" TEXT NOT NULL DEFAULT '',
      "payoutAccountName" TEXT NOT NULL DEFAULT '',
      "payoutBankCode" TEXT NOT NULL DEFAULT '',
      "netAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Processing','Paid','Failed')),
      -- Stage 2. The provider payout id, and why a payout failed.
      "xenditPayoutId" TEXT,
      "failureReason" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("batchId","employeeId")
    );
    CREATE INDEX IF NOT EXISTS idx_disbursement_items_batch ON disbursement_items ("batchId");

    -- Annual 13th-month pay (PD 851): total BASIC salary actually earned in
    -- the calendar year / 12 — computed from "regularPay" summed across that
    -- employee's payroll_lines rows for the year (OT/deductions excluded).
    CREATE TABLE IF NOT EXISTS thirteenth_month_pay (
      id SERIAL PRIMARY KEY,
      year INTEGER NOT NULL,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT, "employeeName" TEXT NOT NULL,
      "totalBasicEarned" NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Approved','Paid')),
      "computedBy" TEXT, "computedAt" TIMESTAMPTZ,
      "approvedBy" TEXT, "approvedAt" TIMESTAMPTZ, "paidAt" TIMESTAMPTZ,
      UNIQUE (year, "employeeId")
    );

    -- ---- Billing & Statement of Account ---------------------------------
    -- Payroll pays guards for what they were ROSTERED to work; billing charges
    -- clients for the man-hours actually WORKED at their post. The two used to
    -- share attendance-reports.computeReport() so they "could never disagree" —
    -- that invariant is deliberately retired. Billing reads punches by site and
    -- does not consult the roster at all, because the client contracts a post
    -- rather than a person. See the Billing detail section of CLAUDE.md.

    -- A billed client. Its address prints on the SOA.
    --
    -- "adminFeePercent" / "withholdingTaxPercent" are OPTIONAL per-client
    -- commercial terms. NULL means "use the agency-wide figure in
    -- billing_config", which is what every client did before these existed and
    -- what every client still does until someone types a value. Nothing else in
    -- billing_config is per-client: the man-hour divisor, the SOA prefix and the
    -- default rate stay global by decision.
    CREATE TABLE IF NOT EXISTS billing_clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL DEFAULT '',
      "contractRate" NUMERIC(12,2),
      "adminFeePercent" NUMERIC(8,6),
      "withholdingTaxPercent" NUMERIC(8,6),
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Billing terms for one detachment. Links a site (as attendance knows it)
    -- to its client and its contract. "detachmentName" exists because the SOA
    -- names a post more fully than the sites list does ("BBGC" on the roster,
    -- "BBGC Farms" on the statement).
    --
    -- "contractedGuards" is the headcount the CONTRACT specifies, and drives
    -- the period rate. It is deliberately not the number of distinct guards
    -- the roster happens to show: two guards alternating one post is still one
    -- billed post. The derived count is computed and shown alongside it so a
    -- mismatch is visible.
    -- "contractRate" / "dutyHours" NULL means inherit (site -> client -> global).
    CREATE TABLE IF NOT EXISTS billing_sites (
      id SERIAL PRIMARY KEY,
      "clientId" INTEGER NOT NULL REFERENCES billing_clients(id) ON DELETE CASCADE,
      site TEXT NOT NULL UNIQUE,
      "detachmentName" TEXT NOT NULL DEFAULT '',
      "contractRate" NUMERIC(12,2),
      "dutyHours" NUMERIC(6,2),
      "contractedGuards" INTEGER,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_sites_client ON billing_sites ("clientId");

    -- One billing run for one client over one date range. Independent of
    -- payroll periods: a client may be billed monthly while guards are paid
    -- semi-monthly.
    CREATE TABLE IF NOT EXISTS billing_periods (
      id SERIAL PRIMARY KEY,
      "clientId" INTEGER NOT NULL REFERENCES billing_clients(id) ON DELETE CASCADE,
      "periodStart" DATE NOT NULL,
      "periodEnd" DATE NOT NULL,
      "soaDate" DATE,
      -- One statement number for the whole run, printed on every detachment
      -- page — the agency's existing template numbers it this way, and the
      -- client's accounts-payable references that number when paying.
      "soaNo" TEXT,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Issued','Paid')),
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("clientId","periodStart","periodEnd")
    );

    -- One statement line per detachment per period. Client/detachment names
    -- and every rate are snapshotted, like payroll_lines, so re-pricing a
    -- contract next year does not rewrite last year's statements.
    --
    -- Each adjustable quantity is stored three ways:
    --   "derived*"   what attendance says  (recompute always refreshes this)
    --   "*Override"  what an admin typed instead, or NULL  (recompute never
    --                touches this, so a deliberate edit can't be silently
    --                reverted by pressing Recompute)
    --   plain column the effective value actually billed = override ?? derived
    -- The plain column exists so PDFs and SUM() read one place; the other two
    -- exist so a statement can always show its evidence beside its figure.
    CREATE TABLE IF NOT EXISTS billing_lines (
      id SERIAL PRIMARY KEY,
      "periodId" INTEGER NOT NULL REFERENCES billing_periods(id) ON DELETE CASCADE,
      "billingSiteId" INTEGER REFERENCES billing_sites(id) ON DELETE SET NULL,
      site TEXT NOT NULL,
      "detachmentName" TEXT NOT NULL DEFAULT '',
      "clientName" TEXT NOT NULL DEFAULT '',
      "clientAddress" TEXT NOT NULL DEFAULT '',
      guards INTEGER NOT NULL DEFAULT 0,
      "derivedGuards" INTEGER NOT NULL DEFAULT 0,
      "guardsOverride" INTEGER,
      "contractRateUsed" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "dutyHoursUsed" NUMERIC(6,2) NOT NULL DEFAULT 12,
      "manHourRate" NUMERIC(12,4) NOT NULL DEFAULT 0,
      "billingPeriodRate" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "derivedLessHours" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "lessHoursOverride" NUMERIC(10,2),
      "lessHours" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "lessAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "derivedAddHours" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "addHoursOverride" NUMERIC(10,2),
      -- Billable excess the biller adds BY HAND — approved OT the client agreed
      -- to pay for, which no punch can evidence as "extra" because the man-hour
      -- model nets a site-day into one figure. It ADDS to the effective figure
      -- rather than replacing it, which is what separates it from
      -- "addHoursOverride": an override says "ignore what was derived", this
      -- says "and also charge this". Both can be set at once.
      "addHoursManual" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "addHours" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "addAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "billingCost" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "adminFee" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "dueForGuard" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "withholdingTax" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "netAmount" NUMERIC(12,2) NOT NULL DEFAULT 0,
      -- What a biller TYPED, printed before the LESS / ADDITIONAL line it
      -- explains. Blank means "use the derived wording below" — the same
      -- manual-wins-over-derived shape every quantity on this row uses.
      "remarksLess" TEXT NOT NULL DEFAULT '',
      "remarksAdd" TEXT NOT NULL DEFAULT '',
      -- The wording the derivation itself produced ("No calendar date: Feb 29-30
      -- 2026", "Jul 31 2026 Augmentation"). Refreshed on every recompute, so it
      -- is kept apart from the typed remark rather than overwriting it: a
      -- recompute must never silently rewrite a human's sentence on a document
      -- that goes to a client.
      "derivedRemarkLess" TEXT NOT NULL DEFAULT '',
      "derivedRemarkAdd" TEXT NOT NULL DEFAULT '',
      -- Duty days held out of the derivation because attendance is incomplete
      -- (timed in, never timed out). Derived only — refreshed on every compute
      -- and never overridable, because it counts unanswered questions rather
      -- than a billable quantity. > 0 blocks Issue.
      "pendingReviewDays" INTEGER NOT NULL DEFAULT 0,
      -- The fee percentages actually applied, snapshotted like every rate on
      -- this row. The SOA prints the withholding rate in words ("Less: 2%
      -- Withholding Tax"), so once a client can carry its own percentage the
      -- document has to read what was charged rather than what config says now.
      "adminFeePercentUsed" NUMERIC(8,6),
      "withholdingTaxPercentUsed" NUMERIC(8,6),
      "soaNo" TEXT,
      "computedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("periodId","site")
    );
    CREATE INDEX IF NOT EXISTS idx_billing_lines_period ON billing_lines ("periodId");

    -- The days behind each derived figure. A client disputing a statement asks
    -- "which day did you deduct, and for whom?" — once the hours are summed
    -- into the line that is unanswerable, so each contributing day is kept.
    -- Same reasoning as payroll_line_days.
    CREATE TABLE IF NOT EXISTS billing_line_days (
      id SERIAL PRIMARY KEY,
      "lineId" INTEGER NOT NULL REFERENCES billing_lines(id) ON DELETE CASCADE,
      "dutyDate" DATE NOT NULL,
      "guardName" TEXT NOT NULL DEFAULT '',
      -- 'pending' is not a billed adjustment: it is a day the derivation
      -- REFUSED to price because its attendance is incomplete. It is recorded
      -- here so the evidence panel can name the day and the guard, which is the
      -- difference between holding a day back and silently dropping it.
      kind TEXT NOT NULL CHECK (kind IN ('less','add','pending')),
      reason TEXT NOT NULL DEFAULT '',
      hours NUMERIC(8,2) NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_billing_line_days_line ON billing_line_days ("lineId");

    -- ---- Asset & Equipment Management -----------------------------------
    -- Tracks every issued asset from issuance to return, security and
    -- non-security alike.
    --
    -- The classification is a three-level hierarchy: Type -> Category ->
    -- Sub-Category (e.g. Security > Peripherals > Search Light, or
    -- Non-Security > Office Equipment > Laptop). All three levels are
    -- admin-maintainable.
    --
    -- These lists deliberately do NOT live in dropdown_options (the shared
    -- catalog behind Manage Lists). They are owned by this module alone:
    -- they are hierarchical rather than flat, and an "Office Equipment"
    -- offered as a choice in, say, the incident classification list would be
    -- meaningless. Maintaining them from the module's own Classification tab
    -- also means renaming a category can never disturb another module.
    CREATE TABLE IF NOT EXISTS asset_types (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS asset_categories (
      id SERIAL PRIMARY KEY,
      "typeId" INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("typeId", name)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_categories_type ON asset_categories ("typeId");

    CREATE TABLE IF NOT EXISTS asset_subcategories (
      id SERIAL PRIMARY KEY,
      "categoryId" INTEGER NOT NULL REFERENCES asset_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("categoryId", name)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_subcategories_category ON asset_subcategories ("categoryId");

    -- The asset register. One row per trackable item.
    --
    -- "trackingMode" is the axis that makes one table serve both a radio and
    -- a stack of uniforms:
    --   Serialized  one physical unit with its own serial/tag. Quantity is
    --               always 1 and "status" says where it is.
    --   Bulk        a pooled stock (uniform shirts in size M, flashlights).
    --               "quantity" is what is owned; what is available is that
    --               less whatever is currently out on issue, so availability
    --               is DERIVED and can never drift from the issuance ledger.
    --
    -- Classification is stored as both the foreign key and the resolved name.
    -- The names are what an acknowledgement receipt printed; renaming a
    -- category next year must not rewrite what a guard signed for.
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      "assetTag" TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      "typeId" INTEGER REFERENCES asset_types(id) ON DELETE SET NULL,
      "categoryId" INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL,
      "subcategoryId" INTEGER REFERENCES asset_subcategories(id) ON DELETE SET NULL,
      "typeName" TEXT NOT NULL DEFAULT '',
      "categoryName" TEXT NOT NULL DEFAULT '',
      "subcategoryName" TEXT NOT NULL DEFAULT '',
      "trackingMode" TEXT NOT NULL DEFAULT 'Serialized'
        CHECK ("trackingMode" IN ('Serialized','Bulk')),
      "serialNumber" TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      "reorderLevel" INTEGER NOT NULL DEFAULT 0,
      condition TEXT NOT NULL DEFAULT 'Good'
        CHECK (condition IN ('New','Good','Fair','Poor','Damaged')),
      status TEXT NOT NULL DEFAULT 'Available'
        CHECK (status IN ('Available','Issued','Under Repair','Lost','Retired')),
      site TEXT NOT NULL DEFAULT '',
      "acquisitionDate" DATE,
      "acquisitionCost" NUMERIC(12,2),
      "warrantyExpiry" DATE,
      "replacementDueDate" DATE,
      "statusNote" TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedBy" TEXT, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
    CREATE INDEX IF NOT EXISTS idx_assets_category ON assets ("categoryId");

    -- The issuance ledger: who holds what, since when, and due back when.
    -- This is also the module's history — every figure the register shows
    -- about what is out on issue is summed from here, never stored twice.
    -- Employee and asset details are snapshotted for the same reason the
    -- payroll and billing lines snapshot theirs.
    CREATE TABLE IF NOT EXISTS asset_issuances (
      id SERIAL PRIMARY KEY,
      "assetId" INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT, "employeeName" TEXT NOT NULL, position TEXT, site TEXT,
      "assetTag" TEXT NOT NULL DEFAULT '', "assetName" TEXT NOT NULL DEFAULT '',
      "serialNumber" TEXT NOT NULL DEFAULT '',
      "typeName" TEXT NOT NULL DEFAULT '',
      "categoryName" TEXT NOT NULL DEFAULT '',
      "subcategoryName" TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      "quantityReturned" INTEGER NOT NULL DEFAULT 0,
      "issuedDate" DATE NOT NULL,
      "expectedReturnDate" DATE,
      "issuedBy" TEXT,
      purpose TEXT NOT NULL DEFAULT '',
      "conditionOnIssue" TEXT NOT NULL DEFAULT 'Good',
      status TEXT NOT NULL DEFAULT 'Issued'
        CHECK (status IN ('Issued','Partially Returned','Returned','Lost','Damaged')),
      "returnedDate" DATE,
      "receivedBy" TEXT,
      "conditionOnReturn" TEXT,
      "returnNotes" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_asset_issuances_asset ON asset_issuances ("assetId");
    CREATE INDEX IF NOT EXISTS idx_asset_issuances_employee ON asset_issuances ("employeeId");
    CREATE INDEX IF NOT EXISTS idx_asset_issuances_status ON asset_issuances (status);

    -- Purchase receipts, warranty cards, signed acknowledgement receipts.
    -- Same shape as every other module's attachments.
    CREATE TABLE IF NOT EXISTS asset_attachments (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_asset_attachments_asset ON asset_attachments (asset_id);

    -- Firearm particulars, printed on a Duty Detail Order. Only meaningful for
    -- assets classified under a firearms category, which is why they live here
    -- as nullable columns rather than forcing every radio to carry them.
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS "caliber" TEXT NOT NULL DEFAULT '';
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS "licenceNo" TEXT NOT NULL DEFAULT '';
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS "licenceExpiry" DATE;

    -- ---- Duty Detail Order (DDO) -----------------------------------------
    -- The document required by RA 10591 and Rule 39 s.154-156 of RA 11917
    -- authorising a named guard to bear a specified firearm at a specified
    -- post. A PNP inspector can demand it at the gate, so it is a legal
    -- instrument, not an internal note.

    -- One order per post per issue.
    --
    -- Everything from "formVersion" down is a SNAPSHOT taken at Issue. An
    -- order already in a guard's possession must keep printing the wording it
    -- was issued under: editing the boilerplate later must never rewrite a
    -- document the PNP already holds. Same discipline as payroll and billing
    -- lines snapshotting their rates.
    CREATE TABLE IF NOT EXISTS ddo_orders (
      id SERIAL PRIMARY KEY,
      "ddoNo" TEXT,
      site TEXT NOT NULL,
      "orderDate" DATE NOT NULL,
      "fromDate" DATE NOT NULL,
      "toDate" DATE NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'Post Security Services Duties',
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Issued','Cancelled')),
      "formVersion" TEXT NOT NULL DEFAULT '',
      "referencesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "instructionsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "assignmentStatement" TEXT NOT NULL DEFAULT '',
      "closingLine" TEXT NOT NULL DEFAULT '',
      "authorityLine" TEXT NOT NULL DEFAULT '',
      "signatoryName" TEXT NOT NULL DEFAULT '',
      "signatoryPosition" TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "issuedBy" TEXT, "issuedAt" TIMESTAMPTZ,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ddo_orders_site ON ddo_orders (site);
    CREATE INDEX IF NOT EXISTS idx_ddo_orders_status ON ddo_orders (status);

    -- The number series runs PER POST, so two posts both legitimately hold
    -- 2026-08-001 and only a repeat within one post is a clash. An earlier
    -- build made "ddoNo" globally unique, which would have refused the second
    -- post's first order of the month — dropped explicitly, since CREATE TABLE
    -- IF NOT EXISTS never revisits an existing table's constraints.
    ALTER TABLE ddo_orders DROP CONSTRAINT IF EXISTS "ddo_orders_ddoNo_key";
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ddo_orders_site_no ON ddo_orders (site, "ddoNo");

    -- The duty table. Guard and firearm are linked AND snapshotted: the link
    -- keeps the order honest while it is a draft, the snapshot keeps an issued
    -- order readable after an employee leaves or a firearm is retired.
    --
    -- Firearm columns are nullable throughout — the source form carries
    -- several unarmed posts, with a name, designation, place and shift but no
    -- calibre or serial.
    CREATE TABLE IF NOT EXISTS ddo_lines (
      id SERIAL PRIMARY KEY,
      "orderId" INTEGER NOT NULL REFERENCES ddo_orders(id) ON DELETE CASCADE,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "employeeNo" TEXT NOT NULL DEFAULT '',
      rank TEXT NOT NULL DEFAULT 'SG',
      "guardName" TEXT NOT NULL,
      designation TEXT NOT NULL DEFAULT 'SECURITY GUARD',
      "placeOfDuty" TEXT NOT NULL DEFAULT '',
      shift TEXT NOT NULL DEFAULT '',
      "assetId" INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      "firearmCaliber" TEXT NOT NULL DEFAULT '',
      "firearmSerial" TEXT NOT NULL DEFAULT '',
      "firearmLicenceExpiry" DATE,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ddo_lines_order ON ddo_lines ("orderId");

    -- Single-row, admin-editable boilerplate. The form is already stamped
    -- "Revised Form No. 2025", so the wording demonstrably changes when a new
    -- DOLE/PNP issuance lands — hardcoding it would mean a deploy each time.
    CREATE TABLE IF NOT EXISTS ddo_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      "formVersion" TEXT NOT NULL DEFAULT '',
      "defaultPurpose" TEXT NOT NULL DEFAULT '',
      "referencesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "instructionsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "assignmentStatement" TEXT NOT NULL DEFAULT '',
      "closingLine" TEXT NOT NULL DEFAULT '',
      "authorityLine" TEXT NOT NULL DEFAULT '',
      "validityDays" INTEGER NOT NULL DEFAULT 30,
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ---- Security Reports: Monthly Disposition Report (MDR) ---------------
    -- The monthly return an agency files with its Regional Civil Security
    -- Unit under RA 11917: which clients it serves in the region, which
    -- guards are posted there under which LESP licence, which firearms are
    -- deployed, who the agency's officers are, and who joined or left.
    --
    -- Operationally the sibling of the DDO -- that document authorises ONE
    -- post, this one reports the whole region -- and built with the same
    -- discipline: everything printed is snapshotted at Finalise, and every
    -- summary is derived rather than stored.

    -- One return per month per region.
    --
    -- "periodMonth" is the SINGLE month field. The intro sentence, the
    -- certification line and the download filename are all rendered from it,
    -- so they cannot disagree -- the source workbook names three different
    -- months in one document (filename February, body July, certification
    -- MAY) and this shape makes that impossible.
    --
    -- The subject line is likewise not a column: it is composed from the
    -- region and this month.
    --
    -- "letterheadJson" and "certificationText" are the SNAPSHOT taken at
    -- Finalise. A return already lodged with RCSU must keep printing what was
    -- lodged; editing System Settings afterwards must never rewrite it. Same
    -- rule as the DDO's issued wording and payroll's snapshotted rates.
    CREATE TABLE IF NOT EXISTS mdr_reports (
      id SERIAL PRIMARY KEY,
      "periodMonth" TEXT NOT NULL,
      "reportDate" DATE,
      region TEXT NOT NULL DEFAULT '',
      addressee TEXT NOT NULL DEFAULT '',
      attention TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Finalised','Submitted')),
      "submittedDate" DATE,
      "preparedByName" TEXT NOT NULL DEFAULT '',
      "preparedByPosition" TEXT NOT NULL DEFAULT '',
      "notedByName" TEXT NOT NULL DEFAULT '',
      "notedByPosition" TEXT NOT NULL DEFAULT '',
      "letterheadJson" JSONB,
      "certificationText" TEXT NOT NULL DEFAULT '',
      -- Finalising over outstanding ADVISORY findings requires a typed reason,
      -- and "overrideIssuesJson" snapshots exactly which findings were waived.
      -- The reason alone would say why something was waived without recording
      -- what -- and a later edit to the data would then leave a reason
      -- attached to findings that no longer exist. Blocking findings are never
      -- overridable; they refuse the finalise outright.
      "overrideReason" TEXT NOT NULL DEFAULT '',
      "overrideIssuesJson" JSONB,
      "finalisedBy" TEXT, "finalisedAt" TIMESTAMPTZ,
      "createdBy" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedBy" TEXT, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- One return per month per region. A correction is an Amend of the same
    -- row (Reopen -> edit -> re-finalise), never a second return for the same
    -- month: RCSU would then hold two documents claiming to be the filing.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mdr_reports_month_region
      ON mdr_reports ("periodMonth", region);

    -- Section 2's client blocks -- the vertically merged Client/Address cell
    -- with its guards beneath. "billingSiteId" links to the detachment when
    -- one is mapped, so the guards can be pulled from the roster; the name and
    -- address are snapshotted regardless, because a client renamed in March
    -- must not rewrite February's return.
    --
    -- "province" is stored here because Sections 1 and 3 group by it and
    -- Sites/Facilities does not record it.
    CREATE TABLE IF NOT EXISTS mdr_clients (
      id SERIAL PRIMARY KEY,
      "reportId" INTEGER NOT NULL REFERENCES mdr_reports(id) ON DELETE CASCADE,
      "billingSiteId" INTEGER REFERENCES billing_sites(id) ON DELETE SET NULL,
      "clientName" TEXT NOT NULL DEFAULT '',
      "clientAddress" TEXT NOT NULL DEFAULT '',
      province TEXT NOT NULL DEFAULT '',
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mdr_clients_report ON mdr_clients ("reportId");

    -- Section 2's rows: one per guard. Of the 66 guards on the reference
    -- return, 2 carry a firearm.
    --
    -- Guard particulars are snapshotted beside the foreign key for the usual
    -- reason -- a name corrected in the 201 File in March must not rewrite
    -- February's filed return -- and because the register is not always
    -- complete: a LESP expiry may never have been recorded and the return
    -- still has to carry the correct date. Note the FK is ON DELETE SET NULL,
    -- never CASCADE: deleting an employee must not delete the evidence that
    -- they were reported as posted.
    --
    -- The NO. columns are NOT stored. The running number across the report and
    -- the number within a client block are both positions, derived from
    -- "sortOrder" on read -- storing them would let them drift the moment a
    -- row is inserted or removed.
    CREATE TABLE IF NOT EXISTS mdr_personnel (
      id SERIAL PRIMARY KEY,
      "reportId" INTEGER NOT NULL REFERENCES mdr_reports(id) ON DELETE CASCADE,
      "clientId" INTEGER NOT NULL REFERENCES mdr_clients(id) ON DELETE CASCADE,
      "employeeId" INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      "guardName" TEXT NOT NULL DEFAULT '',
      rank TEXT NOT NULL DEFAULT 'SG',
      "licenceNo" TEXT NOT NULL DEFAULT '',
      "licenceExpiry" DATE,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mdr_personnel_report ON mdr_personnel ("reportId");
    CREATE INDEX IF NOT EXISTS idx_mdr_personnel_client ON mdr_personnel ("clientId");

    -- The firearms a reported guard is accountable for.
    --
    -- A CHILD table rather than columns on mdr_personnel, because a guard can
    -- be issued more than one -- a pistol and a shotgun on the same post is
    -- ordinary. Carrying them as columns would force a second personnel row
    -- for the same guard, which would then count that guard twice in the
    -- Section 3 recapitulation. The reference return's shape (0 or 1 firearms
    -- per guard) is simply the common case of this one.
    --
    -- Section 2 prints the guard's row with their first firearm on it and any
    -- further firearms on continuation rows beneath the same name, which is
    -- how the source sheet would have had to render it.
    CREATE TABLE IF NOT EXISTS mdr_firearms (
      id SERIAL PRIMARY KEY,
      "reportId" INTEGER NOT NULL REFERENCES mdr_reports(id) ON DELETE CASCADE,
      "personnelId" INTEGER NOT NULL REFERENCES mdr_personnel(id) ON DELETE CASCADE,
      "assetId" INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      make TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      "serialNo" TEXT NOT NULL DEFAULT '',
      "licenceExpiry" DATE,
      "firearmClass" TEXT NOT NULL DEFAULT '' CHECK ("firearmClass" IN ('','Small Arms','Light Weapons')),
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mdr_firearms_report ON mdr_firearms ("reportId");
    CREATE INDEX IF NOT EXISTS idx_mdr_firearms_personnel ON mdr_firearms ("personnelId");

    -- Section 4: the agency's officers and staff. Per report rather than a
    -- single agency-wide list, so a return filed in February keeps naming the
    -- people who held those posts in February. A new report pre-fills from the
    -- previous month, so the usual case is still no typing.
    CREATE TABLE IF NOT EXISTS mdr_officers (
      id SERIAL PRIMARY KEY,
      "reportId" INTEGER NOT NULL REFERENCES mdr_reports(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      designation TEXT NOT NULL DEFAULT '',
      "homeAddress" TEXT NOT NULL DEFAULT '',
      "contactNumbers" TEXT NOT NULL DEFAULT '',
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mdr_officers_report ON mdr_officers ("reportId");

    -- Section 5: A. GAIN and B. LOSSES. One table, because the two halves have
    -- an identical shape -- only their column LABELS differ, and those are a
    -- printing concern, not a storage one. The source sheet gives the GAIN
    -- table the LOSSES headers ("DATE TERMINATED", "CAUSE(S) OF TERMINATION");
    -- a gain prints "Date Hired / Deployed" and "Remarks" instead.
    CREATE TABLE IF NOT EXISTS mdr_movements (
      id SERIAL PRIMARY KEY,
      "reportId" INTEGER NOT NULL REFERENCES mdr_reports(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('Gain','Loss')),
      "guardName" TEXT NOT NULL DEFAULT '',
      "postingPlace" TEXT NOT NULL DEFAULT '',
      "effectiveDate" DATE,
      cause TEXT NOT NULL DEFAULT '',
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mdr_movements_report ON mdr_movements ("reportId");

    -- Sections 1 (firearms per province) and 3 (recapitulation) have NO
    -- tables. Both are counts over mdr_personnel grouped by the client's
    -- province, computed on read by src/lib/mdrHelpers.js. Storing them would
    -- let a return's own summary drift from its own body -- the same reason
    -- asset availability and the asset alerts are derived.

    -- ---- MDR immutability, enforced by the database -----------------------
    -- The write routes already refuse to touch a return that is not Draft.
    -- These triggers are the belt to that pair of braces: a finalised return
    -- is a document lodged with the PNP, and it must not be alterable by a
    -- migration, a psql session, a future route that forgets the check, or a
    -- bug. The rule lives with the data, not only with the code that guards
    -- it.
    --
    -- What stays permitted on a non-Draft return is the WORKFLOW only:
    -- status, submission date, and the finalise/override stamps. Every column
    -- that appears on the printed document is frozen.
    CREATE OR REPLACE FUNCTION mdr_guard_report() RETURNS trigger AS $mdr$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'Draft' THEN
          RAISE EXCEPTION 'MDR %: a % return is a filed record and cannot be deleted', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status <> 'Draft' THEN
        IF (NEW."periodMonth", NEW.region, NEW.addressee, NEW.attention, NEW."reportDate",
            NEW."preparedByName", NEW."preparedByPosition",
            NEW."notedByName", NEW."notedByPosition",
            NEW."letterheadJson", NEW."certificationText")
           IS DISTINCT FROM
           (OLD."periodMonth", OLD.region, OLD.addressee, OLD.attention, OLD."reportDate",
            OLD."preparedByName", OLD."preparedByPosition",
            OLD."notedByName", OLD."notedByPosition",
            OLD."letterheadJson", OLD."certificationText")
        THEN
          RAISE EXCEPTION 'MDR %: the return is % and its contents are frozen. Reopen it first.', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $mdr$ LANGUAGE plpgsql;

    -- Section rows: no insert, update or delete while the parent is not Draft.
    --
    -- A missing parent means the return itself is being deleted and these are
    -- cascading away behind it; the report-level trigger above has already
    -- decided whether that delete was allowed, so it is not re-litigated here.
    CREATE OR REPLACE FUNCTION mdr_guard_child() RETURNS trigger AS $mdr$
    DECLARE rid INTEGER; st TEXT; k TEXT; oldj JSONB; newj JSONB;
    BEGIN
      IF TG_OP = 'DELETE' THEN rid := OLD."reportId"; ELSE rid := NEW."reportId"; END IF;
      SELECT status INTO st FROM mdr_reports WHERE id = rid;

      IF st IS NULL OR st = 'Draft' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;

      -- The parent is filed. One update is still legitimate: the referential
      -- SET NULL that fires when an employee, an asset or a detachment is
      -- deleted from the live records. Without this exemption, deleting an
      -- employee who appears on ANY filed return would fail — the return
      -- would be holding the 201 File hostage.
      --
      -- Nulling the link changes nothing the document prints: every guard and
      -- firearm particular is snapshotted on the row itself. Any other change,
      -- and any INSERT or DELETE, is refused.
      IF TG_OP = 'UPDATE' THEN
        oldj := to_jsonb(OLD); newj := to_jsonb(NEW);
        FOR k IN SELECT jsonb_object_keys(newj) LOOP
          IF newj -> k IS DISTINCT FROM oldj -> k THEN
            IF NOT (k IN ('employeeId','assetId','billingSiteId') AND newj -> k = 'null'::jsonb) THEN
              RAISE EXCEPTION 'MDR %: the return is % and its contents are frozen (% cannot change). Reopen it first.', rid, st, k
                USING ERRCODE = 'check_violation';
            END IF;
          END IF;
        END LOOP;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'MDR %: the return is % and its contents are frozen. Reopen it first.', rid, st
        USING ERRCODE = 'check_violation';
    END;
    $mdr$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_mdr_guard_report ON mdr_reports;
    CREATE TRIGGER trg_mdr_guard_report
      BEFORE UPDATE OR DELETE ON mdr_reports
      FOR EACH ROW EXECUTE FUNCTION mdr_guard_report();

    -- Attached by loop so a sixth section table cannot be added later without
    -- someone noticing this list.
    DO $mdr$
    DECLARE t TEXT;
    BEGIN
      FOREACH t IN ARRAY ARRAY['mdr_clients','mdr_personnel','mdr_firearms','mdr_officers','mdr_movements'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_guard ON %I', t, t);
        EXECUTE format(
          'CREATE TRIGGER trg_%s_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
             FOR EACH ROW EXECUTE FUNCTION mdr_guard_child()', t, t);
      END LOOP;
    END
    $mdr$;

    -- Single-row billing knobs, admin-editable. Same discipline as the
    -- statutory tables: no percentage or divisor is hardcoded in the engine,
    -- because these are commercial terms that change per contract renewal.
    CREATE TABLE IF NOT EXISTS billing_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      "adminFeePercent" NUMERIC(8,6) NOT NULL DEFAULT 0.1224,
      "withholdingTaxPercent" NUMERIC(8,6) NOT NULL DEFAULT 0.02,
      "manHourDivisor" NUMERIC(8,2) NOT NULL DEFAULT 365,
      "periodsPerMonth" NUMERIC(6,2) NOT NULL DEFAULT 2,
      -- How many days of full daily duty the FLAT baseline covers. The baseline
      -- is (contractRate / periodsPerMonth) x guards and does not move with the
      -- calendar, so a period longer than this bills the extra days as an
      -- augmentation and a shorter one credits the missing days back. 15 by the
      -- agency's convention, and admin-editable because it is a commercial term.
      "standardPeriodDays" NUMERIC(6,2) NOT NULL DEFAULT 15,
      "defaultContractRate" NUMERIC(12,2) NOT NULL DEFAULT 33000,
      "defaultDutyHours" NUMERIC(6,2) NOT NULL DEFAULT 12,
      "soaPrefix" TEXT NOT NULL DEFAULT 'SOA',
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A directory of external websites operations actually needs: the PNP-SOSIA
    -- portal, SSS, PhilHealth, BIR, a vendor's support page. Nothing here is
    -- hardcoded — every entry is added and maintained from the module.
    --
    -- "urlCategory" holds the VALUE STRING from the url_category list, not an
    -- id. That is how all twenty-six configurable lists are consumed here: no
    -- record anywhere carries a foreign key into dropdown_options. Integrity
    -- comes from the two rules that table already enforces — a rename carries
    -- its records across, and a value still in use cannot be deleted — which is
    -- why url_category is registered in lib/dropdownUsage.js.
    --
    -- The url is stored canonicalised (scheme and host lowercased, path and query
    -- untouched, see lib/urlSafety.js), so the UNIQUE below catches the same
    -- address typed with a different-cased host without merging two URLs that
    -- genuinely differ.
    CREATE TABLE IF NOT EXISTS useful_links (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      "urlCategory" TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
      "createdBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedBy" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS useful_links_category_idx ON useful_links ("urlCategory");
  `);

  // Seed the billing knobs once, from the figures in the agency's existing
  // Billing Auto Compute template. Defaults only — never overwrites an admin's
  // edits, and the UI carries a "verify against the contract" notice.
  await pool.query(`INSERT INTO billing_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // Seed the one client the template bills, so the module is usable on first
  // load. Detachments are NOT seeded: the template's post names ("BBGC Farms")
  // are not the site names the roster uses ("BBGC"), and guessing the mapping
  // would silently bill the wrong post. Unmapped sites are listed in the UI
  // instead, for an admin to map deliberately.
  await pool.query(
    `INSERT INTO billing_clients (name, address, "contractRate", "createdBy")
     VALUES ('Brookside Group of Companies',
             'Km. 102 Mc. Arthur Hi-way, Brgy. Anupul, Bamban, Tarlac',
             33000, 'system')
     ON CONFLICT (name) DO NOTHING`
  );

  // Seed a starting asset taxonomy so the module is usable on first load.
  //
  // Guarded on the taxonomy being EMPTY, the same way DROPDOWN_SEEDS guards
  // each list below. Without that guard this would re-add, on every single
  // boot, whatever an admin had deliberately deleted — every level here is
  // theirs to maintain from the module's Classification tab.
  //
  // Deliberately NOT written into `dropdown_options`: this taxonomy belongs
  // to the Asset module alone and must not appear in any other module's
  // dropdowns.
  const ASSET_TAXONOMY = {
    "Security": {
      "Uniforms & Apparel": ["Uniform Set", "Cap", "Boots", "Belt", "Raincoat", "Reflective Vest"],
      "Communication": ["Handheld Radio", "Base Radio", "Repeater", "Spare Battery", "Charger"],
      "Peripherals": ["Search Light", "Flashlight", "Whistle", "Handcuffs", "Baton", "Metal Detector"],
      "Surveillance": ["Body Camera", "CCTV Camera", "DVR/NVR", "Memory Card"],
      "Access Control": ["Key", "Padlock", "Access Card", "Logbook", "Barrier/Boom Gate"],
      "Firearms & Accessories": ["Service Firearm", "Holster", "Ammunition Pouch", "Gun Safe"],
      "Safety & Emergency": ["Fire Extinguisher", "First Aid Kit", "Emergency Light", "Traffic Cone"],
    },
    "Non-Security": {
      "Office Equipment": ["Laptop", "Desktop", "Printer", "Monitor", "UPS", "Scanner"],
      "IT Peripherals": ["Router", "Network Switch", "External Drive", "Keyboard & Mouse", "Projector"],
      "Furniture & Fixtures": ["Desk", "Chair", "Filing Cabinet", "Whiteboard", "Locker"],
      "Vehicles": ["Motorcycle", "Service Vehicle", "Bicycle"],
      "Facilities": ["Air Conditioner", "Electric Fan", "Water Dispenser", "Generator"],
    },
  };
  // Seed the Duty Detail Order boilerplate once, from the agency's current
  // "Revised Form No. 2025".
  //
  // Reproduced VERBATIM, including the source form's own spelling ("Agecy",
  // "incdicated", "repective", "principa", "possesion"). This is the wording
  // the agency has been issuing to the PNP; silently correcting it here would
  // change a legal document without anyone deciding to. Every line is
  // editable from the module's Form Text screen if they choose to fix it.
  //
  // Guarded on the row being absent, so an admin's edits survive every redeploy.
  await pool.query(
    `INSERT INTO ddo_config (id, "formVersion", "defaultPurpose", "referencesJson",
       "instructionsJson", "assignmentStatement", "closingLine", "authorityLine", "validityDays")
     VALUES (1, $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, 30)
     ON CONFLICT (id) DO NOTHING`,
    [
      "Revised Form No. 2025",
      "Post Security Services Duties",
      JSON.stringify([
        { letter: "a.", text: "DOLE: Department Order No. 150-16;" },
        { letter: "b.", text: 'Republic Act. No. 10591, as amended, " Comprehensive Firearms and Ammunition Regulation Act and' },
        { letter: "c.", text: 'Rule 39 Section 154-156 of Republic Act No. 11917," Strengthening the Private Security Industry Service Act"' },
      ]),
      JSON.stringify([
        { letter: "a.", text: "Shall be issued by the Private Security Agecy (PSA), Company Guard Force (CGF) and Government Security Force (GSF) Managers and/ or the Security Officers to their posted security personnel while carrying/ bearing firearms;" },
        { letter: "b.", text: "Shall serve as authority to bear issued firearms while the actual performance of guard duties in repective specific guard post/ establishment/compound of the principal/client, and prescribe uniform;" },
        { letter: "c.", text: "Shall serve as authority to bear and transport the firearms outside of the respective guard post and official registered residence of the firearms for routine rotation,repair,new posting recall of the firearms, and escorting large amount of cash or valuables outside its specified post within 24 hours only, if it is beyond 24 hours, a permit to transport is required to be issued by FEO." },
        { letter: "d.", text: "Shall be valid for thirty (30) days,renewable until termination of the security service contract within the principa/client;" },
        { letter: "e.", text: "The issued firearms shall be license and a copy of this DDO shall be in the actual possesion of the posted security personnel. Electronic copy of this DDO may be presented in the lieu of the original during the inspection. Provided that the Original copy is presented by an authorized PNP personnel: and" },
        { letter: "f.", text: 'Remarks: " THIS IS NOT AUTHORITY TO BEAR FIREARMS OUTSIDE THE PREMISES OF THE SPECIFIED POST/ ESTABLISHMENT OF THE PRINCIPAL NOR SHALL THE FIREARM DESCRIBED HERE IN LEAVE THE POST/STATIONS OF THE PRINCIPAL' },
      ]),
      "The following security personnel is/ are hereby assigned to render post security service duties in place/s incdicated and hereby issued Agency/ Company (Fas):",
      "For strict compliance.",
      "BY AUTHORITY OF THE GENERAL MANAGER.",
    ]
  );

  const taxonomyCount = (await pool.query(`SELECT COUNT(*)::int c FROM asset_types`)).rows[0].c;
  if (taxonomyCount === 0) {
    for (const [typeName, categories] of Object.entries(ASSET_TAXONOMY)) {
      const typeId = (await pool.query(
        `INSERT INTO asset_types (name, "createdBy") VALUES ($1,'system') RETURNING id`, [typeName]
      )).rows[0].id;
      for (const [categoryName, subs] of Object.entries(categories)) {
        const categoryId = (await pool.query(
          `INSERT INTO asset_categories ("typeId", name, "createdBy") VALUES ($1,$2,'system') RETURNING id`,
          [typeId, categoryName]
        )).rows[0].id;
        for (const subName of subs) {
          await pool.query(
            `INSERT INTO asset_subcategories ("categoryId", name, "createdBy") VALUES ($1,$2,'system')`,
            [categoryId, subName]
          );
        }
      }
    }
  }

  // Seed the single settings row once, using the current production company
  // name so nothing looks blank on first load. Never overwrites an existing row.
  await pool.query(
    `INSERT INTO app_settings (id, "companyName") VALUES (1, 'Brookside Farms Corporation')
     ON CONFLICT (id) DO NOTHING`
  );

  // Seed the statutory contribution tables + payroll knobs once each. These
  // are STARTING DEFAULTS, not authoritative figures — the admin edits them
  // from the Payroll module's Statutory Tables tab to match the current
  // official SSS/PhilHealth/Pag-IBIG/BIR issuance. Never overwrites an
  // existing row, so an admin's edits survive redeploys.
  const sssBrackets = [];
  {
    let prevMax = 0;
    for (let msc = 5000; msc <= 35000; msc += 1500) {
      const capped = Math.min(msc, 35000);
      sssBrackets.push({
        minMsc: prevMax === 0 ? 0 : prevMax + 1,
        maxMsc: capped,
        msc: capped,
        ee: Math.round(capped * 0.05),
        er: Math.round(capped * 0.10),
        ec: capped >= 15000 ? 30 : 10,
      });
      prevMax = capped;
    }
  }
  // payroll_statutory_config.key enumerates its allowed keys in a CHECK, and
  // CREATE TABLE IF NOT EXISTS won't touch an existing table's constraints —
  // so widen it explicitly for 'premium_rules' (same approach used for
  // ops_records_record_type_check above).
  await pool.query(`ALTER TABLE payroll_statutory_config DROP CONSTRAINT IF EXISTS payroll_statutory_config_key_check`);
  await pool.query(`
    ALTER TABLE payroll_statutory_config ADD CONSTRAINT payroll_statutory_config_key_check
      CHECK (key IN ('sss','philhealth','pagibig','withholding_tax','pay_rules','premium_rules'))
  `);

  const STATUTORY_SEEDS = {
    sss: { brackets: sssBrackets },
    philhealth: { ratePercent: 5, floor: 10000, ceiling: 100000 },
    pagibig: { employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500, employerRate: 0.02, salaryCap: 10000 },
    withholding_tax: {
      frequency: "semi-monthly",
      brackets: [
        { min: 0,      max: 10416,  base: 0,        rate: 0 },
        { min: 10417,  max: 16666,  base: 0,        rate: 0.15 },
        { min: 16667,  max: 33332,  base: 937.50,   rate: 0.20 },
        { min: 33333,  max: 83332,  base: 4270.70,  rate: 0.25 },
        { min: 83333,  max: 333332, base: 16770.70, rate: 0.30 },
        { min: 333333, max: 666666, base: 91770.70, rate: 0.32 },
        { min: 666667, max: null,   base: 200000,   rate: 0.35 },
      ],
    },
    // statutoryCutoff 'second': the whole month's SSS/PhilHealth/Pag-IBIG is
    // withheld on the 16-30/31 cutoff only. Withholding tax is unaffected by
    // this setting — it is always assessed per cutoff, with half the monthly
    // statutory subtracted from each tax base so the two payslips carry an
    // even tax burden even though the cash deduction lands on one of them.
    // withholdingTaxEnabled turns income-tax withholding off company-wide, for
    // agencies that don't withhold from guards at all. Individual employees can
    // also be exempted via employees."taxExempt" (minimum-wage earners under
    // RA 9504) while the rest of the payroll is still taxed.
    pay_rules: { otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30, statutoryCutoff: "second", withholdingTaxEnabled: true },
    // Night-differential and holiday premium rates. Seeded at the DOLE
    // standard multipliers, but editable for the same reason as the statutory
    // tables — the figures are policy, not code. Note the ordinary-day OT
    // multiplier stays in pay_rules.otMultiplier (1.25) so existing behaviour
    // is driven by exactly the same setting it always was.
    premium_rules: {
      nightDiffPercent: 0.10, nightStartHour: 22, nightEndHour: 6,
      regularHolidayWorked: 2.00, regularHolidayOt: 2.60,
      regularHolidayUnworkedPay: 1.00, requirePresenceDayBefore: true,
      specialDayWorked: 1.30, specialDayOt: 1.69, specialDayUnworkedPay: 0.00,
    },
  };
  for (const [key, config] of Object.entries(STATUTORY_SEEDS)) {
    await pool.query(
      `INSERT INTO payroll_statutory_config (key, config) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(config)]
    );
  }

  // The seed above never overwrites an existing row, so installs created
  // before statutory deductions moved to the second cutoff still say 'split'.
  // Migrate that specific old default across; an admin who deliberately chose
  // 'first' keeps it.
  await pool.query(`
    UPDATE payroll_statutory_config
    SET config = jsonb_set(config, '{statutoryCutoff}', '"second"'),
        "updatedAt" = now()
    WHERE key = 'pay_rules' AND config->>'statutoryCutoff' = 'split'
  `);

  // A shift whose end time is at or before its start time can only run past
  // midnight. crossesMidnight used to depend solely on an admin ticking a box,
  // and an untidied box yields a NEGATIVE-length shift: built-in OT computes to
  // zero, the entire shift is treated as excess overtime, and the punch-matching
  // window inverts so every day reads Absent. Correct the stored rows to match
  // their own times. Only ever sets the flag ON, and only where the times prove
  // it, so a legitimate same-time 24h shift is left alone.
  await pool.query(`
    UPDATE shift_templates SET "crossesMidnight" = true
    WHERE "crossesMidnight" = false AND "startTime" IS NOT NULL AND "endTime" IS NOT NULL
      AND "endTime" < "startTime"
  `);
  await pool.query(`
    UPDATE shift_assignments SET "crossesMidnight" = true
    WHERE "crossesMidnight" = false AND "startTime" IS NOT NULL AND "endTime" IS NOT NULL
      AND "endTime" < "startTime"
  `);

  // Repair approved time-log corrections stored 8h ahead (see the
  // "timesNormalized" comment above). Only touches rows that actually carry a
  // time, and flags every row so it can never be shifted twice.
  await pool.query(`
    UPDATE missing_timelog_requests
    SET "approvedInAt"  = "approvedInAt"  - INTERVAL '8 hours',
        "approvedOutAt" = "approvedOutAt" - INTERVAL '8 hours',
        "timesNormalized" = true
    WHERE "timesNormalized" = false
      AND ("approvedInAt" IS NOT NULL OR "approvedOutAt" IS NOT NULL)
  `);
  await pool.query(`
    UPDATE missing_timelog_requests SET "timesNormalized" = true WHERE "timesNormalized" = false
  `);

  // Backfill the tax toggle on installs seeded before it existed, defaulting
  // to enabled so behaviour is unchanged until an admin turns it off.
  await pool.query(`
    UPDATE payroll_statutory_config
    SET config = jsonb_set(config, '{withholdingTaxEnabled}', 'true'),
        "updatedAt" = now()
    WHERE key = 'pay_rules' AND config->'withholdingTaxEnabled' IS NULL
  `);

  // Seed the pay-components catalog once, all INACTIVE — Brookside's admin
  // activates and prices only what they actually offer (managed from Manage
  // Lists > Pay Components).
  const PAYROLL_COMPONENT_SEEDS = [
    ["Rice Allowance", "Earning", "Allowance"], ["Uniform Allowance", "Earning", "Allowance"],
    ["Laundry Allowance", "Earning", "Allowance"], ["Transportation Allowance", "Earning", "Allowance"],
    ["Meal Allowance", "Earning", "Allowance"], ["Load/Communication Allowance", "Earning", "Allowance"],
    ["Attendance Incentive", "Earning", "Incentive"], ["Perfect Attendance Bonus", "Earning", "Incentive"],
    ["Performance Bonus", "Earning", "Incentive"],
    ["Christmas Bonus", "Earning", "Bonus"], ["Loyalty Award", "Earning", "Bonus"], ["Birthday Cash Gift", "Earning", "Bonus"],
    ["Hazard Pay", "Earning", "Benefit"], ["Educational Assistance", "Earning", "Benefit"],
    ["Funeral Assistance", "Earning", "Benefit"], ["Medical Assistance", "Earning", "Benefit"],
    ["SSS Salary Loan", "Deduction", "Loan"], ["SSS Calamity Loan", "Deduction", "Loan"],
    ["Pag-IBIG Multi-Purpose Loan", "Deduction", "Loan"], ["Company/Cash Advance", "Deduction", "Loan"],
    ["Uniform/Equipment Deduction", "Deduction", "Other"], ["Damage/Shortage Deduction", "Deduction", "Other"],
    ["Union Dues", "Deduction", "Other"],
  ];
  for (const [name, kind, category] of PAYROLL_COMPONENT_SEEDS) {
    await pool.query(
      `INSERT INTO payroll_components (name, kind, category, active) VALUES ($1,$2,$3,false) ON CONFLICT (name) DO NOTHING`,
      [name, kind, category]
    );
  }

  // Seed ONLY the fixed-date national holidays, whose dates are set by law
  // (RA 9492 as amended), for the current and next year. Movable feasts
  // (Maundy Thursday, Good Friday, Eid'l Fitr, Eid'l Adha) and every LOCAL
  // holiday are proclaimed annually and must be entered by hand — the
  // Holidays tab says so rather than implying this calendar is complete.
  const FIXED_HOLIDAYS = [
    ["01-01", "New Year's Day", "Regular"],
    ["04-09", "Araw ng Kagitingan", "Regular"],
    ["05-01", "Labor Day", "Regular"],
    ["06-12", "Independence Day", "Regular"],
    ["08-21", "Ninoy Aquino Day", "Special Non-Working"],
    ["11-01", "All Saints' Day", "Special Non-Working"],
    ["11-30", "Bonifacio Day", "Regular"],
    ["12-08", "Feast of the Immaculate Conception", "Special Non-Working"],
    ["12-25", "Christmas Day", "Regular"],
    ["12-30", "Rizal Day", "Regular"],
    ["12-31", "Last Day of the Year", "Special Non-Working"],
  ];
  {
    const thisYear = new Date().getFullYear();
    for (const year of [thisYear, thisYear + 1]) {
      for (const [monthDay, name, type] of FIXED_HOLIDAYS) {
        await pool.query(
          `INSERT INTO payroll_holidays (date, name, type, sites, active)
           VALUES ($1::date, $2, $3, NULL, true) ON CONFLICT (date, name) DO NOTHING`,
          [`${year}-${monthDay}`, name, type]
        );
      }
    }
  }

  const DROPDOWN_SEEDS = {
    // Operational records on the Security Operations Dashboard. These three were
    // hardcoded option arrays in the frontend; they are lists now so the agency
    // can change them from Manage Lists without a deploy.
    deployment_status:          ["On Duty","Off Duty","On Leave","Reassigned"],
    site_condition:             ["Normal","Alert","Breach","Under Maintenance"],
    site_manning_status:        ["Complete","Incomplete","No Guards"],
    video_patrol_status:        ["Complete","Incomplete"],
    post_type:                  ["Farm","Gate","Egg Store"],
    vacancy_tracking_status:    ["Open","Filled","Escalated"],
    shift_assignments_status:   ["Scheduled","Completed","No-show","Cancelled"],
    shift_assignments_shift:    ["Day Shift","Night Shift"],
    leave_records_type:         ["Vacation Leave","Sick Leave","Emergency Leave","Maternity/Paternity Leave","Bereavement Leave"],
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
    corrective_action_status: ["Pending","In Progress","Completed"],
    position_title: ["Security Guard","Shift Supervisor","Security Officer","CCTV Operator","Detachment Commander"],
    background_check_status: ["Pending","Cleared","Flagged"],
    license_verification_status: ["Pending","Verified","Rejected"],
    medical_exam_status: ["Pending","Passed","Failed"],
    employment_status: ["Active","Separated"],
    // The category a guard's License to Exercise Security Profession is issued
    // under. Admin-maintainable from Manage Lists rather than hardcoded,
    // because PNP-SOSIA revises the categories and a new one must not need a
    // deploy. Reported beside the LESP number on the Monthly Disposition
    // Report (see Known Gap 14).
    lesp_category: ["Security Guard","Government Guard","Security Officer","Private Detective",
      "Security Consultant","Protection Agent","Aviation Guard","Bank & Armor Guard",
      "Mall & Commercial Guard","K9 Administrator","K9 Evaluator","K9 Trainer","K9 Handler",
      "Other / Specialized Classification"],
    // What kind of site a Useful Link points at. Seeded like every other list —
    // only when the key is empty — so values an admin removes stay removed.
    url_category: ["Government","Security / Regulatory","HR / Labor","Finance",
      "IT / Technology","Operations","Other"],
    employee_document_type: ["NBI Clearance","Police Clearance","Medical Certificate","Security License","Employment Contract","SSS ID","PhilHealth ID","Pag-IBIG ID","TIN ID","Barangay Clearance","Drug Test Result","Training Certificate","Other"],
    civil_status: ["Single","Married","Widowed","Separated"],
    employee_status: ["Active","Separated","Suspended","On Leave"],
    // DEAD LIST — seeded, but read by nothing. It is not in VALID_LISTS in
    // routes/meta.js, not a tab in manageListsShared.js, and no page fetches
    // it. The education levels the 201 File actually uses are the ORDERED ones
    // in src/lib/educationRank.js, whose order IS the attainment rank.
    //
    // Left in place rather than deleted so an existing database is not
    // silently altered, but do not wire this up: these six values are a
    // different, coarser set and ranking against them would disagree with the
    // Education tab.
    education_level: ["Elementary","High School","Senior High School","Vocational","College","Post-Graduate"]
  };
  for (const [listKey, values] of Object.entries(DROPDOWN_SEEDS)) {
    const existingCount = (await pool.query("SELECT COUNT(*)::int c FROM dropdown_options WHERE list_key = $1", [listKey])).rows[0].c;
    if (existingCount === 0) {
      for (const v of values) {
        await pool.query("INSERT INTO dropdown_options (list_key, value) VALUES ($1,$2) ON CONFLICT DO NOTHING", [listKey, v]);
      }
    }
  }

  // Which list values mean "nothing needs doing".
  //
  // This used to be hardcoded in the FRONTEND (`goodStatuses` in
  // dashboardShared.js) while the values themselves are admin-editable here. An
  // administrator renaming or re-casing "Complete" silently reclassified every
  // record as an exception, turning the whole dashboard red with no error
  // anywhere. Moving the classification onto the row it describes removes that
  // possibility: there is no second list to disagree with.
  //
  // NULL means "this list has no compliance meaning" — the honest state for the
  // twenty-one lists that classify nothing, and the reason this is nullable
  // rather than `NOT NULL DEFAULT false`.
  await pool.query(`ALTER TABLE dropdown_options ADD COLUMN IF NOT EXISTS "isCompliant" boolean`);

  // Seeded from the values the frontend hardcoded, so behaviour on the first
  // boot after this deploy is identical to the last boot before it.
  //
  // Guarded twice: the flag makes it run once, and `IS NULL` means it can never
  // overwrite a choice an administrator has since made. Both matter — without
  // the second, re-running would silently revert their edits.
  const COMPLIANT_SEEDS = {
    deployment_status:   "On Duty",
    site_condition:      "Normal",
    site_manning_status: "Complete",
    video_patrol_status: "Complete",
  };
  const compliantDone = (await pool.query(
    "SELECT 1 FROM migration_flags WHERE key = 'seed-dropdown-compliance'")).rowCount > 0;
  if (!compliantDone) {
    for (const [listKey, good] of Object.entries(COMPLIANT_SEEDS)) {
      await pool.query(
        `UPDATE dropdown_options SET "isCompliant" = (value = $2)
          WHERE list_key = $1 AND "isCompliant" IS NULL`, [listKey, good]);
    }
    await pool.query("INSERT INTO migration_flags (key) VALUES ('seed-dropdown-compliance') ON CONFLICT (key) DO NOTHING");
  }

  // Who last edited an operational record. It recorded who CREATED one and when
  // it was updated, but never by whom — so when a status turned out to have been
  // overwritten, the row could say that it happened and not who did it.
  await pool.query(`ALTER TABLE ops_records ADD COLUMN IF NOT EXISTS "updatedBy" TEXT`);

  // How the public incident form identified its reporter.
  //
  // `reportedBy` still holds the display name and is untouched, so every
  // existing incident stays exactly as readable as before. These two only add
  // WHERE that name came from: an employee number checked against the 201 File,
  // or an external reporter who typed it.
  //
  // Deliberately left NULL on existing rows rather than backfilled to
  // 'external': those reports predate the choice, and marking them external
  // would assert something about them that nobody checked.
  await pool.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS "reporterType" TEXT`);
  await pool.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS "reporterEmployeeNo" TEXT`);

  // --- Manually chosen duty site on the two public forms -------------------
  //
  // Both tables already carried `site`, but it was COPIED from employees.site
  // at submission, so it always agreed with the roster. It is now picked by the
  // submitter, because a guard on relief duty works a site that is not their
  // assigned one and that choice drives billing.
  //
  // Which makes a disagreement dangerous rather than merely untidy. Punches are
  // matched to roster rows by guardName|site (attendance-reports.js), so a punch
  // at a site the guard is not rostered at matches nothing: the rostered post
  // reads Absent and bills the client a LESS, while the punch reads as an
  // unrostered duty day and bills the OTHER client an ADD. One wrong selection
  // moves money at two clients in opposite directions.
  //
  // So the disagreement is recorded on the row and the record is held OUT of
  // billing until someone resolves it — see siteMismatch.js and the
  // "Pending site review" status in computeReport().
  //
  // Nullable with no backfill: every existing row predates the choice and was
  // copied from the employee record, so it cannot be in disagreement. NULL
  // means "never evaluated", which is the honest state for those rows and is
  // distinct from false ("evaluated, and it agreed").
  for (const t of ["attendance_records", "missing_timelog_requests"]) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "siteMismatch" BOOLEAN`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "rosteredSite" TEXT`);
    // Who reconciled it and when. Set when an admin confirms the roster and the
    // submission now agree; clearing siteMismatch is what returns the record to
    // billing, and these two say who took that decision.
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "siteResolvedBy" TEXT`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "siteResolvedAt" TIMESTAMPTZ`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_site_mismatch
    ON attendance_records ("siteMismatch") WHERE "siteMismatch" = true`);

  // --- Missing Time Log: selfie + supporting files -------------------------
  //
  // Same shape as attendance_records' selfie columns, so one capture routine
  // serves both forms. Optional here, unlike the attendance punch: this form
  // reports a PAST day, often from home days later, so a photo taken now proves
  // who is filing rather than that they were on post. Blocking submission on a
  // camera would lock out the guard whose phone failure is the thing being
  // reported.
  await pool.query(`ALTER TABLE missing_timelog_requests ADD COLUMN IF NOT EXISTS "selfieData" BYTEA`);
  await pool.query(`ALTER TABLE missing_timelog_requests ADD COLUMN IF NOT EXISTS "selfieMimetype" TEXT`);
  await pool.query(`ALTER TABLE missing_timelog_requests ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE missing_timelog_requests ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`);

  // A logsheet photo, a screenshot of the error and a supervisor's note are
  // three legitimate artefacts for one request, so this is a child table rather
  // than one column — the shape dsr_attachments and training_attachments use.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS missing_timelog_attachments (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES missing_timelog_requests(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mtl_attachments_request
    ON missing_timelog_attachments (request_id)`);

  // Which Missing Time Log request produced this punch, when one did.
  //
  // A correction inserts a punch that nobody photographed and nobody stood
  // anywhere for — an administrator typed a time — so its selfie and coordinate
  // columns are legitimately empty. Once the request itself began carrying a
  // selfie, a location and attachments, that empty punch started reading as a
  // broken image beside evidence that plainly exists one table over.
  //
  // The evidence is LINKED, not copied. Copying would duplicate a blob, could
  // drift when a correction is re-approved with different times, and would
  // misrepresent the row: a selfie taken at home the next day is not proof of
  // presence at 06:00 the day before, and putting it in the punch's Selfie
  // column would assert exactly that.
  //
  // Nullable with NO backfill. Rows corrected before this existed cannot be
  // matched back reliably — a guard may file several requests for one date —
  // and a link pointing at the wrong request is worse than none.
  // ON DELETE SET NULL so deleting a request never blocks on its punches; the
  // punch remains a true record of the corrected time either way.
  await pool.query(`ALTER TABLE attendance_records
    ADD COLUMN IF NOT EXISTS "correctionRequestId" INTEGER
    REFERENCES missing_timelog_requests(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_correction_request
    ON attendance_records ("correctionRequestId") WHERE "correctionRequestId" IS NOT NULL`);

  // Which employee a disciplinary case is against.
  //
  // The name has always been free text, typed by whoever opened the case, so
  // nothing tied it to the 201 File and a misspelling made a case unfindable
  // against its own employee. New cases pick from the register and store both:
  // the id for the link, the NAME as a snapshot, because a case is evidence and
  // must keep printing the name it was raised under even if the employee record
  // is later corrected or the employee leaves.
  //
  // Nullable, no backfill. Production holds no disciplinary cases at all
  // (measured: 0 total, 0 unmatched), so there is nothing to reconcile today --
  // but the column stays nullable because a case may legitimately name someone
  // who is not on the register, and because the local-dev fixture already
  // showed a typed name matching no employee. ON DELETE SET NULL: deleting an
  // employee must not delete the disciplinary history raised against them.
  await pool.query(`ALTER TABLE disciplinary_cases
    ADD COLUMN IF NOT EXISTS "employeeId" INTEGER
    REFERENCES employees(id) ON DELETE SET NULL`);

  // --- Billing: incomplete attendance held out of the derivation -----------
  //
  // A duty day with a time IN and no time OUT was billed as fully served. It is
  // not "Absent" (the guard was there), not "Undertime" (undertime is measured
  // against a time-out that never arrived) and not "On Leave", so
  // deriveFromAttendance matched none of its branches and the day passed
  // through with no adjustment at all — the client paid for a shift nobody can
  // evidence the end of.
  //
  // Held out instead, the same way a site disagreement is: the day contributes
  // neither a LESS nor an ADD until somebody resolves it, and it is COUNTED
  // rather than dropped. The resolution path already exists and needed nothing
  // new — Absence Monitoring's "No time-out" section lists exactly these days,
  // and approving a Missing Time Log request supplies the OUT, after which
  // computeReport stops flagging the day and the next recompute bills it
  // normally.
  await pool.query(`ALTER TABLE billing_lines
    ADD COLUMN IF NOT EXISTS "pendingReviewDays" INTEGER NOT NULL DEFAULT 0`);

  // --- Billing: manual ADD man-hours ---------------------------------------
  //
  // The site-level man-hour model nets each site-day into ONE figure, so there
  // is no longer a derived "excess OT" line for a biller to lean on. Genuine
  // billable overtime the client agreed to still has to reach the statement, so
  // it is entered by hand and ADDED to the derived figure:
  //
  //   addHours = (addHoursOverride ?? derivedAddHours) + addHoursManual
  //
  // Additive with a 0 default, so every existing line is unchanged.
  await pool.query(`ALTER TABLE billing_lines
    ADD COLUMN IF NOT EXISTS "addHoursManual" NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // --- Billing: the baseline covers a FIXED number of days -----------------
  //
  // The flat baseline — (contractRate / periodsPerMonth) x guards — covers a
  // standard 15-day half-month of full daily duty. It does NOT scale with the
  // calendar, but the man-hour requirement previously did: it was summed over
  // the period's ACTUAL days, so a fully-served 16-day period (Aug 16-31) and a
  // fully-served 13-day one (Feb 16-28) both netted to zero and billed the same
  // flat figure. The 31st was given away and February was over-charged.
  //
  // The requirement is now anchored to standardPeriodDays, and the difference
  // between that and the period's real length is booked explicitly: extra days
  // as an augmentation ADD, missing days as a LESS. Both at the same
  // contractRate/365 man-hour rate as every other adjustment.
  await pool.query(`ALTER TABLE billing_config
    ADD COLUMN IF NOT EXISTS "standardPeriodDays" NUMERIC(6,2) NOT NULL DEFAULT 15`);

  // The derivation's own wording for the LESS / ADDITIONAL lines, kept apart
  // from the typed remark so a recompute cannot rewrite a human's sentence.
  await pool.query(`ALTER TABLE billing_lines
    ADD COLUMN IF NOT EXISTS "derivedRemarkLess" TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE billing_lines
    ADD COLUMN IF NOT EXISTS "derivedRemarkAdd" TEXT NOT NULL DEFAULT ''`);

  // Module 11 added new record types after ops_records already existed in production —
  // CREATE TABLE IF NOT EXISTS won't touch an existing table's constraints, so update it explicitly.
  await pool.query(`ALTER TABLE ops_records DROP CONSTRAINT IF EXISTS ops_records_record_type_check`);
  await pool.query(`
    ALTER TABLE ops_records ADD CONSTRAINT ops_records_record_type_check CHECK (record_type IN (
      'guard_deployment','site_manning','patrol_video','site_status','duty_roster','gps_monitoring','visitor_count','vehicle_count','daily_metrics',
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
