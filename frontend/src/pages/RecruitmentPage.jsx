import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewRecruitmentModal from "./NewRecruitmentModal";
import RecruitmentDetailModal from "./RecruitmentDetailModal";
import { rcStatusBadgeClass, buildRecruitmentKpis, RECRUITMENT_LIST_KEYS } from "./recruitmentShared";

const SUBTITLE = "Manage the entire guard recruitment process from application to first day";
const STATUS_OPTIONS = ["Applied", "Screening", "Interview", "Background & Medical Checks", "Approved", "Hired", "Onboarded", "Rejected"];

export default function RecruitmentPage() {
  const { isViewer, isAdmin } = useAuth();

  const [applicants, setApplicants] = useState([]);
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState([]);
  const [dropdowns, setDropdowns] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
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
      if (positionFilter) params.push(`position=${encodeURIComponent(positionFilter)}`);
      if (siteFilter) params.push(`site=${encodeURIComponent(siteFilter)}`);
      const [rows, statData] = await Promise.all([
        api(`/recruitment${params.length ? "?" + params.join("&") : ""}`),
        api("/recruitment/_all/stats").catch(() => null),
      ]);
      setApplicants(rows);
      if (statData) setStats(statData);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, positionFilter, siteFilter]);

  useEffect(() => {
    Promise.all([
      api("/meta/sites").catch(() => []),
      ...RECRUITMENT_LIST_KEYS.map((k) => api(`/meta/dropdown/${k}`).then((v) => [k, v]).catch(() => [k, []])),
    ]).then(([s, ...lists]) => { setSites(s); setDropdowns(Object.fromEntries(lists)); });
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  const siteOptions = useMemo(() => {
    const used = new Set(applicants.map((a) => a.site).filter(Boolean));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, applicants]);

  const positionOptions = dropdowns.position_title || [];
  const kpis = stats ? buildRecruitmentKpis(stats) : null;

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadList}>Refresh</button>
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New Applicant</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="👤" iconBg="var(--gold)" title="Recruitment, Hiring &amp; Onboarding" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Manage the entire guard recruitment process from application to first day.</PurposeBar>

      {kpis && (
        <div className="kpi-grid">
          {kpis.map((k) => (
            <div className={`kpi-card ${k.cls}`} key={k.label}>
              <div className="kpi-label">{k.label}</div>
              <div className="kpi-value">{k.value}</div>
              <div className="kpi-note">{k.note}</div>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search name or position..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)}>
            <option value="">All positions</option>
            {positionOptions.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${applicants.length} applicant${applicants.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Applicant register</div>
        <table>
          <thead>
            <tr>
              <th>Applicant</th><th>Full Name</th><th>Position</th><th>Site</th><th>Application Date</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={6}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={6}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && applicants.length === 0 && (
              <tr><td colSpan={6}><div className="empty-hint">No applicants found.</div></td></tr>
            )}
            {!loadError && !loading && applicants.map((a) => (
              <tr key={a.id} onClick={() => setDetailId(a.id)} style={{ cursor: "pointer" }}>
                <td data-label="Applicant"><strong>{a.code}</strong></td>
                <td data-label="Full Name">{a.fullName}</td>
                <td data-label="Position">{a.position || "—"}</td>
                <td data-label="Site"><span className="chip">{a.site || "—"}</span></td>
                <td data-label="Application Date">{a.applicationDate}</td>
                <td data-label="Status"><span className={`badge ${rcStatusBadgeClass(a.status)}`}>{a.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>

      {showNewModal && (
        <NewRecruitmentModal
          sites={sites}
          positionTypes={positionOptions}
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await loadList();
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <RecruitmentDetailModal
          applicantId={detailId}
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
