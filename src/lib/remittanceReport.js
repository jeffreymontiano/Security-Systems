/**
 * The monthly statutory remittance report (Known Gap 30, Phase 2).
 *
 * What Accounting files with SSS, PhilHealth and Pag-IBIG each month. It READS
 * stored figures and computes nothing: every peso here was assessed by
 * payrollEngine and written to payroll_lines. This module only decides which
 * cutoffs belong to the month, aggregates, and — the part that carries the
 * weight — says honestly when it cannot answer.
 *
 * Pure: no DB, no I/O.
 *
 * THE SAFETY RULE THIS IS BUILT AROUND: a PENDING agency never renders a
 * numeric total. Every configured agency is expected every month, so a missing
 * figure means "pending, act on it" and never "nothing owed". A zero would be
 * indistinguishable from a real nil return, and in a spreadsheet a SUM() would
 * sweep it into a filing. `total` is therefore `null` when pending, and the
 * callers render text.
 *
 * PER-AGENCY INDEPENDENCE: each agency resolves alone. PhilHealth and Pag-IBIG
 * render in full even when SSS's cutoff has never been run. There is no
 * wholesale refusal, because the common real case is exactly that -- one
 * contribution's cutoff computed and another's not.
 */

const { sssLookup, resolveCutoffs, round2 } = require("./payrollEngine");

const AGENCIES = [
  { key: "sss", label: "SSS", idField: "sssNo", idLabel: "SSS No",
    ee: "sssEe", er: "sssEr", ec: "sssEc" },
  { key: "philhealth", label: "PhilHealth", idField: "philhealthNo", idLabel: "PhilHealth No",
    ee: "philhealthEe", er: "philhealthEr", ec: null },
  { key: "pagibig", label: "Pag-IBIG", idField: "pagibigNo", idLabel: "Pag-IBIG No",
    ee: "pagibigEe", er: "pagibigEr", ec: null },
];

const isFirstCutoffOf = (periodStart) => Number(String(periodStart).split("-")[2]) <= 15;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// A period has usable figures only once it has been computed. Draft means the
// lines have not been produced yet (or were invalidated), so its zeros are not
// an answer.
const isComputed = (p) => p && p.status && p.status !== "Draft";

/**
 * @param month        "YYYY-MM"
 * @param periods      [{ id, periodStart, periodEnd, status }] whose periodStart is in the month
 * @param linesByPeriod  { [periodId]: [payroll_lines rows] }
 * @param employees    [{ id, sssNo, philhealthNo, pagibigNo }]
 * @param statutory    { sss, pay_rules, ... } -- the payroll_statutory_config rows
 */
function buildRemittance({ month, periods = [], linesByPeriod = {}, employees = [], statutory = {} }) {
  const cutoffs = resolveCutoffs(statutory.pay_rules || {});
  const empById = new Map(employees.map((e) => [e.id, e]));
  const monthlyDivisor = num((statutory.pay_rules || {}).monthlyDivisor) || 30;

  const first = periods.find((p) => isFirstCutoffOf(p.periodStart)) || null;
  const second = periods.find((p) => !isFirstCutoffOf(p.periodStart)) || null;

  const slot = (which) => {
    const p = which === "first" ? first : second;
    const lines = p ? (linesByPeriod[p.id] || []) : [];
    return {
      which, period: p, lines,
      ok: !!p && isComputed(p) && lines.length > 0,
      reason: !p
        ? `${which === "first" ? "1st" : "2nd"}-cutoff period not found`
        : !isComputed(p)
          ? "period exists but not computed - run Compute"
          : lines.length === 0
            ? "period computed but holds no payroll lines"
            : null,
    };
  };

  const agencies = AGENCIES.map((a) => resolveAgency({
    a, mode: cutoffs[a.key], slot, empById, statutory, monthlyDivisor,
  }));

  return { month, agencies, periodsFound: periods.map((p) => ({ ...p, cutoff: isFirstCutoffOf(p.periodStart) ? "first" : "second" })) };
}

function resolveAgency({ a, mode, slot, empById, statutory, monthlyDivisor }) {
  const base = {
    key: a.key, label: a.label, idLabel: a.idLabel, cutoffMode: mode,
    hasEc: !!a.ec, columns: columnsFor(a),
    rows: [], excluded: [], warnings: [], total: null,
    status: "pending", pendingReason: null, incomplete: false,
    cutoffsUsed: [],
  };

  const needed = mode === "split" ? ["first", "second"] : [mode];
  const slots = needed.map(slot);
  base.cutoffsUsed = slots.map((s) => ({
    which: s.which, periodId: s.period ? s.period.id : null,
    periodStart: s.period ? s.period.periodStart : null,
    status: s.period ? s.period.status : null, ok: s.ok, reason: s.reason,
  }));

  const bad = slots.filter((s) => !s.ok);
  if (bad.length) {
    // "not yet computed" is the honest headline in every case; the specific
    // cause follows, because the three causes need different actions.
    base.pendingReason = mode === "split" && bad.length < slots.length
      ? `split: other cutoff not yet computed - incomplete (${bad[0].which} cutoff: ${bad[0].reason})`
      : `not yet computed - ${bad.map((s) => `${s.which} cutoff: ${s.reason}`).join("; ")}`;
    return base; // total stays null. Never 0.
  }

  // --- READY ---------------------------------------------------------------
  base.status = "ready";

  // Aggregate per employee ACROSS the assigned cutoffs, so `split` sums to the
  // month and a single-cutoff mode passes straight through.
  const byEmp = new Map();
  const seenIn = new Map(); // employeeId -> Set(which cutoffs they had a line in)
  for (const s of slots) {
    for (const l of s.lines) {
      const id = l.employeeId;
      if (id == null) continue;
      if (!byEmp.has(id)) {
        byEmp.set(id, {
          employeeId: id, employeeNo: l.employeeNo || "", employeeName: l.employeeName || "",
          payType: l.payType, rateUsed: num(l.rateUsed),
          ee: 0, er: 0, ec: 0,
        });
      }
      const row = byEmp.get(id);
      row.ee = round2(row.ee + num(l[a.ee]));
      row.er = round2(row.er + num(l[a.er]));
      if (a.ec) row.ec = round2(row.ec + num(l[a.ec]));
      if (!seenIn.has(id)) seenIn.set(id, new Set());
      seenIn.get(id).add(s.which);
    }
  }

  // Known Gap 30 section 3a, DEFERRED but made SAFE. Nothing is configured
  // `split` today, so this cannot fire; it exists so that a future config
  // change cannot silently understate a filing. A guard present in one half of
  // a split month and not the other has had only part of the month's
  // obligation collected -- resolving that properly means modelling
  // obligation-vs-collected, which is not built. So the condition is DETECTED
  // and named rather than quietly summed into a clean-looking total.
  if (mode === "split") {
    const partial = [...seenIn.entries()].filter(([, set]) => set.size < slots.length);
    if (partial.length) {
      base.incomplete = true;
      base.warnings.push({
        kind: "split_partial_month",
        text: `Split contribution, partial month - collected may understate the monthly `
          + `obligation for ${partial.length} employee(s) who appear in only one cutoff. `
          + `This total is INCOMPLETE.`,
      });
    }
  }

  // Member ID join. A guard with no ID for THIS agency is listed separately and
  // left out of the total -- never silently dropped, because the filing has to
  // account for them one way or the other.
  const sssCfg = statutory.sss || {};
  let staleEc = 0;
  for (const row of byEmp.values()) {
    const emp = empById.get(row.employeeId) || {};
    const memberId = String(emp[a.idField] || "").trim();

    if (a.key === "sss") {
      const monthlyComp = row.payType === "Monthly" ? row.rateUsed : row.rateUsed * monthlyDivisor;
      const b = bracketFor(sssCfg, monthlyComp);
      row.msc = b ? num(b.msc) : null;
      // STALE-EC DETECTION, derived from the data rather than a deploy date.
      // Every bracket carries an ec, so a line whose bracket has ec > 0 while
      // its stored sssEc is 0 -- with a real EE beside it -- was computed by an
      // engine that did not assess EC (before Phase 1). It needs recomputing or
      // the SSS filing goes EC-short.
      if (b && num(b.ec) > 0 && row.ec === 0 && row.ee > 0) staleEc++;
    }

    row.memberId = memberId;
    row.total = round2(row.ee + row.er + (a.ec ? row.ec : 0));

    // A NON-CONTRIBUTOR is not listed at all -- not in the rows, and not as an
    // omission. Compute writes a line for every ACTIVE employee, so a guard with
    // no compensation this cutoff carries a zero line; listing them would put
    // most of the register on a filing that is meant to name who owes what.
    //
    // It matters most for the excluded list, whose whole purpose is to be acted
    // on: measured on dev, four employees appeared as "no SSS number on file"
    // when only one had actually contributed without one. Burying the real case
    // among zero-value rows makes the list useless.
    if (row.total === 0) continue;

    if (!memberId) base.excluded.push(row); else base.rows.push(row);
  }

  if (staleEc > 0) {
    base.warnings.push({
      kind: "stale_ec",
      text: `${staleEc} line(s) carry EC of 0 against a bracket that charges it - these were `
        + `computed before EC was introduced. Recompute the SSS cutoff period, or the `
        + `remittance understates EC.`,
    });
  }

  base.rows.sort((x, y) => String(x.employeeName).localeCompare(String(y.employeeName)));
  base.excluded.sort((x, y) => String(x.employeeName).localeCompare(String(y.employeeName)));

  if (base.excluded.length) {
    base.warnings.push({
      kind: "missing_member_id",
      text: `${base.excluded.length} employee(s) have no ${a.idLabel} on file and are excluded `
        + `from the total. Add the number in the 201 File, or file for them separately.`,
    });
  }

  base.total = round2(base.rows.reduce((s, r) => s + r.total, 0));
  base.totalEe = round2(base.rows.reduce((s, r) => s + r.ee, 0));
  base.totalEr = round2(base.rows.reduce((s, r) => s + r.er, 0));
  if (a.ec) base.totalEc = round2(base.rows.reduce((s, r) => s + r.ec, 0));
  return base;
}

function bracketFor(cfg, monthlyComp) {
  const brackets = (cfg && cfg.brackets) || [];
  if (!brackets.length) return null;
  let b = brackets.find((x) => monthlyComp >= x.minMsc && monthlyComp <= x.maxMsc);
  if (!b) b = monthlyComp > brackets[brackets.length - 1].maxMsc ? brackets[brackets.length - 1] : brackets[0];
  return b;
}

function columnsFor(a) {
  const cols = [
    { k: "employeeNo", label: "Emp No" },
    { k: "employeeName", label: "Name" },
    { k: "memberId", label: a.idLabel },
  ];
  if (a.key === "sss") cols.push({ k: "msc", label: "MSC", money: true });
  cols.push({ k: "ee", label: "Employee", money: true });
  cols.push({ k: "er", label: "Employer", money: true });
  if (a.ec) cols.push({ k: "ec", label: "EC", money: true });
  cols.push({ k: "total", label: "Total", money: true });
  return cols;
}

// The one string both exports use for a pending agency's total, so a PDF and a
// workbook can never disagree about what "no figure" looks like.
const PENDING_TOTAL_TEXT = "PENDING - NOT YET COMPUTED";

function monthLabel(month) {
  const [y, m] = String(month).split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return names[m - 1] ? `${names[m - 1]} ${y}` : String(month);
}

const isValidMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));

module.exports = {
  buildRemittance, AGENCIES, PENDING_TOTAL_TEXT, monthLabel, isValidMonth,
  isFirstCutoffOf, bracketFor,
};
