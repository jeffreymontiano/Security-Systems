import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import ConfidentialFooter from "../components/ConfidentialFooter";
import { StackedBars, HBars, Donut, weekLabel, COLORS } from "./ExecutiveCharts";
import { apiBlobUrl, downloadBlobUrl } from "../api/client";

const SUBTITLE = "Live operational position across every module, for leadership";

// Executive Summary — read-only, and aggregated entirely on the server.
//
// Nothing is computed in the browser. The attendance figures in particular come
// from the same computeReport() that Attendance Reports and Billing read, so
// this page cannot quietly disagree with the report it summarises.
//
// Access is closed by default: `executive` is view-restricted, so the API
// refuses a GET without the privilege and the sidebar hides the entry. Owner /
// President / General Manager holds it; anyone else is granted it in Manage
// Users.
export default function ExecutiveSummary() {
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [charts, setCharts] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // One period and one site drive the KPIs AND every chart, so nothing on the
  // page can be describing a different window from anything else.
  //
  // `period` is either a rolling number of weeks or "custom", in which case the
  // From/To dates take over. The server already prefers an explicit range over
  // a week count, so the two can never both apply.
  const [period, setPeriod] = useState("4");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [site, setSite] = useState("");
  const [sites, setSites] = useState([]);

  const custom = period === "custom";
  // A backwards range would return nothing and look like a bug in the data.
  const rangeInvalid = custom && from && to && from > to;
  const rangeIncomplete = custom && (!from || !to);

  const query = useCallback(() => {
    const q = new URLSearchParams();
    if (custom && from && to) { q.set("from", from); q.set("to", to); }
    else q.set("weeks", period === "custom" ? "4" : period);
    if (site) q.set("site", site);
    return q.toString();
  }, [custom, from, to, period, site]);

  const load = useCallback(async () => {
    // Waiting for the second date rather than firing a request per keystroke,
    // and refusing a backwards one outright.
    if (rangeIncomplete || rangeInvalid) { setLoading(false); return; }
    setLoading(true);
    try {
      // Fetched together so the cards and the charts can never be showing
      // two different windows while one of them is still in flight.
      const [k, c] = await Promise.all([
        api(`/executive-summary/kpis?${query()}`),
        api(`/executive-summary/charts?${query()}`),
      ]);
      setData(k); setCharts(c); setError("");
    } catch (e) {
      setError(e.message);
      setData(null); setCharts(null);
    } finally {
      setLoading(false);
    }
  }, [query, rangeIncomplete, rangeInvalid]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api("/executive-summary/sites").then((r) => setSites(Array.isArray(r) ? r : [])).catch(() => setSites([]));
  }, []);

  async function exportPdf() {
    setExporting(true);
    try {
      // Behind requireAuth, so it must be fetched with the bearer token and
      // handed over as a blob; window.open cannot attach it and returns 401.
      const url = await apiBlobUrl(`/executive-summary/summary.pdf?${query()}`);
      downloadBlobUrl(url, `Executive-Summary-${data ? data.range.from : "period"}-to-${data ? data.range.to : ""}.pdf`);
    } catch (e) { setError(e.message); }
    finally { setExporting(false); }
  }

  // The sidebar already hides this, but a pasted URL must not render a shell
  // that then fills with 403s.
  if (!can("executive", "view")) {
    return (
      <div className="module-view">
        <ModuleHeader icon="◆" iconBg="var(--gold)" title="Executive Summary" subtitle={SUBTITLE} />
        <div className="section-card">
          <div className="section-head">Not available</div>
          <div style={{ padding: "18px" }} className="empty-hint">
            This view is limited to leadership. An administrator can grant access from Manage Users.
          </div>
        </div>
        <ConfidentialFooter />
      </div>
    );
  }

  const k = data && data.kpis;
  const a = data && data.attendance;

  // A trend is only meaningful against a comparable prior window; the server
  // sends one of the same length.
  const trendOf = (now, prior, higherIsBetter) => {
    if (now == null || prior == null || now === prior) return { trend: "flat", label: "unchanged" };
    const up = now > prior;
    const good = higherIsBetter ? up : !up;
    return {
      trend: up ? "up" : "down",
      label: `${up ? "up" : "down"} from ${prior}${higherIsBetter ? "%" : ""} — ${good ? "better" : "worse"}`,
    };
  };

  const compliance = k && k.attendanceCompliance;
  const absences = k && k.unexplainedAbsences;
  const cT = compliance ? trendOf(compliance.value, compliance.prior, true) : null;
  const aT = absences ? trendOf(absences.value, absences.prior, false) : null;

  const actions = (
    <>
      {/* One Refresh, and it is the one that reports itself: it disables while
          the fetch is in flight and says "Refreshing…", so a second click
          cannot stack another request. A plain duplicate sat beside it. */}
      <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      <button className="btn btn-gold btn-sm" onClick={exportPdf} disabled={exporting || !data}>
        <i className="bi bi-file-earmark-pdf" aria-hidden="true" />
        {exporting ? "Preparing…" : "Export PDF"}
      </button>
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="◆" iconBg="var(--gold)" title="Executive Summary" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>
        The agency&rsquo;s current operating position at a glance — deployment, attendance, discipline and
        compliance — aggregated from the live records rather than re-keyed, so these figures and the
        module reports behind them can never disagree.
      </PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="form-field">
            <label htmlFor="exec-period">Period</label>
            <select id="exec-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="4">Last 4 weeks</option>
              <option value="8">Last 8 weeks</option>
              <option value="12">Last 12 weeks</option>
              <option value="26">Last 26 weeks</option>
              <option value="custom">Custom date range…</option>
            </select>
          </div>
          {custom && (
            <>
              <div className="form-field">
                <label htmlFor="exec-from">From</label>
                <input id="exec-from" type="date" value={from} max={to || undefined}
                       onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="form-field">
                <label htmlFor="exec-to">To</label>
                <input id="exec-to" type="date" value={to} min={from || undefined}
                       onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="form-field">
            <label htmlFor="exec-site">Site</label>
            <select id="exec-site" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">All sites</option>
              {sites.map((sname) => <option key={sname} value={sname}>{sname}</option>)}
            </select>
          </div>
          <span style={{ fontSize: 12, alignSelf: "flex-end", paddingBottom: 9 }}>
            {rangeInvalid ? (
              <span style={{ color: "var(--red)" }}>The “to” date is before the “from” date.</span>
            ) : rangeIncomplete ? (
              <span style={{ color: "var(--text-mute)" }}>Choose both dates.</span>
            ) : data ? (
              <span style={{ color: "var(--text-mute)" }}>{data.range.from} to {data.range.to}</span>
            ) : null}
          </span>
        </div>
      </div>

      {error && (
        <div className="section-card">
          <div className="section-head">Could not load</div>
          <div style={{ padding: 18 }} className="empty-hint">{error}</div>
        </div>
      )}

      {!error && loading && !data && (
        <div className="section-card"><div style={{ padding: 18 }} className="empty-hint">Loading…</div></div>
      )}

      {!error && data && (
        <>
          <div className="kpi-grid" data-cols="4">
            <KpiCard
              label="Active personnel" value={k.activeHeadcount} icon="bi-people"
              note="Active in the 201 File"
            />
            <KpiCard
              label="Deployed this period" value={k.deployedGuards} icon="bi-person-badge"
              tone={k.deployedGuards < k.activeHeadcount ? "warn" : "good"}
              note={`of ${k.activeHeadcount} rostered to a post`}
            />
            <KpiCard
              label="Sites covered" value={k.sitesCovered} icon="bi-geo-alt"
              note="With roster activity this period"
            />
            <KpiCard
              label="Attendance compliance"
              value={compliance.value == null ? "—" : `${compliance.value}%`}
              icon="bi-check2-square"
              tone={compliance.value == null ? "neutral" : compliance.value >= 95 ? "good" : compliance.value >= 85 ? "warn" : "danger"}
              trend={cT.trend} trendLabel={cT.label}
              note={compliance.prior == null ? "On time, of days expected" : `vs ${compliance.prior}% prior period`}
            />
            <KpiCard
              label="Unexplained absences" value={absences.value} icon="bi-person-x"
              tone={absences.value > 0 ? "danger" : "good"}
              trend={aT.trend} trendLabel={aT.label}
              note={`vs ${absences.prior} prior period`}
            />
            <KpiCard
              label="Open disciplinary" value={k.openDisciplinary} icon="bi-exclamation-diamond"
              tone={k.openDisciplinary > 0 ? "warn" : "good"}
              note="Open or under review"
            />
            <KpiCard
              label="Open compliance items" value={k.complianceItems.open} icon="bi-clipboard-check"
              tone={k.complianceItems.open > 0 ? "warn" : "good"}
              note="Corrective actions not completed"
            />
            <KpiCard
              label="Overdue items" value={k.complianceItems.overdue} icon="bi-alarm"
              tone={k.complianceItems.overdue > 0 ? "danger" : "good"}
              note="Past their due date"
            />
          </div>

          {/* The rate above is a single number, and a single number invites
              argument. This is what it is made of, so it can be checked against
              Attendance Reports for the same dates. */}
          <div className="section-card">
            <div className="section-head">
              How the compliance rate is derived
              <span style={{ fontWeight: 400, fontSize: 12 }}>
                {data.range.from} to {data.range.to}
              </span>
            </div>
            <table>
              <tbody>
                <tr><td data-label="Days expected on post">Days expected on post</td><td data-label="Value">{a.expectedDays}</td></tr>
                <tr><td data-label="Present">Present</td><td data-label="Value">{a.present}</td></tr>
                <tr><td data-label="Of which late">Of which late</td><td data-label="Value">{a.late}</td></tr>
                <tr><td data-label="Absent">Absent</td><td data-label="Value">{a.absent}</td></tr>
                <tr><td data-label="On leave (not expected)">On leave (not expected)</td><td data-label="Value">{a.onLeave}</td></tr>
                <tr><td data-label="Rest day (not expected)">Rest day (not expected)</td><td data-label="Value">{a.restDay}</td></tr>
              </tbody>
            </table>
            <div style={{ padding: "12px 18px", fontSize: 12.5, color: "var(--text-mute)" }}>
              Compliance = (present &minus; late) &divide; days expected. Rest days and approved leave are
              not expected days, so a correct roster is never counted against.
            </div>
          </div>
        </>
      )}

      {!error && charts && (
        <>
          <div className="chart-grid">
            <StackedBars
              title="Attendance by week"
              hint="Days on post, split by how they ended."
              points={charts.weekly.map((w) => ({ label: weekLabel(w.week), ...w }))}
              series={[
                { key: "present", label: "Present", color: COLORS.TEAL },
                { key: "absent", label: "Absent", color: COLORS.RED },
                { key: "onLeave", label: "On leave", color: COLORS.BLUE },
                { key: "restDay", label: "Rest day", color: "#C3C9D2" },
              ]}
            />
            <StackedBars
              title="Overtime by week"
              hint="Built-in OT is inside the rostered shift; excess needs approval."
              unit=" min"
              points={charts.weekly.map((w) => ({ label: weekLabel(w.week), ...w }))}
              series={[
                { key: "builtinOtMin", label: "Built-in OT", color: COLORS.NAVY },
                { key: "excessOtMin", label: "Excess OT", color: COLORS.GOLD },
              ]}
            />
            <HBars
              title="Deployment by site"
              hint="Distinct guards rostered in this period."
              rows={charts.deploymentBySite} valueKey="guards" color={COLORS.NAVY}
            />
            <StackedBars
              title="Absence patterns by week"
              hint="Unexplained absences and shifts with no time-out."
              points={charts.absencePatterns.byWeek.map((w) => ({ label: weekLabel(w.week), ...w }))}
              series={[
                { key: "absent", label: "Absent", color: COLORS.RED },
                { key: "noTimeOut", label: "No time-out", color: COLORS.AMBER },
              ]}
            />
            <Donut
              title="Compliance audits"
              hint="Audit status. Pass/fail lives on the checklist items, not the audit."
              counts={charts.compliance.auditsByStatus}
              colors={{ Completed: COLORS.TEAL, "In Progress": COLORS.BLUE, Scheduled: "#8A93A2", Cancelled: COLORS.RED }}
            />
            <Donut
              title="Disciplinary cases"
              hint="Raised in this period, by status."
              counts={charts.disciplinaryByStatus}
              colors={{ Open: COLORS.RED, "Under Review": COLORS.AMBER, Resolved: COLORS.TEAL, Closed: "#8A93A2" }}
            />
          </div>
        </>
      )}

      <ConfidentialFooter />
    </div>
  );
}
