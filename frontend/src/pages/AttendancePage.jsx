import { useEffect, useMemo, useState, useCallback } from "react";
import { api, apiBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ShareFormModal from "./ShareFormModal";
import AttendanceReports from "./AttendanceReports";
import AbsenceMonitoring from "./AbsenceMonitoring";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Monitor guard attendance and deployment in real time across all sites";

// Small component that fetches an auth-protected selfie as a blob URL (a bare
// <img src> can't send the token, so we load it via apiBlobUrl like other
// protected images in the app).
function SelfieThumb({ recordId }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; let objUrl = null;
    apiBlobUrl(`/attendance/${recordId}/selfie`)
      .then((u) => { if (active) { objUrl = u; setUrl(u); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [recordId]);
  if (failed) return <span style={{ color: "var(--text-mute)", fontSize: 12 }}>—</span>;
  if (!url) return <span style={{ color: "var(--text-mute)", fontSize: 12 }}>…</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Selfie" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
    </a>
  );
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  // Always display in Philippine time regardless of the viewer's browser zone.
  return d.toLocaleString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function AttendancePage() {
  const { isViewer, isAdmin } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [filterSite, setFilterSite] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterGuard, setFilterGuard] = useState("");
  // Register date range. Empty = no bound, so the default view still shows
  // every record and existing behaviour is unchanged until a date is set.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [employeeList, setEmployeeList] = useState([]);
  const [allSites, setAllSites] = useState([]);
  const [showShare, setShowShare] = useState(false);
  const [view, setView] = useState("register"); // "register" | "reports"

  const loadData = useCallback(async () => {
    try {
      const rows = await api("/attendance");
      setRecords(rows);
      setLoadError("");
    } catch (e) { setLoadError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Load active employees (201 File) for the Guard filter dropdown.
  useEffect(() => {
    let active = true;
    api("/leave/employees")
      .then((emps) => { if (active) setEmployeeList(Array.isArray(emps) ? emps : []); })
      .catch(() => { /* keep empty */ });
    return () => { active = false; };
  }, []);

  // Load the full Site list from Manage Lists so the Site filter shows every
  // configured site, not only those already present in attendance records.
  useEffect(() => {
    let active = true;
    api("/meta/sites")
      .then((sites) => { if (active) setAllSites(Array.isArray(sites) ? sites : []); })
      .catch(() => { /* fall back to sites derived from records */ });
    return () => { active = false; };
  }, []);

  const siteOptions = useMemo(() => {
    // Full master list from Manage Lists, plus any site already present in
    // records (so nothing in the data is unfilterable). Default remains "All sites".
    const set = new Set(allSites);
    records.forEach((r) => { if (r.site) set.add(r.site); });
    return [...set].sort();
  }, [allSites, records]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const g = filterGuard.trim().toLowerCase();
    // Punches are UTC instants but guards work in PH time, so the range is
    // compared against the PH calendar date — otherwise a 06:00 PH punch
    // (22:00 UTC the previous day) would fall outside its own duty date.
    const phDate = (iso) => new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    return records.filter((r) => {
      if (q && !`${r.guardName} ${r.site}`.toLowerCase().includes(q)) return false;
      if (filterSite && r.site !== filterSite) return false;
      if (filterType && r.punchType !== filterType) return false;
      if (g && (r.guardName || "").trim().toLowerCase() !== g) return false;
      if (fromDate || toDate) {
        const d = phDate(r.punchAt);
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
      }
      return true;
    });
  }, [records, search, filterSite, filterType, filterGuard, fromDate, toDate]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const todays = records.filter((r) => new Date(r.punchAt).toDateString() === today);
    return {
      todayIn: todays.filter((r) => r.punchType === "IN").length,
      todayOut: todays.filter((r) => r.punchType === "OUT").length,
      todayTotal: todays.length,
      total: records.length,
    };
  }, [records]);

  async function removeRecord(id, e) {
    e.stopPropagation();
    if (!window.confirm("Delete this attendance record?")) return;
    try { await api(`/attendance/${id}`, { method: "DELETE" }); await loadData(); }
    catch (err) { setLoadError(err.message); }
  }

  const actions = (
    <>
      {isAdmin && <button className="btn btn-outline" onClick={() => setShowShare(true)}>Share attendance link</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader title="Attendance &amp; Timekeeping Module" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Monitor guard attendance and deployment in real time across all sites. Guards submit time records with a selfie and location via the shared attendance link.</PurposeBar>

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0" }}>
        <button className={`btn btn-sm ${view === "register" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("register")}>Register</button>
        <button className={`btn btn-sm ${view === "reports" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("reports")}>Reports</button>
        <button className={`btn btn-sm ${view === "absence" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("absence")}>Absence Monitoring</button>
      </div>

      {view === "reports" && <AttendanceReports siteOptions={siteOptions} />}

      {view === "absence" && <AbsenceMonitoring siteOptions={siteOptions} />}

      {view === "register" && (
      <>
      <div className="toolbar">
        <div className="toolbar-left">
          <input type="text" className="search-input" placeholder="Search name or site..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All records</option>
            <option value="IN">Time IN</option>
            <option value="OUT">Time OUT</option>
          </select>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={filterGuard} onChange={(e) => setFilterGuard(e.target.value)}>
            <option value="">All guards</option>
            {employeeList.map((emp) => <option key={emp.id} value={emp.fullName}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
          </select>
          <label style={{ fontSize: 11, color: "var(--text-mute)", display: "flex", flexDirection: "column", gap: 2 }}>
            From
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label style={{ fontSize: 11, color: "var(--text-mute)", display: "flex", flexDirection: "column", gap: 2 }}>
            To
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} />
          </label>
          {(fromDate || toDate) && (
            <button className="btn btn-sm btn-secondary" onClick={() => { setFromDate(""); setToDate(""); }}>Clear dates</button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} record${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {!loading && !loadError && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <div className="kpi-card good"><div className="kpi-label">Time IN today</div><div className="kpi-value">{stats.todayIn}</div></div>
          <div className="kpi-card danger"><div className="kpi-label">Time OUT today</div><div className="kpi-value">{stats.todayOut}</div></div>
          <div className="kpi-card"><div className="kpi-label">Records today</div><div className="kpi-value">{stats.todayTotal}</div></div>
          <div className="kpi-card"><div className="kpi-label">Total records</div><div className="kpi-value">{stats.total}</div></div>
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Attendance register</div>
        <div className="table-scroll">
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Selfie</th><th>Employee No</th><th>Guard</th><th>Site</th><th>Record</th><th>Date &amp; time</th><th>Location</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loadError && <tr className="empty-row"><td colSpan={isAdmin ? 8 : 7}>{loadError}</td></tr>}
            {!loadError && loading && <tr className="empty-row"><td colSpan={isAdmin ? 8 : 7}>Loading attendance…</td></tr>}
            {!loadError && !loading && rows.length === 0 && <tr className="empty-row"><td colSpan={isAdmin ? 8 : 7}>No attendance records match your filters.</td></tr>}
            {!loadError && rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Selfie">{r.hasSelfie ? <SelfieThumb recordId={r.id} /> : <span style={{ color: "var(--text-mute)" }}>—</span>}</td>
                <td data-label="Employee No">{r.employeeNo || "—"}</td>
                <td data-label="Guard"><strong>{r.guardName}</strong></td>
                <td data-label="Site">{r.site ? <span className="chip">{r.site}</span> : "—"}</td>
                <td data-label="Record">
                  <span className={`badge ${r.punchType === "IN" ? "badge-resolved" : "badge-open"}`}>Time {r.punchType}</span>
                  {r.createdBy && String(r.createdBy).startsWith("correction:") && (
                    <div style={{ fontSize: 10.5, color: "var(--teal, #0e7c86)", fontWeight: 600, marginTop: 3 }}>
                      ✎ Corrected via approved request
                    </div>
                  )}
                </td>
                <td data-label="Date & time">{fmtDateTime(r.punchAt)}</td>
                <td data-label="Location">
                  {r.mapsUrl
                    ? <a href={r.mapsUrl} target="_blank" rel="noreferrer">View on map</a>
                    : <span style={{ color: "var(--text-mute)" }}>—</span>}
                </td>
                {isAdmin && (
                  <td data-label="" style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm btn-danger" onClick={(e) => removeRecord(r.id, e)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      </>
      )}

      <ConfidentialFooter />

      {showShare && <ShareFormModal kind="attendance" onClose={() => setShowShare(false)} />}
    </div>
  );
}
