import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ShareFormModal from "./ShareFormModal";

function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status) {
  const cls = status === "Actioned" ? "badge-resolved" : status === "Excused" ? "badge-closed" : "badge-open";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export default function AbsenceMonitoring({ siteOptions = [] }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;

  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

  const [from, setFrom] = useState(isoDate(weekStart));
  const [to, setTo] = useState(isoDate(weekEnd));
  const [site, setSite] = useState("");
  const [guard, setGuard] = useState("");
  const [siteList, setSiteList] = useState(siteOptions);
  const [employeeList, setEmployeeList] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState("absences"); // absences | notimeout | patterns | missing
  const [missingReqs, setMissingReqs] = useState([]);
  const [showShare, setShowShare] = useState(false);
  const [showShareMy, setShowShareMy] = useState(false);

  const run = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams({ from, to });
      const res = await api(`/absence-monitoring?${qs.toString()}`);
      setData(res);
    } catch (e) { setError(e.message); setData(null); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { run(); }, []); // initial

  useEffect(() => {
    let active = true;
    api("/meta/sites").then((s) => { if (active) setSiteList([...new Set([...(Array.isArray(s) ? s : []), ...siteOptions])].sort()); }).catch(() => {});
    api("/leave/employees").then((e) => { if (active) setEmployeeList(Array.isArray(e) ? e : []); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Client-side Site + Guard filtering (instant, like the reports tab).
  const filterItem = useCallback((r) => {
    if (site && r.site !== site) return false;
    if (guard && (r.guardName || "").trim().toLowerCase() !== guard.trim().toLowerCase()) return false;
    return true;
  }, [site, guard]);

  const absences = useMemo(() => (data?.absences || []).filter(filterItem), [data, filterItem]);
  const noTimeouts = useMemo(() => (data?.noTimeouts || []).filter(filterItem), [data, filterItem]);

  const patterns = useMemo(() => {
    // Recompute patterns from the filtered absences so they respect Site/Guard.
    const byGuard = new Map(), bySite = new Map();
    for (const a of absences) {
      byGuard.set(a.guardName, (byGuard.get(a.guardName) || 0) + 1);
      const s = a.site || "(no site)";
      bySite.set(s, (bySite.get(s) || 0) + 1);
    }
    return {
      repeatAbsentees: [...byGuard.entries()].map(([guardName, count]) => ({ guardName, count })).sort((a, b) => b.count - a.count),
      siteConcentration: [...bySite.entries()].map(([s, count]) => ({ site: s, count })).sort((a, b) => b.count - a.count),
    };
  }, [absences]);

  const kpi = useMemo(() => ({
    absences: absences.length,
    noTimeouts: noTimeouts.length,
    pending: absences.filter((a) => a.status === "Pending").length,
    repeatAbsentees: patterns.repeatAbsentees.filter((r) => r.count > 1).length,
  }), [absences, noTimeouts, patterns]);

  async function saveFollowup(item, status, remark) {
    try {
      await api("/absence-monitoring/followup", {
        method: "PUT",
        body: JSON.stringify({ guardName: item.guardName, dutyDate: item.dutyDate, kind: item.kind, site: item.site, status, remark }),
      });
      await run();
    } catch (e) { setError(e.message); }
  }

  const loadMissing = useCallback(async () => {
    try { setMissingReqs(await api("/absence-monitoring/missing-timelog")); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadMissing(); }, [loadMissing]);

  async function reviewMissing(id, decision, inAt, outAt, note) {
    try {
      await api(`/absence-monitoring/missing-timelog/${id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ decision, inAt, outAt, reviewNote: note }),
      });
      await loadMissing();
    } catch (e) { setError(e.message); }
  }

  async function deleteMissing(id) {
    if (!window.confirm("Delete this request?")) return;
    try { await api(`/absence-monitoring/missing-timelog/${id}`, { method: "DELETE" }); await loadMissing(); }
    catch (e) { setError(e.message); }
  }

  const pendingMissing = missingReqs.filter((r) => r.status === "Pending").length;

  return (
    <div style={{ padding: "16px 32px 0" }}>
      {/* Admin action bar — always-visible share links */}
      {isAdmin && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          <button
            onClick={() => setShowShareMy(true)}
            style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            🔗 Share "My Attendance" link
          </button>
          <button
            onClick={() => setShowShare(true)}
            style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            🔗 Share Missing Time Log form link
          </button>
        </div>
      )}

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
          <button className="btn btn-gold" onClick={run} disabled={loading}>{loading ? "Loading…" : "Run"}</button>
        </div>
      </div>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="kpi-card danger"><div className="kpi-label">Unexplained absences</div><div className="kpi-value">{kpi.absences}</div></div>
        <div className="kpi-card"><div className="kpi-label">Pending follow-up</div><div className="kpi-value">{kpi.pending}</div></div>
        <div className="kpi-card"><div className="kpi-label">No time-out</div><div className="kpi-value">{kpi.noTimeouts}</div></div>
        <div className="kpi-card"><div className="kpi-label">Repeat absentees</div><div className="kpi-value">{kpi.repeatAbsentees}</div></div>
      </div>

      {/* Section switch */}
      <div style={{ display: "flex", gap: 6, margin: "4px 0 12px", alignItems: "center", flexWrap: "wrap" }}>
        <button className={`btn btn-sm ${section === "absences" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("absences")}>Unexplained absences</button>
        <button className={`btn btn-sm ${section === "notimeout" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("notimeout")}>No time-out</button>
        <button className={`btn btn-sm ${section === "patterns" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("patterns")}>Patterns</button>
        <button className={`btn btn-sm ${section === "missing" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("missing")}>
          Missing Time Log Requests{pendingMissing > 0 ? ` (${pendingMissing})` : ""}
        </button>
      </div>

      {section === "absences" && (
        <div className="section-card">
          <div className="section-head">Unexplained absences — {from} to {to}</div>
          <AbsenceTable items={absences} loading={loading} canEdit={canEdit} onSave={saveFollowup} showTimeIn={false} />
        </div>
      )}

      {section === "notimeout" && (
        <div className="section-card">
          <div className="section-head">Timed in, no time-out — {from} to {to}</div>
          <AbsenceTable items={noTimeouts} loading={loading} canEdit={canEdit} onSave={saveFollowup} showTimeIn={true} />
        </div>
      )}

      {section === "patterns" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="section-card">
            <div className="section-head">Repeat absentees</div>
            <table>
              <thead><tr><th>Guard</th><th style={{ textAlign: "center" }}>Absences</th></tr></thead>
              <tbody>
                {patterns.repeatAbsentees.length === 0 && <tr className="empty-row"><td colSpan={2}>No absences in range.</td></tr>}
                {patterns.repeatAbsentees.map((r) => (
                  <tr key={r.guardName}>
                    <td><strong>{r.guardName}</strong></td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`badge ${r.count > 1 ? "badge-open" : "badge-closed"}`}>{r.count}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="section-card">
            <div className="section-head">Absence concentration by site</div>
            <table>
              <thead><tr><th>Site</th><th style={{ textAlign: "center" }}>Absences</th></tr></thead>
              <tbody>
                {patterns.siteConcentration.length === 0 && <tr className="empty-row"><td colSpan={2}>No absences in range.</td></tr>}
                {patterns.siteConcentration.map((r) => (
                  <tr key={r.site}>
                    <td>{r.site}</td>
                    <td style={{ textAlign: "center" }}><span className="badge badge-inprogress">{r.count}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {section === "missing" && (
        <MissingTimeLogPanel reqs={missingReqs} canEdit={canEdit} isAdmin={isAdmin} onReview={reviewMissing} onDelete={deleteMissing} />
      )}

      {showShare && <ShareFormModal kind="missing" onClose={() => setShowShare(false)} />}
      {showShareMy && <ShareFormModal kind="myattendance" onClose={() => setShowShareMy(false)} />}
    </div>
  );
}

function MissingTimeLogPanel({ reqs, canEdit, isAdmin, onReview, onDelete }) {
  const [filter, setFilter] = useState("");
  const rows = filter ? reqs.filter((r) => r.status === filter) : reqs;
  return (
    <div className="section-card">
      <div className="section-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Missing Time Log Requests</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ fontSize: 12.5 }}>
          <option value="">All statuses</option>
          <option value="Pending">Pending</option>
          <option value="Approved">Approved</option>
          <option value="Rejected">Rejected</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Guard</th><th>Site</th><th>Missing</th><th>Explanation</th><th>Status</th>
            {canEdit && <th>Review</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 7 : 6}>No requests.</td></tr>}
          {rows.map((r) => (
            <MissingRow key={r.id} r={r} canEdit={canEdit} isAdmin={isAdmin} onReview={onReview} onDelete={onDelete} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MissingRow({ r, canEdit, isAdmin, onReview, onDelete }) {
  const [reviewing, setReviewing] = useState(false);
  const [inAt, setInAt] = useState(`${r.dutyDate}T06:00`);
  const [outAt, setOutAt] = useState(`${r.dutyDate}T18:00`);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const needIn = r.missingType === "IN" || r.missingType === "BOTH";
  const needOut = r.missingType === "OUT" || r.missingType === "BOTH";
  const label = r.missingType === "BOTH" ? "Time In & Out" : r.missingType === "IN" ? "Time In" : "Time Out";

  function badge(s) {
    const cls = s === "Approved" ? "badge-resolved" : s === "Rejected" ? "badge-open" : "badge-inprogress";
    return <span className={`badge ${cls}`}>{s}</span>;
  }

  async function approve() {
    setBusy(true);
    await onReview(r.id, "Approved", needIn ? inAt : null, needOut ? outAt : null, note);
    setBusy(false); setReviewing(false);
  }
  async function reject() {
    const n = window.prompt("Reason for rejection (optional):", "") || "";
    setBusy(true);
    await onReview(r.id, "Rejected", null, null, n);
    setBusy(false); setReviewing(false);
  }

  return (
    <tr>
      <td data-label="Date">{r.dutyDate}</td>
      <td data-label="Guard"><strong>{r.guardName}</strong>{r.employeeNo ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.employeeNo}</div> : null}</td>
      <td data-label="Site">{r.site || "—"}</td>
      <td data-label="Missing">{label}</td>
      <td data-label="Explanation" style={{ maxWidth: 220, fontSize: 12.5, color: "var(--text-mute)" }}>{r.reason}</td>
      <td data-label="Status">
        {badge(r.status)}
        {r.status !== "Pending" && r.reviewedBy && <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 3 }}>by {r.reviewedBy}{r.reviewNote ? ` — ${r.reviewNote}` : ""}</div>}
        {r.status === "Approved" && (r.approvedInAt || r.approvedOutAt) && (
          <div style={{ fontSize: 11, color: "var(--green)", marginTop: 2 }}>
            {r.approvedInAt ? `IN ${r.approvedInAt.slice(11)}` : ""}{r.approvedInAt && r.approvedOutAt ? " · " : ""}{r.approvedOutAt ? `OUT ${r.approvedOutAt.slice(11)}` : ""}
          </div>
        )}
      </td>
      {canEdit && (
        <td data-label="Review" style={{ minWidth: 240 }}>
          {r.status === "Pending" ? (
            !reviewing ? (
              <button className="btn btn-sm btn-primary" onClick={() => setReviewing(true)}>Review</button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {needIn && <label style={{ fontSize: 11, margin: 0 }}>Set Time In<input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} style={{ fontSize: 12 }} /></label>}
                {needOut && <label style={{ fontSize: 11, margin: 0 }}>Set Time Out<input type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} style={{ fontSize: 12 }} /></label>}
                <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ fontSize: 12 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-primary" onClick={approve} disabled={busy}>Approve &amp; correct</button>
                  <button className="btn btn-sm btn-danger" onClick={reject} disabled={busy}>Reject</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setReviewing(false)}>Cancel</button>
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

function AbsenceTable({ items, loading, canEdit, onSave, showTimeIn }) {
  const colCount = showTimeIn ? 7 : 6;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Guard</th><th>Site</th><th>Shift</th>
          {showTimeIn && <th>Time In</th>}
          <th>Status</th>
          {canEdit && <th>Follow-up</th>}
        </tr>
      </thead>
      <tbody>
        {loading && <tr className="empty-row"><td colSpan={colCount + (canEdit ? 1 : 0)}>Loading…</td></tr>}
        {!loading && items.length === 0 && <tr className="empty-row"><td colSpan={colCount + (canEdit ? 1 : 0)}>None in the selected range. 🎉</td></tr>}
        {!loading && items.map((r, i) => (
          <FollowupRow key={`${r.guardName}|${r.dutyDate}|${r.kind}`} item={r} canEdit={canEdit} onSave={onSave} showTimeIn={showTimeIn} />
        ))}
      </tbody>
    </table>
  );
}

function FollowupRow({ item, canEdit, onSave, showTimeIn }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(item.status || "Pending");
  const [remark, setRemark] = useState(item.remark || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(item, status, remark);
    setSaving(false);
    setEditing(false);
  }

  return (
    <tr>
      <td data-label="Date">{item.dutyDate}</td>
      <td data-label="Guard"><strong>{item.guardName}</strong></td>
      <td data-label="Site">{item.site || "—"}</td>
      <td data-label="Shift">{item.shiftName || "—"}</td>
      {showTimeIn && <td data-label="Time In">{item.timeIn ? fmtTime(item.timeIn) : "—"}</td>}
      <td data-label="Status">
        {statusBadge(item.status || "Pending")}
        {item.remark ? <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 3 }}>{item.remark}</div> : null}
      </td>
      {canEdit && (
        <td data-label="Follow-up" style={{ minWidth: 260 }}>
          {!editing ? (
            <button className="btn btn-sm btn-secondary" onClick={() => { setStatus(item.status || "Pending"); setRemark(item.remark || ""); setEditing(true); }}>
              {item.status && item.status !== "Pending" ? "Edit" : "Record"}
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="Pending">Pending</option>
                <option value="Excused">Excused</option>
                <option value="Actioned">Actioned</option>
              </select>
              <input type="text" placeholder="Reason / action taken" value={remark} onChange={(e) => setRemark(e.target.value)} style={{ fontSize: 12.5 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          )}
        </td>
      )}
    </tr>
  );
}
