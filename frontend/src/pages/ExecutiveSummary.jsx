import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import ConfidentialFooter from "../components/ConfidentialFooter";

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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api("/executive-summary/kpis"));
      setError("");
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
    <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="◆" iconBg="var(--gold)" title="Executive Summary" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>
        The agency&rsquo;s current operating position at a glance — deployment, attendance, discipline and
        compliance — aggregated from the live records rather than re-keyed, so these figures and the
        module reports behind them can never disagree.
      </PurposeBar>

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

      <ConfidentialFooter />
    </div>
  );
}
