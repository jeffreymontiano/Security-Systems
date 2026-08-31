/**
 * Gap 30 Phase 1 -- SSS Employees' Compensation (EC).
 *
 * EC is an EMPLOYER-ONLY levy (PHP 10 or 30 per bracket) that the SSS table has
 * always carried and sssLookup used to discard. It is now assessed and stored so
 * the remittance report (Phase 2) can show the agency's full SSS obligation.
 *
 * The load-bearing assertion is NEGATIVE: adding EC must not move one centavo of
 * any guard's pay. It is proved two independent ways, because the failure being
 * guarded against is a leak into the money path:
 *
 *   1. AGAINST THE PREVIOUS ENGINE, pinned at commit cf02dfd -- the last commit
 *      before EC existed. Every employee-side figure and netPay must be
 *      byte-identical across the twelve ladder shapes override-arrears.js
 *      exercises. Pinned to a NAMED revision, never HEAD: a back-compat suite
 *      loading HEAD becomes self-referential the moment its change is committed
 *      and then compares the new code against itself (Known Gap 21).
 *
 *   2. BY VARYING ec ITSELF -- 0, 10, 30, and an absurd 9999 -- and asserting
 *      netPay is unchanged. This one keeps working forever, with no pinned
 *      revision to go stale, and it proves the property directly rather than by
 *      comparison.
 *
 * This suite is PURE: no DB, no server, and it SETS the statutory config it
 * depends on rather than inheriting whatever the database happens to hold --
 * the arrears-e2e mistake recorded as Known Gap 21. It also never requires
 * ../db, whose import runs migrate() (Known Gap 27).
 *
 * Usage: node scripts/payroll/sss-ec.js
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..", "..");

const PINNED = "cf02dfd"; // the commit immediately before EC. NEVER HEAD.

const { computeEmployeeLine } = require(path.join(ROOT, "src", "lib", "payrollEngine"));

let pass = 0, fail = 0;
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.005;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
  ok ? pass++ : fail++;
}

// ---- an explicit, self-contained statutory config ---------------------------
// Two EC values (10 and 30) so the per-bracket lookup is actually exercised,
// and brackets wide enough that a 570/day and a 1500/day guard land in
// different ones.
const makeStatutory = (over = {}) => ({
  sss: {
    brackets: [
      { minMsc: 0, maxMsc: 5000, msc: 5000, ee: 250, er: 500, ec: 10 },
      { minMsc: 5001, maxMsc: 20000, msc: 20000, ee: 1000, er: 2000, ec: 10 },
      { minMsc: 20001, maxMsc: 35000, msc: 35000, ee: 1750, er: 3500, ec: 30 },
    ],
    ...(over.sss || {}),
  },
  philhealth: { ratePercent: 5, floor: 10000, ceiling: 100000 },
  pagibig: {
    employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500,
    employerRate: 0.02, salaryCap: 10000,
  },
  withholding_tax: {
    frequency: "semi-monthly",
    brackets: [
      { min: 0, max: 10416, base: 0, rate: 0 },
      { min: 10417, max: 16666, base: 0, rate: 0.15 },
      { min: 16667, max: null, base: 937.5, rate: 0.2 },
    ],
  },
  pay_rules: {
    otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30,
    sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second",
    withholdingTaxEnabled: true,
    ...(over.pay_rules || {}),
  },
  premium_rules: {
    nightDiffPercent: 0.1, nightStartHour: 22, nightEndHour: 6,
    regularHolidayWorked: 2, regularHolidayOt: 2.6, regularHolidayUnworkedPay: 1,
    requirePresenceDayBefore: true,
    specialDayWorked: 1.3, specialDayOt: 1.69, specialDayUnworkedPay: 0,
  },
});

const day = (d) => ({
  dutyDate: d, guardName: "EC-PROBE", site: "PROBE", status: "Present",
  timeIn: `${d}T06:00:00+08:00`, timeOut: `${d}T18:00:00+08:00`,
  shiftName: "Day", startTime: "06:00", endTime: "18:00", crossesMidnight: false,
  lateMin: 0, undertimeMin: 0, builtinOtMin: 240, overtimeMin: 0, isRestDay: false, flags: [],
});

function runWith(engine, { rate = 570, days = 1, arrears = 0, overrides = {},
                          statutory, isFirstCutoff = false } = {}) {
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(`2026-04-${String(i + 1).padStart(2, "0")}`);
  return engine.computeEmployeeLine({
    employee: { fullName: "EC-PROBE", employeeNo: "PROBE", payType: "Daily", dailyRate: rate, monthlyRate: 0 },
    attendanceRows: dates.map(day), approvedOtByDate: new Map(), leaveRecords: [],
    isGuard: true, components: [], statutory: statutory || makeStatutory(),
    isFirstCutoff, periodStart: dates[0], periodEnd: dates[dates.length - 1],
    holidays: [], openingArrears: arrears, overrides,
  });
}
const run = (cfg) => runWith({ computeEmployeeLine }, cfg);

// The exact twelve shapes override-arrears.js exercises.
const LADDER_CASES = [
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

// Everything that is, or feeds, the guard's money.
const GUARD_FACING = [
  "grossPay", "netPay", "totalWanted", "totalTaken", "deductionsDeferred",
  "arrearsOpening", "arrearsRecovered", "arrearsClosing",
  "sssEe", "philhealthEe", "pagibigEe", "withholdingTax", "otherDeductions",
  "regularPay", "otPay", "builtinOtPay", "excessOtPay", "nightDiffPay",
  "holidayPremiumPay", "holidayUnworkedPay", "otherEarnings", "lateUndertimeDeduction",
];

function loadPinnedEngine() {
  const src = execFileSync("git", ["show", `${PINNED}:src/lib/payrollEngine.js`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (/sssEc/.test(src)) {
    throw new Error(`the pinned revision ${PINNED} already knows about sssEc -- `
      + "it is not a valid 'before'. Pin an earlier commit.");
  }
  // It must live in src/lib/ so its own relative requires (./leaveCredits,
  // ./phTime) resolve. Dot-prefixed so it is invisible to tooling, and removed
  // in a finally so a throw mid-require cannot leave a stray engine on disk.
  const tmp = path.join(ROOT, "src", "lib", `.pinned-payrollEngine-${PINNED}.js`);
  fs.writeFileSync(tmp, src);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function main() {
  console.log(`1. EC IS ASSESSED, PER BRACKET (pinned config, no DB)\n`);
  // 570/day x monthlyDivisor 30 = 17,100 -> the middle bracket, ec 10.
  const mid = run({ rate: 570, days: 20 });
  check("a 570/day guard (monthlyComp 17,100) draws the ec-10 bracket",
    near(mid.sssEc, 10), `sssEc ${mid.sssEc}`);
  // 800/day x 30 = 24,000 -> the top bracket, ec 30.
  const top = run({ rate: 800, days: 20 });
  check("an 800/day guard (monthlyComp 24,000) draws the ec-30 bracket",
    near(top.sssEc, 30), `sssEc ${top.sssEc}`);
  check("the two brackets really do differ (the lookup is not returning a constant)",
    mid.sssEc !== top.sssEc);
  check("sssEc is present on the returned line at all", "sssEc" in mid);

  console.log("\n2. EC IS ZERO WHERE THE WHOLE STATUTORY BLOCK IS ZERO\n");
  const noComp = run({ rate: 0, days: 20 });
  check("no pay rate configured -> sssEc 0, like sssEe/sssEr",
    noComp.sssEc === 0 && noComp.sssEe === 0 && noComp.sssEr === 0,
    `ec ${noComp.sssEc} ee ${noComp.sssEe} er ${noComp.sssEr}`);
  const emptyTable = run({ days: 20, statutory: makeStatutory({ sss: { brackets: [] } }) });
  check("an SSS table with no brackets -> sssEc 0, not undefined or NaN",
    emptyTable.sssEc === 0, String(emptyTable.sssEc));

  console.log("\n3. EC RIDES THE SSS CUTOFF (present on one, zero on the other)\n");
  for (const [mode, firstHasIt] of [["first", true], ["second", false]]) {
    const st = makeStatutory({ pay_rules: { sssCutoff: mode } });
    const onFirst = run({ days: 20, statutory: st, isFirstCutoff: true });
    const onSecond = run({ days: 20, statutory: st, isFirstCutoff: false });
    const withEc = firstHasIt ? onFirst : onSecond;
    const withoutEc = firstHasIt ? onSecond : onFirst;
    check(`sssCutoff "${mode}": EC lands on the ${firstHasIt ? "FIRST" : "SECOND"} cutoff`,
      near(withEc.sssEc, 10), `sssEc ${withEc.sssEc}`);
    check(`sssCutoff "${mode}": EC is 0 on the other cutoff`,
      withoutEc.sssEc === 0, `sssEc ${withoutEc.sssEc}`);
    check(`sssCutoff "${mode}": EC moves with sssEe/sssEr, not against them`,
      (withEc.sssEc > 0) === (withEc.sssEe > 0) && (withoutEc.sssEc > 0) === (withoutEc.sssEe > 0),
      `on: ec ${withEc.sssEc} ee ${withEc.sssEe} | off: ec ${withoutEc.sssEc} ee ${withoutEc.sssEe}`);
  }
  const split = makeStatutory({ pay_rules: { sssCutoff: "split" } });
  const s1 = run({ days: 20, statutory: split, isFirstCutoff: true });
  const s2 = run({ days: 20, statutory: split, isFirstCutoff: false });
  check(`sssCutoff "split": the two halves sum to the month's EC exactly`,
    near(s1.sssEc + s2.sssEc, 10), `${s1.sssEc} + ${s2.sssEc}`);

  console.log("\n4. THE LOAD-BEARING ONE -- EC MOVES NO GUARD MONEY\n");
  console.log("   4a. against the PREVIOUS ENGINE, pinned at " + PINNED + "\n");
  const old = loadPinnedEngine();
  let drift = 0;
  for (const [label, cfg] of LADDER_CASES) {
    const before = runWith(old, cfg);
    const after = runWith({ computeEmployeeLine }, cfg);
    const moved = GUARD_FACING.filter((f) => !near(Number(before[f]) || 0, Number(after[f]) || 0))
      .map((f) => `${f}: ${before[f]} -> ${after[f]}`);
    // withheld{} is what the payslip itemises; compare it too.
    for (const k of Object.keys(before.withheld || {})) {
      if (!near(before.withheld[k], after.withheld[k])) {
        moved.push(`withheld.${k}: ${before.withheld[k]} -> ${after.withheld[k]}`);
      }
    }
    if (moved.length) drift++;
    check(`${label} — every guard-facing figure identical`, moved.length === 0, moved.join("\n          "));
    check(`${label} — ...and the OLD engine had no sssEc while the new one does`,
      before.sssEc === undefined && typeof after.sssEc === "number",
      `before ${before.sssEc} after ${after.sssEc}`);
  }
  check("no ladder shape drifted at all", drift === 0, `${drift} of ${LADDER_CASES.length} drifted`);

  console.log("\n   4b. by VARYING ec itself -- the check that never goes stale\n");
  for (const [label, cfg] of LADDER_CASES) {
    const nets = [0, 10, 30, 9999].map((ec) => {
      const st = makeStatutory();
      st.sss.brackets = st.sss.brackets.map((b) => ({ ...b, ec }));
      return runWith({ computeEmployeeLine }, { ...cfg, statutory: st });
    });
    const netsSame = nets.every((l) => near(l.netPay, nets[0].netPay));
    const takenSame = nets.every((l) => near(l.totalTaken, nets[0].totalTaken));
    const deferSame = nets.every((l) => near(l.deductionsDeferred, nets[0].deductionsDeferred));
    const arrSame = nets.every((l) => near(l.arrearsClosing, nets[0].arrearsClosing));
    check(`${label} — net/taken/deferred/arrears unmoved by ec 0|10|30|9999`,
      netsSame && takenSame && deferSame && arrSame,
      `net ${nets.map((l) => l.netPay).join(" / ")}  taken ${nets.map((l) => l.totalTaken).join(" / ")}`);
    // ...and prove the input actually varied, or the check above is vacuous.
    check(`${label} — ...while sssEc itself DID vary (the check is not vacuous)`,
      new Set(nets.map((l) => l.sssEc)).size > 1,
      `sssEc ${nets.map((l) => l.sssEc).join(" / ")}`);
  }

  console.log("\n5. EC IS OUTSIDE THE LADDER, STRUCTURALLY\n");
  const src = fs.readFileSync(path.join(ROOT, "src", "lib", "payrollEngine.js"), "utf8");
  const wanted = src.match(/const wanted = \[([\s\S]*?)\];/);
  check("the wanted[] array is found", !!wanted);
  check("sssEc is NOT in wanted[] -- it cannot reach totalTaken, netPay, deferral or arrears",
    !/sssEc/.test(wanted[1]), wanted[1].trim());
  check("no employer share is in wanted[] either (EC is consistent with sssEr)",
    !/(sssEr|philhealthEr|pagibigEr)/.test(wanted[1]));
  const taxLine = src.match(/const taxDeductible = .*;/)[0];
  check("sssEc is NOT in the tax base -- it cannot move taxable income",
    !/sssEc/.test(taxLine), taxLine);
  // The conservation identity must still hold with EC present.
  for (const [label, cfg] of LADDER_CASES) {
    const l = run(cfg);
    check(`${label} — conservation identity still holds`,
      near(l.totalWanted, l.totalTaken + l.deductionsDeferred + (l.arrearsOpening - l.arrearsRecovered)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
