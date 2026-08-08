// Helpers for the Employee Master File (201 File) / HR module.
// Mirrors lib/incidentHelpers.js: a full-record aggregator that attaches all
// child lists, plus a thin audit-log writer that reuses the shared audit_log
// table (incident_id column is nullable text, so we store the employee id there
// the same way — it's a generic "record id" in practice).

const { pool } = require("../db");
const { highestEducation } = require("./educationRank");

// Assemble an employee with all sub-lists (documents metadata, education,
// employment history). Document BYTEA data is deliberately NOT selected here —
// only metadata — so listing employees never pulls file blobs into memory. The
// actual bytes are streamed on demand by the download endpoint.
async function fullEmployee(id) {
  // "lespExpiry" is rendered explicitly because it is a real DATE column,
  // unlike "dateHired"/"birthDate" which are TEXT. node-postgres turns a DATE
  // into a JS Date at UTC midnight, which JSON-serialises to the PREVIOUS day
  // for anyone in PH (UTC+8) — a licence expiring 11 June would be shown, and
  // filed to RCSU, as 10 June. to_char keeps it the plain YYYY-MM-DD every
  // consumer already expects. Same class of bug as the timestamptz rule in
  // CLAUDE.md, one type down.
  const emp = (await pool.query(
    `SELECT *,
            to_char("lespExpiry",'YYYY-MM-DD')            AS "lespExpiry",
            to_char("policeClearanceExpiry",'YYYY-MM-DD') AS "policeClearanceExpiry",
            to_char("lastMedicalExam",'YYYY-MM-DD')       AS "lastMedicalExam",
            to_char("lastNeuroExam",'YYYY-MM-DD')         AS "lastNeuroExam",
            to_char("lastDrugTestExam",'YYYY-MM-DD')      AS "lastDrugTestExam"
     FROM employees WHERE id = $1`, [id])).rows[0];
  if (!emp) return null;

  const [documents, education, employment] = await Promise.all([
    pool.query(
      `SELECT id, "docType", filename, mimetype, size, "issueDate", "expiryDate", notes, uploaded_by, uploaded_at
       FROM employee_documents WHERE employee_id = $1 ORDER BY uploaded_at DESC`,
      [id]
    ),
    pool.query(
      `SELECT id, "level", "schoolName", "courseOrStrand", "yearGraduated", notes
       FROM employee_education WHERE employee_id = $1 ORDER BY id`,
      [id]
    ),
    pool.query(
      `SELECT id, "companyName", position, "employmentType", "yearsEmployed", "dateResigned", notes
       FROM employee_employment_history WHERE employee_id = $1 ORDER BY id`,
      [id]
    ),
  ]);

  return {
    ...emp,
    documents: documents.rows,
    education: education.rows,
    employment: employment.rows,
    // DERIVED, never stored: the highest level among the education entries
    // above. Computed here rather than on the screen so the API, the 201 File
    // and any report that reads an employee all get the same answer — and so a
    // future export carries it without knowing the ranking rules. Null when
    // there is nothing to report.
    highestEducation: highestEducation(education.rows),
  };
}

// Audit-log writer. Same signature/shape as incidentHelpers.log so the module
// stays consistent. The record id is stored in the audit_log.incident_id column
// (nullable text) — reused here as a generic record reference. The action
// labels map to the cross-module entries already present in incidentShared.js's
// AUDIT_LABELS (e.g. "created", "updated", "attachment_added", ...), so the
// system-wide Live Feed renders them with friendly text automatically.
async function log(recordId, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [recordId != null ? String(recordId) : null, username, action, detail != null ? String(detail) : null]
  );
}

module.exports = { fullEmployee, log };
