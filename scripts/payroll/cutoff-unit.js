// Three independent per-contribution cutoffs.
//
// Back-compat is the load-bearing test here: the whole change must be invisible
// to any install that keeps its three settings equal to the single one it used
// to have. Priced against the PRE-CHANGE engine loaded out of git, so "unchanged"
// is measured rather than asserted.
// Resolved from this file's own location, never hardcoded: an absolute path
// to one developer's checkout is useless to everyone else.
const ROOT = require("path").resolve(__dirname, "..", "..");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const NEW = require(ROOT + "/src/lib/payrollEngine");

// PINNED to the last commit whose engine still had the single statutoryCutoff.
// It was "HEAD" while the split was unlanded, which quietly became
// self-referential the moment it shipped: the suite then compared the NEW engine
// against itself while feeding it a config key it no longer reads, so every
// mode but the fallback "failed". The comparison only means something against
// the actual pre-change code.
const PRE_SPLIT_REV = "68ad575";
function loadOld() {
  const src = execFileSync("git", ["show", `${PRE_SPLIT_REV}:src/lib/payrollEngine.js`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const f = path.join(__dirname, "_eng_oldcutoff.js");
  fs.writeFileSync(f, src.replace(/require\("\.\/([^"]+)"\)/g,
    (_m, q) => `require(${JSON.stringify(ROOT + "/src/lib/" + q)})`));
  return require(f);
}
const OLD = loadOld();

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`
    + (ok ? "" : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`));
};

// Real seeded tables. PhilHealth is 5% of comp, which is where the odd centavo
// appears; SSS is a fixed peso bracket; Pag-IBIG 2% of comp.
const TABLES = {
  sss: { brackets: [{ minMsc: 0, maxMsc: 1000000, ee: 855, er: 1710 }] },
  philhealth: { floor: 10000, ceiling: 100000, ratePercent: 5 },
  pagibig: { employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500, employerRate: 0.02, salaryCap: 10000 },
  withholding_tax: { brackets: [{ min: 0, max: null, base: 0, rate: 0 }] },
};
const rules = (extra) => ({
  sss: TABLES.sss, philhealth: TABLES.philhealth, pagibig: TABLES.pagibig,
  withholding_tax: TABLES.withholding_tax,
  pay_rules: {
    otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30,
    withholdingTaxEnabled: false, ...extra,
  },
  premium_rules: { nightDiffPercent: 0.1, nightStartHour: 22, nightEndHour: 6,
    regularHolidayWorked: 2, regularHolidayOt: 2.6, regularHolidayUnworkedPay: 1,
    specialDayWorked: 1.3, specialDayOt: 1.69, specialDayUnworkedPay: 0,
    requirePresenceDayBefore: true },
});
const iso = (d, t) => new Date(`${d}T${t}:00+08:00`).toISOString();
function workedDays(from, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.parse(from + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
    out.push({
      dutyDate: d, guardName: "T", site: "S", shiftName: "Day Shift",
      startTime: "06:00", endTime: "18:00", crossesMidnight: false, shiftKind: "Day",
      status: "Present", isRestDay: false, shiftUnits: 1,
      timeIn: iso(d, "06:00"), timeOut: iso(d, "18:00"),
      lateMin: 0, undertimeMin: 0, overtimeMin: 0, builtinOtMin: 240,
      startTime2: null, endTime2: null, crossesMidnight2: false, flags: [],
    });
  }
  return out;
}
function line(engine, cfg, isFirstCutoff, rate = 645, days = 15) {
  const start = isFirstCutoff ? "2026-09-01" : "2026-09-16";
  const end = isFirstCutoff ? "2026-09-15" : "2026-09-30";
  return engine.computeEmployeeLine({
    employee: { id: 1, fullName: "T", payType: "Daily", dailyRate: rate, monthlyRate: 0 },
    attendanceRows: workedDays(start, days), approvedOtByDate: new Map(),
    leaveRecords: [], isGuard: true, components: [], statutory: rules(cfg),
    isFirstCutoff, periodStart: start, periodEnd: end, holidays: [], openingArrears: 0,
  });
}
const SC = ["sssEe", "sssEr", "philhealthEe", "philhealthEr", "pagibigEe", "pagibigEr"];
const ALL = [...SC, "grossPay", "netPay", "withholdingTax", "regularPay", "otPay", "nightDiffPay"];

// Monthly totals at rate 645 -> monthlyComp 19,350.
const MONTHLY = { sssEe: 855, philhealthEe: 483.75, pagibigEe: 200 };
console.log(`monthly contributions at PHP 645/day (comp 19,350):`
  + `  SSS ${MONTHLY.sssEe}   PhilHealth ${MONTHLY.philhealthEe}   Pag-IBIG ${MONTHLY.pagibigEe}\n`);

console.log("=== 1. THE SPECIFIED MIX: SSS=1st, PhilHealth=2nd, Pag-IBIG=2nd ===");
{
  const cfg = { sssCutoff: "first", philhealthCutoff: "second", pagibigCutoff: "second" };
  const c1 = line(NEW, cfg, true), c2 = line(NEW, cfg, false);
  console.log("  1st cutoff (1-15):");
  check("    SSS withheld in full", Number(c1.sssEe), MONTHLY.sssEe);
  check("    PhilHealth NOT withheld", Number(c1.philhealthEe), 0);
  check("    Pag-IBIG NOT withheld", Number(c1.pagibigEe), 0);
  console.log("  2nd cutoff (16-end):");
  check("    SSS NOT withheld", Number(c2.sssEe), 0);
  check("    PhilHealth withheld in full", Number(c2.philhealthEe), MONTHLY.philhealthEe);
  check("    Pag-IBIG withheld in full", Number(c2.pagibigEe), MONTHLY.pagibigEe);
  check("  each contribution is remitted exactly once across the month",
    [Number(c1.sssEe) + Number(c2.sssEe),
      Number(c1.philhealthEe) + Number(c2.philhealthEe),
      Number(c1.pagibigEe) + Number(c2.pagibigEe)],
    [MONTHLY.sssEe, MONTHLY.philhealthEe, MONTHLY.pagibigEe]);
  check("  the EMPLOYER share follows the same cutoff", Number(c1.sssEr) > 0 && Number(c2.sssEr) === 0, true);
}

console.log("\n=== 2. SPLIT: halves sum to the month EXACTLY, odd centavo included ===");
{
  const cfg = { sssCutoff: "split", philhealthCutoff: "split", pagibigCutoff: "split" };
  const c1 = line(NEW, cfg, true), c2 = line(NEW, cfg, false);
  console.log(`  PhilHealth 483.75 -> 1st ${c1.philhealthEe}  2nd ${c2.philhealthEe}`);
  check("    PhilHealth halves sum to the monthly total",
    Number(c1.philhealthEe) + Number(c2.philhealthEe), MONTHLY.philhealthEe);
  check("    the FIRST cutoff carries the odd centavo", Number(c1.philhealthEe), 241.88);
  check("    the SECOND cutoff takes the remainder", Number(c2.philhealthEe), 241.87);
  check("    SSS halves sum to the monthly total",
    Number(c1.sssEe) + Number(c2.sssEe), MONTHLY.sssEe);
  check("    Pag-IBIG halves sum to the monthly total",
    Number(c1.pagibigEe) + Number(c2.pagibigEe), MONTHLY.pagibigEe);
  // Independent rounding was the defect: round2(483.75/2) x 2 = 483.76.
  const naive = Math.round((483.75 / 2) * 100) / 100 * 2;
  console.log(`  (rounding each half independently would give ${naive.toFixed(2)} \u2014 a centavo over)`);
  check("    the drift the old arithmetic produced is gone",
    Number(c1.philhealthEe) + Number(c2.philhealthEe) !== naive, true);
}

console.log("\n=== 3. BACK-COMPAT: all three equal reproduces the old engine ===");
// 'first' and 'second' must be byte-identical. 'split' is byte-identical on the
// 1st cutoff and differs by exactly ONE CENTAVO on the 2nd, deliberately: the
// old code rounded each half independently and over-withheld.
for (const mode of ["first", "second"]) {
  for (const isFirst of [true, false]) {
    const before = line(OLD, { statutoryCutoff: mode }, isFirst);
    const after = line(NEW, { sssCutoff: mode, philhealthCutoff: mode, pagibigCutoff: mode }, isFirst);
    const moved = ALL.filter((k) => String(before[k]) !== String(after[k]));
    check(`  statutoryCutoff="${mode}" on the ${isFirst ? "1st" : "2nd"} cutoff: BYTE-IDENTICAL`,
      moved.map((k) => `${k} ${before[k]}->${after[k]}`), []);
  }
}
{
  const b1 = line(OLD, { statutoryCutoff: "split" }, true);
  const a1 = line(NEW, { sssCutoff: "split", philhealthCutoff: "split", pagibigCutoff: "split" }, true);
  check('  statutoryCutoff="split" on the 1st cutoff: BYTE-IDENTICAL',
    ALL.filter((k) => String(b1[k]) !== String(a1[k])), []);
  const b2 = line(OLD, { statutoryCutoff: "split" }, false);
  const a2 = line(NEW, { sssCutoff: "split", philhealthCutoff: "split", pagibigCutoff: "split" }, false);
  const moved = ALL.filter((k) => String(b2[k]) !== String(a2[k])).sort();
  console.log(`  statutoryCutoff="split" on the 2nd cutoff moves: ${moved.join(", ") || "nothing"}`);
  check("  ...and ONLY by the deliberate centavo correction", moved,
    ["netPay", "philhealthEe", "philhealthEr"]);
  check("    PhilHealth 2nd half 241.88 -> 241.87", Number(a2.philhealthEe), 241.87);
  check("    net pay rises by exactly one centavo",
    Math.round((Number(a2.netPay) - Number(b2.netPay)) * 100) / 100, 0.01);
  const oldSum = Number(b1.philhealthEe) + Number(b2.philhealthEe);
  const newSum = Number(a1.philhealthEe) + Number(a2.philhealthEe);
  console.log(`  across the month: old ${oldSum.toFixed(2)} vs new ${newSum.toFixed(2)} (owed ${MONTHLY.philhealthEe})`);
  check("    the old total over-withheld; the new total is exact",
    [Math.round((oldSum - MONTHLY.philhealthEe) * 100) / 100, newSum], [0.01, MONTHLY.philhealthEe]);
}

console.log("\n=== 4. WITHHOLDING TAX is independent of every cutoff setting ===");
{
  const taxed = (cfg) => {
    const r = rules(cfg);
    r.pay_rules.withholdingTaxEnabled = true;
    r.withholding_tax = { brackets: [{ min: 0, max: null, base: 0, rate: 0.1 }] };
    return NEW.computeEmployeeLine({
      employee: { id: 1, fullName: "T", payType: "Daily", dailyRate: 645, monthlyRate: 0 },
      attendanceRows: workedDays("2026-09-01", 15), approvedOtByDate: new Map(),
      leaveRecords: [], isGuard: true, components: [], statutory: r,
      isFirstCutoff: true, periodStart: "2026-09-01", periodEnd: "2026-09-15",
      holidays: [], openingArrears: 0,
    });
  };
  const base = Number(taxed({ sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second" }).withholdingTax);
  for (const cfg of [
    { sssCutoff: "first", philhealthCutoff: "first", pagibigCutoff: "first" },
    { sssCutoff: "split", philhealthCutoff: "split", pagibigCutoff: "split" },
    { sssCutoff: "first", philhealthCutoff: "second", pagibigCutoff: "split" },
  ]) {
    check(`    tax unchanged under ${Object.values(cfg).join("/")}`,
      Number(taxed(cfg).withholdingTax), base);
  }
  console.log(`    (tax base always uses HALF the month's contributions, whatever the cash timing)`);
}

console.log("\n=== 5. a missing or malformed setting NEVER half-withholds ===");
{
  const c1 = line(NEW, {}, true), c2 = line(NEW, {}, false);
  check("    absent settings withhold nothing on the 1st cutoff", Number(c1.sssEe), 0);
  check("    ...and the whole month on the 2nd (the seeded default)", Number(c2.sssEe), MONTHLY.sssEe);
  const bad = line(NEW, { sssCutoff: "every", philhealthCutoff: "", pagibigCutoff: 5 }, false);
  check("    'every' is not a mode and falls back to 'second'", Number(bad.sssEe), MONTHLY.sssEe);
  check("    ...so nothing is ever doubled", Number(bad.sssEe) <= MONTHLY.sssEe, true);
  const badFirst = line(NEW, { sssCutoff: "every" }, true);
  check("    ...and nothing is withheld twice across the month",
    Number(badFirst.sssEe) + Number(bad.sssEe), MONTHLY.sssEe);
}

fs.unlinkSync(path.join(__dirname, "_eng_oldcutoff.js"));
console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILURE(S)"}`);
process.exit(failed === 0 ? 0 : 1);
