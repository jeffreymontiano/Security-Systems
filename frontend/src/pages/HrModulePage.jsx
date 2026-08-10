import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import NewEmployeeModal from "./NewEmployeeModal";
import EmployeeDetailModal from "./EmployeeDetailModal";
import { employmentStatusClass, countChipClass, EMPLOYMENT_STATUSES } from "./employeeShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Central repository of all personnel records and government-required documents";

export default function HrModulePage() {
  // Gated on the per-user Access Privileges matrix, not on the role. `isViewer`
  // could not see an override an administrator set in Manage Users, which is
  // why granted actions stayed hidden and denied ones stayed visible.
  const perm = useModulePerms();

  const [employees, setEmployees] = useState([]);
  const [siteList, setSiteList] = useState([]); // authoritative sites from List Settings (meta)
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSite, setFilterSite] = useState("");
  // Which column the register is ordered by. Full Name ascending is the order
  // the page has always opened in, so the default is not a new behaviour.
  const [sort, setSort] = useState({ key: "fullName", dir: "asc" });

  // First click on a column sorts it ascending; clicking the SAME column again
  // flips the direction. Moving to a different column starts at ascending
  // rather than inheriting the previous column's direction, which would leave
  // the arrow pointing the way the user never asked for.
  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

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

  // Load the authoritative site list from the List Settings module (meta/sites)
  // for the form dropdowns. Falls back silently to an empty list on error so the
  // page still works even if the fetch fails.
  useEffect(() => {
    let active = true;
    api("/meta/sites")
      .then((sites) => { if (active) setSiteList(Array.isArray(sites) ? sites : []); })
      .catch(() => { if (active) setSiteList([]); });
    return () => { active = false; };
  }, []);

  // Sites for the FILTER dropdown: those actually used by employees, plus any
  // from List Settings, so you can filter even before an employee uses a site.
  const siteOptions = useMemo(() => {
    const used = new Set(employees.map((e) => e.site).filter(Boolean));
    siteList.forEach((s) => used.add(s));
    return [...used].sort();
  }, [employees, siteList]);

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
      .sort((a, b) => {
        const av = String(a[sort.key] ?? ""), bv = String(b[sort.key] ?? "");
        // `numeric` so "2026-0002" sorts before "2026-0011" on the digits rather
        // than character by character — which is only accidentally right while
        // every number is zero-padded to the same width, and stops being right
        // the moment one is not. `sensitivity: base` keeps "de la Cruz" beside
        // "De La Cruz" instead of grouping all capitals first.
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
        return sort.dir === "asc" ? cmp : -cmp;
      });
  }, [employees, search, filterStatus, filterSite, sort]);

  const stats = useMemo(() => {
    const active = employees.filter((e) => e.employmentStatus === "Active").length;
    const separated = employees.filter((e) => e.employmentStatus === "Separated").length;
    const onLeave = employees.filter((e) => e.employmentStatus === "On Leave").length;
    return { active, separated, onLeave, total: employees.length };
  }, [employees]);

  const actions = (
    <>
      {perm.add && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New employee</button>}
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
        <div className="kpi-grid" data-cols="4">
          <KpiCard label={<>Active</>} value={stats.active} tone="good" icon="bi-person-check" />
          <KpiCard label={<>On leave</>} value={stats.onLeave} tone="warn" icon="bi-airplane" />
          <KpiCard label={<>Separated</>} value={stats.separated} tone="neutral" icon="bi-person-dash" />
          <KpiCard label={<>Total personnel</>} value={stats.total} tone="neutral" icon="bi-people" />
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Employee register</div>
        <table>
          <thead>
            <tr>
              <SortableTh label="Employee No" sortKey="employeeNo" sort={sort} onSort={toggleSort} />
              <SortableTh label="Full Name" sortKey="fullName" sort={sort} onSort={toggleSort} />
              <th>Position</th><th>Site</th>
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

      <ConfidentialFooter />

      {showNewModal && (
        <NewEmployeeModal
          siteOptions={siteList}
          onClose={() => setShowNewModal(false)}
          onCreated={async (empId) => {
            setShowNewModal(false);
            await loadData();
            setDetailId(empId);
          }}
        />
      )}

      {/* Edit and Delete are separate privileges, so they are passed
          separately. The modal used to derive both from one `isViewer`, which
          made "Add and Edit but not Delete" impossible to express. */}
      {detailId && (
        <EmployeeDetailModal
          employeeId={detailId}
          siteOptions={siteList}
          canEdit={perm.edit}
          canDelete={perm.delete}
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

/**
 * A column header that sorts the register.
 *
 * The clickable thing is a real <button> inside the <th>, not a click handler on
 * the cell: it is then reachable by Tab, activates on Enter and Space without
 * any key handling of our own, and is announced as a control rather than as
 * text that happens to respond to a mouse.
 *
 * `aria-sort` goes on the <th> — that is the element the attribute is defined
 * for — so a screen reader states the current order when it reads the column,
 * instead of the arrow being the only signal.
 */
function SortableTh({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} style={{ padding: 0 }}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label} ${active && dir === "asc" ? "descending" : "ascending"}`}
        style={{
          all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
          width: "100%", boxSizing: "border-box", padding: "12px 14px",
          font: "inherit", color: "inherit", letterSpacing: "inherit", textTransform: "inherit",
        }}
      >
        {label}
        {/* The inactive glyph is dimmed rather than absent, so the column does
            not change width when it becomes the sorted one. */}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.35, fontSize: 10 }}>
          {active ? (dir === "asc" ? "▲" : "▼") : "▲"}
        </span>
      </button>
    </th>
  );
}
