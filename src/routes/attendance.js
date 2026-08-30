const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole, permissionsFor } = require("../middleware/auth");
const { ATTENDANCE_EDIT_ROLES, labelForRole, can } = require("../lib/permissions");
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
 * Does this user hold DELETE on attendance?
 *
 * Resolved explicitly rather than read off req.moduleGrant, because
 * modulePermission() derives the action from the HTTP METHOD: a GET asks about
 * `view` and a PATCH about `edit`. The retire / restore / list-retired trio all
 * belong to the same privilege as the delete itself, and two of them are not
 * DELETE requests — so trusting moduleGrant there would gate the restore on
 * `edit` and the retired list on `view`, which is not what either means.
 */
async function hasAttendanceDelete(req) {
  if (req.user.role === "Admin") return true;
  return can(await permissionsFor(req.user), "attendance", "delete");
}

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
            a."siteMismatch", a."rosteredSite", a."reliefDeclared",
            src."hasEvidence" AS "correctionHasEvidence"
     FROM attendance_records a
     LEFT JOIN LATERAL (
       SELECT (m."selfieMimetype" IS NOT NULL
               OR m.latitude IS NOT NULL
               OR EXISTS (SELECT 1 FROM missing_timelog_attachments t WHERE t.request_id = m.id)
              ) AS "hasEvidence"
       FROM missing_timelog_requests m WHERE m.id = a."correctionRequestId"
     ) src ON true
     WHERE a."deletedAt" IS NULL
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
    // Every card counts LIVE punches only - a retired one is not a record of
    // work and must not inflate a total on the page it was removed from.
    pool.query(`SELECT COUNT(*)::int total FROM attendance_records WHERE "deletedAt" IS NULL`),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE "punchType" = 'IN')::int ins,
         COUNT(*) FILTER (WHERE "punchType" = 'OUT')::int outs
       FROM attendance_records WHERE "deletedAt" IS NULL AND "punchAt"::date = $1`, [today]
    ),
    pool.query(`SELECT site, COUNT(*)::int c FROM attendance_records
                 WHERE "deletedAt" IS NULL GROUP BY site ORDER BY c DESC`),
  ]);
  res.json({
    total: totals.rows[0].total,
    todayIn: todayCounts.rows[0].ins,
    todayOut: todayCounts.rows[0].outs,
    bySite: bySite.rows,
  });
});

/**
 * The guards the register's filter dropdown offers.
 *
 * Served by the ATTENDANCE module, deliberately. The register used to read
 * /leave/employees, which is gated by Leave Management — so a user holding
 * attendance but not leave got a page that loaded with an EMPTY guard list and
 * no way to scope the register to one person. Measured: attendance 200, the
 * guard list 403.
 *
 * A screen should not need a second module's permission to populate its own
 * filter. This also stops the register pulling leave balances it never renders.
 *
 * Name, number and id only — the register shows "Full Name (Employee No)" and
 * filters on the name. No pay, no government IDs, no contact details: the 201
 * File is not exposed through an attendance filter.
 */
router.get("/_all/guards", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, "fullName", "employeeNo" FROM employees
      WHERE "employmentStatus" = 'Active'
      ORDER BY "fullName"`
  );
  res.json(rows);
}));

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
    `SELECT id, "guardName", site, "punchType", "punchAt", "deletedAt", "employeeNo",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS "phDate",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS "phStamp"
     FROM attendance_records WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Attendance record not found." });
  // A retired punch is not editable. Restore it first - otherwise the edit would
  // change a record that reaches no report, and would only take effect if
  // somebody later restored it.
  if (rec.deletedAt) {
    return res.status(409).json({
      error: "This record was deleted. Restore it before editing.",
      reason: "record_deleted",
    });
  }

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
            "siteResolvedBy" = NULL, "siteResolvedAt" = NULL,
            -- Same reasoning for the relief declaration: the guard declared
            -- cover at the site they PUNCHED, and an admin has just moved the
            -- record to a different one. Carrying it across would assert cover
            -- at a post nobody declared, and would suppress the held-for-review
            -- state on a site the guard never stood at.
            "reliefDeclared" = NULL
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

/**
 * The punch as it stood, plus the duty it belonged to and the hours it made.
 *
 * Written into the audit BEFORE the row is retired, because afterwards the log
 * is the only place that reads as a sentence. "Record 412 deleted" is not
 * enough to tell whether a deletion was right; who, at which post, for whose
 * shift, and how many hours it was worth — that is.
 *
 * The counterpart punch is looked up so the entry can state the PAIR: deleting
 * one half of a day is what actually moves a client's bill, and the surviving
 * half is what makes the loss visible on the next recompute.
 */
async function deletionSnapshot(rec, user) {
  const { duty, dutyDate } = await dutyForPunch(pool, rec.guardName, rec.punchAt, rec.punchType);

  // The nearest opposite punch on the same guard and site, within a day either
  // way — enough to describe the pair without pretending to re-run the matcher.
  const mate = (await pool.query(
    `SELECT "punchType", "punchAt",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS ph
       FROM attendance_records
      WHERE "deletedAt" IS NULL AND id <> $1
        AND "punchType" <> $2
        AND lower(regexp_replace(btrim("guardName"), '\\s+', ' ', 'g'))
          = lower(regexp_replace(btrim($3), '\\s+', ' ', 'g'))
        AND lower(regexp_replace(btrim(site), '\\s+', ' ', 'g'))
          = lower(regexp_replace(btrim($4), '\\s+', ' ', 'g'))
        AND "punchAt" BETWEEN $5::timestamptz - INTERVAL '1 day'
                          AND $5::timestamptz + INTERVAL '1 day'
      ORDER BY abs(extract(epoch FROM ("punchAt" - $5::timestamptz))) LIMIT 1`,
    [rec.id, rec.punchType, rec.guardName, rec.site, rec.punchAt]
  )).rows[0] || null;

  let hours = null;
  if (mate) {
    const a = new Date(rec.punchAt).getTime(), b = new Date(mate.punchAt).getTime();
    const span = Math.abs(b - a) / 3600000;
    // Only meaningful when this punch and its mate are the right way round.
    const ordered = rec.punchType === "IN" ? b > a : a > b;
    if (ordered) hours = Math.round(span * 100) / 100;
  }

  return {
    punch: {
      id: rec.id, guardName: rec.guardName, employeeNo: rec.employeeNo || null,
      site: rec.site, punchType: rec.punchType, punchAtPh: rec.phStamp,
      siteMismatch: rec.siteMismatch === true, rosteredSite: rec.rosteredSite || null,
      createdBy: rec.createdBy || null,
    },
    duty: duty
      ? { dutyDate, shiftName: duty.shiftName || "", site: duty.site,
          startTime: duty.startTime, endTime: duty.endTime, crossesMidnight: !!duty.crossesMidnight }
      : null,
    pair: mate ? { withType: mate.punchType, atPh: mate.ph, hours } : null,
    by: { id: user.id, username: user.username, role: user.role, roleLabel: labelForRole(user.role) },
  };
}

/**
 * Retire a punch. SOFT delete — the row stays, `deletedAt` is stamped.
 *
 * A punch is evidence of a guard's day and it drives what a client is billed, so
 * removing the row outright made a mistaken deletion unrecoverable and left the
 * Live Feed with nothing to show but the fact that something had gone. Every
 * read filters `deletedAt IS NULL`, so a retired punch reaches no report, no
 * payslip and no statement — and the row, its selfie and its coordinates are
 * still there to restore.
 *
 * The permission is UNCHANGED: `perm.delete`, granted per user from Manage
 * Users. This makes the action reversible and the trail sufficient; it does not
 * re-gate who may take it.
 */
router.delete("/:id", requireAuth, requireRole(), wrap(async (req, res) => {
  if (req.user.role !== "Admin" && req.moduleGrant !== true) {
    return res.status(403).json({ error: "You don't have permission to delete attendance records." });
  }

  const rec = (await pool.query(
    `SELECT id, "guardName", "employeeNo", site, "punchType", "punchAt", "createdBy",
            "siteMismatch", "rosteredSite", "deletedAt",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD') AS "phDate",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "phStamp"
       FROM attendance_records WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Attendance record not found." });
  if (rec.deletedAt) return res.json({ ok: true, alreadyDeleted: true });

  // Snapshot BEFORE the write, while the row still reads as it did.
  const snap = await deletionSnapshot(rec, req.user);
  const periods = await periodsCovering(rec.phDate, [rec.site]);

  await pool.query(
    `UPDATE attendance_records SET "deletedAt" = now(), "deletedBy" = $2 WHERE id = $1`,
    [rec.id, req.user.username]
  );

  try {
    await pool.query(
      `INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)`,
      [`ATT-${String(rec.id).padStart(4, "0")}`, req.user.username, "attendance_record_deleted",
        `${snap.by.roleLabel} deleted ${rec.punchType} punch for ${rec.guardName}`
        + `${rec.employeeNo ? ` (${rec.employeeNo})` : ""} at "${rec.site}" on ${rec.phStamp}. `
        + (snap.duty
          ? `Duty: ${snap.duty.dutyDate} ${snap.duty.shiftName || ""} ${snap.duty.startTime}-${snap.duty.endTime}`
            + `${snap.duty.crossesMidnight ? " (+1d)" : ""} at "${snap.duty.site}". `
          : "No rostered duty matched this punch. ")
        + (snap.pair
          ? `Paired with ${snap.pair.withType} at ${snap.pair.atPh}`
            + `${snap.pair.hours != null ? `, ${snap.pair.hours} h` : ""}. `
          : "No counterpart punch. ")
        + (periods.length
          ? `Affects billing period(s): ${periods.map((p) => `${p.id} (${p.status})`).join(", ")}. `
          : "")
        + `Recoverable: restore record ${rec.id}. ` + JSON.stringify(snap)],
    );
  } catch (e) {
    console.error("[attendance] delete audit write failed:", e.message);
  }

  res.json({
    ok: true, deleted: true, id: rec.id,
    snapshot: snap,
    affectedPeriods: periods.map((p) => ({ id: p.id, clientName: p.clientName, status: p.status })),
  });
}));

/**
 * Put a retired punch back. The other half of making delete reversible: without
 * it the Live Feed can only show that something was removed, never undo it.
 *
 * Gated on the same privilege as the delete, so whoever can retire a punch can
 * also put it back — a restore is strictly less destructive than the delete it
 * reverses, and needing a second person to undo your own mistake is what makes
 * people avoid reporting it.
 */
// requireRole() is deliberately ABSENT. "restore" is in the WORKFLOW pattern in
// permissions.js, so modulePermission withholds req.moduleGrant on this path and
// a bare requireRole() would refuse everyone but Admin. That exemption exists so
// a workflow step keeps the ROUTE's own check as the decisive one — and
// hasAttendanceDelete() below is that check, stated explicitly rather than
// inherited from the method-to-action mapping.
router.patch("/:id/restore", requireAuth, wrap(async (req, res) => {
  if (!(await hasAttendanceDelete(req))) {
    return res.status(403).json({ error: "You don't have permission to restore attendance records." });
  }

  const rec = (await pool.query(
    `SELECT id, "guardName", site, "punchType", "deletedAt", "deletedBy",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD') AS "phDate",
            to_char("punchAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "phStamp"
       FROM attendance_records WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Attendance record not found." });
  if (!rec.deletedAt) return res.json({ ok: true, alreadyLive: true });

  await pool.query(
    `UPDATE attendance_records SET "deletedAt" = NULL, "deletedBy" = NULL WHERE id = $1`, [rec.id]);

  const periods = await periodsCovering(rec.phDate, [rec.site]);
  try {
    await pool.query(
      `INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)`,
      [`ATT-${String(rec.id).padStart(4, "0")}`, req.user.username, "attendance_record_restored",
        `${labelForRole(req.user.role)} restored ${rec.punchType} punch for ${rec.guardName} `
        + `at "${rec.site}" on ${rec.phStamp}, deleted by ${rec.deletedBy || "unknown"}. `
        + (periods.length
          ? `Recompute the draft period(s) to bill it again: ${periods.map((p) => p.id).join(", ")}.`
          : "It falls in no billing period yet.")],
    );
  } catch (e) {
    console.error("[attendance] restore audit write failed:", e.message);
  }

  // Nothing is repriced by the restore itself; billing reads punches live at
  // compute time, so the hours return to a statement on the next recompute.
  res.json({
    ok: true, restored: true, id: rec.id,
    affectedPeriods: periods.map((p) => ({ id: p.id, clientName: p.clientName, status: p.status })),
  });
}));

/**
 * The retired punches, so a deletion can be found and reversed.
 *
 * Same privilege as delete and restore: this is the list you act on.
 */
// Same reasoning as the restore above: the privilege is stated here, not
// derived from the HTTP method.
router.get("/_all/deleted", requireAuth, wrap(async (req, res) => {
  if (!(await hasAttendanceDelete(req))) {
    return res.status(403).json({ error: "You don't have permission to view deleted attendance records." });
  }
  const { rows } = await pool.query(
    `SELECT id, "employeeNo", "guardName", site, "punchType", "punchAt", "deletedBy",
            to_char("deletedAt" AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "deletedAtPh",
            to_char("punchAt"  AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS "punchAtPh"
       FROM attendance_records
      WHERE "deletedAt" IS NOT NULL
      ORDER BY "deletedAt" DESC LIMIT 500`
  );
  res.json(rows);
}));

module.exports = router;
