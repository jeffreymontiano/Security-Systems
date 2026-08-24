// STAGE (i): does an override actually flow THROUGH the engine's cap / priority
// / arrears ladder, rather than being pasted on top of the result?
//
// The two hard cases are the point. On a comfortable line any implementation
// looks right; the ladder only reveals itself when deductions exceed gross (the
// deferral path) or when prior arrears are competing for the same pesos. Those
// are exactly the shapes `PATCH /lines/:id` gets wrong today.
// Resolved from this file's own location, never hardcoded: an absolute path
// to one developer's checkout is useless to everyone else.
const ROOT = require("path").resolve(__dirname, "..", "..");
const E = require(ROOT + "/src/lib/payrollEngine");
const { computeEmployeeLine, OVERRIDABLE_FIELDS, DERIVED_FIELDS } = E;

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`
    + (ok ? "" : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`));
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// SSS deliberately large so a short period cannot cover the statutory bill --
// that is what drives the line into the deferral path.
const TABLES = {
  sss: { brackets: [{ minMsc: 0, maxMsc: 1e6, ee: 900, er: 1800 }] },
  philhealth: { floor: 10000, ceiling: 100000, ratePercent: 5 },
  pagibig: { employeeRateLow: 0.01, employeeRateHigh: 0.02, threshold: 1500, employerRate: 0.02, salaryCap: 10000 },
  withholding_tax: { brackets: [{ min: 0, max: null, base: 0, rate: 0 }] },
};
const stat = {
  ...TABLES,
  pay_rules: { otMultiplier: 1.25, monthlyDivisor: 30, graceMinutes: 15, otThresholdMinutes: 30,
    withholdingTaxEnabled: false, sssCutoff: "second", philhealthCutoff: "second", pagibigCutoff: "second" },
  premium_rules: { nightDiffPercent: 0.1, nightStartHour: 22, nightEndHour: 6,
    regularHolidayWorked: 2, regularHolidayOt: 2.6, regularHolidayUnworkedPay: 1,
    specialDayWorked: 1.3, specialDayOt: 1.69, specialDayUnworkedPay: 0, requirePresenceDayBefore: true },
};
const iso = (d, t) => new Date(`${d}T${t}:00+08:00`).toISOString();
const day = (d) => ({
  dutyDate: d, guardName: "T", site: "S", shiftName: "Day Shift",
  startTime: "06:00", endTime: "18:00", crossesMidnight: false, shiftKind: "Day",
  status: "Present", isRestDay: false, shiftUnits: 1,
  timeIn: iso(d, "06:00"), timeOut: iso(d, "18:00"),
  lateMin: 0, undertimeMin: 0, overtimeMin: 0, builtinOtMin: 240,
  startTime2: null, endTime2: null, crossesMidnight2: false, flags: [],
});
const line = ({ days = 1, overrides = null, openingArrears = 0, rate = 570 } = {}) =>
  computeEmployeeLine({
    employee: { id: 1, fullName: "T", payType: "Daily", dailyRate: rate, monthlyRate: 0 },
    attendanceRows: Array.from({ length: days }, (_, i) => day(`2026-09-${16 + i}`)),
    approvedOtByDate: new Map(), leaveRecords: [], isGuard: true, components: [],
    statutory: stat, isFirstCutoff: false,
    periodStart: "2026-09-16", periodEnd: "2026-09-30",
    holidays: [], openingArrears, overrides,
  });

console.log("=== 0. no overrides changes NOTHING (the safety property) ===");
{
  const a = line({ days: 3 }), b = line({ days: 3, overrides: new Map() });
  const cols = ["regularPay", "otPay", "grossPay", "netPay", "sssEe", "philhealthEe",
    "pagibigEe", "totalTaken", "deductionsDeferred", "arrearsClosing"];
  check("  an empty override map is byte-identical to no map",
    cols.filter((c) => String(a[c]) !== String(b[c])), []);
  check("  ...and nothing is reported as applied", b.overridesApplied, []);
}

console.log("\n=== 1. HARD CASE A: deductions EXCEED gross -- the deferral path ===");
{
  // One worked day. Gross 926.25 against SSS 900 + PhilHealth 427.50 +
  // Pag-IBIG 200 = 1527.50 due, so the ladder must cap and defer.
  const base = line({ days: 1 });
  console.log(`  baseline: gross ${base.grossPay}  wanted ${base.totalWanted}  taken ${base.totalTaken}  deferred ${base.deductionsDeferred}`);
  check("  the baseline really is in the capped state", base.deductionsDeferred > 0, true);
  check("  net floors at zero, never negative", base.netPay, 0);
  // ASSESSED vs COLLECTED are different engine outputs and the ladder acts on
  // the second: `philhealthEe` is what was assessed, `withheld.philhealthEe` is
  // what the cap actually let through. Asserting the ladder means asserting the
  // withheld figures.
  check("  SSS is assessed in full", Number(base.sssEe), 900);
  check("  ...and collected in full, being first in priority", Number(base.withheld.sssEe), 900);
  check("  PhilHealth is ASSESSED in full", Number(base.philhealthEe), 427.5);
  check("  ...but only COLLECTS what is left", Number(base.withheld.philhealthEe), r2(base.grossPay - 900));
  check("  Pag-IBIG collects nothing", Number(base.withheld.pagibigEe), 0);

  // Now override SSS DOWN. If the override merely replaced the stored figure,
  // PhilHealth would be untouched. If the ladder RE-RAN, the pesos SSS gave up
  // must flow to PhilHealth next in priority.
  const ovd = line({ days: 1, overrides: new Map([["sssEe", 100]]) });
  console.log(`  override sssEe -> 100:  sss ${ovd.sssEe}  philhealth ${ovd.philhealthEe}  pagibig ${ovd.pagibigEe}  deferred ${ovd.deductionsDeferred}`);
  check("  SSS is assessed at the overridden figure", Number(ovd.sssEe), 100);
  check("  ...and collects it", Number(ovd.withheld.sssEe), 100);
  check("  *** PhilHealth now COLLECTS in full -- the freed pesos flowed on ***",
    Number(ovd.withheld.philhealthEe), 427.5);
  check("  *** and Pag-IBIG collects too, which it could not before ***",
    Number(ovd.withheld.pagibigEe), 200);
  // 800 pesos were freed but only 601.25 were ever short, so the deferral goes
  // to zero and the REMAINDER reaches the guard as net pay. Both halves matter:
  // a paste-on-top implementation would move neither.
  check("  the deferral clears entirely", Number(ovd.deductionsDeferred), 0);
  check("  ...and the surplus becomes net pay",
    Number(ovd.netPay), r2(ovd.grossPay - ovd.totalTaken));
  check("  the 800 freed pesos are fully accounted for",
    r2((base.deductionsDeferred - ovd.deductionsDeferred) + (ovd.netPay - base.netPay)), 800);
  check("  totalTaken never exceeds gross", ovd.totalTaken <= ovd.grossPay, true);

  // And the reverse: overriding a contribution UP must deepen the deferral,
  // not silently overdraw the guard.
  const up = line({ days: 1, overrides: new Map([["philhealthEe", 5000]]) });
  console.log(`  override philhealthEe -> 5000:  taken ${up.totalTaken}  deferred ${up.deductionsDeferred}  net ${up.netPay}`);
  check("  an over-large override is CAPPED by the ladder, not paid",
    up.totalTaken <= up.grossPay, true);
  check("  ...and the shortfall is deferred, not lost", up.deductionsDeferred > base.deductionsDeferred, true);
  check("  net is still never negative", up.netPay, 0);
}

console.log("\n=== 2. HARD CASE B: a line RECOVERING prior arrears ===");
{
  // Comfortable gross so arrears can actually be recovered, with an opening
  // balance competing for the same pesos LAST in priority.
  const OPEN = 3000;
  const base = line({ days: 10, openingArrears: OPEN });
  console.log(`  baseline: gross ${base.grossPay}  statutory ${r2(Number(base.sssEe) + Number(base.philhealthEe) + Number(base.pagibigEe))}  arrearsRecovered ${base.arrearsRecovered}  net ${base.netPay}`);
  check("  the baseline really recovers some arrears", Number(base.arrearsRecovered) > 0, true);

  // Override a statutory contribution DOWN. Arrears recovery is LAST in
  // priority, so the freed pesos must reach it -- that is the ladder running.
  const ovd = line({ days: 10, openingArrears: OPEN, overrides: new Map([["sssEe", 100]]) });
  console.log(`  override sssEe -> 100:  arrearsRecovered ${ovd.arrearsRecovered}  net ${ovd.netPay}  closing ${ovd.arrearsClosing}`);
  check("  SSS takes the overridden figure", Number(ovd.sssEe), 100);
  check("  *** arrears recovery ABSORBS the freed pesos -- ladder re-ran ***",
    r2(Number(ovd.arrearsRecovered) - Number(base.arrearsRecovered)),
    Math.min(800, r2(OPEN - Number(base.arrearsRecovered))));
  check("  the arrears ledger still closes correctly",
    Number(ovd.arrearsClosing),
    r2(OPEN - Number(ovd.arrearsRecovered) + Number(ovd.deductionsDeferred)));
  check("  net = gross - everything actually taken",
    Number(ovd.netPay), r2(ovd.grossPay - ovd.totalTaken));
}

console.log("\n=== 3. DERIVED TOTALS fall out; they are not overridable ===");
{
  const ovd = line({ days: 3, overrides: new Map([["builtinOtPay", 100]]) });
  check("  overriding builtinOtPay flows into otPay",
    Number(ovd.otPay), r2(100 + Number(ovd.excessOtPay)));
  check("  ...and into grossPay", Number(ovd.grossPay),
    r2(Number(ovd.regularPay) + Number(ovd.otPay) + Number(ovd.nightDiffPay)
      + Number(ovd.holidayPremiumPay) + Number(ovd.holidayUnworkedPay)
      + Number(ovd.otherEarnings) - Number(ovd.lateUndertimeDeduction)));
  check("  ...and net still reconciles to gross - taken",
    Number(ovd.netPay), r2(ovd.grossPay - ovd.totalTaken));

  for (const f of DERIVED_FIELDS) {
    const bad = line({ days: 3, overrides: new Map([[f, 1]]) });
    const clean = line({ days: 3 });
    check(`  "${f}" is REJECTED, not applied`,
      [bad.overridesApplied.length, bad.overridesRejected.map((r) => r.field), String(bad.netPay)],
      [0, [f], String(clean.netPay)]);
  }
}

console.log("\n=== 4. the applied record carries the COMPUTED snapshot ===");
{
  const ovd = line({ days: 3, overrides: new Map([["philhealthEe", 400], ["sssEe", 100]]) });
  const byField = Object.fromEntries(ovd.overridesApplied.map((a) => [a.field, a]));
  check("  philhealthEe snapshot is what the engine computed", byField.philhealthEe.computedValue, 427.5);
  check("  ...and its override value", byField.philhealthEe.overrideValue, 400);
  check("  ...classified as statutory", byField.philhealthEe.fieldClass, "statutory");
  check("  sssEe snapshot too", byField.sssEe.computedValue, 900);
  const e = line({ days: 3, overrides: new Map([["otherEarnings", 50]]) });
  check("  an earning override is classified as earning",
    e.overridesApplied[0].fieldClass, "earning");
}

console.log("\n=== 5. a malformed override is IGNORED, never paid ===");
{
  const clean = line({ days: 3 });
  for (const v of ["abc", "", "  ", NaN, null, undefined, {}, [], true, Infinity, -Infinity]) {
    const bad = line({ days: 3, overrides: new Map([["philhealthEe", v]]) });
    check(`  philhealthEe = ${JSON.stringify(v) ?? String(v)} -> computed value stands`,
      String(bad.philhealthEe), String(clean.philhealthEe));
  }
  console.log(`  (an explicit 0 IS a real override and must be honoured)`);
  const zero = line({ days: 3, overrides: new Map([["philhealthEe", 0]]) });
  check("  philhealthEe = 0 is applied", Number(zero.philhealthEe), 0);
  check("  ...and recorded", zero.overridesApplied.length, 1);
}

console.log(`\n${OVERRIDABLE_FIELDS.length} overridable field(s), ${DERIVED_FIELDS.length} locked`);
console.log(`${failed === 0 ? "ALL PASS" : failed + " FAILURE(S)"}`);
process.exit(failed === 0 ? 0 : 1);
