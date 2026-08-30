const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { fullIncident, nextIncidentId, log } = require("../lib/incidentHelpers");
const { bucketFor } = require("../lib/leaveCredits");
const { computeReport } = require("./attendance-reports");
const { evaluateSite } = require("../lib/siteMismatch");
const { dutyForPunch } = require("../lib/dutyForPunch");
const { checkUpload } = require("../lib/fileSniff");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument|^text\/plain$/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: images, PDF, Word docs, text files."));
  }
});

// Fairly generous, but enough to blunt casual abuse of a public, unauthenticated endpoint.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions from this network. Please try again later." }
});

// The public form is only reachable at all if an admin has explicitly set a
// share token in the environment. No token configured = feature is off.
function requireFormToken(req, res, next) {
  const configured = process.env.PUBLIC_FORM_TOKEN;
  if (!configured) {
    return res.status(503).json({ error: "The public report form has not been enabled on this server." });
  }
  const supplied = req.query.token || req.body.token || req.headers["x-form-token"];
  if (supplied !== configured) {
    return res.status(403).json({ error: "Invalid or missing form link. Please request a fresh link." });
  }
  next();
}

router.use(publicLimiter);

// Read-only lookups so the public form can populate its Site/Classification dropdowns.
router.get("/meta", requireFormToken, async (req, res) => {
  const [sites, classifications] = await Promise.all([
    pool.query("SELECT name FROM sites ORDER BY id"),
    pool.query("SELECT name FROM classifications ORDER BY id")
  ]);
  res.json({
    sites: sites.rows.map(r => r.name),
    classifications: classifications.rows.map(r => r.name)
  });
});

// Company name for the public form headers, so they always match the name set
// in System Settings (CSOMS) instead of a hardcoded value. Token-gated to stay
// consistent with the other public routes. Falls back to the default if the
// settings row is missing.
router.get("/branding", requireFormToken, async (req, res) => {
  const row = (await pool.query(
    `SELECT "companyName" FROM app_settings WHERE id = 1`
  )).rows[0];
  // Empty rather than a hardcoded agency: a public form must never carry a
  // different client's name.
  res.json({ companyName: (row && row.companyName) || "" });
});

// --- Public incident + Daily Security Report submission ---
//
// REINSTATED (2026-08) after being withdrawn in Stage A. Both forms are shared
// from their own module now (Incidents / Daily Security Report) rather than
// from Manage Users. Unchanged from the original: every route is behind
// requireFormToken, so nothing is reachable unless PUBLIC_FORM_TOKEN is set on
// the server, and each POST carries a honeypot field that a bot fills and a
// browser does not.
//
// /meta and /branding above are shared with attendance.html and the other
// public forms.

router.post("/incidents", requireFormToken, async (req, res) => {
  const b = req.body || {};
  // Honeypot: a real browser leaves this hidden field empty; bots that fill
  // every field tend to fill it too. Fail silently-ish so bots don't learn.
  if (b.website) return res.status(201).json({ id: "INC-0000" });

  if (!b.title || !b.title.trim()) return res.status(400).json({ error: "Please describe what happened." });

  // An employee reporter is identified by NUMBER; the name is then read from the
  // 201 File and whatever the client sent is discarded. Re-checked here rather
  // than trusted from the form, because the form is public and its payload is
  // whatever the sender chose to type — a request naming employee 2026-00125 as
  // "Fake Person" must save the real holder of that number.
  const reporterType = b.reporterType === "external" ? "external" : "employee";
  let employeeNo = null;
  let reporterName;

  if (reporterType === "employee") {
    employeeNo = (b.employeeNo || "").trim();
    if (!employeeNo) return res.status(400).json({ error: "Please enter your employee number." });
    const { rows } = await pool.query(
      `SELECT "fullName", "employmentStatus" FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [employeeNo]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: "Employee number not found in the Employee Master File." });
    }
    // The same rule the DDO and MDR apply to a separated guard.
    if (rows[0].employmentStatus !== "Active") {
      return res.status(400).json({ error: "Employee number found, but the employee is not currently active." });
    }
    reporterName = rows[0].fullName;
  } else {
    if (!b.reporterName || !b.reporterName.trim()) return res.status(400).json({ error: "Please enter your name." });
    reporterName = b.reporterName.trim();
  }

  const reportedBy = b.reporterContact
    ? `${reporterName} (${b.reporterContact.trim()})`
    : reporterName;

  const id = await nextIncidentId();
  await pool.query(
    `INSERT INTO incidents
      (id, title, date, site, classification, severity, description, "reportedBy", assigned, status, "resolvedDate", "rootCause", "createdBy", "reporterType", "reporterEmployeeNo")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'','Open',NULL,'',$9,$10,$11)`,
    [
      id, b.title.trim(), b.date || new Date().toISOString().slice(0, 10), b.site || "Other",
      b.classification || "Other", b.severity || "Medium", b.description || "", reportedBy,
      `public-form:${reporterName}`, reporterType, employeeNo
    ]
  );
  await log(id, `public-form:${reporterName}`, "created",
    `${b.title.trim()} (submitted via public report form` +
    (employeeNo ? `, employee ${employeeNo} verified against the 201 File` : ", external reporter") + ")");
  res.status(201).json({ id });
});

router.post("/incidents/:id/attachments", requireFormToken, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const inc = (await pool.query("SELECT id FROM incidents WHERE id = $1", [req.params.id])).rows[0];
    if (!inc) return res.status(404).json({ error: "Incident not found." });
    await pool.query(
      `INSERT INTO attachments (incident_id, filename, mimetype, size, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, "public-form"]
    );
    await log(req.params.id, "public-form", "attachment_added", req.file.originalname);
    res.status(201).json({ ok: true });
  });
});

// --- Public Daily Security Report submission ---
function dsrCode(id) { return "DSR-" + String(id).padStart(4, "0"); }

router.post("/dsr", requireFormToken, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ id: 0, code: "DSR-0000" });

  if (!b.date) return res.status(400).json({ error: "Please choose a date." });
  if (!b.submittedBy || !b.submittedBy.trim()) return res.status(400).json({ error: "Please enter your name." });

  const { rows } = await pool.query(
    `INSERT INTO dsr_reports
      (date, site, shift, "submittedBy", "shiftTurnover", "visitorLog", "vehicleLog", "patrolReport", "securityObservations", "siteIssues", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      b.date, b.site || "", b.shift || "", b.submittedBy.trim(), b.shiftTurnover || "",
      b.visitorLog || "", b.vehicleLog || "", b.patrolReport || "", b.securityObservations || "",
      b.siteIssues || "", `public-form:${b.submittedBy.trim()}`
    ]
  );
  const id = rows[0].id;
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [dsrCode(id), `public-form:${b.submittedBy.trim()}`, "created", `Daily Security Report for ${b.date} (submitted via public report form)`]
  );
  res.status(201).json({ id, code: dsrCode(id) });
});

router.post("/dsr/:id/attachments", requireFormToken, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const existing = (await pool.query("SELECT id FROM dsr_reports WHERE id = $1", [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Report not found." });
    await pool.query(
      `INSERT INTO dsr_attachments (dsr_id, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, "public-form"]
    );
    await pool.query(
      "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
      [dsrCode(req.params.id), "public-form", "attachment_added", req.file.originalname]
    );
    res.status(201).json({ ok: true });
  });
});

// --- Public Attendance & Timekeeping submission ---
// The guard opens the shared link, picks Site + IN/OUT, takes a selfie (with a
// date/time stamp drawn on it client-side), and the browser captures GPS
// coordinates. Selfie + location are BOTH required. Coordinates are device-
// reported (not tamper-proof) but give a clickable Google Maps location.

// Public employee lookup by number, for the attendance form's confirmation
// step. Token-protected and privacy-minimal: returns ONLY the full name and
// site for a valid employee number — never IDs, government numbers, or other
// 201-File fields. Used so the guard can confirm "is this me?" before submitting.
// Also reused by the public Leave Request form below for the same purpose.
router.get("/employee-lookup", requireFormToken, async (req, res) => {
  const empNo = (req.query.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  const { rows } = await pool.query(
    `SELECT "fullName", site, "employmentStatus" FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Employee number not found. Please check and try again." });
  // `active` is ADDED, not substituted: the attendance and leave forms read
  // fullName and site and are unaffected, while the incident form can tell a
  // separated employee from an unknown number. Still no HR field beyond the
  // name, the site and one boolean — the 201 File is not exposed here.
  //
  // "Active" is the existing rule, not a new one: DDO refuses a line naming a
  // non-Active guard and the MDR skips them the same way.
  res.json({
    fullName: rows[0].fullName,
    site: rows[0].site || "",
    active: rows[0].employmentStatus === "Active",
  });
});

// The Sites / Facilities list, for the duty-site picker on the attendance and
// missing-time-log forms. Token-gated and read-only, exactly like
// /leave-types above — the authenticated /meta/sites is behind requireAuth and
// a public form has no token to call it with.
//
// Every site is offered, not just the guard's own: relief duty at another
// client's post is the reason this picker exists. The submitted value is
// validated against this same table on POST, so the list is a convenience and
// never the check.
router.get("/sites", requireFormToken, async (req, res) => {
  const { rows } = await pool.query("SELECT name FROM sites ORDER BY name");
  res.json(rows.map((r) => r.name));
});

/**
 * DUPLICATE PUNCH DETECTION -- two checks, in this order.
 *
 * A guard produced four TIME INs in sixteen minutes by tapping again on a flaky
 * connection, and later two TIME INs six hours apart for one night shift. The
 * second escaped a rule that looked only at rows carrying a resolved duty, so
 * detection can no longer depend on the EARLIER punch having been stamped.
 *
 * WHY A NULL DUTY MUST NOT READ AS "A DIFFERENT SHIFT"
 * ---------------------------------------------------
 * "dutyAssignmentId" is NULL on three whole classes of row, and every one of
 * them is a real punch:
 *   - everything written before the column existed;
 *   - every punch by a guard not rostered that day -- first-class here, since
 *     billing ADDs an unrostered duty day as relief or an extra post;
 *   - every punch written by an approved Missing Time Log correction, because
 *     absence-monitoring.js does not stamp the duty. That one is NOT
 *     transitional and will not age out.
 * Comparing `NULL !== 765` and concluding "different shift, allow it" would
 * wave a duplicate through against any of the three. A shift is DIFFERENT only
 * when both sides name one and the two disagree; anything else is "the same
 * shift, not proven otherwise", and is refused.
 */

/**
 * Same guard, same punch type, same PH DAY -- unless both punches name a
 * different rostered duty segment.
 *
 * Day-scoped rather than windowed: the gap in the incident was SIX HOURS, and a
 * window wide enough to catch that would start refusing legitimate second
 * duties. Site-agnostic: a second IN is a duplicate whatever site it names.
 */
async function findSameDayDuplicate(client, empNo, punchType, dutyId, dutySegment) {
  const { rows } = await client.query(
    `SELECT id, "dutyAssignmentId", "dutySegment", site,
            to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'HH12:MI AM') AS "phTime"
       FROM attendance_records
      WHERE "employeeNo" = $1
        AND "punchType" = $2
        AND "deletedAt" IS NULL
        AND ("punchAt" AT TIME ZONE 'Asia/Manila')::date
          = (now()      AT TIME ZONE 'Asia/Manila')::date
      ORDER BY "punchAt" DESC`,
    [empNo, punchType]
  );
  for (const r of rows) {
    const bothNamed = dutyId != null && r.dutyAssignmentId != null;
    const differs = bothNamed && (
      Number(r.dutyAssignmentId) !== Number(dutyId) ||
      Number(r.dutySegment) !== Number(dutySegment)
    );
    if (differs) continue;          // a genuinely different shift -- allowed
    return r;                       // same shift, or not proven different
  }
  return null;
}

/**
 * The same question asked of one DUTY rather than one day, which catches what
 * day-scoping cannot: a night shift's two clock-ins either side of midnight
 * fall on different PH dates but belong to one duty.
 *
 * Mirrors uq_attendance_one_per_duty_segment, so the read path and the database
 * refuse the same thing -- the index is the guarantee, this is the friendly
 * message in front of it.
 */
async function findDutyDuplicate(client, dutyId, dutySegment, punchType) {
  const { rows } = await client.query(
    `SELECT id, to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'HH12:MI AM') AS "phTime"
       FROM attendance_records
      WHERE "dutyAssignmentId" = $1 AND "dutySegment" = $2 AND "punchType" = $3
        AND "deletedAt" IS NULL
      LIMIT 1`,
    [dutyId, dutySegment, punchType]
  );
  return rows[0] || null;
}

/**
 * Resolve the duty site for a public submission.
 *
 * Returns { error } for a bad value, or { site, mismatch, rosteredSite }.
 * Shared by the attendance punch and the missing-time-log request so the two
 * cannot apply different rules to the same decision.
 */
async function resolveDutySite(submitted, employeeId, guardName, dutyDate) {
  const site = String(submitted == null ? "" : submitted).trim();
  if (!site) return { error: "Please choose the site you are on duty at." };

  // Never trust the dropdown: the form is public and its body is whatever the
  // sender typed. An unknown site would flow into billing as a detachment name
  // that maps to no client.
  const known = await pool.query("SELECT name FROM sites WHERE name = $1", [site]);
  if (known.rowCount === 0) {
    return { error: "That site is not on the configured Sites / Facilities list. Please pick one from the list." };
  }

  // What the roster says for this guard on this date — plural, since a broken
  // shift or a same-day transfer can legitimately give two.
  const rostered = (await pool.query(
    `SELECT DISTINCT site FROM shift_assignments
      WHERE "dutyDate" = $1::date AND ("employeeId" = $2 OR "guardName" = $3)`,
    [dutyDate, employeeId || null, guardName || ""]
  )).rows.map((r) => r.site).filter(Boolean);

  const { mismatch, rosteredSite } = evaluateSite(site, rostered);
  return { site, mismatch, rosteredSite };
}

/**
 * The same check for a PUNCH, which carries an instant rather than a duty date.
 *
 * resolveDutySite() above is right for the Missing Time Log form, where the
 * guard STATES the duty date and there is nothing to resolve. A punch is
 * different: a night shift's 06:00 time-out happens on the following calendar
 * day, so asking the roster about the punch's own date asks the wrong day and
 * flags a false mismatch — see lib/dutyForPunch.js for what that then costs.
 *
 * The punch is resolved to the ONE duty that owns it and compared against that
 * duty's post alone. Not against both days' posts: on a rotation week that
 * would accept a punch at either, letting a genuine wrong-site punch through
 * unnoticed.
 */
async function resolveDutySiteForPunch(submitted, guardName, punchAt, punchType) {
  const site = String(submitted == null ? "" : submitted).trim();
  if (!site) return { error: "Please choose the site you are on duty at." };

  const known = await pool.query("SELECT name FROM sites WHERE name = $1", [site]);
  if (known.rowCount === 0) {
    return { error: "That site is not on the configured Sites / Facilities list. Please pick one from the list." };
  }

  const { duty, dutyDate, segment } = await dutyForPunch(pool, guardName, punchAt, punchType);
  // No duty on either candidate day means the guard was not rostered at all,
  // which has never been a mismatch — an unrostered duty day is first-class and
  // billing ADDs it as a reliever or extra post.
  const { mismatch, rosteredSite } = evaluateSite(site, duty ? [duty.site] : []);
  // The duty this punch belongs to, carried out so the route can both STAMP it
  // and refuse a second punch of the same type against the same segment. Null
  // for an unrostered punch, which has no shift to be the duplicate of.
  return {
    site, mismatch, rosteredSite, dutyDate,
    dutyId: duty ? duty.id : null,
    dutySegment: duty ? segment : null,
    dutyName: duty ? (duty.shiftName || "") : "",
  };
}

/**
 * Record a site disagreement in the cross-module audit log.
 *
 * The record is held out of billing until someone reconciles it, so the fact
 * that it happened — and what the roster said at the time — has to survive
 * independently of the row, which an admin may go on to edit.
 *
 * Swallows its own errors: an audit write must never fail the submission it is
 * describing. A guard at a gate cannot do anything about a logging fault.
 */
async function logSiteMismatch(kind, id, employeeNo, guardName, chosen, dutyDate) {
  try {
    await pool.query(
      "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
      [
        kind === "attendance" ? `ATT-${String(id).padStart(4, "0")}` : `MTL-${String(id).padStart(4, "0")}`,
        `public-form:${employeeNo}`,
        "site_mismatch_flagged",
        `${guardName} submitted site "${chosen.site}" for ${dutyDate}, rostered at "${chosen.rosteredSite}". ` +
          "Held out of billing pending review.",
      ]
    );
  } catch { /* never break the submission */ }
}

router.post("/attendance", requireFormToken, (req, res) => {
  upload.single("selfie")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};

    // Honeypot: bots that fill every field trip this hidden one.
    if (b.website) return res.status(201).json({ id: 0 });

    const empNo = (b.employeeNo || "").trim();
    if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
    if (b.punchType !== "IN" && b.punchType !== "OUT") return res.status(400).json({ error: "Please choose Time In or Time Out." });

    // Look up the employee — reject unknown numbers so bad data never enters.
    const emp = (await pool.query(
      `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
    )).rows[0];
    if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

    // Both selfie and location are mandatory.
    if (!req.file) return res.status(400).json({ error: "A selfie photo is required to submit." });
    if (!/^image\/(png|jpe?g)$/.test(req.file.mimetype)) {
      return res.status(400).json({ error: "Selfie must be a PNG or JPEG image." });
    }
    const lat = parseFloat(b.latitude);
    const lng = parseFloat(b.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "Location is required. Please allow location access and try again." });
    }

    // The NAME still comes from the 201 File and is never taken from input.
    // The SITE now does come from the submitter: a guard on relief duty works a
    // post that is not their assigned one, and only they know which. It is
    // validated against the configured list and checked against the roster.
    const guard = emp.fullName;
    // The punch happens NOW; which DUTY it belongs to is a separate question.
    // This used to take the punch's own PH date and treat it as the duty date,
    // which is wrong for every shift that crosses midnight: a night shift's
    // 06:00 time-out was checked against the NEXT day's roster, and on a
    // rotation week that flagged a false mismatch — which computeReport then
    // turns into a lost time-out. Resolved properly by lib/dutyForPunch.js.
    const chosen = await resolveDutySiteForPunch(b.site, guard, new Date(), b.punchType);
    if (chosen.error) return res.status(400).json({ error: chosen.error });

    // ---- duplicate guard -------------------------------------------------
    // The checks and the insert share ONE transaction under an advisory lock
    // keyed on guard+type. Without it, two taps a few hundred milliseconds
    // apart both read "no duplicate" and both insert -- a flaky connection
    // produces bursts, not neatly spaced retries.
    //
    // The lock is now taken on EVERY path, not just the unrostered one. The
    // unique index only covers rows carrying a duty, and the day-scoped check
    // deliberately also refuses against rows that carry NONE -- legacy punches,
    // unrostered punches, and Missing Time Log corrections. Nothing in the
    // database can serialise those, so the lock has to.
    //
    // Keyed on guard+type WITHOUT the site, matching the rule: a second IN is a
    // duplicate whatever site it names, so two submissions naming different
    // sites must contend for the same lock or they would not be compared.
    // pg_advisory_xact_lock releases on COMMIT or ROLLBACK, so no path leaks it.
    let rows;
    const client = await pool.connect();
    // Idempotent: several paths out of this block release, and releasing a
    // client twice throws in pg.
    let released = false;
    const release = () => { if (!released) { released = true; client.release(); } };

    const alreadyPunched = (phTime) => {
      const verb = b.punchType === "IN" ? "in" : "out";
      const where = chosen.dutyName ? ` for your ${chosen.dutyName} shift` : " for this shift";
      return {
        error: `You have already timed ${verb}${chosen.dutyId ? where : ""} at ${phTime}. `
          + `Your time ${verb} was recorded — there is no need to submit again.`,
        code: "duplicate_punch",
        punchType: b.punchType,
        recordedAt: phTime,
      };
    };

    try {
      await client.query("BEGIN");

      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`punch:${empNo}:${b.punchType}`]);

      // Day first, because it is the broader question and the one that catches
      // an unstamped earlier punch. Then the duty, which catches what a PH day
      // cannot: a night shift's two clock-ins either side of midnight fall on
      // different dates but belong to one duty.
      let dupe = await findSameDayDuplicate(client, empNo, b.punchType, chosen.dutyId, chosen.dutySegment);
      if (!dupe && chosen.dutyId) {
        dupe = await findDutyDuplicate(client, chosen.dutyId, chosen.dutySegment, b.punchType);
      }
      if (dupe) {
        await client.query("ROLLBACK");
        release();
        // 409, not 400: nothing is wrong with the submission and nothing
        // failed. The punch the guard is asking for already exists, and the
        // form shows this on the SUCCESS screen -- answering with a red error
        // is what produced four punches in sixteen minutes.
        return res.status(409).json(alreadyPunched(dupe.phTime));
      }

      ({ rows } = await client.query(
        `INSERT INTO attendance_records
          ("employeeNo", "guardName", site, "punchType", "punchAt", "selfieData", "selfieMimetype", latitude, longitude, "createdBy",
           "siteMismatch", "rosteredSite", "dutyAssignmentId", "dutySegment")
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [empNo, guard, chosen.site, b.punchType, req.file.buffer, req.file.mimetype, lat, lng, `public-form:${empNo}`,
         chosen.mismatch, chosen.rosteredSite, chosen.dutyId, chosen.dutySegment]
      ));
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* connection already gone */ });
      release();
      // 23505 is the unique index doing its job: a simultaneous submission won
      // the race and this one lost. That is the SAME outcome as finding the
      // duplicate on the read above, so the guard is told the same thing rather
      // than shown a database failure for pressing a button twice.
      if (e && e.code === "23505") {
        const prior = (await pool.query(
          `SELECT to_char("punchAt" AT TIME ZONE 'Asia/Manila', 'HH12:MI AM') AS "phTime"
             FROM attendance_records
            WHERE "dutyAssignmentId" = $1 AND "dutySegment" = $2 AND "punchType" = $3
              AND "deletedAt" IS NULL LIMIT 1`,
          [chosen.dutyId, chosen.dutySegment, b.punchType]
        ).catch(() => ({ rows: [] }))).rows[0];
        return res.status(409).json(alreadyPunched(prior ? prior.phTime : "the recorded time"));
      }
      // Express 4 does not catch an async route error: rethrowing would leave
      // the guard's request hanging until it timed out, and they would tap
      // again -- feeding the very loop this route exists to stop.
      console.error("[public/attendance] punch insert failed:", e.message);
      return res.status(500).json({ error: "Could not record your time. Please try again." });
    } finally {
      release();
    }
    // The DUTY's date, resolved from the punch — not the date the punch
    // happened, which is what the audit line used to name and would read as the
    // wrong day for any shift that crosses midnight.
    if (chosen.mismatch) await logSiteMismatch("attendance", rows[0].id, empNo, guard, chosen, chosen.dutyDate);
    res.status(201).json({ id: rows[0].id, ok: true });
  });
});

// --- Public Leave Request submission ---
// Guards/employees file a leave request from a shared link. Employee Number
// is the only identity input; Name and Site are always resolved server-side
// from the 201 File (via the same lookup as the attendance form) so they can
// never be spoofed by the client. Unknown employee numbers are rejected
// outright. Submissions land as Pending in leave_records — identical to a
// leave request created by staff in the app — so they show up immediately in
// the Leave Request List on the Leave Management page.

// Public leave-type list for the form's dropdown (the authenticated version
// of this lives at /api/leave/types; this is the same dropdown_options source,
// just reachable without login).
router.get("/leave-types", requireFormToken, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value FROM dropdown_options WHERE list_key = 'leave_records_type' ORDER BY id`
  );
  res.json(rows.map(r => r.value));
});

// Read-only leave balance lookup for the public form. After a guard verifies
// their employee number, the form shows their current Vacation/Sick balances
// for reference. Token-protected and privacy-minimal: returns only the two
// numeric balances for a valid employee number, nothing else.
router.get("/leave-balance", requireFormToken, async (req, res) => {
  const empNo = (req.query.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  const emp = (await pool.query(
    `SELECT id FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  const { rows } = await pool.query(
    `SELECT bucket, balance FROM leave_credits WHERE "employeeId" = $1`, [emp.id]
  );
  let vacation = 0, sick = 0;
  for (const r of rows) {
    if (r.bucket === "Vacation") vacation = Number(r.balance);
    else if (r.bucket === "Sick") sick = Number(r.balance);
  }
  res.json({ vacation, sick });
});

router.post("/leave", requireFormToken, async (req, res) => {
  const b = req.body || {};
  // Honeypot, same convention as the other public forms.
  if (b.website) return res.status(201).json({ id: 0, ok: true });

  const empNo = (b.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });

  // Reject unknown employee numbers before touching anything else — same
  // trust model as /attendance: name/site always come from the 201 File.
  const emp = (await pool.query(
    `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  if (!b.leaveType || !b.leaveType.trim()) return res.status(400).json({ error: "Please choose a leave type." });
  if (!b.fromDate || !b.toDate) return res.status(400).json({ error: "From and to dates are required." });
  if (b.toDate < b.fromDate) return res.status(400).json({ error: "The end date can't be before the start date." });

  const { rows } = await pool.query(
    `INSERT INTO leave_records
      ("employeeId","employeeName","employeeNo","leaveType","fromDate","toDate",reason,status,"createdBy")
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,'Pending',$8)
     RETURNING id`,
    [emp.id, emp.fullName, empNo, b.leaveType.trim(), b.fromDate, b.toDate, (b.reason || "").trim(), `public-form:${empNo}`]
  );
  res.status(201).json({ id: rows[0].id, ok: true });
});

// --- Public Missing Time Log Request submission ---
// A guard explains a missing Time In and/or Time Out for a given date so an
// admin can correct attendance. Same trust model as the other public forms:
// employee number verified server-side; the NAME comes from the 201 File. The
// guard only explains — the admin sets the actual time(s) on approval.
//
// Multipart now, because the request may carry a selfie and up to three
// supporting files (a photo of the manual logsheet, a screenshot of the phone
// error). Both are OPTIONAL: this form reports a PAST day, often from home days
// later, so a photo taken now proves who is filing rather than that they were on
// post — and requiring a camera would lock out the guard whose phone failure is
// the very thing being reported.
const MTL_MAX_FILES = 3;
const MTL_MAX_BYTES = 5 * 1024 * 1024;

const mtlUpload = multer({
  storage: multer.memoryStorage(),
  // Smaller than the 8MB the incident form allows: a phone photo of a logsheet
  // is 1-3MB, and this endpoint is public and unauthenticated.
  limits: { fileSize: MTL_MAX_BYTES, files: MTL_MAX_FILES + 1 },
  fileFilter: (req, file, cb) => {
    // Narrower than the shared filter above, which also admits Word and text.
    // The declared type is only a first pass — the bytes are checked below.
    if (/^image\/(png|jpe?g)$|^application\/pdf$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Attachments must be a JPEG or PNG photo, or a PDF."));
  },
}).fields([{ name: "selfie", maxCount: 1 }, { name: "files", maxCount: MTL_MAX_FILES }]);

// A tighter bucket for this one endpoint, on top of the shared limiter.
//
// The shared 30/15min is ONE counter across every public route, and a guard
// filing a missing-log request now costs five requests (meta, branding, sites,
// employee-lookup, then this multipart POST). Guards at a detachment share one
// connection, so six of them filing on the same afternoon would exhaust the
// shared budget and lock everyone at that site out of the ATTENDANCE PUNCH
// form — a paperwork form starving the operational one.
//
// This cannot loosen anything: the shared limiter still applies first. It only
// caps how much of the budget this form can take, and bounds the unscanned-
// upload surface.
const missingLogLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many missing-time-log requests from this network. Please try again later." },
});

router.post("/missing-timelog", missingLogLimiter, requireFormToken, (req, res) => {
  mtlUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.website) return res.status(201).json({ id: 0, ok: true }); // honeypot

    const empNo = (b.employeeNo || "").trim();
    if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });

    const emp = (await pool.query(
      `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
    )).rows[0];
    if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

    if (!b.dutyDate) return res.status(400).json({ error: "Please choose the date of the missing log." });
    const missingType = ["IN", "OUT", "BOTH"].includes(b.missingType) ? b.missingType : null;
    if (!missingType) return res.status(400).json({ error: "Please choose which log is missing." });
    if (!b.reason || !b.reason.trim()) return res.status(400).json({ error: "Please explain why the log is missing." });

    // Site is chosen by the submitter and checked against the roster for the
    // duty date being reported — not today's date, since this is a past day.
    const chosen = await resolveDutySite(b.site, emp.id, emp.fullName, b.dutyDate);
    if (chosen.error) return res.status(400).json({ error: chosen.error });

    const selfie = (req.files && req.files.selfie && req.files.selfie[0]) || null;
    const extras = (req.files && req.files.files) || [];

    // Every byte offered is checked against its declared type before anything
    // is written, so a rejected attachment does not leave a half-saved request.
    if (selfie) {
      const ok = checkUpload(selfie.buffer, selfie.mimetype);
      if (!ok.ok) return res.status(400).json({ error: `Selfie: ${ok.error}` });
      if (ok.mime === "application/pdf") {
        return res.status(400).json({ error: "The selfie must be a photo, not a PDF." });
      }
    }
    const checked = [];
    for (const f of extras) {
      const ok = checkUpload(f.buffer, f.mimetype);
      if (!ok.ok) return res.status(400).json({ error: `${f.originalname}: ${ok.error}` });
      checked.push({ file: f, mime: ok.mime });
    }

    const lat = parseFloat(b.latitude);
    const lng = parseFloat(b.longitude);

    const { rows } = await pool.query(
      `INSERT INTO missing_timelog_requests
        ("employeeId","employeeNo","guardName",site,"dutyDate","missingType",reason,status,"createdBy",
         "siteMismatch","rosteredSite","selfieData","selfieMimetype",latitude,longitude)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,'Pending',$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [emp.id, empNo, emp.fullName, chosen.site, b.dutyDate, missingType, b.reason.trim(),
       `public-form:${empNo}`, chosen.mismatch, chosen.rosteredSite,
       selfie ? selfie.buffer : null, selfie ? selfie.mimetype : null,
       Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null]
    );
    const id = rows[0].id;

    for (const { file, mime } of checked) {
      await pool.query(
        `INSERT INTO missing_timelog_attachments (request_id, filename, mimetype, size, data, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        // The SNIFFED type is stored, not the declared one: it is what the
        // download route will serve, and it is the one that was verified.
        [id, file.originalname, mime, file.size, file.buffer, `public-form:${empNo}`]
      );
    }

    if (chosen.mismatch) await logSiteMismatch("mtl", id, empNo, emp.fullName, chosen, b.dutyDate);
    res.status(201).json({ id, ok: true, attachments: checked.length });
  });
});

// --- Public self-service attendance view ---
// A guard checks their OWN attendance for a date range. Token-gated; employee
// number verified server-side. Returns ONLY this employee's per-day status
// (Present/Absent/Rest Day/On Leave/No time-out) — never selfies, GPS, or other
// guards. Uses the same classification engine as the admin reports so the
// guard sees exactly what the admin sees.
router.get("/my-attendance", requireFormToken, async (req, res) => {
  const empNo = (req.query.employeeNo || "").trim();
  const from = req.query.from, to = req.query.to;
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  if (!from || !to) return res.status(400).json({ error: "Please choose a date range." });

  const emp = (await pool.query(
    `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  // Cap the range to keep the public query light.
  const span = (await pool.query(`SELECT ($1::date - $2::date) AS days`, [to, from])).rows[0].days;
  if (span < 0) return res.status(400).json({ error: "The end date can't be before the start date." });
  if (span > 92) return res.status(400).json({ error: "Please choose a range of 3 months or less." });

  const { rows } = await computeReport({ from, to, guard: emp.fullName, grace: 15, otThreshold: 30 });

  // Minimal projection: only what the guard needs to see, plus a flag for
  // whether the day looks like it needs a correction (Absent or No time-out).
  const days = rows.map((r) => {
    const noTimeout = Array.isArray(r.flags) && r.flags.includes("No time-out");
    const needsAction = r.status === "Absent" || (r.status !== "On Leave" && r.status !== "Rest Day" && noTimeout);
    let display = r.status;
    if (noTimeout && r.status !== "Absent" && r.status !== "On Leave" && r.status !== "Rest Day") display = "No time-out";
    return {
      dutyDate: r.dutyDate, site: r.site, shiftName: r.shiftName || "",
      scheduled: r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "",
      timeIn: r.timeIn || null, timeOut: r.timeOut || null,
      status: display, leaveType: r.leaveType || null, needsAction,
    };
  });

  res.json({ fullName: emp.fullName, site: emp.site || "", from, to, days });
});

// --- Public Overtime Request submission ---
// A guard files an overtime request for a date so an admin can review/approve.
// Same trust model as the other public forms. The guard proposes the OT minutes
// and explains; the admin sets the final approved amount on review.
router.post("/overtime", requireFormToken, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ id: 0, ok: true }); // honeypot

  const empNo = (b.employeeNo || "").trim();
  if (!empNo) return res.status(400).json({ error: "Please enter your employee number." });
  const emp = (await pool.query(
    `SELECT id, "fullName", site FROM employees WHERE "employeeNo" = $1 LIMIT 1`, [empNo]
  )).rows[0];
  if (!emp) return res.status(404).json({ error: "Employee number not found. Please check and try again." });

  if (!b.dutyDate) return res.status(400).json({ error: "Please choose the date of the overtime." });
  const reqMin = Math.round(+b.requestedMinutes);
  if (!Number.isFinite(reqMin) || reqMin <= 0) return res.status(400).json({ error: "Please enter how many overtime minutes you worked." });
  if (reqMin > 1440) return res.status(400).json({ error: "That's more than 24 hours — please check the amount." });
  if (!b.reason || !b.reason.trim()) return res.status(400).json({ error: "Please explain the reason for the overtime." });

  const guardKey = emp.fullName.trim().toLowerCase().replace(/\s+/g, " ");
  try {
    const { rows } = await pool.query(
      `INSERT INTO overtime_records
        ("employeeId","employeeNo","guardKey","guardName",site,"dutyDate",source,"requestedMinutes",reason,status,"createdBy")
       VALUES ($1,$2,$3,$4,$5,$6::date,'manual',$7,$8,'Pending',$9)
       RETURNING id`,
      [emp.id, empNo, guardKey, emp.fullName, emp.site || "", b.dutyDate, reqMin, b.reason.trim(), `public-form:${empNo}`]
    );
    res.status(201).json({ id: rows[0].id, ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "You already submitted an overtime request for that date." });
    throw e;
  }
});

module.exports = router;
