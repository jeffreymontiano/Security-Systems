// Helpers for the Employee Master File (201 File) / HR module.
// Mirrors lib/incidentHelpers.js: a full-record aggregator that attaches all
// child lists, plus a thin audit-log writer that reuses the shared audit_log
// table (incident_id column is nullable text, so we store the employee id there
// the same way — it's a generic "record id" in practice).

const { pool } = require("../db");

// Assemble an employee with all sub-lists (documents metadata, education,
// employment history). Document BYTEA data is deliberately NOT selected here —
// only metadata — so listing employees never pulls file blobs into memory. The
// actual bytes are streamed on demand by the download endpoint.
async function fullEmployee(id) {
  const emp = (await pool.query("SELECT * FROM employees WHERE id = $1", [id])).rows[0];
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
      `SELECT id, "companyName", position, "yearsEmployed", "dateResigned", notes
       FROM employee_employment_history WHERE employee_id = $1 ORDER BY id`,
      [id]
    ),
  ]);

  return {
    ...emp,
    documents: documents.rows,
    education: education.rows,
    employment: employment.rows,
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
