/**
 * Gap 30 Phase 2 -- the monthly statutory remittance report.
 *
 * PURE: drives buildRemittance() directly. No DB, no server, and it sets the
 * statutory config it depends on rather than inheriting it (Known Gap 21).
 *
 * The load-bearing assertion is that a PENDING agency never produces a NUMBER.
 * Every configured agency is expected every month, so a zero would be
 * indistinguishable from a genuine nil return -- and in a spreadsheet a SUM()
 * would sweep it straight into a filing.
 *
 * Usage:
 *   node scripts/payroll/remittance.js
 *   node scripts/payroll/remittance.js --from-json <file>   (read-only scan of a
 *       pasted { periods, lines, employees, statutory } dump, so the report can
 *       be run against a database whose credential is not in .env)
 */

const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const {
  buildRemittance, PENDING_TOTAL_TEXT, monthLabel, isValidMonth,
} = require(path.join(ROOT, "src", "lib", "remittanceReport"));

let pass = 0, fail = 0;
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.005;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
  ok ? pass++ : fail++;
}
const agency = (rep, key) => rep.agencies.find((a) => a.key === key);

const STATUTORY = (cutoffs = {}) => ({
  sss: {
    brackets: [
      { minMsc: 0, maxMsc: 5000, msc: 5000, ee: 250, er: 500, ec: 10 },
      { minMsc: 5001, maxMsc: 20000, msc: 18500, ee: 925, er: 1850, ec: 30 },
    ],
  },
  pay_rules: {
    monthlyDivisor: 30,
    sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second",
    ...cutoffs,
  },
});

const EMPLOYEES = [
  { id: 1, sssNo: "34-1111111-1", philhealthNo: "PH-1", pagibigNo: "PI-1" },
  { id: 2, sssNo: "34-2222222-2", philhealthNo: "PH-2", pagibigNo: "PI-2" },
  { id: 3, sssNo: "", philhealthNo: "PH-3", pagibigNo: "PI-3" }, // no SSS number
];

const line = (o) => ({
  employeeId: o.id, employeeNo: `E${o.id}`, employeeName: o.name || `Guard ${o.id}`,
  payType: "Daily", rateUsed: 570,
  sssEe: o.sssEe ?? 925, sssEr: o.sssEr ?? 1850, sssEc: o.sssEc ?? 30,
  philhealthEe: o.phEe ?? 427.5, philhealthEr: o.phEr ?? 427.5,
  pagibigEe: o.piEe ?? 200, pagibigEr: o.piEr ?? 200,
  ...o.over,
});

const P1 = { id: 101, periodStart: "2026-08-01", periodEnd: "2026-08-15", status: "Approved" };
const P2 = { id: 102, periodStart: "2026-08-16", periodEnd: "2026-08-31", status: "Approved" };

function suite() {
  console.log("1. A READY MONTH RECONCILES\n");
  const ready = buildRemittance({
    month: "2026-08", periods: [P1, P2],
    linesByPeriod: { 102: [line({ id: 1 }), line({ id: 2 })] },
    employees: EMPLOYEES, statutory: STATUTORY(),
  });
  for (const key of ["sss", "philhealth", "pagibig"]) {
    const a = agency(ready, key);
    check(`${a.label} is READY`, a.status === "ready", a.pendingReason || "");
    const summed = r2(a.rows.reduce((s, r) => s + r.ee + r.er + (a.hasEc ? r.ec : 0), 0));
    check(`${a.label} total == sum of EE + ER${a.hasEc ? " + EC" : ""} across the assigned cutoff`,
      near(a.total, summed), `total ${a.total} vs summed ${summed}`);
    check(`${a.label} total == totalEe + totalEr${a.hasEc ? " + totalEc" : ""}`,
      near(a.total, r2(a.totalEe + a.totalEr + (a.hasEc ? a.totalEc : 0))),
      `${a.total} vs ${a.totalEe}+${a.totalEr}+${a.totalEc ?? 0}`);
  }
  const sss = agency(ready, "sss");
  check("SSS totals are the real figures (2 guards x 925/1850/30)",
    near(sss.totalEe, 1850) && near(sss.totalEr, 3700) && near(sss.totalEc, 60) && near(sss.total, 5610),
    `ee ${sss.totalEe} er ${sss.totalEr} ec ${sss.totalEc} total ${sss.total}`);
  check("MSC is resolved from the bracket (570/day x 30 = 17,100 -> msc 18,500)",
    sss.rows.every((r) => r.msc === 18500), JSON.stringify(sss.rows.map((r) => r.msc)));
  check("only the SECOND cutoff was used (mode 'second')",
    sss.cutoffsUsed.length === 1 && sss.cutoffsUsed[0].which === "second",
    JSON.stringify(sss.cutoffsUsed.map((c) => c.which)));

  console.log("\n2. A PENDING AGENCY RENDERS STATUS AND NO NUMERIC TOTAL\n");
  // Only the FIRST cutoff exists; every agency is configured 'second'.
  const pending = buildRemittance({
    month: "2026-08", periods: [P1],
    linesByPeriod: { 101: [line({ id: 1 })] },
    employees: EMPLOYEES, statutory: STATUTORY(),
  });
  for (const key of ["sss", "philhealth", "pagibig"]) {
    const a = agency(pending, key);
    check(`${a.label} is PENDING`, a.status === "pending", a.status);
    check(`${a.label} total is null -- NOT 0`, a.total === null, JSON.stringify(a.total));
    check(`${a.label} total is not a number at all (a SUM() cannot reach it)`,
      typeof a.total !== "number", typeof a.total);
    check(`${a.label} names its cause`,
      /2nd-cutoff period not found/.test(a.pendingReason || ""), a.pendingReason);
    check(`${a.label} renders no rows and no totals`,
      a.rows.length === 0 && a.totalEe === undefined, `${a.rows.length} rows`);
  }

  console.log("\n3. PER-AGENCY INDEPENDENCE (the whole point)\n");
  // SSS on the FIRST cutoff (which does not exist); the other two on the second
  // (which does). PhilHealth and Pag-IBIG must render fully regardless.
  const mixed = buildRemittance({
    month: "2026-08", periods: [P2],
    linesByPeriod: { 102: [line({ id: 1 }), line({ id: 2 })] },
    employees: EMPLOYEES, statutory: STATUTORY({ sssCutoff: "first" }),
  });
  check("SSS is PENDING (its 1st-cutoff period does not exist)",
    agency(mixed, "sss").status === "pending", agency(mixed, "sss").status);
  check("...and says so specifically", /1st-cutoff period not found/.test(agency(mixed, "sss").pendingReason || ""),
    agency(mixed, "sss").pendingReason);
  check("PhilHealth is READY anyway -- no wholesale refusal",
    agency(mixed, "philhealth").status === "ready" && agency(mixed, "philhealth").total > 0,
    JSON.stringify(agency(mixed, "philhealth").total));
  check("Pag-IBIG is READY anyway",
    agency(mixed, "pagibig").status === "ready" && agency(mixed, "pagibig").total > 0);

  console.log("\n4. 'PERIOD EXISTS BUT NOT COMPUTED' IS A DIFFERENT CAUSE\n");
  const draft = buildRemittance({
    month: "2026-08", periods: [{ ...P2, status: "Draft" }],
    linesByPeriod: {}, employees: EMPLOYEES, statutory: STATUTORY(),
  });
  check("a Draft period reads as pending, not as zero",
    agency(draft, "sss").status === "pending" && agency(draft, "sss").total === null);
  check("...and the reason says to run Compute",
    /not computed - run Compute/.test(agency(draft, "sss").pendingReason || ""),
    agency(draft, "sss").pendingReason);
  const noLines = buildRemittance({
    month: "2026-08", periods: [P2], linesByPeriod: { 102: [] },
    employees: EMPLOYEES, statutory: STATUTORY(),
  });
  check("a computed period holding no lines is also pending, not zero",
    agency(noLines, "sss").status === "pending" && agency(noLines, "sss").total === null,
    agency(noLines, "sss").pendingReason);

  console.log("\n5. MEMBER-ID EXCLUSION -- LISTED, NOT SILENTLY DROPPED\n");
  const excl = buildRemittance({
    month: "2026-08", periods: [P2],
    linesByPeriod: { 102: [line({ id: 1 }), line({ id: 3 })] },
    employees: EMPLOYEES, statutory: STATUTORY(),
  });
  const es = agency(excl, "sss");
  check("the guard with no SSS number is in `excluded`",
    es.excluded.length === 1 && es.excluded[0].employeeId === 3,
    JSON.stringify(es.excluded.map((r) => r.employeeId)));
  check("...and NOT in the rows", !es.rows.some((r) => r.employeeId === 3));
  check("...and NOT in the total (one guard's worth, not two)",
    near(es.total, 2805), `total ${es.total}`);
  check("...and a warning names the omission", es.warnings.some((w) => w.kind === "missing_member_id"),
    JSON.stringify(es.warnings.map((w) => w.kind)));
  check("the SAME guard IS counted by PhilHealth, where they do have a number",
    agency(excl, "philhealth").rows.some((r) => r.employeeId === 3),
    "member-ID exclusion must be per agency, not global");

  console.log("\n6. SECTION 3a -- THE SPLIT PARTIAL-MONTH GUARD\n");
  const splitBoth = buildRemittance({
    month: "2026-08", periods: [P1, P2],
    linesByPeriod: {
      101: [line({ id: 1, sssEe: 462.5, sssEr: 925, sssEc: 15 }), line({ id: 2, sssEe: 462.5, sssEr: 925, sssEc: 15 })],
      102: [line({ id: 1, sssEe: 462.5, sssEr: 925, sssEc: 15 }), line({ id: 2, sssEe: 462.5, sssEr: 925, sssEc: 15 })],
    },
    employees: EMPLOYEES, statutory: STATUTORY({ sssCutoff: "split" }),
  });
  const sb = agency(splitBoth, "sss");
  check("split with BOTH cutoffs complete is READY and NOT flagged",
    sb.status === "ready" && sb.incomplete === false,
    `status ${sb.status} incomplete ${sb.incomplete}`);
  check("...and the halves sum to the month (925 EE per guard, 2 guards)",
    near(sb.totalEe, 1850) && near(sb.totalEc, 60), `ee ${sb.totalEe} ec ${sb.totalEc}`);
  check("...the guard stays SILENT when nothing is partial",
    !sb.warnings.some((w) => w.kind === "split_partial_month"));

  const splitPartial = buildRemittance({
    month: "2026-08", periods: [P1, P2],
    linesByPeriod: {
      101: [line({ id: 1, sssEe: 462.5, sssEr: 925, sssEc: 15 }), line({ id: 2, sssEe: 462.5, sssEr: 925, sssEc: 15 })],
      102: [line({ id: 1, sssEe: 462.5, sssEr: 925, sssEc: 15 })], // guard 2 absent from the 2nd half
    },
    employees: EMPLOYEES, statutory: STATUTORY({ sssCutoff: "split" }),
  });
  const sp = agency(splitPartial, "sss");
  check("split with a guard in only ONE cutoff FIRES the guard",
    sp.incomplete === true, `incomplete ${sp.incomplete}`);
  check("...with a named warning", sp.warnings.some((w) => w.kind === "split_partial_month"),
    JSON.stringify(sp.warnings.map((w) => w.kind)));
  check("...naming the affected count", /1 employee\(s\)/.test(
    (sp.warnings.find((w) => w.kind === "split_partial_month") || {}).text || ""));
  check("...and it is still READY with a figure (this is not PENDING -- the data exists)",
    sp.status === "ready" && typeof sp.total === "number", `${sp.status} ${sp.total}`);
  check("a NON-split mode never fires the 3a guard, even with uneven cutoffs",
    agency(buildRemittance({
      month: "2026-08", periods: [P1, P2],
      linesByPeriod: { 101: [line({ id: 1 })], 102: [line({ id: 1 }), line({ id: 2 })] },
      employees: EMPLOYEES, statutory: STATUTORY(),
    }), "sss").incomplete === false);

  console.log("\n7. STALE-EC DETECTION (Phase 1 caveat)\n");
  const stale = buildRemittance({
    month: "2026-08", periods: [P2],
    linesByPeriod: { 102: [line({ id: 1, sssEc: 0 }), line({ id: 2 })] },
    employees: EMPLOYEES, statutory: STATUTORY(),
  });
  const st = agency(stale, "sss");
  check("a line with EC 0 against an ec-charging bracket is detected",
    st.warnings.some((w) => w.kind === "stale_ec"), JSON.stringify(st.warnings.map((w) => w.kind)));
  check("...and the warning says to recompute",
    /Recompute the SSS cutoff period/.test((st.warnings.find((w) => w.kind === "stale_ec") || {}).text || ""));
  check("a fully post-EC month raises NO stale warning",
    !agency(ready, "sss").warnings.some((w) => w.kind === "stale_ec"));
  check("a guard with no SSS contribution at all is not mistaken for stale",
    !agency(buildRemittance({
      month: "2026-08", periods: [P2],
      linesByPeriod: { 102: [line({ id: 1, sssEe: 0, sssEr: 0, sssEc: 0 })] },
      employees: EMPLOYEES, statutory: STATUTORY(),
    }), "sss").warnings.some((w) => w.kind === "stale_ec"),
    "EE of 0 means no contribution, not a missing EC");

  console.log("\n8. INPUT GUARDS\n");
  check("isValidMonth accepts 2026-08", isValidMonth("2026-08"));
  for (const bad of ["2026-13", "2026-8", "26-08", "", null, "2026-00"]) {
    check(`isValidMonth rejects ${JSON.stringify(bad)}`, !isValidMonth(bad));
  }
  check("monthLabel renders a real month name", monthLabel("2026-08") === "August 2026", monthLabel("2026-08"));
  const empty = buildRemittance({ month: "2026-09", periods: [], linesByPeriod: {}, employees: [], statutory: STATUTORY() });
  check("a month with NO periods is three pendings, no zeros",
    empty.agencies.every((a) => a.status === "pending" && a.total === null));
  check("PENDING_TOTAL_TEXT is shared, so PDF and Excel cannot disagree",
    typeof PENDING_TOTAL_TEXT === "string" && PENDING_TOTAL_TEXT.length > 0);
}

// Neon's SQL Editor exports a json_build_object result as
// [{ "json_build_object": "<the JSON, as an escaped STRING>" }]. Unwrapping it
// here means the documented query's output can be fed in verbatim, with no
// hand-editing of the file -- which is the point: a human reformatting a
// production dump before it is checked is a chance to introduce the very error
// the check exists to find.
function unwrap(raw) {
  let v = raw;
  if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === "object") {
    const keys = Object.keys(v[0]);
    if (keys.length === 1) v = v[0][keys[0]];
  } else if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && /^json_/.test(keys[0])) v = v[keys[0]];
  }
  if (typeof v === "string") v = JSON.parse(v);
  return v;
}

function scan(file) {
  const raw = unwrap(JSON.parse(fs.readFileSync(file, "utf8")));
  const linesByPeriod = {};
  for (const l of raw.lines || []) (linesByPeriod[l.periodId] ||= []).push(l);
  const rep = buildRemittance({
    month: raw.month, periods: raw.periods || [], linesByPeriod,
    employees: raw.employees || [], statutory: raw.statutory || {},
  });
  console.log(`=== REMITTANCE SCAN -- ${monthLabel(rep.month)} (READ ONLY, from ${path.basename(file)}) ===\n`);
  console.log("periods found: " + JSON.stringify(rep.periodsFound.map(
    (p) => `#${p.id} ${p.periodStart}..${p.periodEnd} ${p.status} [${p.cutoff}]`)) + "\n");
  for (const a of rep.agencies) {
    if (a.status === "pending") {
      console.log(`  ${a.label.padEnd(11)} ${PENDING_TOTAL_TEXT}`);
      console.log(`  ${" ".repeat(11)} cutoff mode "${a.cutoffMode}" -- ${a.pendingReason}`);
      console.log(`  ${" ".repeat(11)} total rendered as: ${JSON.stringify(a.total)}  (typeof ${typeof a.total})\n`);
    } else {
      console.log(`  ${a.label.padEnd(11)} READY   ${a.rows.length} employees, cutoff mode "${a.cutoffMode}"`);
      console.log(`  ${" ".repeat(11)} EE ${a.totalEe}  ER ${a.totalEr}`
        + (a.hasEc ? `  EC ${a.totalEc}` : "") + `  =>  TOTAL ${a.total}`
        + (a.incomplete ? "  (INCOMPLETE)" : ""));
      if (a.excluded.length) console.log(`  ${" ".repeat(11)} excluded (no ${a.idLabel}): ${a.excluded.length}`);
      for (const w of a.warnings) console.log(`  ${" ".repeat(11)} ! ${w.text}`);
      console.log("");
    }
  }
}

const i = process.argv.indexOf("--from-json");
if (i > -1) { scan(process.argv[i + 1]); }
else { suite(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
