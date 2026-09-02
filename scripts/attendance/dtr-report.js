/**
 * DTR report — unit suite for src/lib/dtrReport.js, plus an optional
 * reconciliation against whatever attendance the connected database holds.
 *
 * The pure half needs no database and is the part that must never regress:
 *
 *   1. A STRAIGHT DUTY puts both its 12s on its START date, filling DS and NS,
 *      and touches no other date. This is the whole reason the module exists in
 *      this shape -- carrying the second 12 onto the following day manufactures
 *      a same-band collision with that day's own night shift, which was measured
 *      on real data at 12 hours understated per occurrence.
 *   2. TWO BANDS absorb a guard's second duty on one date.
 *   3. ZERO-DUTY codes (DO / A / RTU / leave) count toward neither Days nor
 *      Hours.
 *   4. checkDtr() actually CATCHES a broken invariant -- the control that proves
 *      the other assertions are not passing vacuously.
 *   5. The DS/NS inference reads the PUNCH on an unrostered day, at a 17:00
 *      boundary, because a guard on an 18:00 shift clocks in at 17:42-17:52.
 *
 * Run:  node scripts/attendance/dtr-report.js
 *       node scripts/attendance/dtr-report.js --reconcile 2026-08-16 2026-08-31
 *
 * --reconcile is READ-ONLY and refuses to run against production.
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const {
  buildDtr, checkDtr, bandOf, zeroDutyCode, periodTitle, LEAVE_CODES, LEGEND, HOURS_PER_DUTY,
} = require(path.join(ROOT, "src", "lib", "dtrReport.js"));

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);

const FROM = "2026-08-16", TO = "2026-08-31";
const row = (o) => ({ status: "Present", site: "POST", guardName: "G", ...o });
const cellOn = (dtr, date) =>
  dtr.sites[0].guards[0].cells.find((c) => c.date === date);

console.log("1. STRAIGHT DUTY -- both 12s on the start date, nothing carried\n");
{
  const dtr = buildDtr({
    rows: [row({ dutyDate: "2026-08-20", shiftKind: "Straight", startTime: "06:00", endTime: "06:00", crossesMidnight: true })],
    from: FROM, to: TO, siteMeta: [],
  });
  const g = dtr.sites[0].guards[0];
  eq("start date fills BOTH bands", [cellOn(dtr, "2026-08-20").ds, cellOn(dtr, "2026-08-20").ns], ["12", "12"]);
  eq("the FOLLOWING date is untouched", [cellOn(dtr, "2026-08-21").ds, cellOn(dtr, "2026-08-21").ns], [null, null]);
  eq("counts 2.0 days / 24 hours", [g.ds, g.ns, g.days, g.hours], [1, 1, 2, 24]);
  eq("no contention", dtr.contention, []);
  eq("the tour is reported", dtr.straightTours.length, 1);
}
{
  // The boundary case the start-date rule removes: a tour on the LAST day.
  const dtr = buildDtr({
    rows: [row({ dutyDate: TO, shiftKind: "Straight", startTime: "06:00", endTime: "06:00", crossesMidnight: true })],
    from: FROM, to: TO, siteMeta: [],
  });
  const g = dtr.sites[0].guards[0];
  eq("a tour on the LAST day still counts 2.0 days (nothing is lost to the next cutoff)",
    [g.days, g.hours], [2, 24]);
}

console.log("\n2. THE TWO BANDS ABSORB A SECOND DUTY ON ONE DATE\n");
{
  const dtr = buildDtr({
    rows: [
      row({ dutyDate: "2026-08-20", shiftKind: "Day", startTime: "06:00", endTime: "18:00" }),
      row({ dutyDate: "2026-08-20", shiftKind: "Night", startTime: "18:00", endTime: "06:00", crossesMidnight: true }),
    ],
    from: FROM, to: TO, siteMeta: [],
  });
  const g = dtr.sites[0].guards[0];
  eq("a day shift and a night shift on one date", [g.ds, g.ns, g.days, g.hours], [1, 1, 2, 24]);
  eq("neither was dropped", dtr.contention, []);
}
{
  // Two duties that genuinely want the SAME band must be reported, not lost.
  const dtr = buildDtr({
    rows: [
      row({ dutyDate: "2026-08-20", shiftKind: "Night", startTime: "18:00", endTime: "06:00", crossesMidnight: true }),
      row({ dutyDate: "2026-08-20", shiftKind: "Night", startTime: "18:00", endTime: "06:00", crossesMidnight: true }),
    ],
    from: FROM, to: TO, siteMeta: [],
  });
  check("a same-band clash is REPORTED rather than silently dropped", dtr.contention.length === 1,
    JSON.stringify(dtr.contention));
  check("...and checkDtr surfaces it", checkDtr(dtr).some((p) => /two duties in the NS band/.test(p)));
}

console.log("\n3. ZERO-DUTY CODES COUNT TOWARD NOTHING\n");
{
  const cases = [
    ["Rest Day", {}, "DO"],
    ["RTU", {}, "RTU"],
    ["Absent", {}, "A"],
    ["On Leave", { leaveType: "Vacation Leave" }, "VL"],
    ["On Leave", { leaveType: "Sick Leave" }, "SL"],
    ["On Leave", { leaveType: "Emergency Leave" }, "EL"],
    ["On Leave", { leaveType: "Paternity Leave" }, "PL"],
    ["On Leave", { leaveType: "Maternity Leave" }, "ML"],
    ["On Leave", { leaveType: "Bereavement Leave" }, "BL"],
    ["On Leave", { leaveType: "Maternity/Paternity Leave" }, "M/P"],
    ["On relief at OTHER", {}, "REL"],
    ["Pending site review", {}, "SR"],
  ];
  for (const [status, extra, want] of cases) {
    eq(`${status}${extra.leaveType ? ` (${extra.leaveType})` : ""} -> ${want}`,
      zeroDutyCode({ status, ...extra }), want);
  }
  const dtr = buildDtr({
    rows: cases.map(([status, extra], i) =>
      row({ dutyDate: `2026-08-${16 + i}`, status, ...extra })),
    from: FROM, to: TO, siteMeta: [],
  });
  const g = dtr.sites[0].guards[0];
  eq("none of them count", [g.ds, g.ns, g.days, g.hours], [0, 0, 0, 0]);
  eq("and the per-day man-hour row stays empty",
    dtr.sites[0].perDayHours.reduce((a, b) => a + b, 0), 0);
  check("every legend code is reachable",
    LEGEND.every(([c]) => c === "12" || Object.values(LEAVE_CODES).includes(c) || ["DO", "A", "RTU"].includes(c)),
    LEGEND.map((l) => l[0]).join(" "));
}

console.log("\n4. CONTROL -- checkDtr must FAIL a grid that does not foot\n");
{
  const dtr = buildDtr({
    rows: [row({ dutyDate: "2026-08-20", shiftKind: "Day", startTime: "06:00", endTime: "18:00" })],
    from: FROM, to: TO, siteMeta: [],
  });
  check("a sound grid passes", checkDtr(dtr).length === 0, JSON.stringify(checkDtr(dtr)));
  // Corrupt it the way a real arithmetic bug would.
  dtr.sites[0].totals.hours += HOURS_PER_DUTY;
  check("...and a corrupted one is CAUGHT (proves the checks are live)",
    checkDtr(dtr).some((p) => /Hours/.test(p)), JSON.stringify(checkDtr(dtr)));
}

console.log("\n5. DS/NS INFERENCE ON AN UNROSTERED DAY -- from the punch, at 17:00\n");
{
  // A PH wall-clock time as the UTC instant it actually is. Built by Date
  // arithmetic rather than by subtracting 8 from the hour string: 02:00 PH is
  // the PREVIOUS UTC day, and the naive form yields "-6" and an invalid date.
  const t = (d, hm) => new Date(Date.parse(`${d}T${hm}:00.000Z`) - 8 * 3600 * 1000).toISOString();
  eq("rostered Day -> DS", bandOf({ shiftKind: "Day", startTime: "06:00" }), "DS");
  eq("rostered Night -> NS", bandOf({ shiftKind: "Night", startTime: "18:00", crossesMidnight: true }), "NS");
  eq("unrostered, IN 06:00 -> DS", bandOf({ timeIn: t("2026-08-20", "06:00") }), "DS");
  // The measured cases: an early arrival before an 18:00 shift. At an 18:00
  // boundary all three of these read as day shifts, which is the defect.
  eq("unrostered, IN 17:42 -> NS", bandOf({ timeIn: t("2026-08-20", "17:42") }), "NS");
  eq("unrostered, IN 17:52 -> NS", bandOf({ timeIn: t("2026-08-20", "17:52") }), "NS");
  eq("unrostered, IN 02:00 -> NS", bandOf({ timeIn: t("2026-08-20", "02:00") }), "NS");
  eq("unrostered, OUT-only 06:02 -> NS", bandOf({ timeOut: t("2026-08-20", "06:02") }), "NS");
  eq("unrostered, OUT-only 18:00 -> DS", bandOf({ timeOut: t("2026-08-20", "18:00") }), "DS");
}

console.log("\n6. PERIOD WORDING -- the server and the picker must not drift\n");
{
  // The PDF prints this; the cutoff picker builds its option labels from the
  // frontend copy before any request is made. Two implementations, asserted
  // equal here -- the same arrangement PENDING_TOTAL_TEXT has, because the
  // frontend cannot import from src/.
  const uiSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "lib", "payrollPeriods.js"), "utf8");
  const uiTitle = new Function(uiSrc.replace(/^export /gm, "") + "\nreturn periodTitle;")();
  for (const c of [
    { from: "2026-08-16", to: "2026-08-31" },
    { from: "2026-08-01", to: "2026-08-15" },
    { from: "2026-02-16", to: "2026-02-28" },
    { from: "2026-12-16", to: "2027-01-15" },
  ]) {
    const mine = periodTitle(c), theirs = uiTitle(c);
    check(c.from + ".." + c.to + ' -> "' + mine + '"', mine === theirs && mine.length > 0,
      'server "' + mine + '"  vs  ui "' + theirs + '"');
  }
  eq("the approved wording", periodTitle({ from: "2026-07-16", to: "2026-07-31" }), "JULY 16-31, 2026");
}

console.log("\n7. GRID SHAPE\n");
{
  const dtr = buildDtr({
    rows: [row({ dutyDate: "2026-08-20", shiftKind: "Day", startTime: "06:00", endTime: "18:00" })],
    from: FROM, to: TO,
    siteMeta: [{ site: "POST", detachmentName: "POST Farms", clientName: "A Client" }],
  });
  eq("16 day columns for a 16-day cutoff", dtr.days.length, 16);
  eq("weekday of 2026-08-16", dtr.days[0].weekday, "SUN");
  eq("detachment and client print from billing", [dtr.sites[0].detachmentName, dtr.sites[0].clientName],
    ["POST Farms", "A Client"]);
  eq("8 guard slots on the paper form", dtr.sites[0].guards.length + dtr.sites[0].blankSlots, 8);

  const unmapped = buildDtr({
    rows: [row({ dutyDate: "2026-08-20", shiftKind: "Day", startTime: "06:00", endTime: "18:00" })],
    from: FROM, to: TO, siteMeta: [],
  });
  eq("an UNMAPPED site still generates, under its raw roster name",
    [unmapped.sites[0].detachmentName, unmapped.sites[0].clientName, unmapped.sites[0].mapped],
    ["POST", "", false]);
}

// ---------------------------------------------------------------------------
async function reconcile(from, to) {
  require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (host.includes("ep-sweet-bread-aoiz7aup")) {
    console.error("\nREFUSED: that host looks like PRODUCTION.");
    process.exit(2);
  }
  console.log(`\n8. RECONCILIATION against ${host}   ${from} .. ${to}\n`);
  const { computeReport } = require(path.join(ROOT, "src", "routes", "attendance-reports.js"));
  const { pool } = require(path.join(ROOT, "src", "db.js"));
  const { rows } = await computeReport({ from, to, grace: 15, otThreshold: 30 });
  const meta = (await pool.query(
    'SELECT bs.site, bs."detachmentName", bc.name AS "clientName"'
    + ' FROM billing_sites bs JOIN billing_clients bc ON bc.id = bs."clientId"'
  )).rows;
  const dtr = buildDtr({ rows, from, to, siteMeta: meta });

  // An empty result is not a pass: it would mean nothing was exercised.
  check("the window holds attendance", dtr.sites.length > 0, `${dtr.sites.length} sites`);
  for (const s of dtr.sites) {
    console.log(`  ${s.detachmentName.padEnd(20)}DS ${String(s.totals.ds).padStart(2)}`
      + `  NS ${String(s.totals.ns).padStart(2)}  Days ${String(s.totals.days).padStart(2)}`
      + `  Hours ${String(s.totals.hours).padStart(4)}`);
  }
  const problems = checkDtr(dtr);
  check("every site foots (Days = DS+NS, Hours = Days x 12, man-hour row sums)",
    problems.length === 0, problems.join("\n          "));
  check("no straight tour contends for a band", dtr.contention.length === 0,
    JSON.stringify(dtr.contention));
  await pool.end();
}

(async () => {
  const i = process.argv.indexOf("--reconcile");
  if (i !== -1) await reconcile(process.argv[i + 1] || FROM, process.argv[i + 2] || TO);
  // Anti-vacuity: a suite that asserted nothing must not report success.
  if (pass + fail < 45) {
    console.log(`\nFAIL: only ${pass + fail} assertions ran — the suite did not execute.`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
