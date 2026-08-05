const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { pesoPdf } = require("../lib/pdfMoney");
const { phDateOf } = require("../lib/phTime");
const {
  availableQuantity, derivedSerializedStatus, deriveAlerts,
  outstandingQuantity, nextAssetTag, isOpen,
} = require("../lib/assetHelpers");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler — it
// escapes to the process, which then answers nothing. Every async handler is
// wrapped so a failure becomes a readable 500.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[assets]", e);
  if (!res.headersSent) res.status(500).json({ error: e.message || "The asset request failed." });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument|^text\/plain$/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: images, PDF, Word docs, text files."));
  },
});

const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged"];
const ASSET_STATUSES = ["Available", "Issued", "Under Repair", "Lost", "Retired"];
const TRACKING_MODES = ["Serialized", "Bulk"];
const today = () => phDateOf(Date.now());
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Classification — Type > Category > Sub-Category
//
// Owned entirely by this module. These are NOT the shared Manage Lists
// dropdowns: they are hierarchical, and they exist only to classify assets.
// ---------------------------------------------------------------------------

// The whole tree in one call — the forms need all three levels to cascade,
// and it is a few dozen rows.
router.get("/classification", requireAuth, wrap(async (req, res) => {
  const [types, categories, subcategories] = await Promise.all([
    pool.query(`SELECT * FROM asset_types ORDER BY name`),
    pool.query(`SELECT * FROM asset_categories ORDER BY name`),
    pool.query(`SELECT * FROM asset_subcategories ORDER BY name`),
  ]);
  // In-use counts, so the UI can warn before a deletion that would orphan
  // assets rather than discovering it afterwards.
  const inUse = (await pool.query(`
    SELECT "typeId", "categoryId", "subcategoryId", COUNT(*)::int c FROM assets
    GROUP BY "typeId", "categoryId", "subcategoryId"
  `)).rows;
  const count = (key, id) => inUse.filter((r) => r[key] === id).reduce((s, r) => s + r.c, 0);
  res.json({
    types: types.rows.map((t) => ({ ...t, assetCount: count("typeId", t.id) })),
    categories: categories.rows.map((c) => ({ ...c, assetCount: count("categoryId", c.id) })),
    subcategories: subcategories.rows.map((s) => ({ ...s, assetCount: count("subcategoryId", s.id) })),
  });
}));

// One generic handler per level keeps the three CRUD sets identical in
// behaviour — a rename at any level works the same way, and so does a
// blocked delete.
const LEVELS = {
  types: { table: "asset_types", parent: null, fkOnAsset: "typeId", label: "asset type" },
  categories: { table: "asset_categories", parent: "typeId", fkOnAsset: "categoryId", label: "asset category" },
  subcategories: { table: "asset_subcategories", parent: "categoryId", fkOnAsset: "subcategoryId", label: "asset sub-category" },
};

function levelOf(req, res) {
  const lvl = LEVELS[req.params.level];
  if (!lvl) { res.status(400).json({ error: "Unknown classification level." }); return null; }
  return lvl;
}

router.post("/classification/:level", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const lvl = levelOf(req, res); if (!lvl) return;
  const name = str(req.body?.name);
  if (!name) return res.status(400).json({ error: `A ${lvl.label} name is required.` });
  const parentId = lvl.parent ? numOrNull(req.body?.parentId) : null;
  if (lvl.parent && !parentId) {
    return res.status(400).json({ error: lvl.parent === "typeId" ? "An asset type is required." : "An asset category is required." });
  }
  const cols = lvl.parent ? `("${lvl.parent}", name, "createdBy")` : `(name, "createdBy")`;
  const vals = lvl.parent ? [parentId, name, req.user.username] : [name, req.user.username];
  const params = lvl.parent ? "$1,$2,$3" : "$1,$2";
  const { rows } = await pool.query(
    `INSERT INTO ${lvl.table} ${cols} VALUES (${params}) ON CONFLICT DO NOTHING RETURNING *`, vals
  );
  if (!rows[0]) return res.status(409).json({ error: `That ${lvl.label} already exists.` });
  res.status(201).json(rows[0]);
}));

router.patch("/classification/:level/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const lvl = levelOf(req, res); if (!lvl) return;
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE ${lvl.table} SET name = COALESCE($1, name), active = COALESCE($2, active)
     WHERE id = $3 RETURNING *`,
    [str(b.name) || null, typeof b.active === "boolean" ? b.active : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: `That ${lvl.label} was not found.` });

  // Assets snapshot their classification names so historical receipts stay
  // truthful. A RENAME, though, is a correction to the same thing — not a
  // reclassification — so carry it onto the assets that point at this row.
  // Issued receipts keep the wording they were printed with.
  if (str(b.name)) {
    const col = lvl.fkOnAsset === "typeId" ? "typeName" : lvl.fkOnAsset === "categoryId" ? "categoryName" : "subcategoryName";
    await pool.query(`UPDATE assets SET "${col}" = $1 WHERE "${lvl.fkOnAsset}" = $2`, [str(b.name), req.params.id]);
  }
  res.json(rows[0]);
}));

router.delete("/classification/:level/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const lvl = levelOf(req, res); if (!lvl) return;
  // Refuse rather than orphan. Deactivating hides an entry from the pickers
  // while leaving every existing asset correctly classified.
  const used = (await pool.query(
    `SELECT COUNT(*)::int c FROM assets WHERE "${lvl.fkOnAsset}" = $1`, [req.params.id]
  )).rows[0].c;
  if (used > 0) {
    return res.status(400).json({
      error: `${used} asset${used === 1 ? " is" : "s are"} classified under this ${lvl.label}. Deactivate it instead — deleting would leave them unclassified.`,
    });
  }
  const children = lvl.parent === null
    ? (await pool.query(`SELECT COUNT(*)::int c FROM asset_categories WHERE "typeId" = $1`, [req.params.id])).rows[0].c
    : lvl.fkOnAsset === "categoryId"
      ? (await pool.query(`SELECT COUNT(*)::int c FROM asset_subcategories WHERE "categoryId" = $1`, [req.params.id])).rows[0].c
      : 0;
  if (children > 0) {
    return res.status(400).json({ error: `Remove its ${children} child entr${children === 1 ? "y" : "ies"} first.` });
  }
  await pool.query(`DELETE FROM ${lvl.table} WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Asset register
// ---------------------------------------------------------------------------

// Every asset with its live availability. Availability is summed from the
// open issuances rather than stored, so the register can never disagree with
// the ledger.
async function loadAssetsWithAvailability(where = "", vals = []) {
  const assets = (await pool.query(
    `SELECT * FROM assets ${where} ORDER BY "typeName", "categoryName", "subcategoryName", name, "assetTag"`, vals
  )).rows;
  if (!assets.length) return [];
  const open = (await pool.query(
    `SELECT "assetId", status, quantity, "quantityReturned", "employeeName", "expectedReturnDate"
     FROM asset_issuances WHERE status IN ('Issued','Partially Returned')`
  )).rows;
  return assets.map((a) => {
    const mine = open.filter((i) => i.assetId === a.id);
    return {
      ...a,
      available: availableQuantity(a, mine),
      onIssue: mine.reduce((s, i) => s + outstandingQuantity(i), 0),
      holders: mine.map((i) => i.employeeName).filter(Boolean),
    };
  });
}

router.get("/", requireAuth, wrap(async (req, res) => {
  const clauses = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); clauses.push(sql.replace("?", `$${vals.length}`)); };
  if (req.query.typeId) add(`"typeId" = ?`, req.query.typeId);
  if (req.query.categoryId) add(`"categoryId" = ?`, req.query.categoryId);
  if (req.query.subcategoryId) add(`"subcategoryId" = ?`, req.query.subcategoryId);
  if (req.query.status) add(`status = ?`, req.query.status);
  if (req.query.site) add(`site = ?`, req.query.site);
  if (req.query.q) {
    vals.push(`%${req.query.q}%`);
    clauses.push(`("assetTag" ILIKE $${vals.length} OR name ILIKE $${vals.length} OR "serialNumber" ILIKE $${vals.length} OR brand ILIKE $${vals.length} OR model ILIKE $${vals.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  res.json(await loadAssetsWithAvailability(where, vals));
}));

// Registered before "/:id" so "stats" is not read as an id.
router.get("/stats", requireAuth, wrap(async (req, res) => {
  const assets = await loadAssetsWithAvailability();
  const issuances = (await pool.query(`SELECT * FROM asset_issuances`)).rows;
  const byType = {};
  for (const a of assets) {
    const k = a.typeName || "Unclassified";
    byType[k] = byType[k] || { type: k, count: 0, available: 0, onIssue: 0, value: 0 };
    byType[k].count++;
    byType[k].available += a.available;
    byType[k].onIssue += a.onIssue;
    byType[k].value += Number(a.acquisitionCost || 0) * (a.trackingMode === "Bulk" ? Number(a.quantity || 0) : 1);
  }
  res.json({
    totals: {
      assets: assets.length,
      units: assets.reduce((s, a) => s + (a.trackingMode === "Bulk" ? Number(a.quantity || 0) : 1), 0),
      available: assets.reduce((s, a) => s + a.available, 0),
      onIssue: assets.reduce((s, a) => s + a.onIssue, 0),
      underRepair: assets.filter((a) => a.status === "Under Repair").length,
      lost: assets.filter((a) => a.status === "Lost").length,
      retired: assets.filter((a) => a.status === "Retired").length,
      value: assets.reduce((s, a) => s + Number(a.acquisitionCost || 0) * (a.trackingMode === "Bulk" ? Number(a.quantity || 0) : 1), 0),
    },
    byType: Object.values(byType).sort((a, b) => b.count - a.count),
    openIssuances: issuances.filter(isOpen).length,
  });
}));

// Suggest the next tag in a series, so the register stays tidy without
// forcing a scheme on anyone who has their own.
router.get("/next-tag", requireAuth, wrap(async (req, res) => {
  const prefix = str(req.query.prefix) || "AST";
  const tags = (await pool.query(`SELECT "assetTag" FROM assets`)).rows.map((r) => r.assetTag);
  res.json({ assetTag: nextAssetTag(prefix, tags) });
}));

router.get("/:id", requireAuth, wrap(async (req, res) => {
  const rows = await loadAssetsWithAvailability(`WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Asset not found." });
  // ORDER BY must name the TABLE's column, not the to_char alias of the same
  // name — an unqualified "issuedDate" is ambiguous between the two and
  // Postgres rejects the query outright.
  const issuances = (await pool.query(
    `SELECT *, to_char("issuedDate",'YYYY-MM-DD') AS "issuedDate",
            to_char("expectedReturnDate",'YYYY-MM-DD') AS "expectedReturnDate",
            to_char("returnedDate",'YYYY-MM-DD') AS "returnedDate"
     FROM asset_issuances WHERE "assetId" = $1
     ORDER BY asset_issuances."issuedDate" DESC, asset_issuances.id DESC`, [req.params.id]
  )).rows;
  const attachments = (await pool.query(
    `SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM asset_attachments WHERE asset_id = $1 ORDER BY id`,
    [req.params.id]
  )).rows;
  res.json({ ...rows[0], issuances, attachments });
}));

// Resolve the three classification levels to their names, and verify they
// actually form a chain — a sub-category from another category would produce
// a receipt that reads as nonsense.
async function resolveClassification(typeId, categoryId, subcategoryId) {
  const out = { typeName: "", categoryName: "", subcategoryName: "" };
  if (typeId) {
    const t = (await pool.query(`SELECT name FROM asset_types WHERE id = $1`, [typeId])).rows[0];
    if (!t) throw new Error("That asset type no longer exists.");
    out.typeName = t.name;
  }
  if (categoryId) {
    const c = (await pool.query(`SELECT name, "typeId" FROM asset_categories WHERE id = $1`, [categoryId])).rows[0];
    if (!c) throw new Error("That asset category no longer exists.");
    if (typeId && String(c.typeId) !== String(typeId)) throw new Error("That category does not belong to the selected asset type.");
    out.categoryName = c.name;
  }
  if (subcategoryId) {
    const s = (await pool.query(`SELECT name, "categoryId" FROM asset_subcategories WHERE id = $1`, [subcategoryId])).rows[0];
    if (!s) throw new Error("That asset sub-category no longer exists.");
    if (categoryId && String(s.categoryId) !== String(categoryId)) throw new Error("That sub-category does not belong to the selected category.");
    out.subcategoryName = s.name;
  }
  return out;
}

const ASSET_FIELDS = [
  "assetTag", "name", "description", "trackingMode", "serialNumber", "brand", "model",
  "size", "quantity", "reorderLevel", "condition", "status", "site",
  "acquisitionDate", "acquisitionCost", "warrantyExpiry", "replacementDueDate",
  "statusNote", "notes",
];

router.post("/", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const assetTag = str(b.assetTag);
  const name = str(b.name);
  if (!assetTag) return res.status(400).json({ error: "An asset tag is required." });
  if (!name) return res.status(400).json({ error: "An asset name is required." });
  if (!b.typeId) return res.status(400).json({ error: "An asset type is required." });
  if (!b.categoryId) return res.status(400).json({ error: "An asset category is required." });

  const cls = await resolveClassification(b.typeId, b.categoryId, b.subcategoryId);
  const trackingMode = TRACKING_MODES.includes(b.trackingMode) ? b.trackingMode : "Serialized";
  // A serialized item is one thing; its quantity is not a user's to set.
  const quantity = trackingMode === "Bulk" ? Math.max(0, Number(b.quantity) || 0) : 1;

  const { rows } = await pool.query(
    `INSERT INTO assets ("assetTag", name, description, "typeId", "categoryId", "subcategoryId",
       "typeName", "categoryName", "subcategoryName", "trackingMode", "serialNumber", brand, model,
       size, quantity, "reorderLevel", condition, status, site, "acquisitionDate", "acquisitionCost",
       "warrantyExpiry", "replacementDueDate", "statusNote", notes,
       caliber, "licenceNo", "licenceExpiry", "createdBy", "updatedBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20::date,$21,$22::date,$23::date,$24,$25,$26,$27,$28::date,$29,$29)
     ON CONFLICT ("assetTag") DO NOTHING RETURNING *`,
    [assetTag, name, str(b.description), b.typeId, b.categoryId, b.subcategoryId || null,
     cls.typeName, cls.categoryName, cls.subcategoryName, trackingMode, str(b.serialNumber),
     str(b.brand), str(b.model), str(b.size), quantity, Math.max(0, Number(b.reorderLevel) || 0),
     CONDITIONS.includes(b.condition) ? b.condition : "Good",
     ASSET_STATUSES.includes(b.status) ? b.status : "Available",
     str(b.site), b.acquisitionDate || null, numOrNull(b.acquisitionCost),
     b.warrantyExpiry || null, b.replacementDueDate || null, str(b.statusNote), str(b.notes),
     str(b.caliber), str(b.licenceNo), b.licenceExpiry || null,
     req.user.username]
  );
  if (!rows[0]) return res.status(409).json({ error: `Asset tag "${assetTag}" is already in use.` });
  res.status(201).json(rows[0]);
}));

router.patch("/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const asset = (await pool.query(`SELECT * FROM assets WHERE id = $1`, [req.params.id])).rows[0];
  if (!asset) return res.status(404).json({ error: "Asset not found." });

  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const typeId = has("typeId") ? b.typeId : asset.typeId;
  const categoryId = has("categoryId") ? b.categoryId : asset.categoryId;
  const subcategoryId = has("subcategoryId") ? (b.subcategoryId || null) : asset.subcategoryId;
  const cls = await resolveClassification(typeId, categoryId, subcategoryId);

  const trackingMode = has("trackingMode") && TRACKING_MODES.includes(b.trackingMode) ? b.trackingMode : asset.trackingMode;
  const quantity = trackingMode === "Bulk"
    ? (has("quantity") ? Math.max(0, Number(b.quantity) || 0) : Number(asset.quantity))
    : 1;

  // Reducing bulk stock below what is already out would make availability
  // negative and the ledger unexplainable. Refuse with the actual number.
  if (trackingMode === "Bulk") {
    const out = (await pool.query(
      `SELECT COALESCE(SUM(quantity - "quantityReturned"),0)::int o FROM asset_issuances
       WHERE "assetId" = $1 AND status IN ('Issued','Partially Returned')`, [req.params.id]
    )).rows[0].o;
    if (quantity < out) {
      return res.status(400).json({ error: `${out} unit${out === 1 ? " is" : "s are"} currently out on issue. Stock cannot be set below that.` });
    }
  }

  const pick = (k, fallback) => (has(k) ? b[k] : fallback);
  const { rows } = await pool.query(
    `UPDATE assets SET
       "assetTag" = $1, name = $2, description = $3,
       "typeId" = $4, "categoryId" = $5, "subcategoryId" = $6,
       "typeName" = $7, "categoryName" = $8, "subcategoryName" = $9,
       "trackingMode" = $10, "serialNumber" = $11, brand = $12, model = $13, size = $14,
       quantity = $15, "reorderLevel" = $16, condition = $17, status = $18, site = $19,
       "acquisitionDate" = $20::date, "acquisitionCost" = $21,
       "warrantyExpiry" = $22::date, "replacementDueDate" = $23::date,
       "statusNote" = $24, notes = $25,
       caliber = $26, "licenceNo" = $27, "licenceExpiry" = $28::date,
       "updatedBy" = $29, "updatedAt" = now()
     WHERE id = $30 RETURNING *`,
    [str(pick("assetTag", asset.assetTag)) || asset.assetTag, str(pick("name", asset.name)) || asset.name,
     str(pick("description", asset.description)), typeId, categoryId, subcategoryId,
     cls.typeName, cls.categoryName, cls.subcategoryName, trackingMode,
     str(pick("serialNumber", asset.serialNumber)), str(pick("brand", asset.brand)),
     str(pick("model", asset.model)), str(pick("size", asset.size)),
     quantity, Math.max(0, Number(pick("reorderLevel", asset.reorderLevel)) || 0),
     CONDITIONS.includes(pick("condition", asset.condition)) ? pick("condition", asset.condition) : asset.condition,
     ASSET_STATUSES.includes(pick("status", asset.status)) ? pick("status", asset.status) : asset.status,
     str(pick("site", asset.site)),
     pick("acquisitionDate", asset.acquisitionDate) || null, numOrNull(pick("acquisitionCost", asset.acquisitionCost)),
     pick("warrantyExpiry", asset.warrantyExpiry) || null, pick("replacementDueDate", asset.replacementDueDate) || null,
     str(pick("statusNote", asset.statusNote)), str(pick("notes", asset.notes)),
     str(pick("caliber", asset.caliber)), str(pick("licenceNo", asset.licenceNo)),
     pick("licenceExpiry", asset.licenceExpiry) || null,
     req.user.username, req.params.id]
  );
  await syncSerializedStatus(pool, req.params.id);
  res.json(rows[0]);
}));

router.delete("/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  // An asset with history is evidence of who held what. Retire it instead;
  // only a mistakenly-created record with no issuances is truly deletable.
  const used = (await pool.query(`SELECT COUNT(*)::int c FROM asset_issuances WHERE "assetId" = $1`, [req.params.id])).rows[0].c;
  if (used > 0) {
    await pool.query(`UPDATE assets SET status = 'Retired', "updatedBy" = $1, "updatedAt" = now() WHERE id = $2`,
      [req.user.username, req.params.id]);
    return res.json({ ok: true, retired: true, issuances: used });
  }
  await pool.query(`DELETE FROM assets WHERE id = $1`, [req.params.id]);
  res.json({ ok: true, deleted: true });
}));

// Re-derive a serialized asset's status from its open issuances. Called after
// every issue and return so nothing ever sets 'Issued' by hand.
async function syncSerializedStatus(db, assetId) {
  const asset = (await db.query(`SELECT * FROM assets WHERE id = $1`, [assetId])).rows[0];
  if (!asset || asset.trackingMode !== "Serialized") return;
  const open = (await db.query(
    `SELECT "assetId", status, quantity, "quantityReturned" FROM asset_issuances
     WHERE "assetId" = $1 AND status IN ('Issued','Partially Returned')`, [assetId]
  )).rows;
  const next = derivedSerializedStatus(asset, open);
  if (next !== asset.status) {
    await db.query(`UPDATE assets SET status = $1, "updatedAt" = now() WHERE id = $2`, [next, assetId]);
  }
}

// ---------------------------------------------------------------------------
// Issuance & returns
// ---------------------------------------------------------------------------

const ISSUANCE_SELECT = `
  SELECT ai.*,
         to_char(ai."issuedDate",'YYYY-MM-DD') AS "issuedDate",
         to_char(ai."expectedReturnDate",'YYYY-MM-DD') AS "expectedReturnDate",
         to_char(ai."returnedDate",'YYYY-MM-DD') AS "returnedDate",
         a."trackingMode", a.status AS "assetStatus"
  FROM asset_issuances ai
  LEFT JOIN assets a ON a.id = ai."assetId"
`;

router.get("/issuances/all", requireAuth, wrap(async (req, res) => {
  const clauses = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); clauses.push(sql.replace("?", `$${vals.length}`)); };
  if (req.query.status) add(`ai.status = ?`, req.query.status);
  if (req.query.employeeId) add(`ai."employeeId" = ?`, req.query.employeeId);
  if (req.query.assetId) add(`ai."assetId" = ?`, req.query.assetId);
  if (req.query.site) add(`ai.site = ?`, req.query.site);
  if (req.query.open === "true") clauses.push(`ai.status IN ('Issued','Partially Returned')`);
  if (req.query.from) add(`ai."issuedDate" >= ?::date`, req.query.from);
  if (req.query.to) add(`ai."issuedDate" <= ?::date`, req.query.to);
  if (req.query.q) {
    vals.push(`%${req.query.q}%`);
    clauses.push(`(ai."employeeName" ILIKE $${vals.length} OR ai."assetTag" ILIKE $${vals.length} OR ai."assetName" ILIKE $${vals.length} OR ai."serialNumber" ILIKE $${vals.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `${ISSUANCE_SELECT} ${where} ORDER BY ai."issuedDate" DESC, ai.id DESC`, vals
  );
  res.json(rows);
}));

// Issue an asset to an employee.
router.post("/issuances", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.assetId) return res.status(400).json({ error: "An asset is required." });
  if (!b.employeeId) return res.status(400).json({ error: "An employee is required." });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Lock the asset row for the duration: two people issuing the last radio
    // at the same moment must not both succeed.
    const asset = (await db.query(`SELECT * FROM assets WHERE id = $1 FOR UPDATE`, [b.assetId])).rows[0];
    if (!asset) { await db.query("ROLLBACK"); return res.status(404).json({ error: "Asset not found." }); }

    const employee = (await db.query(
      `SELECT id, "employeeNo", "fullName", position, site FROM employees WHERE id = $1`, [b.employeeId]
    )).rows[0];
    if (!employee) { await db.query("ROLLBACK"); return res.status(404).json({ error: "Employee not found." }); }

    const open = (await db.query(
      `SELECT "assetId", status, quantity, "quantityReturned" FROM asset_issuances
       WHERE "assetId" = $1 AND status IN ('Issued','Partially Returned')`, [asset.id]
    )).rows;
    const available = availableQuantity(asset, open);
    const wanted = asset.trackingMode === "Bulk" ? Math.max(1, Number(b.quantity) || 1) : 1;

    if (available <= 0) {
      await db.query("ROLLBACK");
      const why = asset.status !== "Available" && asset.trackingMode === "Serialized"
        ? `It is marked ${asset.status}.`
        : "Every unit is already out on issue.";
      return res.status(400).json({ error: `${asset.assetTag} cannot be issued. ${why}` });
    }
    if (wanted > available) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: `Only ${available} unit${available === 1 ? "" : "s"} of ${asset.assetTag} ${available === 1 ? "is" : "are"} available.` });
    }

    const { rows } = await db.query(
      `INSERT INTO asset_issuances ("assetId","employeeId","employeeNo","employeeName",position,site,
         "assetTag","assetName","serialNumber","typeName","categoryName","subcategoryName",
         quantity,"issuedDate","expectedReturnDate","issuedBy",purpose,"conditionOnIssue")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16,$17,$18)
       RETURNING id`,
      [asset.id, employee.id, employee.employeeNo, employee.fullName, employee.position, employee.site,
       asset.assetTag, asset.name, asset.serialNumber, asset.typeName, asset.categoryName, asset.subcategoryName,
       wanted, b.issuedDate || today(), b.expectedReturnDate || null, req.user.username,
       str(b.purpose), CONDITIONS.includes(b.conditionOnIssue) ? b.conditionOnIssue : asset.condition]
    );
    await syncSerializedStatus(db, asset.id);
    await db.query("COMMIT");
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}));

// Record a return — whole or partial, and including a write-off.
router.patch("/issuances/:id/return", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const issuance = (await db.query(`SELECT * FROM asset_issuances WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!issuance) { await db.query("ROLLBACK"); return res.status(404).json({ error: "Issuance not found." }); }
    if (!isOpen(issuance)) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: `This issuance is already ${issuance.status.toLowerCase()}.` });
    }

    const outstanding = Number(issuance.quantity) - Number(issuance.quantityReturned);
    const outcome = ["Returned", "Lost", "Damaged"].includes(b.outcome) ? b.outcome : "Returned";
    // Lost and damaged write off everything still out — there is nothing left
    // to hand back, so a partial quantity would be meaningless.
    const qty = outcome === "Returned"
      ? Math.max(1, Math.min(Number(b.quantity) || outstanding, outstanding))
      : outstanding;

    const returnedTotal = Number(issuance.quantityReturned) + (outcome === "Returned" ? qty : 0);
    const fullyAccounted = outcome !== "Returned" || returnedTotal >= Number(issuance.quantity);
    const status = outcome !== "Returned" ? outcome : (fullyAccounted ? "Returned" : "Partially Returned");

    await db.query(
      `UPDATE asset_issuances SET
         "quantityReturned" = $1, status = $2, "returnedDate" = $3::date, "receivedBy" = $4,
         "conditionOnReturn" = $5, "returnNotes" = $6, "updatedAt" = now()
       WHERE id = $7`,
      [returnedTotal, status, fullyAccounted ? (b.returnedDate || today()) : null, req.user.username,
       CONDITIONS.includes(b.conditionOnReturn) ? b.conditionOnReturn : null,
       str(b.returnNotes), req.params.id]
    );

    // A returned item's condition is news about the asset itself: a radio
    // handed back damaged should not be the next thing offered to a guard.
    if (outcome === "Lost") {
      await db.query(`UPDATE assets SET status = 'Lost', "statusNote" = $1, "updatedAt" = now() WHERE id = $2 AND "trackingMode" = 'Serialized'`,
        [`Reported lost by ${issuance.employeeName}`, issuance.assetId]);
    } else if (outcome === "Damaged" || b.conditionOnReturn === "Damaged") {
      await db.query(`UPDATE assets SET condition = 'Damaged', status = 'Under Repair', "statusNote" = $1, "updatedAt" = now() WHERE id = $2 AND "trackingMode" = 'Serialized'`,
        [`Returned damaged by ${issuance.employeeName}`, issuance.assetId]);
    } else if (CONDITIONS.includes(b.conditionOnReturn)) {
      await db.query(`UPDATE assets SET condition = $1, "updatedAt" = now() WHERE id = $2 AND "trackingMode" = 'Serialized'`,
        [b.conditionOnReturn, issuance.assetId]);
    }

    await syncSerializedStatus(db, issuance.assetId);
    await db.query("COMMIT");
    res.json({ ok: true, status });
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}));

router.patch("/issuances/:id", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE asset_issuances SET
       "expectedReturnDate" = COALESCE($1::date, "expectedReturnDate"),
       purpose = COALESCE($2, purpose),
       "returnNotes" = COALESCE($3, "returnNotes"),
       "updatedAt" = now()
     WHERE id = $4 RETURNING id`,
    [b.expectedReturnDate || null, b.purpose ?? null, b.returnNotes ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Issuance not found." });
  res.json({ ok: true });
}));

router.delete("/issuances/:id", requireAuth, requireRole("Admin"), wrap(async (req, res) => {
  const issuance = (await pool.query(`SELECT * FROM asset_issuances WHERE id = $1`, [req.params.id])).rows[0];
  if (!issuance) return res.status(404).json({ error: "Issuance not found." });
  await pool.query(`DELETE FROM asset_issuances WHERE id = $1`, [req.params.id]);
  await syncSerializedStatus(pool, issuance.assetId);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Alerts — derived on read, never stored. An alert is a fact about today.
// ---------------------------------------------------------------------------

router.get("/alerts/all", requireAuth, wrap(async (req, res) => {
  const assets = (await pool.query(
    `SELECT id, "assetTag", name, "typeName", "categoryName", "subcategoryName", "trackingMode",
            status, condition, quantity, "reorderLevel", site,
            to_char("warrantyExpiry",'YYYY-MM-DD') AS "warrantyExpiry",
            to_char("replacementDueDate",'YYYY-MM-DD') AS "replacementDueDate"
     FROM assets`
  )).rows;
  const issuances = (await pool.query(
    `SELECT id, "assetId", "assetTag", "assetName", "employeeId", "employeeName", position, site,
            status, quantity, "quantityReturned",
            to_char("issuedDate",'YYYY-MM-DD') AS "issuedDate",
            to_char("expectedReturnDate",'YYYY-MM-DD') AS "expectedReturnDate"
     FROM asset_issuances`
  )).rows;
  res.json(deriveAlerts({
    assets, issuances, today: today(),
    dueSoonDays: Math.max(0, parseInt(req.query.dueSoonDays, 10) || 7),
    replacementWindowDays: Math.max(0, parseInt(req.query.replacementWindowDays, 10) || 30),
  }));
}));

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

router.post("/:id/attachments", requireAuth, requireRole("Admin", "Investigator"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    try {
      await pool.query(
        `INSERT INTO asset_attachments (asset_id, filename, mimetype, size, data, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.username]
      );
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Could not save the attachment." });
    }
  });
});

router.get("/:id/attachments/:attId", requireAuth, wrap(async (req, res) => {
  const row = (await pool.query(
    `SELECT * FROM asset_attachments WHERE id = $1 AND asset_id = $2`, [req.params.attId, req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Attachment not found." });
  res.set("Content-Type", row.mimetype);
  res.set("Content-Disposition", `inline; filename="${row.filename.replace(/"/g, "")}"`);
  res.send(row.data);
}));

router.delete("/:id/attachments/:attId", requireAuth, requireRole("Admin", "Investigator"), wrap(async (req, res) => {
  await pool.query(`DELETE FROM asset_attachments WHERE id = $1 AND asset_id = $2`, [req.params.attId, req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
const slug = (s) => (s || "asset").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Parsed by hand rather than through Date, which would re-read a bare date in
// the server's timezone and can shift it a day.
function longDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

async function letterhead() {
  const s = (await pool.query(
    `SELECT "companyName", "logoData", "agencyTagline", "agencyAddress", "agencyMobile",
            "agencyEmail", "ownerName", "ownerPosition" FROM app_settings WHERE id = 1`
  )).rows[0] || {};
  return {
    companyName: (s.companyName || "").toUpperCase(),
    logoBuf: s.logoData || null,
    tagline: s.agencyTagline || "", address: s.agencyAddress || "",
    mobile: s.agencyMobile || "", email: s.agencyEmail || "",
    ownerName: s.ownerName || "", ownerPosition: s.ownerPosition || "",
  };
}

function drawBanner(doc, title, subtitle, lh) {
  doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
  const textX = lh.logoBuf ? 96 : 40;
  if (lh.logoBuf) { try { doc.image(lh.logoBuf, 40, 20, { fit: [42, 42] }); } catch (e) { /* unreadable logo */ } }
  doc.font("Helvetica").fillColor(GOLD).fontSize(10).text(lh.companyName, textX, 24, { characterSpacing: 1 });
  doc.fillColor("#fff").fontSize(16).text(title, textX, 40);
  doc.fillColor("#C9D3E3").fontSize(9).text(subtitle, textX, 62, { width: doc.page.width - textX - 40 });
  doc.y = 100;
}

// The Equipment Accountability Form a guard signs when equipment changes
// hands. This is the document that makes "full accountability" mean
// something: agency letterhead and logo from System Settings, then the item,
// its serial, its condition, and who accepted responsibility for it.
router.get("/issuances/:id/receipt.pdf", requireAuth, wrap(async (req, res) => {
  const i = (await pool.query(
    `SELECT *, to_char("issuedDate",'YYYY-MM-DD') AS "issuedDate",
            to_char("expectedReturnDate",'YYYY-MM-DD') AS "expectedReturnDate",
            to_char("returnedDate",'YYYY-MM-DD') AS "returnedDate"
     FROM asset_issuances WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!i) return res.status(404).json({ error: "Issuance not found." });
  const lh = await letterhead();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="Accountability-Form-${slug(i.assetTag)}-${slug(i.employeeName)}.pdf"`);
  doc.pipe(res);

  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;

  let y = 42;
  if (lh.logoBuf) { try { doc.image(lh.logoBuf, L, y - 4, { fit: [56, 56] }); } catch (e) { /* skip */ } }
  doc.font("Helvetica-Bold").fontSize(15).fillColor(NAVY).text(lh.companyName, L, y, { width: W, align: "center" });
  y = doc.y + 1;
  if (lh.tagline) { doc.font("Helvetica-Oblique").fontSize(9).fillColor(GOLD).text(lh.tagline, L, y, { width: W, align: "center" }); y = doc.y + 1; }
  doc.font("Helvetica").fontSize(8).fillColor(MUTE);
  for (const line of [
    lh.address ? `Main Office: ${lh.address}` : "",
    lh.mobile ? `Mobile No. ${lh.mobile}` : "",
    lh.email ? `Email Address: ${lh.email}` : "",
  ].filter(Boolean)) { doc.text(line, L, y, { width: W, align: "center" }); y = doc.y; }

  y += 8;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor(NAVY).stroke();
  y += 12;
  doc.font("Helvetica-Bold").fontSize(13).fillColor(NAVY)
    .text("EQUIPMENT ACCOUNTABILITY FORM", L, y, { width: W, align: "center", characterSpacing: 0.5 });
  y = doc.y + 16;

  const field = (label, value, yy, x, labelW, valW) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTE).text(label, x, yy, { width: labelW });
    doc.font("Helvetica").fontSize(9.5).fillColor("#1a1a1a").text(value || "—", x + labelW, yy - 0.5, { width: valW });
  };
  field("Form No:", `EAF-${String(i.id).padStart(5, "0")}`, y, L, 74, 180);
  field("Date Issued:", longDate(i.issuedDate), y, L + 300, 74, W - 374);
  y += 16;
  field("Issued to:", i.employeeName, y, L, 74, 180);
  field("Employee No:", i.employeeNo || "—", y, L + 300, 74, W - 374);
  y += 16;
  field("Position:", i.position || "—", y, L, 74, 180);
  field("Site / Post:", i.site || "—", y, L + 300, 74, W - 374);
  y += 24;

  doc.rect(L, y, W, 18).fill("#EEF2F7");
  doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text("ITEM ISSUED", L + 6, y + 5, { width: W - 12 });
  y += 26;

  const rowPair = (label, value) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTE).text(label, L + 6, y, { width: 128 });
    doc.font("Helvetica").fontSize(9.5).fillColor("#1a1a1a").text(value || "—", L + 140, y - 0.5, { width: W - 152 });
    y += 16;
  };
  rowPair("Asset tag", i.assetTag);
  rowPair("Description", i.assetName);
  rowPair("Classification", [i.typeName, i.categoryName, i.subcategoryName].filter(Boolean).join("  ›  "));
  rowPair("Serial number", i.serialNumber);
  rowPair("Quantity", String(i.quantity));
  rowPair("Condition on issue", i.conditionOnIssue);
  rowPair("Expected return", longDate(i.expectedReturnDate));
  if (i.purpose) rowPair("Purpose", i.purpose);

  if (i.status !== "Issued") {
    y += 6;
    doc.rect(L, y, W, 18).fill("#EEF2F7");
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text("RETURN", L + 6, y + 5, { width: W - 12 });
    y += 26;
    rowPair("Status", i.status);
    rowPair("Quantity returned", `${i.quantityReturned} of ${i.quantity}`);
    rowPair("Date returned", longDate(i.returnedDate));
    rowPair("Condition on return", i.conditionOnReturn || "—");
    rowPair("Received by", i.receivedBy || "—");
    if (i.returnNotes) rowPair("Remarks", i.returnNotes);
  }

  y += 14;
  doc.font("Helvetica").fontSize(9).fillColor("#1a1a1a").text(
    "I acknowledge receipt of the item described above in the condition stated, and accept responsibility " +
    "for its safekeeping. I undertake to return it on or before the expected return date, or upon separation " +
    "from the agency, and to report any loss or damage immediately. I understand that loss or damage caused " +
    "by negligence may be charged against me in accordance with agency policy.",
    L, y, { width: W, align: "justify", lineGap: 2 }
  );
  y = doc.y + 40;

  const colW = (W - 40) / 2;
  const sign = (x, heading, name, sub) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTE).text(heading, x, y, { width: colW });
    doc.moveTo(x, y + 44).lineTo(x + colW, y + 44).lineWidth(0.8).strokeColor("#1a1a1a").stroke();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#1a1a1a").text(name || "", x, y + 48, { width: colW });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTE).text(sub || "", x, y + 60, { width: colW });
  };
  // The issuer's position may only be stated when the issuer IS the owner.
  // Pairing whoever happened to hand the item over with the owner's title
  // would print a storekeeper as "General Manager / Owner".
  const issuer = i.issuedBy || lh.ownerName;
  const issuerRole = i.issuedBy ? "Authorized representative" : (lh.ownerPosition || "Authorized representative");
  sign(L, "Received by", i.employeeName, i.position || "Employee");
  sign(L + colW + 40, "Issued by", issuer, issuerRole);

  stampAuthorFooter(doc, lh.companyName);


  doc.end();
}));

// The asset register as a printable inventory, honouring the same filters the
// on-screen list is using so what is printed is what was looked at.
router.get("/report/inventory.pdf", requireAuth, wrap(async (req, res) => {
  const clauses = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); clauses.push(sql.replace("?", `$${vals.length}`)); };
  if (req.query.typeId) add(`"typeId" = ?`, req.query.typeId);
  if (req.query.categoryId) add(`"categoryId" = ?`, req.query.categoryId);
  if (req.query.subcategoryId) add(`"subcategoryId" = ?`, req.query.subcategoryId);
  if (req.query.status) add(`status = ?`, req.query.status);
  if (req.query.site) add(`site = ?`, req.query.site);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const assets = await loadAssetsWithAvailability(where, vals);
  const lh = await letterhead();

  const doc = new PDFDocument({ bufferPages: true, size: "A4", layout: "landscape", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="asset-inventory-${today()}.pdf"`);
  doc.pipe(res);

  const filterBits = [
    req.query.status ? `Status: ${req.query.status}` : "",
    req.query.site ? `Site: ${req.query.site}` : "",
  ].filter(Boolean).join("  ·  ");
  drawBanner(doc, "Asset & Equipment Inventory",
    `${assets.length} asset${assets.length === 1 ? "" : "s"}${filterBits ? "  ·  " + filterBits : ""}  ·  As of ${longDate(today())}`, lh);

  const totalValue = assets.reduce((s, a) => s + Number(a.acquisitionCost || 0) * (a.trackingMode === "Bulk" ? Number(a.quantity || 0) : 1), 0);
  doc.font("Helvetica").fillColor(NAVY).fontSize(10).text(
    `On issue: ${assets.reduce((s, a) => s + a.onIssue, 0)}    Available: ${assets.reduce((s, a) => s + a.available, 0)}    Acquisition value: ${pesoPdf(totalValue)}`,
    40, 100
  );

  let y = 124;
  // Widths total 762pt — A4 landscape (842) less two 40pt margins. Exceeding
  // it silently runs the right-hand columns off the page.
  const cols = [
    { k: "assetTag", label: "Asset Tag", w: 74, align: "left" },
    { k: "name", label: "Item", w: 116, align: "left" },
    { k: "typeName", label: "Type", w: 60, align: "left" },
    { k: "categoryName", label: "Category", w: 82, align: "left" },
    { k: "subcategoryName", label: "Sub-Category", w: 82, align: "left" },
    { k: "serialNumber", label: "Serial", w: 74, align: "left" },
    { k: "site", label: "Site", w: 60, align: "left" },
    { k: "qty", label: "Qty", w: 30 },
    { k: "onIssue", label: "On Issue", w: 44 },
    { k: "available", label: "Avail.", w: 38 },
    { k: "condition", label: "Condition", w: 48, align: "left" },
    { k: "status", label: "Status", w: 54, align: "left" },
  ];

  const drawRow = (vals2, opts = {}) => {
    let x = 40;
    if (opts.header) doc.rect(40, y - 2, cols.reduce((s, c) => s + c.w, 0), 16).fill("#EEF2F7");
    cols.forEach((c, idx) => {
      doc.font(opts.header ? "Helvetica-Bold" : "Helvetica")
        .fillColor(opts.header ? NAVY : "#1a1a1a").fontSize(opts.header ? 8 : 8.5)
        .text(String(vals2[idx] ?? ""), x + 2, y + 2, { width: c.w - 4, align: c.align || "right", ellipsis: true });
      x += c.w;
    });
    y += 15;
    if (y > doc.page.height - 46) { doc.addPage({ size: "A4", layout: "landscape", margin: 40 }); y = 46; }
  };

  drawRow(cols.map((c) => c.label), { header: true });
  if (!assets.length) {
    doc.font("Helvetica").fillColor(MUTE).fontSize(9).text("No assets match this view.", 40, y + 6);
  }
  for (const a of assets) {
    drawRow(cols.map((c) => {
      if (c.k === "qty") return a.trackingMode === "Bulk" ? String(a.quantity) : "1";
      if (c.k === "onIssue") return String(a.onIssue);
      if (c.k === "available") return String(a.available);
      return a[c.k] ?? "";
    }));
  }

  stampAuthorFooter(doc, lh.companyName);


  doc.end();
}));

module.exports = router;
