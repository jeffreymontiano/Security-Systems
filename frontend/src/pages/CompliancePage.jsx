import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewComplianceModal from "./NewComplianceModal";
import ComplianceDetailModal from "./ComplianceDetailModal";
import ScoreBadge from "./ScoreBadge";
import { caStatusBadgeClass } from "./complianceShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Ensure adherence to company policies, client requirements, and labor regulations";

export default function CompliancePage() {
  const { isViewer, isAdmin } = useAuth();

  const [audits, setAudits] = useState([]);
  const [sites, setSites] = useState([]);
  const [areaOptions, setAreaOptions] = useState([]);
  const [correctiveStatuses, setCorrectiveStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
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
      if (areaFilter) params.push(`area=${encodeURIComponent(areaFilter)}`);
      if (siteFilter) params.push(`site=${encodeURIComponent(siteFilter)}`);
      const rows = await api(`/compliance${params.length ? "?" + params.join("&") : ""}`);
      setAudits(rows);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, areaFilter, siteFilter]);

  useEffect(() => {
    Promise.all([
      api("/meta/sites").catch(() => []),
      api("/meta/dropdown/compliance_area").catch(() => []),
      api("/meta/dropdown/corrective_action_status").catch(() => []),
    ]).then(([s, areas, statuses]) => { setSites(s); setAreaOptions(areas); setCorrectiveStatuses(statuses); });
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(audits.map((c) => c.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, audits]);

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New Audit</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="✅" iconBg="var(--gold)" title="Compliance &amp; Audit" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Ensure adherence to company policies, client requirements, and labor regulations.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search auditor or notes..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Scheduled">Scheduled</option>
            <option value="In Progress">In Progress</option>
            <option value="Completed">Completed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
          <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
            <option value="">All compliance areas</option>
            {areaOptions.map((a) => <option key={a}>{a}</option>)}
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${audits.length} audit${audits.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Compliance audit register</div>
        <table>
          <thead>
            <tr>
              <th>Audit</th><th>Site</th><th>Compliance Area</th><th>Audit Date</th><th>Auditor</th><th>Score</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={7}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={7}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && audits.length === 0 && (
              <tr><td colSpan={7}><div className="empty-hint">No audits found.</div></td></tr>
            )}
            {!loadError && !loading && audits.map((c) => (
              <tr key={c.id} onClick={() => setDetailId(c.id)} style={{ cursor: "pointer" }}>
                <td data-label="Audit"><strong>{c.code}</strong></td>
                <td data-label="Site"><span className="chip">{c.site || "—"}</span></td>
                <td data-label="Compliance Area">{c.complianceArea || "—"}</td>
                <td data-label="Audit Date">{c.auditDate}</td>
                <td data-label="Auditor">{c.auditorName || "—"}</td>
                <td data-label="Score"><ScoreBadge score={c.score} /></td>
                <td data-label="Status"><span className={`badge ${caStatusBadgeClass(c.status)}`}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfidentialFooter />

      {showNewModal && (
        <NewComplianceModal
          sites={sites}
          areaOptions={areaOptions}
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await loadList();
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <ComplianceDetailModal
          auditId={detailId}
          isViewer={isViewer}
          isAdmin={isAdmin}
          correctiveStatuses={correctiveStatuses}
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
