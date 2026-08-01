import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Plan guard shift rotations across all sites";
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- date helpers (local, no external lib) ---
// Local YYYY-MM-DD (NOT toISOString, which converts to UTC and can shift the
// day for +8 timezones — that was making roster cells miss their date).
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Normalize a dutyDate coming from the API (may be "2026-07-28" or a full ISO
// timestamp like "2026-07-28T00:00:00.000Z") to a plain YYYY-MM-DD for matching.
function normalizeDate(v) {
  if (!v) return "";
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // back to Sunday
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

export default function SchedulingPage() {
  const { isViewer } = useAuth();
  const canEdit = !isViewer;

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [assignments, setAssignments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [shiftNameList, setShiftNameList] = useState([]); // from Manage Lists (shift_assignments_shift)
  const [siteList, setSiteList] = useState([]);           // from Manage Lists (sites)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterSite, setFilterSite] = useState("");

  const [showAssign, setShowAssign] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showRemove, setShowRemove] = useState(false);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const loadWeek = useCallback(async () => {
    setLoading(true);
    try {
      const from = toISO(weekStart);
      const to = toISO(addDays(weekStart, 6));
      const [asn, tmpls, emps] = await Promise.all([
        api(`/scheduling/assignments?from=${from}&to=${to}`),
        api("/scheduling/templates"),
        api("/scheduling/employees"),
      ]);
      setAssignments(asn);
      setTemplates(tmpls);
      setEmployees(emps);
      setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [weekStart]);

  useEffect(() => { loadWeek(); }, [loadWeek]);

  // Load the configurable dropdowns from Manage Lists once: shift names
  // (shift_assignments_shift) and sites. Both fall back to empty on error.
  useEffect(() => {
    let active = true;
    Promise.all([
      api("/meta/dropdown/shift_assignments_shift").catch(() => []),
      api("/meta/sites").catch(() => []),
    ]).then(([shifts, sites]) => {
      if (!active) return;
      setShiftNameList(Array.isArray(shifts) ? shifts : []);
      setSiteList(Array.isArray(sites) ? sites : []);
    });
    return () => { active = false; };
  }, []);

  const siteOptions = useMemo(() => {
    const set = new Set(siteList);
    assignments.forEach((a) => { if (a.site) set.add(a.site); });
    return [...set].sort();
  }, [siteList, assignments]);

  // Build guard rows: unique guards in this week's assignments, filtered by site.
  const grid = useMemo(() => {
    const filtered = filterSite ? assignments.filter((a) => a.site === filterSite) : assignments;
    const byGuard = new Map();
    for (const a of filtered) {
      const key = a.employeeId != null ? `e${a.employeeId}` : `n:${a.guardName}`;
      if (!byGuard.has(key)) byGuard.set(key, { guardName: a.guardName, site: a.site, cells: {} });
      byGuard.get(key).cells[normalizeDate(a.dutyDate)] = a;
    }
    return [...byGuard.values()].sort((a, b) => a.guardName.localeCompare(b.guardName));
  }, [assignments, filterSite]);

  async function removeAssignment(id) {
    if (!window.confirm("Remove this shift assignment?")) return;
    try { await api(`/scheduling/assignments/${id}`, { method: "DELETE" }); await loadWeek(); }
    catch (e) { setError(e.message); }
  }

  async function copyPrevWeek() {
    const prev = toISO(addDays(weekStart, -7));
    if (!window.confirm("Copy last week's roster into this week? Existing entries won't be duplicated.")) return;
    try {
      const res = await api("/scheduling/assignments/copy-week", { method: "POST", body: JSON.stringify({ fromStart: prev }) });
      await loadWeek();
      setError("");
      window.alert(`Copied ${res.copied} assignment(s)${res.skipped ? `, skipped ${res.skipped} already present` : ""}.`);
    } catch (e) { setError(e.message); }
  }

  const actions = canEdit ? (
    <>
      <button className="btn btn-outline" onClick={() => setShowTemplates(true)}>Manage shifts</button>
      <button className="btn btn-outline" onClick={copyPrevWeek}>Copy last week</button>
      <button className="btn btn-outline" onClick={() => setShowRemove(true)}>Remove shifts</button>
      <button className="btn btn-gold" onClick={() => setShowAssign(true)}>+ Assign shift</button>
    </>
  ) : null;

  return (
    <div className="module-view">
      <ModuleHeader title="Shift Scheduling" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Plan guard rotations week by week. Assign guards from the 201 File to shift templates per day; use "Copy last week" to roll a rotating roster forward.</PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div className="toolbar">
        <div className="toolbar-left" style={{ alignItems: "center", gap: 10 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>&larr; Prev</button>
          <strong style={{ fontSize: 13.5 }}>
            {weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} &ndash;{" "}
            {addDays(weekStart, 6).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </strong>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next &rarr;</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</button>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="section-card" style={{ overflowX: "auto" }}>
        <div className="section-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Weekly roster</span>
          <span style={{ display: "flex", gap: 14, fontSize: 11, fontWeight: 400 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: "#DCEAF7", border: "1px solid #B9D4EC", display: "inline-block" }}></span>Day shift
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: "var(--navy)", display: "inline-block" }}></span>Night shift
            </span>
          </span>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-mute)" }}>Loading roster…</div>
        ) : grid.length === 0 ? (
          <div style={{ padding: 24, color: "var(--text-mute)" }}>
            No shifts assigned for this week{filterSite ? ` at ${filterSite}` : ""}. Use "+ Assign shift" to add one.
          </div>
        ) : (
          <table style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>Guard</th>
                {weekDays.map((d, i) => (
                  <th key={i} style={{ textAlign: "center", minWidth: 96 }}>
                    {DAY_LABELS[i]}<br /><span style={{ fontWeight: 400, color: "var(--text-mute)" }}>{d.getDate()}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, ri) => (
                <tr key={ri}>
                  <td>
                    <strong>{row.guardName}</strong>
                    {row.site && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{row.site}</div>}
                  </td>
                  {weekDays.map((d, ci) => {
                    const iso = toISO(d);
                    const a = row.cells[iso];
                    // Treat a cell as a "night" shift if it crosses midnight OR
                    // its name mentions night — so it's visually distinct even if
                    // the overnight flag wasn't set when the template was made.
                    const isNight = a && (a.crossesMidnight || /night/i.test(a.shiftName || ""));
                    return (
                      <td key={ci} style={{ textAlign: "center", verticalAlign: "middle" }}>
                        {a ? (
                          <div
                            title={canEdit ? "Click to remove" : ""}
                            onClick={canEdit ? () => removeAssignment(a.id) : undefined}
                            style={{
                              cursor: canEdit ? "pointer" : "default",
                              background: isNight ? "var(--navy)" : "#DCEAF7",
                              color: isNight ? "#fff" : "var(--navy)",
                              border: isNight ? "1px solid var(--navy-dark)" : "1px solid #B9D4EC",
                              borderRadius: 6, padding: "5px 6px", fontSize: 11, lineHeight: 1.3,
                            }}
                          >
                            <div style={{ fontWeight: 700 }}>{a.shiftName || "Shift"}</div>
                            {a.startTime && <div style={{ opacity: isNight ? 0.85 : 0.75 }}>{a.startTime}–{a.endTime}</div>}
                          </div>
                        ) : (
                          <span style={{ color: "#CBD2DC" }}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfidentialFooter />

      {showAssign && (
        <AssignShiftModal
          employees={employees} templates={templates} weekDays={weekDays}
          onClose={() => setShowAssign(false)}
          onSaved={async () => { setShowAssign(false); await loadWeek(); }}
        />
      )}
      {showRemove && (
        <RemoveShiftsModal
          employees={employees}
          onClose={() => setShowRemove(false)}
          onDone={async () => { setShowRemove(false); await loadWeek(); }}
        />
      )}
      {showTemplates && (
        <ShiftTemplatesModal
          templates={templates}
          shiftNameList={shiftNameList}
          siteList={siteList}
          onClose={() => setShowTemplates(false)}
          onChanged={loadWeek}
        />
      )}
    </div>
  );
}

// --- Assign a guard to a shift on a date -----------------------------------
function AssignShiftModal({ employees, templates, weekDays, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState("");
  const [shiftTemplateId, setShiftTemplateId] = useState("");
  const firstDay = weekDays[0] ? toISO(weekDays[0]) : "";
  const lastDay = weekDays[6] ? toISO(weekDays[6]) : "";
  const [fromDate, setFromDate] = useState(firstDay);
  const [toDate, setToDate] = useState(firstDay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function save() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!fromDate) { setError("Please choose a start date."); return; }
    const end = toDate || fromDate;
    if (end < fromDate) { setError("The 'To' date can't be before the 'From' date."); return; }
    setSaving(true); setError(""); setResult("");
    try {
      const res = await api("/scheduling/assignments/range", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(employeeId),
          shiftTemplateId: shiftTemplateId ? Number(shiftTemplateId) : null,
          fromDate, toDate: end,
        }),
      });
      // If some days were skipped as duplicates, tell the user rather than fail.
      if (res.skipped > 0 && res.created === 0) {
        setError(`All ${res.skipped} day(s) in that range were already assigned.`);
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Assign shift</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Guard (from 201 File)</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">— Select guard —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Shift</label>
            <select value={shiftTemplateId} onChange={(e) => setShiftTemplateId(e.target.value)}>
              <option value="">— Select shift —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.site ? ` · ${t.site}` : ""} ({t.startTime}–{t.endTime})</option>)}
            </select>
            {templates.length === 0 && <div className="hint" style={{ marginTop: 6, color: "var(--text-mute)", fontSize: 12 }}>No shift templates yet — add one via "Manage shifts" first.</div>}
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="hint" style={{ color: "var(--text-mute)", fontSize: 12, marginTop: -6 }}>
            The shift will be assigned to the guard on every day from the start to the end date (inclusive). Leave "To" the same as "From" for a single day.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Assigning…" : "Assign"}</button>
        </div>
      </div>
    </div>
  );
}

// --- Remove shifts by guard + date range ------------------------------------
function RemoveShiftsModal({ employees, onClose, onDone }) {
  const [employeeId, setEmployeeId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!fromDate) { setError("Please choose a start date."); return; }
    const end = toDate || fromDate;
    if (end < fromDate) { setError("The 'To' date can't be before the 'From' date."); return; }
    if (!window.confirm("Remove all shift assignments for this guard within the selected date range? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      const res = await api("/scheduling/assignments/remove-range", {
        method: "POST",
        body: JSON.stringify({ employeeId: Number(employeeId), fromDate, toDate: end }),
      });
      window.alert(`Removed ${res.removed} shift assignment(s).`);
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Remove shifts</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
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
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="hint" style={{ color: "var(--text-mute)", fontSize: 12, marginTop: -6 }}>
            All of this guard's shifts from the start to the end date (inclusive) will be removed.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? "Removing…" : "Remove shifts"}</button>
        </div>
      </div>
    </div>
  );
}

// --- Manage shift templates -------------------------------------------------
function ShiftTemplatesModal({ templates, shiftNameList, siteList, onClose, onChanged }) {
  const [add, setAdd] = useState({ name: "", site: "", startTime: "", endTime: "", crossesMidnight: false });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addTemplate() {
    if (!add.name.trim()) { setError("Please select a shift name."); return; }
    if (!add.startTime || !add.endTime) { setError("Start and end times are required."); return; }
    setSaving(true); setError("");
    try {
      await api("/scheduling/templates", { method: "POST", body: JSON.stringify(add) });
      setAdd({ name: "", site: "", startTime: "", endTime: "", crossesMidnight: false });
      await onChanged();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function removeTemplate(id) {
    if (!window.confirm("Deactivate this shift template? Existing roster entries keep their times.")) return;
    try { await api(`/scheduling/templates/${id}`, { method: "DELETE" }); await onChanged(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Shift templates</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="entry-list" style={{ marginBottom: 16 }}>
            {templates.length === 0 && <div className="empty-hint">No shift templates yet.</div>}
            {templates.map((t) => (
              <div className="entry-card" key={t.id}>
                <div className="entry-top">
                  <div>
                    <div className="entry-title">{t.name} {t.crossesMidnight && <span className="badge badge-closed" style={{ marginLeft: 6 }}>overnight</span>}</div>
                    <div className="entry-meta">{[t.site, `${t.startTime}–${t.endTime}`].filter(Boolean).join("  ·  ")}</div>
                  </div>
                  <button className="entry-remove" onClick={() => removeTemplate(t.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="add-row">
            <div className="form-field"><label>Shift name</label>
              <select value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })}>
                <option value="">— Select shift —</option>
                {/* keep an existing custom value visible if not in the list */}
                {add.name && !shiftNameList.includes(add.name) && <option value={add.name}>{add.name}</option>}
                {shiftNameList.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Site</label>
              <select value={add.site} onChange={(e) => setAdd({ ...add, site: e.target.value })}>
                <option value="">— Select site —</option>
                {add.site && !siteList.includes(add.site) && <option value={add.site}>{add.site}</option>}
                {siteList.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Start</label><input type="time" value={add.startTime} onChange={(e) => setAdd({ ...add, startTime: e.target.value })} /></div>
            <div className="form-field"><label>End</label><input type="time" value={add.endTime} onChange={(e) => setAdd({ ...add, endTime: e.target.value })} /></div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={add.crossesMidnight} onChange={(e) => setAdd({ ...add, crossesMidnight: e.target.checked })} /> Overnight
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-gold" onClick={addTemplate} disabled={saving}>{saving ? "Adding…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
