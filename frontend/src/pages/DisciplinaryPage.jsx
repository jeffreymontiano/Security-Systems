import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewDisciplinaryModal from "./NewDisciplinaryModal";
import DisciplinaryDetailModal from "./DisciplinaryDetailModal";
import { daStatusBadgeClass } from "./disciplinaryShared";

const SUBTITLE = "Monitor employee discipline and enforce consistent compliance standards";

export default function DisciplinaryPage() {
  const { isViewer, isAdmin } = useAuth();

  const [cases, setCases] = useState([]);
  const [sites, setSites] = useState([]);
  const [violationTypes, setViolationTypes] = useState([]);
  const [penaltyTypes, setPenaltyTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [siteFilter, setSiteFilter] = useState("");

  const [showNewModal, setShowNewModal] = useState(false);
  const [detailId, setDetailId] = useState(null);

  // Filtering is server-side (?search=&status=&site=). Debounce the search box
  // so we aren't firing a request on every keystroke.
  const debounceRef = useRef(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = [];
      if (search.trim()) params.push(`search=${encodeURIComponent(search.trim())}`);
      if (statusFilter) params.push(`status=${encodeURIComponent(statusFilter)}`);
      if (siteFilter) params.push(`site=${encodeURIComponent(siteFilter)}`);
      const rows = await api(`/disciplinary${params.length ? "?" + params.join("&") : ""}`);
      setCases(rows);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, siteFilter]);

  // Reference data loaded once.
  useEffect(() => {
    Promise.all([
      api("/meta/sites").catch(() => []),
      api("/meta/dropdown/violation_type").catch(() => []),
      api("/meta/dropdown/penalty_type").catch(() => []),
    ]).then(([s, vt, pt]) => { setSites(s); setViolationTypes(vt); setPenaltyTypes(pt); });
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(cases.map((c) => c.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, cases]);

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New Case</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="⚖" iconBg="var(--gold)" title="Disciplinary Action &amp; Infraction Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Monitor employee discipline and enforce consistent compliance standards.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search employee, violation, notes..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Open">Open</option>
            <option value="Under Review">Under Review</option>
            <option value="Resolved">Resolved</option>
            <option value="Closed">Closed</option>
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${cases.length} case${cases.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Disciplinary case register</div>
        <table>
          <thead>
            <tr>
              <th>Case</th><th>Employee</th><th>Site</th><th>Violation Type</th><th>Violation Date</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={6}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={6}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && cases.length === 0 && (
              <tr><td colSpan={6}><div className="empty-hint">No cases found.</div></td></tr>
            )}
            {!loadError && !loading && cases.map((c) => (
              <tr key={c.id} onClick={() => setDetailId(c.id)} style={{ cursor: "pointer" }}>
                <td data-label="Case"><strong>{c.code}</strong></td>
                <td data-label="Employee">{c.employeeName}</td>
                <td data-label="Site"><span className="chip">{c.site || "—"}</span></td>
                <td data-label="Violation Type">{c.violationType || "—"}</td>
                <td data-label="Violation Date">{c.violationDate}</td>
                <td data-label="Status"><span className={`badge ${daStatusBadgeClass(c.status)}`}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>

      {showNewModal && (
        <NewDisciplinaryModal
          sites={sites}
          violationTypes={violationTypes}
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await loadList();
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <DisciplinaryDetailModal
          caseId={detailId}
          isViewer={isViewer}
          isAdmin={isAdmin}
          violationTypes={violationTypes}
          penaltyTypes={penaltyTypes}
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
