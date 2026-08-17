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

// phDateOf converts an epoch instant to its PH (UTC+8) calendar date, and
// addDays walks a YYYY-MM-DD string. Both come from the shared time module
// rather than being re-derived here — the Times convention exists because a
// bare date cast lands a 06:00 PH punch on the previous UTC day.
const { phDateOf, addDays } = require("./phTime");

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
  // How many days of full daily duty the flat baseline covers. See the calendar
  // deviation block in deriveSiteDayHours.
  standardPeriodDays: 15,
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

// The two commercial percentages, resolved client-first then agency-wide.
//
// Deliberately NOT the `> 0` test resolveContractRate uses. A client billed at
// 0% withholding tax is a real term someone may have negotiated, so a stored
// zero has to be honoured; a client on a zero contract rate is not a thing
// anyone means to configure, which is why that one reads 0 as "unset". Same
// shape as every other override in billing: `override ?? global`.
//
// Only these two are per-client. manHourDivisor, periodsPerMonth, soaPrefix,
// defaultContractRate and defaultDutyHours stay agency-wide by decision.
function resolveFeeConfig(config, client) {
  const cfg = withDefaults(config);
  const pick = (v, fallback) =>
    (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));
  return {
    ...cfg,
    adminFeePercent: pick(client?.adminFeePercent, cfg.adminFeePercent),
    withholdingTaxPercent: pick(client?.withholdingTaxPercent, cfg.withholdingTaxPercent),
  };
}

// The per-period figures for one detachment.
//
// Reproduced from the template:
//   manHourRate       = contractRate / 365          (spreadsheet: (rate*12/365)/12)
//   billingPeriodRate = (contractRate / 2) x guards
//   billingCost       = (billingPeriodRate + addAmount) - lessAmount
//                       + legalHoliday + specialHoliday
//   adminFee          = billingCost x 12.24%
//   dueForGuard       = billingCost - adminFee
//   withholdingTax    = adminFee x 2%      <- OF THE FEE, not of billingCost
//   netAmount         = billingCost - withholdingTax
//
// Withholding is taken from the ADMINISTRATIVE FEE, not from the billing cost.
// That is what the agency's own statements show, and it is why folding holiday
// pay into billingCost is enough to make it taxed: everything below the cost
// line recomputes from it.
//
// One deliberate departure: every figure is rounded to centavos as it is
// produced, whereas the spreadsheet carries full precision and rounds only for
// display. Rounding here makes the printed statement FOOT — "amount to guards"
// plus "administrative overhead" equals the total. In the spreadsheet those
// two displayed figures sum to one centavo less than the total it prints
// beside them. The divergence is never more than a centavo per line.
function computeSiteBilling({ guards, contractRate, lessHours, addHours, legalHolidayAmount, specialHolidayAmount, config }) {
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

  // Holiday pay is typed by the biller, not derived, and it is billable REVENUE
  // — so it joins the base here, before the fee and withholding layer, rather
  // than being added to the net afterwards. A line with none is arithmetically
  // untouched: both default to 0.
  const legalHoliday = Math.max(0, num(legalHolidayAmount));
  const specialHoliday = Math.max(0, num(specialHolidayAmount));

  // Deductions can in principle exceed the period rate (a detachment stood
  // down for most of a cutoff). Floor the billing cost at zero rather than
  // invoicing a negative amount, exactly as payroll floors net pay.
  const billingCost = round2(Math.max(0,
    billingPeriodRate + addAmount - lessAmount + legalHoliday + specialHoliday));
  const adminFeePercent = num(cfg.adminFeePercent);
  const withholdingTaxPercent = num(cfg.withholdingTaxPercent);
  const adminFee = round2(billingCost * adminFeePercent);
  const dueForGuard = round2(billingCost - adminFee);
  const withholdingTax = round2(adminFee * withholdingTaxPercent);
  const netAmount = round2(billingCost - withholdingTax);

  return {
    guards: g,
    contractRateUsed: round2(rate),
    // Reported back so the caller can snapshot what was applied. A percentage
    // that only exists in config cannot be printed on a statement issued under
    // a different one.
    adminFeePercentUsed: adminFeePercent,
    withholdingTaxPercentUsed: withholdingTaxPercent,
    manHourRate,
    billingPeriodRate,
    lessHours: round2(less),
    lessAmount,
    addHours: round2(add),
    addAmount,
    legalHolidayAmount: round2(legalHoliday),
    specialHolidayAmount: round2(specialHoliday),
    billingCost,
    adminFee,
    dueForGuard,
    withholdingTax,
    netAmount,
  };
}

// ---------------------------------------------------------------------------
// Site-level man-hour derivation. THE ROSTER IS NOT READ.
//
// The client contracts a POST, not a person: N guards x H hours at this site,
// every calendar day. What they are owed is measured against what was actually
// worked there — so the only inputs are the punches at this site and the
// contract, and the schedule is irrelevant. A guard on relief duty, a
// reassignment, a rest day covered by somebody else: none of it matters, because
// all of it shows up either as hours on the post or as their absence.
//
// This REPLACED a per-guard model that walked roster rows and accumulated LESS
// (absent / on leave / late / undertime) and ADD (excess OT / unrostered day)
// INDEPENDENTLY. That model routinely produced both on one site-day — an absent
// guard crediting a shift while a reliever charged for one — which is the
// two-step this deterministic net rule exists to remove.
//
//   actual   = SUM over COMPLETED pairs of MIN(shiftDuration, standardShiftHours)
//   required = contractedGuards x standardShiftHours
//   net      = actual - required      ->  >0 ADD | <0 LESS | 0 nothing
//
// One signed scalar per site-day, so simultaneous gross ADD and LESS on the same
// day is not reachable. (A PERIOD can still carry both totals, summed from
// different days — that is correct, not a leak.)
//
// An incomplete pair contributes ZERO and holds the day. Note what that means:
// a held shift now CREATES a LESS, because hours nobody can evidence are hours
// the client did not receive. That is a deliberate reversal of the previous
// behaviour, where a held day was neutral and contributed to neither total.

const normName = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
const HOUR_MS = 3600000;

// "17:39" in PH local time, for an evidence line.
function phClock(ms) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

// Pair one guard's punches into shifts over a CONTINUOUS time-ordered stream.
//
// Bucketing by calendar day first and pairing inside each bucket is the obvious
// implementation and it is wrong: an 18:00->06:00 shift would leave an IN with
// no OUT on one day and an OUT with no IN on the next, corrupting both. So the
// stream is walked whole, and each completed pair is attributed to the PH date
// of its IN punch.
function pairPunches(list) {
  const completed = [];
  const held = [];
  const unmatchedOuts = [];
  const ordered = [...list].sort((a, b) => a.at - b.at);

  let openIn = null;
  for (const p of ordered) {
    if (p.type === "IN") {
      // A second IN while one is still open means the first never closed.
      if (openIn) held.push(openIn);
      openIn = p;
      continue;
    }
    // An OUT with no IN before it is ignored, and reported so it is not silent.
    if (!openIn) { unmatchedOuts.push(p); continue; }
    completed.push({
      guardName: openIn.guardName, inAt: openIn.at, outAt: p.at,
      hours: (p.at - openIn.at) / HOUR_MS,
    });
    openIn = null;
  }
  if (openIn) held.push(openIn);
  return { completed, held, unmatchedOuts };
}

// Every PH calendar date from `from` to `to` inclusive. The requirement applies
// to EVERY day — a rest day, an absence or a reassignment has no bearing on what
// the client contracted, so an unrelieved post is a genuine shortfall.
function eachDate(from, to) {
  const out = [];
  if (!from || !to) return out;
  for (let d = String(from); d <= String(to); d = addDays(d, 1)) out.push(d);
  return out;
}

// `punches` are THIS SITE's punches only, each { guardName, type: "IN"|"OUT",
// at: epoch ms }. The caller must include punches up to one day past `to` so a
// shift starting on the last day can still be closed; a pair whose IN falls
// outside [from, to] belongs to another period and is dropped here.
function deriveSiteDayHours(punches, { standardShiftHours, contractedGuards, from, to, standardPeriodDays } = {}) {
  // Resolve through num() on BOTH sides of the test. Writing
  // `num(x, 12) > 0 ? Number(x) : 12` reads as a fallback but is not one: for an
  // undefined argument the guard passes on the fallback and then hands back
  // Number(undefined) = NaN. NaN then propagates silently — round2 coerces it to
  // 0 — which disabled the calendar deviation below entirely and made a suite of
  // tests pass by doing nothing.
  const stdRaw = num(standardShiftHours, 12);
  const std = stdRaw > 0 ? stdRaw : 12;
  const stdDaysRaw = num(standardPeriodDays, 15);
  const stdDays = stdDaysRaw > 0 ? stdDaysRaw : 15;
  const guards = Math.max(0, Math.round(num(contractedGuards)));
  const requiredPerDay = round2(guards * std);

  const byGuard = new Map();
  for (const p of punches || []) {
    const k = normName(p.guardName);
    if (!byGuard.has(k)) byGuard.set(k, []);
    byGuard.get(k).push(p);
  }

  const worked = new Map();          // date -> guardKey -> { guardName, hours }
  const heldShifts = [];
  const unmatchedOuts = [];
  const inWindow = (d) => (!from || d >= from) && (!to || d <= to);

  for (const [gk, list] of byGuard) {
    const paired = pairPunches(list);
    for (const u of paired.unmatchedOuts) {
      const d = phDateOf(u.at);
      if (inWindow(d)) unmatchedOuts.push({ guardName: u.guardName, dutyDate: d, at: u.at });
    }
    for (const h of paired.held) {
      const d = phDateOf(h.at);
      if (inWindow(d)) heldShifts.push({ guardName: h.guardName, dutyDate: d, inAt: h.at });
    }
    for (const c of paired.completed) {
      const d = phDateOf(c.inAt);
      if (!inWindow(d)) continue;
      // Cap 1: no single shift counts for more than a standard shift.
      const capped = Math.min(c.hours, std);
      if (!worked.has(d)) worked.set(d, new Map());
      const day = worked.get(d);
      const cur = day.get(gk) || { guardName: c.guardName, hours: 0 };
      cur.hours += capped;
      day.set(gk, cur);
    }
  }

  const heldByDate = new Map();
  for (const h of heldShifts) {
    if (!heldByDate.has(h.dutyDate)) heldByDate.set(h.dutyDate, []);
    heldByDate.get(h.dutyDate).push(h);
  }

  const days = [];
  const pendingDays = [];
  const guardsSeen = new Set();
  let lessHours = 0, addHours = 0, actualTotal = 0, requiredTotal = 0;
  // Days the post was over- or under-manned WITHIN the period, kept so the
  // statement can name them ("Feb 22 2026 Augmentation").
  const overDates = [];
  const shortDates = [];

  // The flat baseline covers the FIRST `stdDays` days of the period. Days beyond
  // that were never paid for by it, so they are treated differently below.
  const allDates = eachDate(from, to);
  const baselineDates = allDates.slice(0, Math.max(0, Math.floor(stdDays)));
  const extraDates = allDates.slice(Math.max(0, Math.floor(stdDays)));

  // Hours actually worked on one date, capped per guard, plus the wording.
  const workedOn = (d) => {
    const day = worked.get(d) || new Map();
    const parts = [];
    let actual = 0;
    for (const [gk, v] of day) {
      // Cap 2: a guard cannot fill more than one post's daily requirement,
      // however many times they came and went.
      const h = round2(Math.min(v.hours, std));
      if (h <= 0) continue;
      actual += h;
      guardsSeen.add(gk);
      parts.push(`${v.guardName} ${h}`);
    }
    return { actual: round2(actual), parts };
  };

  // Held shifts are recorded whatever the day comes to. They contribute zero
  // hours, so they can only lower `actual` — a surplus never cancels one, and a
  // day can legitimately read ADD while still being held.
  const recordHeld = (d) => {
    for (const h of heldByDate.get(d) || []) {
      const entry = {
        dutyDate: d, guardName: h.guardName || "", kind: "pending",
        reason: `Timed in ${phClock(h.inAt)} with no time-out — 0 h counted, awaiting correction`,
        hours: 0,
      };
      days.push(entry);
      pendingDays.push(entry);
    }
  };

  // --- Days the baseline covers: net worked against contracted ---------------
  for (const d of baselineDates) {
    const { actual, parts } = workedOn(d);
    actualTotal += actual;
    requiredTotal += requiredPerDay;
    recordHeld(d);

    const net = round2(actual - requiredPerDay);
    if (net === 0) continue;

    const detail = parts.length ? ` — ${parts.join(", ")}` : "";
    const basis = `Required ${requiredPerDay} h (${guards} guard(s) x ${std} h); worked ${actual} h${detail}`;
    if (net > 0) {
      days.push({ dutyDate: d, guardName: "", kind: "add", reason: `${basis}; ${net} h over`, hours: net });
      addHours += net;
      overDates.push(d);
    } else {
      days.push({ dutyDate: d, guardName: "", kind: "less", reason: `${basis}; ${Math.abs(net)} h short`, hours: Math.abs(net) });
      lessHours += Math.abs(net);
      shortDates.push(d);
    }
  }

  // --- Days BEYOND the standard: whatever was worked is service beyond -------
  //
  // The flat baseline bought `stdDays` days. A 16-day August has a day the
  // client has not paid for, so anything worked on it is an augmentation — and
  // anything NOT worked on it is simply nothing. It must never take a LESS: you
  // cannot credit somebody for a day they never bought.
  //
  // This is the half that is easy to get wrong. Applying the ordinary per-day
  // requirement to the extra days and then adding a flat calendar augmentation
  // nets to the same figure, but grosses up the statement absurdly: an entirely
  // unmanned 16-day post read "LESS 16 days" AND "ADDITIONAL 1 day" — billing an
  // augmentation for a day nobody worked — and both landed on the same date.
  const extraWorkedDates = [];
  for (const d of extraDates) {
    const { actual, parts } = workedOn(d);
    actualTotal += actual;
    recordHeld(d);
    if (actual <= 0) continue;
    const detail = parts.length ? ` — ${parts.join(", ")}` : "";
    days.push({
      dutyDate: d, guardName: "", kind: "add",
      reason: `Day ${allDates.indexOf(d) + 1} of the period, beyond the ${stdDays}-day standard the period rate covers; worked ${actual} h${detail}`,
      hours: actual,
    });
    addHours += actual;
    overDates.push(d);
    extraWorkedDates.push(d);
  }

  // --- Days the standard has but the calendar does not ----------------------
  //
  // A 13-day February against a 15-day standard is short by two days that do
  // not exist — the agency writes "No calendar date: Feb 29-30". The client paid
  // for them, so they are credited in full.
  const actualDays = allDates.length;
  let calendarDeviation = null;
  if (actualDays < stdDays) {
    const missingDays = round2(stdDays - actualDays);
    const missingHours = round2(missingDays * guards * std);
    if (missingHours > 0) {
      calendarDeviation = { kind: "less", days: missingDays, hours: missingHours, actualDays, standardPeriodDays: stdDays };
      // Dated at the last REAL day: billing_line_days.dutyDate is NOT NULL and
      // Feb 29 does not exist, so an imaginary date cannot be stored. The reason
      // carries the meaning, and this is the one row that describes the period
      // rather than its date — see the determinism note in CLAUDE.md.
      days.push({
        dutyDate: to, guardName: "", kind: "less",
        reason: `No calendar date: the period runs ${actualDays} days against a ${stdDays}-day standard; ${missingDays} day(s) x ${guards} guard(s) x ${std} h credited`,
        hours: missingHours,
      });
      lessHours += missingHours;
    }
  } else if (extraWorkedDates.length || actualDays > stdDays) {
    // Reported for the statement's wording even when the extra days were unworked.
    calendarDeviation = {
      kind: "add", days: actualDays - stdDays, hours: 0, actualDays, standardPeriodDays: stdDays,
      workedDates: extraWorkedDates,
    };
  }

  days.sort((a, b) =>
    String(a.dutyDate).localeCompare(String(b.dutyDate)) ||
    a.kind.localeCompare(b.kind) ||
    a.guardName.localeCompare(b.guardName));

  return {
    // Distinct guards who actually worked a completed shift here. No longer a
    // roster figure — it sits beside the contracted count so a divergence
    // between who is billed for and who turned up stays visible.
    derivedGuards: guardsSeen.size,
    lessHours: round2(lessHours),
    addHours: round2(addHours),
    actualHours: round2(actualTotal),
    // The requirement actually APPLIED per day — over the baseline days only.
    // Days beyond the standard carry none, which is what stops an unworked extra
    // day taking a LESS for a day the client never bought. For a short period
    // this falls below standardRequiredHours by exactly the missing-days credit.
    requiredHours: round2(requiredTotal),
    standardRequiredHours: round2(stdDays * guards * std),
    // Structured, not worded: the statement's phrasing is composed in
    // routes/billing.js, which owns date formatting. The engine stays pure maths.
    calendarDeviation,
    overDates,
    shortDates,
    days,
    pendingDays,
    pendingCount: pendingDays.length,
    // Reported, never silently swallowed — see the pairing rules above.
    unmatchedOuts,
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

// "1 Days, 12 Hours", the statement's wording for an adjustment.
//
// "Days" here are GUARD-days, not calendar days: hours over the contracted shift
// length, as in the spreadsheet (which divides by a hardcoded 12 — here it
// follows the detachment's actual duty hours). So 72 h at a 12 h post is 6
// guard-shifts, which is what the client is being credited for.
function hoursAsDays(hours, dutyHours) {
  const h = round2(hours);
  const per = num(dutyHours, 12) || 12;
  const days = Math.round((h / per) * 100) / 100;
  return { days, hours: h, label: `${days} Days, ${h} Hours` };
}

module.exports = {
  round2,
  round4,
  DEFAULT_CONFIG,
  withDefaults,
  resolveContractRate,
  resolveDutyHours,
  resolveFeeConfig,
  computeSiteBilling,
  deriveSiteDayHours,
  pairPunches,
  numberToWords,
  spellNumber,
  hoursAsDays,
};
