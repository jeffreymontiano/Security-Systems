// Pure payroll computation — no DB access, so the money math is easy to read
// and test in isolation. Routes/payroll.js gathers the inputs (attendance
// rows from attendance-reports.js's computeReport(), approved OT minutes,
// overlapping leave records, the employee's rate, and the admin-editable
// statutory config) and hands them to computeEmployeeLine().

const { countLeaveDays } = require("./leaveCredits");

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
function computeEmployeeLine({ employee, attendanceRows, approvedOtMinutes, leaveRecords, isGuard, components, statutory, isFirstCutoff, periodStart, periodEnd }) {
  const payRules = statutory.pay_rules || {};
  const payType = employee.payType === "Monthly" ? "Monthly" : "Daily";
  const dailyRate = Number(employee.dailyRate) || 0;
  const monthlyRate = Number(employee.monthlyRate) || 0;
  const rateUsed = payType === "Monthly" ? monthlyRate : dailyRate;

  let presentDays = 0, absentDays = 0, lateMinutes = 0, undertimeMinutes = 0, builtinOtMinutes = 0;
  for (const r of attendanceRows || []) {
    if (r.status === "Present") presentDays++;
    else if (r.status === "Absent") absentDays++;
    lateMinutes += r.lateMin || 0;
    undertimeMinutes += r.undertimeMin || 0;
    builtinOtMinutes += r.builtinOtMin || 0;
  }

  let paidLeaveDays = 0, lwopDays = 0;
  for (const rec of leaveRecords || []) {
    const ov = leaveOverlap(rec, periodStart, periodEnd, isGuard);
    if (ov) { paidLeaveDays += ov.paidDays; lwopDays += ov.lwopDays; }
  }
  paidLeaveDays = round2(paidLeaveDays);
  lwopDays = round2(lwopDays);

  const monthlyDivisor = payRules.monthlyDivisor || 30;
  const dayRate = payType === "Monthly" ? monthlyRate / monthlyDivisor : dailyRate;
  const hourlyRate = dayRate / 8;
  const minuteRate = hourlyRate / 60;

  const regularPay = payType === "Monthly"
    ? round2(monthlyRate / 2 - (absentDays + lwopDays) * dayRate)
    : round2(dailyRate * (presentDays + paidLeaveDays));

  const lateUndertimeDeduction = round2((lateMinutes + undertimeMinutes) * minuteRate);

  const otMultiplier = payRules.otMultiplier ?? 1.25;
  const totalOtMinutes = builtinOtMinutes + (approvedOtMinutes || 0);
  const otPay = round2((totalOtMinutes / 60) * hourlyRate * otMultiplier);

  const earningComponents = (components || []).filter((c) => c.kind === "Earning");
  const deductionComponents = (components || []).filter((c) => c.kind === "Deduction");
  const otherEarnings = round2(earningComponents.reduce((s, c) => s + Number(c.amount || 0), 0));
  const otherDeductions = round2(deductionComponents.reduce((s, c) => s + Number(c.amount || 0), 0));
  const nonTaxableEarnings = round2(earningComponents.filter((c) => !c.taxable).reduce((s, c) => s + Number(c.amount || 0), 0));

  const grossPay = round2(regularPay + otPay + otherEarnings - lateUndertimeDeduction);

  const monthlyComp = payType === "Monthly" ? monthlyRate : dailyRate * monthlyDivisor;
  const factor = statutoryFactor(payRules.statutoryCutoff, isFirstCutoff);

  const sss = sssLookup(statutory.sss, monthlyComp);
  const philhealth = philhealthCompute(statutory.philhealth, monthlyComp);
  const pagibig = pagibigCompute(statutory.pagibig, monthlyComp);

  const sssEe = round2(sss.ee * factor), sssEr = round2(sss.er * factor);
  const philhealthEe = round2(philhealth.ee * factor), philhealthEr = round2(philhealth.er * factor);
  const pagibigEe = round2(pagibig.ee * factor), pagibigEr = round2(pagibig.er * factor);

  const taxableIncome = Math.max(0, round2(grossPay - nonTaxableEarnings - sssEe - philhealthEe - pagibigEe));
  const withholdingTax = withholdingTaxCompute(statutory.withholding_tax, taxableIncome);

  const netPay = round2(grossPay - sssEe - philhealthEe - pagibigEe - withholdingTax - otherDeductions);

  return {
    payType, rateUsed,
    presentDays, absentDays, paidLeaveDays, lwopDays,
    lateMinutes, undertimeMinutes, builtinOtMinutes, approvedOtMinutes: approvedOtMinutes || 0,
    regularPay, otPay, lateUndertimeDeduction, otherEarnings, grossPay,
    sssEe, sssEr, philhealthEe, philhealthEr, pagibigEe, pagibigEr, withholdingTax,
    otherDeductions, netPay,
  };
}

// 13th-month pay per PD 851: total BASIC salary actually earned in the year / 12.
function computeThirteenthMonth(totalBasicEarned) {
  return round2((Number(totalBasicEarned) || 0) / 12);
}

module.exports = {
  round2, clamp, leaveOverlap, sssLookup, philhealthCompute, pagibigCompute,
  withholdingTaxCompute, statutoryFactor, resolveRecurringComponents,
  computeEmployeeLine, computeThirteenthMonth,
};
