/**
 * Known Gap 26: the override x arrears/deferral interaction.
 *
 * override-stage1 proves the cap/priority/arrears ladder re-runs beneath an
 * override, but drives computeEmployeeLine() with a synthetic line and never
 * exercises arrears. override-stage2/3 drive the real routes, but their
 * fixtures have gross comfortably above deductions, so the ladder never caps.
 * Nothing tested the two TOGETHER — an override on a line whose deductions
 * exceed gross, where the freed or added pesos have to flow through the
 * deferral and the arrears recovery.
 *
 * The engine is PURE, so this needs no HTTP and no fixture data: it drives the
 * ladder directly with the real statutory config. It reads that config and
 * writes nothing.
 *
 * FIVE INVARIANTS, asserted on every case:
 *
 *   1. RECONCILES   gross - (the itemised deductions the PAYSLIP prints,
 *                   i.e. `withheld.*`, plus arrearsRecovered) == netPay
 *   2. CONSERVES    totalWanted == totalTaken + deductionsDeferred
 *                                  + (arrearsOpening - arrearsRecovered)
 *   3. ARREARS SANE arrearsRecovered <= arrearsOpening
 *   4. CLOSING      arrearsClosing == arrearsOpening - arrearsRecovered
 *                                     + deductionsDeferred
 *   5. NET IN RANGE 0 <= netPay <= grossPay
 *
 * Invariant 2 is stated carefully and was got WRONG first time. The obvious
 * form, `totalWanted == totalTaken + deductionsDeferred`, is false whenever
 * arrears exist: deductionsDeferred deliberately covers only THIS cutoff's
 * unmet deductions, because unrecovered OPENING arrears was already carried and
 * stays in arrearsClosing rather than being deferred a second time. Asserting
 * the obvious form would fail against correct code and send someone hunting a
 * bug that is not there.
 *
 * Invariant 5 is the one a NEGATIVE override breaks, and the reason
 * makeOverrides() refuses negatives rather than trusting the API to have done
 * it: the ladder takes min(amount, remaining) and decrements `remaining`, so a
 * negative INCREASES capacity and manufactures money. Measured before the
 * guard: a -5000 override on a PHP 926.25 gross produced a net of 5000.00.
 */
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

// Read-only by construction: the only statement this file issues is the
// statutory-config SELECT, and anything else is refused.
const pg = require(path.join(ROOT, "node_modules", "pg"));
const realQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (sql, ...rest) {
  const t = typeof sql === "string" ? sql : (sql && sql.text) || "";
  if (/^\s*(insert|update|delete|alter|drop|create|truncate)\b/i.test(t)) {
    console.error("REFUSED: this suite is read-only and something tried to write.");
    process.exit(3);
  }
  return realQuery.call(this, sql, ...rest);
};
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { computeEmployeeLine } = require(path.join(ROOT, "src", "lib", "payrollEngine"));

const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.005;
let statutory = {};
let pass = 0, fail = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "   " + detail}`);
  ok ? pass++ : fail++;
}

const day = (d) => ({
  dutyDate: d, guardName: "ARREARS-PROBE", site: "PROBE", status: "Present",
  timeIn: `${d}T06:00:00+08:00`, timeOut: `${d}T18:00:00+08:00`,
  shiftName: "Day", startTime: "06:00", endTime: "18:00", crossesMidnight: false,
  lateMin: 0, undertimeMin: 0, builtinOtMin: 240, overtimeMin: 0, isRestDay: false, flags: [],
});

function run({ rate = 570, days = 1, arrears = 0, overrides = {} }) {
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(`2026-04-${String(i + 1).padStart(2, "0")}`);
  return computeEmployeeLine({
    employee: { fullName: "ARREARS-PROBE", employeeNo: "PROBE", payType: "Daily", dailyRate: rate, monthlyRate: 0 },
    attendanceRows: dates.map(day), approvedOtByDate: new Map(), leaveRecords: [],
    isGuard: true, components: [], statutory, isFirstCutoff: false,
    periodStart: dates[0], periodEnd: dates[dates.length - 1], holidays: [],
    openingArrears: arrears, overrides,
  });
}

function assertInvariants(label, l) {
  const w = l.withheld;
  const itemised = r2(w.sssEe + w.philhealthEe + w.pagibigEe + w.withholdingTax
    + w.otherDeductions + l.arrearsRecovered);
  check(`${label} — 1 reconciles`, near(r2(l.grossPay - itemised), l.netPay),
    `gross ${l.grossPay} - itemised ${itemised} != net ${l.netPay}`);
  check(`${label} — 2 conserves`,
    near(l.totalWanted, l.totalTaken + l.deductionsDeferred + (l.arrearsOpening - l.arrearsRecovered)),
    `wanted ${l.totalWanted} != taken ${l.totalTaken} + deferred ${l.deductionsDeferred} + unrecovered ${r2(l.arrearsOpening - l.arrearsRecovered)}`);
  check(`${label} — 3 arrearsRecovered <= arrearsOpening`,
    l.arrearsRecovered <= l.arrearsOpening + 0.005,
    `recovered ${l.arrearsRecovered} > owed ${l.arrearsOpening}`);
  check(`${label} — 4 arrearsClosing`,
    near(l.arrearsClosing, l.arrearsOpening - l.arrearsRecovered + l.deductionsDeferred),
    `closing ${l.arrearsClosing}`);
  check(`${label} — 5 0 <= net <= gross`,
    l.netPay >= 0 && l.netPay <= l.grossPay + 0.005,
    `net ${l.netPay} vs gross ${l.grossPay}`);
}

(async () => {
  for (const r of (await pool.query(`SELECT key, config FROM payroll_statutory_config`)).rows) {
    statutory[r.key] = r.config;
  }
  await pool.end();

  console.log("1. THE FIVE INVARIANTS, ACROSS THE LADDER'S SHAPES\n");
  const cases = [
    ["baseline, gross exhausted", { days: 1 }],
    ["baseline, ample gross", { days: 20 }],
    ["override LOWERS philhealth, gross exhausted", { days: 1, overrides: { philhealthEe: 0 } }],
    ["override LOWERS philhealth, ample gross", { days: 20, overrides: { philhealthEe: 0 } }],
    ["override RAISES otherDeductions past gross", { days: 1, overrides: { otherDeductions: 99999 } }],
    ["arrears present, gross exhausted", { days: 1, arrears: 300 }],
    ["arrears present + override", { days: 1, arrears: 300, overrides: { philhealthEe: 0 } }],
    ["arrears partially recoverable", { days: 3, arrears: 5000 }],
    ["arrears partially recoverable + override", { days: 3, arrears: 5000, overrides: { philhealthEe: 0 } }],
    ["arrears far exceed any surplus", { days: 20, arrears: 100000 }],
    ["override to exactly 0", { days: 20, overrides: { sssEe: 0 } }],
    ["several overrides at once", { days: 20, overrides: { philhealthEe: 0, pagibigEe: 50, otherDeductions: 500 } }],
  ];
  for (const [label, cfg] of cases) assertInvariants(label, run(cfg));

  console.log("\n2. THE FREED PESO LANDS WHERE THE LADDER SAYS\n");
  const wide = run({ days: 20 });
  const wideLow = run({ days: 20, overrides: { philhealthEe: 0 } });
  check("with no arrears and ample gross, it reaches NET, exactly",
    near(wideLow.netPay - wide.netPay, wide.withheld.philhealthEe),
    `net moved ${r2(wideLow.netPay - wide.netPay)}, freed ${wide.withheld.philhealthEe}`);

  const part = run({ days: 3, arrears: 5000 });
  const partLow = run({ days: 3, arrears: 5000, overrides: { philhealthEe: 0 } });
  check("with arrears outstanding, it reaches ARREARS, exactly",
    near(partLow.arrearsRecovered - part.arrearsRecovered, part.withheld.philhealthEe),
    `arrears moved ${r2(partLow.arrearsRecovered - part.arrearsRecovered)}, freed ${part.withheld.philhealthEe}`);
  check("...and net does not move while gross is still exhausted",
    near(partLow.netPay, part.netPay));

  console.log("\n3. A NEGATIVE OVERRIDE IS REFUSED BY THE ENGINE ITSELF\n");
  // Not merely by the API: the ladder is the money path and must not depend on
  // every caller having validated first.
  const neg = run({ days: 1, overrides: { otherDeductions: -5000 } });
  const base = run({ days: 1 });
  check("rejected, and REPORTED rather than silently swallowed",
    neg.overridesRejected.some((r) => r.field === "otherDeductions"),
    JSON.stringify(neg.overridesRejected));
  check("the computed value stands instead", near(neg.withheld.otherDeductions, base.withheld.otherDeductions));
  check("net is unchanged from baseline", near(neg.netPay, base.netPay));
  check("net never exceeds gross", neg.netPay <= neg.grossPay + 0.005,
    `net ${neg.netPay} vs gross ${neg.grossPay}`);
  assertInvariants("negative override", neg);

  const negArr = run({ days: 1, arrears: 300, overrides: { sssEe: -1000 } });
  check("negative + arrears: recovery not manufactured",
    negArr.arrearsRecovered <= negArr.arrearsOpening + 0.005
      && negArr.netPay <= negArr.grossPay + 0.005,
    `recovered ${negArr.arrearsRecovered}, net ${negArr.netPay}, gross ${negArr.grossPay}`);
  assertInvariants("negative + arrears", negArr);

  console.log("\n4. AN EXPLICIT ZERO IS STILL A REAL OVERRIDE\n");
  // The sign guard must not swallow 0 the way a truthiness check would.
  const zero = run({ days: 20, overrides: { philhealthEe: 0 } });
  check("0 is applied, not rejected",
    zero.overridesApplied.some((a) => a.field === "philhealthEe" && a.overrideValue === 0),
    JSON.stringify(zero.overridesApplied));
  check("and it is not in the rejected list",
    !zero.overridesRejected.some((r) => r.field === "philhealthEe"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR " + e.message); console.error(e.stack); process.exit(1); });
