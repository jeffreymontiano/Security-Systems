// Monthly Disposition Report logic.
//
// Pure — no database — like payrollEngine.js, billingEngine.js and
// ddoHelpers.js, and for the same reason: the report screen, the PDF and the
// finalise check must all reach the same numbers, and a document filed with
// the PNP cannot have two of them disagreeing.
//
// THIS FILE IS THE ONLY PLACE A RETURN IS JUDGED. Every validation rule, its
// severity, and the decision of whether a return may be finalised live here
// and nowhere else. The API serves `reportIssues()` output to the screen and
// calls `finaliseCheck()` before writing; the frontend renders what it is
// given and never re-derives a verdict. That is what makes it impossible for
// the UI to say a return is filable while the API refuses it, or the reverse.
//
// Sections 1 (firearms per province) and 3 (recapitulation) are likewise
// computed here and stored nowhere — persisting them would let a return's
// summary drift from its own body.

const { phDateOf } = require("./phTime");

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const SMALL_ARMS = "Small Arms";
const LIGHT_WEAPONS = "Light Weapons";

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const iso = (d) => (d ? String(d).slice(0, 10) : "");
const today = () => phDateOf(Date.now());
const bySort = (a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id);

// ---------------------------------------------------------------------------
// The month — one field, three renderings
// ---------------------------------------------------------------------------

// `periodMonth` is stored as "YYYY-MM" and is the ONLY place a month is
// recorded. The intro sentence, the certification line and the download
// filename are all rendered from it here, so they can never name different
// months — which the source workbook does, calling itself February in its
// filename, July in its body and MAY in its certification.
function monthPhrases(periodMonth) {
  const hit = /^(\d{4})-(\d{1,2})$/.exec(str(periodMonth));
  const none = { valid: false, body: "", certification: "", file: "", label: "", year: null, month: null };
  if (!hit) return none;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  if (m < 1 || m > 12) return none;
  const body = `${MONTHS[m - 1]} ${y}`;
  return {
    valid: true,
    year: y,
    month: m,
    label: body,                       // the list screen
    body,                              // "…for the month of February 2026"
    certification: body.toUpperCase(), // "…for the Month of FEBRUARY 2026"
    file: `${MONTHS[m - 1]}${y}`,      // MDR-RCSU3-February2026.pdf
  };
}

// The subject line is composed, never typed — so it always names the same
// month the body and the certification do.
function subjectLine(region, periodMonth) {
  const r = str(region);
  const base = `Monthly Disposition Report re: Deployment within ${r || "the Region"}`;
  const p = monthPhrases(periodMonth);
  return p.valid ? `${base} for ${p.body}` : base;
}

// The certification sentence, reproducing the form's own wording (including
// its missing "of").
function certificationLine(periodMonth) {
  const p = monthPhrases(periodMonth);
  return `I HEREBY CERTIFY the correctness disposition report for the Month of ${p.certification}`;
}

// The month before this one — what a new report pre-fills its officers and
// client blocks from.
function previousMonth(periodMonth) {
  const p = monthPhrases(periodMonth);
  if (!p.valid) return "";
  const m = p.month === 1 ? 12 : p.month - 1;
  const y = p.month === 1 ? p.year - 1 : p.year;
  return `${y}-${String(m).padStart(2, "0")}`;
}

// First and last day of the month, as ISO dates — the window the roster is
// read over when personnel are pulled from records.
function monthWindow(periodMonth) {
  const p = monthPhrases(periodMonth);
  if (!p.valid) return { from: "", to: "" };
  const mm = String(p.month).padStart(2, "0");
  const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return { from: `${p.year}-${mm}-01`, to: `${p.year}-${mm}-${String(last).padStart(2, "0")}` };
}

// ---------------------------------------------------------------------------
// Numbering — positions, not stored values
// ---------------------------------------------------------------------------

// The reference sheet's unheaded columns C and D: C runs across the WHOLE
// report, D restarts within each client block. Both are positions, so both
// are derived — storing them would leave holes the moment a guard is removed
// mid-month.
//
// Grouped in one pass rather than filtering the personnel list per client:
// the filter form is O(clients x personnel), which at 300 clients and 5,000
// guards is 1.5M comparisons for a number that is just an index.
function numbering(clients = [], personnel = []) {
  const byClient = new Map();
  for (const p of personnel) {
    const list = byClient.get(p.clientId);
    if (list) list.push(p);
    else byClient.set(p.clientId, [p]);
  }
  for (const list of byClient.values()) list.sort(bySort);

  const out = new Map();
  let running = 0;
  for (const c of [...clients].sort(bySort)) {
    const rows = byClient.get(c.id) || [];
    for (let i = 0; i < rows.length; i++) {
      out.set(rows[i].id, { runningNo: ++running, lineNo: i + 1 });
    }
  }
  return out;
}

// Firearms grouped under the guard that holds them, in print order.
function firearmsByPersonnel(firearms = []) {
  const out = new Map();
  for (const f of firearms) {
    const list = out.get(f.personnelId);
    if (list) list.push(f);
    else out.set(f.personnelId, [f]);
  }
  for (const list of out.values()) list.sort(bySort);
  return out;
}

// ---------------------------------------------------------------------------
// Firearms
// ---------------------------------------------------------------------------

// Small Arms vs Light Weapons, defaulted from the calibre.
//
// NOTE the source return files a 12GA shotgun under Light Weapons. That is
// arguable — under RA 10591 a shotgun is a small arm — but it is the
// classification the agency has been filing, so it is the DEFAULT and not a
// rule: every firearm carries an editable "firearmClass" that wins over this.
// Recorded as a known gap for confirmation against the current SOSIA form.
function classifyFirearm({ firearmClass, kind, make } = {}) {
  const explicit = str(firearmClass);
  if (explicit === SMALL_ARMS || explicit === LIGHT_WEAPONS) return explicit;
  const text = `${str(kind)} ${str(make)}`.toUpperCase();
  if (!text.trim()) return "";
  if (/\b(12\s*GA|20\s*GA|GAUGE|SHOTGUN|CARBINE|RIFLE|5\.56|7\.62)\b/.test(text)) return LIGHT_WEAPONS;
  return SMALL_ARMS;
}

// ---------------------------------------------------------------------------
// Section 1 — firearms deployed per province
// ---------------------------------------------------------------------------

// One row per province, two count columns, then a TOTAL row.
//
// The reference prints "1 (9MM)" — the count with the calibres behind it —
// so the cell carries both, and a province with two 9MMs and a 12GA reads
// "3 (9MM, 12GA)".
function firearmsByProvince(clients = [], personnel = [], firearms = []) {
  const provinceOfClient = new Map(clients.map((c) => [c.id, str(c.province) || "(unspecified)"]));
  const provinceOfPersonnel = new Map(personnel.map((p) => [p.id, provinceOfClient.get(p.clientId) || "(unspecified)"]));

  const acc = new Map();
  for (const f of firearms) {
    const prov = provinceOfPersonnel.get(f.personnelId);
    if (!prov) continue;
    if (!acc.has(prov)) acc.set(prov, { province: prov, small: [], light: [] });
    const b = acc.get(prov);
    (classifyFirearm(f) === LIGHT_WEAPONS ? b.light : b.small).push(str(f.kind) || str(f.make));
  }

  // "1 (9MM)" — count, then the distinct calibres behind it.
  const cell = (kinds) => {
    if (!kinds.length) return "";
    const distinct = [...new Set(kinds.filter(Boolean))];
    return distinct.length ? `${kinds.length} (${distinct.join(", ")})` : String(kinds.length);
  };

  const rows = [...acc.values()]
    .sort((a, b) => a.province.localeCompare(b.province))
    .map((b) => ({
      province: b.province,
      smallArms: cell(b.small),
      lightWeapons: cell(b.light),
      smallArmsCount: b.small.length,
      lightWeaponsCount: b.light.length,
    }));

  return {
    rows,
    total: {
      smallArms: rows.reduce((s, r) => s + r.smallArmsCount, 0),
      lightWeapons: rows.reduce((s, r) => s + r.lightWeaponsCount, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Section 3 — recapitulation
// ---------------------------------------------------------------------------

// The reference has a single BULACAN column because that agency files one
// province. An agency operating in three gets three columns; the shape is
// driven by the data, not hardcoded.
//
// "Guards" counts REPORTED POSTINGS, matching the sheet's own 66 — one line
// per guard per post. A guard transferred mid-month legitimately appears at
// two posts, so `distinctGuards` is reported alongside; where the two differ
// the return says so rather than quietly picking one. Same discipline as
// billing showing the roster-derived headcount beside the contracted one.
function recapitulation(clients = [], personnel = [], firearms = []) {
  const provinceOfClient = new Map(clients.map((c) => [c.id, str(c.province) || "(unspecified)"]));
  const provinces = [...new Set(clients.map((c) => str(c.province) || "(unspecified)"))]
    .sort((a, b) => a.localeCompare(b));

  const zero = () => Object.fromEntries(provinces.map((p) => [p, 0]));
  const guards = zero();
  const firearmCounts = zero();
  const distinct = Object.fromEntries(provinces.map((p) => [p, new Set()]));

  const provinceOfPersonnel = new Map();
  for (const p of personnel) {
    const prov = provinceOfClient.get(p.clientId);
    if (!prov || !(prov in guards)) continue;
    provinceOfPersonnel.set(p.id, prov);
    guards[prov] += 1;
    distinct[prov].add(p.employeeId ? `e${p.employeeId}` : `n${str(p.guardName).toUpperCase()}`);
  }
  for (const f of firearms) {
    const prov = provinceOfPersonnel.get(f.personnelId);
    if (prov) firearmCounts[prov] += 1;
  }

  const sum = (o) => provinces.reduce((s, p) => s + o[p], 0);
  const distinctByProvince = Object.fromEntries(provinces.map((p) => [p, distinct[p].size]));
  const allDistinct = new Set();
  for (const p of provinces) for (const k of distinct[p]) allDistinct.add(k);

  return {
    provinces,
    rows: [
      { label: "Guards", byProvince: guards, total: sum(guards) },
      { label: "Firearms", byProvince: firearmCounts, total: sum(firearmCounts) },
    ],
    distinctGuards: { byProvince: distinctByProvince, total: allDistinct.size },
  };
}

// ---------------------------------------------------------------------------
// Licence validity
// ---------------------------------------------------------------------------

// A guard whose LESP has lapsed, or a firearm whose licence has, is the
// single thing an RCSU reader opens this return to catch. Judged against the
// REPORTED month rather than against "now", so re-opening February's return in
// August does not retroactively invent expiries that were not true in
// February — and never stored, for the same reason the asset alerts and a
// DDO's Expired state are not: it is a fact about a date, not a property of
// the row.
function licenceState(expiry, periodMonth, warnDays = 60) {
  const d = iso(expiry);
  if (!d) return { state: "missing", label: "No expiry recorded" };

  const asOf = monthWindow(periodMonth).to || today();
  if (d < asOf) return { state: "expired", label: `expired ${d}` };

  const soon = new Date(`${asOf}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + warnDays);
  if (d <= iso(soon.toISOString())) return { state: "expiring", label: `expires ${d}` };
  return { state: "valid", label: d };
}

// ---------------------------------------------------------------------------
// Validation — one table, one verdict
// ---------------------------------------------------------------------------

// Severity is declared here as DATA, not scattered through the checks, so the
// tiering can be read and audited at a glance and changed in one place.
//
//   blocking  — legal or data-integrity defects. Finalise is REFUSED. There is
//               no override: a return naming a separated guard, or the same
//               firearm at two posts, is not a return with a caveat, it is a
//               false statement to the PNP.
//   advisory  — administrative gaps. Finalise proceeds, but only with a typed
//               override reason, and the waived findings are snapshotted onto
//               the return so the record shows what was filed knowingly.
const ISSUE_SEVERITY = {
  // --- blocking: legal / data integrity ---
  "month-invalid": "blocking",             // invalid reporting period
  "no-clients": "blocking",
  "province-missing": "blocking",          // Sections 1 and 3 group by it
  "guard-separated": "blocking",           // separated guard reported as posted
  "firearm-duplicated": "blocking",        // one firearm, two posts
  "firearm-serial-missing": "blocking",    // a firearm reported without a serial
  "firearm-written-off": "blocking",       // Retired/Lost firearm reported deployed
  "guard-duplicated": "blocking",          // same guard twice at one client

  // --- advisory: administrative ---
  "licence-missing": "advisory",           // no LESP expiry recorded
  "licence-expiring": "advisory",          // lapses soon
  "licence-no-missing": "advisory",        // no LESP number recorded
  "firearm-licence-missing": "advisory",
  "client-empty": "advisory",
  "guard-at-two-posts": "advisory",        // ordinary for a mid-month transfer

  // --- advisory BY DECISION, not by nature ---
  // An expired LESP or firearm licence is a legal defect and the argument for
  // blocking it is strong. It is advisory because the MDR filing deadline is
  // statutory and a renewal in process is common: blocking would mean the
  // agency cannot file AT ALL because one guard's licence is with SOSIA, and
  // filing late is the worse violation. It therefore requires a typed override
  // and is recorded on the return as knowingly filed.
  // Flip these two to "blocking" to enforce instead — nothing else changes.
  "licence-expired": "advisory",
  "firearm-licence-expired": "advisory",
};

const severityOf = (kind) => ISSUE_SEVERITY[kind] || "advisory";

// Everything questionable about a return, in one list, so the screen, the API
// and the finalise check cannot disagree about what is wrong with it.
//
// `employees` and `assets` are Maps of the CURRENT record, used only to catch
// a guard who has since separated or a firearm since written off. They are
// never read for the values that get printed — those are snapshotted on the
// rows themselves.
function reportIssues({
  report = {}, clients = [], personnel = [], firearms = [],
  employees = new Map(), assets = new Map(),
} = {}) {
  const issues = [];
  const month = report.periodMonth;
  const add = (kind, message, extra = {}) =>
    issues.push({ kind, severity: severityOf(kind), blocking: severityOf(kind) === "blocking", message, ...extra });

  const nameOf = (p) => str(p.guardName) || `personnel #${p.id}`;
  const byPersonnel = firearmsByPersonnel(firearms);
  const personnelById = new Map(personnel.map((p) => [p.id, p]));

  for (const p of personnel) {
    const lic = licenceState(p.licenceExpiry, month);
    if (lic.state === "expired") {
      add("licence-expired", `${nameOf(p)} — LESP ${str(p.licenceNo) || "(no number)"} ${lic.label} before the end of the reported month.`, { personnelId: p.id });
    } else if (lic.state === "missing") {
      add("licence-missing", `${nameOf(p)} — no LESP expiry date recorded.`, { personnelId: p.id });
    } else if (lic.state === "expiring") {
      add("licence-expiring", `${nameOf(p)} — LESP ${lic.label}.`, { personnelId: p.id });
    }
    if (!str(p.licenceNo)) {
      add("licence-no-missing", `${nameOf(p)} — no LESP number recorded.`, { personnelId: p.id });
    }

    // A guard who has left the agency must not be reported as posted.
    //
    // The 201 File column is "employmentStatus" (values Active / Separated).
    // Both spellings are accepted so a caller passing a raw employee row and
    // one passing a normalised object behave identically — reading only
    // `status` meant this check silently never fired against real rows.
    const emp = p.employeeId ? employees.get(p.employeeId) : null;
    const empStatus = emp ? str(emp.employmentStatus || emp.status) : "";
    if (empStatus && empStatus !== "Active") {
      add("guard-separated", `${nameOf(p)} is ${empStatus} in the 201 File but is reported as posted.`, { personnelId: p.id });
    }

    for (const f of byPersonnel.get(p.id) || []) {
      if (!str(f.serialNo)) {
        add("firearm-serial-missing", `${nameOf(p)} — a firearm is reported with no serial number.`, { personnelId: p.id, firearmId: f.id });
      }
      const fl = licenceState(f.licenceExpiry, month);
      if (fl.state === "expired") {
        add("firearm-licence-expired", `${nameOf(p)} — firearm ${str(f.serialNo)} licence ${fl.label}.`, { personnelId: p.id, firearmId: f.id });
      } else if (fl.state === "missing") {
        add("firearm-licence-missing", `${nameOf(p)} — firearm ${str(f.serialNo)} has no licence expiry recorded.`, { personnelId: p.id, firearmId: f.id });
      }
      const asset = f.assetId ? assets.get(f.assetId) : null;
      if (asset && ["Retired", "Lost"].includes(str(asset.status))) {
        add("firearm-written-off", `${nameOf(p)} — firearm ${str(f.serialNo)} is ${asset.status} in the asset register.`, { personnelId: p.id, firearmId: f.id });
      }
    }
  }

  // The same firearm cannot be deployed at two posts in the same month. The
  // source workbook carries exactly this defect on its DDO sheets — serial
  // RIA2950961 appears on both the HAT and SALUYOT pages.
  const seenSerial = new Map();
  for (const f of [...firearms].sort(bySort)) {
    const sn = str(f.serialNo).toUpperCase();
    if (!sn) continue;
    const holder = nameOf(personnelById.get(f.personnelId) || {});
    if (seenSerial.has(sn)) {
      add("firearm-duplicated", `Firearm ${sn} is reported against both ${seenSerial.get(sn)} and ${holder}.`, { personnelId: f.personnelId, firearmId: f.id });
    } else seenSerial.set(sn, holder);
  }

  // The same guard listed twice. Two different things wear one shape here, and
  // they are NOT the same severity:
  //
  //   different clients -> ordinary mid-month transfer. Advisory. It is why the
  //                        recapitulation reports distinct guards alongside
  //                        postings, so the discrepancy is visible.
  //   same client       -> a duplicated row. It inflates the headcount reported
  //                        to the PNP, so it is a data-integrity defect and
  //                        blocks. The reference return carries exactly this:
  //                        "Dionicio, Jay M." appears at rows 27 and 29 of the
  //                        same block on the same licence number, which is how
  //                        that sheet reaches 66 guards from 65 people.
  const seenGuard = new Map();
  const clientName = new Map(clients.map((c) => [c.id, str(c.clientName) || `client #${c.id}`]));
  for (const p of [...personnel].sort(bySort)) {
    const key = p.employeeId ? `e${p.employeeId}` : `n${str(p.guardName).toUpperCase()}`;
    if (key === "n" || key === "e") continue;
    const prior = seenGuard.get(key);
    if (prior === undefined) { seenGuard.set(key, p.clientId); continue; }
    if (prior === p.clientId) {
      add("guard-duplicated", `${nameOf(p)} is listed twice under ${clientName.get(p.clientId) || "the same client"} — a duplicated row inflates the reported headcount.`, { personnelId: p.id });
    } else {
      add("guard-at-two-posts", `${nameOf(p)} is reported at both ${clientName.get(prior) || "another post"} and ${clientName.get(p.clientId) || "another post"} — confirm this is a mid-month transfer.`, { personnelId: p.id });
    }
  }

  for (const c of clients) {
    const label = str(c.clientName) || `client #${c.id}`;
    if (!str(c.province)) {
      add("province-missing", `${label} has no province — Sections 1 and 3 group by it.`, { clientId: c.id });
    }
  }
  const populated = new Set(personnel.map((p) => p.clientId));
  for (const c of clients) {
    if (!populated.has(c.id)) {
      add("client-empty", `${str(c.clientName) || `client #${c.id}`} has no guards listed.`, { clientId: c.id });
    }
  }

  if (!monthPhrases(month).valid) add("month-invalid", "The report month is not set, or is not a valid YYYY-MM.");
  if (!clients.length) add("no-clients", "The return lists no clients.");

  return issues;
}

// The single verdict. The finalise route calls this and obeys it; the screen
// calls nothing and renders what the API returns. Both therefore always agree.
//
// Blocking findings refuse outright. Advisory findings are permitted only with
// a typed reason, and the exact findings waived are returned so the caller can
// snapshot them onto the return.
function finaliseCheck(issues = [], { overrideReason = "" } = {}) {
  const blocking = issues.filter((i) => i.severity === "blocking");
  const advisory = issues.filter((i) => i.severity !== "blocking");
  const reason = str(overrideReason);

  if (blocking.length) {
    return {
      ok: false,
      code: "blocking-issues",
      blocking,
      advisory,
      requiresOverride: false,
      message: `This return cannot be finalised: ${blocking.length} legal or data-integrity ${blocking.length === 1 ? "issue" : "issues"} must be corrected first.`,
    };
  }
  if (advisory.length && !reason) {
    return {
      ok: false,
      code: "override-required",
      blocking,
      advisory,
      requiresOverride: true,
      message: `This return has ${advisory.length} outstanding administrative ${advisory.length === 1 ? "finding" : "findings"}. Give a reason to file it as it stands — the reason and the findings are recorded on the return.`,
    };
  }
  return {
    ok: true,
    blocking,
    advisory,
    requiresOverride: advisory.length > 0,
    overrideReason: reason,
    // Snapshotted onto the return, so the record shows WHAT was waived and not
    // merely that something was.
    overrideIssues: advisory.map(({ kind, severity, message }) => ({ kind, severity, message })),
  };
}

// A guard's rank as the return prints it. The 201 File has no rank column, so
// it is inferred from the employment position and stays editable on the row —
// the same compromise the DDO makes.
function rankFor(position) {
  const p = str(position).toUpperCase();
  if (/OFFICER|SUPERVISOR|INSPECTOR|DETACHMENT|SO\b/.test(p)) return "SO";
  if (/LADY/.test(p)) return "LG";
  return "SG";
}

module.exports = {
  MONTHS, SMALL_ARMS, LIGHT_WEAPONS, ISSUE_SEVERITY,
  monthPhrases, subjectLine, certificationLine, previousMonth, monthWindow,
  numbering, firearmsByPersonnel, classifyFirearm,
  firearmsByProvince, recapitulation,
  licenceState, severityOf, reportIssues, finaliseCheck, rankFor,
};
