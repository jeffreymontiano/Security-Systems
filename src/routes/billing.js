const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { pesoPdf, amountPdf } = require("../lib/pdfMoney");
// computeReport() is deliberately NOT imported any more. Billing reads punches
// directly and ignores the roster; payroll still reads computeReport. See the
// comment in the compute route for why the two were separated.
const {
  resolveContractRate, resolveDutyHours, resolveFeeConfig, resolveCadence,
  cadenceIsCoherent, CADENCE_KEYS, computeSiteBilling,
  deriveSiteDayHours, numberToWords, hoursAsDays, round2,
} = require("../lib/billingEngine");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler — the
// rejection escapes to the process, which answers nothing and (before the
// server.js guards) took the whole process down. Every async handler below is
// wrapped so a failure becomes a 500 with a readable message.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[billing]", e);
  if (!res.headersSent) res.status(500).json({ error: e.message || "The billing request failed." });
});

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

// 0.02 -> "2%", 0.1224 -> "12.24%". Used where the statement states a rate in
// words. Trailing zeros are trimmed so a plain 2% does not print as "2.00%".
function pctLabel(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return "";
  return `${String(Number((n * 100).toFixed(4)))}%`;
}

async function loadConfig(db = pool) {
  const row = (await db.query(`SELECT * FROM billing_config WHERE id = 1`)).rows[0];
  if (!row) return {};
  return {
    adminFeePercent: Number(row.adminFeePercent),
    withholdingTaxPercent: Number(row.withholdingTaxPercent),
    manHourDivisor: Number(row.manHourDivisor),
    periodsPerMonth: Number(row.periodsPerMonth),
    standardPeriodDays: Number(row.standardPeriodDays),
    defaultContractRate: Number(row.defaultContractRate),
    defaultDutyHours: Number(row.defaultDutyHours),
    soaPrefix: row.soaPrefix,
  };
}

// --- Statement wording for a derived adjustment ------------------------------
//
// Composed here, not in billingEngine: the engine stays pure maths and returns
// structured facts, and date formatting is presentation.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Feb 22 2026" — the form the agency's statements already use.
function shortDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return `${MONTH_ABBR[m - 1]} ${d} ${y}`;
}

// The days a SHORTFALL refers to — days the standard has that the calendar does
// not. A 13-day February is short by the 29th and the 30th, which is exactly why
// the agency writes "No calendar date". The day numbers simply continue past the
// month end; they are never parsed as dates, only printed.
//
// There is no equivalent for an excess: days beyond the standard are real dates
// that the derivation already names individually, so they come through
// `overDates` like any other augmentation.
function missingDaysLabel(periodEnd, deviation) {
  const [y, m, d] = String(periodEnd).split("-").map(Number);
  const mon = MONTH_ABBR[m - 1] || "";
  const first = d + 1;
  const last = d + Math.round(deviation.days);
  return first === last ? `${mon} ${first} ${y}` : `${mon} ${first}-${last} ${y}`;
}

// A handful of dates, then a count. A period short on twelve separate days must
// not print twelve dates into a statement line.
function dateList(dates) {
  const shown = dates.slice(0, 3).map(shortDate);
  const rest = dates.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

// The two remark strings the SOA prints before its LESS / ADDITIONAL lines.
function derivedRemarks(derived, periodEnd) {
  const cal = derived.calendarDeviation;
  const lessParts = [];
  const addParts = [];

  if (cal && cal.kind === "less") lessParts.push(`No calendar date: ${missingDaysLabel(periodEnd, cal)}`);
  if (derived.shortDates.length) lessParts.push(`Under-manned ${dateList(derived.shortDates)}`);

  // An extra calendar day and a within-period extra guard read as the same thing
  // to the client — service beyond the contract — so they share one line. Both
  // already arrive as real dates in `overDates`.
  //
  // The remark is the DATES ALONE. The row that prints it supplies the word:
  // "Jul 31 2026" + " - AUGMENTATION: 3 Days, 36 Hours". Ending this string with
  // "Augmentation" (as it did while the row said "ADDITIONAL") would now print
  // "Jul 31 2026 Augmentation - AUGMENTATION: ...".
  const addDates = derived.overDates.map(shortDate);
  if (addDates.length) addParts.push(`${addDates.slice(0, 3).join(", ")}${addDates.length > 3 ? ` and ${addDates.length - 3} more` : ""}`);

  return { less: lessParts.join("; "), add: addParts.join("; ") };
}

// ---- Config -----------------------------------------------------------------

router.get("/config", requireAuth, wrap(async (req, res) => {
  const row = (await pool.query(`SELECT * FROM billing_config WHERE id = 1`)).rows[0] || {};
  res.json(row);
}));

router.put("/config", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const b = req.body || {};
  const pct = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const cur = (await pool.query(`SELECT * FROM billing_config WHERE id = 1`)).rows[0] || {};

  // periodsPerMonth and standardPeriodDays are two halves of one fact and their
  // product must be a month. A CLIENT cannot set them inconsistently -- it picks
  // a cadence and both are derived -- but the agency-wide pair is still two free
  // numbers, and this is the one remaining place they can disagree. Getting it
  // wrong over-bills a fully served month by ~48% while reading as an ordinary
  // augmentation, so it is refused rather than warned about.
  const nextPerMonth = pct(b.periodsPerMonth, cur.periodsPerMonth) || 2;
  const nextStdDays = pct(b.standardPeriodDays, cur.standardPeriodDays) || 15;
  if (!cadenceIsCoherent(nextPerMonth, nextStdDays)) {
    return res.status(400).json({
      error: `Billing periods per month (${nextPerMonth}) x standard days per period (${nextStdDays}) = ${Math.round(nextPerMonth * nextStdDays * 100) / 100} days, which is not a month. ` +
        `The baseline is the contract rate divided by the first and covers the second, so they must multiply to roughly 30 — 2 x 15 for semi-monthly, 1 x 30 for monthly.`,
    });
  }

  await pool.query(
    `UPDATE billing_config SET
       "adminFeePercent" = $1, "withholdingTaxPercent" = $2, "manHourDivisor" = $3,
       "periodsPerMonth" = $4, "defaultContractRate" = $5, "defaultDutyHours" = $6,
       "standardPeriodDays" = $7, "soaPrefix" = $8, "updatedBy" = $9, "updatedAt" = now()
     WHERE id = 1`,
    [
      pct(b.adminFeePercent, cur.adminFeePercent),
      pct(b.withholdingTaxPercent, cur.withholdingTaxPercent),
      pct(b.manHourDivisor, cur.manHourDivisor) || 365,
      pct(b.periodsPerMonth, cur.periodsPerMonth) || 2,
      pct(b.defaultContractRate, cur.defaultContractRate),
      pct(b.defaultDutyHours, cur.defaultDutyHours) || 12,
      // Never 0: a zero-day standard would make every period pure augmentation.
      pct(b.standardPeriodDays, cur.standardPeriodDays) || 15,
      (b.soaPrefix || cur.soaPrefix || "SOA").trim(),
      req.user.username,
    ]
  );
  res.json({ ok: true });
}));

// ---- Clients ----------------------------------------------------------------

router.get("/clients", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT bc.*, COUNT(bs.id) FILTER (WHERE bs.active) ::int AS "siteCount"
    FROM billing_clients bc
    LEFT JOIN billing_sites bs ON bs."clientId" = bc.id
    GROUP BY bc.id ORDER BY bc.active DESC, bc.name
  `);
  res.json(rows);
}));

// A percentage override, or null to fall back to the agency-wide figure.
// Stored as the decimal the engine multiplies by, matching billing_config —
// entering 12.24 instead of 0.1224 would bill 1224% and is refused here rather
// than discovered on a statement.
// A cadence key, or null to inherit the agency-wide pair. Refused rather than
// silently ignored: a typo would fall through resolveCadence to the global
// default and bill a monthly client semi-monthly, which is a halved invoice.
function cadenceOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const key = String(v).trim();
  if (!CADENCE_KEYS.includes(key)) {
    throw Object.assign(new Error(
      `Billing cadence must be one of: ${CADENCE_KEYS.join(", ")}. Leave it blank to use the agency default.`), { status: 400 });
  }
  return key;
}

function feePercent(v, label) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw Object.assign(new Error(`${label} must be a decimal between 0 and 1 (0.1224 = 12.24%). Leave it blank to use the agency-wide figure.`), { status: 400 });
  }
  return n;
}

router.post("/clients", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "A client name is required." });
  let adminFee, wht, cadence;
  try {
    adminFee = feePercent(req.body.adminFeePercent, "Administrative overhead");
    wht = feePercent(req.body.withholdingTaxPercent, "Withholding tax");
    cadence = cadenceOrNull(req.body.billingCadence);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const { rows } = await pool.query(
    `INSERT INTO billing_clients (name, address, "contractRate", "adminFeePercent", "withholdingTaxPercent", "billingCadence", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (name) DO NOTHING RETURNING *`,
    [name, (req.body.address || "").trim(), numOrNull(req.body.contractRate), adminFee, wht, cadence, req.user.username]
  );
  if (!rows[0]) return res.status(400).json({ error: "A client with that name already exists." });
  res.status(201).json(rows[0]);
}));

router.patch("/clients/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const b = req.body || {};
  let adminFee, wht, cadence;
  try {
    adminFee = feePercent(b.adminFeePercent, "Administrative overhead");
    wht = feePercent(b.withholdingTaxPercent, "Withholding tax");
    cadence = cadenceOrNull(b.billingCadence);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  // "field present in the body" -> set it, possibly to null; absent -> leave it.
  // The same distinction /lines/:id already makes, and it matters more here:
  // these two are money. A caller sending only { active: false } must not
  // silently reset a negotiated percentage back to the agency-wide one, which
  // is what an unconditional assignment would do. contractRate keeps its
  // existing unconditional behaviour deliberately — changing it is not this
  // change's business.
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const { rows } = await pool.query(
    `UPDATE billing_clients SET
       name = COALESCE($1, name), address = COALESCE($2, address),
       "contractRate" = $3,
       "adminFeePercent"      = CASE WHEN $4 THEN $5::numeric ELSE "adminFeePercent"      END,
       "withholdingTaxPercent"= CASE WHEN $6 THEN $7::numeric ELSE "withholdingTaxPercent" END,
       "billingCadence"       = CASE WHEN $8 THEN $9::text    ELSE "billingCadence"        END,
       active = COALESCE($10, active)
     WHERE id = $11 RETURNING *`,
    [b.name?.trim() || null, b.address ?? null, numOrNull(b.contractRate),
     has("adminFeePercent"), adminFee,
     has("withholdingTaxPercent"), wht,
     has("billingCadence"), cadence,
     typeof b.active === "boolean" ? b.active : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Client not found." });
  res.json(rows[0]);
}));

// Hard-delete only while nothing has been billed. Once statements exist the
// client deactivates instead, so history stays explainable — the same rule the
// rest of the app's catalogs follow.
router.delete("/clients/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const used = (await pool.query(
    `SELECT 1 FROM billing_periods WHERE "clientId" = $1 LIMIT 1`, [req.params.id]
  )).rowCount;
  if (used) {
    await pool.query(`UPDATE billing_clients SET active = false WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true, deactivated: true });
  }
  await pool.query(`DELETE FROM billing_clients WHERE id = $1`, [req.params.id]);
  res.json({ ok: true, deleted: true });
}));

// ---- Detachments (site -> client mapping) -----------------------------------

router.get("/sites", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT bs.*, bc.name AS "clientName", bc."contractRate" AS "clientContractRate"
    FROM billing_sites bs JOIN billing_clients bc ON bc.id = bs."clientId"
    ORDER BY bc.name, bs.site
  `);
  // Sites the roster uses that nobody has mapped to a client yet. Surfaced
  // rather than guessed: the statement's detachment name ("BBGC Farms") is not
  // the roster's site name ("BBGC"), so an automatic match would quietly bill
  // the wrong post.
  const mapped = new Set(rows.map((r) => norm(r.site)));
  const known = (await pool.query(`
    SELECT name FROM sites
    UNION
    SELECT DISTINCT site FROM shift_assignments WHERE site IS NOT NULL AND site <> ''
  `)).rows.map((r) => r.name).filter(Boolean);
  const unmapped = [...new Set(known.filter((s) => !mapped.has(norm(s))))].sort();
  res.json({ sites: rows, unmapped });
}));

router.post("/sites", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const b = req.body || {};
  const site = (b.site || "").trim();
  if (!b.clientId) return res.status(400).json({ error: "A client is required." });
  if (!site) return res.status(400).json({ error: "A site is required." });
  const { rows } = await pool.query(
    `INSERT INTO billing_sites ("clientId", site, "detachmentName", "contractRate", "dutyHours", "contractedGuards", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (site) DO NOTHING RETURNING *`,
    [b.clientId, site, (b.detachmentName || site).trim(), numOrNull(b.contractRate),
     numOrNull(b.dutyHours), numOrNull(b.contractedGuards), req.user.username]
  );
  if (!rows[0]) return res.status(400).json({ error: `"${site}" is already mapped to a client.` });
  res.status(201).json(rows[0]);
}));

router.patch("/sites/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE billing_sites SET
       "clientId" = COALESCE($1,"clientId"),
       "detachmentName" = COALESCE($2,"detachmentName"),
       "contractRate" = $3, "dutyHours" = $4, "contractedGuards" = $5,
       active = COALESCE($6, active)
     WHERE id = $7 RETURNING *`,
    [b.clientId || null, b.detachmentName ?? null, numOrNull(b.contractRate),
     numOrNull(b.dutyHours), numOrNull(b.contractedGuards),
     typeof b.active === "boolean" ? b.active : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Detachment not found." });
  res.json(rows[0]);
}));

router.delete("/sites/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  await pool.query(`DELETE FROM billing_sites WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Billing periods --------------------------------------------------------

const PERIOD_SELECT = `
  SELECT bp.id, bp."clientId", bc.name AS "clientName", bc.address AS "clientAddress",
         to_char(bp."periodStart",'YYYY-MM-DD') AS "periodStart",
         to_char(bp."periodEnd",'YYYY-MM-DD') AS "periodEnd",
         to_char(bp."soaDate",'YYYY-MM-DD') AS "soaDate",
         bp."soaNo", bp.status, bp."createdBy",
         to_char(bp."createdAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "createdAt",
         COUNT(bl.id)::int AS "lineCount",
         COALESCE(SUM(bl."billingCost"),0)::numeric AS "totalBillingCost",
         COALESCE(SUM(bl."netAmount"),0)::numeric AS "totalNetAmount"
  FROM billing_periods bp
  JOIN billing_clients bc ON bc.id = bp."clientId"
  LEFT JOIN billing_lines bl ON bl."periodId" = bp.id
`;

router.get("/periods", requireAuth, wrap(async (req, res) => {
  const vals = [];
  let where = "";
  if (req.query.clientId) { vals.push(req.query.clientId); where = `WHERE bp."clientId" = $1`; }
  const { rows } = await pool.query(
    `${PERIOD_SELECT} ${where} GROUP BY bp.id, bc.name, bc.address ORDER BY bp."periodStart" DESC, bc.name`,
    vals
  );
  res.json(rows);
}));

router.get("/periods/:id", requireAuth, wrap(async (req, res) => {
  const period = (await pool.query(
    `${PERIOD_SELECT} WHERE bp.id = $1 GROUP BY bp.id, bc.name, bc.address`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Billing period not found." });
  const lines = (await pool.query(
    `SELECT bl.*, bs."contractedGuards"
     FROM billing_lines bl LEFT JOIN billing_sites bs ON bs.id = bl."billingSiteId"
     WHERE bl."periodId" = $1 ORDER BY bl."detachmentName", bl.site`,
    [period.id]
  )).rows;
  res.json({ period, lines });
}));

router.post("/periods", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.clientId) return res.status(400).json({ error: "A client is required." });
  if (!b.periodStart || !b.periodEnd) return res.status(400).json({ error: "A period start and end date are required." });
  if (b.periodEnd < b.periodStart) return res.status(400).json({ error: "The period end cannot be before its start." });
  const { rows } = await pool.query(
    `INSERT INTO billing_periods ("clientId","periodStart","periodEnd","soaDate","createdBy")
     VALUES ($1,$2::date,$3::date,$4::date,$5)
     ON CONFLICT ("clientId","periodStart","periodEnd") DO NOTHING RETURNING id`,
    [b.clientId, b.periodStart, b.periodEnd, b.soaDate || b.periodEnd, req.user.username]
  );
  if (!rows[0]) return res.status(400).json({ error: "That client already has a billing period for those dates." });
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/periods/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE billing_periods SET "soaDate" = COALESCE($1::date,"soaDate"), "updatedAt" = now()
     WHERE id = $2 AND status <> 'Paid' RETURNING id`,
    [b.soaDate || null, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "A paid billing period is locked." });
  res.json({ ok: true });
}));

router.delete("/periods/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM billing_periods WHERE id = $1 AND status <> 'Paid'`, [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "A paid billing period cannot be deleted." });
  res.json({ ok: true });
}));

// ---- Compute ----------------------------------------------------------------

// Re-price one line from its stored quantities. The effective quantity is
// always `override ?? derived`, so pressing Recompute can never discard a
// deliberate edit, and clearing an override restores the attendance figure.
async function repriceLine(db, lineId) {
  // The client is joined in for its optional fee overrides. It reaches here
  // through the period rather than the line, because a line belongs to a
  // detachment and a detachment's commercial terms come from its client.
  const line = (await db.query(
    `SELECT bl.*, bs."contractedGuards",
            bc."adminFeePercent" AS "clientAdminFeePercent",
            bc."withholdingTaxPercent" AS "clientWithholdingTaxPercent",
            bc."billingCadence" AS "clientBillingCadence"
     FROM billing_lines bl
     LEFT JOIN billing_sites bs ON bs.id = bl."billingSiteId"
     LEFT JOIN billing_periods bp ON bp.id = bl."periodId"
     LEFT JOIN billing_clients bc ON bc.id = bp."clientId"
     WHERE bl.id = $1`, [lineId]
  )).rows[0];
  if (!line) return null;
  // Client-first, then agency-wide. A client with no overrides computes
  // byte-for-byte as it did before these columns existed. The two resolvers
  // compose because each takes a config and returns one: the cadence supplies
  // periodsPerMonth (which sets the baseline amount), the fee resolver the two
  // percentages.
  const client = {
    adminFeePercent: line.clientAdminFeePercent,
    withholdingTaxPercent: line.clientWithholdingTaxPercent,
    billingCadence: line.clientBillingCadence,
  };
  const cfg = resolveCadence(resolveFeeConfig(await loadConfig(db), client), client);

  const guards = line.guardsOverride != null ? Number(line.guardsOverride)
    : Number(line.contractedGuards) > 0 ? Number(line.contractedGuards)
    : Number(line.derivedGuards);
  const lessHours = line.lessHoursOverride != null ? Number(line.lessHoursOverride) : Number(line.derivedLessHours);
  // Manual ADD is ADDITIVE, not another override. An override answers "what
  // should the derived figure have been"; manual ADD answers "and also charge
  // the client this" — approved OT the punches cannot distinguish, because a
  // site-day nets to a single figure. Both can apply at once.
  const addHours = round2(
    (line.addHoursOverride != null ? Number(line.addHoursOverride) : Number(line.derivedAddHours))
    + Number(line.addHoursManual || 0)
  );

  const c = computeSiteBilling({
    guards, contractRate: line.contractRateUsed, lessHours, addHours,
    // Manual peso figures. Stored as typed, never derived, and folded into
    // billingCost so the fee and withholding layer sees a holiday-inclusive base.
    legalHolidayAmount: line.legalHolidayAmount,
    specialHolidayAmount: line.specialHolidayAmount,
    config: cfg,
  });

  await db.query(
    `UPDATE billing_lines SET
       guards = $1, "manHourRate" = $2, "billingPeriodRate" = $3,
       "lessHours" = $4, "lessAmount" = $5, "addHours" = $6, "addAmount" = $7,
       "billingCost" = $8, "adminFee" = $9, "dueForGuard" = $10,
       "withholdingTax" = $11, "netAmount" = $12,
       "adminFeePercentUsed" = $13, "withholdingTaxPercentUsed" = $14,
       -- The cadence operands applied, so an issued statement keeps its
       -- arithmetic if the client's cadence changes later.
       "periodsPerMonthUsed" = $15, "standardPeriodDaysUsed" = $16,
       "computedAt" = now()
     WHERE id = $17`,
    [c.guards, c.manHourRate, c.billingPeriodRate, c.lessHours, c.lessAmount,
     c.addHours, c.addAmount, c.billingCost, c.adminFee, c.dueForGuard,
     c.withholdingTax, c.netAmount, c.adminFeePercentUsed, c.withholdingTaxPercentUsed,
     cfg.periodsPerMonth, cfg.standardPeriodDays,
     lineId]
  );
  return c;
}

// Derive every mapped detachment's billable hours from attendance and price
// them. Safe to re-run while Draft. Issued and Paid periods are locked so a
// statement already sent to a client can't silently change underneath it.
router.post("/periods/:id/compute", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const period = (await pool.query(
    `SELECT bp.*, to_char(bp."periodStart",'YYYY-MM-DD') AS "ps", to_char(bp."periodEnd",'YYYY-MM-DD') AS "pe",
            bc.name AS "clientName", bc.address AS "clientAddress", bc."contractRate" AS "clientContractRate",
            bc."billingCadence" AS "clientBillingCadence"
     FROM billing_periods bp JOIN billing_clients bc ON bc.id = bp."clientId"
     WHERE bp.id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Billing period not found." });
  if (period.status !== "Draft") {
    return res.status(400).json({ error: `This period is ${period.status}. Only a draft period can be recomputed.` });
  }

  const cfg = await loadConfig();
  const sites = (await pool.query(
    `SELECT * FROM billing_sites WHERE "clientId" = $1 AND active = true ORDER BY site`, [period.clientId]
  )).rows;
  if (!sites.length) {
    return res.status(400).json({
      error: "No detachments are mapped to this client yet. Map its sites on the Clients & Detachments tab first.",
    });
  }

  const client = {
    name: period.clientName, address: period.clientAddress, contractRate: period.clientContractRate,
    billingCadence: period.clientBillingCadence,
  };
  // The cadence decides how many days the flat baseline covers, which is what
  // the calendar rule measures the period against. A monthly client's 30-day
  // standard makes a fully served 30-day month net to zero; a semi-monthly
  // client keeps the 15-day standard it has always had.
  const cadence = resolveCadence(cfg, client);

  // THE PUNCHES ARE THE WHOLE INPUT. The roster is not read at all.
  //
  // Billing used to run computeReport() — the roster-driven engine payroll uses
  // — so that "a day billed to the client and a day paid to the guard are always
  // the same day". That invariant is deliberately retired: the client contracts
  // a POST, and what they are owed is measured by what was worked at that post,
  // not by who was scheduled to work it. Payroll stays roster-anchored; the two
  // now answer different questions and are allowed to differ.
  //
  // Consequences that follow, all intended:
  //   - a relief guard's hours count at the site they actually punched;
  //   - a rest day nobody covered is a genuine shortfall, not an exemption;
  //   - leave, absence and roster edits have no direct effect — only hours do.
  //
  // "AT TIME ZONE 'Asia/Manila'" is mandatory: a timestamptz renders in the
  // SESSION timezone (UTC on the server), so an 18:00 PH punch would otherwise
  // land on the previous calendar day.
  //
  // The window reaches ONE DAY PAST periodEnd so a shift starting on the last
  // day can still be closed by its time-out; deriveSiteDayHours drops any pair
  // whose IN falls outside the period, so nothing from the next period leaks in.
  //
  // There is no `siteMismatch` filter any more. It excluded punches whose site
  // disagreed with the roster — but the punch's site is now authoritative, so a
  // "mismatch" is simply a relief guard and those hours are real. Keeping the
  // filter would delete genuine man-hours and manufacture a shortfall.
  const punchRows = (await pool.query(
    `SELECT "guardName", site, "punchType", "punchAt"
     FROM attendance_records
     WHERE ("punchAt" AT TIME ZONE 'Asia/Manila')::date >= $1::date
       AND ("punchAt" AT TIME ZONE 'Asia/Manila')::date <= ($2::date + INTERVAL '1 day')
     ORDER BY "punchAt"`,
    [period.ps, period.pe]
  )).rows;

  const punchesBySite = new Map();
  for (const p of punchRows) {
    const k = norm(p.site);
    if (!punchesBySite.has(k)) punchesBySite.set(k, []);
    punchesBySite.get(k).push({
      guardName: p.guardName,
      type: p.punchType,
      at: new Date(p.punchAt).getTime(),
    });
  }

  // Sites with hours in this period that no billing_sites row claims. With no
  // roster fallback left, an unmapped site is hours that can never be billed to
  // anyone — so it is reported rather than quietly discarded.
  const mappedSites = new Set(
    (await pool.query(`SELECT site FROM billing_sites`)).rows.map((r) => norm(r.site))
  );
  const unmappedSites = [...new Set(
    punchRows
      .filter((p) => !mappedSites.has(norm(p.site)))
      .map((p) => (p.site || "").trim())
      .filter(Boolean)
  )].sort();

  let count = 0;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    // Drop lines for detachments that are no longer mapped to this client, so
    // a de-scoped post stops appearing on the statement.
    await db.query(
      `DELETE FROM billing_lines WHERE "periodId" = $1 AND site <> ALL($2::text[])`,
      [period.id, sites.map((s) => s.site)]
    );

    for (const bs of sites) {
      // billing_sites."dutyHours" IS the standard shift length for this post —
      // the per-site figure the man-hour model calls standardShiftHours. It
      // already existed, already defaults to 12 through billing_config, and is
      // already admin-editable on Clients & Detachments; a second column
      // meaning the same thing could only ever disagree with it.
      const dutyHours = resolveDutyHours(bs, cfg);
      const contractRate = resolveContractRate(bs, client, cfg);
      const sitePunches = punchesBySite.get(norm(bs.site)) || [];

      const derived = deriveSiteDayHours(sitePunches, {
        standardShiftHours: dutyHours,
        contractedGuards: bs.contractedGuards,
        from: period.ps,
        to: period.pe,
        // The flat baseline covers this many days, whatever the calendar says.
        standardPeriodDays: cadence.standardPeriodDays,
      });
      const remarks = derivedRemarks(derived, period.pe);

      // An OUT with no IN before it cannot be priced and is ignored by the
      // engine. Logged rather than dropped in silence: it means a punch went
      // missing, and somebody has to know to go looking.
      if (derived.unmatchedOuts.length) {
        console.warn(`[billing] ${bs.site}: ${derived.unmatchedOuts.length} time-out(s) with no preceding time-in`,
          derived.unmatchedOuts.map((u) => `${u.guardName} ${u.dutyDate}`).join("; "));
      }

      const line = (await db.query(
        `INSERT INTO billing_lines
           ("periodId","billingSiteId",site,"detachmentName","clientName","clientAddress",
            "derivedGuards","contractRateUsed","dutyHoursUsed","derivedLessHours","derivedAddHours",
            "pendingReviewDays","derivedRemarkLess","derivedRemarkAdd")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT ("periodId",site) DO UPDATE SET
           "billingSiteId" = EXCLUDED."billingSiteId",
           "detachmentName" = EXCLUDED."detachmentName",
           "clientName" = EXCLUDED."clientName",
           "clientAddress" = EXCLUDED."clientAddress",
           "derivedGuards" = EXCLUDED."derivedGuards",
           "contractRateUsed" = EXCLUDED."contractRateUsed",
           "dutyHoursUsed" = EXCLUDED."dutyHoursUsed",
           "derivedLessHours" = EXCLUDED."derivedLessHours",
           "derivedAddHours" = EXCLUDED."derivedAddHours",
           -- Refreshed like any derived figure. A day corrected since the last
           -- compute drops out of the count here, which is what returns the
           -- period to issuable without anyone clearing a flag by hand.
           "pendingReviewDays" = EXCLUDED."pendingReviewDays",
           -- Refreshed like any derived figure. The TYPED remark is deliberately
           -- not in this list: a recompute must never rewrite a biller's wording
           -- on a document that goes to a client.
           "derivedRemarkLess" = EXCLUDED."derivedRemarkLess",
           "derivedRemarkAdd" = EXCLUDED."derivedRemarkAdd"
         RETURNING id`,
        [period.id, bs.id, bs.site, bs.detachmentName || bs.site, client.name, client.address || "",
         derived.derivedGuards, contractRate, dutyHours, derived.lessHours, derived.addHours,
         derived.pendingCount, remarks.less, remarks.add]
      )).rows[0];

      // Day-level evidence is replaced wholesale each recompute — it describes
      // the derived figures, so it must never outlive them.
      await db.query(`DELETE FROM billing_line_days WHERE "lineId" = $1`, [line.id]);
      for (const d of derived.days) {
        await db.query(
          `INSERT INTO billing_line_days ("lineId","dutyDate","guardName",kind,reason,hours)
           VALUES ($1,$2::date,$3,$4,$5,$6)`,
          [line.id, d.dutyDate, d.guardName, d.kind, d.reason, d.hours]
        );
      }

      await repriceLine(db, line.id);
      count++;
    }

    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  res.json({ ok: true, lines: count, unmappedSites });
}));

// ---- Statement lines --------------------------------------------------------

// Override a derived quantity, or clear the override (send null) to fall back
// to what attendance says. Remarks print on the statement beside the LESS/ADD
// line they explain.
router.patch("/lines/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const line = (await pool.query(
    `SELECT bl.id, bp.status FROM billing_lines bl
     JOIN billing_periods bp ON bp.id = bl."periodId" WHERE bl.id = $1`, [req.params.id]
  )).rows[0];
  if (!line) return res.status(404).json({ error: "Statement line not found." });
  if (line.status !== "Draft") {
    return res.status(400).json({ error: `This period is ${line.status}. Only a draft statement can be edited.` });
  }

  // "field" in the body at all -> set it (possibly to null); absent -> leave.
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  await pool.query(
    `UPDATE billing_lines SET
       "guardsOverride"    = CASE WHEN $1 THEN $2::int     ELSE "guardsOverride"    END,
       "lessHoursOverride" = CASE WHEN $3 THEN $4::numeric ELSE "lessHoursOverride" END,
       "addHoursOverride"  = CASE WHEN $5 THEN $6::numeric ELSE "addHoursOverride"  END,
       -- NOT NULL with a 0 default, so a cleared field means "no manual ADD"
       -- rather than "unset". COALESCE keeps a null body value at zero.
       "addHoursManual"    = CASE WHEN $7 THEN COALESCE($8::numeric, 0) ELSE "addHoursManual" END,
       -- Same shape as addHoursManual: NOT NULL, so a cleared field stores 0
       -- ("no holiday pay") rather than a null, and an absent field is left
       -- alone so a partial PATCH cannot wipe a figure somebody typed.
       "legalHolidayAmount"   = CASE WHEN $9  THEN COALESCE($10::numeric, 0) ELSE "legalHolidayAmount"   END,
       "specialHolidayAmount" = CASE WHEN $11 THEN COALESCE($12::numeric, 0) ELSE "specialHolidayAmount" END,
       "remarksLess"       = COALESCE($13, "remarksLess"),
       "remarksAdd"        = COALESCE($14, "remarksAdd")
     WHERE id = $15`,
    [has("guardsOverride"), numOrNull(b.guardsOverride),
     has("lessHoursOverride"), numOrNull(b.lessHoursOverride),
     has("addHoursOverride"), numOrNull(b.addHoursOverride),
     has("addHoursManual"), numOrNull(b.addHoursManual),
     has("legalHolidayAmount"), numOrNull(b.legalHolidayAmount),
     has("specialHolidayAmount"), numOrNull(b.specialHolidayAmount),
     b.remarksLess ?? null, b.remarksAdd ?? null, req.params.id]
  );
  const computed = await repriceLine(pool, req.params.id);
  res.json({ ok: true, computed });
}));

router.get("/lines/:id/days", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", "guardName", kind, reason, hours
     FROM billing_line_days WHERE "lineId" = $1
     ORDER BY "dutyDate", kind, "guardName"`, [req.params.id]
  );
  res.json(rows);
}));

// ---- Workflow ---------------------------------------------------------------

// Issue: stamps the statement number and freezes the figures. The number is
// per RUN, not per detachment — every page of the statement carries it, which
// is how the client's accounts-payable references the payment.
router.patch("/periods/:id/issue", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const period = (await pool.query(
    `SELECT id, status, "soaNo", to_char(COALESCE("soaDate","periodEnd"),'YYYY') AS yr
     FROM billing_periods WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!period) return res.status(404).json({ error: "Billing period not found." });
  if (period.status !== "Draft") return res.status(400).json({ error: "Only a draft billing period can be issued." });

  const lineCount = (await pool.query(
    `SELECT COUNT(*)::int n FROM billing_lines WHERE "periodId" = $1`, [period.id]
  )).rows[0].n;
  if (!lineCount) return res.status(400).json({ error: "Compute the period before issuing it — it has no statement lines." });

  // A statement is a demand for payment, so it must not go out with days on it
  // that the derivation refused to price. Refused rather than warned: the
  // figures on those lines are known to be incomplete, and once issued they are
  // frozen and the client has them.
  //
  // 409, not 400 — the request is valid and the period is real; the conflict is
  // with the state of the attendance behind it, which is exactly what the
  // site-mismatch resolve route answers 409 for.
  const pending = (await pool.query(
    `SELECT "detachmentName", site, "pendingReviewDays"
     FROM billing_lines WHERE "periodId" = $1 AND "pendingReviewDays" > 0
     ORDER BY "detachmentName", site`, [period.id]
  )).rows;
  if (pending.length) {
    const total = pending.reduce((s, l) => s + Number(l.pendingReviewDays), 0);
    const where = pending.map((l) => `${l.detachmentName || l.site} (${l.pendingReviewDays})`).join(", ");
    return res.status(409).json({
      error: `${total} duty day${total === 1 ? "" : "s"} on this period ${total === 1 ? "has" : "have"} a time in with no time out and ${total === 1 ? "is" : "are"} held out of the computation: ${where}. ` +
        `Settle them in Attendance → Absence Monitoring → No time-out (approving a Missing Time Log request supplies the missing punch), then recompute before issuing.`,
      pendingReviewDays: total,
      lines: pending,
    });
  }

  const cfg = await loadConfig();
  const prefix = (cfg.soaPrefix || "SOA").trim();
  const soaNo = period.soaNo || await nextSoaNo(prefix, period.yr);

  await pool.query(
    `UPDATE billing_periods SET status = 'Issued', "soaNo" = $1, "updatedAt" = now() WHERE id = $2`,
    [soaNo, period.id]
  );
  // Snapshot the number onto each line so a page keeps its identity even if
  // the run is later renumbered.
  await pool.query(`UPDATE billing_lines SET "soaNo" = $1 WHERE "periodId" = $2`, [soaNo, period.id]);
  res.json({ ok: true, soaNo });
}));

// Next statement number for the year, e.g. SOA-2026-007. Sequential across
// clients, since the agency issues one series. The prefix is stripped to
// alphanumerics because it is interpolated into a regex below — and because a
// statement number with punctuation in it invites parsing mistakes downstream.
async function nextSoaNo(rawPrefix, year) {
  const prefix = (rawPrefix || "SOA").replace(/[^A-Za-z0-9]/g, "") || "SOA";
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace("soaNo", '^.*-', ''), '')::int), 0) AS n
     FROM billing_periods
     WHERE "soaNo" ~ ('^' || $1 || '-' || $2 || '-[0-9]+$')`,
    [prefix, year]
  );
  return `${prefix}-${year}-${String(Number(rows[0].n) + 1).padStart(3, "0")}`;
}

router.patch("/periods/:id/mark-paid", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE billing_periods SET status = 'Paid', "updatedAt" = now() WHERE id = $1 AND status = 'Issued'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only an issued billing period can be marked paid." });
  res.json({ ok: true });
}));

// Reopen an issued (unpaid) statement so it can be corrected before it goes
// out. Keeps its statement number, so a reissue is the same document.
router.patch("/periods/:id/reopen", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE billing_periods SET status = 'Draft', "updatedAt" = now() WHERE id = $1 AND status = 'Issued'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only an issued, unpaid billing period can be reopened." });
  res.json({ ok: true });
}));

// ---- PDFs -------------------------------------------------------------------

const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85", RULE = "#B9C4D4";

// Safe filename fragment for Content-Disposition.
const slug = (s) => (s || "statement").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Everything the letterhead needs, straight from System Settings — company
// name, logo, and the contact/signatory lines. Nothing about the agency is
// hardcoded in the document, so renaming the company in System Administration
// renames it on every statement.
async function letterhead() {
  const s = (await pool.query(
    `SELECT "companyName", "logoData", "agencyTagline", "agencyAddress",
            "agencyMobile", "agencyEmail", "ownerName", "ownerPosition"
     FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  return {
    companyName: (s.companyName || "").toUpperCase(),
    logoBuf: s.logoData || null,
    tagline: s.agencyTagline || "",
    address: s.agencyAddress || "",
    mobile: s.agencyMobile || "",
    email: s.agencyEmail || "",
    ownerName: s.ownerName || "",
    ownerPosition: s.ownerPosition || "",
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// 'YYYY-MM-DD' -> 'March 14, 2026'. Parsed by hand rather than through Date,
// which would re-interpret a bare date in the server's timezone and can shift
// it by a day.
function longDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// "July 16 to 31, 2025" when the range sits inside one month, widening only as
// far as it has to. This is the wording the agency's statements already use.
function periodLabel(start, end) {
  if (!start || !end) return "";
  const [sy, sm, sd] = String(start).split("-").map(Number);
  const [ey, em, ed] = String(end).split("-").map(Number);
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd} to ${ed}, ${sy}`;
  if (sy === ey) return `${MONTHS[sm - 1]} ${sd} to ${MONTHS[em - 1]} ${ed}, ${sy}`;
  return `${MONTHS[sm - 1]} ${sd}, ${sy} to ${MONTHS[em - 1]} ${ed}, ${ey}`;
}

// One detachment's Statement of Account, laid out as the agency's existing
// template prints it. Draws onto the CURRENT page, so several detachments can
// be emitted back to back with addPage() between them.
function drawSoaPage(doc, { lh, period, line }) {
  const L = doc.page.margins.left;                       // 40
  const R = doc.page.width - doc.page.margins.right;     // 555
  const W = R - L;
  const money = (n) => amountPdf(n);

  // --- Letterhead ---
  let y = 42;
  if (lh.logoBuf) {
    try { doc.image(lh.logoBuf, L, y - 4, { fit: [56, 56] }); } catch (e) { /* unreadable logo: skip */ }
  }
  doc.font("Helvetica-Bold").fontSize(15).fillColor(NAVY)
    .text(lh.companyName, L, y, { width: W, align: "center" });
  y = doc.y + 1;
  if (lh.tagline) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(GOLD)
      .text(lh.tagline, L, y, { width: W, align: "center" });
    y = doc.y + 1;
  }
  doc.font("Helvetica").fontSize(8).fillColor(MUTE);
  for (const l of [
    lh.address ? `Main Office: ${lh.address}` : "",
    lh.mobile ? `Mobile No. ${lh.mobile}` : "",
    lh.email ? `Email Address: ${lh.email}` : "",
  ].filter(Boolean)) {
    doc.text(l, L, y, { width: W, align: "center" });
    y = doc.y;
  }

  y += 8;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor(NAVY).stroke();
  y += 12;

  doc.font("Helvetica-Bold").fontSize(13).fillColor(NAVY)
    .text("STATEMENT OF ACCOUNT", L, y, { width: W, align: "center", characterSpacing: 1 });
  y = doc.y + 14;

  // --- Header block ---
  const label = (t, v, yy, x, labelW, valW) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTE).text(t, x, yy, { width: labelW });
    doc.font("Helvetica").fontSize(9.5).fillColor("#1a1a1a")
      .text(v || "—", x + labelW, yy - 0.5, { width: valW });
  };
  label("Date:", longDate(period.soaDate || period.periodEnd), y, L, 46, 190);
  label("SOA No:", line.soaNo || period.soaNo || "(unissued draft)", y, L + 300, 52, W - 352);
  y += 16;
  label("Name of Client:", line.clientName || period.clientName, y, L, 84, W - 84);
  y += 16;
  label("Detachment:", line.detachmentName || line.site, y, L, 84, W - 84);
  y += 16;
  label("Address:", line.clientAddress || period.clientAddress, y, L, 84, W - 84);
  y += 22;

  // --- Particulars table ---
  const AMT_W = 110;
  const PART_W = W - AMT_W;
  doc.rect(L, y, W, 18).fill("#EEF2F7");
  doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY)
    .text("PARTICULARS", L + 6, y + 5, { width: PART_W - 12 })
    .text("AMOUNT", L + PART_W, y + 5, { width: AMT_W - 6, align: "right" });
  y += 24;

  // A particulars row: text on the left, amount right-aligned in its column.
  const row = (text, amount, opts = {}) => {
    const size = opts.size || 9.5;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
      .fillColor(opts.color || "#1a1a1a")
      .text(text, L + (opts.indent || 0), y, { width: PART_W - 12 - (opts.indent || 0) });
    const textBottom = doc.y;
    if (amount !== null && amount !== undefined) {
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .fillColor(opts.color || "#1a1a1a")
        .text(amount, L + PART_W, y, { width: AMT_W - 6, align: "right" });
    }
    y = Math.max(textBottom, y + size + 4) + 3;
  };
  const rule = (thick) => {
    doc.moveTo(L, y).lineTo(R, y).lineWidth(thick ? 1 : 0.6)
      .strokeColor(thick ? NAVY : RULE).stroke();
    y += 6;
  };

  row("Security services rendered for the period of:", null);
  row(periodLabel(period.periodStart, period.periodEnd), null, { bold: true, indent: 12 });
  y += 2;

  const guardsWords = numberToWords(line.guards);
  const dutyHours = Number(line.dutyHoursUsed) || 12;
  row(`${guardsWords} guard(s) rendered (${dutyHours} hours) duty`,
    money(line.billingPeriodRate), { indent: 12 });

  // LESS / ADDITIONAL print only when there is something to say, exactly as
  // the template's IF() does — a statement with no adjustments shows no lines.
  // The typed remark wins; the derivation's own wording is the default. So a
  // statement reads "No calendar date: Feb 29-30 2026 - LESS: 6 Day(s) - 72
  // Hours" with nobody typing anything, and a biller who needs different words
  // still overrides it.
  //
  // "N Day(s)" is GUARD-days, not calendar days: hoursAsDays divides by the
  // post's standard shift, so 72 h at a 12 h post is 6 guard-days — six
  // guard-shifts not rendered, which is what the client is being credited for.
  const remarkLess = line.remarksLess || line.derivedRemarkLess || "";
  const remarkAdd = line.remarksAdd || line.derivedRemarkAdd || "";
  if (Number(line.lessHours) > 0) {
    const hd = hoursAsDays(line.lessHours, dutyHours);
    row(`${remarkLess ? remarkLess + " " : ""}- LESS: ${hd.label}`,
      `(${money(line.lessAmount)})`, { indent: 12, color: "#8C2F2F" });
  }
  if (Number(line.addHours) > 0) {
    const hd = hoursAsDays(line.addHours, dutyHours);
    row(`${remarkAdd ? remarkAdd + " " : ""}- AUGMENTATION: ${hd.label}`,
      money(line.addAmount), { indent: 12, color: "#1E5E3A" });
  }

  // Holiday pay, on the same "print only when there is something to say" rule as
  // the adjustments above — row() advances the cursor only when it is called, so
  // a detachment with no holiday pay shows no line and occupies no space. Placed
  // after the adjustments and before TOTAL because it is part of the billable
  // base, not an afterthought: billingCost already includes it, so the admin fee
  // and the withholding below are taken from a holiday-inclusive figure.
  if (Number(line.legalHolidayAmount) > 0) {
    row("Legal Holiday Pay", money(line.legalHolidayAmount), { indent: 12, color: "#1E5E3A" });
  }
  if (Number(line.specialHolidayAmount) > 0) {
    row("Special Holiday Pay", money(line.specialHolidayAmount), { indent: 12, color: "#1E5E3A" });
  }

  y += 2;
  rule();
  row("TOTAL", money(line.billingCost), { bold: true });
  // The rate is read from the LINE, not from config. A client may carry its own
  // withholding percentage, and an issued statement must state the figure it was
  // computed under — not whichever one config holds when it is reprinted. Falls
  // back to 2% only for lines computed before the percentage was snapshotted.
  const whtPct = line.withholdingTaxPercentUsed != null ? pctLabel(line.withholdingTaxPercentUsed) : "2%";
  row(`Less:  ${whtPct} Withholding Tax`, money(line.withholdingTax));
  rule(true);
  y += 4;

  // --- Note block: how the total splits between the guards and the agency ---
  doc.font("Helvetica").fontSize(9).fillColor(MUTE);
  const noteRow = (text, amount, bold) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? NAVY : MUTE)
      .text(text, L + 12, y, { width: PART_W - 24 });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? NAVY : MUTE)
      .text(pesoPdf(amount), L + PART_W, y, { width: AMT_W - 6, align: "right" });
    y += 14;
  };
  noteRow("Note: Amount to guards and Government-", line.dueForGuard);
  noteRow("Administrative Overhead :", line.adminFee);
  noteRow("TOTAL", line.billingCost, true);

  y += 10;
  doc.rect(L, y, W, 26).fill(NAVY);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#fff")
    .text("Please pay this amount", L + 8, y + 8, { width: PART_W - 16 });
  doc.font("Helvetica-Bold").fontSize(12).fillColor(GOLD)
    .text(pesoPdf(line.netAmount), L + PART_W, y + 7, { width: AMT_W - 8, align: "right" });
  y += 40;

  doc.font("Helvetica").fontSize(9).fillColor("#1a1a1a")
    .text(`You may prepare your check or cash payment to ${lh.ownerName}`, L, y, { width: W });
  y += 44;

  // --- Signatories ---
  const colW = (W - 40) / 2;
  const sign = (x, heading, name, sub) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTE).text(heading, x, y, { width: colW });
    doc.moveTo(x, y + 44).lineTo(x + colW, y + 44).lineWidth(0.8).strokeColor("#1a1a1a").stroke();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#1a1a1a").text(name || "", x, y + 48, { width: colW });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTE).text(sub || "", x, y + 60, { width: colW });
  };
  sign(L, "Prepared by", lh.ownerName, lh.ownerPosition);
  sign(L + colW + 40, "Received by", line.clientName || period.clientName, "Client");
}

async function loadPeriodForPdf(id) {
  const period = (await pool.query(
    `${PERIOD_SELECT} WHERE bp.id = $1 GROUP BY bp.id, bc.name, bc.address`, [id]
  )).rows[0];
  if (!period) return null;
  const lines = (await pool.query(
    `SELECT * FROM billing_lines WHERE "periodId" = $1 ORDER BY "detachmentName", site`, [id]
  )).rows;
  return { period, lines };
}

// One detachment's statement.
router.get("/lines/:id/soa.pdf", requireAuth, wrap(async (req, res) => {
  const line = (await pool.query(`SELECT * FROM billing_lines WHERE id = $1`, [req.params.id])).rows[0];
  if (!line) return res.status(404).json({ error: "Statement line not found." });
  const loaded = await loadPeriodForPdf(line.periodId);
  const lh = await letterhead();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition",
    `attachment; filename="SOA-${slug(line.detachmentName || line.site)}-${loaded.period.periodStart}_${loaded.period.periodEnd}.pdf"`);
  doc.pipe(res);
  drawSoaPage(doc, { lh, period: loaded.period, line });
  stampAuthorFooter(doc, lh.companyName);
  doc.end();
}));

// Every detachment in the period, one page each.
router.get("/periods/:id/soa.pdf", requireAuth, wrap(async (req, res) => {
  const loaded = await loadPeriodForPdf(req.params.id);
  if (!loaded) return res.status(404).json({ error: "Billing period not found." });
  const { period, lines } = loaded;
  if (!lines.length) return res.status(400).json({ error: "This period has no statement lines yet. Compute it first." });
  const lh = await letterhead();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition",
    `attachment; filename="SOA-${slug(period.clientName)}-${period.periodStart}_${period.periodEnd}.pdf"`);
  doc.pipe(res);
  lines.forEach((line, i) => {
    if (i > 0) doc.addPage({ size: "A4", margin: 40 });
    drawSoaPage(doc, { lh, period, line });
  });
  stampAuthorFooter(doc, lh.companyName);
  doc.end();
}));

// The internal computation sheet: every detachment on one landscape page, the
// working behind the statements rather than a document for the client.
router.get("/periods/:id/summary.pdf", requireAuth, wrap(async (req, res) => {
  const loaded = await loadPeriodForPdf(req.params.id);
  if (!loaded) return res.status(404).json({ error: "Billing period not found." });
  const { period, lines } = loaded;
  const lh = await letterhead();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition",
    `attachment; filename="billing-summary-${slug(period.clientName)}-${period.periodStart}_${period.periodEnd}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
  const textX = lh.logoBuf ? 96 : 40;
  if (lh.logoBuf) { try { doc.image(lh.logoBuf, 40, 20, { fit: [42, 42] }); } catch (e) { /* skip */ } }
  doc.font("Helvetica").fillColor(GOLD).fontSize(10).text(lh.companyName, textX, 24, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(16).text("Billing Computation", textX, 40);
  doc.fillColor("#C9D3E3").fontSize(9).text(
    `${period.clientName}  ·  Period covered: ${periodLabel(period.periodStart, period.periodEnd)}  ·  ` +
    `${period.soaNo ? "SOA No: " + period.soaNo + "  ·  " : ""}Status: ${period.status}  ·  Generated ${longDate(new Date().toISOString().slice(0, 10))}`,
    textX, 62, { width: doc.page.width - textX - 40 });

  let y = 104;
  // Widths total 762pt — A4 landscape (842) less two 40pt margins. Exceeding
  // it silently runs the right-hand columns off the page.
  const cols = [
    { k: "detachmentName", label: "Detachment", w: 106, align: "left" },
    { k: "guards", label: "# Guards", w: 46 },
    { k: "billingPeriodRate", label: "Period Rate", w: 66 },
    { k: "lessHours", label: "LESS Hrs", w: 50 },
    { k: "lessAmount", label: "LESS Amt", w: 62 },
    { k: "addHours", label: "AUGMENT Hrs", w: 48 },
    { k: "addAmount", label: "AUGMENT Amt", w: 62 },
    { k: "billingCost", label: "Billing Cost", w: 68 },
    { k: "dueForGuard", label: "Due for Guard", w: 70 },
    { k: "adminFee", label: "Admin Fee", w: 62 },
    // Not "2% W/Tax": the rate is per client now, and a column header stating
    // one figure above a column computed at another is worse than no figure.
    { k: "withholdingTax", label: "W/Tax", w: 52 },
    { k: "netAmount", label: "Net Amount", w: 70 },
  ];
  const MONEY_KEYS = new Set(["billingPeriodRate", "lessAmount", "addAmount", "billingCost", "dueForGuard", "adminFee", "withholdingTax", "netAmount"]);

  const drawRow = (vals, opts = {}) => {
    let x = 40;
    if (opts.header) doc.rect(40, y - 2, cols.reduce((s, c) => s + c.w, 0), 16).fill("#EEF2F7");
    if (opts.total) doc.rect(40, y - 2, cols.reduce((s, c) => s + c.w, 0), 16).fill("#F3F6FA");
    cols.forEach((c, i) => {
      doc.font(opts.header || opts.total ? "Helvetica-Bold" : "Helvetica")
        .fillColor(opts.header || opts.total ? NAVY : "#1a1a1a").fontSize(opts.header ? 8 : 8.5)
        .text(String(vals[i] ?? ""), x + 2, y + 2, {
          width: c.w - 4, align: c.align || "right", ellipsis: true,
        });
      x += c.w;
    });
    y += 16;
    if (y > doc.page.height - 50) { doc.addPage({ size: "A4", layout: "landscape", margin: 40 }); y = 46; }
  };

  drawRow(cols.map((c) => c.label), { header: true });
  if (!lines.length) {
    doc.font("Helvetica").fillColor(MUTE).fontSize(9)
      .text("No detachments computed for this period yet.", 40, y + 6);
  }
  for (const l of lines) {
    drawRow(cols.map((c) => (MONEY_KEYS.has(c.k) ? amountPdf(l[c.k])
      : c.k === "detachmentName" ? (l.detachmentName || l.site)
      : String(l[c.k] ?? ""))));
  }
  if (lines.length) {
    const sum = (k) => lines.reduce((s, l) => s + Number(l[k] || 0), 0);
    drawRow(cols.map((c) => {
      if (c.k === "detachmentName") return "TOTAL";
      if (MONEY_KEYS.has(c.k)) return amountPdf(sum(c.k));
      if (c.k === "guards") return String(sum("guards"));
      // The hours columns total too — a row that footed in money but left its
      // hours blank read as if the hours weren't part of the same arithmetic.
      return sum(c.k).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }), { total: true });
  }

  stampAuthorFooter(doc, lh.companyName);

  doc.end();
}));

module.exports = router;
