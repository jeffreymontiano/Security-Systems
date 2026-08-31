const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  PAYROLL_OVERRIDE_ROLES, PAYROLL_STATUTORY_OVERRIDE_ROLES, PAYROLL_REOPEN_ROLES,
} = require("../lib/permissions");
const { isGuardPosition } = require("../lib/leaveCredits");
const { addDays: phAddDays } = require("../lib/phTime");
const { computeReport } = require("./attendance-reports");
const {
  validateOverride, overridesMapFor, reconcileOverrides, STATUTORY_REASON_CATEGORIES,
} = require("../lib/payrollOverrides");
const { OVERRIDABLE_FIELDS, OVERRIDABLE_STATUTORY } = require("../lib/payrollEngine");
const { pesoPdf, amountPdf } = require("../lib/pdfMoney");
const { maskAccount, payoutReadiness } = require("../lib/payoutDetails");
const { xenditChannelCode, hasConfirmedCode, DISBURSEMENT_FEE_PHP } = require("../lib/xenditChannels");
const { buildCsv, fileNameFor } = require("../lib/disbursementFile");
const {
  resolveRecurringComponents, computeEmployeeLine, computeThirteenthMonth,
} = require("../lib/payrollEngine");

const router = express.Router();

const STATUTORY_KEYS = ["sss", "philhealth", "pagibig", "withholding_tax", "pay_rules", "premium_rules"];
const HOLIDAY_TYPES = ["Regular", "Special Non-Working"];

async function loadStatutoryConfig() {
  const { rows } = await pool.query(`SELECT key, config FROM payroll_statutory_config`);
  const out = {};
  for (const r of rows) out[r.key] = r.config;
  return out;
}

function isFirstCutoffOf(periodStart) {
  const day = Number(String(periodStart).split("-")[2]);
  return day <= 15;
}

// ---- Statutory / pay-rule config -------------------------------------------

router.get("/config", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT key, config, "updatedBy", "updatedAt" FROM payroll_statutory_config ORDER BY key`
  );
  res.json(rows);
});

router.put("/config/:key", requireAuth, requireRole("Admin"), async (req, res) => {
  if (!STATUTORY_KEYS.includes(req.params.key)) return res.status(400).json({ error: "Unknown config key." });
  const config = req.body?.config;
  if (!config || typeof config !== "object") return res.status(400).json({ error: "A config object is required." });
  await pool.query(
    `UPDATE payroll_statutory_config SET config = $1::jsonb, "updatedBy" = $2, "updatedAt" = now() WHERE key = $3`,
    [JSON.stringify(config), req.user.username, req.params.key]
  );
  res.json({ ok: true });
});

// ---- Pay periods ------------------------------------------------------------

router.get("/periods", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pp.id, to_char(pp."periodStart",'YYYY-MM-DD') AS "periodStart",
           to_char(pp."periodEnd",'YYYY-MM-DD') AS "periodEnd",
           to_char(pp."payDate",'YYYY-MM-DD') AS "payDate", pp.status,
           COUNT(pl.id)::int "lineCount",
           COALESCE(SUM(pl."grossPay"),0)::numeric "totalGross",
           COALESCE(SUM(pl."netPay"),0)::numeric "totalNet"
    FROM payroll_periods pp
    LEFT JOIN payroll_lines pl ON pl."periodId" = pp.id
    GROUP BY pp.id ORDER BY pp."periodStart" DESC
  `);
  res.json(rows);
});

router.post("/periods", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.periodStart || !b.periodEnd) return res.status(400).json({ error: "Period start and end dates are required." });
  if (b.periodEnd < b.periodStart) return res.status(400).json({ error: "The end date can't be before the start date." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO payroll_periods ("periodStart","periodEnd","payDate","createdBy")
       VALUES ($1::date,$2::date,$3::date,$4) RETURNING id`,
      [b.periodStart, b.periodEnd, b.payDate || null, req.user.username]
    );
    res.status(201).json({ id: rows[0].id, ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "A payroll period already exists for these dates." });
    throw e;
  }
});

// ---- Shift kinds worked in a period (DISPLAY ONLY) -------------------------
//
// The register shows WHICH KINDS of shift a guard actually worked, as a SET
// rather than a dominant type: a guard who worked days and nights reads
// "Day/Night". The point is that a pure-Day guard carrying night differential
// is visible as a contradiction rather than blending into an average.
//
// Sourced from `shift_assignments` — the same rostered duty rows attendance and
// payroll already read — never re-derived from punches. An UNROSTERED duty day
// contributes no kind, because there is no roster row to state one; a guard with
// only unrostered days reads as no kind at all rather than being guessed at.
//
// The API returns the ARRAY. Presentation differs by surface (the screen spells
// the kinds out, the PDF abbreviates for width), so the data has one home and
// each renderer formats it.
const SHIFT_KIND_ORDER = ["Day", "Night", "Straight", "Broken"];
const SHIFT_KIND_ABBREV = { Day: "D", Night: "N", Straight: "SD", Broken: "B" };

async function shiftKindsByEmployee(periodStart, periodEnd) {
  const { rows } = await pool.query(
    `SELECT "employeeId", NULLIF(btrim("shiftKind"), '') AS kind
       FROM shift_assignments
      WHERE "employeeId" IS NOT NULL
        AND "dutyDate" >= $1::date AND "dutyDate" <= $2::date
      GROUP BY 1, 2`,
    [periodStart, periodEnd]
  );
  const seen = new Map();
  for (const r of rows) {
    if (!r.kind) continue;                       // '' is the column default
    if (!seen.has(r.employeeId)) seen.set(r.employeeId, new Set());
    seen.get(r.employeeId).add(r.kind);
  }
  // Canonical order, so the same set always renders the same string. A kind the
  // roster holds but this list does not is appended rather than dropped.
  const out = new Map();
  for (const [id, set] of seen) {
    const known = SHIFT_KIND_ORDER.filter((k) => set.has(k));
    const extra = [...set].filter((k) => !SHIFT_KIND_ORDER.includes(k)).sort();
    out.set(id, [...known, ...extra]);
  }
  return out;
}

// The PDF abbreviates because the column budget is exactly full; truncating a
// combination would be worse than shortening it, since "Day/Nig" and "Day/Nig"
// read identically for Day/Night and Day/Night-Straight. A legend under the
// summary spells the letters out. The screen has no width pressure and spells
// the kinds out in full.
function shiftCell(line) {
  const kinds = line.shiftKinds || [];
  if (!kinds.length) return "—";
  return kinds.map((k) => SHIFT_KIND_ABBREV[k] || k.slice(0, 2).toUpperCase()).join("/");
}

async function withShiftKinds(lines, periodStart, periodEnd) {
  const kinds = await shiftKindsByEmployee(periodStart, periodEnd);
  return lines.map((l) => ({ ...l, shiftKinds: kinds.get(l.employeeId) || [] }));
}

// ---- Override audit -------------------------------------------------------
//
// payroll.js wrote NO audit entries before this: it was the least-audited money
// path in the system. Overrides are the first, because an override is a human
// disagreeing with the engine about someone's pay and the record of who and why
// is the entire point of the feature.
//
// Reuses the raw audit_log pattern already used in five other files. The write
// swallows its own errors, per convention: the log must never fail the action it
// records.
async function logPayrollAudit(req, periodId, employeeId, action, detail) {
  try {
    await pool.query(
      `INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)`,
      [`PAY-${periodId}-${employeeId ?? "all"}`, req.user?.username || "system", action, detail]
    );
  } catch (e) {
    console.error("[payroll] audit write failed:", e.message);
  }
}

// A period cannot be Approved while an override is stale, and cannot be deleted
// while it holds any override at all. Both are stated once so the routes cannot
// drift apart on the wording.
async function staleOverridesFor(periodId) {
  return (await pool.query(
    `SELECT o."employeeName", o."fieldName", o."computedValue", o."staleComputedValue"
       FROM payroll_line_overrides o
      WHERE o."periodId" = $1 AND o.status = 'stale'
      ORDER BY o."employeeName", o."fieldName"`, [periodId]
  )).rows;
}

router.get("/periods/:id", requireAuth, async (req, res) => {
  const period = (await pool.query(
    `SELECT id, to_char("periodStart",'YYYY-MM-DD') AS "periodStart",
            to_char("periodEnd",'YYYY-MM-DD') AS "periodEnd",
            to_char("payDate",'YYYY-MM-DD') AS "payDate", status
     FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  const lines = (await pool.query(
    `SELECT * FROM payroll_lines WHERE "periodId" = $1 ORDER BY "employeeName"`, [req.params.id]
  )).rows;

  // ORPHANED OVERRIDES: a standing correction whose employee is no longer
  // Active. `compute` loops over Active employees only, so such an override is
  // never applied and never reconciled -- it is skipped one level ABOVE
  // reconcileOverrides(), which never sees the employee at all. It then applies
  // again, unflagged, the moment the employee is reactivated and the period is
  // recomputed.
  //
  // READ ONLY, and deliberately so. This makes the condition VISIBLE; it does
  // not change whether the override applies. Suspending it would mean touching
  // the compute loop and the engine, which is a bigger change than a
  // population of zero justifies -- this list is what would show that
  // population arriving. See Known Gap 25.
  //
  // Gated on the override read allowlist: an override carries a reason that can
  // name an employee dispute, and this route is only requireAuth.
  const orphanedOverrides = mayReadOverrides(req)
    ? (await pool.query(
        `SELECT o.id, o."employeeName", o."employeeNo", o."fieldName",
                o."computedValue", o."overrideValue", o."createdBy",
                to_char(o."createdAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "createdPh",
                e."employmentStatus"
           FROM payroll_line_overrides o
           LEFT JOIN employees e ON e.id = o."employeeId"
          WHERE o."periodId" = $1
            AND o.status = 'active'
            -- e.id IS NULL covers the FK's ON DELETE SET NULL: the employee row
            -- is gone entirely, which is at least as orphaned as inactive.
            AND (e.id IS NULL OR e."employmentStatus" <> 'Active')
          ORDER BY o."employeeName", o."fieldName"`, [req.params.id]
      )).rows
    : [];

  res.json({
    ...period,
    lines: await withShiftKinds(lines, period.periodStart, period.periodEnd),
    orphanedOverrides,
  });
});

router.delete("/periods/:id", requireAuth, requireRole(), async (req, res) => {
  // Deletion is Admin-only UNLESS an administrator has explicitly granted
  // this user the delete privilege for this module (req.moduleGrant, set by
  // modulePermission). Without that, the Access Privileges screen could
  // grant a delete that this line would silently overrule.
  if (req.user.role !== "Admin" && req.moduleGrant !== true) return res.status(403).json({ error: "Only an Admin can delete a payroll period." });
  const period = (await pool.query(`SELECT status FROM payroll_periods WHERE id = $1`, [req.params.id])).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status === "Paid") return res.status(400).json({ error: "A paid payroll period can't be deleted." });
  // A labelled correction must never vanish silently. The foreign key is ON
  // DELETE RESTRICT so the database refuses too — enforced twice, the way a
  // finalised MDR is — but this answers with a count and a list instead of a
  // constraint violation. The way past it is removal-with-reason, which is
  // audited.
  const heldOverrides = (await pool.query(
    `SELECT "employeeName", "fieldName" FROM payroll_line_overrides
      WHERE "periodId" = $1 ORDER BY "employeeName", "fieldName"`, [req.params.id]
  )).rows;
  if (heldOverrides.length) {
    return res.status(409).json({
      error: `This period holds ${heldOverrides.length} payroll override(s). Remove them `
        + "first — each removal records who did it and why — so the corrections are not "
        + "discarded without a trace.",
      code: "period_has_overrides",
      overrides: heldOverrides,
    });
  }
  await pool.query(`DELETE FROM payroll_periods WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Compute (or recompute) every active employee's payslip line for this
// period. Safe to re-run while Draft/Computed — auto-applied components are
// replaced wholesale each time; any manually-added one-off components on a
// line are left untouched.
router.post("/periods/:id/compute", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const period = (await pool.query(
    `SELECT id, to_char("periodStart",'YYYY-MM-DD') AS "periodStart", to_char("periodEnd",'YYYY-MM-DD') AS "periodEnd", status
     FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status === "Paid") return res.status(400).json({ error: "A paid payroll period is locked." });

  const statutory = await loadStatutoryConfig();
  const payRules = statutory.pay_rules || {};
  const isFirstCutoff = isFirstCutoffOf(period.periodStart);

  const employees = (await pool.query(`SELECT * FROM employees WHERE "employmentStatus" = 'Active'`)).rows;

  // Holidays overlapping the period drive the premium multipliers. Loaded once
  // and matched per day/site by the engine's holidayFor().
  const holidays = (await pool.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, name, type, sites, active
     FROM payroll_holidays WHERE active = true AND date >= $1::date AND date <= $2::date`,
    [period.periodStart, period.periodEnd]
  )).rows;

  // Pull attendance from a week BEFORE the period so the Art. 94 "present the
  // workday before" check has something to look back at when a holiday lands
  // on day 1 of the cutoff. The engine only ever pays days inside the period.
  const lookbackFrom = phAddDays(period.periodStart, -7);
  const { rows: attendanceRows } = await computeReport({
    from: lookbackFrom, to: period.periodEnd, site: null, guard: null,
    grace: payRules.graceMinutes ?? 15, otThreshold: payRules.otThresholdMinutes ?? 30,
  });
  const attendanceByEmployee = new Map();
  for (const r of attendanceRows) {
    if (r.employeeId == null) continue;
    if (!attendanceByEmployee.has(r.employeeId)) attendanceByEmployee.set(r.employeeId, []);
    attendanceByEmployee.get(r.employeeId).push(r);
  }

  // Approved OT is now grouped by DAY as well as employee: overtime on a
  // holiday is paid at that holiday's OT multiplier, so a period total would
  // lose the information needed to price it.
  const otRows = (await pool.query(
    `SELECT "employeeId", to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", SUM("approvedMinutes")::int mins
     FROM overtime_records
     WHERE status = 'Approved' AND "employeeId" IS NOT NULL AND "dutyDate" >= $1::date AND "dutyDate" <= $2::date
     GROUP BY "employeeId", "dutyDate"`, [period.periodStart, period.periodEnd]
  )).rows;
  const otByEmployee = new Map();
  for (const r of otRows) {
    if (!otByEmployee.has(r.employeeId)) otByEmployee.set(r.employeeId, new Map());
    otByEmployee.get(r.employeeId).set(r.dutyDate, r.mins);
  }

  const leaveRows = (await pool.query(
    `SELECT "employeeId", to_char("fromDate",'YYYY-MM-DD') AS "fromDate", to_char("toDate",'YYYY-MM-DD') AS "toDate",
            "totalDays", "paidDays"
     FROM leave_records
     WHERE status = 'Approved' AND "employeeId" IS NOT NULL AND "toDate" >= $1::date AND "fromDate" <= $2::date`,
    [period.periodStart, period.periodEnd]
  )).rows;
  const leaveByEmployee = new Map();
  for (const r of leaveRows) {
    if (!leaveByEmployee.has(r.employeeId)) leaveByEmployee.set(r.employeeId, []);
    leaveByEmployee.get(r.employeeId).push(r);
  }

  const catalog = (await pool.query(`SELECT * FROM payroll_components`)).rows;
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  // Admin overrides for this period, loaded once. They are passed INTO the
  // engine so the priority/cap/arrears ladder re-runs beneath them; nothing
  // here adjusts a computed result afterwards.
  const overrideRows = (await pool.query(
    `SELECT id, "employeeId", "fieldName", "fieldClass", "computedValue",
            "overrideValue", status, "staleComputedValue"
       FROM payroll_line_overrides WHERE "periodId" = $1`, [period.id]
  )).rows;
  const overridesByEmployee = new Map();
  for (const r of overrideRows) {
    if (!overridesByEmployee.has(r.employeeId)) overridesByEmployee.set(r.employeeId, []);
    overridesByEmployee.get(r.employeeId).push(r);
  }
  const staleChanges = [];

  // Outstanding deduction arrears carried in from previously PAID periods.
  const arrearsRows = (await pool.query(`SELECT "employeeId", balance FROM payroll_employee_arrears`)).rows;
  const arrearsByEmployee = new Map(arrearsRows.map((r) => [r.employeeId, Number(r.balance)]));

  const assignmentRows = (await pool.query(`SELECT * FROM payroll_employee_components WHERE active = true`)).rows;
  const assignmentsByEmployee = new Map();
  for (const a of assignmentRows) {
    if (!assignmentsByEmployee.has(a.employeeId)) assignmentsByEmployee.set(a.employeeId, []);
    assignmentsByEmployee.get(a.employeeId).push(a);
  }

  let count = 0;
  for (const emp of employees) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let line = (await client.query(
        `SELECT id FROM payroll_lines WHERE "periodId" = $1 AND "employeeId" = $2`, [period.id, emp.id]
      )).rows[0];
      if (!line) {
        line = (await client.query(
          `INSERT INTO payroll_lines ("periodId","employeeId","employeeNo","employeeName",position,site)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [period.id, emp.id, emp.employeeNo || "", emp.fullName, emp.position || "", emp.site || ""]
        )).rows[0];
      }
      const lineId = line.id;

      // Replace auto-applied components; keep manual one-offs.
      await client.query(`DELETE FROM payroll_line_components WHERE "lineId" = $1 AND auto = true`, [lineId]);
      const recurring = resolveRecurringComponents(assignmentsByEmployee.get(emp.id) || [], catalogById, isFirstCutoff);
      for (const c of recurring) {
        await client.query(
          `INSERT INTO payroll_line_components
             ("lineId","componentId","employeeComponentId",name,kind,taxable,auto,amount,"createdBy")
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
          [lineId, c.componentId, c.assignmentId, c.name, c.kind, c.taxable, c.amount, req.user.username]
        );
      }

      const allComponents = (await client.query(
        `SELECT name, kind, taxable, amount FROM payroll_line_components WHERE "lineId" = $1`, [lineId]
      )).rows;

      const isGuard = isGuardPosition(emp.position);
      const computed = computeEmployeeLine({
        employee: emp,
        attendanceRows: attendanceByEmployee.get(emp.id) || [],
        approvedOtByDate: otByEmployee.get(emp.id) || new Map(),
        leaveRecords: leaveByEmployee.get(emp.id) || [],
        isGuard, components: allComponents, statutory, isFirstCutoff,
        overrides: overridesMapFor(overridesByEmployee.get(emp.id)),
        periodStart: period.periodStart, periodEnd: period.periodEnd,
        holidays,
        openingArrears: arrearsByEmployee.get(emp.id) || 0,
      });

      // Did the ground move under any standing override? Collected now and
      // written after the loop, so a failure priced for one employee cannot
      // leave half the reconciliation applied.
      // Reconcile this employee's overrides INSIDE the same transaction as their
      // line. The status and the figure it describes then move together: a
      // crash mid-run can no longer leave a line recomputed against a base that
      // its override was never checked against.
      //
      // The AUDIT writes stay outside, collected here and written after the
      // loop. They are deliberately non-transactional -- an audit write must
      // never fail the action it records -- and rolling one back with a failed
      // employee would erase the record of something that did happen.
      const reconciled = reconcileOverrides(
        overridesByEmployee.get(emp.id), computed.overridesApplied
      ).map((c) => ({ ...c, employeeId: emp.id, employeeName: emp.fullName }));
      for (const c of reconciled) {
        await client.query(
          `UPDATE payroll_line_overrides
              SET status = $1, "staleComputedValue" = $2,
                  "staleDetectedAt" = CASE WHEN $1 = 'stale' THEN now() ELSE NULL END,
                  "reconfirmedBy" = CASE WHEN $1 = 'stale' THEN NULL ELSE "reconfirmedBy" END
            WHERE id = $3`,
          [c.status, c.staleComputedValue, c.id]
        );
      }
      staleChanges.push(...reconciled);

      // Per-day audit rows: replaced wholesale each recompute, same as the
      // auto line-components above.
      await client.query(`DELETE FROM payroll_line_days WHERE "lineId" = $1`, [lineId]);
      for (const d of computed.days) {
        await client.query(
          `INSERT INTO payroll_line_days
             ("lineId","dutyDate","dayType","holidayName","isRestDay",worked,
              "regularMinutes","otMinutes","nightMinutes","nightOtMinutes",
              "basePay","otPay","nightDiffPay","holidayPremium")
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [lineId, d.dutyDate, d.dayType, d.holidayName, d.isRestDay, d.worked,
           d.regularMinutes, d.otMinutes, d.nightMinutes, d.nightOtMinutes,
           d.basePay, d.otPay, d.nightDiffPay, d.holidayPremium + d.unworkedHolidayPay]
        );
      }

      await client.query(
        `UPDATE payroll_lines SET
           "employeeNo" = $1, "employeeName" = $2, position = $3, site = $4,
           "payType" = $5, "rateUsed" = $6,
           "presentDays" = $7, "absentDays" = $8, "paidLeaveDays" = $9, "lwopDays" = $10,
           "lateMinutes" = $11, "undertimeMinutes" = $12, "builtinOtMinutes" = $13, "approvedOtMinutes" = $14,
           "regularPay" = $15, "otPay" = $16, "lateUndertimeDeduction" = $17, "otherEarnings" = $18, "grossPay" = $19,
           "sssEe" = $20, "sssEr" = $21, "philhealthEe" = $22, "philhealthEr" = $23,
           "pagibigEe" = $24, "pagibigEr" = $25, "withholdingTax" = $26,
           "otherDeductions" = $27, "netPay" = $28,
           "nightDiffMinutes" = $29, "nightDiffPay" = $30,
           "holidayPremiumPay" = $31, "holidayUnworkedPay" = $32,
           "arrearsOpening" = $33, "arrearsRecovered" = $34, "deductionsDeferred" = $35,
           "builtinOtPay" = $36, "excessOtPay" = $37,
           "computedAt" = now()
         WHERE id = $38`,
        [
          emp.employeeNo || "", emp.fullName, emp.position || "", emp.site || "",
          computed.payType, computed.rateUsed,
          computed.presentDays, computed.absentDays, computed.paidLeaveDays, computed.lwopDays,
          computed.lateMinutes, computed.undertimeMinutes, computed.builtinOtMinutes, computed.approvedOtMinutes,
          computed.regularPay, computed.otPay, computed.lateUndertimeDeduction, computed.otherEarnings, computed.grossPay,
          // Employee-side figures store what was ACTUALLY withheld after the
          // gross cap, so gross - deductions reconciles exactly to net on the
          // payslip; anything not collected shows as "deductionsDeferred" and
          // moves to the arrears balance. Employer shares are unaffected — the
          // company remits its full contribution regardless.
          computed.withheld.sssEe, computed.sssEr,
          computed.withheld.philhealthEe, computed.philhealthEr,
          computed.withheld.pagibigEe, computed.pagibigEr,
          computed.withheld.withholdingTax,
          computed.withheld.otherDeductions, computed.netPay,
          computed.nightDiffMinutes, computed.nightDiffPay,
          computed.holidayPremiumPay, computed.holidayUnworkedPay,
          computed.arrearsOpening, computed.arrearsRecovered, computed.deductionsDeferred,
          computed.builtinOtPay, computed.excessOtPay,
          lineId,
        ]
      );

      await client.query("COMMIT");
      count++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error(`[payroll] compute failed for employee ${emp.id}:`, e.message);
      return res.status(500).json({
        error: `Could not compute payroll for ${emp.fullName}. No changes were saved for that employee. (${e.message})`,
      });
    }
    client.release();
  }

  // Apply the override reconciliation. A STALE override is one whose computed
  // base has moved since a human chose to override it — the PhilHealth rate
  // repair (PHP 2.14 -> 427.50) is the worked example. It stays APPLIED, but it
  // is flagged and it blocks Approve until someone re-confirms, updates or
  // removes it: auto-clearing would silently undo a decision, and silently
  // keeping it would let a correction ride a base it was never taken against.
  // The status rows are already written, each inside its own employee's
  // transaction. This pass only AUDITS them and collects what to report.
  const staleNow = [];
  for (const c of staleChanges) {
    if (c.status === "active") {
      // Automatic, but never silent. The flag cleared itself because the engine
      // came back to the figure the override was taken against, so the override
      // no longer rides a base it was never checked against — but it IS a
      // status change on a money record, and every one of those is traceable.
      await logPayrollAudit(req, period.id, c.employeeId, "payroll_override_reactivated",
        `${c.employeeName}: ${c.fieldName} override returned to ACTIVE automatically — the `
        + `engine's computed figure returned to ${c.returnedTo}, the value the override was `
        + "taken against. Cleared by this recompute; no longer blocks Approve.");
    }
    if (c.status === "stale") {
      staleNow.push(c);
      await logPayrollAudit(req, period.id, c.employeeId, "payroll_override_stale",
        `${c.employeeName}: ${c.fieldName} was overridden when the engine computed a different `
        + `figure; the engine now computes ${c.staleComputedValue}. Re-confirm, update or remove it.`);
    }
  }

  await pool.query(`UPDATE payroll_periods SET status = 'Computed', "updatedAt" = now() WHERE id = $1`, [period.id]);
  res.json({
    ok: true, count,
    // Named rather than merely counted: the reviewer has to know WHOSE line and
    // WHICH field to look at, or the flag is just a number on a screen.
    staleOverrides: staleNow.map((c) => ({
      employeeName: c.employeeName, fieldName: c.fieldName,
      engineNowComputes: c.staleComputedValue,
    })),
  });
});

router.patch("/periods/:id/approve", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  // An approval says the figures are agreed. A stale override means the engine
  // has changed its mind about a figure a human deliberately overrode, and
  // nobody has looked at the divergence yet — so the figures are precisely NOT
  // agreed. Same shape as billing refusing Issue while a line holds a pending
  // review, and refused on the SERVER because a disabled button is not a check.
  const stale = await staleOverridesFor(req.params.id);
  if (stale.length) {
    return res.status(409).json({
      error: `${stale.length} override(s) on this period were taken against a computed `
        + "figure the engine no longer produces. Re-confirm, update or remove each one "
        + "before approving.",
      code: "stale_overrides",
      staleOverrides: stale.map((r) => ({
        employeeName: r.employeeName, fieldName: r.fieldName,
        overriddenWhenEngineSaid: r.computedValue, engineNowComputes: r.staleComputedValue,
      })),
    });
  }
  const { rowCount } = await pool.query(
    `UPDATE payroll_periods SET status = 'Approved', "updatedAt" = now() WHERE id = $1 AND status = 'Computed'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only a computed period can be approved." });
  res.json({ ok: true });
});

// Mark Paid: the one-way lock. Also the one and only point where recurring
// loan balances actually decrement — never during compute/recompute, so
// re-running Compute before Paid can never double-charge a loan.
router.patch("/periods/:id/mark-paid", requireAuth, requireRole("Admin"), async (req, res) => {
  const period = (await pool.query(`SELECT id, status FROM payroll_periods WHERE id = $1`, [req.params.id])).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status !== "Approved") return res.status(400).json({ error: "Only an approved period can be marked paid." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const loanRows = (await client.query(
      `SELECT plc."employeeComponentId", plc.amount
       FROM payroll_line_components plc
       JOIN payroll_lines pl ON pl.id = plc."lineId"
       WHERE pl."periodId" = $1 AND plc.auto = true AND plc."employeeComponentId" IS NOT NULL`,
      [period.id]
    )).rows;
    for (const r of loanRows) {
      await client.query(
        `UPDATE payroll_employee_components
         SET "balanceRemaining" = GREATEST(0, COALESCE("balanceRemaining", 0) - $1),
             active = CASE WHEN COALESCE("balanceRemaining", 0) - $1 <= 0 AND "balanceRemaining" IS NOT NULL THEN false ELSE active END
         WHERE id = $2 AND "balanceRemaining" IS NOT NULL`,
        [r.amount, r.employeeComponentId]
      );
    }
    // Move deduction arrears only now, for the same reason as loan balances:
    // recomputing a Draft/Computed period must never double-count. Each line
    // recovers what it collected and defers what gross couldn't cover.
    const arrearsLines = (await client.query(
      `SELECT pl."employeeId", pl."arrearsRecovered", pl."deductionsDeferred",
              to_char(pp."periodStart",'YYYY-MM-DD') || ' to ' || to_char(pp."periodEnd",'YYYY-MM-DD') AS label
       FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl."periodId"
       WHERE pl."periodId" = $1 AND pl."employeeId" IS NOT NULL
         AND (pl."arrearsRecovered" > 0 OR pl."deductionsDeferred" > 0)`,
      [period.id]
    )).rows;

    for (const r of arrearsLines) {
      const delta = Number(r.deductionsDeferred) - Number(r.arrearsRecovered);
      // $2 must be cast: with a bare GREATEST(0, $2) Postgres infers integer
      // from the literal and rejects a decimal delta like 591.25.
      const updated = (await client.query(
        `INSERT INTO payroll_employee_arrears ("employeeId", balance, "updatedAt")
         VALUES ($1, GREATEST(0::numeric, $2::numeric), now())
         ON CONFLICT ("employeeId") DO UPDATE
           SET balance = GREATEST(0::numeric, payroll_employee_arrears.balance + $2::numeric), "updatedAt" = now()
         RETURNING balance`,
        [r.employeeId, delta]
      )).rows[0];

      for (const [kind, amount] of [["recovered", Number(r.arrearsRecovered)], ["deferred", Number(r.deductionsDeferred)]]) {
        if (amount > 0) {
          await client.query(
            `INSERT INTO payroll_arrears_ledger ("employeeId","periodId","periodLabel",kind,amount,"balanceAfter")
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [r.employeeId, period.id, r.label, kind, amount, updated.balance]
          );
        }
      }
    }

    await client.query(`UPDATE payroll_periods SET status = 'Paid', "updatedAt" = now() WHERE id = $1`, [period.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[payroll] mark-paid failed:", e.message);
    return res.status(500).json({ error: "Could not mark this period paid. No changes were saved." });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// ---- Disbursement (Stage 1: capture + export) -------------------------------
//
// Turns an APPROVED pay period into an instruction to pay each guard's net pay
// into their e-wallet or bank. Stage 1 produces a file the finance person
// uploads to the payment provider; Stage 2 will call the provider's payout API
// against these same rows.
//
// This module never moves money and never holds provider credentials. It reads
// computed net pay and the 201 File's payout details, and writes a file.

// Everything the batch screen and the file both need, in one shape.
async function loadBatch(batchId) {
  const batch = (await pool.query(
    `SELECT b.*, to_char(b."createdAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "createdAtPh",
            to_char(b."exportedAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "exportedAtPh",
            to_char(p."periodStart",'YYYY-MM-DD') AS "periodStart",
            to_char(p."periodEnd",'YYYY-MM-DD') AS "periodEnd",
            p.status AS "periodStatus"
     FROM disbursement_batches b
     JOIN payroll_periods p ON p.id = b."payPeriodId"
     WHERE b.id = $1`, [batchId]
  )).rows[0];
  if (!batch) return null;
  const items = (await pool.query(
    `SELECT * FROM disbursement_items WHERE "batchId" = $1 ORDER BY "guardName"`, [batchId]
  )).rows;
  return { batch, items };
}

// Account numbers are masked for DISPLAY. The full number is written only into
// the downloaded file, which is the one place it has to be complete.
const presentItem = (i) => ({
  ...i,
  payoutAccountNumber: maskAccount(i.payoutAccountNumber),
  channelCode: xenditChannelCode(i.payoutChannel, i.payoutBankCode),
  channelCodeConfirmed: hasConfirmedCode(i.payoutChannel, i.payoutBankCode),
});

function batchSummary(batch, items) {
  const count = items.length;
  const unconfirmed = items.filter((i) => !hasConfirmedCode(i.payoutChannel, i.payoutBankCode));
  return {
    employeeCount: count,
    totalNet: items.reduce((s, i) => s + Number(i.netAmount || 0), 0),
    // An ESTIMATE only. The provider charges per successful payout, and two
    // announced changes are not modelled — see xenditChannels.js.
    estimatedFee: count * DISBURSEMENT_FEE_PHP,
    feePerPayout: DISBURSEMENT_FEE_PHP,
    unconfirmedChannelCount: unconfirmed.length,
  };
}

// Build a Draft batch from an approved period. Idempotent: a period already
// carrying a batch returns that batch rather than creating a second
// instruction to pay the same payroll.
router.post("/periods/:id/disbursement", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const period = (await pool.query(
    `SELECT id, status, to_char("periodStart",'YYYY-MM-DD') AS "periodStart",
            to_char("periodEnd",'YYYY-MM-DD') AS "periodEnd"
     FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status !== "Approved") {
    return res.status(400).json({
      error: `This period is ${period.status}. A disbursement can only be prepared from an Approved period — approving is the point at which the figures are agreed.`,
    });
  }

  const existing = (await pool.query(
    `SELECT id FROM disbursement_batches WHERE "payPeriodId" = $1`, [period.id]
  )).rows[0];
  if (existing) {
    const loaded = await loadBatch(existing.id);
    return res.json({
      ...loaded.batch,
      items: loaded.items.map(presentItem),
      summary: batchSummary(loaded.batch, loaded.items),
      skipped: [],
      alreadyExisted: true,
    });
  }

  // Net pay comes from the computed payslip; the destination comes from the
  // 201 File. A guard missing either is reported, not guessed at.
  const rows = (await pool.query(
    `SELECT pl."employeeId", pl."employeeNo", pl."employeeName", pl."netPay",
            e."payoutChannel", e."payoutAccountNumber", e."payoutAccountName", e."payoutBankCode"
     FROM payroll_lines pl
     LEFT JOIN employees e ON e.id = pl."employeeId"
     WHERE pl."periodId" = $1
     ORDER BY pl."employeeName"`, [period.id]
  )).rows;

  const payable = [];
  const skipped = [];
  for (const r of rows) {
    const net = Number(r.netPay || 0);
    if (!r.employeeId) {
      skipped.push({ guardName: r.employeeName, reason: "The payslip is not linked to an employee record." });
      continue;
    }
    // Net can legitimately be zero: deductions capped at gross carry the
    // shortfall forward. Paying ₱0.00 would cost a fee and mean nothing.
    if (net <= 0) {
      skipped.push({ guardName: r.employeeName, employeeId: r.employeeId, reason: "Net pay is ₱0.00 — nothing to disburse (deductions were carried forward)." });
      continue;
    }
    const readiness = payoutReadiness(r);
    if (!readiness.ready) {
      skipped.push({ guardName: r.employeeName, employeeId: r.employeeId, reason: readiness.reason });
      continue;
    }
    payable.push({ ...r, netAmount: net });
  }

  if (!payable.length) {
    return res.status(400).json({
      error: "No guard on this period can be paid out yet — every payslip was skipped.",
      skipped,
    });
  }

  const db = await pool.connect();
  let batchId;
  try {
    await db.query("BEGIN");
    batchId = (await db.query(
      `INSERT INTO disbursement_batches ("payPeriodId","totalNet","employeeCount","createdBy")
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [period.id, payable.reduce((s, p) => s + p.netAmount, 0), payable.length, req.user.username]
    )).rows[0].id;

    for (const p of payable) {
      await db.query(
        `INSERT INTO disbursement_items ("batchId","employeeId","employeeNo","guardName",
           "payoutChannel","payoutAccountNumber","payoutAccountName","payoutBankCode","netAmount")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [batchId, p.employeeId, p.employeeNo || "", p.employeeName,
         p.payoutChannel, p.payoutAccountNumber, p.payoutAccountName, p.payoutBankCode || "", p.netAmount]
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("[payroll] disbursement build failed:", e.message);
    return res.status(500).json({ error: "Could not prepare the disbursement. No batch was created." });
  } finally {
    db.release();
  }

  const loaded = await loadBatch(batchId);
  res.status(201).json({
    ...loaded.batch,
    items: loaded.items.map(presentItem),
    summary: batchSummary(loaded.batch, loaded.items),
    created: loaded.items.length,
    skipped,
  });
});

router.get("/periods/:id/disbursement", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT id FROM disbursement_batches WHERE "payPeriodId" = $1`, [req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "No disbursement has been prepared for this period." });
  const loaded = await loadBatch(row.id);
  res.json({
    ...loaded.batch,
    items: loaded.items.map(presentItem),
    summary: batchSummary(loaded.batch, loaded.items),
  });
});

// The file. Downloading it marks the batch Exported — that is the moment the
// account numbers leave this system, so it is worth recording who and when.
router.get("/disbursement/:batchId/file", requireAuth, async (req, res) => {
  const loaded = await loadBatch(req.params.batchId);
  if (!loaded) return res.status(404).json({ error: "Disbursement batch not found." });
  const { batch, items } = loaded;
  if (!items.length) return res.status(400).json({ error: "This batch has no payable guards." });

  const { companyName } = await brandingBlock();
  const csv = buildCsv({ batch, items, period: batch, companyName });

  await pool.query(
    `UPDATE disbursement_batches
     SET status = CASE WHEN status = 'Draft' THEN 'Exported' ELSE status END,
         "exportedBy" = $1, "exportedAt" = now()
     WHERE id = $2`,
    [req.user.username, batch.id]
  );

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${fileNameFor(batch, batch)}"`);
  res.send(csv);
});

// Remove a batch so it can be rebuilt after fixing a guard's 201 File. Only
// before the money has moved — Stage 2's Submitted/Reconciled batches are a
// record of instructed payouts and are not deletable.
router.delete("/disbursement/:batchId", requireAuth, requireRole("Admin"), async (req, res) => {
  const batch = (await pool.query(`SELECT id, status FROM disbursement_batches WHERE id = $1`, [req.params.batchId])).rows[0];
  if (!batch) return res.status(404).json({ error: "Disbursement batch not found." });
  if (!["Draft", "Exported"].includes(batch.status)) {
    return res.status(400).json({ error: `This batch is ${batch.status} — payouts have been instructed and the record must be kept.` });
  }
  await pool.query(`DELETE FROM disbursement_batches WHERE id = $1`, [batch.id]);
  res.json({ ok: true });
});

// Manual catch-all adjustment on a single line (e.g. a correction that
// doesn't fit the itemized components model). Recomputes net pay.
// requireRole() is gone from this route on purpose: it named Admin and the
// legacy Investigator, neither of which is the rule any more. The gate is
// mayOverride() below -- the same allowlist the override routes use -- so one
// list decides who may move money, wherever the edit is entered from.
router.patch("/lines/:id", requireAuth, async (req, res) => {
  const line = (await pool.query(
    `SELECT pl.*, pp.status "periodStatus", pp."reopenedAt" FROM payroll_lines pl
     JOIN payroll_periods pp ON pp.id = pl."periodId" WHERE pl.id = $1`, [req.params.id]
  )).rows[0];
  if (!line) return res.status(404).json({ error: "Payslip line not found." });

  const b = req.body || {};
  const otherDeductions = b.otherDeductions !== undefined ? Number(b.otherDeductions) : Number(line.otherDeductions);
  if (!Number.isFinite(otherDeductions) || otherDeductions < 0) return res.status(400).json({ error: "Other deductions must be a non-negative number." });
  const note = b.otherDeductionsNote !== undefined ? String(b.otherDeductionsNote).trim() : line.otherDeductionsNote;

  if (!mayOverride(req, "otherDeductions")) {
    return res.status(403).json({ error: overrideDenied("otherDeductions") });
  }
  if (line.periodStatus === "Paid" && !line.reopenedAt) {
    return res.status(400).json({
      error: "A paid payroll period is locked. Reopen it first if it must be corrected.",
      code: "period_locked",
    });
  }

  // THIS ROUTE NO LONGER COMPUTES NET PAY. It used to write
  //   netPay = grossPay - sssEe - philhealthEe - pagibigEe - withholdingTax - otherDeductions
  // which omitted arrears recovery and the gross cap entirely, so adjusting a
  // line that recovers arrears wrote a net the engine would never produce and
  // left deductionsDeferred describing a collection that had changed. It was a
  // second implementation of the money maths in the least-reviewed place, and
  // the next recompute silently overwrote whatever it wrote.
  //
  // It now records an OVERRIDE on otherDeductions and lets computeEmployeeLine
  // re-derive net through its own priority/cap/arrears ladder. The edit
  // therefore survives a recompute instead of being erased by one. (Known Gap
  // 23.)
  const note_ = note || "";
  const reason = (String(b.reason || "").trim())
    || (note_ ? `Other deductions adjusted: ${note_}` : "");
  const v = validateOverride({
    fieldName: "otherDeductions",
    value: otherDeductions,
    reason,
    reasonCategory: b.reasonCategory,
  });
  if (!v.ok) {
    return res.status(400).json({
      error: v.error + " (Adjusting Other Deductions now records an audited override.)",
    });
  }

  const prior = (await pool.query(
    `SELECT id, "overrideValue" FROM payroll_line_overrides
      WHERE "periodId" = $1 AND "employeeId" = $2 AND "fieldName" = 'otherDeductions'`,
    [line.periodId, line.employeeId]
  )).rows[0];

  await pool.query(
    `INSERT INTO payroll_line_overrides
       ("periodId","employeeId","employeeNo","employeeName","fieldName","fieldClass",
        "computedValue","overrideValue",reason,"reasonCategory","createdBy")
     VALUES ($1,$2,$3,$4,'otherDeductions',$5,$6,$7,$8,$9,$10)
     ON CONFLICT ("periodId","employeeId","fieldName") DO UPDATE
        SET "overrideValue" = EXCLUDED."overrideValue", reason = EXCLUDED.reason,
            "reasonCategory" = EXCLUDED."reasonCategory",
            "computedValue" = EXCLUDED."computedValue",
            status = 'active', "staleComputedValue" = NULL, "staleDetectedAt" = NULL,
            "reconfirmedBy" = NULL, "reconfirmedAt" = NULL,
            "createdBy" = EXCLUDED."createdBy", "createdAt" = now()`,
    [line.periodId, line.employeeId, line.employeeNo, line.employeeName,
      v.fieldClass, Number(line.otherDeductions ?? 0), v.value, v.reason, v.reasonCategory,
      req.user.username]
  );

  // The note is a display field on the line and is kept as it was.
  if (b.otherDeductionsNote !== undefined) {
    await pool.query(`UPDATE payroll_lines SET "otherDeductionsNote" = $1 WHERE id = $2`,
      [note_, req.params.id]);
  }

  const postIssue = !!line.reopenedAt;
  await logPayrollAudit(req, line.periodId, line.employeeId,
    (prior ? "payroll_override_updated" : "payroll_override_set") + (postIssue ? "_post_issue" : ""),
    `${line.employeeName}: otherDeductions overridden ${Number(line.otherDeductions ?? 0)} -> ${v.value} `
      + `via the line adjust. Reason: "${v.reason}".`);

  res.json({
    ok: true,
    otherDeductions: v.value,
    otherDeductionsNote: note_,
    // Deliberately no netPay: this route no longer derives it. The engine does,
    // on the next recompute.
    note: "Recorded as an override. Not reflected on the payslip until this period is recomputed.",
  });
});

// ---- Reopen / re-lock a PAID period ----------------------------------------
//
// A paid period is locked because netPay is what the disbursement file already
// paid. Correcting one is sometimes necessary and must never be casual, so it
// is a DELIBERATE, LOGGED act with a typed reason, restricted more tightly than
// the corrections it enables -- Accounting / Payroll may correct a line, but
// only Admin or the Owner may decide a paid period may be corrected at all.
//
// Re-lock is EXPLICIT, not automatic. Auto-relocking after each edit would mean
// a fresh reopen per line for anyone fixing three of them; relocking on leaving
// the page would depend on a UI event that a closed laptop never sends. The
// cost of explicitness is a period that can sit open unnoticed, which is why
// `reopenedAt` is surfaced on the period screen rather than only in the log.
router.patch("/periods/:id/reopen", requireAuth, async (req, res) => {
  if (!PAYROLL_REOPEN_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: "Your role may not reopen a paid payroll period." });
  }
  const period = (await pool.query(
    `SELECT id, status, "reopenedAt" FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status !== "Paid") {
    return res.status(400).json({ error: "Only a paid period can be reopened." });
  }
  const why = String((req.body || {}).reason || "").trim();
  if (why.length < 20) {
    return res.status(400).json({
      error: "Reopening a paid period needs a reason of at least 20 characters: it puts money "
        + "that has already been disbursed back in scope for correction.",
    });
  }
  await pool.query(
    `UPDATE payroll_periods
        SET status = 'Approved', "reopenedAt" = now(), "reopenedBy" = $1,
            "reopenReason" = $2, "updatedAt" = now()
      WHERE id = $3`, [req.user.username, why, period.id]);
  await logPayrollAudit(req, period.id, null, "payroll_period_reopened",
    `Paid period reopened for correction by ${req.user.username} (${req.user.role}). Reason: "${why}".`);
  res.json({ ok: true, status: "Approved", reopened: true });
});

router.patch("/periods/:id/relock", requireAuth, async (req, res) => {
  if (!PAYROLL_REOPEN_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: "Your role may not re-lock a payroll period." });
  }
  const period = (await pool.query(
    `SELECT id, status, "reopenedAt" FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (!period.reopenedAt) {
    return res.status(400).json({ error: "This period is not currently reopened." });
  }
  // A standing STALE override means a correction is still unreviewed. Re-locking
  // over it would freeze a figure nobody confirmed -- the same reason Approve
  // refuses one.
  const stale = await staleOverridesFor(period.id);
  if (stale.length) {
    return res.status(409).json({
      error: `${stale.length} override(s) on this period are flagged and unreviewed. `
        + "Re-confirm, update or remove each one before re-locking.",
      code: "stale_overrides",
      staleOverrides: stale.map((r) => ({
        employeeName: r.employeeName, fieldName: r.fieldName,
        overriddenWhenEngineSaid: r.computedValue, engineNowComputes: r.staleComputedValue,
      })),
    });
  }
  await pool.query(
    `UPDATE payroll_periods
        SET status = 'Paid', "reopenedAt" = NULL, "reopenedBy" = NULL,
            "reopenReason" = NULL, "updatedAt" = now()
      WHERE id = $1`, [period.id]);
  await logPayrollAudit(req, period.id, null, "payroll_period_relocked",
    `Period re-locked as Paid by ${req.user.username} (${req.user.role}) after post-issue correction.`);
  res.json({ ok: true, status: "Paid", reopened: false });
});

// ---- Who may correct a computed figure -------------------------------------
//
// Explicit allowlists, checked in the route rather than through the module
// matrix. `edit` on payroll is grantable per user from Manage Users, so relying
// on the matrix would let someone widen who can move money without touching a
// reviewed line. These lists are that line.
//
// Statutory fields are checked against their OWN list: overriding an SSS or
// PhilHealth figure changes what the agency remits to government, which is a
// heavier act than correcting an allowance. Identical membership today; the
// separation is what makes divergence cheap.
function mayOverride(req, fieldName) {
  const list = OVERRIDABLE_STATUTORY.includes(fieldName)
    ? PAYROLL_STATUTORY_OVERRIDE_ROLES
    : PAYROLL_OVERRIDE_ROLES;
  return list.includes(req.user?.role);
}
function overrideDenied(fieldName) {
  return OVERRIDABLE_STATUTORY.includes(fieldName)
    ? "Your role may not override a statutory contribution."
    : "Your role may not override a payroll figure.";
}
const mayReadOverrides = (req) =>
  PAYROLL_OVERRIDE_ROLES.includes(req.user?.role)
  || PAYROLL_STATUTORY_OVERRIDE_ROLES.includes(req.user?.role);

// A period is EDITABLE when it is not Paid, or when it is Paid and has been
// deliberately reopened. `reopenedAt` is the durable marker; an edit made while
// it is set is audited under its own action name, because it changes money the
// disbursement file already paid.
const isReopened = (period) => !!period.reopenedAt;
function periodEditable(period) {
  if (period.status !== "Paid") return { ok: true, postIssue: isReopened(period) };
  return { ok: false };
}

// ---- Payroll line OVERRIDES ------------------------------------------------
//
// Gated Admin-only for now. Stage 3 replaces this with the two explicit
// allowlists (PAYROLL_OVERRIDE_ROLES / PAYROLL_STATUTORY_OVERRIDE_ROLES);
// Admin-only is at least as tight as that will be, so nothing is exposed early.

// Admin-only to READ, not merely to write: an override reason can name an
// employee dispute, which is sensitive HR context. There is no reason reads
// should be looser than the writes beside them. Stage 3 widens both to the
// allowlist together.
router.get("/periods/:id/overrides", requireAuth, async (req, res) => {
  if (!mayReadOverrides(req)) {
    return res.status(403).json({ error: "Your role may not view payroll overrides." });
  }
  const rows = (await pool.query(
    `SELECT * FROM payroll_line_overrides WHERE "periodId" = $1
      ORDER BY "employeeName", "fieldName"`, [req.params.id]
  )).rows;
  res.json({ overrides: rows, reasonCategories: STATUTORY_REASON_CATEGORIES });
});

// Create or replace one override. Idempotent on (periodId, employeeId, field),
// so re-submitting is an UPDATE rather than a duplicate.
router.post("/periods/:id/overrides", requireAuth, async (req, res) => {
  const period = (await pool.query(
    `SELECT id, status, "reopenedAt" FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });

  const b = req.body || {};
  const v = validateOverride(b);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // Role check AFTER validation so the message names the real reason, and
  // BEFORE any write. Statutory fields answer to their own list.
  if (!mayOverride(req, b.fieldName)) {
    return res.status(403).json({ error: overrideDenied(b.fieldName) });
  }

  // A Paid period is locked unless it has been deliberately reopened. Editing a
  // reopened one is allowed and AUDITED DIFFERENTLY -- it changes money the
  // disbursement file already paid, and must not read like a draft correction.
  const editable = periodEditable(period);
  if (!editable.ok) {
    return res.status(400).json({
      error: "A paid payroll period is locked. Reopen it first if it must be corrected.",
      code: "period_locked",
    });
  }

  // The computed value is snapshotted from the line as it stands, which is what
  // the admin is looking at when they decide to disagree with it. Freezing it
  // here is what makes a later divergence detectable at all.
  //
  // NO FIELD NAME REACHES SQL. The row is fetched whole and indexed in JS, so
  // there is no interpolation to audit and nothing that could become injectable
  // if validateOverride() were ever refactored. Membership is re-asserted right
  // here rather than relied on from another module twenty lines up -- this line
  // has to be safe on its own reading.
  if (!OVERRIDABLE_FIELDS.includes(b.fieldName)) {
    return res.status(400).json({ error: `"${b.fieldName}" is not an overridable payroll field.` });
  }
  const line = (await pool.query(
    `SELECT * FROM payroll_lines WHERE "periodId" = $1 AND "employeeId" = $2`,
    [period.id, b.employeeId]
  )).rows[0];
  if (!line) {
    return res.status(404).json({
      error: "That employee has no payslip line in this period. Compute the period first.",
    });
  }
  const computedValue = Number(line[b.fieldName] ?? 0);

  const prior = (await pool.query(
    `SELECT id, "overrideValue", reason FROM payroll_line_overrides
      WHERE "periodId" = $1 AND "employeeId" = $2 AND "fieldName" = $3`,
    [period.id, b.employeeId, b.fieldName]
  )).rows[0];

  const row = (await pool.query(
    `INSERT INTO payroll_line_overrides
       ("periodId","employeeId","employeeNo","employeeName","fieldName","fieldClass",
        "computedValue","overrideValue",reason,"reasonCategory","createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ("periodId","employeeId","fieldName") DO UPDATE
        SET "overrideValue" = EXCLUDED."overrideValue",
            reason = EXCLUDED.reason,
            "reasonCategory" = EXCLUDED."reasonCategory",
            "computedValue" = EXCLUDED."computedValue",
            "fieldClass" = EXCLUDED."fieldClass",
            status = 'active', "staleComputedValue" = NULL, "staleDetectedAt" = NULL,
            "reconfirmedBy" = NULL, "reconfirmedAt" = NULL,
            "createdBy" = EXCLUDED."createdBy", "createdAt" = now()
     RETURNING *`,
    [period.id, b.employeeId, line.employeeNo, line.employeeName, b.fieldName,
      v.fieldClass, computedValue, v.value, v.reason, v.reasonCategory,
      req.user.username]
  )).rows[0];

  // A correction to a REOPENED paid period gets its own action name, so a change
  // to disbursed money is never mistaken for an ordinary draft edit when the
  // log is read back.
  const act = (name) => (editable.postIssue ? `${name}_post_issue` : name);
  await logPayrollAudit(req, period.id, b.employeeId,
    act(prior ? "payroll_override_updated" : "payroll_override_set"),
    prior
      ? `${line.employeeName}: ${b.fieldName} override ${prior.overrideValue} -> ${v.value} `
        + `(engine computes ${computedValue}). Reason was "${prior.reason}", now "${v.reason}".`
      : `${line.employeeName}: ${b.fieldName} overridden ${computedValue} -> ${v.value} `
        + `[${v.fieldClass}]${v.reasonCategory ? " " + v.reasonCategory : ""}. Reason: "${v.reason}".`);

  res.status(prior ? 200 : 201).json({
    override: row,
    // Nothing is repriced by recording an override: the engine applies it on the
    // next compute, exactly as billing figures only move when a draft period is
    // recomputed.
    note: "Not reflected on the payslip until this period is recomputed.",
  });
});

// Accept the new computed base a recompute produced, keeping the override.
router.patch("/overrides/:id/reconfirm", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT o.*, pp.status AS "periodStatus", pp."reopenedAt" FROM payroll_line_overrides o
       JOIN payroll_periods pp ON pp.id = o."periodId" WHERE o.id = $1`, [req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Override not found." });
  if (!mayOverride(req, row.fieldName)) {
    return res.status(403).json({ error: overrideDenied(row.fieldName) });
  }
  if (row.periodStatus === "Paid" && !row.reopenedAt) {
    return res.status(400).json({
      error: "A paid payroll period is locked. Reopen it first if it must be corrected.",
      code: "period_locked",
    });
  }
  if (row.status !== "stale") {
    return res.status(400).json({ error: "This override is not flagged; there is nothing to re-confirm." });
  }
  const updated = (await pool.query(
    `UPDATE payroll_line_overrides
        SET "computedValue" = "staleComputedValue", status = 'active',
            "staleComputedValue" = NULL, "staleDetectedAt" = NULL,
            "reconfirmedBy" = $1, "reconfirmedAt" = now()
      WHERE id = $2 RETURNING *`, [req.user.username, row.id]
  )).rows[0];
  await logPayrollAudit(req, row.periodId, row.employeeId, "payroll_override_reconfirmed",
    `${row.employeeName}: ${row.fieldName} override of ${row.overrideValue} re-confirmed against `
    + `the engine's new figure ${row.staleComputedValue} (was taken against ${row.computedValue}).`);
  res.json({ override: updated });
});

// Remove an override; the computed value takes effect on the next compute.
router.delete("/overrides/:id", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT o.*, pp.status AS "periodStatus", pp."reopenedAt" FROM payroll_line_overrides o
       JOIN payroll_periods pp ON pp.id = o."periodId" WHERE o.id = $1`, [req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Override not found." });
  if (!mayOverride(req, row.fieldName)) {
    return res.status(403).json({ error: overrideDenied(row.fieldName) });
  }
  if (row.periodStatus === "Paid" && !row.reopenedAt) {
    return res.status(400).json({
      error: "A paid payroll period is locked. Reopen it first if it must be corrected.",
      code: "period_locked",
    });
  }

  const why = String((req.body || {}).reason || "").trim();
  if (why.length < 10) {
    return res.status(400).json({
      error: "Removing an override needs a reason of at least 10 characters, so the record "
        + "says why the correction was withdrawn.",
    });
  }
  await pool.query(`DELETE FROM payroll_line_overrides WHERE id = $1`, [row.id]);
  // The row is gone, so the audit entry is now the ONLY place this correction
  // and its reason exist. It carries the full particulars for that reason.
  await logPayrollAudit(req, row.periodId, row.employeeId, "payroll_override_removed",
    `${row.employeeName}: ${row.fieldName} override REMOVED. It held ${row.overrideValue} `
    + `against a computed ${row.computedValue} [${row.fieldClass}`
    + `${row.reasonCategory ? ", " + row.reasonCategory : ""}], set by ${row.createdBy} `
    + `because "${row.reason}". Withdrawn because: "${why}". The computed value applies on the `
    + "next recompute.");
  res.json({ ok: true, note: "The computed value applies once this period is recomputed." });
});

// ---- One-off line components (earnings/deductions added to a single payslip) ----

router.post("/lines/:id/components", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const line = (await pool.query(
    `SELECT pl.id, pp.status "periodStatus" FROM payroll_lines pl
     JOIN payroll_periods pp ON pp.id = pl."periodId" WHERE pl.id = $1`, [req.params.id]
  )).rows[0];
  if (!line) return res.status(404).json({ error: "Payslip line not found." });
  if (line.periodStatus === "Paid") return res.status(400).json({ error: "A paid payroll period is locked." });

  const b = req.body || {};
  const comp = b.componentId ? (await pool.query(`SELECT * FROM payroll_components WHERE id = $1`, [b.componentId])).rows[0] : null;
  if (!comp) return res.status(400).json({ error: "Please choose a pay component." });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Please enter a valid amount." });

  const { rows } = await pool.query(
    `INSERT INTO payroll_line_components ("lineId","componentId",name,kind,taxable,auto,amount,note,"createdBy")
     VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8) RETURNING *`,
    [line.id, comp.id, comp.name, comp.kind, comp.taxable, amount, (b.note || "").trim(), req.user.username]
  );
  res.status(201).json(rows[0]);
});

// Per-day audit trail behind one payslip line — what each day was classified
// as and how it priced. Drives the drill-down in PayrollPeriodDetail.
router.get("/lines/:id/days", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", "dayType", "holidayName",
            "isRestDay", worked, "regularMinutes", "otMinutes", "nightMinutes", "nightOtMinutes",
            "basePay", "otPay", "nightDiffPay", "holidayPremium"
     FROM payroll_line_days WHERE "lineId" = $1 ORDER BY "dutyDate"`, [req.params.id]
  );
  res.json(rows);
});

router.get("/lines/:id/components", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM payroll_line_components WHERE "lineId" = $1 ORDER BY kind, name`, [req.params.id]
  );
  res.json(rows);
});

router.delete("/line-components/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const row = (await pool.query(
    `SELECT plc.id, pp.status "periodStatus" FROM payroll_line_components plc
     JOIN payroll_lines pl ON pl.id = plc."lineId"
     JOIN payroll_periods pp ON pp.id = pl."periodId" WHERE plc.id = $1`, [req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Line component not found." });
  if (row.periodStatus === "Paid") return res.status(400).json({ error: "A paid payroll period is locked." });
  await pool.query(`DELETE FROM payroll_line_components WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Pay components catalog (surfaced in Manage Lists) ----------------------

router.get("/components", requireAuth, async (req, res) => {
  const { kind, active } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (kind) { clauses.push(`kind = $${i++}`); vals.push(kind); }
  if (active !== undefined) { clauses.push(`active = $${i++}`); vals.push(active === "true"); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM payroll_components ${where} ORDER BY kind, category, name`, vals);
  res.json(rows);
});

router.post("/components", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: "Name is required." });
  if (!["Earning", "Deduction"].includes(b.kind)) return res.status(400).json({ error: "Kind must be Earning or Deduction." });
  const category = ["Allowance", "Incentive", "Bonus", "Benefit", "Loan", "Government", "Other"].includes(b.category) ? b.category : "Other";
  const frequency = ["Per Period", "Monthly (1st cutoff)", "One-time", "Annual"].includes(b.frequency) ? b.frequency : "Per Period";
  try {
    const { rows } = await pool.query(
      `INSERT INTO payroll_components (name, kind, category, taxable, frequency, "defaultAmount", active, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.name.trim(), b.kind, category, !!b.taxable, frequency, Number(b.defaultAmount) || 0, b.active !== false, req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "A pay component with that name already exists." });
    throw e;
  }
});

router.patch("/components/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM payroll_components WHERE id = $1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Pay component not found." });
  const b = req.body || {};
  const fields = { name: "name", category: "category", taxable: "taxable", frequency: "frequency", defaultAmount: '"defaultAmount"', active: "active" };
  const set = []; const vals = []; let i = 1;
  for (const k of Object.keys(fields)) {
    if (b[k] !== undefined) { set.push(`${fields[k]} = $${i++}`); vals.push(k === "name" ? String(b[k]).trim() : b[k]); }
  }
  if (set.length === 0) return res.json(existing);
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE payroll_components SET ${set.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  res.json(rows[0]);
});

// ---- Holiday calendar (surfaced in Manage Lists) ---------------------------
// "sites" is the local-holiday axis: empty/NULL = nationwide, populated = only
// guards posted at those sites. Type (Regular vs Special Non-Working) is a
// separate axis and drives the pay multiplier.

router.get("/holidays", requireAuth, async (req, res) => {
  const { year } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (year) { clauses.push(`EXTRACT(YEAR FROM date) = $${i++}`); vals.push(Number(year)); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, to_char(date,'YYYY-MM-DD') AS date, name, type, sites, active, "createdBy"
     FROM payroll_holidays ${where} ORDER BY date`, vals
  );
  res.json(rows);
});

router.post("/holidays", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.date) return res.status(400).json({ error: "A date is required." });
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: "A holiday name is required." });
  if (!HOLIDAY_TYPES.includes(b.type)) return res.status(400).json({ error: "Type must be Regular or Special Non-Working." });
  const sites = Array.isArray(b.sites) && b.sites.length ? b.sites : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO payroll_holidays (date, name, type, sites, active, "createdBy")
       VALUES ($1::date,$2,$3,$4,$5,$6) RETURNING id`,
      [b.date, b.name.trim(), b.type, sites, b.active !== false, req.user.username]
    );
    res.status(201).json({ id: rows[0].id, ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That holiday already exists on that date." });
    throw e;
  }
});

router.patch("/holidays/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM payroll_holidays WHERE id = $1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Holiday not found." });
  const b = req.body || {};
  if (b.type !== undefined && !HOLIDAY_TYPES.includes(b.type)) {
    return res.status(400).json({ error: "Type must be Regular or Special Non-Working." });
  }
  const set = []; const vals = []; let i = 1;
  if (b.date !== undefined) { set.push(`date = $${i++}::date`); vals.push(b.date); }
  if (b.name !== undefined) { set.push(`name = $${i++}`); vals.push(String(b.name).trim()); }
  if (b.type !== undefined) { set.push(`type = $${i++}`); vals.push(b.type); }
  if (b.sites !== undefined) { set.push(`sites = $${i++}`); vals.push(Array.isArray(b.sites) && b.sites.length ? b.sites : null); }
  if (b.active !== undefined) { set.push(`active = $${i++}`); vals.push(!!b.active); }
  if (set.length === 0) return res.json(existing);
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE payroll_holidays SET ${set.join(", ")} WHERE id = $${i}
     RETURNING id, to_char(date,'YYYY-MM-DD') AS date, name, type, sites, active`, vals
  );
  res.json(rows[0]);
});

// Safe to hard-delete: holidays are matched by date at compute time and never
// referenced by FK, and payroll_line_days snapshots the holiday NAME onto each
// computed day so historical payslips keep their explanation.
router.delete("/holidays/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query(`DELETE FROM payroll_holidays WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Recurring per-employee assignments (allowances / loans) ----------------

router.get("/employee-components/:employeeId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ec.*, c.name, c.kind, c.category, c.taxable, c.frequency
     FROM payroll_employee_components ec
     JOIN payroll_components c ON c.id = ec."componentId"
     WHERE ec."employeeId" = $1 ORDER BY c.name`, [req.params.employeeId]
  );
  res.json(rows);
});

router.put("/employee-components/:employeeId/:componentId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "Amount must be a non-negative number." });
  const totalOwed = b.totalOwed !== undefined && b.totalOwed !== null && b.totalOwed !== "" ? Number(b.totalOwed) : null;
  const balanceRemaining = b.balanceRemaining !== undefined && b.balanceRemaining !== null && b.balanceRemaining !== ""
    ? Number(b.balanceRemaining) : totalOwed;
  const active = b.active !== false;

  const { rows } = await pool.query(
    `INSERT INTO payroll_employee_components ("employeeId","componentId",amount,"totalOwed","balanceRemaining",active,note,"createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT ("employeeId","componentId") DO UPDATE SET
       amount = EXCLUDED.amount, "totalOwed" = EXCLUDED."totalOwed",
       "balanceRemaining" = EXCLUDED."balanceRemaining", active = EXCLUDED.active, note = EXCLUDED.note
     RETURNING *`,
    [req.params.employeeId, req.params.componentId, amount, totalOwed, balanceRemaining, active, (b.note || "").trim(), req.user.username]
  );
  res.json(rows[0]);
});

router.delete("/employee-components/:employeeId/:componentId", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query(
    `DELETE FROM payroll_employee_components WHERE "employeeId" = $1 AND "componentId" = $2`,
    [req.params.employeeId, req.params.componentId]
  );
  res.json({ ok: true });
});

// ---- Info-only benefits (HMO, insurance) -----------------------------------

router.get("/employee-benefits/:employeeId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM payroll_employee_benefits WHERE "employeeId" = $1 ORDER BY "effectiveDate" DESC`, [req.params.employeeId]
  );
  res.json(rows);
});

router.post("/employee-benefits", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !b.benefitName || !b.benefitName.trim()) return res.status(400).json({ error: "Employee and benefit name are required." });
  const { rows } = await pool.query(
    `INSERT INTO payroll_employee_benefits ("employeeId","benefitName",provider,"effectiveDate","expiryDate",notes,"createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.employeeId, b.benefitName.trim(), b.provider || "", b.effectiveDate || null, b.expiryDate || null, b.notes || "", req.user.username]
  );
  res.status(201).json(rows[0]);
});

router.delete("/employee-benefits/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  await pool.query(`DELETE FROM payroll_employee_benefits WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ---- 13th month pay ---------------------------------------------------------

router.get("/thirteenth-month", requireAuth, async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { rows } = await pool.query(`SELECT * FROM thirteenth_month_pay WHERE year = $1 ORDER BY "employeeName"`, [year]);
  res.json(rows);
});

router.post("/thirteenth-month/compute", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const year = parseInt(req.body?.year, 10);
  if (!year) return res.status(400).json({ error: "Year is required." });
  const rows = (await pool.query(
    `SELECT pl."employeeId", pl."employeeNo", pl."employeeName", SUM(pl."regularPay")::numeric total
     FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl."periodId"
     WHERE EXTRACT(YEAR FROM pp."periodStart") = $1 AND pl."employeeId" IS NOT NULL
     GROUP BY pl."employeeId", pl."employeeNo", pl."employeeName"`, [year]
  )).rows;
  for (const r of rows) {
    const amount = computeThirteenthMonth(r.total);
    await pool.query(
      `INSERT INTO thirteenth_month_pay (year,"employeeId","employeeNo","employeeName","totalBasicEarned",amount,status,"computedBy","computedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7,now())
       ON CONFLICT (year,"employeeId") DO UPDATE SET
         "totalBasicEarned" = EXCLUDED."totalBasicEarned", amount = EXCLUDED.amount,
         "computedBy" = EXCLUDED."computedBy", "computedAt" = now()
       WHERE thirteenth_month_pay.status = 'Draft'`,
      [year, r.employeeId, r.employeeNo, r.employeeName, r.total, amount, req.user.username]
    );
  }
  res.json({ ok: true, count: rows.length });
});

router.patch("/thirteenth-month/:id/approve", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE thirteenth_month_pay SET status = 'Approved', "approvedBy" = $1, "approvedAt" = now() WHERE id = $2 AND status = 'Draft'`,
    [req.user.username, req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only a draft 13th-month record can be approved." });
  res.json({ ok: true });
});

router.patch("/thirteenth-month/:id/mark-paid", requireAuth, requireRole("Admin"), async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE thirteenth_month_pay SET status = 'Paid', "paidAt" = now() WHERE id = $1 AND status = 'Approved'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only an approved 13th-month record can be marked paid." });
  res.json({ ok: true });
});

// ---- PDFs -------------------------------------------------------------------

// Money for PDFs. Lives in ../lib/pdfMoney.js so the Statement of Account
// formats amounts identically — and so the "never ₱ in a PDF" rule is stated
// in exactly one place.

async function brandingBlock() {
  const settings = (await pool.query(`SELECT "companyName", "logoData" FROM app_settings WHERE id = 1`)).rows[0] || {};
  return {
    companyName: (settings.companyName || "").toUpperCase(),
    logoBuf: settings.logoData || null,
  };
}
function drawHeader(doc, title, subtitle, companyName, logoBuf) {
  const NAVY = "#0B2545", GOLD = "#C9A227";
  doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
  const textX = logoBuf ? 96 : 40;
  if (logoBuf) { try { doc.image(logoBuf, 40, 20, { fit: [42, 42] }); } catch (e) { /* skip */ } }
  doc.fillColor(GOLD).fontSize(10).text(companyName, textX, 24, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(16).text(title, textX, 40);
  doc.fillColor("#C9D3E3").fontSize(9).text(subtitle, textX, 62);
  doc.y = 100;
}

router.get("/periods/:id/register.pdf", requireAuth, async (req, res) => {
  const period = (await pool.query(
    `SELECT id, to_char("periodStart",'YYYY-MM-DD') AS "periodStart", to_char("periodEnd",'YYYY-MM-DD') AS "periodEnd", status
     FROM payroll_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  const lines = await withShiftKinds(
    (await pool.query(`SELECT * FROM payroll_lines WHERE "periodId" = $1 ORDER BY "employeeName"`, [period.id])).rows,
    period.periodStart, period.periodEnd
  );
  const otLabel = (label, minutes, field) =>
    (overridden.has(field) ? `${label} (adjusted)` : `${label} (${minutes} min)`);
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="payroll-register-${period.periodStart}_${period.periodEnd}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, "Payroll Register", `Period covered: ${period.periodStart} to ${period.periodEnd}  ·  Status: ${period.status}  ·  Generated ${new Date().toLocaleDateString()}`, companyName, logoBuf);

  const totalGross = lines.reduce((s, l) => s + Number(l.grossPay), 0);
  const totalNet = lines.reduce((s, l) => s + Number(l.netPay), 0);
  doc.fillColor("#0B2545").fontSize(10).text(`Employees: ${lines.length}    Total Gross: ${pesoPdf(totalGross)}    Total Net: ${pesoPdf(totalNet)}`, 40, 100);
  doc.fillColor("#5B6B85").fontSize(8).text("Shift:  D = Day    N = Night    SD = Straight Duty    B = Broken    — = no rostered shift", 40, 116);
  doc.y = 132;

  // Widths must total <= 762pt (A4 landscape 842 less two 40pt margins), or the
  // right-hand columns silently run off the page. Splitting OT into two columns
  // pushed this to 974pt, so every width is re-balanced to fit exactly.
  //
  // Re-balanced again when the Shift column was added. The money columns were
  // measured against their widest realistic value at fontSize 8 and were
  // carrying 66pt of slack between them; that slack paid for Shift (32pt) and
  // for widening the two columns that were actually too narrow:
  //   Name 82 -> 92, so "Mark Roger A. Cardona" fits on ONE line (it needed 89)
  //   Site 38 -> 62, taking "Swine Saluyot Egg Store" from FOUR lines to two
  // Site was the worst offender by far and the main cause of the row overlap.
  const cols = [
    { k: "employeeNo", label: "Emp No", w: 43 }, { k: "employeeName", label: "Name", w: 92 },
    { k: "site", label: "Site", w: 62 }, { k: "shiftKinds", label: "Shift", w: 32 },
    { k: "presentDays", label: "Days", w: 24 },
    { k: "regularPay", label: "Basic Pay", w: 45 },
    { k: "nightDiffPay", label: "Night Diff", w: 40 },
    { k: "builtinOtPay", label: "Built-in OT", w: 44 }, { k: "excessOtPay", label: "Excess OT", w: 46 },
    { k: "holidayPay", label: "Holiday", w: 40 },
    { k: "grossPay", label: "Gross", w: 45 }, { k: "sssEe", label: "SSS", w: 36 },
    { k: "philhealthEe", label: "PhilHealth", w: 43 }, { k: "pagibigEe", label: "Pag-IBIG", w: 39 },
    { k: "withholdingTax", label: "Tax", w: 40 }, { k: "otherDeductions", label: "Other Ded.", w: 46 },
    { k: "netPay", label: "Net Pay", w: 45 },
  ];
  const TABLE_W = cols.reduce((s, c) => s + c.w, 0);
  const HEAD_LABELS = cols.map((c) => c.label);
  const ROW_PAD = 6;          // 3pt above and below the text in every cell
  const BOTTOM = doc.page.height - 40;

  let y = doc.y;

  // Row height follows the TALLEST cell in the row rather than being fixed.
  //
  // It was a flat 15pt while a wrapped cell is 18.5pt for two lines and was
  // 37pt for "Swine Saluyot Egg Store" at the old Site width — so a long name
  // or site printed straight over the row beneath it, and a four-line site over
  // the next two. Widening the columns above removes most of the wrapping;
  // measuring the row removes the overlap even when a value still wraps, which
  // a bigger fixed height would not: a three-line value would simply overflow
  // the new number instead of the old one.
  function measure(strs, size) {
    doc.fontSize(size);
    let h = 0;
    cols.forEach((c, i) => { h = Math.max(h, doc.heightOfString(strs[i], { width: c.w - 4 })); });
    return Math.ceil(h) + ROW_PAD;
  }
  function drawRow(vals, header) {
    const size = header ? 8.5 : 8;
    const strs = cols.map((c, i) => String(vals[i] ?? ""));
    const h = measure(strs, size);
    // Break BEFORE drawing, using this row's real height, so a tall row is never
    // split across the fold — and repeat the header, which the fixed-height
    // version never did.
    if (!header && y + h > BOTTOM) {
      doc.addPage({ layout: "landscape", margin: 40 });
      y = 40;
      drawRow(HEAD_LABELS, true);
    }
    if (header) doc.rect(40, y, TABLE_W, h).fill("#EEF2F7");
    let x = 40;
    cols.forEach((c, i) => {
      doc.fillColor(header ? "#0B2545" : "#1a1a1a").fontSize(size)
        .text(strs[i], x + 2, y + 3, { width: c.w - 4 });
      x += c.w;
    });
    y += h;
  }
  drawRow(HEAD_LABELS, true);
  const money = amountPdf;
  for (const l of lines) {
    drawRow([
      l.employeeNo, l.employeeName, l.site, shiftCell(l), l.presentDays,
      money(l.regularPay), money(l.nightDiffPay),
      money(l.builtinOtPay), money(l.excessOtPay),
      money(Number(l.holidayPremiumPay) + Number(l.holidayUnworkedPay)),
      money(l.grossPay), money(l.sssEe),
      money(l.philhealthEe), money(l.pagibigEe), money(l.withholdingTax), money(l.otherDeductions), money(l.netPay),
    ]);
  }
  stampAuthorFooter(doc, companyName);
  doc.end();
});

router.get("/lines/:id/payslip.pdf", requireAuth, async (req, res) => {
  const line = (await pool.query(
    `SELECT pl.*, to_char(pp."periodStart",'YYYY-MM-DD') AS "periodStart", to_char(pp."periodEnd",'YYYY-MM-DD') AS "periodEnd",
            to_char(pp."payDate",'YYYY-MM-DD') AS "payDate"
     FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl."periodId" WHERE pl.id = $1`, [req.params.id]
  )).rows[0];
  if (!line) return res.status(404).json({ error: "Payslip line not found." });
  const components = (await pool.query(`SELECT * FROM payroll_line_components WHERE "lineId" = $1 ORDER BY kind, name`, [line.id])).rows;
  // Which figures on this line were CORRECTED by hand. Used only to suppress a
  // minutes claim the peso figure no longer matches -- see the OT rows below.
  const overridden = new Set((await pool.query(
    `SELECT "fieldName" FROM payroll_line_overrides WHERE "periodId" = $1 AND "employeeId" = $2`,
    [line.periodId, line.employeeId]
  )).rows.map((r) => r.fieldName));
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="payslip-${line.employeeNo || line.id}-${line.periodStart}_${line.periodEnd}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, "Payslip", `Period covered: ${line.periodStart} to ${line.periodEnd}${line.payDate ? "  ·  Pay date " + line.payDate : ""}`, companyName, logoBuf);

  const money = pesoPdf;
  doc.fillColor("#0B2545").fontSize(11).text(`${line.employeeName}`, 40, 100);
  doc.fillColor("#5B6B85").fontSize(9).text(`${line.employeeNo || "—"}  ·  ${line.position || ""}  ·  ${line.site || ""}`, 40, 116);
  doc.fillColor("#5B6B85").fontSize(9).text(`Pay type: ${line.payType}  ·  Rate: ${money(line.rateUsed)}`, 40, 130);

  let y = 156;
  function row(label, value, opts = {}) {
    doc.fillColor(opts.bold ? "#0B2545" : "#1a1a1a").fontSize(opts.bold ? 10 : 9.5)
      .text(label, 40, y, { width: 320, continued: false });
    doc.text(value, 380, y, { width: 150, align: "right" });
    y += opts.bold ? 18 : 15;
  }
  doc.fillColor("#0B2545").fontSize(11).text("Earnings", 40, y); y += 18;
  row(`Basic pay — present days (${line.presentDays})`, money(line.regularPay));
  if (Number(line.paidLeaveDays) > 0) row(`Paid leave days (${line.paidLeaveDays})`, "");
  if (Number(line.builtinOtMinutes) > 0 || Number(line.builtinOtPay) > 0) {
    // The minutes are DROPPED when the pay has been overridden. OT pay is
    // normally derived from those minutes, so a hand-corrected peso figure no
    // longer reconciles with them -- and a payslip that prints "240 min" beside
    // an amount that is not 240 minutes' pay is asserting something untrue to
    // the guard holding it. The peso figure prints; the minutes claim does not.
    // Why it was corrected lives in the override's reason and the audit log,
    // which is where it belongs, not on the payslip face.
    row(otLabel("Built-in OT", line.builtinOtMinutes, "builtinOtPay"), money(line.builtinOtPay));
  }
  if (Number(line.approvedOtMinutes) > 0 || Number(line.excessOtPay) > 0) {
    row(otLabel("Excess OT — approved", line.approvedOtMinutes, "excessOtPay"), money(line.excessOtPay));
  }
  if (Number(line.nightDiffMinutes) > 0 || Number(line.nightDiffPay) > 0) {
    row(`Night differential (${line.nightDiffMinutes} min)`, money(line.nightDiffPay));
  }
  if (Number(line.holidayPremiumPay) > 0) row("Holiday premium", money(line.holidayPremiumPay));
  if (Number(line.holidayUnworkedPay) > 0) row("Holiday pay (unworked)", money(line.holidayUnworkedPay));
  for (const c of components.filter((x) => x.kind === "Earning")) row(c.name, money(c.amount));
  row("Late/undertime deduction", `-${money(line.lateUndertimeDeduction)}`);
  y += 4;
  row("Gross Pay", money(line.grossPay), { bold: true });

  y += 10;
  doc.fillColor("#0B2545").fontSize(11).text("Deductions", 40, y); y += 18;
  row("SSS", money(line.sssEe));
  row("PhilHealth", money(line.philhealthEe));
  row("Pag-IBIG", money(line.pagibigEe));
  row("Withholding Tax", money(line.withholdingTax));
  for (const c of components.filter((x) => x.kind === "Deduction")) row(c.name, money(c.amount));
  if (Number(line.otherDeductions) > 0 && components.filter((x) => x.kind === "Deduction").length === 0) {
    row(line.otherDeductionsNote || "Other deductions", money(line.otherDeductions));
  }
  if (Number(line.arrearsRecovered) > 0) row("Arrears recovered (prior period)", money(line.arrearsRecovered));

  y += 14;
  doc.rect(40, y - 4, 490, 24).fill("#0B2545");
  doc.fillColor("#fff").fontSize(12).text("Net Pay", 50, y + 2);
  // Same x and width as the itemised rows above (380 / 150) so the figure
  // lines up with the column instead of sitting 10pt short of it.
  doc.text(money(line.netPay), 380, y + 2, { width: 150, align: "right" });
  y += 30;

  // Explain any deferral, otherwise a capped payslip silently looks like the
  // contributions were never assessed.
  if (Number(line.deductionsDeferred) > 0) {
    doc.fillColor("#8a6d1f").fontSize(9).text(
      `Deductions of ${money(line.deductionsDeferred)} exceeded this period's pay and were carried forward `
      + `to the next payroll period. Outstanding balance after this payslip: ${money(Number(line.arrearsOpening) - Number(line.arrearsRecovered) + Number(line.deductionsDeferred))}.`,
      40, y, { width: 490 }
    );
  }

  stampAuthorFooter(doc, companyName);

  doc.end();
});

router.get("/thirteenth-month/:id/payslip.pdf", requireAuth, async (req, res) => {
  const rec = (await pool.query(`SELECT * FROM thirteenth_month_pay WHERE id = $1`, [req.params.id])).rows[0];
  if (!rec) return res.status(404).json({ error: "13th-month record not found." });
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="13th-month-${rec.employeeNo || rec.id}-${rec.year}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, "13th Month Pay", `Year ${rec.year}  ·  Status: ${rec.status}`, companyName, logoBuf);
  const money = pesoPdf;
  doc.fillColor("#0B2545").fontSize(11).text(rec.employeeName, 40, 100);
  doc.fillColor("#5B6B85").fontSize(9).text(rec.employeeNo || "—", 40, 116);
  doc.fillColor("#1a1a1a").fontSize(10).text(`Total basic salary earned in ${rec.year}: ${money(rec.totalBasicEarned)}`, 40, 150);
  doc.rect(40, 175, 300, 26).fill("#0B2545");
  doc.fillColor("#fff").fontSize(12).text(`13th Month Pay: ${money(rec.amount)}`, 50, 183);
  stampAuthorFooter(doc, companyName);
  doc.end();
});

module.exports = router;
