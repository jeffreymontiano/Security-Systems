// Billing maths for client Statements of Account.
//
// Pure — no database, no Express — for the same reason payrollEngine.js is:
// the arithmetic on a client invoice has to be testable in isolation, and two
// callers (the compute route and the SOA PDF) must never disagree about a
// figure.
//
// The formulas mirror the agency's existing "Billing Auto Compute Template"
// spreadsheet exactly, so a statement produced here reconciles with one
// produced by hand. Every rate and percentage arrives via `config` — nothing
// commercial is hardcoded, per the Money convention.

const { hhmmToMin } = require("./phTime");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Man-hour rate keeps four decimals: it is a unit price multiplied by up to a
// few hundred hours, so rounding it to centavos first would drift the line.
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const num = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

const DEFAULT_CONFIG = {
  adminFeePercent: 0.1224,
  withholdingTaxPercent: 0.02,
  manHourDivisor: 365,
  periodsPerMonth: 2,
  defaultContractRate: 33000,
  defaultDutyHours: 12,
};

function withDefaults(config) {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

// Contract rate resolves most-specific-first: this detachment's own rate, then
// the client's default, then the agency-wide fallback. Same shape for duty
// hours. A stored 0 is treated as "not set" — a free detachment is not a thing
// anyone means to configure, whereas a blank field saved as 0 is common.
function resolveContractRate(billingSite, client, config) {
  const cfg = withDefaults(config);
  return num(billingSite?.contractRate) > 0 ? Number(billingSite.contractRate)
    : num(client?.contractRate) > 0 ? Number(client.contractRate)
    : Number(cfg.defaultContractRate);
}

function resolveDutyHours(billingSite, config) {
  const cfg = withDefaults(config);
  return num(billingSite?.dutyHours) > 0 ? Number(billingSite.dutyHours) : Number(cfg.defaultDutyHours);
}

// The per-period figures for one detachment.
//
// Reproduced from the template:
//   manHourRate       = contractRate / 365          (spreadsheet: (rate*12/365)/12)
//   billingPeriodRate = (contractRate / 2) x guards
//   billingCost       = (billingPeriodRate + addAmount) - lessAmount
//   adminFee          = billingCost x 12.24%
//   dueForGuard       = billingCost - adminFee
//   withholdingTax    = adminFee x 2%
//   netAmount         = billingCost - withholdingTax
//
// One deliberate departure: every figure is rounded to centavos as it is
// produced, whereas the spreadsheet carries full precision and rounds only for
// display. Rounding here makes the printed statement FOOT — "amount to guards"
// plus "administrative overhead" equals the total. In the spreadsheet those
// two displayed figures sum to one centavo less than the total it prints
// beside them. The divergence is never more than a centavo per line.
function computeSiteBilling({ guards, contractRate, lessHours, addHours, config }) {
  const cfg = withDefaults(config);
  const g = Math.max(0, Math.round(num(guards)));
  const rate = Math.max(0, num(contractRate));
  const divisor = num(cfg.manHourDivisor) > 0 ? Number(cfg.manHourDivisor) : 365;
  const perMonth = num(cfg.periodsPerMonth) > 0 ? Number(cfg.periodsPerMonth) : 2;

  const manHourRate = round4(rate / divisor);
  const billingPeriodRate = round2((rate / perMonth) * g);
  const less = Math.max(0, num(lessHours));
  const add = Math.max(0, num(addHours));
  const lessAmount = round2(manHourRate * less);
  const addAmount = round2(manHourRate * add);

  // Deductions can in principle exceed the period rate (a detachment stood
  // down for most of a cutoff). Floor the billing cost at zero rather than
  // invoicing a negative amount, exactly as payroll floors net pay.
  const billingCost = round2(Math.max(0, billingPeriodRate + addAmount - lessAmount));
  const adminFee = round2(billingCost * num(cfg.adminFeePercent));
  const dueForGuard = round2(billingCost - adminFee);
  const withholdingTax = round2(adminFee * num(cfg.withholdingTaxPercent));
  const netAmount = round2(billingCost - withholdingTax);

  return {
    guards: g,
    contractRateUsed: round2(rate),
    manHourRate,
    billingPeriodRate,
    lessHours: round2(less),
    lessAmount,
    addHours: round2(add),
    addAmount,
    billingCost,
    adminFee,
    dueForGuard,
    withholdingTax,
    netAmount,
  };
}

// Scheduled length of a shift in hours, from its PH local start/end times.
// Falls back to the contracted duty hours when the roster row carries no
// times, so a shift template with blank hours can't silently bill zero.
function shiftHours(row, dutyHours) {
  if (!row || !row.startTime || !row.endTime) return num(dutyHours, 12);
  const start = hhmmToMin(row.startTime);
  const end = hhmmToMin(row.endTime);
  if (start == null || end == null) return num(dutyHours, 12);
  let mins = end - start;
  if (mins <= 0) mins += 24 * 60; // crosses midnight
  return round2(mins / 60);
}

// Turn one detachment's attendance into billable adjustments.
//
// The client contracts N guards x H hours per post. LESS is service the client
// paid for and did not receive; ADD is service delivered beyond the contract.
// Everything is itemised into `days` so a disputed statement can be answered
// day by day, and every total is an editable starting point rather than a
// verdict.
//
//   LESS  Absent / On Leave  -> the whole shift, nobody was on post
//         Undertime          -> the hours left early
//         Late               -> the hours the post stood unmanned at shift start
//   ADD   Extra duty         -> a duty day worked with no roster entry
//                               (reliever or additional post)
//         Excess OT          -> hours worked past shift end. Built-in OT is
//                               NOT included: it is inside the contracted
//                               12-hour shift and already paid for by the
//                               period rate.
//
// Rest days never produce a LESS — no service was contracted for them.
//
// `extraDutyDays` is supplied by the caller because computeReport() only emits
// rows for ROSTERED days; a guard who punched in at a post with no assignment
// leaves no row there at all.
//
// A third outcome sits beside LESS and ADD: PENDING. A day whose attendance is
// incomplete — a time IN with no time OUT — is priced as neither, because
// nothing about it can be priced honestly. See the block in the loop below.
function deriveFromAttendance(rows, { dutyHours, extraDutyDays = [] } = {}) {
  const contracted = num(dutyHours, 12);
  const days = [];
  const guardSet = new Set();
  let lessHours = 0;
  let addHours = 0;
  const pendingDays = [];

  const push = (kind, dutyDate, guardName, reason, hours) => {
    const h = round2(hours);
    if (h <= 0) return;
    days.push({ dutyDate, guardName: guardName || "", kind, reason, hours: h });
    if (kind === "less") lessHours += h;
    else addHours += h;
  };

  // A held day. It goes into `days` so the evidence panel can name it, but into
  // NEITHER total — its hours are what the day would have been worth, not what
  // is being charged. Recorded even at zero hours: the point is that the day
  // exists and is unresolved.
  const pushPending = (dutyDate, guardName, reason, hours) => {
    const entry = { dutyDate, guardName: guardName || "", kind: "pending", reason, hours: round2(hours) };
    days.push(entry);
    pendingDays.push(entry);
  };

  const hasFlag = (r, f) => Array.isArray(r.flags) && r.flags.includes(f);

  for (const r of rows || []) {
    if (r.status === "Rest Day") continue;
    // Held out of billing until an admin reconciles the site.
    //
    // The guard punched at a site they are not rostered at. Billed as it
    // stands, this day would take a LESS here (the rostered post reads
    // unmanned) AND an ADD at the site punched (an unrostered duty day) — two
    // clients moved in opposite directions off one wrong dropdown selection.
    // Neither figure is trustworthy until someone says which site is right, so
    // the day contributes nothing rather than contributing something wrong.
    //
    // It is NOT silently dropped: computeReport gives it the status "Pending
    // site review", which the attendance report and Absence Monitoring both
    // count and show. The matching ADD is suppressed in routes/billing.js,
    // which filters mismatched punches out of its unrostered-day query.
    if (r.siteReviewPending) continue;
    // A rostered day means a contracted post, whether or not it was manned.
    if (r.startTime && r.endTime) guardSet.add((r.guardName || "").trim().toLowerCase());

    const scheduled = shiftHours(r, contracted);

    // Held out of billing until the missing time-out is supplied.
    //
    // The guard timed in and never timed out. computeReport already detects
    // this and flags it "No time-out"; billing simply ignored the flag, and the
    // day fell through every branch below — not Absent (somebody was there),
    // not Undertime (undertime is the gap to a time-out that never arrived),
    // not On Leave. So the client was charged a full shift on the strength of a
    // punch that has no end, with nothing on the statement saying so.
    //
    // Deducting a full shift instead would be equally wrong in the other
    // direction: the guard probably worked it and the log is what failed. The
    // honest figure is no figure, so the day contributes nothing to either
    // total and is COUNTED instead, exactly as a site disagreement is.
    //
    // It resolves itself. Approving a Missing Time Log request writes the OUT,
    // computeReport stops flagging the day, and the next recompute prices it
    // like any other — there is no separate "resolve" action to build, and
    // Absence Monitoring's "No time-out" section is already the screen that
    // lists these days and files the correction.
    //
    // One deliberate departure from the site-mismatch hold: the guard IS still
    // counted above. A site disagreement means the punch belongs to another
    // post, so the guard was not here; a missing time-out means the guard was
    // here and the record is short. Dropping them from the headcount would
    // silently move the period rate — a commercial figure — because of a data
    // entry gap, which is not the hold's job.
    if (hasFlag(r, "No time-out")) {
      // Rostered days only. An UNROSTERED incomplete day reaches this loop too
      // (computeReport emits a row for it), but it is billed from
      // `extraDutyDays` below, and recording it in both places would count one
      // day twice.
      if (r.startTime && r.endTime) {
        pushPending(r.dutyDate, r.guardName, "Timed in with no time-out — awaiting correction", scheduled);
      }
      continue;
    }

    if (r.status === "Absent") {
      push("less", r.dutyDate, r.guardName, "Absent — post unmanned", scheduled);
      continue;
    }
    if (r.status === "On Leave") {
      push("less", r.dutyDate, r.guardName,
        `On leave${r.leaveType ? ` (${r.leaveType})` : ""} — no reliever`, scheduled);
      continue;
    }

    if (num(r.lateMin) > 0) {
      push("less", r.dutyDate, r.guardName, `Late ${r.lateMin} min`, num(r.lateMin) / 60);
    }
    if (num(r.undertimeMin) > 0) {
      push("less", r.dutyDate, r.guardName, `Undertime ${r.undertimeMin} min`, num(r.undertimeMin) / 60);
    }
    if (num(r.overtimeMin) > 0) {
      push("add", r.dutyDate, r.guardName, `Excess overtime ${r.overtimeMin} min`, num(r.overtimeMin) / 60);
    }
  }

  for (const e of extraDutyDays) {
    // Same hold on the ADD side. An unrostered duty day with no time-out is a
    // charge ABOVE the contract resting on a punch with no end — held for the
    // same reason and resolved by the same correction.
    if (e.incomplete) {
      pushPending(e.dutyDate, e.guardName,
        "Extra duty timed in with no time-out — awaiting correction", num(e.hours, contracted));
      continue;
    }
    push("add", e.dutyDate, e.guardName, e.reason || "Extra duty — no roster entry",
      num(e.hours, contracted));
  }

  days.sort((a, b) =>
    String(a.dutyDate).localeCompare(String(b.dutyDate)) ||
    a.kind.localeCompare(b.kind) ||
    a.guardName.localeCompare(b.guardName));

  return {
    derivedGuards: guardSet.size,
    lessHours: round2(lessHours),
    addHours: round2(addHours),
    days,
    // Held, not billed. The count is what gates Issue; the list is what the
    // statement line shows so the gate can be acted on rather than argued with.
    pendingDays,
    pendingCount: pendingDays.length,
  };
}

// "Three (3)" for the statement's particulars line.
//
// The spreadsheet nests IF() four deep and prints "Four (4)" for ANY count
// above three, so a five-guard detachment silently under-states itself on its
// own statement. This spells any count.
const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function spellNumber(n) {
  const v = Math.max(0, Math.round(num(n)));
  if (v < 20) return ONES[v];
  if (v < 100) return TENS[Math.floor(v / 10)] + (v % 10 ? `-${ONES[v % 10].toLowerCase()}` : "");
  if (v < 1000) {
    const rest = v % 100;
    return `${ONES[Math.floor(v / 100)]} hundred${rest ? ` ${spellNumber(rest).toLowerCase()}` : ""}`;
  }
  return String(v);
}

function numberToWords(n) {
  const v = Math.max(0, Math.round(num(n)));
  return `${spellNumber(v)} (${v})`;
}

// "1 Day(s) - 12 Hours", the statement's wording for an adjustment. Days are
// hours over the contracted shift length, as in the spreadsheet (which divides
// by a hardcoded 12 — here it follows the detachment's actual duty hours).
function hoursAsDays(hours, dutyHours) {
  const h = round2(hours);
  const per = num(dutyHours, 12) || 12;
  const days = Math.round((h / per) * 100) / 100;
  return { days, hours: h, label: `${days} Day(s) - ${h} Hours` };
}

module.exports = {
  round2,
  round4,
  DEFAULT_CONFIG,
  withDefaults,
  resolveContractRate,
  resolveDutyHours,
  shiftHours,
  computeSiteBilling,
  deriveFromAttendance,
  numberToWords,
  spellNumber,
  hoursAsDays,
};
