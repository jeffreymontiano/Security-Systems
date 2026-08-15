import { useEffect, useMemo, useState, useCallback } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { toast } from "../lib/toast";
import { confirm } from "../lib/confirm";
import { prompt } from "../lib/prompt";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ShareFormModal from "./ShareFormModal";
import KpiCard from "../components/KpiCard";

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
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
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
      // Approving a correction WRITES attendance punches, which is exactly what
      // the Unexplained Absences / Pending Follow-up / No Time-Out cards count.
      // Reloading only the request list left all three showing the figures from
      // before the approval.
      await run();
    } catch (e) { setError(e.message); }
  }

  // Returns the server's summary so the modal can show what was applied and
  // what was skipped, rather than silently succeeding on a partial batch.
  // Returns a site-mismatched request to billing. The server re-reads the
  // roster and refuses with 409 while the two still disagree, so this button
  // cannot make an unreconciled day billable — the admin has to fix the roster
  // (Shift Scheduling) or the submission first.
  async function resolveSite(id) {
    try {
      const res = await api(`/absence-monitoring/missing-timelog/${id}/resolve-site`, { method: "PATCH" });
      toast.success(`Site reconciled to ${res.rosteredSite}. This day returns to billing.`);
      await loadMissing();
    } catch (e) {
      setError(e.message);
    }
  }

  async function bulkReviewMissing(ids, decision, reviewNote) {
    try {
      const res = await api("/absence-monitoring/missing-timelog/bulk-review", {
        method: "PATCH",
        body: JSON.stringify({ ids, decision, reviewNote }),
      });
      await loadMissing();
      await run(); // absences/KPIs shift once corrections land
      return res;
    } catch (e) {
      setError(e.message);
      return { decision, appliedCount: 0, skippedCount: ids.length, skipped: [{ id: 0, dutyDate: null, reason: e.message }] };
    }
  }

  async function deleteMissing(id) {
    if (!await confirm("Delete this request?")) return;
    try {
      await api(`/absence-monitoring/missing-timelog/${id}`, { method: "DELETE" });
      await loadMissing();
      // The KPI cards are derived from attendance, not from this list.
      await run();
    } catch (e) { setError(e.message); }
  }

  const pendingMissing = missingReqs.filter((r) => r.status === "Pending").length;

  return (
    <>
      {/* Share links — offered to anyone who may ADD attendance records, since
          the forms they hand out create them. Was Admin-only. */}
      {perm.add && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 32px 0" }}>
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
      <div className="kpi-grid" data-cols="4">
        <KpiCard label={<>Unexplained absences</>} value={kpi.absences} tone="danger" icon="bi-person-x" />
        <KpiCard label={<>Pending follow-up</>} value={kpi.pending} tone="neutral" icon="bi-hourglass-split" />
        <KpiCard label={<>No time-out</>} value={kpi.noTimeouts} tone="neutral" icon="bi-clock-history" />
        <KpiCard label={<>Repeat absentees</>} value={kpi.repeatAbsentees} tone="neutral" icon="bi-arrow-repeat" />
      </div>

      {/* Section switch */}
      <div style={{ display: "flex", gap: 6, margin: "16px 32px 12px", alignItems: "center", flexWrap: "wrap" }}>
        <button className={`btn btn-sm ${section === "absences" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("absences")}>Unexplained absences</button>
        <button className={`btn btn-sm ${section === "notimeout" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("notimeout")}>No time-out</button>
        <button className={`btn btn-sm ${section === "patterns" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("patterns")}>Patterns</button>
        <button className={`btn btn-sm ${section === "missing" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSection("missing")}>
          Missing Time Log Requests{pendingMissing > 0 ? ` (${pendingMissing})` : ""}
        </button>
      </div>

      {section === "absences" && (
        <div className="section-card sticky-card">
          <div className="section-head">Unexplained absences — {from} to {to}</div>
          <AbsenceTable items={absences} loading={loading} canEdit={canEdit} onSave={saveFollowup} showTimeIn={false} />
        </div>
      )}

      {section === "notimeout" && (
        <div className="section-card sticky-card">
          <div className="section-head">Timed in, no time-out — {from} to {to}</div>
          <AbsenceTable items={noTimeouts} loading={loading} canEdit={canEdit} onSave={saveFollowup} showTimeIn={true} />
        </div>
      )}

      {section === "patterns" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="section-card sticky-card">
            <div className="section-head">Repeat absentees</div>
            <table className="sticky-head">
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
          <div className="section-card sticky-card">
            <div className="section-head">Absence concentration by site</div>
            <table className="sticky-head">
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
        <MissingTimeLogPanel reqs={missingReqs} canEdit={canEdit} isAdmin={isAdmin}
          onReview={reviewMissing} onDelete={deleteMissing} onBulkReview={bulkReviewMissing}
          onResolveSite={resolveSite} />
      )}

      {showShare && <ShareFormModal kind="missing" onClose={() => setShowShare(false)} />}
      {showShareMy && <ShareFormModal kind="myattendance" onClose={() => setShowShareMy(false)} />}
    </>
  );
}

function MissingTimeLogPanel({ reqs, canEdit, isAdmin, onReview, onDelete, onBulkReview, onResolveSite }) {
  const [filter, setFilter] = useState("");
  const [showMass, setShowMass] = useState(false);
  const rows = filter ? reqs.filter((r) => r.status === filter) : reqs;
  return (
    <div className="section-card sticky-card">
      <div className="section-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>Missing Time Log Requests</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {canEdit && (
            <button className="btn btn-sm btn-gold" onClick={() => setShowMass(true)}>Mass Approval</button>
          )}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ fontSize: 12.5 }}>
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>
      </div>

      {showMass && (
        <MassApprovalModal
          reqs={rows}
          isAdmin={isAdmin}
          onClose={() => setShowMass(false)}
          onSubmit={onBulkReview}
        />
      )}
      <table className="sticky-head">
        <thead>
          <tr>
            <th>Date</th><th>Guard</th><th>Site</th><th>Missing</th><th>Explanation</th><th>Evidence</th><th>Status</th>
            {canEdit && <th>Review</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 8 : 7}>No requests.</td></tr>}
          {rows.map((r) => (
            <MissingRow key={r.id} r={r} canEdit={canEdit} isAdmin={isAdmin} onReview={onReview} onDelete={onDelete}
              onResolveSite={onResolveSite} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Review many requests at once. The response and comment chosen at the top are
 * applied to every ticked row.
 *
 * Approving needs TIMES, not just a decision, so each request is timed from
 * its own rostered shift — the same default the single-review form uses. A
 * single blanket time pair can't work here: a night shift's time-out falls on
 * the following day, and different guards sit on different rosters. Rows with
 * no shift rostered are shown as un-approvable rather than guessed at, since
 * inventing times would feed wrong hours straight into payroll.
 */
function MassApprovalModal({ reqs, isAdmin, onClose, onSubmit }) {
  const [decision, setDecision] = useState("Approved");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const eligible = (r) =>
    (r.status === "Pending" || isAdmin) &&        // re-reviewing is Admin-only
    (decision === "Rejected" || !!r.shiftStart);  // approving needs a roster

  const [picked, setPicked] = useState(() => new Set(reqs.filter((r) => r.status === "Pending").map((r) => r.id)));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const selectable = reqs.filter(eligible);
  const chosen = selectable.filter((r) => picked.has(r.id));
  const blocked = reqs.filter((r) => !eligible(r));

  async function submit() {
    if (chosen.length === 0) return;
    setBusy(true);
    try { setResult(await onSubmit(chosen.map((r) => r.id), decision, note)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Mass review — Missing Time Log Requests</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {result ? (
            <>
              <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--teal-bg)", borderColor: "#bfe3d6", color: "var(--teal)" }}>
                <strong>{result.appliedCount} request{result.appliedCount === 1 ? "" : "s"} {result.decision === "Approved" ? "approved" : "rejected"}.</strong>
                {result.skippedCount > 0 && ` ${result.skippedCount} skipped.`}
              </div>
              {result.skipped?.length > 0 && (
                <table>
                  <thead><tr><th>Date</th><th>Why it was skipped</th></tr></thead>
                  <tbody>
                    {result.skipped.map((s) => (
                      <tr key={s.id}><td>{s.dutyDate || "—"}</td><td style={{ color: "var(--text-mute)" }}>{s.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <>
              <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", paddingBottom: 12, borderBottom: "1px solid var(--border)", marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-mute)", textTransform: "uppercase", letterSpacing: 0.4 }}>Response</label>
                  <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
                    {["Approved", "Rejected"].map((d) => (
                      <label key={d} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                        <input type="radio" name="massDecision" checked={decision === d} onChange={() => setDecision(d)} />
                        {d === "Approved" ? "Approve" : "Reject"}
                      </label>
                    ))}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-mute)", textTransform: "uppercase", letterSpacing: 0.4 }}>Comment</label>
                  <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Applied to every selected request" style={{ width: "100%", marginTop: 6 }} />
                </div>
              </div>

              {decision === "Approved" && (
                <p style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 0 }}>
                  Each request is approved using <strong>its own rostered shift times</strong> — a night shift's
                  time-out lands on the following day. Review anything unusual individually instead.
                </p>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}>
                <button className="btn btn-sm btn-secondary" onClick={() => setPicked(new Set(selectable.map((r) => r.id)))}>Select all ({selectable.length})</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setPicked(new Set())}>Clear</button>
                <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{chosen.length} selected</span>
              </div>

              <table>
                <thead><tr><th style={{ width: 34 }}></th><th>Date</th><th>Guard</th><th>Missing</th><th>Scheduled shift</th><th>Status</th></tr></thead>
                <tbody>
                  {selectable.length === 0 && <tr className="empty-row"><td colSpan={6}>Nothing here can be {decision === "Approved" ? "approved" : "rejected"} in bulk.</td></tr>}
                  {selectable.map((r) => (
                    <tr key={r.id}>
                      <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                      <td>{r.dutyDate}</td>
                      <td>{r.guardName}</td>
                      <td>{r.missingType === "BOTH" ? "In & Out" : r.missingType}</td>
                      <td style={{ fontSize: 12.5 }}>
                        {r.shiftStart ? `${r.shiftStart}–${r.shiftEnd}${r.shiftCrossesMidnight ? " (+1d)" : ""}` : "—"}
                      </td>
                      <td><span className={`badge ${r.status === "Approved" ? "badge-resolved" : r.status === "Rejected" ? "badge-open" : "badge-inprogress"}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {blocked.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: "#8a6d1f", background: "var(--amber-bg, #fff7e6)", border: "1px solid #f0dca0", borderRadius: 6, padding: "8px 12px" }}>
                  <strong>{blocked.length} not available here:</strong>{" "}
                  {blocked.map((r) => `${r.dutyDate} (${!r.shiftStart && decision === "Approved" ? "no shift rostered" : "already reviewed — Admin only"})`).join(", ")}.
                  {" "}Handle those individually.
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          {result ? (
            <button className="btn btn-gold" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-gold" onClick={submit} disabled={busy || chosen.length === 0}>
                {busy ? "Applying…" : `${decision === "Approved" ? "Approve" : "Reject"} ${chosen.length} request${chosen.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Add whole days to a YYYY-MM-DD string via UTC so no timezone can shift it.
function addDaysISO(dateStr, n) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

function MissingRow({ r, canEdit, isAdmin, onReview, onDelete, onResolveSite }) {
  const [reviewing, setReviewing] = useState(false);
  // Default the corrected times to the guard's ROSTERED shift for this date,
  // falling back to a 06:00-18:00 day shift only when nothing is scheduled.
  // These used to be hardcoded to 06:00/18:00, so approving a night shift
  // wrote punches outside the shift's matching window and the day still read
  // "Absent" even though the correction had been approved. A night shift's
  // time-out also lands on the NEXT calendar day, which the old default
  // could not express at all.
  const shiftStart = r.shiftStart || "06:00";
  const shiftEnd = r.shiftEnd || "18:00";
  const outDate = r.shiftCrossesMidnight ? addDaysISO(r.dutyDate, 1) : r.dutyDate;
  const [inAt, setInAt] = useState(`${r.dutyDate}T${shiftStart}`);
  const [outAt, setOutAt] = useState(`${outDate}T${shiftEnd}`);
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
    const n = await prompt("Reason for rejection (optional):", "") || "";
    setBusy(true);
    await onReview(r.id, "Rejected", null, null, n);
    setBusy(false); setReviewing(false);
  }

  return (
    <tr>
      <td data-label="Date">{r.dutyDate}</td>
      <td data-label="Guard"><strong>{r.guardName}</strong>{r.employeeNo ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.employeeNo}</div> : null}</td>
      <td data-label="Site">
        {r.site || "—"}
        {/* A disagreement with the roster is not decoration: the day is held
            OUT of billing until it is reconciled, so it is stated in words
            rather than left as a coloured dot. */}
        {r.siteMismatch === true && (
          <div style={{ fontSize: 11, color: "var(--red)", marginTop: 3, lineHeight: 1.4 }}>
            <strong>Pending site review</strong>
            <div>Rostered at {r.rosteredSite || "—"}. Excluded from billing until resolved.</div>
          </div>
        )}
        {r.siteMismatch === false && r.siteResolvedBy && (
          <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 3 }}>
            Site reconciled by {r.siteResolvedBy}{r.siteResolvedAt ? ` — ${r.siteResolvedAt}` : ""}
          </div>
        )}
      </td>
      <td data-label="Missing">{label}</td>
      <td data-label="Explanation" style={{ maxWidth: 220, fontSize: 12.5, color: "var(--text-mute)" }}>{r.reason}</td>
      <td data-label="Evidence" style={{ fontSize: 12 }}><EvidenceCell r={r} /></td>
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
          {/* Shown whatever the approval status: a request can be approved and
              still be held out of billing on the site question, and those are
              two different decisions. */}
          {r.siteMismatch === true && (
            <button className="btn btn-sm btn-outline" style={{ marginBottom: 6, borderColor: "var(--red)", color: "var(--red)" }}
              onClick={() => onResolveSite(r.id)}
              title={`Confirm the roster and this request now agree. Rostered at ${r.rosteredSite || "—"}.`}>
              Resolve site
            </button>
          )}
          {r.status === "Pending" ? (
            !reviewing ? (
              <button className="btn btn-sm btn-primary" onClick={() => setReviewing(true)}>Review</button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, color: r.shiftStart ? "var(--text-mute)" : "var(--red)" }}>
                  {r.shiftStart
                    ? <>Scheduled: <strong>{r.shiftName || "Shift"} {r.shiftStart}–{r.shiftEnd}</strong>{r.shiftCrossesMidnight ? " (ends next day)" : ""}</>
                    : <>No shift rostered for this date — times below are a guess, check them.</>}
                </div>
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
          ) : !reviewing ? (
            // Already reviewed. An Admin can redo it — approving with times
            // that don't match the shift is easy to do and previously had no
            // remedy short of deleting and re-filing the whole request.
            isAdmin && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn btn-sm btn-primary" onClick={() => setReviewing(true)}>Re-review</button>
                <button className="btn btn-sm btn-secondary" onClick={() => onDelete(r.id)}>Delete</button>
              </div>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: r.shiftStart ? "var(--text-mute)" : "var(--red)" }}>
                {r.shiftStart
                  ? <>Scheduled: <strong>{r.shiftName || "Shift"} {r.shiftStart}–{r.shiftEnd}</strong>{r.shiftCrossesMidnight ? " (ends next day)" : ""}</>
                  : <>No shift rostered for this date — times below are a guess, check them.</>}
              </div>
              {needIn && <label style={{ fontSize: 11, margin: 0 }}>Set Time In<input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} style={{ fontSize: 12 }} /></label>}
              {needOut && <label style={{ fontSize: 11, margin: 0 }}>Set Time Out<input type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} style={{ fontSize: 12 }} /></label>}
              <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ fontSize: 12 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm btn-primary" onClick={approve} disabled={busy}>Save correction</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setReviewing(false)}>Cancel</button>
              </div>
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

function AbsenceTable({ items, loading, canEdit, onSave, showTimeIn }) {
  const colCount = showTimeIn ? 7 : 6;
  return (
    <table className="sticky-head">
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

/**
 * The selfie and any supporting files a guard attached, plus the control that
 * returns a site-mismatched record to billing.
 *
 * Nothing is fetched until asked for: the list route returns counts only, and
 * the bytes come down one request at a time through the authenticated download
 * routes. A public form collected these, so they are never rendered inline —
 * apiBlobUrl/downloadBlobUrl carry the bearer token and the server serves them
 * as attachments.
 */
function EvidenceCell({ r }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);

  const count = Number(r.attachmentCount || 0);
  if (!r.hasSelfie && count === 0) return <span style={{ color: "var(--text-mute)" }}>—</span>;

  async function grab(path, filename) {
    setBusy(true);
    try {
      const url = await apiBlobUrl(path);
      downloadBlobUrl(url, filename);
    } finally { setBusy(false); }
  }

  async function listFiles() {
    if (files) { setFiles(null); return; }
    setFiles(await api(`/absence-monitoring/missing-timelog/${r.id}/attachments`).catch(() => []));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {r.hasSelfie && (
        <button className="btn btn-sm btn-outline" disabled={busy}
          onClick={() => grab(`/absence-monitoring/missing-timelog/${r.id}/selfie`, `selfie-MTL-${r.id}.jpg`)}>
          Selfie
        </button>
      )}
      {/* Coordinates, when the guard allowed location. A map link rather than
          raw numbers, since the reviewer's question is "where was this". */}
      {r.latitude != null && r.longitude != null && (
        <a href={`https://www.google.com/maps?q=${r.latitude},${r.longitude}`}
           target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
          {Number(r.latitude).toFixed(5)}, {Number(r.longitude).toFixed(5)}
        </a>
      )}
      {count > 0 && (
        <button className="btn btn-sm btn-outline" onClick={listFiles}>
          {files ? "Hide" : `${count} file${count === 1 ? "" : "s"}`}
        </button>
      )}
      {files && files.map((f) => (
        <button key={f.id} className="btn btn-sm btn-outline" disabled={busy} title={`${Math.round(f.size / 1024)} KB`}
          onClick={() => grab(`/absence-monitoring/missing-timelog/${r.id}/attachments/${f.id}`, f.filename)}>
          {f.filename.length > 22 ? f.filename.slice(0, 20) + "…" : f.filename}
        </button>
      ))}
    </div>
  );
}
