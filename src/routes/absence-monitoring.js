const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { computeReport } = require("./attendance-reports");
const { evaluateSite } = require("../lib/siteMismatch");

const router = express.Router();

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Main absence-monitoring payload for a date range:
//  - absences: true unexplained absences (missed shift, no IN punch)
//  - noTimeouts: timed in but never out
//  - patterns: repeat absentees, per-guard counts, per-site concentration
//  - each item is merged with any saved follow-up (status + remark)
router.get("/", requireAuth, async (req, res) => {
  const { from, to, site, guard } = req.query;
  const grace = Math.max(0, parseInt(req.query.grace, 10) || 15);
  const otThreshold = Math.max(0, parseInt(req.query.otThreshold, 10) || 30);
  if (!from || !to) return res.status(400).json({ error: "A from and to date are required." });

  // Reuse the shared attendance classification engine (same source of truth as
  // the attendance report), then derive the two absence categories from it.
  const { rows } = await computeReport({ from, to, site, guard, grace, otThreshold });

  const absences = rows
    .filter((r) => r.status === "Absent")
    .map((r) => ({ dutyDate: r.dutyDate, guardName: r.guardName, site: r.site, shiftName: r.shiftName, kind: "absence" }));

  const noTimeouts = rows
    .filter((r) => r.status !== "Absent" && r.status !== "On Leave" && r.status !== "Rest Day"
      && Array.isArray(r.flags) && r.flags.includes("No time-out"))
    .map((r) => ({
      dutyDate: r.dutyDate, guardName: r.guardName, site: r.site, shiftName: r.shiftName,
      timeIn: r.timeIn, kind: "no_timeout"
    }));

  // Merge saved follow-ups for everything in range.
  const followupRows = (await pool.query(
    `SELECT "guardKey", to_char("dutyDate", 'YYYY-MM-DD') AS "dutyDate", kind, status, remark, "updatedBy",
            to_char("updatedAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS "updatedAt"
     FROM absence_followups
     WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date`,
    [from, to]
  )).rows;
  const fMap = new Map();
  for (const f of followupRows) fMap.set(`${f.guardKey}|${f.dutyDate}|${f.kind}`, f);
  function attach(item) {
    const f = fMap.get(`${norm(item.guardName)}|${item.dutyDate}|${item.kind}`);
    return { ...item, status: f ? f.status : "Pending", remark: f ? f.remark : "", updatedBy: f ? f.updatedBy : null, updatedAt: f ? f.updatedAt : null };
  }
  const absencesOut = absences.map(attach);
  const noTimeoutsOut = noTimeouts.map(attach);

  // Patterns (absences only — the actionable category).
  const byGuard = new Map();
  const bySite = new Map();
  for (const a of absences) {
    byGuard.set(a.guardName, (byGuard.get(a.guardName) || 0) + 1);
    const s = a.site || "(no site)";
    bySite.set(s, (bySite.get(s) || 0) + 1);
  }
  const repeatAbsentees = [...byGuard.entries()]
    .map(([guardName, count]) => ({ guardName, count }))
    .sort((a, b) => b.count - a.count);
  const siteConcentration = [...bySite.entries()]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    from, to, site: site || null, guard: guard || null,
    summary: {
      absences: absencesOut.length,
      noTimeouts: noTimeoutsOut.length,
      pendingAbsences: absencesOut.filter((a) => a.status === "Pending").length,
      repeatAbsenteeCount: repeatAbsentees.filter((r) => r.count > 1).length,
    },
    absences: absencesOut,
    noTimeouts: noTimeoutsOut,
    patterns: { repeatAbsentees, siteConcentration },
  });
});

// Upsert a follow-up for one absence/no-timeout item.
// Body: { guardName, dutyDate, kind, site, status, remark }
router.put("/followup", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const b = req.body || {};
  if (!b.guardName || !b.dutyDate) return res.status(400).json({ error: "Guard and date are required." });
  const kind = b.kind === "no_timeout" ? "no_timeout" : "absence";
  const status = ["Pending", "Excused", "Actioned"].includes(b.status) ? b.status : "Pending";
  const guardKey = norm(b.guardName);

  const { rows } = await pool.query(
    `INSERT INTO absence_followups ("guardKey", "guardName", site, "dutyDate", kind, status, remark, "updatedBy", "updatedAt")
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8, now())
     ON CONFLICT ("guardKey", "dutyDate", kind)
     DO UPDATE SET status = EXCLUDED.status, remark = EXCLUDED.remark, site = EXCLUDED.site,
                   "guardName" = EXCLUDED."guardName", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()
     RETURNING id, status, remark`,
    [guardKey, b.guardName, b.site || "", b.dutyDate, kind, status, (b.remark || "").trim(), req.user.username]
  );
  res.json({ ok: true, ...rows[0] });
});

// ---- Missing Time Log Requests (admin review) -----------------------------

// List requests, optional ?status= filter.
router.get("/missing-timelog", requireAuth, async (req, res) => {
  const { status } = req.query;
  const clauses = []; const vals = []; let i = 1;
  if (status) { clauses.push(`status = $${i++}`); vals.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // The guard's SCHEDULED shift for that duty date comes back with each row so
  // the approval form can default the corrected times to the shift actually
  // rostered. Without it the form guessed a day shift, and approving a night
  // shift with 06:00/18:00 produced punches outside the shift's matching
  // window — the day stayed "Absent" despite an approved correction.
  // Matched on normalized guard name, the same key the attendance report uses.
  const { rows } = await pool.query(
    `SELECT m.id, m."employeeId", m."employeeNo", m."guardName", m.site,
            to_char(m."dutyDate", 'YYYY-MM-DD') AS "dutyDate",
            m."missingType", m.reason, m.status,
            -- Render in Manila time. to_char on a timestamptz formats in the
            -- SESSION timezone, which is UTC on the server, so an 18:00 PH
            -- correction was being shown to the admin as 10:00.
            to_char(m."approvedInAt"  AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI') AS "approvedInAt",
            to_char(m."approvedOutAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI') AS "approvedOutAt",
            m."reviewedBy", m."reviewNote", m."createdAt",
            -- The manually chosen duty site, and whether it agreed with the
            -- roster. A disagreement holds the record out of billing, so the
            -- reviewer has to see it and act on it, not merely notice it.
            m."siteMismatch", m."rosteredSite", m."siteResolvedBy",
            to_char(m."siteResolvedAt" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS "siteResolvedAt",
            -- Metadata only. The image and the files are fetched on demand by
            -- the two routes below, so the list stays light.
            (m."selfieMimetype" IS NOT NULL) AS "hasSelfie",
            m.latitude, m.longitude,
            (SELECT count(*)::int FROM missing_timelog_attachments a WHERE a.request_id = m.id) AS "attachmentCount",
            s."shiftName"       AS "shiftName",
            s."startTime"       AS "shiftStart",
            s."endTime"         AS "shiftEnd",
            s."crossesMidnight" AS "shiftCrossesMidnight"
     FROM missing_timelog_requests m
     LEFT JOIN LATERAL (
       SELECT sa."shiftName", sa."startTime", sa."endTime", sa."crossesMidnight"
       FROM shift_assignments sa
       WHERE sa."dutyDate" = m."dutyDate"
         AND lower(regexp_replace(btrim(sa."guardName"), '\\s+', ' ', 'g'))
           = lower(regexp_replace(btrim(m."guardName"), '\\s+', ' ', 'g'))
       ORDER BY sa.id LIMIT 1
     ) s ON true
     ${where.replace(/\bstatus\b/g, 'm.status')} ORDER BY m."createdAt" DESC`, vals
  );
  res.json(rows);
});

// --- Selfie and supporting files -------------------------------------------
//
// Authenticated, like the attendance selfie route: a guard's photograph and
// whatever they attached are not public just because the form that collected
// them was.
//
// Both serve Content-Disposition: attachment with the SNIFFED type recorded at
// upload. Never inline — these bytes arrived from an unauthenticated form, and
// rendering an attacker-supplied PDF or SVG inside an administrator's
// authenticated session is the one thing that turns opaque storage into a
// live risk. nosniff stops the browser second-guessing the type.
router.get("/missing-timelog/:id/selfie", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT "selfieData", "selfieMimetype", "guardName" FROM missing_timelog_requests WHERE id = $1`,
    [req.params.id]
  )).rows[0];
  if (!row || !row.selfieData) return res.status(404).json({ error: "No selfie on this request." });
  res.setHeader("Content-Type", row.selfieMimetype || "image/jpeg");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition",
    `attachment; filename="selfie-MTL-${String(req.params.id).padStart(4, "0")}.jpg"`);
  res.send(row.selfieData);
});

router.get("/missing-timelog/:id/attachments/:attId", requireAuth, async (req, res) => {
  const row = (await pool.query(
    `SELECT filename, mimetype, data FROM missing_timelog_attachments
      WHERE id = $1 AND request_id = $2`,
    [req.params.attId, req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Attachment not found." });
  res.setHeader("Content-Type", row.mimetype);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Quotes stripped from the filename so a crafted name cannot break out of the
  // header — it came from a public form and is the submitter's own text.
  res.setHeader("Content-Disposition",
    `attachment; filename="${String(row.filename).replace(/["\r\n]/g, "")}"`);
  res.send(row.data);
});

// Metadata for the attachment list, so the review row can name the files
// without pulling their bytes.
router.get("/missing-timelog/:id/attachments", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, filename, mimetype, size, uploaded_at FROM missing_timelog_attachments
      WHERE request_id = $1 ORDER BY id`, [req.params.id]
  );
  res.json(rows);
});

// --- Resolving a site disagreement -----------------------------------------
//
// The record is held out of billing while siteMismatch is true. Clearing it is
// what returns the day to the statement, so it is a deliberate act by a named
// person, recorded in the audit log beside the flag that was raised.
//
// The admin's job before pressing this is to make the roster and the submission
// agree — either correct the roster in Shift Scheduling, or correct the site on
// the submission. This route does not guess which: it re-reads the roster and
// refuses to clear the flag while they still disagree, so the button cannot be
// used to make an unreconciled day billable.
router.patch("/missing-timelog/:id/resolve-site", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const row = (await pool.query(
    `SELECT id, "guardName", site, to_char("dutyDate",'YYYY-MM-DD') AS "dutyDate", "siteMismatch"
       FROM missing_timelog_requests WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Request not found." });
  if (row.siteMismatch !== true) return res.status(400).json({ error: "This request has no site disagreement to resolve." });

  const rostered = (await pool.query(
    `SELECT DISTINCT site FROM shift_assignments
      WHERE "dutyDate" = $1::date AND "guardName" = $2`,
    [row.dutyDate, row.guardName]
  )).rows.map((r) => r.site).filter(Boolean);

  const { mismatch, rosteredSite } = evaluateSite(row.site, rostered);
  if (mismatch) {
    return res.status(409).json({
      error: `The roster still says "${rosteredSite}" for ${row.guardName} on ${row.dutyDate}, ` +
             `but this request says "${row.site}". Correct one of them first.`,
      rosteredSite,
    });
  }

  await pool.query(
    `UPDATE missing_timelog_requests
        SET "siteMismatch" = false, "rosteredSite" = $2,
            "siteResolvedBy" = $3, "siteResolvedAt" = now()
      WHERE id = $1`,
    [row.id, rosteredSite, req.user.username]
  );
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [`MTL-${String(row.id).padStart(4, "0")}`, req.user.username, "site_mismatch_resolved",
     `Site reconciled to "${rosteredSite}" for ${row.guardName} on ${row.dutyDate}. Record returns to billing.`]
  );
  res.json({ ok: true, rosteredSite });
});

router.get("/missing-timelog/_stats", requireAuth, async (req, res) => {
  const r = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='Pending')::int pending,
            COUNT(*) FILTER (WHERE status='Approved')::int approved,
            COUNT(*) FILTER (WHERE status='Rejected')::int rejected,
            COUNT(*)::int total
     FROM missing_timelog_requests`
  )).rows[0];
  res.json(r);
});

// The admin enters times as PH-local 'YYYY-MM-DDTHH:MM' (datetime-local).
// Attendance punches are stored as UTC instants (real punches use now()), and
// the report builds shift windows in UTC from PH-local times. So the admin's
// local value must be converted to the matching UTC instant — otherwise the
// corrected punch lands 8h off and the report won't match it to the shift.
const PH_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8, no DST
function toUtcInstant(local) {
  const [datePart, timePart] = String(local).split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, m] = (timePart || "00:00").split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - PH_OFFSET_MS);
}
function addDaysISO(dateStr, n) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// Apply one review inside an existing transaction. Shared by the single-request
// route and the bulk endpoint so both behave identically — in particular the
// re-approval cleanup, which must never be reimplemented separately or the two
// paths will drift and start duplicating punches.
async function applyReview(client, rec, { decision, inAt, outAt, note, username }) {
  const isRedo = rec.status !== "Pending";

  // Reviewing a time-log request settles the matching absence follow-up too, so
  // the two views can't disagree about the same day. A missing IN (or both)
  // shows up as an unexplained absence; a missing OUT shows up under "timed in,
  // no time-out", so the follow-up is keyed to whichever category applies.
  const followupKind = rec.missingType === "OUT" ? "no_timeout" : "absence";
  // "SELECT *" hands back dutyDate as a JS Date; round-tripping that through a
  // ::date cast can land on the adjacent day depending on server timezone, which
  // would attach the follow-up to the wrong date. Format it explicitly instead.
  const dutyDateStr = rec.dutyDateStr
    || (rec.dutyDate instanceof Date
        ? new Date(rec.dutyDate.getTime() - rec.dutyDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
        : String(rec.dutyDate).slice(0, 10));
  async function settleFollowup(status) {
    await client.query(
      `INSERT INTO absence_followups ("guardKey","guardName",site,"dutyDate",kind,status,remark,"updatedBy","updatedAt")
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8, now())
       ON CONFLICT ("guardKey","dutyDate",kind)
       DO UPDATE SET status=EXCLUDED.status, remark=EXCLUDED.remark,
                     "updatedBy"=EXCLUDED."updatedBy", "updatedAt"=now()`,
      [norm(rec.guardName), rec.guardName, rec.site || "", dutyDateStr, followupKind, status,
       // Keep the guard's own explanation; append the reviewer's note if any.
       [rec.reason, note].filter(Boolean).join(" — "), username]
    );
  }

  if (decision === "Rejected") {
    await client.query(
      `UPDATE missing_timelog_requests
       SET status='Rejected', "reviewedBy"=$1, "reviewedAt"=now(), "reviewNote"=$2 WHERE id=$3`,
      [username, note, rec.id]
    );
    // Rejected: no correction is applied, so the day stays absent — but it has
    // been explained and ruled on, which is what Excused records.
    await settleFollowup("Excused");
    return { status: "Rejected" };
  }

  const needIn = rec.missingType === "IN" || rec.missingType === "BOTH";
  const needOut = rec.missingType === "OUT" || rec.missingType === "BOTH";

  // Re-approving: drop the punches the previous approval wrote, matched on the
  // exact instants it recorded, so the correction is replaced rather than
  // duplicated. Punches typed in by hand are untouched — only rows this flow
  // created carry the "correction:" prefix.
  if (isRedo) {
    for (const prev of [rec.approvedInAt, rec.approvedOutAt]) {
      if (!prev) continue;
      await client.query(
        `DELETE FROM attendance_records
         WHERE "guardName" = $1 AND "punchAt" = $2 AND "createdBy" LIKE 'correction:%'`,
        [rec.guardName, prev]
      );
    }
  }

  // The punch records WHICH request produced it. One parameter, and it covers
  // all three correction shapes at once: IN-only, OUT-only and BOTH run through
  // this same function, differing only in how many times it is called.
  //
  // The evidence itself stays on the request. A correction punch has no selfie
  // and no coordinates because none were taken for it; the register follows
  // this link to say so and to offer what the guard DID attach, instead of
  // showing a bare dash that reads as a broken image.
  const createPunch = (type, at) => client.query(
    `INSERT INTO attendance_records
      ("employeeNo","guardName",site,"punchType","punchAt","createdBy","correctionRequestId")
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [rec.employeeNo || "", rec.guardName, rec.site || "", type, toUtcInstant(at), `correction:${username}`, rec.id]
  );
  if (needIn) await createPunch("IN", inAt);
  if (needOut) await createPunch("OUT", outAt);

  await client.query(
    `UPDATE missing_timelog_requests
     SET status='Approved', "approvedInAt"=$1, "approvedOutAt"=$2, "timesNormalized"=true,
         "reviewedBy"=$3, "reviewedAt"=now(), "reviewNote"=$4 WHERE id=$5`,
    // Store the SAME UTC instants written to attendance_records.
    [needIn ? toUtcInstant(inAt) : null, needOut ? toUtcInstant(outAt) : null, username, note, rec.id]
  );
  // Approved: the punches now exist, so the day is corrected and no longer
  // needs chasing. Note the row also drops out of the Unexplained Absences
  // list entirely once the report re-runs, since it reads Present — this keeps
  // the follow-up record itself accurate for history and audit.
  await settleFollowup("Actioned");
  return { status: "Approved" };
}

// Approve or reject. On approval the admin supplies the actual time(s), and we
// create the corresponding attendance punch record(s). Datetimes are local
// 'YYYY-MM-DDTHH:MM' strings from the admin form.
// Body: { decision: 'Approved'|'Rejected', inAt, outAt, reviewNote }
router.patch("/missing-timelog/:id/review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "Approved" && decision !== "Rejected") {
    return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  }
  const note = (req.body?.reviewNote || "").trim();

  const rec = (await pool.query(
    `SELECT * FROM missing_timelog_requests WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!rec) return res.status(404).json({ error: "Request not found." });
  // An already-reviewed request can be corrected rather than only deleted and
  // re-filed: approving with the wrong times (e.g. day-shift hours on a night
  // shift) is easy to do and previously had no in-app remedy. Re-approving
  // replaces the punches the earlier approval created, so corrections can't
  // accumulate duplicates.
  const isRedo = rec.status !== "Pending";
  if (isRedo && req.user.role !== "Admin") {
    return res.status(403).json({ error: "Only an Admin can change an already-reviewed request." });
  }

  const needIn = rec.missingType === "IN" || rec.missingType === "BOTH";
  const needOut = rec.missingType === "OUT" || rec.missingType === "BOTH";
  const inAt = req.body?.inAt || null;
  const outAt = req.body?.outAt || null;
  if (decision === "Approved") {
    if (needIn && !inAt) return res.status(400).json({ error: "Please set the Time In for approval." });
    if (needOut && !outAt) return res.status(400).json({ error: "Please set the Time Out for approval." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await applyReview(client, rec, { decision, inAt, outAt, note, username: req.user.username });
    await client.query("COMMIT");
    res.json({ ok: true, ...out });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[absence] review failed:", e.message);
    res.status(500).json({ error: "Could not apply the correction. Please try again." });
  } finally {
    client.release();
  }
});

// Review MANY requests in one action. Approving needs times, not just a
// decision, so each request is timed from its own ROSTERED shift — the same
// default the single-review form pre-fills. That keeps a night shift's
// time-out on the following day, which a single blanket time pair could not
// express. Requests with no shift rostered are skipped and reported rather
// than guessed at, since inventing times would silently corrupt payroll.
// Body: { ids: [], decision: 'Approved'|'Rejected', reviewNote }
router.patch("/missing-timelog/bulk-review", requireAuth, requireRole("Admin", "Investigator"), async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "Approved" && decision !== "Rejected") {
    return res.status(400).json({ error: "Decision must be Approved or Rejected." });
  }
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return res.status(400).json({ error: "Select at least one request." });
  const note = (req.body?.reviewNote || "").trim();

  // Pull each request together with the shift rostered for its guard and date.
  const rows = (await pool.query(
    `SELECT m.*, to_char(m."dutyDate",'YYYY-MM-DD') AS "dutyDateStr",
            s."startTime" AS "shiftStart", s."endTime" AS "shiftEnd",
            s."crossesMidnight" AS "shiftCrosses"
     FROM missing_timelog_requests m
     LEFT JOIN LATERAL (
       SELECT sa."startTime", sa."endTime", sa."crossesMidnight"
       FROM shift_assignments sa
       WHERE sa."dutyDate" = m."dutyDate"
         AND lower(regexp_replace(btrim(sa."guardName"), '\\s+', ' ', 'g'))
           = lower(regexp_replace(btrim(m."guardName"), '\\s+', ' ', 'g'))
       ORDER BY sa.id LIMIT 1
     ) s ON true
     WHERE m.id = ANY($1)`, [ids]
  )).rows;

  const applied = []; const skipped = [];
  for (const rec of rows) {
    // Re-reviewing an already-decided request is Admin-only, matching the
    // single-request route.
    if (rec.status !== "Pending" && req.user.role !== "Admin") {
      skipped.push({ id: rec.id, dutyDate: rec.dutyDateStr, reason: "Already reviewed — Admin only" });
      continue;
    }
    let inAt = null, outAt = null;
    if (decision === "Approved") {
      if (!rec.shiftStart || !rec.shiftEnd) {
        skipped.push({ id: rec.id, dutyDate: rec.dutyDateStr, reason: "No shift rostered for this date — approve it individually and set the times" });
        continue;
      }
      const needIn = rec.missingType === "IN" || rec.missingType === "BOTH";
      const needOut = rec.missingType === "OUT" || rec.missingType === "BOTH";
      inAt = needIn ? `${rec.dutyDateStr}T${rec.shiftStart}` : null;
      outAt = needOut
        ? `${rec.shiftCrosses ? addDaysISO(rec.dutyDateStr, 1) : rec.dutyDateStr}T${rec.shiftEnd}`
        : null;
    }

    // Each request commits on its own, so one bad row can't discard the rest
    // of a 15-day batch.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyReview(client, rec, { decision, inAt, outAt, note, username: req.user.username });
      await client.query("COMMIT");
      applied.push({ id: rec.id, dutyDate: rec.dutyDateStr, inAt, outAt });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[absence] bulk review failed for request ${rec.id}:`, e.message);
      skipped.push({ id: rec.id, dutyDate: rec.dutyDateStr, reason: e.message });
    } finally {
      client.release();
    }
  }

  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  for (const id of missing) skipped.push({ id, dutyDate: null, reason: "Request not found" });

  res.json({ ok: true, decision, appliedCount: applied.length, skippedCount: skipped.length, applied, skipped });
});

router.delete("/missing-timelog/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query("DELETE FROM missing_timelog_requests WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
