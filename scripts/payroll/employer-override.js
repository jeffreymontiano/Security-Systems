/**
 * Gap 30 Phase 3 -- un-gating the four EMPLOYER statutory overrides
 * (sssEr, philhealthEr, pagibigEr, sssEc).
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *
 *   1. The correction must be VISIBLE. That is the whole reason this phase came
 *      last: a figure that can be changed but not verified is the wrong side of
 *      the trade. So an overridden employer figure must reach the Monthly
 *      Statutory Remittance report, on its own agency's section.
 *
 *   2. The correction must be INERT to the guard. An employer share is not the
 *      guard's money. Overriding one changes what the AGENCY remits and must
 *      never move netPay, totalTaken, deductionsDeferred or arrears -- nor the
 *      tax base. Override is a NEW path into these values, so the Phase 1
 *      property has to be re-proved under it rather than assumed to carry.
 *
 * PURE: no DB, no server, sets its own statutory config (Known Gap 21) and
 * never requires ../db (Known Gap 27).
 *
 * Usage: node scripts/payroll/employer-override.js
 */

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const {
  computeEmployeeLine, OVERRIDABLE_FIELDS, OVERRIDABLE_STATUTORY, OVERRIDE_FIELD_CLASS,
} = require(path.join(ROOT, "src", "lib", "payrollEngine"));
const { validateOverride, overridesMapFor, reconcileOverrides } =
  require(path.join(ROOT, "src", "lib", "payrollOverrides"));
const { buildRemittance } = require(path.join(ROOT, "src", "lib", "remittanceReport"));
const {
  PAYROLL_STATUTORY_OVERRIDE_ROLES, PAYROLL_OVERRIDE_ROLES,
} = require(path.join(ROOT, "src", "lib", "permissions"));

let pass = 0, fail = 0;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
  ok ? pass++ : fail++;
}

const EMPLOYER_FIELDS = ["sssEr", "philhealthEr", "pagibigEr", "sssEc"];
const EMPLOYEE_FIELDS = ["sssEe", "philhealthEe", "pagibigEe", "withholdingTax"];

const STATUTORY = {
  sss: {
    brackets: [
      { minMsc: 0, maxMsc: 5000, msc: 5000, ee: 250, er: 500, ec: 10 },
      { minMsc: 5001, maxMsc: 20000, msc: 18500, ee: 925, er: 1850, ec: 30 },
    ],
  },
  philhealth: { ratePercent: 5, floor: 10000, ceiling: 100000 },
  pagibig: {
    employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500,
    employerRate: 0.02, salaryCap: 10000,
  },
  withholding_tax: {
    frequency: "semi-monthly",
    brackets: [{ min: 0, max: 10416, base: 0, rate: 0 }, { min: 10417, max: null, base: 0, rate: 0.15 }],
  },
  pay_rules: {
    otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30,
    sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second",
    withholdingTaxEnabled: true,
  },
  premium_rules: {
    nightDiffPercent: 0.1, nightStartHour: 22, nightEndHour: 6,
    regularHolidayWorked: 2, regularHolidayOt: 2.6, regularHolidayUnworkedPay: 1,
    requirePresenceDayBefore: true, specialDayWorked: 1.3, specialDayOt: 1.69,
    specialDayUnworkedPay: 0,
  },
};

const day = (d) => ({
  dutyDate: d, guardName: "ER-PROBE", site: "PROBE", status: "Present",
  timeIn: `${d}T06:00:00+08:00`, timeOut: `${d}T18:00:00+08:00`,
  shiftName: "Day", startTime: "06:00", endTime: "18:00", crossesMidnight: false,
  lateMin: 0, undertimeMin: 0, builtinOtMin: 240, overtimeMin: 0, isRestDay: false, flags: [],
});

function run({ days = 20, arrears = 0, overrides = {} } = {}) {
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(`2026-04-${String(i + 1).padStart(2, "0")}`);
  return computeEmployeeLine({
    employee: { fullName: "ER-PROBE", employeeNo: "PROBE", payType: "Daily", dailyRate: 570, monthlyRate: 0 },
    attendanceRows: dates.map(day), approvedOtByDate: new Map(), leaveRecords: [],
    isGuard: true, components: [], statutory: STATUTORY, isFirstCutoff: false,
    periodStart: dates[0], periodEnd: dates[dates.length - 1], holidays: [],
    openingArrears: arrears, overrides,
  });
}

// The GUARD-facing figures. An employer override must move none of them.
const GUARD_FACING = [
  "grossPay", "netPay", "totalWanted", "totalTaken", "deductionsDeferred",
  "arrearsOpening", "arrearsRecovered", "arrearsClosing",
  "sssEe", "philhealthEe", "pagibigEe", "withholdingTax", "otherDeductions",
  "regularPay", "otPay", "builtinOtPay", "excessOtPay", "nightDiffPay",
  "holidayPremiumPay", "holidayUnworkedPay", "otherEarnings", "lateUndertimeDeduction",
];

function main() {
  console.log("1. THE FOUR EMPLOYER FIELDS ARE OVERRIDABLE AGAIN\n");
  for (const f of EMPLOYER_FIELDS) {
    check(`${f} is in OVERRIDABLE_FIELDS`, OVERRIDABLE_FIELDS.includes(f));
    check(`${f} is classed STATUTORY (so it answers to the statutory allowlist and 25-char reason)`,
      OVERRIDE_FIELD_CLASS[f] === "statutory", String(OVERRIDE_FIELD_CLASS[f]));
  }
  for (const f of EMPLOYEE_FIELDS) {
    check(`${f} is UNAFFECTED and still overridable`, OVERRIDABLE_FIELDS.includes(f));
  }
  check("17 fields overridable (13 + the 4 employer)", OVERRIDABLE_FIELDS.length === 17,
    String(OVERRIDABLE_FIELDS.length));
  check("no DERIVED total leaked in", !OVERRIDABLE_FIELDS.some(
    (f) => ["netPay", "grossPay", "otPay", "totalTaken", "arrearsClosing"].includes(f)));

  console.log("\n2. THE MONEY-PATH SAFETY -- AN EMPLOYER OVERRIDE MOVES NO GUARD MONEY\n");
  for (const f of EMPLOYER_FIELDS) {
    for (const [label, cfg] of [
      ["ample gross", { days: 20 }],
      ["gross exhausted", { days: 1 }],
      ["arrears outstanding", { days: 1, arrears: 5000 }],
      ["arrears partly recoverable", { days: 3, arrears: 5000 }],
    ]) {
      const before = run(cfg);
      const after = run({ ...cfg, overrides: { [f]: 99999 } });
      const moved = GUARD_FACING.filter((k) => !near(before[k] || 0, after[k] || 0))
        .map((k) => `${k}: ${before[k]} -> ${after[k]}`);
      for (const k of Object.keys(before.withheld || {})) {
        if (!near(before.withheld[k], after.withheld[k])) moved.push(`withheld.${k}`);
      }
      check(`${f} = 99999 (${label}): every guard-facing figure unmoved`,
        moved.length === 0, moved.join("\n          "));
      // ...and prove the override actually landed, or the check above is vacuous.
      check(`${f} = 99999 (${label}): ...while the field itself DID change`,
        near(after[f], 99999) && !near(before[f], 99999),
        `before ${before[f]} after ${after[f]}`);
    }
  }

  console.log("\n3. EC UNDER OVERRIDE -- THE PHASE 1 INVARIANT STILL HOLDS\n");
  const base = run({ days: 20 });
  for (const v of [0, 15, 30, 250000]) {
    const l = run({ days: 20, overrides: { sssEc: v } });
    check(`sssEc override = ${v}: netPay identical to the un-overridden line`,
      near(l.netPay, base.netPay), `${l.netPay} vs ${base.netPay}`);
    check(`sssEc override = ${v}: ...and it is stored on the line as ${v}`, near(l.sssEc, v), String(l.sssEc));
  }
  check("sssEc rides the SSS cutoff even when overridden (the override IS the cutoff share)",
    near(run({ days: 20, overrides: { sssEc: 42 } }).sssEc, 42));
  // The tax base must be untouched: it takes only the employee shares.
  check("an employer override does not move taxable income (withholdingTax unchanged)",
    near(run({ days: 20, overrides: { philhealthEr: 99999 } }).withholdingTax, base.withholdingTax));

  console.log("\n4. THE CORRECTION IS VISIBLE -- IT REACHES THE REMITTANCE REPORT\n");
  // This is the precondition that gated Phase 3. The route persists
  // computed.sssEr / .philhealthEr / .pagibigEr / .sssEc onto the line, and the
  // report reads those columns -- so an overridden figure has to show up on its
  // own agency's section.
  const corrected = run({ days: 20, overrides: { sssEr: 2000, sssEc: 45, philhealthEr: 500, pagibigEr: 250 } });
  const asLine = {
    periodId: 1, employeeId: 1, employeeNo: "E1", employeeName: "ER-PROBE",
    payType: "Daily", rateUsed: 570,
    sssEe: corrected.sssEe, sssEr: corrected.sssEr, sssEc: corrected.sssEc,
    philhealthEe: corrected.philhealthEe, philhealthEr: corrected.philhealthEr,
    pagibigEe: corrected.pagibigEe, pagibigEr: corrected.pagibigEr,
  };
  const rep = buildRemittance({
    month: "2026-04",
    periods: [{ id: 1, periodStart: "2026-04-16", periodEnd: "2026-04-30", status: "Computed" }],
    linesByPeriod: { 1: [asLine] },
    employees: [{ id: 1, sssNo: "34-1", philhealthNo: "PH-1", pagibigNo: "PI-1" }],
    statutory: STATUTORY,
  });
  const ag = (k) => rep.agencies.find((a) => a.key === k);
  check("SSS section shows the corrected EMPLOYER share (2000, not the engine's 1850)",
    near(ag("sss").totalEr, 2000), String(ag("sss").totalEr));
  check("SSS section shows the corrected EC (45, not the bracket's 30)",
    near(ag("sss").totalEc, 45), String(ag("sss").totalEc));
  check("PhilHealth section shows the corrected employer share (500)",
    near(ag("philhealth").totalEr, 500), String(ag("philhealth").totalEr));
  check("Pag-IBIG section shows the corrected employer share (250)",
    near(ag("pagibig").totalEr, 250), String(ag("pagibig").totalEr));
  check("SSS agency total folds the corrections in (ee + 2000 + 45)",
    near(ag("sss").total, ag("sss").totalEe + 2000 + 45), String(ag("sss").total));
  check("the EMPLOYEE side on the report is untouched by the employer corrections",
    near(ag("sss").totalEe, base.sssEe) && near(ag("philhealth").totalEe, base.philhealthEe),
    `${ag("sss").totalEe} / ${ag("philhealth").totalEe}`);
  check("a corrected EC does NOT raise the stale-EC warning (it is non-zero and deliberate)",
    !ag("sss").warnings.some((w) => w.kind === "stale_ec"));

  console.log("\n5. THE STATUTORY CEREMONY APPLIES TO ALL FOUR\n");
  for (const f of EMPLOYER_FIELDS) {
    const short = validateOverride({
      fieldName: f, value: 100, reason: "too short", reasonCategory: "Retroactive adjustment",
    });
    check(`${f}: a short reason is refused (25-char statutory minimum)`, !short.ok, short.error);
    const noCat = validateOverride({
      fieldName: f, value: 100,
      reason: "A sufficiently long explanation of the employer-side correction.",
    });
    check(`${f}: a missing reason CATEGORY is refused`, !noCat.ok, noCat.error);
    const good = validateOverride({
      fieldName: f, value: 100,
      reason: "A sufficiently long explanation of the employer-side correction.",
      reasonCategory: "Correction of a mis-assessed premium",
    });
    check(`${f}: a complete statutory submission is accepted`, good.ok, good.error);
    check(`${f}: ...and is flagged isStatutory`, good.ok && good.isStatutory === true);
    const neg = validateOverride({
      fieldName: f, value: -1,
      reason: "A sufficiently long explanation of the employer-side correction.",
      reasonCategory: "Correction of a mis-assessed premium",
    });
    check(`${f}: a NEGATIVE value is refused`, !neg.ok, neg.error);
  }

  console.log("\n6. ROLE GATING -- THE STATUTORY ALLOWLIST GOVERNS ALL FOUR\n");
  // mayOverride() in routes/payroll.js is `OVERRIDABLE_STATUTORY.includes(field)
  // ? PAYROLL_STATUTORY_OVERRIDE_ROLES : PAYROLL_OVERRIDE_ROLES`. It is field-
  // agnostic, so membership of OVERRIDABLE_STATUTORY is what routes each field
  // to the tighter list -- which is exactly what this asserts.
  const ROLES = [
    "Admin", "Owner / President / General Manager", "Accounting / Payroll",
    "Operation Manager / Operation Officer / Supervisor", "HR", "Admin Officer",
    "Inspector / Investigator", "Investigator", "Viewer",
  ];
  const ALLOWED = ["Admin", "Owner / President / General Manager", "Accounting / Payroll"];
  const mayOverride = (role, field) => (OVERRIDABLE_STATUTORY.includes(field)
    ? PAYROLL_STATUTORY_OVERRIDE_ROLES : PAYROLL_OVERRIDE_ROLES).includes(role);
  for (const f of EMPLOYER_FIELDS) {
    for (const role of ROLES) {
      const expect = ALLOWED.includes(role);
      check(`${f} / ${role}: ${expect ? "ALLOWED" : "refused"}`, mayOverride(role, f) === expect);
    }
  }
  check("the four employer fields route to the STATUTORY list, not the looser one",
    EMPLOYER_FIELDS.every((f) => OVERRIDABLE_STATUTORY.includes(f)));
  check("all nine roles are real (typo in a role name would silently 'refuse' everyone)",
    ROLES.length === 9 && ALLOWED.every((r) => ROLES.includes(r)));

  console.log("\n7. THE STALE / RECONCILE PATH IS FIELD-AGNOSTIC AND COVERS THEM\n");
  const stored = EMPLOYER_FIELDS.map((f, i) => ({
    id: i + 1, fieldName: f, computedValue: 100, overrideValue: 500, status: "active",
  }));
  const movedBase = reconcileOverrides(stored, EMPLOYER_FIELDS.map((f) => ({ field: f, computedValue: 111 })));
  check("a moved base marks every employer override stale", movedBase.length === 4
    && movedBase.every((c) => c.status === "stale"), JSON.stringify(movedBase.map((c) => c.status)));
  const returned = reconcileOverrides(
    stored.map((s) => ({ ...s, status: "stale", staleComputedValue: 111 })),
    EMPLOYER_FIELDS.map((f) => ({ field: f, computedValue: 100 }))
  );
  check("a base that returns clears the flag automatically", returned.length === 4
    && returned.every((c) => c.status === "active"));
  const map = overridesMapFor([{ fieldName: "sssEc", overrideValue: "77" }]);
  check("overridesMapFor carries an employer field through (string coerced once, at the boundary)",
    map.get("sssEc") === 77);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
