const express = require("express");
const PDFDocument = require("pdfkit");
const { stampAuthorFooter } = require("../lib/pdfBranding");
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

// Dates here are PH days. dutyDate is a real DATE column so ::date is safe on
// it; auditDate and violationDate are stored as YYYY-MM-DD text and compare
// directly. The one place a timestamptz is bucketed by day is inside
// computeReport(), which already does it AT TIME ZONE 'Asia/Manila' — a bare
// ::date there once put 06:00 PH punches on the previous day.

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

// Resolve the requested window.
//
// `weeks` is what the screen sends and is the normal path; explicit from/to is
// accepted so the same endpoints can answer for an arbitrary period (a board
// pack for one month, say) without a second API. An explicit range wins.
//
// Clamped: a request for 500 weeks would aggregate the whole history on every
// keystroke, and nobody reads a 10-year bar chart.
function resolveRange(q) {
  const explicit = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") && /^\d{4}-\d{2}-\d{2}$/.test(q.to || "");
  if (explicit) return { from: q.from, to: q.to, site: (q.site || "").trim() };

  const weeks = Math.min(52, Math.max(1, Number(q.weeks) || 4));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : phToday();
  return { from: addDays(to, -(weeks * 7 - 1)), to, site: (q.site || "").trim(), weeks };
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

// ---------------------------------------------------------------------------
// GET /api/executive-summary/charts
//
// Every series is aggregated here, not in the browser: the page should ask once
// and draw, rather than pull thousands of rows and reduce them client-side.
// ---------------------------------------------------------------------------

// PH week starting Monday, as a YYYY-MM-DD label. Weeks are the unit leadership
// reads attendance in, and they must be PH weeks — bucketing a 06:00 PH punch
// by its UTC day would put Monday mornings in the previous week.
function phWeekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;          // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

router.get("/charts", requireAuth, async (req, res) => {
  try {
    const { from, to, site } = resolveRange(req.query);
    const grace = Number(req.query.grace) || 15;
    const otThreshold = Number(req.query.otThreshold) || 30;

    const { rows } = await computeReport({ from, to, site, guard: "", grace, otThreshold });

    // 1 + 2 + 4: one pass over the attendance rows, bucketed by PH week.
    const weeks = new Map();
    const bySite = new Map();
    for (const r of rows) {
      const wk = phWeekStart(r.dutyDate);
      if (!weeks.has(wk)) {
        weeks.set(wk, { week: wk, present: 0, late: 0, absent: 0, onLeave: 0, restDay: 0,
                        builtinOtMin: 0, excessOtMin: 0, noTimeOut: 0 });
      }
      const w = weeks.get(wk);
      if (r.status === "Present") w.present++;
      else if (r.status === "Absent") w.absent++;
      else if (r.status === "On Leave") w.onLeave++;
      else if (r.status === "Rest Day") w.restDay++;
      if (r.lateMin > 0) w.late++;
      w.builtinOtMin += r.builtinOtMin || 0;
      w.excessOtMin += r.overtimeMin || 0;
      if (Array.isArray(r.flags) && r.flags.includes("No time-out")) w.noTimeOut++;

      const key = r.site || "(unassigned)";
      if (!bySite.has(key)) bySite.set(key, { site: key, guards: new Set(), absent: 0, noTimeOut: 0 });
      const s = bySite.get(key);
      s.guards.add(r.guardName);
      if (r.status === "Absent") s.absent++;
      if (Array.isArray(r.flags) && r.flags.includes("No time-out")) s.noTimeOut++;
    }

    const [missing, audits, correctives, leave, discipline] = await Promise.all([
      // 4: missing time-log requests raised in the window, by status.
      pool.query(
        `SELECT status, count(*)::int AS n FROM missing_timelog_requests
          WHERE "dutyDate" >= $1::date AND "dutyDate" <= $2::date
          GROUP BY status`, [from, to]
      ),
      // 5: audit containers by status, and the compliant rate of their items.
      pool.query(
        `SELECT a.status, count(*)::int AS n FROM compliance_audits a
          WHERE a."auditDate" >= $1 AND a."auditDate" <= $2${site ? ` AND a.site = $3` : ""}
          GROUP BY a.status`, site ? [from, to, site] : [from, to]
      ),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE ci.compliant = 'Yes')::int AS compliant,
           count(*) FILTER (WHERE ci.compliant = 'No')::int  AS notCompliant,
           count(*) FILTER (WHERE ci.compliant = 'N/A')::int AS notApplicable
         FROM compliance_checklist_items ci
         JOIN compliance_audits a ON a.id = ci.audit_id
         WHERE a."auditDate" >= $1 AND a."auditDate" <= $2${site ? ` AND a.site = $3` : ""}`,
        site ? [from, to, site] : [from, to]
      ),
      // 6: leave by type and status, disciplinary by status.
      pool.query(
        `SELECT "leaveType", status, count(*)::int AS n FROM leave_records
          WHERE "toDate" >= $1::date AND "fromDate" <= $2::date
          GROUP BY "leaveType", status`, [from, to]
      ),
      pool.query(
        `SELECT status, count(*)::int AS n FROM disciplinary_cases
          WHERE "violationDate" >= $1 AND "violationDate" <= $2${site ? ` AND site = $3` : ""}
          GROUP BY status`, site ? [from, to, site] : [from, to]
      ),
    ]);

    const weekly = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));

    res.json({
      range: { from, to, site: site || null },
      // 1. Attendance trend, and 2. the OT split — the same weekly buckets, so
      // a spike in one can be read against the other.
      weekly,
      // 3. Deployment by site.
      deploymentBySite: [...bySite.values()]
        .map((s) => ({ site: s.site, guards: s.guards.size, absent: s.absent, noTimeOut: s.noTimeOut }))
        .sort((a, b) => b.guards - a.guards),
      // 4. Absence patterns.
      absencePatterns: {
        byWeek: weekly.map((w) => ({ week: w.week, absent: w.absent, noTimeOut: w.noTimeOut })),
        bySite: [...bySite.values()]
          .filter((s) => s.absent > 0 || s.noTimeOut > 0)
          .map((s) => ({ site: s.site, absent: s.absent, noTimeOut: s.noTimeOut }))
          .sort((a, b) => (b.absent + b.noTimeOut) - (a.absent + a.noTimeOut)),
        missingTimeLogs: Object.fromEntries(missing.rows.map((r) => [r.status, r.n])),
      },
      // 5. Compliance. NOTE: compliance_audits.status is Scheduled / In Progress
      // / Completed / Cancelled — there is no pass/fail on the audit itself.
      // Pass/fail lives on the checklist items, so both are returned and the
      // chart must not label the container "passed".
      compliance: {
        auditsByStatus: Object.fromEntries(audits.rows.map((r) => [r.status, r.n])),
        checklist: correctives.rows[0] || { compliant: 0, notcompliant: 0, notapplicable: 0 },
      },
      // 6. Leave and disciplinary.
      leaveByTypeStatus: leave.rows,
      disciplinaryByStatus: Object.fromEntries(discipline.rows.map((r) => [r.status, r.n])),
    });
  } catch (e) {
    console.error("[executive-summary/charts]", e);
    res.status(500).json({ error: e.message || "Could not build the charts." });
  }
});

// The site filter. Cheap and separate so it can populate before any heavy
// aggregation runs.
//
// Sourced from the Sites / Facilities list in Manage Lists — the same `sites`
// table /meta/sites serves — so leadership sees every site the agency has
// configured, in the order an administrator arranged them. It previously read
// DISTINCT site off the roster, which meant a site with no shifts in the chosen
// window simply vanished from the filter: you could not ask "why is nothing
// happening at RH?" because RH was not on the list to select.
//
// Any site that appears on the roster but is NOT in Manage Lists is appended
// after them. That should not happen, but it does — see Known Gap 7, where a
// roster's site name and the configured name diverge — and a filter that cannot
// reach data the page is already counting would be worse than an untidy list.
router.get("/sites", requireAuth, async (req, res) => {
  try {
    const [configured, rostered] = await Promise.all([
      pool.query(`SELECT name FROM sites ORDER BY id`),
      pool.query(
        `SELECT DISTINCT site FROM shift_assignments WHERE COALESCE(site, '') <> ''`
      ),
    ]);
    const list = configured.rows.map((r) => r.name);
    const known = new Set(list.map((n) => n.trim().toLowerCase()));
    const strays = rostered.rows
      .map((r) => r.site)
      .filter((s) => !known.has(String(s).trim().toLowerCase()))
      .sort();
    res.json([...list, ...strays]);
  } catch (e) {
    console.error("[executive-summary/sites]", e);
    res.status(500).json({ error: "Could not list sites." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/executive-summary/summary.pdf
//
// The same figures as the screen, on the agency's letterhead. The charts are
// redrawn here as PDF vectors rather than rasterised in the browser and
// uploaded: PDFKit runs server-side and cannot execute React, and a screenshot
// would print blurry and carry whatever the browser happened to be showing.
// Both the page and this document read the same aggregations, so they cannot
// disagree.
// ---------------------------------------------------------------------------
router.get("/summary.pdf", requireAuth, async (req, res) => {
  try {
    const { from, to, site } = resolveRange(req.query);
    const grace = Number(req.query.grace) || 15;
    const otThreshold = Number(req.query.otThreshold) || 30;

    const { rows, summary } = await computeReport({ from, to, site, guard: "", grace, otThreshold });

    const weeks = new Map();
    const bySite = new Map();
    for (const r of rows) {
      const wk = phWeekStart(r.dutyDate);
      if (!weeks.has(wk)) weeks.set(wk, { week: wk, present: 0, absent: 0, onLeave: 0, restDay: 0, builtinOtMin: 0, excessOtMin: 0 });
      const w = weeks.get(wk);
      if (r.status === "Present") w.present++;
      else if (r.status === "Absent") w.absent++;
      else if (r.status === "On Leave") w.onLeave++;
      else if (r.status === "Rest Day") w.restDay++;
      w.builtinOtMin += r.builtinOtMin || 0;
      w.excessOtMin += r.overtimeMin || 0;
      const key = r.site || "(unassigned)";
      if (!bySite.has(key)) bySite.set(key, new Set());
      bySite.get(key).add(r.guardName);
    }
    const weekly = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
    const deployment = [...bySite.entries()]
      .map(([k, v]) => ({ site: k, guards: v.size }))
      .sort((a, b) => b.guards - a.guards);

    const [emp, disc, corr] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM employees WHERE "employmentStatus" = 'Active'`),
      pool.query(`SELECT count(*)::int AS n FROM disciplinary_cases WHERE status IN ('Open','Under Review')`),
      pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'Completed')::int AS open,
                count(*) FILTER (WHERE status <> 'Completed' AND COALESCE("dueDate",'') <> '' AND "dueDate" < $1)::int AS overdue
           FROM compliance_corrective_actions`, [phToday()]
      ),
    ]);

    const expected = summary.total - summary.restDay - summary.onLeave;
    const rate = expected > 0 ? Math.round(((summary.present - summary.late) / expected) * 1000) / 10 : null;

    const settings = (await pool.query(
      `SELECT "companyName", "logoData" FROM app_settings WHERE id = 1`
    )).rows[0] || {};
    const companyName = (settings.companyName || "").toUpperCase();
    const logoBuf = settings.logoData || null;

    const NAVY = "#0B2545", GOLD = "#C9A227", MUTE = "#5B6B85";
    const TEAL = "#0F6E56", RED = "#A32D2D", BLUE = "#3E7CB1", GREY = "#C3C9D2";

    // bufferPages so the author footer can be stamped on EVERY page; without it
    // only the last page can be reached.
    const doc = new PDFDocument({ bufferPages: true, size: "A4", margin: 40 });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="executive-summary-${from}_${to}.pdf"`);
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
    const textX = logoBuf ? 96 : 40;
    if (logoBuf) { try { doc.image(logoBuf, 40, 20, { fit: [42, 42] }); } catch (e) { /* skip */ } }
    doc.fillColor(GOLD).fontSize(10).text(companyName, textX, 24, { characterSpacing: 1 });
    doc.fillColor("#fff").fontSize(16).text("Executive Summary", textX, 40);
    doc.fillColor("#C9D3E3").fontSize(9).text(
      `${from} to ${to}${site ? "  ·  " + site : "  ·  All sites"}  ·  Generated ${new Date().toLocaleDateString()}`,
      textX, 62
    );

    // ---- headline figures ------------------------------------------------
    let y = 104;
    const cards = [
      ["Active personnel", String(emp.rows[0].n)],
      ["Sites covered", String(deployment.length)],
      ["Attendance compliance", rate == null ? "—" : `${rate}%`],
      ["Unexplained absences", String(summary.absent)],
      ["Open disciplinary", String(disc.rows[0].n)],
      ["Overdue compliance items", String(corr.rows[0].overdue)],
    ];
    const cw = (doc.page.width - 80 - 10 * 2) / 3;
    cards.forEach((c, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 40 + col * (cw + 10);
      const cy = y + row * 56;
      doc.roundedRect(x, cy, cw, 48, 5).fillAndStroke("#F7F9FC", "#DCE1E8");
      doc.fillColor(MUTE).fontSize(7.5).text(c[0].toUpperCase(), x + 9, cy + 8, { width: cw - 18, characterSpacing: 0.5 });
      doc.fillColor(NAVY).fontSize(17).text(c[1], x + 9, cy + 21, { width: cw - 18 });
    });
    y += 2 * 56 + 12;

    // ---- how the rate is derived ----------------------------------------
    doc.fillColor(NAVY).fontSize(10).text("How the compliance rate is derived", 40, y);
    y += 15;
    doc.fillColor(MUTE).fontSize(8.5).text(
      `Days expected on post ${expected}   ·   Present ${summary.present}   ·   Of which late ${summary.late}   ·   Absent ${summary.absent}   ·   On leave ${summary.onLeave}   ·   Rest day ${summary.restDay}`,
      40, y, { width: doc.page.width - 80 }
    );
    y += 14;
    doc.fillColor(MUTE).fontSize(8).text(
      "Compliance = (present - late) / days expected. Rest days and approved leave are not expected days.",
      40, y, { width: doc.page.width - 80 }
    );
    y += 22;

    // ---- attendance by week, drawn as stacked columns --------------------
    const drawStacked = (title, points, series, unitLabel) => {
      if (y > doc.page.height - 190) { doc.addPage(); y = 50; }
      doc.fillColor(NAVY).fontSize(10).text(title, 40, y);
      y += 16;
      const W = doc.page.width - 80, H = 110;
      const max = Math.max(1, ...points.map((p) => series.reduce((n, s) => n + (p[s.key] || 0), 0)));
      const gap = 6;
      const bw = points.length ? Math.max(4, (W - gap * (points.length - 1)) / points.length) : 0;
      doc.moveTo(40, y + H).lineTo(40 + W, y + H).strokeColor("#C3C9D2").lineWidth(0.7).stroke();
      points.forEach((pt, i) => {
        const x = 40 + i * (bw + gap);
        let cursor = y + H;
        series.forEach((sr) => {
          const v = pt[sr.key] || 0;
          if (v <= 0) return;
          const h = Math.max(0.8, (v / max) * H);
          cursor -= h;
          doc.rect(x, cursor, bw, h).fill(sr.color);
        });
        doc.fillColor(MUTE).fontSize(6).text(pt.label, x - 4, y + H + 4, { width: bw + 8, align: "center" });
      });
      // Legend, so a column of colours is readable without the screen beside it.
      let lx = 40;
      const ly = y + H + 16;
      series.forEach((sr) => {
        doc.rect(lx, ly, 7, 7).fill(sr.color);
        doc.fillColor(MUTE).fontSize(7.5).text(sr.label, lx + 10, ly + 0.5);
        lx += 10 + doc.widthOfString(sr.label) + 16;
      });
      if (unitLabel) {
        doc.fillColor(MUTE).fontSize(7).text(unitLabel, 40 + W - 120, ly + 0.5, { width: 120, align: "right" });
      }
      y = ly + 22;
    };

    const wkLabel = (iso) => {
      const d = new Date(iso + "T00:00:00Z");
      return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    };
    const pts = weekly.map((w) => ({ label: wkLabel(w.week), ...w }));

    if (pts.length) {
      drawStacked("Attendance by week", pts, [
        { key: "present", label: "Present", color: TEAL },
        { key: "absent", label: "Absent", color: RED },
        { key: "onLeave", label: "On leave", color: BLUE },
        { key: "restDay", label: "Rest day", color: GREY },
      ]);
      drawStacked("Overtime by week", pts, [
        { key: "builtinOtMin", label: "Built-in OT", color: NAVY },
        { key: "excessOtMin", label: "Excess OT", color: GOLD },
      ], "minutes");
    } else {
      doc.fillColor(MUTE).fontSize(9).text("No rostered days in this period.", 40, y);
      y += 20;
    }

    // ---- deployment by site ---------------------------------------------
    if (deployment.length) {
      if (y > doc.page.height - 160) { doc.addPage(); y = 50; }
      doc.fillColor(NAVY).fontSize(10).text("Deployment by site", 40, y);
      y += 16;
      const maxG = Math.max(1, ...deployment.map((d) => d.guards));
      const trackX = 160, trackW = doc.page.width - 40 - trackX - 40;
      deployment.slice(0, 12).forEach((d) => {
        doc.fillColor("#1E2430").fontSize(8.5).text(d.site, 40, y, { width: 112, ellipsis: true });
        doc.roundedRect(trackX, y - 1, trackW, 10, 2).fill("#EEF1F5");
        doc.roundedRect(trackX, y - 1, Math.max(2, (d.guards / maxG) * trackW), 10, 2).fill(NAVY);
        doc.fillColor(NAVY).fontSize(8.5).text(String(d.guards), trackX + trackW + 6, y, { width: 30 });
        y += 15;
      });
    }

    stampAuthorFooter(doc, companyName);
    doc.end();
  } catch (e) {
    console.error("[executive-summary/pdf]", e);
    if (!res.headersSent) res.status(500).json({ error: e.message || "Could not build the PDF." });
  }
});

module.exports = router;
