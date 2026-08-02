import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import ShareFormModal from "./ShareFormModal";

const SUBTITLE = "Manage employee leave requests and approvals";

function statusBadge(s) {
  const cls = s === "Approved" ? "badge-resolved" : s === "Rejected" ? "badge-open" : "badge-inprogress";
  return <span className={`badge ${cls}`}>{s}</span>;
}

// Renders the paid/LWOP outcome for an approved request. Falls back to a plain
// dash for pending/rejected rows or legacy approvals with no split recorded.
function splitCell(r) {
  if (r.status !== "Approved" || r.totalDays == null) return <span style={{ color: "var(--text-mute)" }}>—</span>;
  const total = Number(r.totalDays), paid = Number(r.paidDays || 0), lwop = Number(r.lwopDays || 0);
  if (r.creditBucket == null) {
    return <span style={{ fontSize: 12 }}>{total} day{total === 1 ? "" : "s"} <span style={{ color: "var(--text-mute)" }}>(always allowed)</span></span>;
  }
  return (
    <span style={{ fontSize: 12 }}>
      {paid > 0 && <span style={{ color: "var(--green)" }}>{paid} paid</span>}
      {paid > 0 && lwop > 0 && ", "}
      {lwop > 0 && <span style={{ color: "var(--red)", fontWeight: 600 }}>{lwop} LWOP</span>}
      {" "}<span style={{ color: "var(--text-mute)" }}>({r.creditBucket})</span>
    </span>
  );
}

export default function LeaveManagementPage() {
  const { isViewer, isAdmin } = useAuth();
  const canReview = !isViewer;

  const [view, setView] = useState("requests"); // "requests" | "credits"
  const [records, setRecords] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [recs, st] = await Promise.all([
        api("/leave"),
        api("/leave/_all/stats"),
      ]);
      setRecords(recs);
      setStats(st);
      setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (filterStatus && r.status !== filterStatus) return false;
      if (q && !`${r.employeeName} ${r.employeeNo} ${r.leaveType}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, search, filterStatus]);

  async function review(id, decision) {
    let note = "";
    if (decision === "Rejected") {
      note = window.prompt("Reason for rejection (optional):", "") || "";
    }
    try {
      await api(`/leave/${id}/review`, { method: "PATCH", body: JSON.stringify({ decision, reviewNote: note }) });
      await loadData();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!window.confirm("Delete this leave record?")) return;
    try { await api(`/leave/${id}`, { method: "DELETE" }); await loadData(); }
    catch (e) { setError(e.message); }
  }

  const actions = (
    <>
      {isAdmin && <button className="btn btn-outline" onClick={() => setShowShare(true)}>Share form link</button>}
      {canReview && <button className="btn btn-gold" onClick={() => setShowNew(true)}>+ New leave request</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader title="Leave Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Record employee leave requests and process approvals. Approved leave is reflected in attendance reports, so those days show as "On Leave" rather than absent. On approval, days are deducted from the employee's Vacation or Sick credits; any shortfall is tagged Leave Without Pay (LWOP).</PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0" }}>
        <button className={`btn btn-sm ${view === "requests" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("requests")}>Requests</button>
        <button className={`btn btn-sm ${view === "credits" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("credits")}>Leave Credits</button>
      </div>

      {view === "credits" && <LeaveCreditsSection isAdmin={isAdmin} onError={setError} />}

      {view === "requests" && (
      <>
      <div className="toolbar">
        <div className="toolbar-left">
          <input type="text" className="search-input" placeholder="Search name, number, or type..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} record${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {stats && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <div className="kpi-card"><div className="kpi-label">Total</div><div className="kpi-value">{stats.total}</div></div>
          <div className="kpi-card"><div className="kpi-label">Pending</div><div className="kpi-value">{stats.pending}</div></div>
          <div className="kpi-card good"><div className="kpi-label">Approved</div><div className="kpi-value">{stats.approved}</div></div>
          <div className="kpi-card danger"><div className="kpi-label">Rejected</div><div className="kpi-value">{stats.rejected}</div></div>
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Leave requests</div>
        <table>
          <thead>
            <tr>
              <th>Employee No</th><th>Name</th><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th>Paid / LWOP</th><th>Reviewed by</th>
              {canReview && <th></th>}
            </tr>
          </thead>
          <tbody>
            {error && <tr className="empty-row"><td colSpan={canReview ? 10 : 9}>{error}</td></tr>}
            {!error && loading && <tr className="empty-row"><td colSpan={canReview ? 10 : 9}>Loading leave records…</td></tr>}
            {!error && !loading && rows.length === 0 && <tr className="empty-row"><td colSpan={canReview ? 10 : 9}>No leave records match your filters.</td></tr>}
            {!error && rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Employee No">{r.employeeNo || "—"}</td>
                <td data-label="Name"><strong>{r.employeeName}</strong></td>
                <td data-label="Type">{r.leaveType}</td>
                <td data-label="From">{r.fromDate}</td>
                <td data-label="To">{r.toDate}</td>
                <td data-label="Reason" style={{ maxWidth: 180, fontSize: 12.5, color: "var(--text-mute)" }}>{r.reason || "—"}</td>
                <td data-label="Status">{statusBadge(r.status)}</td>
                <td data-label="Paid / LWOP">{splitCell(r)}</td>
                <td data-label="Reviewed by" style={{ fontSize: 12 }}>
                  {r.reviewedBy ? <>{r.reviewedBy}{r.reviewNote ? <div style={{ color: "var(--text-mute)" }}>{r.reviewNote}</div> : null}</> : "—"}
                </td>
                {canReview && (
                  <td data-label="" style={{ whiteSpace: "nowrap" }}>
                    {r.status === "Pending" ? (
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => review(r.id, "Approved")}>Approve</button>{" "}
                        <button className="btn btn-sm btn-danger" onClick={() => review(r.id, "Rejected")}>Reject</button>
                      </>
                    ) : (
                      isAdmin && <button className="btn btn-sm btn-secondary" onClick={() => remove(r.id)}>Delete</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      <ConfidentialFooter />

      {showNew && (
        <NewLeaveModal
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await loadData(); }}
        />
      )}

      {showShare && <ShareFormModal kind="leave" onClose={() => setShowShare(false)} />}
    </div>
  );
}

// ---- Leave Credits section (Admin can edit; others view) ------------------

function LeaveCreditsSection({ isAdmin, onError }) {
  const [credits, setCredits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setCredits(await api("/leave/credits")); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return credits;
    return credits.filter((c) => `${c.fullName} ${c.employeeNo} ${c.site}`.toLowerCase().includes(q));
  }, [credits, search]);

  async function edit(employeeId, bucket, currentBalance) {
    const raw = window.prompt(
      `Set ${bucket} credits (days). Enter a number to set the balance, or "+2" / "-1" to add or subtract.`,
      String(currentBalance)
    );
    if (raw == null) return;
    const s = raw.trim();
    if (!s) return;
    let mode = "set", amount;
    if (s.startsWith("+") || s.startsWith("-")) { mode = "add"; amount = Number(s); }
    else { amount = Number(s); }
    if (!Number.isFinite(amount)) { onError("Please enter a valid number."); return; }
    try {
      await api(`/leave/credits/${employeeId}`, { method: "PUT", body: JSON.stringify({ bucket, mode, amount }) });
      await load();
      onError("");
    } catch (e) { onError(e.message); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <input type="text" className="search-input" placeholder="Search employee, number, or site..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} employee${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Leave credit balances</div>
        <table>
          <thead>
            <tr>
              <th>Employee No</th><th>Name</th><th>Position</th><th>Site</th>
              <th>Vacation</th><th>Sick</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={isAdmin ? 7 : 6}>Loading balances…</td></tr>}
            {!loading && rows.length === 0 && <tr className="empty-row"><td colSpan={isAdmin ? 7 : 6}>No employees match your search.</td></tr>}
            {!loading && rows.map((c) => (
              <tr key={c.employeeId}>
                <td data-label="Employee No">{c.employeeNo || "—"}</td>
                <td data-label="Name"><strong>{c.fullName}</strong></td>
                <td data-label="Position" style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{c.position || "—"}</td>
                <td data-label="Site">{c.site ? <span className="chip">{c.site}</span> : "—"}</td>
                <td data-label="Vacation"><strong>{c.vacationBalance}</strong></td>
                <td data-label="Sick"><strong>{c.sickBalance}</strong></td>
                {isAdmin && (
                  <td data-label="" style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => edit(c.employeeId, "Vacation", c.vacationBalance)}>Edit VL</button>{" "}
                    <button className="btn btn-sm btn-secondary" onClick={() => edit(c.employeeId, "Sick", c.sickBalance)}>Edit SL</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NewLeaveModal({ onClose, onCreated }) {
  const [employees, setEmployees] = useState([]);
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState({ employeeId: "", leaveType: "", fromDate: "", toDate: "", reason: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api("/leave/employees").catch(() => []), api("/leave/types").catch(() => [])])
      .then(([emps, tps]) => { setEmployees(emps); setTypes(tps); });
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!form.employeeId) { setError("Please select an employee."); return; }
    if (!form.leaveType) { setError("Please choose a leave type."); return; }
    if (!form.fromDate || !form.toDate) { setError("From and to dates are required."); return; }
    if (form.toDate < form.fromDate) { setError("The end date can't be before the start date."); return; }
    setSaving(true); setError("");
    try {
      await api("/leave", { method: "POST", body: JSON.stringify({ ...form, employeeId: Number(form.employeeId) }) });
      onCreated();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>New leave request</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Employee (from 201 File)</label>
            <select value={form.employeeId} onChange={set("employeeId")}>
              <option value="">— Select employee —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Leave type</label>
            <select value={form.leaveType} onChange={set("leaveType")}>
              <option value="">— Select type —</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={form.fromDate} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, fromDate: v, toDate: !f.toDate || f.toDate < v ? v : f.toDate })); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={form.toDate} min={form.fromDate} onChange={set("toDate")} />
            </div>
          </div>
          <div className="form-field">
            <label>Reason (optional)</label>
            <textarea rows={3} value={form.reason} onChange={set("reason")} placeholder="Brief reason for the leave" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "Submit request"}</button>
        </div>
      </div>
    </div>
  );
}
