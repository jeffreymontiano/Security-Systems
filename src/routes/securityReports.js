// Security Reports — the Operations-layer module that files the agency's
// statutory returns. Its first report is the Monthly Disposition Report (MDR),
// namespaced under /mdr so a second report type needs no second mount.
//
// Every judgement about a return — what is wrong with it, and whether it may
// be finalised — comes from src/lib/mdrHelpers.js. This file transports and
// persists; it never decides. That is what stops the API and the screen from
// disagreeing about whether a return is filable.

const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { phDateOf } = require("../lib/phTime");
const {
  monthPhrases, subjectLine, certificationLine, previousMonth, monthWindow,
  numbering, firearmsByPersonnel, classifyFirearm,
  firearmsByProvince, recapitulation, reportIssues, finaliseCheck, rankFor,
} = require("../lib/mdrHelpers");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler — it
// escapes to the process, which then answers nothing.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[security-reports]", e);
  if (!res.headersSent) res.status(500).json({ error: e.message || "The security report request failed." });
});

const today = () => phDateOf(Date.now());
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const dateOrNull = (v) => (str(v) ? str(v).slice(0, 10) : null);
// Only write a field the caller actually sent, so a partial PATCH from an
// older client cannot blank what it didn't mention.
const patchField = (b, k) => (Object.prototype.hasOwnProperty.call(b, k) ? str(b[k]) : null);

// ---------------------------------------------------------------------------
// Loading a return
// ---------------------------------------------------------------------------

const REPORT_SELECT = `
  SELECT r.*,
         to_char(r."reportDate",'YYYY-MM-DD')    AS "reportDate",
         to_char(r."submittedDate",'YYYY-MM-DD') AS "submittedDate",
         to_char(r."finalisedAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "finalisedAt",
         to_char(r."createdAt"   AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "createdAt",
         (SELECT COUNT(*)::int FROM mdr_personnel p WHERE p."reportId" = r.id) AS "guardCount",
         (SELECT COUNT(*)::int FROM mdr_firearms  f WHERE f."reportId" = r.id) AS "firearmCount",
         (SELECT COUNT(*)::int FROM mdr_clients   c WHERE c."reportId" = r.id) AS "clientCount"
  FROM mdr_reports r
`;

async function loadParts(reportId) {
  const [clients, personnel, firearms, officers, movements] = await Promise.all([
    pool.query(`SELECT * FROM mdr_clients WHERE "reportId" = $1 ORDER BY "sortOrder", id`, [reportId]),
    pool.query(
      `SELECT p.*, to_char(p."licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry",
              e."employmentStatus"
       FROM mdr_personnel p
       LEFT JOIN employees e ON e.id = p."employeeId"
       WHERE p."reportId" = $1 ORDER BY p."sortOrder", p.id`, [reportId]),
    pool.query(
      `SELECT f.*, to_char(f."licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry",
              a.status AS "assetStatus"
       FROM mdr_firearms f
       LEFT JOIN assets a ON a.id = f."assetId"
       WHERE f."reportId" = $1 ORDER BY f."sortOrder", f.id`, [reportId]),
    pool.query(`SELECT * FROM mdr_officers WHERE "reportId" = $1 ORDER BY "sortOrder", id`, [reportId]),
    pool.query(
      `SELECT m.*, to_char(m."effectiveDate",'YYYY-MM-DD') AS "effectiveDate"
       FROM mdr_movements m WHERE m."reportId" = $1 ORDER BY m.kind, m."sortOrder", m.id`, [reportId]),
  ]);
  return {
    clients: clients.rows, personnel: personnel.rows, firearms: firearms.rows,
    officers: officers.rows, movements: movements.rows,
  };
}

// The current state of the records a return points at — used ONLY to judge it
// (has this guard since separated? has this firearm been written off?), never
// to supply a value that gets printed. Printed values are snapshotted on the
// rows themselves, which is what makes a finalised return immutable.
function liveRecords(parts) {
  const employees = new Map();
  for (const p of parts.personnel) {
    if (p.employeeId) employees.set(p.employeeId, { employmentStatus: p.employmentStatus });
  }
  const assets = new Map();
  for (const f of parts.firearms) {
    if (f.assetId) assets.set(f.assetId, { status: f.assetStatus });
  }
  return { employees, assets };
}

// Everything a caller needs to render or judge a return, assembled once so the
// screen and the finalise check are looking at identical numbers.
function assemble(report, parts) {
  const { clients, personnel, firearms, officers, movements } = parts;
  const nums = numbering(clients, personnel);
  const byPersonnel = firearmsByPersonnel(firearms);
  const issues = reportIssues({ report, clients, personnel, firearms, ...liveRecords(parts) });

  return {
    report: {
      ...report,
      subject: subjectLine(report.region, report.periodMonth),
      monthLabel: monthPhrases(report.periodMonth).label,
      certification: report.certificationText || certificationLine(report.periodMonth),
    },
    clients: clients.map((c) => ({
      ...c,
      personnel: personnel
        .filter((p) => p.clientId === c.id)
        .map((p) => ({
          ...p,
          ...(nums.get(p.id) || { runningNo: null, lineNo: null }),
          firearms: (byPersonnel.get(p.id) || []).map((f) => ({ ...f, firearmClass: classifyFirearm(f) })),
        })),
    })),
    officers,
    movements: {
      gains: movements.filter((m) => m.kind === "Gain"),
      losses: movements.filter((m) => m.kind === "Loss"),
    },
    // Sections 1 and 3 — derived here, stored nowhere.
    section1: firearmsByProvince(clients, personnel, firearms),
    section3: recapitulation(clients, personnel, firearms),
    issues,
    // The verdict the finalise route will reach, so the screen can show it
    // BEFORE the user presses the button rather than after.
    verdict: finaliseCheck(issues),
  };
}

async function getReport(id) {
  return (await pool.query(`${REPORT_SELECT} WHERE r.id = $1`, [id])).rows[0] || null;
}

// A finalised or submitted return is an immutable snapshot. Every write below
// funnels through this, so no route can forget it.
function assertDraft(report, res, what = "return") {
  if (report.status === "Draft") return true;
  res.status(409).json({
    error: `This ${what} is ${report.status} and cannot be edited. Reopen it first if it must be corrected.`,
    status: report.status,
  });
  return false;
}

async function touch(id, username) {
  await pool.query(`UPDATE mdr_reports SET "updatedBy" = $1, "updatedAt" = now() WHERE id = $2`, [username, id]);
}

// A child row's report, loaded from the child itself so ownership and status
// are checked in one place for every nested route.
async function parentOf(table, childId) {
  const row = (await pool.query(`SELECT "reportId" FROM ${table} WHERE id = $1`, [childId])).rows[0];
  if (!row) return null;
  return getReport(row.reportId);
}

// ---------------------------------------------------------------------------
// Returns — list, create, read
// ---------------------------------------------------------------------------

router.get("/mdr", requireAuth, wrap(async (req, res) => {
  const vals = [];
  const clauses = [];
  if (str(req.query.year)) { vals.push(`${str(req.query.year)}-%`); clauses.push(`r."periodMonth" LIKE $${vals.length}`); }
  if (str(req.query.status)) { vals.push(str(req.query.status)); clauses.push(`r.status = $${vals.length}`); }
  if (str(req.query.region)) { vals.push(str(req.query.region)); clauses.push(`r.region = $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `${REPORT_SELECT} ${where} ORDER BY r."periodMonth" DESC, r.region, r.id DESC`, vals
  );
  res.json(rows.map((r) => ({
    ...r,
    monthLabel: monthPhrases(r.periodMonth).label,
    subject: subjectLine(r.region, r.periodMonth),
  })));
}));

// Create a return for a month.
//
// The addressee, attention and region come from System Settings so they are
// not re-typed every month, and the previous month's officers and client
// blocks are carried forward for the same reason. The subject line is never
// accepted from the caller — it is composed from the region and the month, so
// it cannot name a month the body and certification disagree with.
router.post("/mdr", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const periodMonth = str(b.periodMonth);
  if (!monthPhrases(periodMonth).valid) {
    return res.status(400).json({ error: "A valid report month (YYYY-MM) is required." });
  }

  const s = (await pool.query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
  const region = str(b.region) || str(s.agencyRegion);

  const dup = (await pool.query(
    `SELECT id FROM mdr_reports WHERE "periodMonth" = $1 AND region = $2`, [periodMonth, region]
  )).rows[0];
  if (dup) {
    return res.status(409).json({
      error: `A Monthly Disposition Report for ${monthPhrases(periodMonth).label} in ${region} already exists. Open it rather than filing a second return for the same month.`,
      existingId: dup.id,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO mdr_reports ("periodMonth","reportDate",region,addressee,attention,
         "preparedByName","preparedByPosition","notedByName","notedByPosition","createdBy","updatedBy")
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [periodMonth, dateOrNull(b.reportDate) || today(), region,
       str(b.addressee) || str(s.agencyRcsuAddressee), str(b.attention) || str(s.agencyRcsuAttention),
       str(b.preparedByName), str(b.preparedByPosition),
       str(b.notedByName) || str(s.ownerName), str(b.notedByPosition) || str(s.ownerPosition),
       req.user.username]
    );
    const id = rows[0].id;

    // Carry forward from last month's return for the same region: the officer
    // list is the same six people month after month, and the client blocks are
    // the same detachments. Guards are NOT carried forward — who was posted is
    // the thing the return exists to state, and it must be pulled fresh.
    const prev = (await client.query(
      `SELECT id FROM mdr_reports WHERE "periodMonth" = $1 AND region = $2 ORDER BY id DESC LIMIT 1`,
      [previousMonth(periodMonth), region]
    )).rows[0];
    let carried = { officers: 0, clients: 0 };
    if (prev && b.carryForward !== false) {
      const o = await client.query(
        `INSERT INTO mdr_officers ("reportId",name,designation,"homeAddress","contactNumbers","sortOrder")
         SELECT $1, name, designation, "homeAddress", "contactNumbers", "sortOrder"
         FROM mdr_officers WHERE "reportId" = $2`, [id, prev.id]);
      const c = await client.query(
        `INSERT INTO mdr_clients ("reportId","billingSiteId","clientName","clientAddress",province,"sortOrder")
         SELECT $1, "billingSiteId", "clientName", "clientAddress", province, "sortOrder"
         FROM mdr_clients WHERE "reportId" = $2`, [id, prev.id]);
      carried = { officers: o.rowCount, clients: c.rowCount };
    }
    await client.query("COMMIT");
    res.status(201).json({ id, carriedForward: carried });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}));

router.get("/mdr/:id", requireAuth, wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  res.json(assemble(report, await loadParts(report.id)));
}));

router.patch("/mdr/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};

  // Changing the month or region must not collide with another return.
  const periodMonth = patchField(b, "periodMonth");
  if (periodMonth !== null && !monthPhrases(periodMonth).valid) {
    return res.status(400).json({ error: "The report month must be a valid YYYY-MM." });
  }
  const nextMonth = periodMonth ?? report.periodMonth;
  const nextRegion = patchField(b, "region") ?? report.region;
  if (nextMonth !== report.periodMonth || nextRegion !== report.region) {
    const dup = (await pool.query(
      `SELECT id FROM mdr_reports WHERE "periodMonth" = $1 AND region = $2 AND id <> $3`,
      [nextMonth, nextRegion, report.id])).rows[0];
    if (dup) return res.status(409).json({ error: `A return for ${monthPhrases(nextMonth).label} in ${nextRegion} already exists.`, existingId: dup.id });
  }

  await pool.query(
    `UPDATE mdr_reports SET
       "periodMonth" = COALESCE($1, "periodMonth"),
       "reportDate"  = COALESCE(NULLIF($2,'')::date, "reportDate"),
       region        = COALESCE($3, region),
       addressee     = COALESCE($4, addressee),
       attention     = COALESCE($5, attention),
       "preparedByName"     = COALESCE($6,  "preparedByName"),
       "preparedByPosition" = COALESCE($7,  "preparedByPosition"),
       "notedByName"        = COALESCE($8,  "notedByName"),
       "notedByPosition"    = COALESCE($9,  "notedByPosition"),
       "updatedBy" = $10, "updatedAt" = now()
     WHERE id = $11`,
    [periodMonth, patchField(b, "reportDate"), patchField(b, "region"),
     patchField(b, "addressee"), patchField(b, "attention"),
     patchField(b, "preparedByName"), patchField(b, "preparedByPosition"),
     patchField(b, "notedByName"), patchField(b, "notedByPosition"),
     req.user.username, report.id]
  );
  res.json({ ok: true });
}));

router.delete("/mdr/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (report.status !== "Draft") {
    return res.status(409).json({ error: `A ${report.status} return is a filed record and cannot be deleted.` });
  }
  await pool.query(`DELETE FROM mdr_reports WHERE id = $1`, [report.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Workflow: Draft -> Finalised -> Submitted
// ---------------------------------------------------------------------------

// Finalise. The verdict comes from finaliseCheck() in the engine and is obeyed
// verbatim — this route adds no rule of its own, which is what guarantees the
// screen's preview and the actual outcome agree.
router.patch("/mdr/:id/finalise", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (report.status !== "Draft") {
    return res.status(409).json({ error: `This return is already ${report.status}.` });
  }

  const parts = await loadParts(report.id);
  const issues = reportIssues({ report, ...parts, ...liveRecords(parts) });
  const verdict = finaliseCheck(issues, { overrideReason: (req.body || {}).overrideReason });
  if (!verdict.ok) {
    return res.status(409).json({
      error: verdict.message, code: verdict.code,
      requiresOverride: verdict.requiresOverride,
      blocking: verdict.blocking, advisory: verdict.advisory,
    });
  }

  // Snapshot the letterhead and the certification wording. From here the
  // return prints what it was filed with, whatever System Settings later says.
  const s = (await pool.query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
  const letterhead = {
    companyName: s.companyName || "",
    agencyAddress: s.agencyAddress || "",
    agencyLtoNo: s.agencyLtoNo || "",
    agencyLtoExpiry: s.agencyLtoExpiry ? String(s.agencyLtoExpiry).slice(0, 10) : "",
    agencyContactPerson: s.agencyContactPerson || "",
    agencyContactMobile: s.agencyContactMobile || s.agencyMobile || "",
    agencyEmail: s.agencyEmail || "",
  };

  await pool.query(
    `UPDATE mdr_reports SET status = 'Finalised',
       "letterheadJson" = $1::jsonb, "certificationText" = $2,
       "overrideReason" = $3, "overrideIssuesJson" = $4::jsonb,
       "finalisedBy" = $5, "finalisedAt" = now(), "updatedBy" = $5, "updatedAt" = now()
     WHERE id = $6`,
    [JSON.stringify(letterhead), certificationLine(report.periodMonth),
     verdict.overrideReason || "", JSON.stringify(verdict.overrideIssues || []),
     req.user.username, report.id]
  );
  res.json({ ok: true, waived: (verdict.overrideIssues || []).length });
}));

// Reopen — deliberately only from Finalised, never from Submitted. Once a
// return has gone to RCSU, correcting it is an amended filing, not an edit of
// the document they already hold.
router.patch("/mdr/:id/reopen", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (report.status !== "Finalised") {
    return res.status(409).json({
      error: report.status === "Submitted"
        ? "This return has been submitted to RCSU and cannot be reopened. File an amended return instead."
        : "Only a finalised return can be reopened.",
    });
  }
  await pool.query(
    `UPDATE mdr_reports SET status = 'Draft', "updatedBy" = $1, "updatedAt" = now() WHERE id = $2`,
    [req.user.username, report.id]
  );
  res.json({ ok: true });
}));

router.patch("/mdr/:id/submit", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (report.status !== "Finalised") {
    return res.status(409).json({ error: "Finalise the return before recording its submission." });
  }
  await pool.query(
    `UPDATE mdr_reports SET status = 'Submitted', "submittedDate" = $1::date,
       "updatedBy" = $2, "updatedAt" = now() WHERE id = $3`,
    [dateOrNull((req.body || {}).submittedDate) || today(), req.user.username, report.id]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Section 2 — client blocks
// ---------------------------------------------------------------------------

// Detachments the agency bills, offered as the source for a client block.
router.get("/mdr/lookup/detachments", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bs.id, bs.site, bs."detachmentName", bc.name AS "clientName", bc.address
     FROM billing_sites bs JOIN billing_clients bc ON bc.id = bs."clientId"
     WHERE bs.active ORDER BY bc.name, bs.site`
  );
  res.json(rows);
}));

router.post("/mdr/:id/clients", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};

  // Prefill from a billing detachment where one is named; the values are
  // COPIED onto the return, never read through the link at print time.
  let name = str(b.clientName), address = str(b.clientAddress);
  const billingSiteId = b.billingSiteId ? Number(b.billingSiteId) : null;
  if (billingSiteId && (!name || !address)) {
    const d = (await pool.query(
      `SELECT bs."detachmentName", bs.site, bc.name, bc.address
       FROM billing_sites bs JOIN billing_clients bc ON bc.id = bs."clientId"
       WHERE bs.id = $1`, [billingSiteId])).rows[0];
    if (d) {
      name = name || str(d.detachmentName) || str(d.name) || str(d.site);
      address = address || str(d.address);
    }
  }
  if (!name) return res.status(400).json({ error: "A client name is required." });

  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_clients WHERE "reportId" = $1`, [report.id]
  )).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO mdr_clients ("reportId","billingSiteId","clientName","clientAddress",province,"sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [report.id, billingSiteId, name, address, str(b.province), next]
  );
  await touch(report.id, req.user.username);
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/mdr/clients/:cid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_clients", req.params.cid);
  if (!report) return res.status(404).json({ error: "Client block not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  await pool.query(
    `UPDATE mdr_clients SET
       "clientName"    = COALESCE($1, "clientName"),
       "clientAddress" = COALESCE($2, "clientAddress"),
       province        = COALESCE($3, province),
       "sortOrder"     = COALESCE($4, "sortOrder")
     WHERE id = $5`,
    [patchField(b, "clientName"), patchField(b, "clientAddress"), patchField(b, "province"),
     b.sortOrder === undefined ? null : Number(b.sortOrder), req.params.cid]
  );
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

router.delete("/mdr/clients/:cid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_clients", req.params.cid);
  if (!report) return res.status(404).json({ error: "Client block not found." });
  if (!assertDraft(report, res)) return;
  await pool.query(`DELETE FROM mdr_clients WHERE id = $1`, [req.params.cid]);
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Section 2 — personnel
// ---------------------------------------------------------------------------

// Pull the guards posted at this client from the 201 File, with their LESP
// details, and any firearm currently issued to them from the Asset register.
//
// This is what makes the module worth building rather than re-keying 66 rows a
// month. Everything it writes is a SNAPSHOT and stays editable; guards not in
// the file can still be added by hand.
router.post("/mdr/clients/:cid/from-records", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const block = (await pool.query(`SELECT * FROM mdr_clients WHERE id = $1`, [req.params.cid])).rows[0];
  if (!block) return res.status(404).json({ error: "Client block not found." });
  const report = await getReport(block.reportId);
  if (!assertDraft(report, res)) return;

  // Which site's guards? The detachment's site when the block is linked to
  // one, otherwise a site named in the request.
  let site = str((req.body || {}).site);
  if (!site && block.billingSiteId) {
    const d = (await pool.query(`SELECT site FROM billing_sites WHERE id = $1`, [block.billingSiteId])).rows[0];
    site = d ? str(d.site) : "";
  }
  if (!site) {
    return res.status(400).json({ error: "This client block is not linked to a detachment. Choose a site to pull guards from." });
  }

  const { from, to } = monthWindow(report.periodMonth);
  const already = new Set((await pool.query(
    `SELECT "employeeId" FROM mdr_personnel WHERE "reportId" = $1 AND "employeeId" IS NOT NULL`,
    [report.id])).rows.map((r) => r.employeeId));

  const guards = (await pool.query(
    `SELECT id, "fullName", position, "lespNo", to_char("lespExpiry",'YYYY-MM-DD') AS "lespExpiry"
     FROM employees
     WHERE site = $1 AND "employmentStatus" = 'Active'
     ORDER BY "fullName"`, [site])).rows;

  // Firearms currently in each guard's hands, from the issuance ledger — the
  // same ledger the asset module derives availability from, so a firearm
  // already returned cannot be reported as deployed.
  //
  // "Open" is status IN ('Issued','Partially Returned'), exactly as
  // routes/assets.js defines it. There is no returned-date predicate to use:
  // the ledger records outcome in `status`, and a partially returned bulk
  // issue is still outstanding.
  const issued = (await pool.query(
    `SELECT i."employeeId", a.id AS "assetId", a.brand, a.name, a.caliber, a.model,
            a."serialNumber", to_char(a."licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry"
     FROM asset_issuances i
     JOIN assets a ON a.id = i."assetId"
     WHERE i.status IN ('Issued','Partially Returned')
       AND i."employeeId" IS NOT NULL
       AND a."categoryId" IN (SELECT id FROM asset_categories WHERE name ILIKE '%firearm%')
       AND a.status NOT IN ('Retired','Lost')`)).rows;
  const faByEmployee = new Map();
  for (const f of issued) {
    if (!faByEmployee.has(f.employeeId)) faByEmployee.set(f.employeeId, []);
    faByEmployee.get(f.employeeId).push(f);
  }

  const client = await pool.connect();
  let added = 0, firearmsAdded = 0, skipped = 0;
  try {
    await client.query("BEGIN");
    let order = (await client.query(
      `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_personnel WHERE "clientId" = $1`,
      [block.id])).rows[0].n;

    for (const g of guards) {
      if (already.has(g.id)) { skipped++; continue; }
      const { rows } = await client.query(
        `INSERT INTO mdr_personnel ("reportId","clientId","employeeId","guardName",rank,"licenceNo","licenceExpiry","sortOrder")
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8) RETURNING id`,
        [report.id, block.id, g.id, str(g.fullName), rankFor(g.position),
         str(g.lespNo), g.lespExpiry || null, order++]
      );
      added++;
      let fo = 0;
      for (const f of faByEmployee.get(g.id) || []) {
        // "Make" is the make; "Kind" is the calibre — the same reading the DDO
        // takes of its MAKE CALIBER column.
        await client.query(
          `INSERT INTO mdr_firearms ("reportId","personnelId","assetId",make,kind,"serialNo","licenceExpiry","sortOrder")
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)`,
          [report.id, rows[0].id, f.assetId,
           str(f.brand) || str(f.name) || str(f.model),
           str(f.caliber) || str(f.name), str(f.serialNumber), f.licenceExpiry || null, fo++]
        );
        firearmsAdded++;
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await touch(report.id, req.user.username);
  res.json({ added, firearmsAdded, skipped, site, window: { from, to } });
}));

router.post("/mdr/:id/personnel", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  const clientId = Number(b.clientId);
  const block = (await pool.query(
    `SELECT id FROM mdr_clients WHERE id = $1 AND "reportId" = $2`, [clientId, report.id])).rows[0];
  if (!block) return res.status(400).json({ error: "That client block does not belong to this return." });

  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_personnel WHERE "clientId" = $1`, [clientId]
  )).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO mdr_personnel ("reportId","clientId","employeeId","guardName",rank,"licenceNo","licenceExpiry","sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8) RETURNING id`,
    [report.id, clientId, b.employeeId ? Number(b.employeeId) : null,
     str(b.guardName), str(b.rank) || "SG", str(b.licenceNo), dateOrNull(b.licenceExpiry), next]
  );
  await touch(report.id, req.user.username);
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/mdr/personnel/:pid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_personnel", req.params.pid);
  if (!report) return res.status(404).json({ error: "Personnel row not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  await pool.query(
    `UPDATE mdr_personnel SET
       "guardName"     = COALESCE($1, "guardName"),
       rank            = COALESCE($2, rank),
       "licenceNo"     = COALESCE($3, "licenceNo"),
       "licenceExpiry" = CASE WHEN $4::text IS NULL THEN "licenceExpiry" ELSE NULLIF($4,'')::date END,
       "clientId"      = COALESCE($5, "clientId"),
       "sortOrder"     = COALESCE($6, "sortOrder")
     WHERE id = $7`,
    [patchField(b, "guardName"), patchField(b, "rank"), patchField(b, "licenceNo"),
     patchField(b, "licenceExpiry"),
     b.clientId === undefined ? null : Number(b.clientId),
     b.sortOrder === undefined ? null : Number(b.sortOrder), req.params.pid]
  );
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

router.delete("/mdr/personnel/:pid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_personnel", req.params.pid);
  if (!report) return res.status(404).json({ error: "Personnel row not found." });
  if (!assertDraft(report, res)) return;
  await pool.query(`DELETE FROM mdr_personnel WHERE id = $1`, [req.params.pid]);
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Section 2 — firearms (a child of a personnel row, since a guard may hold
// more than one)
// ---------------------------------------------------------------------------

router.post("/mdr/personnel/:pid/firearms", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_personnel", req.params.pid);
  if (!report) return res.status(404).json({ error: "Personnel row not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};

  // Picking a registered firearm fills all four particulars from the register.
  let make = str(b.make), kind = str(b.kind), serialNo = str(b.serialNo), expiry = dateOrNull(b.licenceExpiry);
  const assetId = b.assetId ? Number(b.assetId) : null;
  if (assetId) {
    const a = (await pool.query(
      `SELECT brand, name, model, caliber, "serialNumber", to_char("licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry"
       FROM assets WHERE id = $1`, [assetId])).rows[0];
    if (a) {
      make = make || str(a.brand) || str(a.name) || str(a.model);
      kind = kind || str(a.caliber) || str(a.name);
      serialNo = serialNo || str(a.serialNumber);
      expiry = expiry || a.licenceExpiry || null;
    }
  }

  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_firearms WHERE "personnelId" = $1`, [req.params.pid]
  )).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO mdr_firearms ("reportId","personnelId","assetId",make,kind,"serialNo","licenceExpiry","firearmClass","sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9) RETURNING id`,
    [report.id, req.params.pid, assetId, make, kind, serialNo, expiry,
     ["Small Arms", "Light Weapons"].includes(str(b.firearmClass)) ? str(b.firearmClass) : "", next]
  );
  await touch(report.id, req.user.username);
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/mdr/firearms/:fid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_firearms", req.params.fid);
  if (!report) return res.status(404).json({ error: "Firearm row not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  const cls = patchField(b, "firearmClass");
  if (cls !== null && !["", "Small Arms", "Light Weapons"].includes(cls)) {
    return res.status(400).json({ error: "Firearm class must be Small Arms or Light Weapons." });
  }
  await pool.query(
    `UPDATE mdr_firearms SET
       make            = COALESCE($1, make),
       kind            = COALESCE($2, kind),
       "serialNo"      = COALESCE($3, "serialNo"),
       "licenceExpiry" = CASE WHEN $4::text IS NULL THEN "licenceExpiry" ELSE NULLIF($4,'')::date END,
       "firearmClass"  = COALESCE($5, "firearmClass"),
       "sortOrder"     = COALESCE($6, "sortOrder")
     WHERE id = $7`,
    [patchField(b, "make"), patchField(b, "kind"), patchField(b, "serialNo"),
     patchField(b, "licenceExpiry"), cls,
     b.sortOrder === undefined ? null : Number(b.sortOrder), req.params.fid]
  );
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

router.delete("/mdr/firearms/:fid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_firearms", req.params.fid);
  if (!report) return res.status(404).json({ error: "Firearm row not found." });
  if (!assertDraft(report, res)) return;
  await pool.query(`DELETE FROM mdr_firearms WHERE id = $1`, [req.params.fid]);
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Section 4 — officers
// ---------------------------------------------------------------------------

router.post("/mdr/:id/officers", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_officers WHERE "reportId" = $1`, [report.id]
  )).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO mdr_officers ("reportId",name,designation,"homeAddress","contactNumbers","sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [report.id, str(b.name), str(b.designation), str(b.homeAddress), str(b.contactNumbers), next]
  );
  await touch(report.id, req.user.username);
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/mdr/officers/:oid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_officers", req.params.oid);
  if (!report) return res.status(404).json({ error: "Officer row not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  await pool.query(
    `UPDATE mdr_officers SET
       name             = COALESCE($1, name),
       designation      = COALESCE($2, designation),
       "homeAddress"    = COALESCE($3, "homeAddress"),
       "contactNumbers" = COALESCE($4, "contactNumbers"),
       "sortOrder"      = COALESCE($5, "sortOrder")
     WHERE id = $6`,
    [patchField(b, "name"), patchField(b, "designation"), patchField(b, "homeAddress"),
     patchField(b, "contactNumbers"),
     b.sortOrder === undefined ? null : Number(b.sortOrder), req.params.oid]
  );
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

router.delete("/mdr/officers/:oid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_officers", req.params.oid);
  if (!report) return res.status(404).json({ error: "Officer row not found." });
  if (!assertDraft(report, res)) return;
  await pool.query(`DELETE FROM mdr_officers WHERE id = $1`, [req.params.oid]);
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Section 5 — gains and losses
// ---------------------------------------------------------------------------

router.post("/mdr/:id/movements", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  const kind = str(b.kind);
  if (!["Gain", "Loss"].includes(kind)) {
    return res.status(400).json({ error: "A movement must be a Gain or a Loss." });
  }
  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS n FROM mdr_movements WHERE "reportId" = $1 AND kind = $2`,
    [report.id, kind])).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO mdr_movements ("reportId",kind,"guardName","postingPlace","effectiveDate",cause,"sortOrder")
     VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING id`,
    [report.id, kind, str(b.guardName), str(b.postingPlace), dateOrNull(b.effectiveDate), str(b.cause), next]
  );
  await touch(report.id, req.user.username);
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/mdr/movements/:mid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_movements", req.params.mid);
  if (!report) return res.status(404).json({ error: "Movement row not found." });
  if (!assertDraft(report, res)) return;
  const b = req.body || {};
  await pool.query(
    `UPDATE mdr_movements SET
       "guardName"     = COALESCE($1, "guardName"),
       "postingPlace"  = COALESCE($2, "postingPlace"),
       "effectiveDate" = CASE WHEN $3::text IS NULL THEN "effectiveDate" ELSE NULLIF($3,'')::date END,
       cause           = COALESCE($4, cause),
       "sortOrder"     = COALESCE($5, "sortOrder")
     WHERE id = $6`,
    [patchField(b, "guardName"), patchField(b, "postingPlace"), patchField(b, "effectiveDate"),
     patchField(b, "cause"),
     b.sortOrder === undefined ? null : Number(b.sortOrder), req.params.mid]
  );
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

router.delete("/mdr/movements/:mid", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const report = await parentOf("mdr_movements", req.params.mid);
  if (!report) return res.status(404).json({ error: "Movement row not found." });
  if (!assertDraft(report, res)) return;
  await pool.query(`DELETE FROM mdr_movements WHERE id = $1`, [req.params.mid]);
  await touch(report.id, req.user.username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const MUTE = "#555";
const slug = (s) => String(s || "mdr").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

// A FINALISED return prints its own snapshot; a draft previews the live
// settings, so what you check before finalising is what gets frozen. Same rule
// the DDO follows for its boilerplate.
async function letterheadFor(report) {
  const s = (await pool.query(
    `SELECT "companyName", "logoData", "agencyAddress", "agencyEmail", "agencyMobile",
            "agencyLtoNo", to_char("agencyLtoExpiry",'YYYY-MM-DD') AS "agencyLtoExpiry",
            "agencyContactPerson", "agencyContactMobile"
     FROM app_settings WHERE id = 1`)).rows[0] || {};
  const snap = report.letterheadJson || null;
  const pick = (k, live) => (snap && snap[k] !== undefined && snap[k] !== null ? snap[k] : live);
  return {
    // The logo is never snapshotted — storing a copy of the image per return
    // would bloat the table for a mark that does not change. It is always read
    // live, which is the one deliberate exception to the freeze.
    logoBuf: s.logoData || null,
    companyName: String(pick("companyName", s.companyName) || "").toUpperCase(),
    address: pick("agencyAddress", s.agencyAddress) || "",
    ltoNo: pick("agencyLtoNo", s.agencyLtoNo) || "",
    ltoExpiry: pick("agencyLtoExpiry", s.agencyLtoExpiry) || "",
    contactPerson: pick("agencyContactPerson", s.agencyContactPerson) || "",
    contactMobile: pick("agencyContactMobile", s.agencyContactMobile) || s.agencyMobile || "",
    email: pick("agencyEmail", s.agencyEmail) || "",
  };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  const p = String(iso || "").slice(0, 10).split("-").map(Number);
  if (!p[0] || !p[1] || !p[2]) return "";
  return `${MONTH_NAMES[p[1] - 1]} ${p[2]}, ${p[0]}`;
}

// A4 landscape: section 2 is eleven columns and will not fit portrait.
router.get("/mdr/:id/mdr.pdf", requireAuth, wrap(async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Monthly Disposition Report not found." });

  const parts = await loadParts(report.id);
  const { clients, personnel, firearms, officers, movements } = parts;
  const nums = numbering(clients, personnel);
  const byPersonnel = firearmsByPersonnel(firearms);
  const s1 = firearmsByProvince(clients, personnel, firearms);
  const s3 = recapitulation(clients, personnel, firearms);
  const lh = await letterheadFor(report);
  const month = monthPhrases(report.periodMonth);

  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 28 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition",
    `attachment; filename="MDR-${slug(report.region)}-${slug(month.file || report.periodMonth)}.pdf"`);
  doc.pipe(res);

  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const BOTTOM = doc.page.height - 46;   // leaves room for the stamped footer
  let y = 0;

  const text = (t, x, yy, o = {}) => doc.text(String(t === null || t === undefined ? "" : t), x, yy, o);
  const rule = (yy, x1 = L, x2 = R, colour = "#000") =>
    doc.moveTo(x1, yy).lineTo(x2, yy).lineWidth(0.5).strokeColor(colour).stroke();

  // ---- letterhead ---------------------------------------------------------
  function letterheadBlock() {
    y = 30;
    if (lh.logoBuf) { try { doc.image(lh.logoBuf, L + 4, y, { fit: [52, 52] }); } catch { /* unreadable logo */ } }
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
    text(lh.companyName, L, y + 2, { width: W, align: "center" });
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTE);
    let ly = y + 19;
    for (const line of [
      lh.address,
      lh.ltoNo ? `License to Operate No. ${lh.ltoNo}` : "",
      lh.ltoExpiry ? `Expire on ${longDate(lh.ltoExpiry)}` : "",
      lh.contactPerson ? `Contact Person: ${lh.contactPerson}${lh.contactMobile ? ` - ${lh.contactMobile}` : ""}`
        : (lh.contactMobile ? `Contact No. ${lh.contactMobile}` : ""),
      lh.email ? `Email Address: ${lh.email}` : "",
    ].filter(Boolean)) {
      text(line, L, ly, { width: W, align: "center" });
      ly += 9.5;
    }
    y = ly + 4;
    rule(y);
    y += 8;
    doc.fillColor("#000");
  }

  // Every page break re-stamps the letterhead, because a page of a return that
  // reaches an inspector on its own must still identify the agency.
  function newPage() {
    doc.addPage({ size: "A4", layout: "landscape", margin: 28 });
    letterheadBlock();
  }
  const room = (need) => { if (y + need > BOTTOM) { newPage(); return true; } return false; };

  letterheadBlock();

  // ---- addressee, subject, date -------------------------------------------
  doc.font("Helvetica-Bold").fontSize(8);
  text("TO:", L, y);
  doc.font("Helvetica"); text(report.addressee || "", L + 32, y);
  y += 11;
  if (report.attention) { text(report.attention, L + 32, y); y += 11; }
  y += 4;
  doc.font("Helvetica-Bold"); text("Subject:", L, y);
  doc.font("Helvetica");
  text(subjectLine(report.region, report.periodMonth), L + 50, y, { width: W - 50 });
  y += 12;
  doc.font("Helvetica-Bold"); text("Date:", L, y);
  doc.font("Helvetica"); text(longDate(report.reportDate), L + 50, y);
  y += 17;

  text(`Submitted hereunder is the disposition of our Client/s, Guards and Firearms in the ${report.region} for the month of ${month.body}.`,
    L, y, { width: W });
  y += 20;

  // ---- 1 -------------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(8.5);
  text("1. Number of Firearms Deployed in Provinces:", L, y);
  y += 14;
  const C1 = [L, L + 210, L + 350];
  doc.fontSize(7.5);
  text("Province", C1[0] + 3, y); text("Small Arms", C1[1] + 3, y); text("Light Weapons", C1[2] + 3, y);
  y += 11; rule(y, L, L + 490); y += 3;
  doc.font("Helvetica");
  for (const r of s1.rows) {
    text(r.province, C1[0] + 3, y);
    text(r.smallArms || "", C1[1] + 3, y);
    text(r.lightWeapons || "", C1[2] + 3, y);
    y += 11;
  }
  if (!s1.rows.length) { doc.fillColor(MUTE); text("No firearms reported.", C1[0] + 3, y); doc.fillColor("#000"); y += 11; }
  doc.font("Helvetica-Bold");
  text("TOTAL", C1[0] + 3, y);
  text(s1.total.smallArms, C1[1] + 3, y);
  text(s1.total.lightWeapons, C1[2] + 3, y);
  y += 20;

  // ---- 2 -------------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(8.5);
  text("2. Disposition of Clients, Guards and Firearms:", L, y);
  y += 14;

  // Widths total 767 against 786 of usable width. Sized so the widest real
  // values from the source return — "Meregildo Alfredo Jr. Besorio",
  // "R03-202501000866" — fit on one line: a licence number split across two
  // lines is two half numbers.
  const COLS = [
    ["Client / Address", 128], ["No.", 20], ["No.", 20], ["Rank", 26],
    ["Name of Security Guard", 140], ["Licence Number", 94], ["Expiry Date", 58],
    ["Make", 48], ["Kind", 38], ["Serial Number", 80], ["Expiry Date", 58],
  ];
  const X = [];
  { let acc = L; for (const [, w] of COLS) { X.push(acc); acc += w; } }
  const TABLE_R = X[10] + COLS[10][1];
  const ROW_H = 11.5;

  function section2Header() {
    doc.font("Helvetica-Bold");
    rule(y, L, TABLE_R);
    doc.fontSize(5.6);
    // "Firearms Issued" spans Make + Kind, as the source sheet does.
    text("Firearms Issued", X[7], y + 1.5, { width: COLS[7][1] + COLS[8][1], align: "center" });
    doc.fontSize(6.2);
    // Columns 0 (client), 4 (guard name) and 5 (licence number) print their
    // values left-aligned, so their HEADERS must be left-aligned too — a
    // centred header over a left-aligned column reads as a misprint.
    const LEFT = new Set([0, 4, 5]);
    COLS.forEach(([label, w], i) => {
      const mid = i >= 7 && i <= 8;
      text(label, X[i] + (mid ? 0 : 2), y + (mid ? 8 : 4),
        { width: w - (mid ? 0 : 4), align: LEFT.has(i) ? "left" : "center" });
    });
    y += 18;
    rule(y, L, TABLE_R);
    y += 2;
    doc.font("Helvetica").fontSize(6.4);
  }
  section2Header();

  if (!clients.length) {
    doc.fillColor(MUTE); text("No clients reported.", L + 3, y); doc.fillColor("#000"); y += ROW_H;
  }

  for (const c of clients) {
    const mine = personnel.filter((p) => p.clientId === c.id)
      .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
    // The client cell is written once per page-run, mimicking the source
    // sheet's vertically merged cell.
    let needsClientCell = true;
    const rows = mine.length ? mine : [null];
    for (const p of rows) {
      const fas = p ? (byPersonnel.get(p.id) || [null]) : [null];
      for (let k = 0; k < fas.length; k++) {
        if (room(ROW_H + 4)) { section2Header(); needsClientCell = true; }
        if (needsClientCell) {
          doc.font("Helvetica-Bold").fontSize(5.9);
          text([c.clientName, c.clientAddress].filter(Boolean).join(" "),
            X[0] + 2, y, { width: COLS[0][1] - 4 });
          doc.font("Helvetica").fontSize(6.4);
          needsClientCell = false;
        }
        if (p && k === 0) {
          const n = nums.get(p.id) || {};
          text(n.runningNo, X[1], y, { width: COLS[1][1], align: "center" });
          text(n.lineNo, X[2], y, { width: COLS[2][1], align: "center" });
          text(p.rank, X[3], y, { width: COLS[3][1], align: "center" });
          text(p.guardName, X[4] + 2, y, { width: COLS[4][1] - 4, height: ROW_H, ellipsis: true });
          text(p.licenceNo, X[5] + 2, y, { width: COLS[5][1] - 4, height: ROW_H, ellipsis: true });
          text(p.licenceExpiry || "", X[6], y, { width: COLS[6][1], align: "center" });
        }
        const f = fas[k];
        if (f) {
          text(f.make, X[7], y, { width: COLS[7][1], align: "center", height: ROW_H, ellipsis: true });
          text(f.kind, X[8], y, { width: COLS[8][1], align: "center", height: ROW_H, ellipsis: true });
          text(f.serialNo, X[9], y, { width: COLS[9][1], align: "center", height: ROW_H, ellipsis: true });
          text(f.licenceExpiry || "", X[10], y, { width: COLS[10][1], align: "center" });
        }
        y += ROW_H;
      }
    }
    rule(y, L, TABLE_R, "#BBB");
    y += 2;
  }
  y += 12;

  // ---- 3 -------------------------------------------------------------------
  room(24 + s3.rows.length * 11 + 30);
  doc.font("Helvetica-Bold").fontSize(8.5);
  text("3. Recapitulation", L, y);
  y += 14;
  const CW = 84;
  const RX = L + 150;
  doc.fontSize(7.5);
  text("Deployed", L + 3, y);
  s3.provinces.forEach((p, i) => text(p.toUpperCase(), RX + i * CW, y, { width: CW, align: "center" }));
  text("TOTAL", RX + s3.provinces.length * CW, y, { width: CW, align: "center" });
  y += 11;
  rule(y, L, RX + (s3.provinces.length + 1) * CW);
  y += 3;
  for (const r of s3.rows) {
    doc.font("Helvetica");
    text(r.label, L + 3, y);
    s3.provinces.forEach((p, i) => text(r.byProvince[p], RX + i * CW, y, { width: CW, align: "center" }));
    doc.font("Helvetica-Bold");
    text(r.total, RX + s3.provinces.length * CW, y, { width: CW, align: "center" });
    y += 11;
  }
  y += 18;

  // ---- 4 -------------------------------------------------------------------
  room(40 + Math.max(officers.length, 1) * 11);
  doc.font("Helvetica-Bold").fontSize(8.5);
  text("4. List of officers and their respective designation", L, y);
  y += 14;
  const OC = [["NO.", 30], ["NAME OF OFFICERS & STAFF", 200], ["DESIGNATION", 140], ["HOME ADDRESS", 190], ["CONTACT NUMBERS", 120]];
  const OX = [];
  { let acc = L; for (const [, w] of OC) { OX.push(acc); acc += w; } }
  const OR = OX[4] + OC[4][1];
  doc.fontSize(6.5);
  OC.forEach(([l, w], i) => text(l, OX[i] + 2, y, { width: w - 4, align: i === 0 ? "center" : "left" }));
  y += 10; rule(y, L, OR); y += 3;
  doc.font("Helvetica");
  officers.forEach((o, i) => {
    room(ROW_H);
    text(i + 1, OX[0], y, { width: OC[0][1], align: "center" });
    text(o.name, OX[1] + 2, y, { width: OC[1][1] - 4, height: ROW_H, ellipsis: true });
    text(o.designation, OX[2] + 2, y, { width: OC[2][1] - 4, height: ROW_H, ellipsis: true });
    text(o.homeAddress, OX[3] + 2, y, { width: OC[3][1] - 4, height: ROW_H, ellipsis: true });
    text(o.contactNumbers, OX[4] + 2, y, { width: OC[4][1] - 4, height: ROW_H, ellipsis: true });
    y += 11;
  });
  if (!officers.length) { doc.fillColor(MUTE); text("None listed.", OX[1] + 2, y); doc.fillColor("#000"); y += 11; }
  y += 18;

  // ---- 5 -------------------------------------------------------------------
  room(60);
  doc.font("Helvetica-Bold").fontSize(8.5);
  text("5. GAINS AND LOSSES:", L, y);
  y += 14;

  const GC = [["NO.", 30], ["NAME OF GUARDS", 190], [null, 170], [null, 120], [null, 200]];
  const GX = [];
  { let acc = L; for (const [, w] of GC) { GX.push(acc); acc += w; } }
  const GR = GX[4] + GC[4][1];

  // The two halves differ only in their column LABELS. The source sheet gives
  // the GAIN table the LOSSES headers; a gain reads correctly here instead.
  for (const [title, rows, placeLabel, dateLabel, causeLabel] of [
    ["A. GAIN", movements.filter((m) => m.kind === "Gain"), "POSTING PLACE", "DATE HIRED / DEPLOYED", "REMARKS"],
    ["B. LOSSES", movements.filter((m) => m.kind === "Loss"), "LAST POSTING PLACE", "DATE TERMINATED", "CAUSE(S) OF TERMINATION"],
  ]) {
    room(46);
    doc.font("Helvetica-Bold").fontSize(7.5);
    text(title, L, y);
    y += 11;
    doc.fontSize(6.5);
    const labels = [GC[0][0], GC[1][0], placeLabel, dateLabel, causeLabel];
    labels.forEach((l, i) => text(l, GX[i] + 2, y, { width: GC[i][1] - 4, align: i === 0 ? "center" : "left" }));
    y += 10; rule(y, L, GR); y += 3;
    doc.font("Helvetica");
    // The paper form carries numbered blank lines, so an empty table still
    // prints rows to write on.
    const count = Math.max(rows.length, 3);
    for (let i = 0; i < count; i++) {
      room(ROW_H);
      const m = rows[i];
      text(i + 1, GX[0], y, { width: GC[0][1], align: "center" });
      if (m) {
        text(m.guardName, GX[1] + 2, y, { width: GC[1][1] - 4, height: ROW_H, ellipsis: true });
        text(m.postingPlace, GX[2] + 2, y, { width: GC[2][1] - 4, height: ROW_H, ellipsis: true });
        text(m.effectiveDate || "", GX[3] + 2, y, { width: GC[3][1] - 4 });
        text(m.cause, GX[4] + 2, y, { width: GC[4][1] - 4, height: ROW_H, ellipsis: true });
      }
      y += 10.5;
    }
    y += 12;
  }

  // ---- certification + signatures -----------------------------------------
  room(96);
  doc.font("Helvetica").fontSize(8);
  text(report.certificationText || certificationLine(report.periodMonth), L, y, { width: W });
  y += 28;
  const SIG2 = L + 440;
  text("Prepared by:", L, y);
  text("Noted by:", SIG2, y);
  y += 34;
  doc.font("Helvetica-Bold").fontSize(8.5);
  text((report.preparedByName || "").toUpperCase(), L, y, { width: 300 });
  text((report.notedByName || "").toUpperCase(), SIG2, y, { width: 300 });
  y += 11;
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTE);
  text(report.preparedByPosition || "", L, y, { width: 300 });
  text(report.notedByPosition || "", SIG2, y, { width: 300 });

  // A draft must never be mistaken for a filing. Watermarked on every page.
  //
  // Deliberately plain ASCII. An em-dash IS in WinAnsi, but it lands in the
  // 0x80-0x9F range where WinAnsi and Latin-1 disagree, so it cannot be
  // verified by extracting the page's bytes — and a watermark gains nothing
  // from typography. See the pdfMoney.js note for the general rule.
  if (report.status === "Draft") {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font("Helvetica-Bold").fontSize(60).fillColor("#000").opacity(0.07)
        .text("DRAFT - NOT FILED", 0, doc.page.height / 2 - 38, { width: doc.page.width, align: "center" })
        .opacity(1).restore();
    }
  }

  // Required on every document: buffered pages, then the footer carrying the
  // CLIENT's company name alongside the author line.
  stampAuthorFooter(doc, lh.companyName);
  doc.end();
}));

module.exports = router;
