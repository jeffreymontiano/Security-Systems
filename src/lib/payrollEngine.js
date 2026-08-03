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

function statutoryFactor(mode, isFirstCutoff) {
  if (mode === "first") return isFirstCutoff ? 1 : 0;
  if (mode === "second") return isFirstCutoff ? 0 : 1;
  return 0.5; // "split" (default): half each cutoff
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
    return { base: rules.regularHolidayWorked ?? 2.0, ot: rules.regularHolidayOt ?? 2.6 };
  }
  if (dayType === "Special Non-Working") {
    return { base: rules.specialDayWorked ?? 1.3, ot: rules.specialDayOt ?? 1.69 };
  }
  return { base: 1.0, ot: ordinaryOtMultiplier };
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
  const out = {
    dutyDate: row.dutyDate, dayType, holidayName: holiday ? holiday.name : null,
    isRestDay: !!row.isRestDay, worked,
    regularMinutes: 0, otMinutes: 0, nightMinutes: 0, nightOtMinutes: 0,
    basePay: 0, otPay: 0, nightDiffPay: 0, holidayPremium: 0, unworkedHolidayPay: 0,
  };

  if (!worked) {
    // Unworked holiday pay. Only Daily-rated staff receive it — a Monthly
    // salary is already deemed to cover every day of the period, so paying it
    // again would double-count. Art. 94 also conditions regular-holiday pay on
    // presence the workday before, which the caller resolves into
    // holidayEligible (toggleable via rules.requirePresenceDayBefore).
    if (payType === "Daily" && dayType === "Regular Holiday" && holidayEligible) {
      out.unworkedHolidayPay = round2(dayRate * (rules.regularHolidayUnworkedPay ?? 1.0));
    } else if (payType === "Daily" && dayType === "Special Non-Working") {
      out.unworkedHolidayPay = round2(dayRate * (rules.specialDayUnworkedPay ?? 0));
    }
    return out;
  }

  const mult = multipliersFor(dayType, rules, ordinaryOtMultiplier);
  out.otMinutes = (row.builtinOtMin || 0) + (approvedOtMin || 0);

  // Base pay is per-DAY, not per-minute: a present day earns the day rate
  // regardless of exact minutes, with lateness/undertime deducted separately.
  // Preserved from the original implementation so ordinary days don't move.
  out.basePay = payType === "Monthly" ? 0 : round2(dayRate);
  out.holidayPremium = round2(dayRate * (mult.base - 1.0));
  out.otPay = round2((out.otMinutes / 60) * hourlyRate * mult.ot);

  // Night differential: split the worked interval at the 8-hour mark so night
  // hours inside regular time and inside OT are valued at their own rates.
  // The boundary reuses the scheduled start when there is one, matching how
  // attendance-reports.js already derives built-in OT.
  const inMs = Date.parse(row.timeIn);
  const outMs = row.timeOut ? Date.parse(row.timeOut) : null;
  if (outMs != null && outMs > inMs) {
    const shiftStartMs = row.startTime ? dateAtTime(row.dutyDate, row.startTime) : inMs;
    const eightHourMark = shiftStartMs + 8 * 60 * 60 * 1000;
    const regEnd = Math.min(outMs, eightHourMark);
    const otStart = Math.max(inMs, eightHourMark);

    out.regularMinutes = Math.max(0, Math.round((regEnd - inMs) / 60000));
    out.nightMinutes = regEnd > inMs ? nightMinutesIn(inMs, regEnd, rules) : 0;
    out.nightOtMinutes = outMs > otStart ? nightMinutesIn(otStart, outMs, rules) : 0;

    const pct = rules.nightDiffPercent ?? 0.1;
    const regularNightPay = (out.nightMinutes / 60) * hourlyRate * mult.base * pct;
    const otNightPay = (out.nightOtMinutes / 60) * hourlyRate * mult.ot * pct;
    out.nightDiffPay = round2(regularNightPay + otNightPay);
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
function computeEmployeeLine({ employee, attendanceRows, approvedOtMinutes, approvedOtByDate, leaveRecords, isGuard, components, statutory, isFirstCutoff, periodStart, periodEnd, holidays }) {
  const payRules = statutory.pay_rules || {};
  const premiumRules = statutory.premium_rules || {};
  const payType = employee.payType === "Monthly" ? "Monthly" : "Daily";
  const dailyRate = Number(employee.dailyRate) || 0;
  const monthlyRate = Number(employee.monthlyRate) || 0;
  const rateUsed = payType === "Monthly" ? monthlyRate : dailyRate;

  const monthlyDivisor = payRules.monthlyDivisor || 30;
  const dayRate = payType === "Monthly" ? monthlyRate / monthlyDivisor : dailyRate;
  const hourlyRate = dayRate / 8;
  const minuteRate = hourlyRate / 60;
  const otMultiplier = payRules.otMultiplier ?? 1.25;

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

  const taxableIncome = Math.max(0, round2(grossPay - nonTaxableEarnings - sssEe - philhealthEe - pagibigEe));
  const withholdingTax = hasCompensation ? withholdingTaxCompute(statutory.withholding_tax, taxableIncome) : 0;

  const netPay = round2(grossPay - sssEe - philhealthEe - pagibigEe - withholdingTax - otherDeductions);

  return {
    payType, rateUsed,
    presentDays, absentDays, paidLeaveDays, lwopDays,
    lateMinutes, undertimeMinutes, builtinOtMinutes, approvedOtMinutes: totalApprovedOt,
    regularPay, otPay, lateUndertimeDeduction, otherEarnings, grossPay,
    nightDiffMinutes, nightDiffPay, holidayPremiumPay, holidayUnworkedPay,
    sssEe, sssEr, philhealthEe, philhealthEr, pagibigEe, pagibigEr, withholdingTax,
    otherDeductions, netPay,
    days, // per-day breakdown -> payroll_line_days
  };
}

// 13th-month pay per PD 851: total BASIC salary actually earned in the year / 12.
function computeThirteenthMonth(totalBasicEarned) {
  return round2((Number(totalBasicEarned) || 0) / 12);
}

module.exports = {
  round2, clamp, leaveOverlap, sssLookup, philhealthCompute, pagibigCompute,
  withholdingTaxCompute, statutoryFactor, resolveRecurringComponents,
  holidayFor, multipliersFor, computeDay,
  computeEmployeeLine, computeThirteenthMonth,
};
