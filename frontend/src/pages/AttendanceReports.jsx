import { useEffect, useMemo, useState, useCallback } from "react";
import { brandedSheet } from "../lib/xlsxBranding";
import { useSettings } from "../context/SettingsContext";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ShareFormModal from "./ShareFormModal";
import KpiCard from "../components/KpiCard";

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
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  // Branding for the Excel export, from System Settings.
  const { companyName } = useSettings();
  const isViewer = !perm.edit;
  const canEdit = !isViewer;
  const today = new Date();
  // Default range = the current week, Sunday through Saturday.
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

  const [siteList, setSiteList] = useState(siteOptions); // full list from Manage Lists
  const [employeeList, setEmployeeList] = useState([]);  // active guards (201 File)
  const [from, setFrom] = useState(isoDate(weekStart));
  const [to, setTo] = useState(isoDate(weekEnd));
  const [site, setSite] = useState("");
  const [guard, setGuard] = useState("");                // selected guard name filter
  const [grace, setGrace] = useState(15);
  const [otThreshold, setOtThreshold] = useState(30);
  const [tab, setTab] = useState("daily");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [otRecords, setOtRecords] = useState([]);      // saved OT approvals/requests
  const [showShareOt, setShowShareOt] = useState(false);
  const [showManualOt, setShowManualOt] = useState(false);
  const [otEmployees, setOtEmployees] = useState([]);

  const runReport = useCallback(async () => {
    setLoading(true); setError("");
    try {
      // Fetch the full range across all sites; Site and Guard both filter
      // client-side so changing them updates instantly without re-running.
      const qs = new URLSearchParams({ from, to, grace: String(grace), otThreshold: String(otThreshold) });
      const res = await api(`/attendance-reports?${qs.toString()}`);
      setData(res);
    } catch (e) { setError(e.message); setData(null); }
    finally { setLoading(false); }
  }, [from, to, grace, otThreshold]);

  useEffect(() => { runReport(); }, []); // initial load

  // Load saved overtime approval/request records for the range, and employees
  // for the manual-OT picker. Refetched whenever the range changes.
  const loadOt = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ from, to });
      setOtRecords(await api(`/overtime?${qs.toString()}`));
    } catch (e) { /* non-fatal */ }
  }, [from, to]);
  useEffect(() => { loadOt(); }, [loadOt]);
  useEffect(() => {
    let active = true;
    api("/leave/employees").then((e) => { if (active) setOtEmployees(Array.isArray(e) ? e : []); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Map saved OT records by guard+date (detected) and a list of manual ones.
  const otByKey = useMemo(() => {
    const m = new Map();
    for (const r of otRecords) if (r.source === "detected") m.set(`${(r.guardName || "").trim().toLowerCase()}|${r.dutyDate}`, r);
    return m;
  }, [otRecords]);
  const manualOt = useMemo(() => otRecords.filter((r) => r.source === "manual"), [otRecords]);

  async function reviewDetectedOt(row, decision, approvedMinutes, note) {
    try {
      await api("/overtime/detected", {
        method: "PUT",
        body: JSON.stringify({
          guardName: row.guardName, employeeNo: row.employeeNo || "", site: row.site,
          dutyDate: row.dutyDate, detectedMinutes: row.overtimeMin,
          decision, approvedMinutes, reviewNote: note,
        }),
      });
      await loadOt();
    } catch (e) { setError(e.message); }
  }
  async function reviewManualOt(id, decision, approvedMinutes, note) {
    try {
      await api(`/overtime/${id}/review`, { method: "PATCH", body: JSON.stringify({ decision, approvedMinutes, reviewNote: note }) });
      await loadOt();
    } catch (e) { setError(e.message); }
  }
  async function deleteOt(id) {
    if (!await confirm("Delete this overtime record?")) return;
    try { await api(`/overtime/${id}`, { method: "DELETE" }); await loadOt(); } catch (e) { setError(e.message); }
  }

  // Delete the punch records behind one Daily Attendance line.
  //
  // The line itself is DERIVED — roster entry x date — so it cannot be removed:
  // after this the same day comes back reading "Absent", because the roster
  // still says the guard was due. The confirm says so, since "delete" would
  // otherwise imply the row disappears.
  async function deleteRow(r) {
    const ids = r.punchIds || [];
    if (!ids.length) return;
    const ok = await confirm(
      `Delete the ${ids.length} punch record${ids.length === 1 ? "" : "s"} for ${r.guardName} on ${r.dutyDate}?\n\n` +
      "The day stays on the report and will read Absent, because the roster still shows this guard as scheduled. " +
      "Payroll and billing recompute from attendance, so any figure already drawn from these punches changes."
    );
    if (!ok) return;
    setDeleting(true); setError("");
    try {
      // Sequential, not Promise.all: a partial failure should stop rather than
      // leave a half-deleted day whose cause is hard to read afterwards.
      for (const id of ids) {
        await api(`/attendance/${id}`, { method: "DELETE" });
      }
      await runReport();
    } catch (e) {
      setError(e.message);
      await runReport();          // show whatever did get removed
    } finally {
      setDeleting(false);
    }
  }

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

  // Load the active employees (201 File) for the Guard filter dropdown.
  useEffect(() => {
    let active = true;
    api("/leave/employees")
      .then((emps) => { if (active) setEmployeeList(Array.isArray(emps) ? emps : []); })
      .catch(() => { /* keep empty */ });
    return () => { active = false; };
  }, []);

  const rows = data?.rows || [];

  // The empty/loading rows must span the real column count, which varies by tab
  // and by whether the delete column is shown. Hardcoding 11 left the message
  // short of the table's width.
  const colCount = 8 + (tab !== "overtime" ? 2 : 0) + (tab !== "late" ? 1 : 0) + (perm.delete ? 1 : 0);

  // Rows filtered by the selected Site and Guard (both client-side). Applied
  // before tab filtering and used to recompute the KPI summary so the cards
  // reflect the current Site + Guard selection.
  const guardRows = useMemo(() => {
    let out = rows;
    if (site) out = out.filter((r) => r.site === site);
    if (guard) {
      const g = guard.trim().toLowerCase();
      out = out.filter((r) => (r.guardName || "").trim().toLowerCase() === g);
    }
    return out;
  }, [rows, site, guard]);

  // Summary: server-provided for the whole range, or recomputed from the
  // filtered rows when a Site or Guard filter is active.
  const summary = useMemo(() => {
    if (!site && !guard) return data?.summary || null;
    const sm = { total: 0, present: 0, absent: 0, onLeave: 0, restDay: 0, late: 0, undertime: 0, overtime: 0 };
    for (const r of guardRows) {
      if (r.status === "Rest Day") { sm.restDay++; continue; }
      // "Scheduled" means rostered. A day that was worked with no roster entry
      // is counted as Present below but never as Scheduled — otherwise the KPI
      // would claim someone was rostered when nobody rostered them. The server
      // summary draws the same line, and the two must not disagree.
      if (!r.unrostered) sm.total++;
      if (r.status === "Absent") sm.absent++;
      else if (r.status === "On Leave") sm.onLeave++;
      else {
        sm.present++;
        if (r.lateMin > 0) sm.late++;
        if (r.undertimeMin > 0) sm.undertime++;
        // Match the server: built-in OT counts as an overtime day too.
        if ((r.overtimeMin || 0) + (r.builtinOtMin || 0) > 0) sm.overtime++;
      }
    }
    return sm;
  }, [site, guard, guardRows, data]);

  // Rows filtered per active tab (on top of the guard filter).
  const tabRows = useMemo(() => {
    const base = guardRows;
    if (tab === "daily") return base;
    if (tab === "late") return base.filter((r) => r.lateMin > 0 || r.undertimeMin > 0);
    if (tab === "overtime") return base.filter((r) => r.overtimeMin > 0 || r.builtinOtMin > 0);
    return base;
  }, [guardRows, tab]);

  function statusBadge(r) {
    if (r.status === "Absent") return <span className="badge badge-open">Absent</span>;
    if (r.status === "On Leave") {
      return <span className="badge badge-inprogress" title={r.leaveType || "On Leave"}>On Leave{r.leaveType ? ` · ${r.leaveType}` : ""}</span>;
    }
    if (r.status === "Rest Day") return <span className="badge badge-closed">Rest Day</span>;
    // "Corrected" describes where the time CAME FROM, not what the day was, so
    // it is shown alongside the status rather than replacing it — otherwise a
    // corrected-but-otherwise-normal day rendered no "Present" badge at all.
    const corrected = r.flags.includes("Corrected");
    // The status says what the DAY was; it always reads "Present" for a worked
    // day. Overtime is deliberately not shown here — it has its own column, and
    // a 12h shift earning built-in OT is normal, not an exception, so surfacing
    // it as the status made ordinary night shifts look irregular.
    const exceptions = r.flags.filter((f) => ["Late", "Undertime", "No time-out"].includes(f));
    return (
      <>
        {corrected && (
          <span className="badge badge-info" style={{ marginRight: 4 }}
            title="Time supplied by an approved Missing Time Log correction, not a punch">Corrected</span>
        )}
        <span className="badge badge-present" style={{ marginRight: 4 }}>Present</span>
        {exceptions.map((f) => (
          <span key={f} className={`badge ${f === "Late" ? "badge-closed" : "badge-open"}`} style={{ marginRight: 4 }}>{f}</span>
        ))}
      </>
    );
  }

  // ---- Export helpers (client-side, like the incidents export) ----
  function exportExcel() {
    import("xlsx").then((XLSX) => {
      const header = ["Date", "Guard", "Site", "Shift", "Scheduled", "Time In", "Time Out", "Late (min)", "Undertime (min)", "Built-in OT (min)", "Excess OT (min)", "Total OT (min)", "Status"];
      const body = tabRows.map((r) => [
        r.dutyDate, r.guardName, r.site, r.shiftName || "",
        r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "",
        r.timeIn ? fmtTime(r.timeIn) : "", r.timeOut ? fmtTime(r.timeOut) : "",
        r.lateMin || 0, r.undertimeMin || 0,
        r.builtinOtMin || 0, r.overtimeMin || 0, (r.builtinOtMin || 0) + (r.overtimeMin || 0),
        r.status === "Absent" ? "Absent"
          : r.status === "On Leave" ? `On Leave${r.leaveType ? ` (${r.leaveType})` : ""}`
          : r.status === "Rest Day" ? "Rest Day"
          : (r.flags.filter((f) => f !== "Absent" && f !== "On Leave" && f !== "Rest Day").join(", ") || "Present"),
      ]);
      const tabLabel = TABS.find((t) => t.key === tab).label;
      // The agency letterhead, then the data beneath it.
      const ws = brandedSheet(XLSX, { companyName, title: tabLabel, subtitle: `${from} to ${to}` });
      XLSX.utils.sheet_add_aoa(ws, [header, ...body], { origin: -1 });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, tabLabel.slice(0, 31));
      XLSX.writeFile(wb, `attendance-${tab}-${from}_to_${to}.xlsx`);
    });
  }

  async function exportPdf() {
    // Server-side PDF endpoint keeps branding (logo/name) consistent with other reports.
    const qs = new URLSearchParams({ from, to, grace: String(grace), otThreshold: String(otThreshold), tab });
    if (site) qs.set("site", site);
    if (guard) qs.set("guard", guard);
    // The route is behind requireAuth and this app authenticates with a bearer
    // token in sessionStorage — not a cookie — so a plain window.open navigates
    // without the header and comes back 401. Fetch it as a blob instead.
    try {
      const url = await apiBlobUrl(`/attendance-reports/pdf?${qs.toString()}`);
      downloadBlobUrl(url, `attendance-${tab}-${from}_${to}.pdf`);
    } catch (e) { setError(e.message); }
  }

  const s = summary;

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
          <div className="form-field" style={{ margin: 0 }}>
            <label>Guard</label>
            <select value={guard} onChange={(e) => setGuard(e.target.value)}>
              <option value="">All guards</option>
              {employeeList.map((emp) => <option key={emp.id} value={emp.fullName}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
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
        <div className="kpi-grid" data-cols="8">
          <KpiCard label={<>Scheduled</>} value={s.total} tone="neutral" icon="bi-calendar-check" />
          <KpiCard label={<>Present</>} value={s.present} tone="good" icon="bi-person-check" />
          <KpiCard label={<>Absent</>} value={s.absent} tone="danger" icon="bi-person-x" />
          <KpiCard label={<>On Leave</>} value={s.onLeave ?? 0} tone="neutral" icon="bi-airplane" />
          <KpiCard label={<>Rest Day</>} value={s.restDay ?? 0} tone="neutral" icon="bi-moon" />
          <KpiCard label={<>Late</>} value={s.late} tone="neutral" icon="bi-clock" />
          <KpiCard label={<>Undertime</>} value={s.undertime} tone="neutral" icon="bi-hourglass-bottom" />
          <KpiCard label={<>Overtime</>} value={s.overtime} tone="neutral" icon="bi-clock-history" />
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
          {tab === "overtime" && canEdit && <button onClick={() => setShowManualOt(true)} style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>+ Manual OT</button>}
          {tab === "overtime" && perm.add && <button onClick={() => setShowShareOt(true)} style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>🔗 Share OT form link</button>}
          <button className="btn btn-outline btn-sm" onClick={exportExcel} disabled={!tabRows.length}>Export Excel</button>
          <button className="btn btn-outline btn-sm" onClick={exportPdf} disabled={!tabRows.length}>Export PDF</button>
        </div>
      </div>

      {/* Table */}
      {/* Table (or Overtime approval panel) */}
      {tab === "overtime" ? (
        <OvertimePanel
          detectedRows={tabRows} otByKey={otByKey} manualOt={manualOt}
          from={from} to={to} canEdit={canEdit} isAdmin={isAdmin}
          onReviewDetected={reviewDetectedOt} onReviewManual={reviewManualOt} onDelete={deleteOt}
          onManualFile={() => setShowManualOt(true)}
        />
      ) : (
      /* Inner scrollport, NOT the app-wide .sticky-card pattern — deliberate,
          and reverting it reintroduces a real bug. .sticky-card sets
          overflow:visible so the card cannot capture the sticky header, but
          .app-main is a flex item with min-width:0, so a table wider than its
          card paints outside the viewport and NOTHING scrolls to it — the
          right-hand columns become unreachable, silently. This table's own
          header labels alone already exceed the card below 900px. See the
          .wide-card rule in index.css. */
      <div className="section-card wide-card">
        <div className="section-head">{TABS.find((t) => t.key === tab).label} — {from} to {to}</div>
        <div className="wide-scroll">
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Date</th><th>Guard</th><th>Site</th><th>Shift</th><th>Scheduled</th>
              <th>Time In</th><th>Time Out</th>
              {tab !== "overtime" && <th>Late</th>}
              {tab !== "overtime" && <th>Undertime</th>}
              {tab !== "late" && <th>Overtime</th>}
              <th>Status</th>
              {perm.delete && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={colCount}>Running report…</td></tr>}
            {!loading && tabRows.length === 0 && <tr className="empty-row"><td colSpan={colCount}>No records for this view in the selected range.</td></tr>}
            {!loading && tabRows.map((r, i) => (
              <tr key={i}>
                <td data-label="Date">{r.dutyDate}</td>
                <td data-label="Guard"><strong>{r.guardName}</strong></td>
                <td data-label="Site">{r.site || "—"}</td>
                <td data-label="Shift">
                  {r.shiftName || "—"}
                  {/* Says WHY the row has no shift or scheduled time: the guard
                      punched on a day nobody rostered them for. Without this it
                      reads as a data gap rather than the fact it is. */}
                  {r.unrostered && (
                    <div style={{ fontSize: 11, color: "var(--text-mute)" }}>Unrostered — no roster entry</div>
                  )}
                </td>
                <td data-label="Scheduled">{r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "—"}</td>
                <td data-label="Time In">{fmtTime(r.timeIn)}</td>
                <td data-label="Time Out">{fmtTime(r.timeOut)}</td>
                {tab !== "overtime" && <td data-label="Late">{mins(r.lateMin)}</td>}
                {tab !== "overtime" && <td data-label="Undertime">{mins(r.undertimeMin)}</td>}
                {tab !== "late" && (
                  <td data-label="Overtime">
                    {/* Total OT = built-in (auto-recognised shift length beyond
                        8h) + excess (worked past shift end, needs approval).
                        Showing only excess made a full 12h night shift read as
                        no overtime at all. */}
                    {mins((r.builtinOtMin || 0) + (r.overtimeMin || 0))}
                    {r.builtinOtMin > 0 && r.overtimeMin > 0 && (
                      <div style={{ fontSize: 11, color: "var(--text-mute)" }}>
                        {r.builtinOtMin} built-in + {r.overtimeMin} excess
                      </div>
                    )}
                    {r.builtinOtMin > 0 && !r.overtimeMin && (
                      <div style={{ fontSize: 11, color: "var(--text-mute)" }}>
                        {/* A straight duty says WHY there is no excess: the 24
                            hours are counted as two consecutive regular shifts,
                            so the overtime inside them is all built-in. */}
                        {r.shiftUnits === 2 ? "built-in — straight duty, 2 shifts" : "built-in"}
                      </div>
                    )}
                  </td>
                )}
                <td data-label="Status">{statusBadge(r)}</td>
                {perm.delete && (
                  <td data-label="">
                    {/* Only offered where there is something to delete. An
                        Absent day has no record behind it — the row exists
                        because the roster says a guard was due, so there is
                        nothing a delete could remove. */}
                    {r.punchIds && r.punchIds.length > 0 ? (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deleting}
                        onClick={() => deleteRow(r)}
                        title={`Delete the ${r.punchIds.length} punch record${r.punchIds.length === 1 ? "" : "s"} behind this row`}
                      >
                        Delete
                      </button>
                    ) : (
                      <span style={{ color: "var(--text-mute)", fontSize: 11 }}>—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      )}

      {showShareOt && <ShareFormModal kind="overtime" onClose={() => setShowShareOt(false)} />}
      {showManualOt && (
        <ManualOtModal employees={otEmployees} onClose={() => setShowManualOt(false)} onSaved={async () => { setShowManualOt(false); await loadOt(); }} />
      )}
    </div>
  );
}

// --- Overtime approval panel -------------------------------------------------
function otBadge(status) {
  const cls = status === "Approved" ? "badge-resolved" : status === "Rejected" ? "badge-open" : "badge-inprogress";
  return <span className={`badge ${cls}`}>{status || "Pending"}</span>;
}
function fmtMins(n) {
  if (n == null || n === "") return "—";
  const m = Number(n); if (!m) return "0 min";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}h ${r}m` : `${r}m`;
}

function OvertimePanel({ detectedRows, otByKey, manualOt, from, to, canEdit, isAdmin, onReviewDetected, onReviewManual, onDelete, onManualFile }) {
  return (
    <>
      {/* Inner scrollport, NOT the app-wide .sticky-card pattern — deliberate,
          and reverting it reintroduces a real bug. .sticky-card sets
          overflow:visible so the card cannot capture the sticky header, but
          .app-main is a flex item with min-width:0, so a table wider than its
          card paints outside the viewport and NOTHING scrolls to it — the
          right-hand columns become unreachable, silently. This table's own
          header labels alone already exceed the card below 900px. See the
          .wide-card rule in index.css. */}
      <div className="section-card wide-card" style={{ marginBottom: 16 }}>
        <div className="section-head">Detected overtime — {from} to {to}</div>
        <div style={{ fontSize: 12, color: "var(--text-mute)", padding: "0 0 8px" }}>
          Built-in OT (shift length beyond 8h) is auto-recognized and needs no approval. Excess OT (worked past shift end) is the approvable item.
        </div>
        <div className="wide-scroll">
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Date</th><th>Guard</th><th>Site</th><th>Shift</th><th>Time Out</th>
              <th>Built-in OT</th><th>Excess OT</th><th>Approved</th><th>Status</th>
              {canEdit && <th>Review</th>}
            </tr>
          </thead>
          <tbody>
            {detectedRows.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 10 : 9}>No detected overtime in this range.</td></tr>}
            {detectedRows.map((r, i) => {
              const saved = otByKey.get(`${(r.guardName || "").trim().toLowerCase()}|${r.dutyDate}`);
              return <DetectedOtRow key={i} r={r} saved={saved} canEdit={canEdit} onReview={onReviewDetected} />;
            })}
          </tbody>
        </table>
        </div>
      </div>

      <div className="section-card sticky-card">
        <div className="section-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Manual & guard-filed overtime requests</span>
        </div>
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Date</th><th>Guard</th><th>Site</th><th>Requested</th><th>Reason</th><th>Approved</th><th>Status</th>
              {canEdit && <th>Review</th>}
            </tr>
          </thead>
          <tbody>
            {manualOt.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 8 : 7}>No manual or guard-filed OT requests in this range.</td></tr>}
            {manualOt.map((r) => <ManualOtRow key={r.id} r={r} canEdit={canEdit} isAdmin={isAdmin} onReview={onReviewManual} onDelete={onDelete} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DetectedOtRow({ r, saved, canEdit, onReview }) {
  const [editing, setEditing] = useState(false);
  const [approved, setApproved] = useState(saved?.approvedMinutes ?? r.overtimeMin);
  const [note, setNote] = useState(saved?.reviewNote || "");
  const [busy, setBusy] = useState(false);
  const status = saved?.status || "Pending";
  const hasExcess = (r.overtimeMin || 0) > 0;

  async function decide(decision) {
    setBusy(true);
    await onReview(r, decision, decision === "Approved" ? Number(approved) : null, note);
    setBusy(false); setEditing(false);
  }

  return (
    <tr>
      <td data-label="Date">{r.dutyDate}</td>
      <td data-label="Guard"><strong>{r.guardName}</strong></td>
      <td data-label="Site">{r.site || "—"}</td>
      <td data-label="Shift">{r.shiftName || "—"}</td>
      <td data-label="Time Out">{r.timeOut ? new Date(r.timeOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
      <td data-label="Built-in OT" style={{ color: "var(--text-mute)" }}>{r.builtinOtMin > 0 ? fmtMins(r.builtinOtMin) : "—"}</td>
      <td data-label="Excess OT" style={{ fontWeight: hasExcess ? 700 : 400 }}>{hasExcess ? fmtMins(r.overtimeMin) : "—"}</td>
      <td data-label="Approved">{hasExcess && status === "Approved" ? fmtMins(saved?.approvedMinutes) : "—"}</td>
      <td data-label="Status">{hasExcess ? <>{otBadge(status)}{saved?.reviewedBy ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>by {saved.reviewedBy}</div> : null}</> : <span className="badge badge-resolved">Auto</span>}</td>
      {canEdit && (
        <td data-label="Review" style={{ minWidth: 220 }}>
          {!hasExcess ? (
            <span style={{ fontSize: 11.5, color: "var(--text-mute)" }}>No approval needed</span>
          ) : !editing ? (
            <button className="btn btn-sm btn-primary" onClick={() => { setApproved(saved?.approvedMinutes ?? r.overtimeMin); setNote(saved?.reviewNote || ""); setEditing(true); }}>
              {status === "Pending" ? "Review" : "Edit"}
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, margin: 0 }}>Approved minutes (excess)
                <input type="number" min="0" value={approved} onChange={(e) => setApproved(e.target.value)} style={{ fontSize: 12 }} />
              </label>
              <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ fontSize: 12 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm btn-primary" onClick={() => decide("Approved")} disabled={busy}>Approve</button>
                <button className="btn btn-sm btn-danger" onClick={() => decide("Rejected")} disabled={busy}>Reject</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

function ManualOtRow({ r, canEdit, isAdmin, onReview, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [approved, setApproved] = useState(r.approvedMinutes ?? r.requestedMinutes);
  const [note, setNote] = useState(r.reviewNote || "");
  const [busy, setBusy] = useState(false);

  async function decide(decision) {
    setBusy(true);
    await onReview(r.id, decision, decision === "Approved" ? Number(approved) : null, note);
    setBusy(false); setEditing(false);
  }

  return (
    <tr>
      <td data-label="Date">{r.dutyDate}</td>
      <td data-label="Guard"><strong>{r.guardName}</strong>{r.createdBy && r.createdBy.startsWith("public-form") ? <div style={{ fontSize: 10.5, color: "var(--text-mute)" }}>guard-filed</div> : null}</td>
      <td data-label="Site">{r.site || "—"}</td>
      <td data-label="Requested">{fmtMins(r.requestedMinutes)}</td>
      <td data-label="Reason" style={{ maxWidth: 200, fontSize: 12.5, color: "var(--text-mute)" }}>{r.reason || "—"}</td>
      <td data-label="Approved">{r.status === "Approved" ? fmtMins(r.approvedMinutes) : "—"}</td>
      <td data-label="Status">{otBadge(r.status)}{r.reviewedBy ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>by {r.reviewedBy}</div> : null}</td>
      {canEdit && (
        <td data-label="Review" style={{ minWidth: 220 }}>
          {r.status === "Pending" ? (
            !editing ? (
              <button className="btn btn-sm btn-primary" onClick={() => { setApproved(r.approvedMinutes ?? r.requestedMinutes); setNote(r.reviewNote || ""); setEditing(true); }}>Review</button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, margin: 0 }}>Approved minutes
                  <input type="number" min="0" value={approved} onChange={(e) => setApproved(e.target.value)} style={{ fontSize: 12 }} />
                </label>
                <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ fontSize: 12 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => decide("Approved")} disabled={busy}>Approve</button>
                  <button className="btn btn-sm btn-danger" onClick={() => decide("Rejected")} disabled={busy}>Reject</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            )
          ) : (
            isAdmin && <button className="btn btn-sm btn-secondary" onClick={() => onDelete(r.id)}>Delete</button>
          )}
        </td>
      )}
    </tr>
  );
}

function ManualOtModal({ employees, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState("");
  const [dutyDate, setDutyDate] = useState(new Date().toISOString().slice(0, 10));
  const [minutes, setMinutes] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!dutyDate) { setError("Please choose a date."); return; }
    const m = parseInt(minutes, 10);
    if (!Number.isFinite(m) || m <= 0) { setError("Please enter the overtime minutes."); return; }
    setSaving(true); setError("");
    try {
      await api("/overtime/manual", { method: "POST", body: JSON.stringify({ employeeId: Number(employeeId), dutyDate, requestedMinutes: m, reason }) });
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>File manual overtime</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Guard (from 201 File)</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">— Select guard —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-field"><label>Date</label><input type="date" value={dutyDate} onChange={(e) => setDutyDate(e.target.value)} /></div>
            <div className="form-field"><label>Overtime (minutes)</label><input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="e.g. 90" /></div>
          </div>
          <div className="form-field"><label>Reason (optional)</label><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the overtime" /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "File overtime"}</button>
        </div>
      </div>
    </div>
  );
}
