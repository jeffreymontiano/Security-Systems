import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";

// Local YYYY-MM-DD for date inputs.
function isoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function mins(n) { return n ? `${n} min` : "—"; }

const TABS = [
  { key: "daily", label: "Daily Attendance" },
  { key: "late", label: "Late & Undertime" },
  { key: "overtime", label: "Overtime" },
];

export default function AttendanceReports({ siteOptions = [] }) {
  const today = new Date();
  // Default range = the current week, Sunday through Saturday.
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

  const [siteList, setSiteList] = useState(siteOptions); // full list from Manage Lists
  const [from, setFrom] = useState(isoDate(weekStart));
  const [to, setTo] = useState(isoDate(weekEnd));
  const [site, setSite] = useState("");
  const [grace, setGrace] = useState(15);
  const [otThreshold, setOtThreshold] = useState(30);
  const [tab, setTab] = useState("daily");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runReport = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams({ from, to, grace: String(grace), otThreshold: String(otThreshold) });
      if (site) qs.set("site", site);
      const res = await api(`/attendance-reports?${qs.toString()}`);
      setData(res);
    } catch (e) { setError(e.message); setData(null); }
    finally { setLoading(false); }
  }, [from, to, site, grace, otThreshold]);

  useEffect(() => { runReport(); }, []); // initial load

  // Load the full Site/Facilities list from Manage Lists, so the filter shows
  // every site (not just those already in the data). Merges any in-use sites.
  useEffect(() => {
    let active = true;
    api("/meta/sites")
      .then((sites) => {
        if (!active) return;
        const set = new Set(Array.isArray(sites) ? sites : []);
        siteOptions.forEach((s) => set.add(s));
        setSiteList([...set].sort());
      })
      .catch(() => { /* keep whatever we have */ });
    return () => { active = false; };
  }, []);

  const rows = data?.rows || [];

  // Rows filtered per active tab.
  const tabRows = useMemo(() => {
    if (tab === "daily") return rows;
    if (tab === "late") return rows.filter((r) => r.lateMin > 0 || r.undertimeMin > 0);
    if (tab === "overtime") return rows.filter((r) => r.overtimeMin > 0);
    return rows;
  }, [rows, tab]);

  function statusBadge(r) {
    if (r.status === "Absent") return <span className="badge badge-open">Absent</span>;
    if (r.status === "On Leave") {
      return <span className="badge badge-inprogress" title={r.leaveType || "On Leave"}>On Leave{r.leaveType ? ` · ${r.leaveType}` : ""}</span>;
    }
    const flags = r.flags.filter((f) => f !== "Absent" && f !== "On Leave");
    if (flags.length === 0) return <span className="badge badge-resolved">Present</span>;
    return flags.map((f) => {
      const cls = f === "Late" ? "badge-closed" : f === "Overtime" ? "badge-inprogress" : "badge-open";
      return <span key={f} className={`badge ${cls}`} style={{ marginRight: 4 }}>{f}</span>;
    });
  }

  // ---- Export helpers (client-side, like the incidents export) ----
  function exportExcel() {
    import("xlsx").then((XLSX) => {
      const header = ["Date", "Guard", "Site", "Shift", "Scheduled", "Time In", "Time Out", "Late (min)", "Undertime (min)", "Overtime (min)", "Status"];
      const body = tabRows.map((r) => [
        r.dutyDate, r.guardName, r.site, r.shiftName || "",
        r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "",
        r.timeIn ? fmtTime(r.timeIn) : "", r.timeOut ? fmtTime(r.timeOut) : "",
        r.lateMin || 0, r.undertimeMin || 0, r.overtimeMin || 0,
        r.status === "Absent" ? "Absent"
          : r.status === "On Leave" ? `On Leave${r.leaveType ? ` (${r.leaveType})` : ""}`
          : (r.flags.filter((f) => f !== "Absent" && f !== "On Leave").join(", ") || "Present"),
      ]);
      const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
      const wb = XLSX.utils.book_new();
      const tabLabel = TABS.find((t) => t.key === tab).label;
      XLSX.utils.book_append_sheet(wb, ws, tabLabel.slice(0, 31));
      XLSX.writeFile(wb, `attendance-${tab}-${from}_to_${to}.xlsx`);
    });
  }

  function exportPdf() {
    // Server-side PDF endpoint keeps branding (logo/name) consistent with other reports.
    const qs = new URLSearchParams({ from, to, grace: String(grace), otThreshold: String(otThreshold), tab });
    if (site) qs.set("site", site);
    // Opens the branded PDF in a new tab (auth cookie/session not needed—uses same-origin fetch via link).
    window.open(`/api/attendance-reports/pdf?${qs.toString()}`, "_blank");
  }

  const s = data?.summary;

  return (
    <div>
      {/* Controls */}
      <div className="section-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <div className="form-field" style={{ margin: 0 }}>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="form-field" style={{ margin: 0 }}>
            <label>To</label>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="form-field" style={{ margin: 0 }}>
            <label>Site</label>
            <select value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">All sites</option>
              {siteList.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div className="form-field" style={{ margin: 0, width: 120 }}>
            <label>Grace (min)</label>
            <input type="number" min="0" value={grace} onChange={(e) => setGrace(Math.max(0, +e.target.value))} />
          </div>
          <div className="form-field" style={{ margin: 0, width: 140 }}>
            <label>OT threshold (min)</label>
            <input type="number" min="0" value={otThreshold} onChange={(e) => setOtThreshold(Math.max(0, +e.target.value))} />
          </div>
          <button className="btn btn-gold" onClick={runReport} disabled={loading}>{loading ? "Running…" : "Run report"}</button>
        </div>
      </div>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      {/* Summary strip */}
      {s && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(7, 1fr)" }}>
          <div className="kpi-card"><div className="kpi-label">Scheduled</div><div className="kpi-value">{s.total}</div></div>
          <div className="kpi-card good"><div className="kpi-label">Present</div><div className="kpi-value">{s.present}</div></div>
          <div className="kpi-card danger"><div className="kpi-label">Absent</div><div className="kpi-value">{s.absent}</div></div>
          <div className="kpi-card"><div className="kpi-label">On Leave</div><div className="kpi-value">{s.onLeave ?? 0}</div></div>
          <div className="kpi-card"><div className="kpi-label">Late</div><div className="kpi-value">{s.late}</div></div>
          <div className="kpi-card"><div className="kpi-label">Undertime</div><div className="kpi-value">{s.undertime}</div></div>
          <div className="kpi-card"><div className="kpi-label">Overtime</div><div className="kpi-value">{s.overtime}</div></div>
        </div>
      )}

      {/* Tabs + export */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 32px 0", flexWrap: "wrap", gap: 10 }}>
        <div className="tab-row" style={{ display: "flex", gap: 6 }}>
          {TABS.map((t) => (
            <button key={t.key} className={`btn btn-sm ${tab === t.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-outline btn-sm" onClick={exportExcel} disabled={!tabRows.length}>Export Excel</button>
          <button className="btn btn-outline btn-sm" onClick={exportPdf} disabled={!tabRows.length}>Export PDF</button>
        </div>
      </div>

      {/* Table */}
      <div className="section-card">
        <div className="section-head">{TABS.find((t) => t.key === tab).label} — {from} to {to}</div>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Guard</th><th>Site</th><th>Shift</th><th>Scheduled</th>
              <th>Time In</th><th>Time Out</th>
              {tab !== "overtime" && <th>Late</th>}
              {tab !== "overtime" && <th>Undertime</th>}
              {tab !== "late" && <th>Overtime</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={11}>Running report…</td></tr>}
            {!loading && tabRows.length === 0 && <tr className="empty-row"><td colSpan={11}>No records for this view in the selected range.</td></tr>}
            {!loading && tabRows.map((r, i) => (
              <tr key={i}>
                <td data-label="Date">{r.dutyDate}</td>
                <td data-label="Guard"><strong>{r.guardName}</strong></td>
                <td data-label="Site">{r.site || "—"}</td>
                <td data-label="Shift">{r.shiftName || "—"}</td>
                <td data-label="Scheduled">{r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "—"}</td>
                <td data-label="Time In">{fmtTime(r.timeIn)}</td>
                <td data-label="Time Out">{fmtTime(r.timeOut)}</td>
                {tab !== "overtime" && <td data-label="Late">{mins(r.lateMin)}</td>}
                {tab !== "overtime" && <td data-label="Undertime">{mins(r.undertimeMin)}</td>}
                {tab !== "late" && <td data-label="Overtime">{mins(r.overtimeMin)}</td>}
                <td data-label="Status">{statusBadge(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
