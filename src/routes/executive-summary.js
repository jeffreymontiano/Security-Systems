const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { computeReport } = require("./attendance-reports");

const router = express.Router();

// Executive Summary — a read-only leadership view.
//
// It OWNS no data. Every figure is aggregated from the modules that already
// hold it, and the attendance-derived numbers come from computeReport(), the
// same function Attendance Reports, Absence Monitoring and Billing all read.
// That is deliberate and is the whole point: a summary that computes attendance
// its own way is a summary that will eventually disagree with the report it
// claims to summarise, and the disagreement will be discovered in a meeting.
//
// Access is closed by default. `executive` is in VIEW_RESTRICTED, so
// modulePermission() in server.js refuses a GET from anyone without the view
// privilege — Owner / President / General Manager holds it by default, and an
// administrator can grant it to anyone else from Manage Users.

// Dates in this module are PH days. A bare ::date on a timestamptz renders in
// the session timezone (UTC on the server) and would put an 06:00 PH punch on
// the previous day — the defect that once made every first-of-period morning
// read Absent. Text date columns (auditDate, violationDate) are already stored
// as YYYY-MM-DD strings and compare directly.
const PH = "AT TIME ZONE 'Asia/Manila'";

function phToday() {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000)
    .toISOString().slice(0, 10);
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// Resolve the requested window, defaulting to the last 4 weeks ending today.
function resolveRange(q) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : phToday();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : addDays(to, -27);
  return { from, to, site: (q.site || "").trim() };
}

// ---------------------------------------------------------------------------
// GET /api/executive-summary/kpis
// ---------------------------------------------------------------------------
router.get("/kpis", requireAuth, async (req, res) => {
  try {
    const { from, to, site } = resolveRange(req.query);
    const span = daysBetween(from, to) + 1;
    // The immediately preceding window of the same length, so a trend compares
    // like with like rather than against a month of a different shape.
    const priorTo = addDays(from, -1);
    const priorFrom = addDays(priorTo, -(span - 1));

    const siteFilter = site ? ` AND site = $3` : "";
    const args = site ? [from, to, site] : [from, to];

    const [headcount, rostered, sitesCovered, discipline, corrective, audits] = await Promise.all([
      // Active in the 201 File. A headcount, not a deployment figure.
      pool.query(
        `SELECT count(*)::int AS n FROM employees
          WHERE "employmentStatus" = 'Active'${site ? ` AND site = $1` : ""}`,
        site ? [site] : []
      ),
      // Actually rostered to a post in the window. This is "deployed".
      pool.query(
        `SELECT count(DISTINCT "guardName")::int AS n FROM shift_assignments
          WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date${siteFilter}`,
        args
      ),
      pool.query(
        `SELECT count(DISTINCT site)::int AS n FROM shift_assignments
          WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date
            AND COALESCE(site, '') <> ''${siteFilter}`,
        args
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM disciplinary_cases
          WHERE status IN ('Open','Under Review')${site ? ` AND site = $1` : ""}`,
        site ? [site] : []
      ),
      // Corrective actions are the "items" leadership chases; the audit row
      // itself is the container. Overdue is judged against PH today.
      pool.query(
        `SELECT
           count(*) FILTER (WHERE ca.status <> 'Completed')::int AS open,
           count(*) FILTER (WHERE ca.status <> 'Completed'
                              AND COALESCE(ca."dueDate", '') <> ''
                              AND ca."dueDate" < $1)::int AS overdue
         FROM compliance_corrective_actions ca
         JOIN compliance_audits a ON a.id = ca.audit_id
         ${site ? `WHERE a.site = $2` : ""}`,
        site ? [phToday(), site] : [phToday()]
      ),
      pool.query(
        `SELECT status, count(*)::int AS n FROM compliance_audits
          WHERE "auditDate" >= $1 AND "auditDate" <= $2${site ? ` AND site = $3` : ""}
          GROUP BY status`,
        args
      ),
    ]);

    // Attendance figures come from the shared engine, never re-derived here.
    const grace = Number(req.query.grace) || 15;
    const otThreshold = Number(req.query.otThreshold) || 30;
    const current = await computeReport({ from, to, site, guard: "", grace, otThreshold });
    const prior = await computeReport({ from: priorFrom, to: priorTo, site, guard: "", grace, otThreshold });

    // Compliance rate: of the days a guard was expected on post, how many were
    // actually worked and on time. Rest days and approved leave are NOT
    // expected days, so counting them as failures would punish a correct roster.
    const expected = (s) => s.total - s.restDay - s.onLeave;
    const kept = (s) => s.present - s.late;
    const rate = (s) => (expected(s) > 0 ? Math.round((kept(s) / expected(s)) * 1000) / 10 : null);

    const auditByStatus = Object.fromEntries(audits.rows.map((r) => [r.status, r.n]));

    res.json({
      range: { from, to, site: site || null, days: span },
      priorRange: { from: priorFrom, to: priorTo },
      kpis: {
        activeHeadcount: headcount.rows[0].n,
        deployedGuards: rostered.rows[0].n,
        sitesCovered: sitesCovered.rows[0].n,
        attendanceCompliance: { value: rate(current.summary), prior: rate(prior.summary) },
        unexplainedAbsences: { value: current.summary.absent, prior: prior.summary.absent },
        openDisciplinary: discipline.rows[0].n,
        complianceItems: {
          open: corrective.rows[0].open,
          overdue: corrective.rows[0].overdue,
        },
      },
      // Carried so the screen can show what the rate is made of rather than a
      // bare percentage nobody can check.
      attendance: {
        expectedDays: expected(current.summary),
        present: current.summary.present,
        late: current.summary.late,
        absent: current.summary.absent,
        onLeave: current.summary.onLeave,
        restDay: current.summary.restDay,
        undertime: current.summary.undertime,
        overtimeDays: current.summary.overtime,
      },
      auditsByStatus: auditByStatus,
    });
  } catch (e) {
    // Express 4 does not catch async route errors; an unhandled throw here
    // would hang the request rather than answer it.
    console.error("[executive-summary/kpis]", e);
    res.status(500).json({ error: e.message || "Could not build the executive summary." });
  }
});

module.exports = router;
