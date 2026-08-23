const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { ATTENDANCE_EDIT_ROLES, labelForRole } = require("../lib/permissions");
const { evaluateSite } = require("../lib/siteMismatch");
const { dutyForPunch } = require("../lib/dutyForPunch");

const router = express.Router();

// Express 4 does not catch a rejected promise from a route handler: the request
// simply hangs. Every async handler below is wrapped.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[attendance] ${req.method} ${req.originalUrl} failed:`, e);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
});

const norm = (s) => String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Editing a punch is a BILLING action, gated by an EXPLICIT ROLE ALLOWLIST.
 *
 * Not the module matrix: modulePermission() maps PATCH to "edit", and four
 * roles hold edit on attendance that must not have this — HR, Accounting /
 * Payroll, Inspector / Investigator and the legacy Investigator. Not `delete`
 * either, since that is a matrix cell a per-user override can grant from the
 * Manage Users screen; widening who may move money between clients has to mean
 * editing ATTENDANCE_EDIT_ROLES, where it is visible in review.
 *
 * The list lives in permissions.js so the exact role strings are written once —
 * a typo in a copy of one would be a silent access hole, not a crash.
 */
function requireAttendanceEditRights(req, res) {
  if (ATTENDANCE_EDIT_ROLES.includes(req.user.role)) return true;
  res.status(403).json({
    error: "Your role cannot correct an attendance record. Changing a record's site moves "
      + "billable hours between clients, so it is limited to the System Administrator "
      + "and the Operations role.",
    reason: "role_not_allowed",
    role: labelForRole(req.user.role),
  });
  return false;
}

/**
 * The billing periods that cover this punch, for whichever clients could bill
 * it — the site it is on now and the site it would move to.
 *
 * A cross-client site edit touches TWO periods: the hours leave one statement
 * and arrive on another. Both have to be checked, or an edit could be refused
 * on one side and silently applied on the other.
 *
 * Sites are matched the way billing matches them — case- and whitespace-
 * insensitively — because `billing_sites.site` and `attendance_records.site`
 * are free text that has to agree by name.
 */
async function periodsCovering(punchPhDate, sites) {
  const keys = [...new Set(sites.filter(Boolean).map(norm))];
  if (!keys.length) return [];
  // EXISTS, not a join: one client owning BOTH the old and the new site would
  // otherwise return its period once per matching site, listing the same period
  // twice on screen and in the audit detail.
  const { rows } = await pool.query(
    `SELECT bp.id, bp.status, bp."soaNo", bc.name AS "clientName",
            to_char(bp."periodStart",'YYYY-MM-DD') AS "periodStart",
            to_char(bp."periodEnd",'YYYY-MM-DD') AS "periodEnd"
     FROM billing_periods bp
     JOIN billing_clients bc ON bc.id = bp."clientId"
     WHERE $2::date BETWEEN bp."periodStart" AND bp."periodEnd"
       AND EXISTS (
         SELECT 1 FROM billing_sites bs
         WHERE bs."clientId" = bp."clientId"
           AND lower(regexp_replace(btrim(bs.site), '\\s+', ' ', 'g')) = ANY($1)
       )
     ORDER BY bp.id`,
    [keys, punchPhDate]
  );
  return rows;
}

// List attendance records (metadata only, no selfie blobs). Any authenticated
// user can view the register; selfie image is fetched on demand.
router.get("/", requireAuth, async (req, res) => {
  // The LATERAL join answers one question the register cannot answer alone: a
  // punch created by an approved correction has no selfie of its own, but the
  // REQUEST behind it may carry one — plus coordinates and attachments. Both
  // are optional on that form, so a correction request may equally carry
  // nothing, and the register must not offer a link to an empty page.
  const { rows } = await pool.query(
    `SELECT a.id, a."employeeNo", a."guardName", a.site, a."punchType", a."punchAt", a."selfieMimetype",
            a.latitude, a.longitude, a."createdBy", a."createdAt", a."correctionRequestId",
            -- Surfaced so the register can show a held day where it is, beside
            -- the site that caused it. The flag is stamped at submission and
            -- restamped whenever an admin corrects the site.
            a."siteMismatch", a."rosteredSite",
            src."hasEvidence" AS "correctionHasEvidence"
     FROM attendance_records a
     LEFT JOIN LATERAL (
       SELECT (m."selfieMimetype" IS NOT NULL
               OR m.latitude IS NOT NULL
               OR EXISTS (SELECT 1 FROM missing_timelog_attachments t WHERE t.request_id = m.id)
              ) AS "hasEvidence"
       FROM missing_timelog_requests m WHERE m.id = a."correctionRequestId"
     ) src ON true
     ORDER BY a."punchAt" DESC`
  );
  // Attach a convenience Google Maps link (no external service needed).
  const withLinks = rows.map(r => ({
    ...r,
    hasSelfie: !!r.selfieMimetype,
    // Only true when the punch came from a correction AND that request really
    // holds something to look at. Anything else keeps the plain empty state.
    correctionHasEvidence: !!r.correctionRequestId && r.correctionHasEvidence === true,
    mapsUrl: (r.latitude != null && r.longitude != null)
      ? `https://maps.google.com/?q=${r.latitude},${r.longitude}`
      : null,
  }));
  res.json(withLinks);
});

// Summary stats for the register cards.
router.get("/_all/stats", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [totals, todayCounts, bySite] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int total FROM attendance_records`),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE "punchType" = 'IN')::int ins,
         COUNT(*) FILTER (WHERE "punchType" = 'OUT')::int outs
       FROM attendance_records WHERE "punchAt"::date = $1`, [today]
    ),
    pool.query(`SELECT site, COUNT(*)::int c FROM attendance_records GROUP BY site ORDER BY c DESC`),
  ]);
  res.json({
    total: totals.rows[0].total,
    todayIn: todayCounts.rows[0].ins,
    todayOut: todayCounts.rows[0].outs,
    bySite: bySite.rows,
  });
});

// Serve a selfie image. Authenticated (unlike the company logo, a guard selfie
// is personal data, so it stays behind auth and is loaded via the app's
// blob-fetch helper, not a bare <img src>).
router.get("/:id/selfie", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT "selfieData", "selfieMimetype" FROM attendance_records WHERE id = $1`, [req.params.id]
  );
  const row = rows[0];
  if (!row || !row.selfieData) return res.status(404).json({ error: "No selfie for this record." });
  res.set("Content-Type", row.selfieMimetype);
  res.set("Cache-Control", "no-cache");
  res.send(row.selfieData);
});

/**
 * Correct the SITE or the RECORD TYPE on an existing punch.
 *
 * Guards pick both on the public form, and both are sometimes wrong: a relief
 * guard selects their home post, or taps Time In when they meant Time Out.
 * Correcting them BEFORE the period is billed is the normal, frictionless path
 * — edit, recompute, done.
 *
 * What this route will not do:
 *
 *   - touch a record inside an ISSUED or PAID period. A statement that has gone
 *     to a client is immutable in-system and there is no reopen-to-edit path
 *     here; a dispute is settled outside CSOMS. Enforced HERE, not on the
 *     button, because a stale tab or a direct request must not get through.
 *   - suppress the site-mismatch hold. If the corrected site disagrees with the
 *     roster the flag fires exactly as it does on a public submission; the
 *     admin resolves it by making the ROSTER agree, through the existing
 *     Resolve-site flow. The check is the safety mechanism — we satisfy it, we
 *     never bypass it.
 *   - make an incomplete day billable. Editing the site of a punch whose
 *     time-out is missing corrects the site and nothing else; the day stays
 *     held until the OUT exists.
 *
 * Nothing here re-prices anything. Billing reads punches live at compute time,
 * so an edit reaches a statement only when someone recomputes the DRAFT period
 * — which is why the response names the periods that now need it.
 */
router.patch("/:id", requireAuth, requireRole(), wrap(async (req, res) => {
  if (!requireAttendanceEditRights(req, res)) return;

  const rec = (await pool.query(
    `SELECT id, "guardName", site, "punchType", "punchAt",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS "phDate",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS "phStamp"
     FROM attendance_records WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Attendance record not found." });

  // Absent means unchanged; present means set. Sending only one field must not
  // blank the other.
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
  const nextSite = has("site") ? String(req.body.site || "").trim() : rec.site;
  const nextType = has("punchType") ? String(req.body.punchType || "").trim().toUpperCase() : rec.punchType;

  if (!["IN", "OUT"].includes(nextType)) {
    return res.status(400).json({ error: "Record must be either Time IN or Time OUT." });
  }
  // Never trust the dropdown — the same rule the public form follows. An
  // unknown site would flow into billing as a detachment name matching no
  // client, and the hours would reach no statement at all.
  if (!nextSite) return res.status(400).json({ error: "Please choose the site." });
  if (norm(nextSite) !== norm(rec.site)) {
    const known = await pool.query("SELECT name FROM sites WHERE name = $1", [nextSite]);
    if (known.rowCount === 0) {
      return res.status(400).json({ error: "That site is not on the configured Sites / Facilities list." });
    }
  }

  const siteChanged = norm(nextSite) !== norm(rec.site);
  const typeChanged = nextType !== rec.punchType;
  if (!siteChanged && !typeChanged) return res.json({ ok: true, unchanged: true });

  // FREEZE. Both the site it is leaving and the site it is arriving at, since a
  // cross-client move lands on two statements.
  const periods = await periodsCovering(rec.phDate, [rec.site, nextSite]);
  const frozen = periods.filter((p) => p.status === "Issued" || p.status === "Paid");
  if (frozen.length) {
    const names = [...new Set(frozen.map((p) => `${p.clientName}${p.soaNo ? ` (${p.soaNo})` : ""}`))];
    return res.status(409).json({
      error: "This record is part of an issued Statement of Account and cannot be edited. "
        + "Disputes are handled outside CSOMS.",
      reason: "period_frozen",
      periods: frozen.map((p) => ({ id: p.id, status: p.status, soaNo: p.soaNo, clientName: p.clientName })),
      detail: `Covered by ${names.join(", ")} for ${frozen[0].periodStart} to ${frozen[0].periodEnd}.`,
    });
  }

  // Re-evaluate the site against the roster, the same comparison the public
  // punch form makes at submission — and by the same shared rule.
  //
  // This used to look up the roster for the punch's OWN PH date, which is the
  // wrong day for anything that crosses midnight: a night shift's 06:00
  // time-out was compared against the NEXT day's duty. Correcting a record's
  // site would therefore restamp a FALSE mismatch, and computeReport drops a
  // flagged punch from the matching index, so the duty lost its time-out.
  // Resolved to the one duty that owns the punch — see lib/dutyForPunch.js.
  const { duty } = await dutyForPunch(pool, rec.guardName, rec.punchAt, nextType);
  const { mismatch, rosteredSite } = evaluateSite(nextSite, duty ? [duty.site] : []);

  await pool.query(
    `UPDATE attendance_records
        SET site = $1, "punchType" = $2, "siteMismatch" = $3, "rosteredSite" = $4,
            -- A previous resolution described the OLD site and says nothing
            -- about this one, so it is cleared rather than carried across.
            "siteResolvedBy" = NULL, "siteResolvedAt" = NULL
      WHERE id = $5`,
    [nextSite, nextType, mismatch, rosteredSite, rec.id]
  );

  // Audited because it moves money. Old value beside the new one, as the ops
  // records do — afterwards the log is the only place the previous value
  // exists. Swallows its own errors: an audit write must never fail the action
  // it is describing.
  const changes = [];
  if (siteChanged) changes.push(`site "${rec.site}" -> "${nextSite}"`);
  if (typeChanged) changes.push(`record ${rec.punchType} -> ${nextType}`);
  try {
    await pool.query(
      "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
      [`ATT-${String(rec.id).padStart(4, "0")}`, req.user.username,
        siteChanged ? "attendance_record_site_changed" : "attendance_record_type_changed",
        `${rec.guardName} punch of ${rec.phStamp}: ${changes.join("; ")}.`
        + (mismatch ? ` Site now disagrees with the roster (${rosteredSite}) and is held for review.` : "")
        + (periods.length ? ` Affects draft period(s): ${periods.map((p) => p.id).join(", ")}.` : "")],
    );
  } catch (e) {
    console.error("[attendance] audit write failed:", e.message);
  }

  res.json({
    ok: true,
    site: nextSite, punchType: nextType,
    siteMismatch: mismatch, rosteredSite,
    // The register turns these into "recompute to apply". Draft only — a frozen
    // period never reaches this line.
    affectedPeriods: periods.map((p) => ({ id: p.id, clientName: p.clientName, status: p.status })),
  });
}));

// Delete a record - Admin only.
router.delete("/:id", requireAuth, requireRole(), async (req, res) => {
  // Deletion is Admin-only UNLESS an administrator has explicitly granted
  // this user the delete privilege for this module (req.moduleGrant, set by
  // modulePermission). Without that, the Access Privileges screen could
  // grant a delete that this line would silently overrule.
  if (req.user.role !== "Admin" && req.moduleGrant !== true) return res.status(403).json({ error: "Only an Admin can delete attendance records." });
  await pool.query("DELETE FROM attendance_records WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
