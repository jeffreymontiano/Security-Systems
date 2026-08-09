import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewPerformanceModal from "./NewPerformanceModal";
import PerformanceDetailModal from "./PerformanceDetailModal";
import { paStatusBadgeClass } from "./performanceShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Measure and continuously improve guard performance through structured evaluations";

export default function PerformancePage() {
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;

  const [appraisals, setAppraisals] = useState([]);
  const [sites, setSites] = useState([]);
  const [promotionOptions, setPromotionOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [siteFilter, setSiteFilter] = useState("");

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
      const rows = await api(`/performance${params.length ? "?" + params.join("&") : ""}`);
      setAppraisals(rows);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, siteFilter]);

  useEffect(() => {
    Promise.all([
      api("/meta/sites").catch(() => []),
      api("/meta/dropdown/promotion_recommendation").catch(() => []),
    ]).then(([s, promo]) => { setSites(s); setPromotionOptions(promo); });
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(appraisals.map((c) => c.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, appraisals]);

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {perm.add && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New Appraisal</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="📈" iconBg="var(--gold)" title="Performance Appraisal" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Measure and continuously improve guard performance through structured evaluations.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search employee or evaluator..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Draft">Draft</option>
            <option value="Submitted">Submitted</option>
            <option value="Finalized">Finalized</option>
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${appraisals.length} appraisal${appraisals.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Performance appraisal register</div>
        <table>
          <thead>
            <tr>
              <th>Appraisal</th><th>Employee</th><th>Site</th><th>Evaluation Date</th><th>Overall Score</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={6}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={6}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && appraisals.length === 0 && (
              <tr><td colSpan={6}><div className="empty-hint">No appraisals found.</div></td></tr>
            )}
            {!loadError && !loading && appraisals.map((c) => (
              <tr key={c.id} onClick={() => setDetailId(c.id)} style={{ cursor: "pointer" }}>
                <td data-label="Appraisal"><strong>{c.code}</strong></td>
                <td data-label="Employee">{c.employeeName}</td>
                <td data-label="Site"><span className="chip">{c.site || "—"}</span></td>
                <td data-label="Evaluation Date">{c.evaluationDate}</td>
                <td data-label="Overall Score">{c.overallScore !== null && c.overallScore !== undefined ? `${c.overallScore} / 5` : "—"}</td>
                <td data-label="Status"><span className={`badge ${paStatusBadgeClass(c.status)}`}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfidentialFooter />

      {showNewModal && (
        <NewPerformanceModal
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
        <PerformanceDetailModal
          appraisalId={detailId}
          isViewer={isViewer}
          isAdmin={isAdmin}
          canDelete={perm.delete}
          promotionOptions={promotionOptions}
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
