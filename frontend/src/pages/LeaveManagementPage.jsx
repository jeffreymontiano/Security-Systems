import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Manage employee leave requests and approvals";

function statusBadge(s) {
  const cls = s === "Approved" ? "badge-resolved" : s === "Rejected" ? "badge-open" : "badge-inprogress";
  return <span className={`badge ${cls}`}>{s}</span>;
}

export default function LeaveManagementPage() {
  const { isViewer, isAdmin } = useAuth();
  const canReview = !isViewer;

  const [records, setRecords] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);

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

  const actions = canReview ? (
    <button className="btn btn-gold" onClick={() => setShowNew(true)}>+ New leave request</button>
  ) : null;

  return (
    <div className="module-view">
      <ModuleHeader title="Leave Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Record employee leave requests and process approvals. Approved leave is reflected in attendance reports, so those days show as "On Leave" rather than absent.</PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

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
              <th>Employee No</th><th>Name</th><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th>Reviewed by</th>
              {canReview && <th></th>}
            </tr>
          </thead>
          <tbody>
            {error && <tr className="empty-row"><td colSpan={canReview ? 9 : 8}>{error}</td></tr>}
            {!error && loading && <tr className="empty-row"><td colSpan={canReview ? 9 : 8}>Loading leave records…</td></tr>}
            {!error && !loading && rows.length === 0 && <tr className="empty-row"><td colSpan={canReview ? 9 : 8}>No leave records match your filters.</td></tr>}
            {!error && rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Employee No">{r.employeeNo || "—"}</td>
                <td data-label="Name"><strong>{r.employeeName}</strong></td>
                <td data-label="Type">{r.leaveType}</td>
                <td data-label="From">{r.fromDate}</td>
                <td data-label="To">{r.toDate}</td>
                <td data-label="Reason" style={{ maxWidth: 200, fontSize: 12.5, color: "var(--text-mute)" }}>{r.reason || "—"}</td>
                <td data-label="Status">{statusBadge(r.status)}</td>
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

      <ConfidentialFooter />

      {showNew && (
        <NewLeaveModal
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await loadData(); }}
        />
      )}
    </div>
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
