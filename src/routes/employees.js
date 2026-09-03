const express = require("express");
const multer = require("multer");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { fullEmployee, log } = require("../lib/employeeHelpers");
const { validatePayout } = require("../lib/payoutDetails");

const router = express.Router();

// Same upload configuration as the incidents module: in-memory, 8MB cap,
// images + PDF + Word + text only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument|^text\/plain$/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: images, PDF, Word docs, text files."));
  }
});

// Must match the CHECK constraint in db.js AND the identical constant in
// frontend/src/pages/employeeShared.js. A suspension is a dated disciplinary
// penalty and leave lives in leave_records -- a guard under either stays
// Active, so neither is a status.
const EMPLOYMENT_STATUSES = ["Active", "Resigned", "Terminated"];

// ---- List / read -----------------------------------------------------------

// List all employees with child records - any authenticated user (Viewer too).
router.get("/", requireAuth, async (req, res) => {
  const rows = (await pool.query(`SELECT * FROM employees ORDER BY "fullName" ASC`)).rows;
  const withSub = await Promise.all(rows.map(e => fullEmployee(e.id)));
  res.json(withSub);
});

// Stats endpoint - registered before "/:id" so "_all" isn't read as an id.
router.get("/_all/stats", requireAuth, async (req, res) => {
  const [byStatus, bySite, totals] = await Promise.all([
    pool.query(`SELECT "employmentStatus" status, COUNT(*)::int c FROM employees GROUP BY "employmentStatus"`),
    pool.query("SELECT site, COUNT(*)::int c FROM employees GROUP BY site ORDER BY c DESC"),
    pool.query(`
      SELECT
        COUNT(*)::int total,
        COUNT(*) FILTER (WHERE "employmentStatus" = 'Active')::int active,
        -- "separated" is the KPI's own word for "no longer employed", which is
        -- now BOTH end states. Left as one figure so the tile it feeds is
        -- unchanged; matching only the retired 'Separated' would have made it
        -- read 0 for ever with nothing on screen saying why.
        COUNT(*) FILTER (WHERE "employmentStatus" IN ('Resigned','Terminated'))::int separated
      FROM employees
    `)
  ]);
  res.json({ totals: totals.rows[0], byStatus: byStatus.rows, bySite: bySite.rows });
});

router.get("/:id", requireAuth, async (req, res) => {
  const emp = await fullEmployee(req.params.id);
  if (!emp) return res.status(404).json({ error: "Employee not found." });
  res.json(emp);
});

// ---- Create / update / delete ----------------------------------------------

const CORE_FIELDS = {
  employeeNo: '"employeeNo"', fullName: '"fullName"', position: "position", site: "site",
  dateHired: '"dateHired"', employmentStatus: '"employmentStatus"', birthDate: '"birthDate"',
  gender: "gender", civilStatus: '"civilStatus"', address: "address", contactNumber: '"contactNumber"',
  email: "email", sssNo: '"sssNo"', philhealthNo: '"philhealthNo"', pagibigNo: '"pagibigNo"',
  tinNo: '"tinNo"', lespNo: '"lespNo"', lespCategory: '"lespCategory"', lespExpiry: '"lespExpiry"',
  emergencyContactName: '"emergencyContactName"',
  emergencyContactNumber: '"emergencyContactNumber"', emergencyContactRelation: '"emergencyContactRelation"',
  notes: "notes", payType: '"payType"', dailyRate: '"dailyRate"', monthlyRate: '"monthlyRate"',
  taxExempt: '"taxExempt"',
  // Clearance and examination dates. Real DATE columns — see DATE_FIELDS below.
  policeClearanceExpiry: '"policeClearanceExpiry"', lastMedicalExam: '"lastMedicalExam"',
  lastNeuroExam: '"lastNeuroExam"', lastDrugTestExam: '"lastDrugTestExam"',
  // Where net pay is sent. Validated below by validatePayout() before any of
  // these reach the UPDATE — an unusable destination on a 201 File becomes a
  // guard silently skipped at disbursement time, which is worse than a
  // rejected save.
  payoutChannel: '"payoutChannel"', payoutAccountNumber: '"payoutAccountNumber"',
  payoutAccountName: '"payoutAccountName"', payoutBankCode: '"payoutBankCode"'
};

// Fields backed by a real DATE column, so an empty string can be turned into
// NULL before it reaches Postgres. Most "date" fields on this table are TEXT
// for historical reasons and need no such handling.
const DATE_FIELDS = new Set([
  "lespExpiry",
  "policeClearanceExpiry", "lastMedicalExam", "lastNeuroExam", "lastDrugTestExam",
]);

// The payout fields, validated as a set. They are only meaningful together —
// a channel without an account number is not a partial save, it is an
// unusable one — so any request touching one is validated against the
// employee's resulting full payout state, not just the fields it sent.
const PAYOUT_KEYS = ["payoutChannel", "payoutAccountNumber", "payoutAccountName", "payoutBankCode"];

function validatePayoutPatch(body, existing = {}) {
  if (!PAYOUT_KEYS.some((k) => body[k] !== undefined)) return null;
  const merged = {};
  for (const k of PAYOUT_KEYS) merged[k] = body[k] !== undefined ? body[k] : existing[k];
  return validatePayout(merged);
}

// Create - Admin or Investigator
router.post("/", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.fullName || !b.fullName.trim()) return res.status(400).json({ error: "Full name is required." });
  const status = EMPLOYMENT_STATUSES.includes(b.employmentStatus) ? b.employmentStatus : "Active";

  // Auto-generate the employee number as YYYY-XXXX (current year + next sequence
  // for that year, resetting to 0001 each year). Any client-supplied number is
  // ignored — the field is system-assigned. We retry on the rare race where two
  // creates pick the same number simultaneously (unique constraint catches it).
  async function nextEmployeeNo() {
    const year = new Date().getFullYear();
    const prefix = `${year}-`;
    // Highest existing sequence for this year.
    const row = (await pool.query(
      `SELECT "employeeNo" FROM employees
       WHERE "employeeNo" LIKE $1
       ORDER BY "employeeNo" DESC LIMIT 1`,
      [`${prefix}%`]
    )).rows[0];
    let seq = 1;
    if (row && row.employeeNo) {
      const m = row.employeeNo.match(/^\d{4}-(\d+)$/);
      if (m) seq = parseInt(m[1], 10) + 1;
    }
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  let created = null, lastErr = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const employeeNo = await nextEmployeeNo();
    try {
      const { rows } = await pool.query(
        `INSERT INTO employees
          ("employeeNo","fullName",position,site,"dateHired","employmentStatus","birthDate",gender,"civilStatus",
           address,"contactNumber",email,"sssNo","philhealthNo","pagibigNo","tinNo",
           "emergencyContactName","emergencyContactNumber","emergencyContactRelation",notes,"createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          employeeNo, b.fullName.trim(), b.position || "", b.site || "",
          b.dateHired || null, status, b.birthDate || null, b.gender || "", b.civilStatus || "",
          b.address || "", b.contactNumber || "", b.email || "", b.sssNo || "", b.philhealthNo || "",
          b.pagibigNo || "", b.tinNo || "", b.emergencyContactName || "", b.emergencyContactNumber || "",
          b.emergencyContactRelation || "", (b.notes || "").trim(), req.user.username
        ]
      );
      created = rows[0];
    } catch (e) {
      // 23505 = unique violation on employeeNo; another create took this number.
      // Retry with the next sequence. Any other error is fatal.
      if (e.code === "23505") { lastErr = e; continue; }
      throw e;
    }
  }
  if (!created) return res.status(500).json({ error: "Could not assign an employee number. Please try again." });

  await log(created.id, req.user.username, "created", b.fullName.trim());
  res.status(201).json(await fullEmployee(created.id));
});

// Update core fields - Admin or Investigator
router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const emp = (await pool.query("SELECT * FROM employees WHERE id = $1", [req.params.id])).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee not found." });
  const b = req.body || {};

  if (b.employmentStatus !== undefined && !EMPLOYMENT_STATUSES.includes(b.employmentStatus)) {
    return res.status(400).json({ error: "Invalid employment status." });
  }
  // NOTE the String(... ?? "") guards. The detail modal PATCHes the WHOLE
  // employee object, so any column that is NULL arrives as null — not absent —
  // and `null.trim()` threw a TypeError here. Express 4 does not catch it, so
  // the request hung with no response instead of failing: editing any record
  // with no employee number was simply impossible. Records created through the
  // API always get a generated number, which is why this went unnoticed.
  const trimmed = (v) => String(v ?? "").trim();
  if (b.fullName !== undefined && !trimmed(b.fullName)) {
    return res.status(400).json({ error: "Full name is required." });
  }
  if (b.employeeNo !== undefined && trimmed(b.employeeNo)) {
    const dupe = (await pool.query(
      `SELECT id FROM employees WHERE "employeeNo" = $1 AND id <> $2`, [trimmed(b.employeeNo), emp.id]
    )).rows[0];
    if (dupe) return res.status(400).json({ error: "That employee number is already in use." });
  }

  // Payout destination: reject an unusable one outright, but let a merely
  // unusual one through with a warning the UI can surface. A wallet number is
  // normalised on the way in so the same person entered two ways is one
  // destination.
  const payout = validatePayoutPatch(b, emp);
  if (payout && !payout.ok) return res.status(400).json({ error: payout.errors[0], errors: payout.errors });
  if (payout) {
    if (b.payoutChannel !== undefined) b.payoutChannel = payout.channel;
    if (b.payoutAccountNumber !== undefined) b.payoutAccountNumber = payout.account;
    if (b.payoutBankCode !== undefined) b.payoutBankCode = payout.bank;
  }

  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(CORE_FIELDS).forEach(f => {
    if (b[f] === undefined) return;
    let v = typeof b[f] === "string" ? b[f].trim() : b[f];
    // Real DATE columns must take NULL, not "", when a date field is cleared.
    // Postgres rejects '' for a date, and Express 4 does not catch the
    // resulting rejection here — the request would hang with no response
    // rather than fail. ("dateHired"/"birthDate" are TEXT and unaffected.)
    if (DATE_FIELDS.has(f) && v === "") v = null;
    setClauses.push(`${CORE_FIELDS[f]} = $${i++}`);
    vals.push(v);
  });
  if (setClauses.length === 0) return res.json(await fullEmployee(emp.id));
  setClauses.push(`"updatedAt" = now()`);
  vals.push(emp.id);
  await pool.query(`UPDATE employees SET ${setClauses.join(", ")} WHERE id = $${i}`, vals);
  // The audit trail records WHICH fields changed, never their values — so an
  // account number never lands in the log. That was already true; it matters
  // more now that payout details pass through here.
  await log(emp.id, req.user.username, "updated", Object.keys(b).join(", "));
  const saved = await fullEmployee(emp.id);
  res.json(payout && payout.warnings.length ? { ...saved, warnings: payout.warnings } : saved);
});

// Delete - Admin only (cascades to documents, education, employment history)
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  // Deletion is Admin-only UNLESS an administrator has explicitly granted
  // this user the delete privilege for this module (req.moduleGrant, set by
  // modulePermission). Without that, the Access Privileges screen could
  // grant a delete that this line would silently overrule.
  if (req.user.role !== "Admin" && req.moduleGrant !== true) return res.status(403).json({ error: "Only an Admin can delete employee records." });
  const emp = (await pool.query(`SELECT id, "fullName" FROM employees WHERE id = $1`, [req.params.id])).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee not found." });
  await pool.query("DELETE FROM employees WHERE id = $1", [emp.id]);
  await log(emp.id, req.user.username, "deleted", emp.fullName);
  res.json({ ok: true });
});

// ---- Education sub-resource -------------------------------------------------

router.post("/:id/education", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { level, schoolName, courseOrStrand, yearGraduated, notes } = req.body || {};
  if (!schoolName || !schoolName.trim()) return res.status(400).json({ error: "School name is required." });
  const { rows } = await pool.query(
    `INSERT INTO employee_education (employee_id, "level", "schoolName", "courseOrStrand", "yearGraduated", notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, level || "", schoolName.trim(), courseOrStrand || "", yearGraduated || "", notes || ""]
  );
  await log(req.params.id, req.user.username, "education_added", schoolName.trim());
  res.status(201).json(rows[0]);
});

router.patch("/:id/education/:eduId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM employee_education WHERE id = $1 AND employee_id = $2", [req.params.eduId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Education entry not found." });
  const fieldMap = { level: '"level"', schoolName: '"schoolName"', courseOrStrand: '"courseOrStrand"', yearGraduated: '"yearGraduated"', notes: "notes" };
  const b = req.body || {};
  if (b.schoolName !== undefined && !b.schoolName.trim()) return res.status(400).json({ error: "School name is required." });
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(typeof b[f] === "string" ? b[f].trim() : b[f]); }
  });
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.eduId);
  const { rows } = await pool.query(`UPDATE employee_education SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  await log(req.params.id, req.user.username, "education_updated", rows[0].schoolName);
  res.json(rows[0]);
});

// ---- Employment history sub-resource ---------------------------------------

router.post("/:id/employment", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { companyName, position, employmentType, yearsEmployed, dateResigned, notes } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: "Company name is required." });
  const { rows } = await pool.query(
    `INSERT INTO employee_employment_history (employee_id, "companyName", position, "employmentType", "yearsEmployed", "dateResigned", notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, companyName.trim(), position || "", employmentType || "", yearsEmployed || "", dateResigned || "", notes || ""]
  );
  await log(req.params.id, req.user.username, "employment_added", companyName.trim());
  res.status(201).json(rows[0]);
});

router.patch("/:id/employment/:histId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(
    "SELECT * FROM employee_employment_history WHERE id = $1 AND employee_id = $2", [req.params.histId, req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Employment entry not found." });
  const fieldMap = { companyName: '"companyName"', position: "position", employmentType: '"employmentType"', yearsEmployed: '"yearsEmployed"', dateResigned: '"dateResigned"', notes: "notes" };
  const b = req.body || {};
  if (b.companyName !== undefined && !b.companyName.trim()) return res.status(400).json({ error: "Company name is required." });
  const setClauses = [];
  const vals = [];
  let i = 1;
  Object.keys(fieldMap).forEach(f => {
    if (b[f] !== undefined) { setClauses.push(`${fieldMap[f]} = $${i++}`); vals.push(typeof b[f] === "string" ? b[f].trim() : b[f]); }
  });
  if (setClauses.length === 0) return res.json(existing);
  vals.push(req.params.histId);
  const { rows } = await pool.query(`UPDATE employee_employment_history SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  await log(req.params.id, req.user.username, "employment_updated", rows[0].companyName);
  res.json(rows[0]);
});

// ---- Shared delete for education / employment child rows --------------------

const childTables = {
  education: { table: "employee_education", label: "education" },
  employment: { table: "employee_employment_history", label: "employment" },
};
router.delete("/:id/:list/:entryId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const entry = childTables[req.params.list];
  if (!entry) return res.status(400).json({ error: "Unknown list." });
  await pool.query(`DELETE FROM ${entry.table} WHERE id = $1 AND employee_id = $2`, [req.params.entryId, req.params.id]);
  await log(req.params.id, req.user.username, `${entry.label}_removed`, req.params.entryId);
  res.json({ ok: true });
});

// ---- Documents (BYTEA storage, same pattern as incident attachments) --------

router.post("/:id/documents", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const emp = (await pool.query("SELECT id FROM employees WHERE id = $1", [req.params.id])).rows[0];
    if (!emp) return res.status(404).json({ error: "Employee not found." });
    const b = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO employee_documents (employee_id, "docType", filename, mimetype, size, data, "issueDate", "expiryDate", notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, "docType", filename, mimetype, size, "issueDate", "expiryDate", notes, uploaded_by, uploaded_at`,
      [
        req.params.id, b.docType || "", req.file.originalname, req.file.mimetype, req.file.size,
        req.file.buffer, b.issueDate || null, b.expiryDate || null, b.notes || "", req.user.username
      ]
    );
    await log(req.params.id, req.user.username, "attachment_added", req.file.originalname);
    res.status(201).json(rows[0]);
  });
});

router.get("/:id/documents/:docId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM employee_documents WHERE id = $1 AND employee_id = $2", [req.params.docId, req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ error: "Document not found." });
  res.set("Content-Type", file.mimetype);
  res.set("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

router.delete("/:id/documents/:docId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT filename FROM employee_documents WHERE id = $1 AND employee_id = $2", [req.params.docId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Document not found." });
  await pool.query("DELETE FROM employee_documents WHERE id = $1", [req.params.docId]);
  await log(req.params.id, req.user.username, "attachment_removed", rows[0].filename);
  res.json({ ok: true });
});

// ---- Per-employee audit trail ----------------------------------------------

router.get("/:id/audit", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM audit_log WHERE incident_id = $1 ORDER BY at DESC", [String(req.params.id)]
  );
  res.json(rows);
});

module.exports = router;
