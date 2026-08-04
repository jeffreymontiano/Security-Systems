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
  `);

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
    employee_document_type: ["NBI Clearance","Police Clearance","Medical Certificate","Security License","Employment Contract","SSS ID","PhilHealth ID","Pag-IBIG ID","TIN ID","Barangay Clearance","Drug Test Result","Training Certificate","Other"],
    civil_status: ["Single","Married","Widowed","Separated"],
    employee_status: ["Active","Separated","Suspended","On Leave"],
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
