import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import NewEmployeeModal from "./NewEmployeeModal";
import EmployeeDetailModal from "./EmployeeDetailModal";
import { employmentStatusClass, countChipClass, EMPLOYMENT_STATUSES } from "./employeeShared";

const SUBTITLE = "Central repository of all personnel records and government-required documents";

export default function HrModulePage() {
  const { isViewer } = useAuth();

  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSite, setFilterSite] = useState("");

  const [showNewModal, setShowNewModal] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const emp = await api("/employees");
      setEmployees(emp);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const siteOptions = useMemo(() => {
    const used = new Set(employees.map((e) => e.site).filter(Boolean));
    return [...used].sort();
  }, [employees]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees
      .filter((e) => {
        const hay = [e.fullName, e.employeeNo, e.position, e.site, e.contactNumber, e.email]
          .join(" ").toLowerCase();
        if (q && !hay.includes(q)) return false;
        if (filterStatus && e.employmentStatus !== filterStatus) return false;
        if (filterSite && e.site !== filterSite) return false;
        return true;
      })
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }, [employees, search, filterStatus, filterSite]);

  const stats = useMemo(() => {
    const active = employees.filter((e) => e.employmentStatus === "Active").length;
    const separated = employees.filter((e) => e.employmentStatus === "Separated").length;
    const onLeave = employees.filter((e) => e.employmentStatus === "On Leave").length;
    return { active, separated, onLeave, total: employees.length };
  }, [employees]);

  const actions = (
    <>
      {!isViewer && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New employee</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader title="Employee Master File (201 File) / HR Module" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Central repository of all personnel records and government-required documents.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search name, employee no, or position..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            {EMPLOYMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} employee${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {!loading && !loadError && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <div className="kpi-card good">
            <div className="kpi-label">Active</div>
            <div className="kpi-value">{stats.active}</div>
          </div>
          <div className="kpi-card warn">
            <div className="kpi-label">On leave</div>
            <div className="kpi-value">{stats.onLeave}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Separated</div>
            <div className="kpi-value">{stats.separated}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Total personnel</div>
            <div className="kpi-value">{stats.total}</div>
          </div>
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Employee register</div>
        <table>
          <thead>
            <tr>
              <th>Employee No</th><th>Full Name</th><th>Position</th><th>Site</th>
              <th>Status</th><th>Date Hired</th><th>Documents</th><th>Education</th><th>Employment</th>
            </tr>
          </thead>
          <tbody>
            {loadError && (
              <tr className="empty-row"><td colSpan={9}>{loadError}</td></tr>
            )}
            {!loadError && loading && (
              <tr className="empty-row"><td colSpan={9}>Loading employees...</td></tr>
            )}
            {!loadError && !loading && rows.length === 0 && (
              <tr className="empty-row"><td colSpan={9}>No employees match your filters.</td></tr>
            )}
            {!loadError && rows.map((e) => (
              <tr key={e.id} onClick={() => setDetailId(e.id)} style={{ cursor: "pointer" }}>
                <td data-label="Employee No"><strong>{e.employeeNo || "\u2014"}</strong></td>
                <td data-label="Full Name">{e.fullName}</td>
                <td data-label="Position">{e.position || "\u2014"}</td>
                <td data-label="Site">{e.site ? <span className="chip">{e.site}</span> : "\u2014"}</td>
                <td data-label="Status"><span className={`badge ${employmentStatusClass(e.employmentStatus)}`}>{e.employmentStatus}</span></td>
                <td data-label="Date Hired">{e.dateHired || "\u2014"}</td>
                <td data-label="Documents"><span className={countChipClass(e.documents.length)}>{e.documents.length}</span></td>
                <td data-label="Education"><span className={countChipClass(e.education.length)}>{e.education.length}</span></td>
                <td data-label="Employment"><span className={countChipClass(e.employment.length)}>{e.employment.length}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>

      {showNewModal && (
        <NewEmployeeModal
          onClose={() => setShowNewModal(false)}
          onCreated={async (empId) => {
            setShowNewModal(false);
            await loadData();
            setDetailId(empId);
          }}
        />
      )}

      {detailId && (
        <EmployeeDetailModal
          employeeId={detailId}
          isViewer={isViewer}
          onClose={() => setDetailId(null)}
          onChanged={loadData}
          onDeleted={async () => {
            setDetailId(null);
            await loadData();
          }}
        />
      )}
    </div>
  );
}
