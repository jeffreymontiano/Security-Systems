import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewTrainingModal from "./NewTrainingModal";
import TrainingDetailModal from "./TrainingDetailModal";
import ExpiryBadge from "./ExpiryBadge";
import { trStatusBadgeClass, daysUntil, TRAINING_LIST_KEYS } from "./trainingShared";

const SUBTITLE = "Ensure all personnel remain qualified, certified, and mission-ready";

export default function TrainingPage() {
  const { isViewer, isAdmin } = useAuth();

  const [records, setRecords] = useState([]);
  const [sites, setSites] = useState([]);
  const [dropdowns, setDropdowns] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [expiryFilter, setExpiryFilter] = useState("");

  const [showNewModal, setShowNewModal] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const debounceRef = useRef(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = [];
      if (search.trim()) params.push(`search=${encodeURIComponent(search.trim())}`);
      if (statusFilter) params.push(`status=${encodeURIComponent(statusFilter)}`);
      if (siteFilter) params.push(`site=${encodeURIComponent(siteFilter)}`);
      if (expiryFilter) params.push(`expiry=${encodeURIComponent(expiryFilter)}`);
      const rows = await api(`/training${params.length ? "?" + params.join("&") : ""}`);
      setRecords(rows);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, siteFilter, expiryFilter]);

  useEffect(() => {
    Promise.all([
      api("/meta/sites").catch(() => []),
      ...TRAINING_LIST_KEYS.map((k) => api(`/meta/dropdown/${k}`).then((v) => [k, v]).catch(() => [k, []])),
    ]).then(([s, ...lists]) => { setSites(s); setDropdowns(Object.fromEntries(lists)); });
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(records.map((c) => c.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, records]);

  // KPIs computed from the currently-filtered rows (matches renderTrainingKpis).
  const kpis = useMemo(() => {
    const total = records.length;
    const completed = records.filter((r) => r.status === "Completed").length;
    const upcoming = records.filter((r) => r.status === "Scheduled").length;
    const expiringSoon = records.filter((r) => {
      const d = daysUntil(r.certificationExpiryDate);
      return d !== null && d >= 0 && d <= 30;
    }).length;
    const expired = records.filter((r) => {
      const d = daysUntil(r.certificationExpiryDate);
      return d !== null && d < 0;
    }).length;
    return [
      { label: "Total Records", value: total, note: "Matching current filters", cls: "blue" },
      { label: "Completed", value: completed, note: "Training completed", cls: "good" },
      { label: "Upcoming", value: upcoming, note: "Scheduled ahead", cls: "blue" },
      { label: "Expiring Soon", value: expiringSoon, note: "Within 30 days", cls: expiringSoon > 0 ? "warn" : "good" },
      { label: "Expired", value: expired, note: "Certification lapsed", cls: expired > 0 ? "danger" : "good" },
    ];
  }, [records]);

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New Record</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="🎓" iconBg="var(--gold)" title="Training &amp; Certification Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Ensure all personnel remain qualified, certified, and mission-ready.</PurposeBar>

      <div className="kpi-grid">
        {kpis.map((k) => (
          <div className={`kpi-card ${k.cls}`} key={k.label}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-note">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search employee, course, certification..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Scheduled">Scheduled</option>
            <option value="In Progress">In Progress</option>
            <option value="Completed">Completed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={expiryFilter} onChange={(e) => setExpiryFilter(e.target.value)}>
            <option value="">All certifications</option>
            <option value="expiring">Expiring within 30 days</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${records.length} record${records.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Training &amp; certification register</div>
        <table>
          <thead>
            <tr>
              <th>Record</th><th>Employee</th><th>Site</th><th>Course</th><th>Scheduled Date</th><th>Status</th><th>Certification Expiry</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={7}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={7}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && records.length === 0 && (
              <tr><td colSpan={7}><div className="empty-hint">No training records found.</div></td></tr>
            )}
            {!loadError && !loading && records.map((c) => (
              <tr key={c.id} onClick={() => setDetailId(c.id)} style={{ cursor: "pointer" }}>
                <td data-label="Record"><strong>{c.code}</strong></td>
                <td data-label="Employee">{c.employeeName}</td>
                <td data-label="Site"><span className="chip">{c.site || "—"}</span></td>
                <td data-label="Course">{c.courseName || "—"}</td>
                <td data-label="Scheduled Date">{c.scheduledDate}</td>
                <td data-label="Status"><span className={`badge ${trStatusBadgeClass(c.status)}`}>{c.status}</span></td>
                <td data-label="Certification Expiry"><ExpiryBadge date={c.certificationExpiryDate} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>

      {showNewModal && (
        <NewTrainingModal
          sites={sites}
          courseTypes={dropdowns.training_type || []}
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await loadList();
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <TrainingDetailModal
          recordId={detailId}
          isViewer={isViewer}
          isAdmin={isAdmin}
          dropdowns={dropdowns}
          onClose={() => setDetailId(null)}
          onChanged={loadList}
          onDeleted={async () => {
            setDetailId(null);
            await loadList();
          }}
        />
      )}
    </div>
  );
}
