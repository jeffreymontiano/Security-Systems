// Pure payroll computation — no DB access, so the money math is easy to read
// and test in isolation. Routes/payroll.js gathers the inputs (attendance
// rows from attendance-reports.js's computeReport(), approved OT minutes,
// overlapping leave records, the employee's rate, and the admin-editable
// statutory config) and hands them to computeEmployeeLine().

const { countLeaveDays } = require("./leaveCredits");
const { dateAtTime, nightMinutesIn, addDays } = require("./phTime");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
/**
 * A configured NUMBER, or the documented default.
 *
 * The rule values come from payroll_statutory_config, which an administrator
 * edits, so they arrive as whatever was stored — a number, a numeric string, or
 * something that is neither. `?? default` only catches null and undefined, so a
 * malformed value used to flow straight into the arithmetic:
 *
 *   "1.25x"  ->  NaN across every column it touches
 *   ""       ->  silently ZERO, which is worse: it looks like a real figure
 *
 * Both now resolve to the default. An explicit 0 is still honoured — a zero
 * multiplier or a zero unworked-holiday rate is a real business decision.
 */
function num(x, fallback) {
  if (typeof x === "number") return Number.isFinite(x) ? x : fallback;
  // Only a NUMBER or a numeric STRING is a rule value. Coercing anything else
  // is how a stored [] or true becomes a plausible-looking 0 or 1.
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Nothing leaves this engine non-finite.
 *
 * A backstop, not a substitute for initialising a field: if a new column is ever
 * added to computeDay()'s worked path and forgotten on its unworked early
 * return, this keeps a NaN off the payslip while the arithmetic is corrected.
 */
function finite(n) {
  return Number.isFinite(n) ? n : 0;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// How much of one leave request falls inside this payroll period, and what
// share of its paid/LWOP split that represents. Documented simplification:
// leave_records stores an aggregate paid/LWOP split over the WHOLE request,
// not per specific day, so a request spanning two cutoffs is allocated
// proportionally by day-count rather than by exact day.
function leaveOverlap(rec, periodStart, periodEnd, isGuard) {
  const from = rec.fromDate < periodStart ? periodStart : rec.fromDate;
  const to = rec.toDate > periodEnd ? periodEnd : rec.toDate;
  if (to < from) return null;
  const overlapDays = countLeaveDays(from, to, isGuard);
  if (overlapDays <= 0) return null;
  const totalDays = Number(rec.totalDays) || countLeaveDays(rec.fromDate, rec.toDate, isGuard);
  if (totalDays <= 0) return null;
  const ratio = overlapDays / totalDays;
  const paidDays = round2((Number(rec.paidDays) || 0) * ratio);
  const lwopDays = round2(Math.max(0, overlapDays - paidDays));
  return { overlapDays, paidDays, lwopDays };
}

// SSS: fixed peso amounts per bracket (matches how SSS actually publishes
// its table) — looked up by monthly-equivalent compensation.
function sssLookup(cfg, monthlyComp) {
  const brackets = cfg?.brackets || [];
  if (brackets.length === 0) return { ee: 0, er: 0 };
  let b = brackets.find((x) => monthlyComp >= x.minMsc && monthlyComp <= x.maxMsc);
  if (!b) b = monthlyComp > brackets[brackets.length - 1].maxMsc ? brackets[brackets.length - 1] : brackets[0];
  return { ee: Number(b.ee) || 0, er: Number(b.er) || 0 };
}

// PhilHealth: rate% of compensation clamped to [floor, ceiling], split 50/50.
function philhealthCompute(cfg, monthlyComp) {
  const base = clamp(monthlyComp, cfg?.floor || 0, cfg?.ceiling ?? Infinity);
  const total = base * ((cfg?.ratePercent || 0) / 100);
  return { ee: round2(total / 2), er: round2(total / 2) };
}

// Pag-IBIG: rate tier by threshold, base capped at salaryCap.
function pagibigCompute(cfg, monthlyComp) {
  const base = Math.min(monthlyComp, cfg?.salaryCap ?? monthlyComp);
  const eeRate = monthlyComp <= (cfg?.threshold ?? 0) ? (cfg?.employeeRateLow || 0) : (cfg?.employeeRateHigh || 0);
  return { ee: round2(base * eeRate), er: round2(base * (cfg?.employerRate || 0)) };
}

// Withholding tax: BIR-style bracket lookup applied directly to this
// period's taxable pay (brackets are already expressed per the configured
// frequency, e.g. semi-monthly, so no annualization step is needed).
function withholdingTaxCompute(cfg, taxableIncome) {
  const brackets = cfg?.brackets || [];
  const b = brackets.find((x) => taxableIncome >= x.min && (x.max == null || taxableIncome <= x.max));
  if (!b) return 0;
  return round2((Number(b.base) || 0) + (Number(b.rate) || 0) * (taxableIncome - b.min));
}

// What fraction of the month's statutory contributions is actually WITHHELD
// on this cutoff. 'second' (the default) takes the whole month on the 16-30/31
// run; 'first' takes it on the 1-15 run; 'split' halves it.
function statutoryFactor(mode, isFirstCutoff) {
  if (mode === "first") return isFirstCutoff ? 1 : 0;
  if (mode === "second") return isFirstCutoff ? 0 : 1;
  return 0.5; // "split": half each cutoff
}

// What fraction is subtracted from this cutoff's TAXABLE income — always half,
// regardless of which cutoff the cash is withheld on. Withholding tax is
// assessed per cutoff, so charging the whole month's contributions against one
// cutoff's tax base would make that payslip's tax artificially low and the
// other's artificially high for identical work. Halving both keeps the tax
// even across the month while the cash deduction still lands where configured.
function taxBaseStatutoryFactor() {
  return 0.5;
}

// Which of an employee's recurring component assignments auto-apply this
// period. "One-time" and "Annual" components are never auto-applied — those
// are always added manually as a one-off line component (a specific
// Christmas Bonus run, a specific Birthday Cash Gift), since attaching them
// to a recurring schedule would pay them out every period.
function resolveRecurringComponents(assignments, catalogById, isFirstCutoff) {
  const applied = [];
  for (const a of assignments || []) {
    if (!a.active) continue;
    const comp = catalogById.get(a.componentId);
    if (!comp || !comp.active) continue;
    if (comp.frequency === "One-time" || comp.frequency === "Annual") continue;
    if (comp.frequency === "Monthly (1st cutoff)" && !isFirstCutoff) continue;
    let amount = Number(a.amount) || 0;
    const isLoan = a.balanceRemaining != null;
    if (isLoan) {
      amount = Math.min(amount, Number(a.balanceRemaining));
      if (amount <= 0) continue;
    }
    applied.push({
      componentId: comp.id, name: comp.name, kind: comp.kind, taxable: comp.taxable,
      amount: round2(amount), assignmentId: a.id, isLoan,
    });
  }
  return applied;
}

// Which holiday (if any) applies to a given date at a given site. A holiday
// with no sites is nationwide; one with sites listed is LOCAL and only applies
// to guards posted there — that's what makes a holiday "local", not its type.
function holidayFor(holidays, dutyDate, site) {
  const norm = (s) => (s || "").trim().toLowerCase();
  return (holidays || []).find((h) => {
    if (h.date !== dutyDate || h.active === false) return false;
    if (!h.sites || h.sites.length === 0) return true; // nationwide
    return h.sites.some((s) => norm(s) === norm(site));
  }) || null;
}

// The pay multipliers that apply to one day, given its classification.
// Ordinary days fall through to 1.00 base / pay_rules.otMultiplier so the
// existing behaviour is driven by exactly the same setting it always was.
function multipliersFor(dayType, rules, ordinaryOtMultiplier) {
  if (dayType === "Regular Holiday") {
    return { base: num(rules.regularHolidayWorked, 2.0), ot: num(rules.regularHolidayOt, 2.6) };
  }
  if (dayType === "Special Non-Working") {
    return { base: num(rules.specialDayWorked, 1.3), ot: num(rules.specialDayOt, 1.69) };
  }
  return { base: 1.0, ot: num(ordinaryOtMultiplier, 1.25) };
}

/**
 * The stretch of a duty day the guard is actually PAID for, in clock terms.
 *
 * Night differential attaches to PAID minutes inside the night window and to
 * nothing else. The paid stretch is the SCHEDULED duty window plus any APPROVED
 * excess overtime worked past its end — the two are contiguous, so they are one
 * interval — intersected with what was ACTUALLY WORKED.
 *
 * Both halves of that matter, and each fixes the same error pointing a
 * different way:
 *
 *  - Without the scheduled clamp, the raw punch interval sweeps in unpaid
 *    minutes at both ends. A guard punching in at 05:51 on a 06:00 shift drew
 *    night differential on nine minutes that earn no base pay and no overtime;
 *    one lingering past the shift with nothing approved drew it on the whole
 *    tail. Measured on a PHP 570/day guard: PHP 2.14 over two days.
 *  - Without the intersection with worked time, a guard rostered 18:00-06:00
 *    who arrives at 23:30 would be paid the premium for 22:00-23:30, ninety
 *    minutes before they clocked in. That is the identical error mirrored, so
 *    reading the scheduled window alone is not an option.
 *
 * APPROVED overtime, never detected overtime: `approvedOtByDate` is what the
 * engine actually pays, so lingering that nobody signed off earns no premium.
 *
 * Returns null when there is nothing to clamp to and the caller must keep the
 * punch interval: an UNROSTERED day has no scheduled window at all, a
 * degenerate one (end at or before start) cannot be trusted to mean 24 hours —
 * see the deliberate ambiguity of equal start/end times — and a BROKEN shift is
 * measured from its own worked stretches, whose segment boundaries live in
 * attendance-reports.js. Widening this to broken shifts means passing those
 * segments onto the row beside `workedIntervals` rather than deriving them a
 * second time here; deliberately out of scope.
 */
function paidStretch(row, inMs, outMs, approvedOtMin) {
  if (!row.startTime || !row.endTime) return null;
  if (row.startTime2) return null;                     // broken shift
  const schedStart = dateAtTime(row.dutyDate, row.startTime);
  const schedEnd = dateAtTime(row.dutyDate, row.endTime, row.crossesMidnight ? 1 : 0);
  if (!(schedEnd > schedStart)) return null;           // degenerate window
  const paidEnd = schedEnd + Math.max(0, Number(approvedOtMin) || 0) * 60000;
  const lo = Math.max(schedStart, inMs);
  const hi = Math.min(paidEnd, outMs);
  return hi > lo ? [lo, hi] : null;
}

// Price a single duty day. Returns the day's minutes and its pay decomposed
// into ordinary base / holiday premium / OT / night differential, so the
// payslip can itemise each and payroll_line_days can audit it.
//
// The decomposition splits base pay into `basePay` (the ordinary 1.00x
// portion) and `holidayPremium` (everything above it). That works for both
// pay types: a Monthly employee's flat semi-monthly salary already covers the
// 1.00x, so they receive only the premium, while a Daily employee receives
// both. It also keeps an ordinary day's premium at exactly zero, which is what
// makes the no-holiday case bit-identical to the previous implementation.
function computeDay({ row, holiday, dayRate, hourlyRate, approvedOtMin = 0, rules = {}, ordinaryOtMultiplier = 1.25, payType = "Daily", holidayEligible = true }) {
  const dayType = holiday
    ? (holiday.type === "Regular" ? "Regular Holiday" : "Special Non-Working")
    : "Ordinary";
  const worked = !!row.timeIn;
  // EVERY numeric field this function can return is initialised here, including
  // the ones only the worked path goes on to compute.
  //
  // builtinOtPay and excessOtPay were missing, and an unworked day returns from
  // this object before they are assigned — so `builtinOtPay += day.builtinOtPay`
  // in computeEmployeeLine added `undefined` and the line-level total became
  // NaN. One Absent, Rest Day or On Leave row was enough. `otPay: 0` was already
  // here, which is exactly why otPay, grossPay and netPay stayed correct while
  // the two itemisation columns showed NaN.
  //
  // The money was never wrong — gross is built from otPay, not from these two —
  // but the payslip could not itemise built-in against excess OT, which is the
  // whole reason the columns exist.
  const out = {
    dutyDate: row.dutyDate, dayType, holidayName: holiday ? holiday.name : null,
    isRestDay: !!row.isRestDay, worked,
    regularMinutes: 0, otMinutes: 0, nightMinutes: 0, nightOtMinutes: 0,
    builtinOtMinutes: 0, excessOtMinutes: 0, shiftUnits: 1,
    basePay: 0, otPay: 0, builtinOtPay: 0, excessOtPay: 0,
    nightDiffPay: 0, holidayPremium: 0, unworkedHolidayPay: 0,
  };

  if (!worked) {
    // Unworked holiday pay. Only Daily-rated staff receive it — a Monthly
    // salary is already deemed to cover every day of the period, so paying it
    // again would double-count. Art. 94 also conditions regular-holiday pay on
    // presence the workday before, which the caller resolves into
    // holidayEligible (toggleable via rules.requirePresenceDayBefore).
    if (payType === "Daily" && dayType === "Regular Holiday" && holidayEligible) {
      out.unworkedHolidayPay = round2(dayRate * num(rules.regularHolidayUnworkedPay, 1.0));
    } else if (payType === "Daily" && dayType === "Special Non-Working") {
      out.unworkedHolidayPay = round2(dayRate * num(rules.specialDayUnworkedPay, 0));
    }
    return out;
  }

  const mult = multipliersFor(dayType, rules, ordinaryOtMultiplier);
  // Built-in and excess OT are priced at the same multiplier but kept apart:
  // built-in is auto-recognised from shift length and needs no approval, while
  // excess is worked past shift end and does. Payroll has to be able to show
  // and defend them separately.
  out.builtinOtMinutes = row.builtinOtMin || 0;
  out.excessOtMinutes = approvedOtMin || 0;
  out.otMinutes = out.builtinOtMinutes + out.excessOtMinutes;

  // Base pay is per-DAY, not per-minute: a present day earns the day rate
  // regardless of exact minutes, with lateness/undertime deducted separately.
  // Preserved from the original implementation so ordinary days don't move.
  //
  // `shiftUnits` is 1 for every ordinary day and 2 only for a STRAIGHT DUTY —
  // a continuous 24-hour tour worked as two consecutive regular shifts. The
  // built-in OT for such a day is computed as two shifts in
  // attendance-reports.js, so base pay must be two shifts as well: describing
  // the same 24 hours as two shifts in one column and one in another would
  // leave eight hours paid by neither.
  //
  // A Monthly employee's flat semi-monthly salary already covers the ordinary
  // portion of every day, so they earn no extra base here either way; the
  // holiday premium still scales, because two shifts on a holiday earn two.
  const units = Math.max(1, Number(row.shiftUnits) || 1);
  out.shiftUnits = units;
  out.basePay = payType === "Monthly" ? 0 : round2(dayRate * units);
  out.holidayPremium = round2(dayRate * units * (mult.base - 1.0));
  // Priced apart so each can be shown and audited on its own; otPay stays the
  // sum of the two so gross always reconciles with the itemised columns.
  out.builtinOtPay = round2((out.builtinOtMinutes / 60) * hourlyRate * mult.ot);
  out.excessOtPay = round2((out.excessOtMinutes / 60) * hourlyRate * mult.ot);
  out.otPay = round2(out.builtinOtPay + out.excessOtPay);

  // Night differential covers every PAID hour in the window, valued at the
  // day's base rate — see paidStretch() for what counts as paid and why the
  // punch interval is not it. Hours that fall inside overtime are counted but are NOT
  // uplifted by the OT multiplier — that premium is already paid in full by
  // the Built-in OT / Excess OT columns, and uplifting them here as well read
  // as paying twice for the same hours.
  //
  // The interval is still split at the 8-hour mark so the per-day breakdown can
  // show how many night minutes fell in regular time versus overtime. The
  // boundary reuses the scheduled start when there is one, matching how
  // attendance-reports.js derives built-in OT.
  const inMs = Date.parse(row.timeIn);
  const outMs = row.timeOut ? Date.parse(row.timeOut) : null;

  // A BROKEN (split) shift arrives with its worked stretches listed, because
  // the hours between them are off duty and must not be paid. Everything else
  // arrives without them and keeps the contiguous arithmetic below, unchanged —
  // including where its 8-hour mark sits, which is measured from the SCHEDULED
  // start so that arriving late does not quietly convert regular hours into
  // overtime. Only a split shift needs a cumulative mark, because its eighth
  // hour genuinely falls partway through the second stretch.
  const splitIntervals = Array.isArray(row.workedIntervals) && row.workedIntervals.length
    ? row.workedIntervals
      .map(([a, b]) => [Date.parse(a), Date.parse(b)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((x, y) => x[0] - y[0])
    : null;

  if (splitIntervals) {
    const pct = num(rules.nightDiffPercent, 0.1);
    const EIGHT = 8 * 60 * 60 * 1000;
    let accrued = 0;   // milliseconds worked so far, across stretches
    for (const [a, b] of splitIntervals) {
      const len = b - a;
      // How much of THIS stretch still falls inside the first eight hours.
      const regLen = Math.max(0, Math.min(len, EIGHT - accrued));
      const regEnd = a + regLen;
      out.regularMinutes += Math.round(regLen / 60000);
      if (regEnd > a) out.nightMinutes += nightMinutesIn(a, regEnd, rules);
      if (b > regEnd) out.nightOtMinutes += nightMinutesIn(regEnd, b, rules);
      accrued += len;
    }
    const totalNightMinutes = out.nightMinutes + out.nightOtMinutes;
    out.nightDiffPay = round2((totalNightMinutes / 60) * hourlyRate * mult.base * pct);
  } else if (outMs != null && outMs > inMs) {
    const shiftStartMs = row.startTime ? dateAtTime(row.dutyDate, row.startTime) : inMs;
    const eightHourMark = shiftStartMs + 8 * 60 * 60 * 1000;
    const regEnd = Math.min(outMs, eightHourMark);

    out.regularMinutes = Math.max(0, Math.round((regEnd - inMs) / 60000));

    // Night differential is measured over the PAID stretch, not the punch
    // interval. The split at the eight-hour mark is unchanged — it exists so
    // the per-day breakdown can show how many night minutes fell in regular
    // time versus overtime — it is simply applied to the paid stretch now.
    // A day with nothing to clamp to keeps the punch interval it always had.
    const paid = paidStretch(row, inMs, outMs, out.excessOtMinutes);
    const [nightLo, nightHi] = paid || [inMs, outMs];
    const nightRegEnd = Math.min(nightHi, eightHourMark);
    const nightOtStart = Math.max(nightLo, eightHourMark);
    out.nightMinutes = nightRegEnd > nightLo ? nightMinutesIn(nightLo, nightRegEnd, rules) : 0;
    out.nightOtMinutes = nightHi > nightOtStart ? nightMinutesIn(nightOtStart, nightHi, rules) : 0;

    const pct = num(rules.nightDiffPercent, 0.1);
    // mult.base still applies, so night hours on a holiday are uplifted by the
    // holiday rate — that is a different axis from the OT multiplier.
    const totalNightMinutes = out.nightMinutes + out.nightOtMinutes;
    out.nightDiffPay = round2((totalNightMinutes / 60) * hourlyRate * mult.base * pct);
  }

  return out;
}

// The core per-employee-per-period computation.
//
// Inputs:
//  - employee: { payType, dailyRate, monthlyRate }
//  - attendanceRows: this employee's computeReport() rows for the period
//    (status/lateMin/undertimeMin/builtinOtMin)
//  - approvedOtMinutes: sum of Approved overtime_records.approvedMinutes in range
//  - leaveRecords: Approved leave_records overlapping the period
//    ({ fromDate, toDate, totalDays, paidDays })
//  - isGuard: drives leave day-counting rules (calendar vs Mon-Sat), reused
//    from leaveCredits.js
//  - components: resolved [{ name, kind, taxable, amount }] to apply this line
//    (recurring assignments already resolved by the caller, plus any one-off
//    additions)
//  - statutory: { sss, philhealth, pagibig, withholding_tax, pay_rules } —
//    the admin-editable config rows
//  - isFirstCutoff: true for the 1-15 cutoff, false for 16-end
//  - periodStart/periodEnd: 'YYYY-MM-DD' bounds of this payroll period
function computeEmployeeLine({ employee, attendanceRows, approvedOtMinutes, approvedOtByDate, leaveRecords, isGuard, components, statutory, isFirstCutoff, periodStart, periodEnd, holidays, openingArrears = 0 }) {
  const payRules = statutory.pay_rules || {};
  const premiumRules = statutory.premium_rules || {};
  const payType = employee.payType === "Monthly" ? "Monthly" : "Daily";
  const dailyRate = Number(employee.dailyRate) || 0;
  const monthlyRate = Number(employee.monthlyRate) || 0;
  const rateUsed = payType === "Monthly" ? monthlyRate : dailyRate;

  const monthlyDivisor = num(payRules.monthlyDivisor, 30) || 30;
  const dayRate = payType === "Monthly" ? monthlyRate / monthlyDivisor : dailyRate;
  const hourlyRate = dayRate / 8;
  const minuteRate = hourlyRate / 60;
  const otMultiplier = num(payRules.otMultiplier, 1.25);

  const allRows = attendanceRows || [];
  // Rows may extend before periodStart to give the Art. 94 "present the
  // workday before" check something to look back at; only days inside the
  // period are ever paid.
  const inPeriod = (d) => d >= periodStart && d <= periodEnd;
  const byDate = new Map(allRows.map((r) => [r.dutyDate, r]));

  // Was the employee present (or on paid leave) on the most recent scheduled
  // day before `dutyDate`? Walks back up to 7 days to skip rest days and
  // unscheduled gaps. With no prior record at all we default to eligible
  // rather than silently withholding legally-owed holiday pay.
  function presentDayBefore(dutyDate) {
    for (let i = 1; i <= 7; i++) {
      const prev = addDays(dutyDate, -i);
      const row = byDate.get(prev);
      if (!row) continue;
      if (row.status === "Rest Day") continue;
      return row.status === "Present" || row.status === "On Leave";
    }
    return true;
  }

  let presentDays = 0, absentDays = 0, lateMinutes = 0, undertimeMinutes = 0, builtinOtMinutes = 0;
  let basePayTotal = 0, otPayTotal = 0, nightDiffPay = 0, holidayPremiumPay = 0, holidayUnworkedPay = 0;
  let nightDiffMinutes = 0, approvedOtTotal = 0;
  let builtinOtPay = 0, excessOtPay = 0;
  const days = [];

  for (const r of allRows) {
    if (!inPeriod(r.dutyDate)) continue;
    if (r.status === "Present") presentDays++;
    else if (r.status === "Absent") absentDays++;
    lateMinutes += r.lateMin || 0;
    undertimeMinutes += r.undertimeMin || 0;
    builtinOtMinutes += r.builtinOtMin || 0;

    const approvedOtMin = approvedOtByDate ? (approvedOtByDate.get(r.dutyDate) || 0) : 0;
    approvedOtTotal += approvedOtMin;

    const holiday = holidayFor(holidays, r.dutyDate, r.site);
    const day = computeDay({
      row: r, holiday, dayRate, hourlyRate, approvedOtMin,
      rules: premiumRules, ordinaryOtMultiplier: otMultiplier, payType,
      holidayEligible: premiumRules.requirePresenceDayBefore === false ? true : presentDayBefore(r.dutyDate),
    });

    basePayTotal += day.basePay;
    otPayTotal += day.otPay;
    builtinOtPay += day.builtinOtPay;
    excessOtPay += day.excessOtPay;
    nightDiffPay += day.nightDiffPay;
    holidayPremiumPay += day.holidayPremium;
    holidayUnworkedPay += day.unworkedHolidayPay;
    nightDiffMinutes += day.nightMinutes + day.nightOtMinutes;
    days.push(day);
  }

  let paidLeaveDays = 0, lwopDays = 0;
  for (const rec of leaveRecords || []) {
    const ov = leaveOverlap(rec, periodStart, periodEnd, isGuard);
    if (ov) { paidLeaveDays += ov.paidDays; lwopDays += ov.lwopDays; }
  }
  paidLeaveDays = round2(paidLeaveDays);
  lwopDays = round2(lwopDays);

  // Base pay: Daily accumulates each worked day's rate (plus paid leave days,
  // which have no attendance row); Monthly keeps its flat semi-monthly figure
  // docked for absence/LWOP. Premiums are added on top for both.
  const regularPay = payType === "Monthly"
    ? round2(monthlyRate / 2 - (absentDays + lwopDays) * dayRate)
    : round2(basePayTotal + dailyRate * paidLeaveDays);

  const lateUndertimeDeduction = round2((lateMinutes + undertimeMinutes) * minuteRate);

  // When the caller has no per-day OT breakdown, fall back to the period total
  // priced at the ordinary rate — keeps older callers working unchanged.
  const otPay = approvedOtByDate
    ? round2(otPayTotal)
    : round2(((builtinOtMinutes + (approvedOtMinutes || 0)) / 60) * hourlyRate * otMultiplier);
  const totalApprovedOt = approvedOtByDate ? approvedOtTotal : (approvedOtMinutes || 0);

  nightDiffPay = round2(nightDiffPay);
  holidayPremiumPay = round2(holidayPremiumPay);
  holidayUnworkedPay = round2(holidayUnworkedPay);
  builtinOtPay = round2(builtinOtPay);
  excessOtPay = round2(excessOtPay);

  const earningComponents = (components || []).filter((c) => c.kind === "Earning");
  const deductionComponents = (components || []).filter((c) => c.kind === "Deduction");
  const otherEarnings = round2(earningComponents.reduce((s, c) => s + Number(c.amount || 0), 0));
  const otherDeductions = round2(deductionComponents.reduce((s, c) => s + Number(c.amount || 0), 0));
  const nonTaxableEarnings = round2(earningComponents.filter((c) => !c.taxable).reduce((s, c) => s + Number(c.amount || 0), 0));

  const grossPay = round2(
    regularPay + otPay + nightDiffPay + holidayPremiumPay + holidayUnworkedPay
    + otherEarnings - lateUndertimeDeduction
  );

  const monthlyComp = payType === "Monthly" ? monthlyRate : dailyRate * monthlyDivisor;
  const factor = statutoryFactor(payRules.statutoryCutoff, isFirstCutoff);

  // Statutory contributions are a share of ACTUAL compensation, so there has to
  // be compensation to take them from. Two cases where there isn't:
  //   - no rate configured yet (monthlyComp 0) — the employee isn't set up for
  //     payroll, and the lowest SSS/PhilHealth bracket would otherwise withhold
  //     a real peso amount from a zero gross, producing a NEGATIVE net pay
  //   - a rate exists but nothing was earned this cutoff (absent throughout,
  //     hired mid-period, etc.)
  // Either way the whole statutory block is zero rather than a bracket lookup.
  const hasCompensation = monthlyComp > 0 && grossPay > 0;

  const sss = hasCompensation ? sssLookup(statutory.sss, monthlyComp) : { ee: 0, er: 0 };
  const philhealth = hasCompensation ? philhealthCompute(statutory.philhealth, monthlyComp) : { ee: 0, er: 0 };
  const pagibig = hasCompensation ? pagibigCompute(statutory.pagibig, monthlyComp) : { ee: 0, er: 0 };

  const sssEe = round2(sss.ee * factor), sssEr = round2(sss.er * factor);
  const philhealthEe = round2(philhealth.ee * factor), philhealthEr = round2(philhealth.er * factor);
  const pagibigEe = round2(pagibig.ee * factor), pagibigEr = round2(pagibig.er * factor);

  // Tax base uses HALF the month's contributions on every cutoff, independent
  // of which cutoff the cash is withheld on (see taxBaseStatutoryFactor).
  const taxFactor = taxBaseStatutoryFactor();
  const taxDeductible = round2((sss.ee + philhealth.ee + pagibig.ee) * taxFactor);
  const taxableIncome = Math.max(0, round2(grossPay - nonTaxableEarnings - taxDeductible));
  // Withholding can be switched off company-wide (agencies that don't withhold
  // from guards) or per employee (minimum-wage earners, exempt under RA 9504).
  const taxEnabled = payRules.withholdingTaxEnabled !== false && employee.taxExempt !== true;
  const withholdingTax = (hasCompensation && taxEnabled)
    ? withholdingTaxCompute(statutory.withholding_tax, taxableIncome) : 0;

  // Cap total withholding at what was actually earned: net pay must never go
  // negative. A guard who worked one day still owes a full month of
  // contributions, so the shortfall is deferred to the next cutoff rather than
  // handed to them as a negative payslip.
  //
  // Priority: this period's own statutory obligations are satisfied first, then
  // voluntary deductions, and prior arrears are recovered only from whatever
  // surplus remains. Recovering old debt first would let a low-earning guard
  // defer current contributions every period and spiral.
  const arrearsOpening = round2(Math.max(0, Number(openingArrears) || 0));
  const wanted = [
    sssEe, philhealthEe, pagibigEe, withholdingTax, otherDeductions, arrearsOpening,
  ];
  let remaining = Math.max(0, grossPay);
  const taken = wanted.map((amount) => {
    const take = Math.min(amount, remaining);
    remaining = round2(remaining - take);
    return round2(take);
  });
  const totalWanted = round2(wanted.reduce((s, n) => s + n, 0));
  const totalTaken = round2(taken.reduce((s, n) => s + n, 0));

  // Everything unmet this cutoff carries forward, except the opening arrears
  // portion which was already carried (it simply stays unrecovered).
  const arrearsRecovered = taken[5];
  const currentUnmet = round2(
    (sssEe - taken[0]) + (philhealthEe - taken[1]) + (pagibigEe - taken[2])
    + (withholdingTax - taken[3]) + (otherDeductions - taken[4])
  );
  const deductionsDeferred = round2(Math.max(0, currentUnmet));
  const netPay = round2(Math.max(0, grossPay - totalTaken));
  const arrearsClosing = round2(arrearsOpening - arrearsRecovered + deductionsDeferred);

  // Final guard: no column leaves this engine non-finite.
  //
  // Every field above is now initialised at source, so this should never fire —
  // it is a backstop for the next column somebody adds to the worked path and
  // forgets on the unworked early return. A NaN reaching payroll_lines is
  // stored by NUMERIC as the literal 'NaN' and renders as "₱NaN" on the
  // payslip, which is what this whole fix is about.
  //
  // It coerces the OUTPUT only. It cannot disguise a wrong figure — a NaN here
  // still means an upstream arithmetic fault, and the suites assert the real
  // values rather than merely "not NaN".
  return {
    payType, rateUsed,
    presentDays, absentDays, paidLeaveDays, lwopDays,
    lateMinutes, undertimeMinutes, builtinOtMinutes, approvedOtMinutes: totalApprovedOt,
    regularPay: finite(regularPay), otPay: finite(otPay),
    lateUndertimeDeduction: finite(lateUndertimeDeduction),
    otherEarnings: finite(otherEarnings), grossPay: finite(grossPay),
    builtinOtPay: finite(builtinOtPay), excessOtPay: finite(excessOtPay),
    nightDiffMinutes, nightDiffPay: finite(nightDiffPay),
    holidayPremiumPay: finite(holidayPremiumPay), holidayUnworkedPay: finite(holidayUnworkedPay),
    sssEe: finite(sssEe), sssEr: finite(sssEr),
    philhealthEe: finite(philhealthEe), philhealthEr: finite(philhealthEr),
    pagibigEe: finite(pagibigEe), pagibigEr: finite(pagibigEr),
    withholdingTax: finite(withholdingTax),
    otherDeductions: finite(otherDeductions), netPay: finite(netPay),
    // What was actually withheld this cutoff, after the gross cap. The figures
    // above stay at their full assessed amounts so remittance reports and the
    // payslip can show assessed-vs-collected honestly.
    withheld: {
      sssEe: finite(taken[0]), philhealthEe: finite(taken[1]), pagibigEe: finite(taken[2]),
      withholdingTax: finite(taken[3]), otherDeductions: finite(taken[4]),
    },
    totalWanted: finite(totalWanted), totalTaken: finite(totalTaken),
    arrearsOpening: finite(arrearsOpening), arrearsRecovered: finite(arrearsRecovered),
    deductionsDeferred: finite(deductionsDeferred), arrearsClosing: finite(arrearsClosing),
    days, // per-day breakdown -> payroll_line_days
  };
}

// 13th-month pay per PD 851: total BASIC salary actually earned in the year / 12.
function computeThirteenthMonth(totalBasicEarned) {
  return round2((Number(totalBasicEarned) || 0) / 12);
}

module.exports = {
  round2, clamp, leaveOverlap, sssLookup, philhealthCompute, pagibigCompute,
  withholdingTaxCompute, statutoryFactor, taxBaseStatutoryFactor, resolveRecurringComponents,
  holidayFor, multipliersFor, computeDay,
  computeEmployeeLine, computeThirteenthMonth,
};
