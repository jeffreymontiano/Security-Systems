/**
 * READ-ONLY inertness check for the payroll override layer (stage ii).
 *
 * The claim this proves, on REAL production data, without writing anything:
 *
 *   With no override rows, the override layer contributes NOTHING. The engine
 *   returns byte-identical figures whether it is given no overrides argument at
 *   all, an empty map, or the map actually built from production's override
 *   table.
 *
 * Why it exists: stage (ii) changed what happens on EVERY payroll compute --
 * an extra query, an `overrides` map into computeEmployeeLine(), and a
 * reconciliation pass. That runs whether or not an override exists. Recomputing
 * a real period would prove it, but a recompute WRITES payroll_lines and
 * restamps computedAt, and the whole reason for care here is a config typo that
 * silently corrupted production payroll. So: prove it read-only first.
 *
 * ---------------------------------------------------------------------------
 * TWO GUARANTEES, both enforced rather than promised:
 *
 * 1. src/db.js calls migrate() AT MODULE IMPORT (db.js:2926). Anything that
 *    requires it -- including computeReport(), which this check needs -- would
 *    therefore run DDL against whatever DATABASE_URL points at. That is not
 *    read-only, so db.js is NEVER imported: its module-cache slot is
 *    pre-populated below with a guarded pool, and migrate() never runs.
 *
 * 2. Every statement issued by anything in this process -- this file,
 *    computeReport(), any transitive require -- passes through a guard that
 *    refuses INSERT/UPDATE/DELETE/DDL and exits 3, naming the statement. A
 *    write cannot happen by oversight; it can only happen by editing the guard.
 *
 * The engine itself (payrollEngine.js) is pure and touches no database.
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/payroll/override-inertness-check.js              # list periods
 *   node scripts/payroll/override-inertness-check.js --period 12
 */

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

// ---- guarantee 2: nothing in this process may write -------------------------
const MUTATING = /^\s*(insert|update|delete|alter|drop|create|truncate|grant|revoke|copy|comment|refresh|reindex|vacuum|set\s+session|set\s+local)\b/i;
let statements = 0;
function guard(sql) {
  const text = typeof sql === "string" ? sql : (sql && sql.text) || "";
  if (MUTATING.test(text)) {
    console.error("\nREFUSED -- this check is read-only and something tried to write:\n");
    console.error("  " + text.replace(/\s+/g, " ").slice(0, 200));
    console.error("\nNothing was written. Exiting.\n");
    process.exit(3);
  }
  statements++;
}

// The guard is installed on Client.prototype.query, which is the ONE chokepoint
// every statement passes through -- pool.query() borrows a client and calls it,
// and so does any code holding a client of its own. Wrapping pool.query and
// pool.connect instead looks equivalent and is not: pg's own Pool.query calls
// this.connect(callback), so an arrow-function connect override that ignores
// the callback never resolves and the first query hangs for ever. Measured, not
// theorised -- the first draft of this file did exactly that.
const pg = require(path.join(ROOT, "node_modules", "pg"));
const realClientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (sql, ...rest) {
  guard(sql);
  return realClientQuery.call(this, sql, ...rest);
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- guarantee 1: db.js is never imported, so migrate() never runs ----------
const dbPath = require.resolve(path.join(ROOT, "src", "db.js"));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { pool, ready: Promise.resolve() },
};

// Safe to require now: these reach db.js only through the cache slot above.
const { computeReport } = require(path.join(ROOT, "src", "routes", "attendance-reports"));
const { resolveRecurringComponents, computeEmployeeLine } = require(path.join(ROOT, "src", "lib", "payrollEngine"));
const { overridesMapFor } = require(path.join(ROOT, "src", "lib", "payrollOverrides"));
const { isGuardPosition } = require(path.join(ROOT, "src", "lib", "leaveCredits"));
const { addDays: phAddDays } = require(path.join(ROOT, "src", "lib", "phTime"));

// Column <-> engine-field mapping, transcribed from the UPDATE in
// routes/payroll.js. Employee-side statutory figures come from `withheld`
// (what the gross cap actually let through); employer shares are assessed.
const FIELDS = [
  ["payType", (c) => c.payType], ["rateUsed", (c) => c.rateUsed],
  ["presentDays", (c) => c.presentDays], ["absentDays", (c) => c.absentDays],
  ["paidLeaveDays", (c) => c.paidLeaveDays], ["lwopDays", (c) => c.lwopDays],
  ["lateMinutes", (c) => c.lateMinutes], ["undertimeMinutes", (c) => c.undertimeMinutes],
  ["builtinOtMinutes", (c) => c.builtinOtMinutes], ["approvedOtMinutes", (c) => c.approvedOtMinutes],
  ["regularPay", (c) => c.regularPay], ["otPay", (c) => c.otPay],
  ["lateUndertimeDeduction", (c) => c.lateUndertimeDeduction],
  ["otherEarnings", (c) => c.otherEarnings], ["grossPay", (c) => c.grossPay],
  ["sssEe", (c) => c.withheld.sssEe], ["sssEr", (c) => c.sssEr],
  ["philhealthEe", (c) => c.withheld.philhealthEe], ["philhealthEr", (c) => c.philhealthEr],
  ["pagibigEe", (c) => c.withheld.pagibigEe], ["pagibigEr", (c) => c.pagibigEr],
  ["withholdingTax", (c) => c.withheld.withholdingTax],
  ["otherDeductions", (c) => c.withheld.otherDeductions], ["netPay", (c) => c.netPay],
  ["nightDiffMinutes", (c) => c.nightDiffMinutes], ["nightDiffPay", (c) => c.nightDiffPay],
  ["holidayPremiumPay", (c) => c.holidayPremiumPay], ["holidayUnworkedPay", (c) => c.holidayUnworkedPay],
  ["arrearsOpening", (c) => c.arrearsOpening], ["arrearsRecovered", (c) => c.arrearsRecovered],
  ["deductionsDeferred", (c) => c.deductionsDeferred],
  ["builtinOtPay", (c) => c.builtinOtPay], ["excessOtPay", (c) => c.excessOtPay],
];
const cents = (v) => (v == null ? null : Math.round(Number(v) * 100));
const sameNum = (a, b) => cents(a) === cents(b);

function diffArms(a, b) {
  const out = [];
  for (const [name, get] of FIELDS) {
    const x = get(a), y = get(b);
    if (typeof x === "string" || typeof y === "string") { if (x !== y) out.push([name, x, y]); }
    else if (!sameNum(x, y)) out.push([name, x, y]);
  }
  // payroll_line_days is written straight from computed.days, so it is part of
  // the claim: identical totals over a different per-day breakdown would still
  // be a behaviour change.
  if (JSON.stringify(a.days) !== JSON.stringify(b.days)) out.push(["days[]", "(differs)", "(differs)"]);
  return out;
}

async function main() {
  let host = "(unparseable)";
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* leave as-is */ }
  console.log("=".repeat(74));
  console.log("OVERRIDE INERTNESS CHECK  --  READ ONLY, NOTHING IS WRITTEN");
  console.log("=".repeat(74));
  console.log("target host : " + host);
  console.log("db.js       : NOT imported -- migrate() does not run");
  console.log("write guard : active (any INSERT/UPDATE/DELETE/DDL exits 3)\n");

  // `--prove-guard` turns the banner's claim into a demonstration: it issues a
  // deliberate UPDATE and the guard must refuse it with exit 3 BEFORE the
  // statement reaches the database. "The guard is active" is worth exactly as
  // much as "the signal handler works" was before somebody pressed Ctrl-C.
  if (process.argv.includes("--prove-guard")) {
    console.log("--prove-guard: issuing a deliberate UPDATE. Expect a refusal and exit 3.\n");
    await pool.query(`UPDATE payroll_lines SET "netPay" = 0 WHERE false`);
    console.error("GUARD DID NOT FIRE -- the write was not refused. Do not trust this script.");
    process.exit(1);
  }

  const argIdx = process.argv.indexOf("--period");
  const periodId = argIdx >= 0 ? Number(process.argv[argIdx + 1]) : null;

  if (!periodId) {
    const { rows } = await pool.query(
      `SELECT p.id, to_char(p."periodStart",'YYYY-MM-DD') AS s, to_char(p."periodEnd",'YYYY-MM-DD') AS e,
              p.status, count(l.id)::int AS lines,
              to_char(max(l."computedAt") AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS computed
         FROM payroll_periods p LEFT JOIN payroll_lines l ON l."periodId" = p.id
        GROUP BY p.id, p."periodStart", p."periodEnd", p.status
        ORDER BY p."periodStart" DESC LIMIT 20`);
    console.log("Pick a period with --period <id>:\n");
    console.log("  id    period                    status        lines  last computed");
    for (const r of rows) {
      console.log("  " + String(r.id).padEnd(6) + (r.s + " .. " + r.e).padEnd(26)
        + String(r.status).padEnd(14) + String(r.lines).padEnd(7) + (r.computed || "-"));
    }
    console.log("\nAny period works -- nothing is written, so an Approved or Paid one is safe too.\n");
    await pool.end();
    return;
  }

  // ---- 1. is the feature actually inert on this database? -------------------
  const inert = (await pool.query(
    `SELECT (SELECT count(*) FROM payroll_line_overrides)::int AS overrides,
            (SELECT count(*) FROM audit_log WHERE action LIKE 'payroll_override%')::int AS audits`)).rows[0];
  console.log("1. INERTNESS");
  console.log("   payroll_line_overrides rows : " + inert.overrides
    + (inert.overrides === 0 ? "  (expected 0)" : "  <-- NOT ZERO"));
  console.log("   payroll_override* audits    : " + inert.audits
    + (inert.audits === 0 ? "  (expected 0)" : "  <-- NOT ZERO"));
  if (inert.overrides > 0) {
    console.log("\n   Note: overrides exist, so arm C below is a REAL substitution test,");
    console.log("   not an inertness test. Arms A and B still prove empty == absent.");
  }
  console.log("");

  // ---- 2. rebuild the compute route's read-only prefix, verbatim ------------
  const period = (await pool.query(
    `SELECT id, to_char("periodStart",'YYYY-MM-DD') AS "periodStart",
            to_char("periodEnd",'YYYY-MM-DD') AS "periodEnd", status
       FROM payroll_periods WHERE id = $1`, [periodId])).rows[0];
  if (!period) { console.error("No such period: " + periodId); await pool.end(); process.exit(1); }

  console.log("2. PERIOD " + period.id + "  " + period.periodStart + " .. "
    + period.periodEnd + "  [" + period.status + "]\n");

  const statutory = {};
  for (const r of (await pool.query(`SELECT key, config FROM payroll_statutory_config`)).rows) {
    statutory[r.key] = r.config;
  }
  const payRules = statutory.pay_rules || {};
  const isFirstCutoff = Number(String(period.periodStart).split("-")[2]) <= 15;

  const employees = (await pool.query(
    `SELECT * FROM employees WHERE "employmentStatus" = 'Active'`)).rows;
  const holidays = (await pool.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, name, type, sites, active
       FROM payroll_holidays WHERE active = true AND date >= $1::date AND date <= $2::date`,
    [period.periodStart, period.periodEnd])).rows;

  const { rows: attendanceRows } = await computeReport({
    from: phAddDays(period.periodStart, -7), to: period.periodEnd, site: null, guard: null,
    grace: payRules.graceMinutes ?? 15, otThreshold: payRules.otThresholdMinutes ?? 30,
  });
  const attendanceByEmployee = new Map();
  for (const r of attendanceRows) {
    if (r.employeeId == null) continue;
    if (!attendanceByEmployee.has(r.employeeId)) attendanceByEmployee.set(r.employeeId, []);
    attendanceByEmployee.get(r.employeeId).push(r);
  }

  const otByEmployee = new Map();
  for (const r of (await pool.query(
    `SELECT "employeeId", to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", SUM("approvedMinutes")::int mins
       FROM overtime_records WHERE status = 'Approved' AND "employeeId" IS NOT NULL
        AND "dutyDate" >= $1::date AND "dutyDate" <= $2::date GROUP BY "employeeId", "dutyDate"`,
    [period.periodStart, period.periodEnd])).rows) {
    if (!otByEmployee.has(r.employeeId)) otByEmployee.set(r.employeeId, new Map());
    otByEmployee.get(r.employeeId).set(r.dutyDate, r.mins);
  }

  const leaveByEmployee = new Map();
  for (const r of (await pool.query(
    `SELECT "employeeId", to_char("fromDate",'YYYY-MM-DD') AS "fromDate",
            to_char("toDate",'YYYY-MM-DD') AS "toDate", "totalDays", "paidDays"
       FROM leave_records
      WHERE status = 'Approved' AND "employeeId" IS NOT NULL
        AND "toDate" >= $1::date AND "fromDate" <= $2::date`,
    [period.periodStart, period.periodEnd])).rows) {
    if (!leaveByEmployee.has(r.employeeId)) leaveByEmployee.set(r.employeeId, []);
    leaveByEmployee.get(r.employeeId).push(r);
  }

  const catalogById = new Map(
    (await pool.query(`SELECT * FROM payroll_components`)).rows.map((c) => [c.id, c]));
  const assignmentsByEmployee = new Map();
  for (const a of (await pool.query(
    `SELECT * FROM payroll_employee_components WHERE active = true`)).rows) {
    if (!assignmentsByEmployee.has(a.employeeId)) assignmentsByEmployee.set(a.employeeId, []);
    assignmentsByEmployee.get(a.employeeId).push(a);
  }
  const arrearsByEmployee = new Map((await pool.query(
    `SELECT "employeeId", balance FROM payroll_employee_arrears`))
    .rows.map((r) => [r.employeeId, Number(r.balance)]));

  const overridesByEmployee = new Map();
  for (const r of (await pool.query(
    `SELECT id, "employeeId", "fieldName", "fieldClass", "computedValue",
            "overrideValue", status, "staleComputedValue"
       FROM payroll_line_overrides WHERE "periodId" = $1`, [period.id])).rows) {
    if (!overridesByEmployee.has(r.employeeId)) overridesByEmployee.set(r.employeeId, []);
    overridesByEmployee.get(r.employeeId).push(r);
  }

  // Stored lines + their MANUAL components. The route DELETEs auto rows and
  // re-INSERTs them before reading; read-only, the equivalent is the manual
  // rows plus resolveRecurringComponents(). That reconstruction feeds all three
  // arms identically, so it cannot affect the A/B/C verdict -- it matters only
  // to the advisory stored-line comparison in section 4.
  const storedLines = new Map((await pool.query(
    `SELECT * FROM payroll_lines WHERE "periodId" = $1`, [period.id]))
    .rows.map((r) => [r.employeeId, r]));
  const manualByLine = new Map();
  for (const r of (await pool.query(
    `SELECT c."lineId", c.name, c.kind, c.taxable, c.amount
       FROM payroll_line_components c JOIN payroll_lines l ON l.id = c."lineId"
      WHERE l."periodId" = $1 AND c.auto = false`, [period.id])).rows) {
    if (!manualByLine.has(r.lineId)) manualByLine.set(r.lineId, []);
    manualByLine.get(r.lineId).push({ name: r.name, kind: r.kind, taxable: r.taxable, amount: r.amount });
  }

  function inputsFor(emp) {
    const stored = storedLines.get(emp.id);
    const recurring = resolveRecurringComponents(
      assignmentsByEmployee.get(emp.id) || [], catalogById, isFirstCutoff);
    const components = (stored ? (manualByLine.get(stored.id) || []) : []).concat(recurring);
    return {
      employee: emp,
      attendanceRows: attendanceByEmployee.get(emp.id) || [],
      approvedOtByDate: otByEmployee.get(emp.id) || new Map(),
      leaveRecords: leaveByEmployee.get(emp.id) || [],
      isGuard: isGuardPosition(emp.position), components, statutory, isFirstCutoff,
      periodStart: period.periodStart, periodEnd: period.periodEnd, holidays,
      openingArrears: arrearsByEmployee.get(emp.id) || 0,
    };
  }

  // ---- 3. the claim: A (no arg) == B (empty map) == C (production's map) ----
  console.log("3. ENGINE A/B/C  --  same inputs, three override arguments");
  console.log("     A = no `overrides` key at all   (pre-stage-(ii) behaviour)");
  console.log("     B = overridesMapFor([])         (empty map)");
  console.log("     C = overridesMapFor(production) (whatever the table holds)\n");

  let checked = 0, abFail = 0, acFail = 0;
  const failures = [];
  for (const emp of employees) {
    const base = inputsFor(emp);
    const A = computeEmployeeLine({ ...base });
    const B = computeEmployeeLine({ ...base, overrides: overridesMapFor([]) });
    const C = computeEmployeeLine({ ...base, overrides: overridesMapFor(overridesByEmployee.get(emp.id)) });
    checked++;
    const ab = diffArms(A, B), ac = diffArms(A, C);
    if (ab.length) { abFail++; failures.push([emp, "A vs B", ab]); }
    if (ac.length) { acFail++; failures.push([emp, "A vs C", ac]); }
  }

  console.log("   active employees run through the engine : " + checked);
  console.log("   A vs B differences : " + abFail
    + (abFail === 0 ? "   PASS -- empty map is identical to no map" : "   FAIL"));
  console.log("   A vs C differences : " + acFail + (acFail === 0
    ? "   PASS -- production's override table changes nothing"
    : (inert.overrides > 0 ? "   (expected: overrides exist and are being applied)" : "   FAIL")));
  for (const [emp, arm, diffs] of failures.slice(0, 10)) {
    console.log("\n   " + arm + "  " + emp.employeeNo + " " + emp.fullName);
    for (const [f, x, y] of diffs) {
      console.log("      " + f.padEnd(24) + String(x).padStart(14) + "  ->  " + String(y));
    }
  }
  console.log("");

  // ---- 4. advisory: does the engine still reproduce the stored rows? --------
  console.log("4. ADVISORY  --  engine output vs the rows already stored");
  console.log("   A difference here is NOT necessarily a stage-(ii) regression: a period");
  console.log("   last computed before 08c7916 (night differential) or 1130415 (statutory");
  console.log("   cutoffs) SHOULD differ, because those commits deliberately moved figures.");
  console.log("   Read it beside the computedAt shown against each line.\n");
  let cmp = 0, moved = 0;
  const movers = [];
  for (const emp of employees) {
    const stored = storedLines.get(emp.id);
    if (!stored) continue;
    const A = computeEmployeeLine(inputsFor(emp));
    cmp++;
    const diffs = [];
    for (const [name, get] of FIELDS) {
      const want = get(A), have = stored[name];
      if (typeof want === "string") { if (want !== have) diffs.push([name, have, want]); }
      else if (!sameNum(want, have)) diffs.push([name, have, want]);
    }
    if (diffs.length) { moved++; movers.push([emp, stored, diffs]); }
  }
  console.log("   stored lines compared : " + cmp);
  console.log("   lines whose figures would move : " + moved
    + (moved === 0 ? "   (engine reproduces production exactly)" : ""));
  for (const [emp, stored, diffs] of movers.slice(0, 8)) {
    const at = stored.computedAt ? new Date(stored.computedAt).toISOString() : "never";
    console.log("\n   " + emp.employeeNo + " " + emp.fullName + "   last computed " + at);
    for (const [f, have, want] of diffs) {
      console.log("      " + f.padEnd(24) + "stored " + String(have).padStart(12) + "  ->  engine " + String(want));
    }
  }

  console.log("\n" + "=".repeat(74));
  const verdict = abFail === 0 && (acFail === 0 || inert.overrides > 0);
  console.log(verdict
    ? "VERDICT: PASS -- the override layer is inert on this data."
    : "VERDICT: FAIL -- see the A/B differences above. Do not proceed.");
  console.log(statements + " statements issued, all reads. Nothing was written.");
  console.log("=".repeat(74) + "\n");
  await pool.end();
  process.exit(verdict ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nERROR: " + e.message);
  console.error(e.stack);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
