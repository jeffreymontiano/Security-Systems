import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewDsrModal from "./NewDsrModal";
import DsrDetailModal from "./DsrDetailModal";
import ShareFormModal from "./ShareFormModal";
import { dsrStatusBadgeClass } from "./dsrShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Standardize daily reporting from all sites with structured digital workflows";

export default function DsrPage() {
  const { isViewer, isAdmin } = useAuth();

  const [reports, setReports] = useState([]);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Default period is "daily" to match the legacy app's initial view.
  const [period, setPeriod] = useState("daily");
  const [siteFilter, setSiteFilter] = useState("");

  const [showNewModal, setShowNewModal] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [showShare, setShowShare] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const qs = [];
      if (period) qs.push(`period=${encodeURIComponent(period)}`);
      if (siteFilter) qs.push(`site=${encodeURIComponent(siteFilter)}`);
      const rows = await api(`/dsr${qs.length ? "?" + qs.join("&") : ""}`);
      setReports(rows);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period, siteFilter]);

  // Sites for the filter dropdown come from /meta/sites (loaded once).
  useEffect(() => {
    api("/meta/sites").then(setSites).catch(() => setSites([]));
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(reports.map((r) => r.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, reports]);

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {isAdmin && <button className="btn btn-outline btn-sm" onClick={() => setShowShare(true)}>Share form link</button>}
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New DSR</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="📋" iconBg="var(--gold)" title="Daily Security Report" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Standardize daily reporting from all sites with structured digital workflows.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="daily">Daily reports</option>
            <option value="weekly">Weekly summaries</option>
            <option value="monthly">Monthly summaries</option>
            <option value="annual">Annual summaries</option>
            <option value="">All reports</option>
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Daily Security Reports</div>
        <table>
          <thead>
            <tr>
              <th>Report</th><th>Date</th><th>Site</th><th>Shift</th><th>Submitted by</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={6}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={6}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && reports.length === 0 && (
              <tr><td colSpan={6}><div className="empty-hint">No reports for this period.</div></td></tr>
            )}
            {!loadError && !loading && reports.map((r) => (
              <tr key={r.id} onClick={() => setDetailId(r.id)} style={{ cursor: "pointer" }}>
                <td data-label="Report"><strong>{r.code}</strong></td>
                <td data-label="Date">{r.date}</td>
                <td data-label="Site"><span className="chip">{r.site || "—"}</span></td>
                <td data-label="Shift">{r.shift || "—"}</td>
                <td data-label="Submitted by">{r.submittedBy || "—"}</td>
                <td data-label="Status"><span className={`badge ${dsrStatusBadgeClass(r.status)}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfidentialFooter />

      {showNewModal && (
        <NewDsrModal
          sites={sites}
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await loadList();
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <DsrDetailModal
          dsrId={detailId}
          isViewer={isViewer}
          isAdmin={isAdmin}
          onClose={() => setDetailId(null)}
          onChanged={loadList}
          onDeleted={async () => {
            setDetailId(null);
            await loadList();
          }}
        />
      )}

      {showShare && <ShareFormModal kind="dsr" onClose={() => setShowShare(false)} />}
    </div>
  );
}
