const express = require("express");
const PDFDocument = require("pdfkit");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { isGuardPosition } = require("../lib/leaveCredits");
const { addDays: phAddDays } = require("../lib/phTime");
const { computeReport } = require("./attendance-reports");
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
  res.json({ ...period, lines });
});

router.delete("/periods/:id", requireAuth, requireRole(), async (req, res) => {
  if (req.user.role !== "Admin") return res.status(403).json({ error: "Only an Admin can delete a payroll period." });
  const period = (await pool.query(`SELECT status FROM payroll_periods WHERE id = $1`, [req.params.id])).rows[0];
  if (!period) return res.status(404).json({ error: "Payroll period not found." });
  if (period.status === "Paid") return res.status(400).json({ error: "A paid payroll period can't be deleted." });
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
        periodStart: period.periodStart, periodEnd: period.periodEnd,
        holidays,
        openingArrears: arrearsByEmployee.get(emp.id) || 0,
      });

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

  await pool.query(`UPDATE payroll_periods SET status = 'Computed', "updatedAt" = now() WHERE id = $1`, [period.id]);
  res.json({ ok: true, count });
});

router.patch("/periods/:id/approve", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
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
router.patch("/lines/:id", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const line = (await pool.query(
    `SELECT pl.*, pp.status "periodStatus" FROM payroll_lines pl
     JOIN payroll_periods pp ON pp.id = pl."periodId" WHERE pl.id = $1`, [req.params.id]
  )).rows[0];
  if (!line) return res.status(404).json({ error: "Payslip line not found." });
  if (line.periodStatus === "Paid") return res.status(400).json({ error: "A paid payroll period is locked." });

  const b = req.body || {};
  const otherDeductions = b.otherDeductions !== undefined ? Number(b.otherDeductions) : Number(line.otherDeductions);
  if (!Number.isFinite(otherDeductions) || otherDeductions < 0) return res.status(400).json({ error: "Other deductions must be a non-negative number." });
  const note = b.otherDeductionsNote !== undefined ? String(b.otherDeductionsNote).trim() : line.otherDeductionsNote;

  const netPay = Number(line.grossPay) - Number(line.sssEe) - Number(line.philhealthEe) - Number(line.pagibigEe)
    - Number(line.withholdingTax) - otherDeductions;

  await pool.query(
    `UPDATE payroll_lines SET "otherDeductions" = $1, "otherDeductionsNote" = $2, "netPay" = $3 WHERE id = $4`,
    [otherDeductions, note, netPay, req.params.id]
  );
  res.json({ ok: true, otherDeductions, otherDeductionsNote: note, netPay });
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
    companyName: (settings.companyName || "Brookside Farms Corporation").toUpperCase(),
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
  const lines = (await pool.query(`SELECT * FROM payroll_lines WHERE "periodId" = $1 ORDER BY "employeeName"`, [period.id])).rows;
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="payroll-register-${period.periodStart}_${period.periodEnd}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, "Payroll Register", `Period covered: ${period.periodStart} to ${period.periodEnd}  ·  Status: ${period.status}  ·  Generated ${new Date().toLocaleDateString()}`, companyName, logoBuf);

  const totalGross = lines.reduce((s, l) => s + Number(l.grossPay), 0);
  const totalNet = lines.reduce((s, l) => s + Number(l.netPay), 0);
  doc.fillColor("#0B2545").fontSize(10).text(`Employees: ${lines.length}    Total Gross: ${pesoPdf(totalGross)}    Total Net: ${pesoPdf(totalNet)}`, 40, 100);
  doc.moveDown(1);

  // Widths must total <= 762pt (A4 landscape 842 less two 40pt margins), or the
  // right-hand columns silently run off the page. Splitting OT into two columns
  // pushed this to 974pt, so every width is re-balanced to fit exactly.
  const cols = [
    { k: "employeeNo", label: "Emp No", w: 48 }, { k: "employeeName", label: "Name", w: 82 },
    { k: "site", label: "Site", w: 38 }, { k: "presentDays", label: "Days", w: 26 },
    { k: "regularPay", label: "Basic Pay", w: 52 },
    { k: "nightDiffPay", label: "Night Diff", w: 50 },
    { k: "builtinOtPay", label: "Built-in OT", w: 50 }, { k: "excessOtPay", label: "Excess OT", w: 48 },
    { k: "holidayPay", label: "Holiday", w: 42 },
    { k: "grossPay", label: "Gross", w: 52 }, { k: "sssEe", label: "SSS", w: 40 },
    { k: "philhealthEe", label: "PhilHealth", w: 50 }, { k: "pagibigEe", label: "Pag-IBIG", w: 44 },
    { k: "withholdingTax", label: "Tax", w: 40 }, { k: "otherDeductions", label: "Other Ded.", w: 46 },
    { k: "netPay", label: "Net Pay", w: 54 },
  ];
  let y = doc.y;
  function drawRow(vals, header) {
    let x = 40;
    if (header) doc.rect(40, y - 2, cols.reduce((s, c) => s + c.w, 0), 16).fill("#EEF2F7");
    cols.forEach((c, i) => {
      doc.fillColor(header ? "#0B2545" : "#1a1a1a").fontSize(header ? 8.5 : 8)
        .text(String(vals[i] ?? ""), x + 2, y + 1, { width: c.w - 4, ellipsis: true });
      x += c.w;
    });
    y += 15;
    if (y > doc.page.height - 40) { doc.addPage({ layout: "landscape", margin: 40 }); y = 40; }
  }
  drawRow(cols.map((c) => c.label), true);
  const money = amountPdf;
  for (const l of lines) {
    drawRow([
      l.employeeNo, l.employeeName, l.site, l.presentDays,
      money(l.regularPay), money(l.nightDiffPay),
      money(l.builtinOtPay), money(l.excessOtPay),
      money(Number(l.holidayPremiumPay) + Number(l.holidayUnworkedPay)),
      money(l.grossPay), money(l.sssEe),
      money(l.philhealthEe), money(l.pagibigEe), money(l.withholdingTax), money(l.otherDeductions), money(l.netPay),
    ]);
  }
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
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ size: "A4", margin: 40 });
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
    row(`Built-in OT (${line.builtinOtMinutes} min)`, money(line.builtinOtPay));
  }
  if (Number(line.approvedOtMinutes) > 0 || Number(line.excessOtPay) > 0) {
    row(`Excess OT — approved (${line.approvedOtMinutes} min)`, money(line.excessOtPay));
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

  doc.end();
});

router.get("/thirteenth-month/:id/payslip.pdf", requireAuth, async (req, res) => {
  const rec = (await pool.query(`SELECT * FROM thirteenth_month_pay WHERE id = $1`, [req.params.id])).rows[0];
  if (!rec) return res.status(404).json({ error: "13th-month record not found." });
  const { companyName, logoBuf } = await brandingBlock();

  const doc = new PDFDocument({ size: "A4", margin: 40 });
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
  doc.end();
});

module.exports = router;
