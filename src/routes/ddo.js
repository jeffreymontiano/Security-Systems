const express = require("express");
const PDFDocument = require("pdfkit");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { phDateOf } = require("../lib/phTime");
const {
  nextDdoNo, periodPhrase, longDateUpper, militaryShift,
  orderState, daysRemaining, defaultWindow, conflicts, rankFor,
} = require("../lib/ddoHelpers");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler — it
// escapes to the process, which then answers nothing.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[ddo]", e);
  if (!res.headersSent) res.status(500).json({ error: e.message || "The duty detail order request failed." });
});

const today = () => phDateOf(Date.now());
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

// ---------------------------------------------------------------------------
// Form text — the admin-editable boilerplate
// ---------------------------------------------------------------------------

async function loadConfig(db = pool) {
  return (await db.query(`SELECT * FROM ddo_config WHERE id = 1`)).rows[0] || {};
}

router.get("/config", requireAuth, wrap(async (req, res) => {
  res.json(await loadConfig());
}));

router.put("/config", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const b = req.body || {};
  const cur = await loadConfig();
  // Lettered lists are stored as JSON so a new issuance can add or drop a
  // clause without a migration.
  const list = (v, fallback) => {
    if (!Array.isArray(v)) return JSON.stringify(fallback || []);
    return JSON.stringify(v
      .filter((x) => x && str(x.text))
      .map((x) => ({ letter: str(x.letter), text: str(x.text) })));
  };
  await pool.query(
    `UPDATE ddo_config SET
       "formVersion" = $1, "defaultPurpose" = $2,
       "referencesJson" = $3::jsonb, "instructionsJson" = $4::jsonb,
       "assignmentStatement" = $5, "closingLine" = $6, "authorityLine" = $7,
       "validityDays" = $8, "updatedBy" = $9, "updatedAt" = now()
     WHERE id = 1`,
    [str(b.formVersion) || cur.formVersion, str(b.defaultPurpose) || cur.defaultPurpose,
     list(b.references, cur.referencesJson), list(b.instructions, cur.instructionsJson),
     str(b.assignmentStatement) || cur.assignmentStatement,
     str(b.closingLine) || cur.closingLine, str(b.authorityLine) || cur.authorityLine,
     Math.max(1, Number(b.validityDays) || cur.validityDays || 30), req.user.username]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Firearms available to a DDO — drawn from the asset register, not typed
// ---------------------------------------------------------------------------

// Anything classified under a firearms CATEGORY. Matched on the category name
// rather than a hardcoded id, because the taxonomy is admin-maintainable and
// an agency may name the category differently.
const FIREARM_CATEGORY_SQL = `
  a."categoryId" IN (SELECT id FROM asset_categories WHERE name ILIKE '%firearm%')
`;

router.get("/firearms", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.id, a."assetTag", a.name, a."serialNumber", a.caliber, a."licenceNo",
           to_char(a."licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry",
           a.status, a.condition, a.site, a."categoryName", a."subcategoryName"
    FROM assets a
    WHERE ${FIREARM_CATEGORY_SQL} AND a.status NOT IN ('Retired','Lost')
    ORDER BY a."assetTag"
  `);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const ORDER_SELECT = `
  SELECT o.*,
         to_char(o."orderDate",'YYYY-MM-DD') AS "orderDate",
         to_char(o."fromDate",'YYYY-MM-DD')  AS "fromDate",
         to_char(o."toDate",'YYYY-MM-DD')    AS "toDate",
         to_char(o."issuedAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "issuedAt",
         (SELECT COUNT(*)::int FROM ddo_lines l WHERE l."orderId" = o.id) AS "lineCount",
         (SELECT COUNT(*)::int FROM ddo_lines l WHERE l."orderId" = o.id AND l."firearmSerial" <> '') AS "armedCount"
  FROM ddo_orders o
`;

const withState = (o) => ({
  ...o,
  state: orderState(o, today()),
  daysRemaining: o.status === "Issued" ? daysRemaining(o, today()) : null,
});

router.get("/orders", requireAuth, wrap(async (req, res) => {
  const vals = [];
  const clauses = [];
  if (req.query.site) { vals.push(req.query.site); clauses.push(`o.site = $${vals.length}`); }
  if (req.query.status) { vals.push(req.query.status); clauses.push(`o.status = $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `${ORDER_SELECT} ${where} ORDER BY o."orderDate" DESC, o.id DESC`, vals
  );
  res.json(rows.map(withState));
}));

async function loadLines(orderId) {
  return (await pool.query(
    `SELECT l.*, to_char(l."firearmLicenceExpiry",'YYYY-MM-DD') AS "firearmLicenceExpiry",
            e."employmentStatus", a.status AS "assetStatus"
     FROM ddo_lines l
     LEFT JOIN employees e ON e.id = l."employeeId"
     LEFT JOIN assets a ON a.id = l."assetId"
     WHERE l."orderId" = $1
     ORDER BY l."sortOrder", l.id`, [orderId]
  )).rows;
}

// Firearms authorised on some OTHER live order — a serial cannot be at two
// posts at once, and finding that out at a PNP inspection is too late.
async function otherIssuedFirearms(orderId) {
  return (await pool.query(
    `SELECT l."firearmSerial", o.site, o."ddoNo"
     FROM ddo_lines l JOIN ddo_orders o ON o.id = l."orderId"
     WHERE o.id <> $1 AND o.status = 'Issued' AND o."toDate" >= $2::date
       AND l."firearmSerial" <> ''`, [orderId, today()]
  )).rows;
}

router.get("/orders/:id", requireAuth, wrap(async (req, res) => {
  const order = (await pool.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id])).rows[0];
  if (!order) return res.status(404).json({ error: "Duty detail order not found." });
  const lines = await loadLines(order.id);
  res.json({
    order: withState(order),
    lines,
    conflicts: conflicts(lines, { otherIssued: await otherIssuedFirearms(order.id) }),
    blockers: issueBlockers(lines),
  });
}));

// Reasons this order must not be issued. A DDO authorises a named person to
// bear a named firearm — it must not name someone who has left, or something
// the agency has written off.
function issueBlockers(lines) {
  const out = [];
  if (!lines.length) out.push({ message: "The order has no security personnel listed." });
  for (const l of lines) {
    if (l.employeeId && l.employmentStatus && l.employmentStatus !== "Active") {
      out.push({ lineId: l.id, message: `${l.guardName} is ${l.employmentStatus} and cannot be detailed.` });
    }
    if (l.assetId && ["Retired", "Lost"].includes(l.assetStatus)) {
      out.push({ lineId: l.id, message: `The firearm on ${l.guardName}'s line is marked ${l.assetStatus}.` });
    }
    if (!str(l.placeOfDuty)) {
      out.push({ lineId: l.id, message: `${l.guardName} has no place of duty.` });
    }
  }
  return out;
}

router.post("/orders", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const site = str(b.site);
  if (!site) return res.status(400).json({ error: "A post (site) is required." });
  const orderDate = str(b.orderDate) || today();
  const cfg = await loadConfig();
  const win = defaultWindow(orderDate, cfg.validityDays || 30);
  const { rows } = await pool.query(
    `INSERT INTO ddo_orders (site, "orderDate", "fromDate", "toDate", purpose, notes, "createdBy")
     VALUES ($1,$2::date,$3::date,$4::date,$5,$6,$7) RETURNING id`,
    [site, orderDate, str(b.fromDate) || win.fromDate, str(b.toDate) || win.toDate,
     str(b.purpose) || cfg.defaultPurpose || "Post Security Services Duties",
     str(b.notes), req.user.username]
  );
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/orders/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const order = (await pool.query(`SELECT * FROM ddo_orders WHERE id = $1`, [req.params.id])).rows[0];
  if (!order) return res.status(404).json({ error: "Duty detail order not found." });
  if (order.status === "Issued") {
    return res.status(400).json({ error: "An issued order is locked. Cancel it and raise a new one if the detail changed." });
  }
  await pool.query(
    `UPDATE ddo_orders SET
       site = COALESCE($1, site),
       "orderDate" = COALESCE($2::date, "orderDate"),
       "fromDate" = COALESCE($3::date, "fromDate"),
       "toDate" = COALESCE($4::date, "toDate"),
       purpose = COALESCE($5, purpose),
       notes = COALESCE($6, notes),
       "updatedAt" = now()
     WHERE id = $7`,
    [str(b.site) || null, str(b.orderDate) || null, str(b.fromDate) || null,
     str(b.toDate) || null, b.purpose ?? null, b.notes ?? null, req.params.id]
  );
  res.json({ ok: true });
}));

router.delete("/orders/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM ddo_orders WHERE id = $1 AND status <> 'Issued'`, [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "An issued order cannot be deleted. Cancel it instead — the record of what was authorised is evidence." });
  res.json({ ok: true });
}));

// Issue: assigns the number and freezes the wording.
router.patch("/orders/:id/issue", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const order = (await pool.query(
    `SELECT *, to_char("orderDate",'YYYY-MM-DD') AS "od" FROM ddo_orders WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Duty detail order not found." });
  if (order.status !== "Draft") return res.status(400).json({ error: `This order is ${order.status}. Only a draft can be issued.` });

  const lines = await loadLines(order.id);
  const blockers = issueBlockers(lines);
  if (blockers.length) {
    return res.status(400).json({ error: blockers[0].message, blockers });
  }
  const clashes = conflicts(lines, { otherIssued: await otherIssuedFirearms(order.id) });
  if (clashes.length) {
    return res.status(400).json({ error: clashes[0].message, conflicts: clashes });
  }

  const cfg = await loadConfig();
  const settings = (await pool.query(
    `SELECT "adminHeadName", "adminHeadPosition" FROM app_settings WHERE id = 1`
  )).rows[0] || {};

  // The series is per POST: only this site's numbers are in scope, so two
  // posts each reach 2026-08-001 and a re-issue here becomes 2026-08-002.
  const used = (await pool.query(
    `SELECT "ddoNo" FROM ddo_orders WHERE site = $1 AND "ddoNo" IS NOT NULL`, [order.site]
  )).rows.map((r) => r.ddoNo);
  const ddoNo = order.ddoNo || nextDdoNo(order.od, used);

  await pool.query(
    `UPDATE ddo_orders SET
       status = 'Issued', "ddoNo" = $1,
       "formVersion" = $2, "referencesJson" = $3::jsonb, "instructionsJson" = $4::jsonb,
       "assignmentStatement" = $5, "closingLine" = $6, "authorityLine" = $7,
       "signatoryName" = $8, "signatoryPosition" = $9,
       "issuedBy" = $10, "issuedAt" = now(), "updatedAt" = now()
     WHERE id = $11`,
    [ddoNo, cfg.formVersion || "", JSON.stringify(cfg.referencesJson || []),
     JSON.stringify(cfg.instructionsJson || []), cfg.assignmentStatement || "",
     cfg.closingLine || "", cfg.authorityLine || "",
     settings.adminHeadName || "", settings.adminHeadPosition || "",
     req.user.username, order.id]
  );
  res.json({ ok: true, ddoNo });
}));

// Amend: return an issued order to Draft so it can be corrected, KEEPING its
// number. A DDO with a wrong licence date or serial has to be fixed and
// reissued as the same order — that is what an amendment is — and forcing a
// cancel-and-renumber would leave the post's series full of holes and the
// guard holding a document whose number no longer exists.
//
// Re-issuing re-snapshots the wording, so an amended order prints the text
// current at the moment it actually went out.
router.patch("/orders/:id/amend", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE ddo_orders SET status = 'Draft', "updatedAt" = now()
     WHERE id = $1 AND status = 'Issued'`, [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only an issued order can be amended." });
  res.json({ ok: true });
}));

router.patch("/orders/:id/cancel", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE ddo_orders SET status = 'Cancelled', notes = COALESCE($1, notes), "updatedAt" = now()
     WHERE id = $2 AND status = 'Issued'`,
    [req.body?.reason ? `Cancelled: ${str(req.body.reason)}` : null, req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Only an issued order can be cancelled." });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

async function assertDraft(orderId, res) {
  const o = (await pool.query(`SELECT status FROM ddo_orders WHERE id = $1`, [orderId])).rows[0];
  if (!o) { res.status(404).json({ error: "Duty detail order not found." }); return null; }
  if (o.status !== "Draft") { res.status(400).json({ error: `This order is ${o.status}. Only a draft can be edited.` }); return null; }
  return o;
}

// Resolve an employee and a firearm into the snapshotted line fields.
// "MAKE CALIBER" on the form names the firearm's make. The register holds that
// as brand + model — "Rock Island Armory (Armsco)" + "STK100" — so the two are
// joined. A firearm recorded only by calibre ("9MM", "SHOTGUN") falls back to
// that field, which is how the source workbook's own entries read.
function makeCalibre(asset) {
  const joined = [asset.brand, asset.model].map((x) => str(x)).filter(Boolean).join(" ");
  return joined || str(asset.caliber) || "";
}

async function resolveLine(b, existing = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {
    employeeId: b.employeeId ?? existing.employeeId ?? null,
    employeeNo: existing.employeeNo || "",
    guardName: str(b.guardName) || existing.guardName || "",
    rank: str(b.rank) || existing.rank || "SG",
    designation: str(b.designation) || existing.designation || "SECURITY GUARD",
    placeOfDuty: b.placeOfDuty !== undefined ? str(b.placeOfDuty) : (existing.placeOfDuty || ""),
    shift: b.shift !== undefined ? str(b.shift) : (existing.shift || ""),
    assetId: b.assetId === null ? null : (b.assetId ?? existing.assetId ?? null),
    firearmCaliber: "", firearmSerial: "", firearmLicenceExpiry: null,
  };

  if (out.employeeId) {
    const e = (await pool.query(
      `SELECT "employeeNo", "fullName", position FROM employees WHERE id = $1`, [out.employeeId]
    )).rows[0];
    if (!e) throw new Error("That employee no longer exists.");
    out.employeeNo = e.employeeNo || "";
    if (!str(b.guardName)) out.guardName = e.fullName;
    if (!str(b.rank)) out.rank = rankFor(e.position);
  }
  if (!out.guardName) throw new Error("A guard is required on every line.");

  // The firearm particulars default from the register, but stay editable on
  // the line. The register is not always complete — a licence expiry may not
  // have been recorded against the asset yet — and a DDO still has to print
  // the correct date. An explicit value in the request therefore wins.
  //
  // Picking a DIFFERENT firearm refreshes all three from that asset, so
  // swapping the weapon cannot leave the previous one's serial behind.
  const assetChanged = String(out.assetId ?? "") !== String(existing.assetId ?? "");
  const fromAssetOr = (key, assetValue) =>
    (has(key) ? undefined : (assetChanged || !existing[key] ? assetValue : existing[key]));

  if (out.assetId) {
    const a = (await pool.query(
      `SELECT "serialNumber", caliber, model, brand,
              to_char("licenceExpiry",'YYYY-MM-DD') AS "licenceExpiry"
       FROM assets WHERE id = $1`, [out.assetId]
    )).rows[0];
    if (!a) throw new Error("That firearm no longer exists in the asset register.");
    out.firearmCaliber = has("firearmCaliber") ? str(b.firearmCaliber) : fromAssetOr("firearmCaliber", makeCalibre(a));
    out.firearmSerial = has("firearmSerial") ? str(b.firearmSerial) : fromAssetOr("firearmSerial", a.serialNumber || "");
    out.firearmLicenceExpiry = has("firearmLicenceExpiry")
      ? (b.firearmLicenceExpiry || null)
      : fromAssetOr("firearmLicenceExpiry", a.licenceExpiry || null);
  } else {
    // Unarmed, or a firearm not (yet) in the register. Keep whatever was typed
    // rather than silently blanking a line someone filled in by hand.
    out.firearmCaliber = has("firearmCaliber") ? str(b.firearmCaliber) : (assetChanged ? "" : existing.firearmCaliber || "");
    out.firearmSerial = has("firearmSerial") ? str(b.firearmSerial) : (assetChanged ? "" : existing.firearmSerial || "");
    out.firearmLicenceExpiry = has("firearmLicenceExpiry")
      ? (b.firearmLicenceExpiry || null)
      : (assetChanged ? null : existing.firearmLicenceExpiry || null);
  }
  return out;
}

router.post("/orders/:id/lines", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  if (!(await assertDraft(req.params.id, res))) return;
  const l = await resolveLine(req.body || {});
  const next = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"),0) + 1 AS n FROM ddo_lines WHERE "orderId" = $1`, [req.params.id]
  )).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO ddo_lines ("orderId","employeeId","employeeNo",rank,"guardName",designation,
       "placeOfDuty",shift,"assetId","firearmCaliber","firearmSerial","firearmLicenceExpiry","sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13) RETURNING id`,
    [req.params.id, l.employeeId, l.employeeNo, l.rank, l.guardName, l.designation,
     l.placeOfDuty, l.shift, l.assetId, l.firearmCaliber, l.firearmSerial,
     l.firearmLicenceExpiry, next]
  );
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/lines/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const existing = (await pool.query(
    `SELECT l.*, to_char(l."firearmLicenceExpiry",'YYYY-MM-DD') AS "firearmLicenceExpiry"
     FROM ddo_lines l WHERE l.id = $1`, [req.params.id]
  )).rows[0];
  if (!existing) return res.status(404).json({ error: "Line not found." });
  if (!(await assertDraft(existing.orderId, res))) return;

  const l = await resolveLine(req.body || {}, existing);
  await pool.query(
    `UPDATE ddo_lines SET "employeeId" = $1, "employeeNo" = $2, rank = $3, "guardName" = $4,
       designation = $5, "placeOfDuty" = $6, shift = $7, "assetId" = $8,
       "firearmCaliber" = $9, "firearmSerial" = $10, "firearmLicenceExpiry" = $11::date
     WHERE id = $12`,
    [l.employeeId, l.employeeNo, l.rank, l.guardName, l.designation, l.placeOfDuty,
     l.shift, l.assetId, l.firearmCaliber, l.firearmSerial, l.firearmLicenceExpiry, req.params.id]
  );
  res.json({ ok: true });
}));

router.delete("/lines/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const existing = (await pool.query(`SELECT "orderId" FROM ddo_lines WHERE id = $1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Line not found." });
  if (!(await assertDraft(existing.orderId, res))) return;
  await pool.query(`DELETE FROM ddo_lines WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Build the duty table from the roster instead of retyping it. Reads the same
// shift_assignments attendance and billing read, so a DDO names the guards the
// roster actually posts at that site over the order's dates.
router.post("/orders/:id/lines/from-roster", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  if (!(await assertDraft(req.params.id, res))) return;
  const order = (await pool.query(
    `SELECT site, to_char("fromDate",'YYYY-MM-DD') AS f, to_char("toDate",'YYYY-MM-DD') AS t
     FROM ddo_orders WHERE id = $1`, [req.params.id]
  )).rows[0];

  // One row per guard and shift pattern — a month of identical night shifts is
  // one line on a DDO, not thirty.
  const rows = (await pool.query(
    `SELECT DISTINCT sa."employeeId", sa."guardName", sa."startTime", sa."endTime",
            e.position, e."employeeNo", e."employmentStatus"
     FROM shift_assignments sa
     LEFT JOIN employees e ON e.id = sa."employeeId"
     WHERE sa.site = $1 AND sa."dutyDate" >= $2::date AND sa."dutyDate" <= $3::date
     ORDER BY sa."guardName", sa."startTime"`,
    [order.site, order.f, order.t]
  )).rows;

  const existing = (await pool.query(
    `SELECT "guardName", shift FROM ddo_lines WHERE "orderId" = $1`, [req.params.id]
  )).rows.map((r) => `${r.guardName.toLowerCase()}|${r.shift}`);

  let added = 0, skipped = 0;
  let sort = (await pool.query(
    `SELECT COALESCE(MAX("sortOrder"),0) AS n FROM ddo_lines WHERE "orderId" = $1`, [req.params.id]
  )).rows[0].n;

  for (const r of rows) {
    if (r.employmentStatus && r.employmentStatus !== "Active") { skipped++; continue; }
    const shift = militaryShift(r.startTime, r.endTime);
    if (existing.includes(`${(r.guardName || "").toLowerCase()}|${shift}`)) { skipped++; continue; }
    sort++;
    await pool.query(
      `INSERT INTO ddo_lines ("orderId","employeeId","employeeNo",rank,"guardName",designation,
         "placeOfDuty",shift,"sortOrder")
       VALUES ($1,$2,$3,$4,$5,'SECURITY GUARD',$6,$7,$8)`,
      [req.params.id, r.employeeId, r.employeeNo || "", rankFor(r.position),
       r.guardName, order.site, shift, sort]
    );
    existing.push(`${(r.guardName || "").toLowerCase()}|${shift}`);
    added++;
  }
  res.json({ ok: true, added, skipped });
}));

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85", RULE = "#B9C4D4";
const slug = (s) => (s || "ddo").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function letterhead() {
  const s = (await pool.query(
    `SELECT "companyName", "logoData", "agencyEmail", "agencyMobile", "agencyLtoNo",
            "adminHeadName", "adminHeadPosition" FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  return {
    companyName: (s.companyName || "").toUpperCase(),
    logoBuf: s.logoData || null,
    email: s.agencyEmail || "",
    mobile: s.agencyMobile || "",
    ltoNo: s.agencyLtoNo || "",
    adminHeadName: s.adminHeadName || "",
    adminHeadPosition: s.adminHeadPosition || "",
  };
}

router.get("/orders/:id/ddo.pdf", requireAuth, wrap(async (req, res) => {
  const order = (await pool.query(
    `SELECT o.*, to_char(o."orderDate",'YYYY-MM-DD') AS "orderDate",
            to_char(o."fromDate",'YYYY-MM-DD') AS "fromDate",
            to_char(o."toDate",'YYYY-MM-DD') AS "toDate"
     FROM ddo_orders o WHERE o.id = $1`, [req.params.id]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Duty detail order not found." });
  const lines = await loadLines(order.id);
  const lh = await letterhead();

  // An ISSUED order prints its own snapshot; a draft previews the live config,
  // so what you check before issuing is what gets frozen.
  const live = await loadConfig();
  const issued = order.status !== "Draft";
  const text = {
    formVersion: issued ? order.formVersion : live.formVersion,
    references: issued ? order.referencesJson : live.referencesJson,
    instructions: issued ? order.instructionsJson : live.instructionsJson,
    assignment: issued ? order.assignmentStatement : live.assignmentStatement,
    closing: issued ? order.closingLine : live.closingLine,
    authority: issued ? order.authorityLine : live.authorityLine,
    signatoryName: issued ? order.signatoryName : lh.adminHeadName,
    signatoryPosition: issued ? order.signatoryPosition : lh.adminHeadPosition,
  };

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition",
    `attachment; filename="DDO-${slug(order.ddoNo || "DRAFT")}-${slug(order.site)}.pdf"`);
  doc.pipe(res);

  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  let y = L;

  // --- Form version, top-left, exactly as the paper form carries it ---
  doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(text.formVersion || "", L, y, { width: W / 2 });
  y += 12;

  // --- Letterhead ---
  if (lh.logoBuf) { try { doc.image(lh.logoBuf, L, y, { fit: [54, 54] }); } catch (e) { /* unreadable logo */ } }
  doc.font("Helvetica-Bold").fontSize(14).fillColor(NAVY).text(lh.companyName, L, y + 2, { width: W, align: "center" });
  y = doc.y + 1;
  doc.font("Helvetica").fontSize(8).fillColor(MUTE);
  for (const l of [
    lh.email ? `Email Address: ${lh.email}` : "",
    lh.ltoNo ? `LTO NO. ${lh.ltoNo}` : "",
    lh.mobile ? `MOBILE NO. ${lh.mobile}` : "",
  ].filter(Boolean)) { doc.text(l, L, y, { width: W, align: "center" }); y = doc.y; }

  y += 8;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor(NAVY).stroke();
  y += 10;

  doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY)
    .text(`Duty Detail Order No. ${order.ddoNo || "(unissued draft)"}`, L, y, { width: W, align: "center" });
  y = doc.y + 2;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#1a1a1a")
    .text(longDateUpper(order.orderDate), L, y, { width: W, align: "center" });
  y = doc.y + 12;

  // --- Numbered sections ---
  const NUM_W = 16, LET_W = 18;
  const section = (n, label, opts = {}) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#1a1a1a").text(`${n}`, L, y, { width: NUM_W });
    doc.font(opts.bold === false ? "Helvetica" : "Helvetica-Bold").fontSize(9)
      .text(label, L + NUM_W, y, { width: W - NUM_W });
    y = doc.y + 3;
  };
  const lettered = (letter, body, indent = NUM_W) => {
    const startY = y;
    doc.font("Helvetica").fontSize(8.5).fillColor("#1a1a1a").text(letter, L + indent, y, { width: LET_W });
    doc.font("Helvetica").fontSize(8.5)
      .text(body, L + indent + LET_W, startY, { width: W - indent - LET_W, align: "justify", lineGap: 0.5 });
    y = doc.y + 3;
  };

  section(1, "References:");
  for (const r of text.references || []) lettered(r.letter, r.text);
  y += 4;

  section(2, `Purpose of Detail: ${order.purpose}`, { bold: false });
  section(3, `Duration/ Inclusive Dates of Detail: ${periodPhrase(order.fromDate, order.toDate)}`, { bold: false });
  y += 2;
  doc.font("Helvetica").fontSize(8.5).fillColor("#1a1a1a").text("4", L, y, { width: NUM_W });
  doc.font("Helvetica").fontSize(8.5).text(text.assignment || "", L + NUM_W, y, { width: W - NUM_W, align: "justify" });
  y = doc.y + 8;

  // --- Duty table ---
  // Widths total the 523pt usable width of A4 portrait at a 36pt margin.
  // The validity column is sized to hold a full date on one line — at 47pt a
  // licence reading "JULY 10, 2030" broke across two, which is not something a
  // document an inspector reads at a gate should do. Place of duty is the one
  // column expected to wrap, since it carries a full postal address.
  // Make calibre carries the register's brand AND model — "Rock Island Armory
  // (Armsco) STK100" — not a bare "9MM", so it needs far more room than the
  // source spreadsheet gave it. At 52pt that value broke over four lines.
  const cols = [
    { k: "name", label: "NAME OF GUARDS", w: 92 },
    { k: "designation", label: "DESIGNATION", w: 56 },
    { k: "place", label: "PLACE OF DUTY", w: 90 },
    // Wide enough for "0600H-1800H" on one line: at 50pt it split after the
    // final digit, leaving a lone "H" on the second row.
    { k: "shift", label: "TIME OF SHIFT", w: 56 },
    { k: "caliber", label: "MAKE CALIBER", w: 96 },
    { k: "serial", label: "FAs SERIAL NO.", w: 68 },
    { k: "validity", label: "VALIDITY OF FAs LICENSE", w: 65 },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);

  const drawTableRow = (vals, opts = {}) => {
    const size = opts.header ? 6.8 : 7.5;
    doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    // Measure the tallest cell first so the row's borders enclose every line.
    let h = 0;
    cols.forEach((c, i) => {
      h = Math.max(h, doc.heightOfString(String(vals[i] ?? ""), { width: c.w - 6, align: "center" }));
    });
    h = Math.max(h + 6, opts.header ? 22 : 18);
    if (y + h > doc.page.height - 40) { doc.addPage({ size: "A4", margin: 36 }); y = 40; }
    let x = L;
    if (opts.header) doc.rect(L, y, tableW, h).fill("#EEF2F7");
    cols.forEach((c, i) => {
      doc.rect(x, y, c.w, h).lineWidth(0.6).strokeColor(RULE).stroke();
      doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .fillColor(opts.header ? NAVY : "#1a1a1a")
        .text(String(vals[i] ?? ""), x + 3, y + (h - doc.heightOfString(String(vals[i] ?? ""), { width: c.w - 6, align: "center" })) / 2,
          { width: c.w - 6, align: "center" });
      x += c.w;
    });
    y += h;
  };

  drawTableRow(cols.map((c) => c.label), { header: true });
  if (!lines.length) {
    drawTableRow(["— no personnel listed —", "", "", "", "", "", ""]);
  }
  for (const l of lines) {
    drawTableRow([
      `${l.rank ? l.rank + " " : ""}${l.guardName}`.toUpperCase(),
      (l.designation || "").toUpperCase(),
      (l.placeOfDuty || "").toUpperCase(),
      l.shift || "",
      (l.firearmCaliber || "").toUpperCase(),
      l.firearmSerial || "",
      l.firearmLicenceExpiry ? longDateUpper(l.firearmLicenceExpiry) : "",
    ]);
  }
  y += 10;

  // --- Specific instructions ---
  if (y > doc.page.height - 200) { doc.addPage({ size: "A4", margin: 36 }); y = 40; }
  section(5, "Specific Instructions:");
  for (const ins of text.instructions || []) lettered(ins.letter, ins.text);
  y += 6;

  if (y > doc.page.height - 130) { doc.addPage({ size: "A4", margin: 36 }); y = 40; }
  section(6, text.closing || "For strict compliance.", { bold: false });
  y += 16;

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#1a1a1a").text(text.authority || "", L + NUM_W, y, { width: W - NUM_W });
  y = doc.y + 32;
  doc.font("Helvetica-Bold").fontSize(9.5).text(text.signatoryName || "", L + NUM_W, y, { width: W - NUM_W });
  y = doc.y + 1;
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTE).text(text.signatoryPosition || "", L + NUM_W, y, { width: W - NUM_W });

  doc.end();
}));

module.exports = router;
