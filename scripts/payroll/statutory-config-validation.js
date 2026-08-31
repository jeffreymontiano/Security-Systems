/**
 * Known Gap 22 -- statutory config validation.
 *
 * Two halves, and both matter:
 *
 *   A. The PURE suite. Drives validateStatutoryConfig() directly across every
 *      failure mode the gap named, and -- just as importantly -- across the
 *      legitimate zeros, because a validator that blocks a real tax-exempt
 *      bracket or a zero grace window would be edited away within a week.
 *      Also asserts STATUTORY_SEEDS passes its own validator, so the shipped
 *      defaults cannot drift out of the bands that guard them.
 *
 *   B. The LIVE SCAN. Runs the validator over the six config rows actually
 *      stored. READ ONLY -- one SELECT, no writes, no migration -- so it is
 *      safe against production. This is the diagnostic that would have caught
 *      the missing pagibig.employerRate before it reached a payslip.
 *
 * Usage:
 *   node scripts/payroll/statutory-config-validation.js
 *   node scripts/payroll/statutory-config-validation.js --scan-only
 *   node scripts/payroll/statutory-config-validation.js --scan-only --from-json <file>
 *
 * The live scan reads DATABASE_URL. It is deliberately not gated to dev: it
 * writes nothing, and production is the database whose answer is worth having.
 *
 * `--from-json` scans a file holding the result of this query instead, so the
 * scan can be run against a database whose credential is not in .env -- paste
 * the output of the Neon SQL Editor rather than putting a production URL on
 * disk. Expects a JSON array of { key, config, updatedBy, updatedAt }:
 *
 *   SELECT json_agg(t) FROM (
 *     SELECT key, config, "updatedBy",
 *            to_char("updatedAt",'YYYY-MM-DD HH24:MI') AS "updatedAt"
 *       FROM payroll_statutory_config ORDER BY key) t;
 */

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const { validateStatutoryConfig, describeErrors, CONFIG_KEYS } =
  require(path.join(ROOT, "src", "lib", "statutoryConfigRules"));

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
  ok ? pass++ : fail++;
}

// Accepts. Prints the refusals when it should not have refused.
function accepts(label, key, config) {
  const v = validateStatutoryConfig(key, config);
  check(label, v.ok, v.ok ? "" : describeErrors(key, v.errors));
}

// Refuses, AND names the field. A validator that refuses for the wrong reason
// is not protection -- it sends an admin to the wrong line of the table.
function refuses(label, key, config, field) {
  const v = validateStatutoryConfig(key, config);
  const named = !v.ok && v.errors.some((e) => e.field === field);
  check(label, named,
    v.ok ? "ACCEPTED -- nothing was refused"
         : `refused, but not on "${field}": ${v.errors.map((e) => e.field).join(", ")}`);
}

// ---- the good configs, from the shipped seeds -------------------------------

const GOOD = {
  philhealth: { ratePercent: 5, floor: 10000, ceiling: 100000 },
  pagibig: {
    employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500,
    employerRate: 0.02, salaryCap: 10000,
  },
  pay_rules: {
    otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30,
    sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second",
    withholdingTaxEnabled: true,
  },
  premium_rules: {
    nightDiffPercent: 0.1, nightStartHour: 22, nightEndHour: 6,
    regularHolidayWorked: 2, regularHolidayOt: 2.6, regularHolidayUnworkedPay: 1,
    requirePresenceDayBefore: true,
    specialDayWorked: 1.3, specialDayOt: 1.69, specialDayUnworkedPay: 0,
  },
  sss: {
    brackets: [
      { minMsc: 0, maxMsc: 5000, msc: 5000, ee: 250, er: 500, ec: 10 },
      { minMsc: 5001, maxMsc: 6500, msc: 6500, ee: 325, er: 650, ec: 10 },
      { minMsc: 6501, maxMsc: 8000, msc: 8000, ee: 400, er: 800, ec: 30 },
    ],
  },
  withholding_tax: {
    frequency: "semi-monthly",
    brackets: [
      { min: 0, max: 10416, base: 0, rate: 0 },
      { min: 10417, max: 16666, base: 0, rate: 0.15 },
      { min: 16667, max: null, base: 937.5, rate: 0.2 },
    ],
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const without = (key, field) => { const c = clone(GOOD[key]); delete c[field]; return c; };
const set = (key, field, v) => { const c = clone(GOOD[key]); c[field] = v; return c; };

function suite() {
  console.log("A. THE SHIPPED SHAPE IS ACCEPTED");
  for (const k of CONFIG_KEYS) accepts(`${k} (seed shape)`, k, GOOD[k]);

  console.log("\nB. FAILURE MODE -- ORDER OF MAGNITUDE (incident 1: PHP 2.14 against PHP 427.50)");
  refuses("philhealth.ratePercent = 0.025 (a fraction where a percent belongs)",
    "philhealth", set("philhealth", "ratePercent", 0.025), "ratePercent");
  refuses("philhealth.ratePercent = 500 (a percent entered as basis points)",
    "philhealth", set("philhealth", "ratePercent", 500), "ratePercent");
  refuses("pagibig.employerRate = 2 (a percent where a fraction belongs, 100x)",
    "pagibig", set("pagibig", "employerRate", 2), "employerRate");
  refuses("pay_rules.otMultiplier = 125 (a percent where a multiplier belongs)",
    "pay_rules", set("pay_rules", "otMultiplier", 125), "otMultiplier");
  // The one the bands are deliberately loose enough to allow.
  accepts("philhealth.ratePercent = 6 (a real legislated rate rise -- must NOT be blocked)",
    "philhealth", set("philhealth", "ratePercent", 6));

  console.log("\nC. FAILURE MODE -- A ZERO THAT IS NEVER LEGAL");
  refuses("pagibig.employerRate = 0 (incident 3, verbatim)",
    "pagibig", set("pagibig", "employerRate", 0), "employerRate");
  refuses("pagibig.salaryCap = 0 (base becomes 0, BOTH shares vanish)",
    "pagibig", set("pagibig", "salaryCap", 0), "salaryCap");
  refuses("pagibig.employeeRateLow = 0", "pagibig", set("pagibig", "employeeRateLow", 0), "employeeRateLow");
  refuses("philhealth.ratePercent = 0", "philhealth", set("philhealth", "ratePercent", 0), "ratePercent");
  refuses("philhealth.ceiling = 0 (clamps every base to 0)",
    "philhealth", set("philhealth", "ceiling", 0), "ceiling");
  refuses("pay_rules.otMultiplier = 0 (all overtime unpaid)",
    "pay_rules", set("pay_rules", "otMultiplier", 0), "otMultiplier");
  refuses("pay_rules.monthlyDivisor = 0 (zeroes the whole statutory block)",
    "pay_rules", set("pay_rules", "monthlyDivisor", 0), "monthlyDivisor");
  // The zero message must explain the CONSEQUENCE, not just the band.
  const zeroMsg = validateStatutoryConfig("pagibig", set("pagibig", "employerRate", 0))
    .errors.find((e) => e.field === "employerRate");
  check("...and the zero refusal says what a zero would have DONE",
    /agency's own Pag-IBIG share/.test(zeroMsg.why), zeroMsg && zeroMsg.why);

  console.log("\nD. FAILURE MODE -- MISSING REQUIRED KEY (the silent `|| 0` path)");
  refuses("pagibig with employerRate absent entirely",
    "pagibig", without("pagibig", "employerRate"), "employerRate");
  refuses("philhealth with ceiling absent (missing = uncapped, not merely blank)",
    "philhealth", without("philhealth", "ceiling"), "ceiling");
  refuses("pay_rules with pagibigCutoff absent",
    "pay_rules", without("pay_rules", "pagibigCutoff"), "pagibigCutoff");
  refuses("pay_rules with withholdingTaxEnabled absent",
    "pay_rules", without("pay_rules", "withholdingTaxEnabled"), "withholdingTaxEnabled");

  console.log("\nE. FAILURE MODE -- WRONG TYPE (the Number() coercion trap, incident 2)");
  for (const bad of [null, "", [], {}, true, "abc", NaN, Infinity]) {
    const shown = Number.isNaN(bad) ? "NaN" : bad === Infinity ? "Infinity" : JSON.stringify(bad);
    refuses(`pagibig.employerRate = ${shown}`,
      "pagibig", set("pagibig", "employerRate", bad), "employerRate");
  }
  accepts("...but a NUMERIC STRING is still accepted (the config screen posts strings)",
    "pagibig", set("pagibig", "employerRate", "0.02"));
  refuses("premium_rules.nightStartHour = 22.5 (an hour must be whole)",
    "premium_rules", set("premium_rules", "nightStartHour", 22.5), "nightStartHour");
  refuses("pay_rules.sssCutoff = 'both' (not a cutoff mode -- there is deliberately no such option)",
    "pay_rules", set("pay_rules", "sssCutoff", "both"), "sssCutoff");

  console.log("\nF. FAILURE MODE -- CROSS-FIELD INCOHERENCE");
  refuses("philhealth ceiling below floor",
    "philhealth", set("philhealth", "ceiling", 5000), "ceiling");
  refuses("pagibig high tier below low tier",
    "pagibig", set("pagibig", "employeeRateHigh", 0.005), "employeeRateHigh");

  console.log("\nG. FAILURE MODE -- BRACKET TABLES");
  refuses("sss with no brackets at all", "sss", { brackets: [] }, "brackets");
  refuses("sss brackets missing", "sss", {}, "brackets");
  refuses("sss bracket with ee = 0 (a bracket contributing nothing is not a bracket)",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[1].ee = 0; return c; })(), "brackets[1].ee");
  refuses("sss bracket with maxMsc below minMsc",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[1].maxMsc = 100; return c; })(),
    "brackets[1].maxMsc");
  refuses("sss brackets that OVERLAP",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[1].minMsc = 4000; return c; })(), "brackets");
  refuses("sss brackets with a GAP (a comp inside it falls to the LOWEST bracket)",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[1].minMsc = 5600; return c; })(), "brackets");
  refuses("sss bracket carrying an unrecognised column",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[0].eec = 10; return c; })(), "brackets[0].eec");
  refuses("withholding_tax with TWO open-ended top brackets",
    "withholding_tax",
    (() => { const c = clone(GOOD.withholding_tax); c.brackets[1].max = null; return c; })(), "brackets");
  refuses("withholding_tax where the open-ended bracket is NOT the highest",
    "withholding_tax",
    (() => {
      const c = clone(GOOD.withholding_tax);
      c.brackets[2].max = 30000;
      c.brackets[0].max = null;
      return c;
    })(), "brackets");
  refuses("withholding_tax rate = 0.9 (90% -- a fraction/percent slip)",
    "withholding_tax",
    (() => { const c = clone(GOOD.withholding_tax); c.brackets[1].rate = 0.9; return c; })(),
    "brackets[1].rate");
  refuses("sss brackets not a list at all",
    "sss", { brackets: "21 rows" }, "brackets");

  console.log("\nH. THE LEGITIMATE ZEROS (CLAUDE.md section 4) MUST STAY ALLOWED");
  accepts("withholding_tax bottom bracket base 0 / rate 0 -- the tax-exempt band IS zero",
    "withholding_tax", GOOD.withholding_tax);
  accepts("pay_rules.graceMinutes = 0 (no grace window is a real setting)",
    "pay_rules", set("pay_rules", "graceMinutes", 0));
  accepts("pay_rules.otThresholdMinutes = 0 (every minute of OT counts)",
    "pay_rules", set("pay_rules", "otThresholdMinutes", 0));
  accepts("premium_rules.specialDayUnworkedPay = 0 -- the SEEDED, CORRECT value",
    "premium_rules", GOOD.premium_rules);
  accepts("philhealth.floor = 0 (no floor)", "philhealth", set("philhealth", "floor", 0));
  accepts("pagibig.threshold = 0 (everyone on the high tier)",
    "pagibig", set("pagibig", "threshold", 0));
  accepts("pay_rules.withholdingTaxEnabled = false -- tax off comes from the TOGGLE, "
    + "never from a zeroed rate", "pay_rules", set("pay_rules", "withholdingTaxEnabled", false));
  accepts("sss bracket ec = 0 (EC is not read by the engine yet -- Gap 30)",
    "sss", (() => { const c = clone(GOOD.sss); c.brackets[0].ec = 0; return c; })());
  accepts("premium_rules.nightEndHour = 0 (midnight is a valid hour)",
    "premium_rules", set("premium_rules", "nightEndHour", 0));

  console.log("\nI. TYPOS AND UNKNOWN KEYS ARE NAMED, NOT SILENTLY IGNORED");
  refuses("pagibig with 'employerrate' (lower-case r) -- the engine would ignore it",
    "pagibig",
    (() => { const c = without("pagibig", "employerRate"); c.employerrate = 0.02; return c; })(),
    "employerrate");
  check("...and the SAME save also reports employerRate as missing", (() => {
    const c = without("pagibig", "employerRate");
    c.employerrate = 0.02;
    const v = validateStatutoryConfig("pagibig", c);
    return !v.ok && v.errors.some((e) => e.field === "employerRate");
  })());

  console.log("\nJ. THE REPLY NAMES EVERY FAILING FIELD, NOT JUST THE FIRST");
  const many = clone(GOOD.pagibig);
  many.employerRate = 0;
  many.salaryCap = 0;
  delete many.threshold;
  const v = validateStatutoryConfig("pagibig", many);
  check("three broken fields produce three errors", v.errors.length === 3,
    JSON.stringify(v.errors.map((e) => e.field)));
  const msg = describeErrors("pagibig", v.errors);
  check("...and the banner string (body.error) names all three",
    ["employerRate", "salaryCap", "threshold"].every((f) => msg.includes(f)), msg);

  console.log("\nK. AN UNKNOWN CONFIG KEY IS STILL REFUSED");
  refuses("key 'sss_2026'", "sss_2026", GOOD.sss, "key");
  refuses("config is an array", "pagibig", [], "config");
  refuses("config is null", "pagibig", null, "config");

  console.log("\nL. STATUTORY_SEEDS PASSES ITS OWN VALIDATOR");
  // Read from db.js WITHOUT importing it: `require("../db")` runs migrate() as
  // an import side effect (Known Gap 27), which would put DDL on whatever
  // DATABASE_URL points at. The seeds are parsed out of the source instead.
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "src", "db.js"), "utf8");
  for (const key of CONFIG_KEYS) {
    const re = new RegExp(`\\n\\s{4}${key}:\\s*\\{`);
    check(`${key} appears in STATUTORY_SEEDS`, re.test(src));
  }
  // The shapes above ARE the seeds, field for field, other than the SSS and
  // withholding bracket rows being abridged to three. Assert that equivalence
  // rather than implying it: every seeded scalar must appear in GOOD.
  for (const [key, cfg] of Object.entries(GOOD)) {
    if (cfg.brackets) continue;
    const block = src.slice(src.indexOf(`\n    ${key}: {`));
    const missing = Object.keys(cfg).filter((f) => !block.slice(0, 700).includes(`${f}:`));
    check(`${key}: every field in this fixture is a real seeded field`, missing.length === 0,
      "not found in the seed block: " + missing.join(", "));
  }
}

// ---- B. the live scan (READ ONLY) -------------------------------------------

async function readLiveRows(fromJson) {
  if (fromJson) {
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(fromJson, "utf8"));
    // Accept the bare array, or a one-row Neon result wrapping it.
    const rows = Array.isArray(raw) ? raw
      : Array.isArray(raw?.json_agg) ? raw.json_agg
      : Array.isArray(raw?.[0]?.json_agg) ? raw[0].json_agg
      : null;
    if (!rows) throw new Error("--from-json: expected a JSON array of config rows");
    return { rows, label: `FILE ${path.basename(fromJson)}` };
  }
  const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const host = new URL(url).hostname;
  const which = host.includes("ep-sweet-bread-aoiz7aup") ? "PRODUCTION"
    : host.includes("ep-winter-thunder-aoowdb3y") ? "dev" : "UNRECOGNISED";
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      `SELECT key, config, "updatedBy", to_char("updatedAt",'YYYY-MM-DD HH24:MI') AS "updatedAt"
         FROM payroll_statutory_config ORDER BY key`
    );
    return { rows, label: `${which} (${host})` };
  } finally {
    await pool.end();
  }
}

async function liveScan(fromJson) {
  const got = await readLiveRows(fromJson);
  if (!got) {
    console.log("\nLIVE SCAN SKIPPED -- no DATABASE_URL and no --from-json");
    return 0;
  }
  const { rows, label } = got;
  console.log(`\n=== LIVE CONFIG SCAN -- ${label} ===`);
  console.log("READ ONLY: one SELECT, no writes, no migration.\n");

  let broken = 0;
  {
    const seen = new Set(rows.map((r) => r.key));
    for (const key of CONFIG_KEYS) {
      if (!seen.has(key)) {
        console.log(`  MISSING   ${key} -- no row at all; the engine reads undefined for every field`);
        broken++;
      }
    }
    for (const r of rows) {
      const v = validateStatutoryConfig(r.key, r.config);
      if (v.ok) {
        console.log(`  OK        ${r.key.padEnd(16)} (last set by ${r.updatedBy || "seed"}${r.updatedAt ? " on " + r.updatedAt : ""})`);
      } else {
        broken++;
        console.log(`  BROKEN    ${r.key.padEnd(16)} (last set by ${r.updatedBy || "seed"}${r.updatedAt ? " on " + r.updatedAt : ""})`);
        for (const e of v.errors) console.log(`            - ${e.field} ${e.why}; expected ${e.expected}`);
      }
    }
  }
  console.log(broken === 0
    ? "\n  All six live config rows pass."
    : `\n  ${broken} live config row(s) would be REFUSED by this validator.`);
  return broken;
}

async function main() {
  const scanOnly = process.argv.includes("--scan-only");
  const i = process.argv.indexOf("--from-json");
  const fromJson = i > -1 ? process.argv[i + 1] : null;
  if (!scanOnly) {
    suite();
    console.log(`\n${pass} passed, ${fail} failed`);
  }
  const broken = await liveScan(fromJson);
  process.exit(fail || broken ? 1 : 0);
}

main().catch((e) => { console.error("\nERROR: " + e.message); console.error(e.stack); process.exit(1); });
