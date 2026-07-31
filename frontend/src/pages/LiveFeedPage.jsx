import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import { auditLabel } from "./incidentShared";

const SUBTITLE = "Real-time log of activity across all modules";

/**
 * Live Feed — the system-wide activity log. Mirrors the legacy Live Activity
 * Feed: it reads the most recent audit-log entries from /incidents/_all/audit
 * (the shared audit_log table every module writes to) and, for Admins, offers a
 * date-range purge via DELETE /incidents/_all/audit. No backend changes.
 */
export default function LiveFeedPage() {
  const { isAdmin } = useAuth();

  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setRows(null);
    setError("");
    try {
      setRows(await api("/incidents/_all/audit?limit=50"));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function deleteRange() {
    if (!from || !to) { alert("Please choose both a from date and a to date."); return; }
    if (!confirm(`Permanently delete all activity log entries from ${from} to ${to}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const result = await api(`/incidents/_all/audit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "DELETE" });
      alert(`Deleted ${result.deleted} ${result.deleted === 1 ? "entry" : "entries"}.`);
      setFrom(""); setTo("");
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="module-view">
      <ModuleHeader icon="☰" iconBg="var(--navy)" title="Live Activity Feed" subtitle={SUBTITLE}
        actions={<button className="btn btn-outline btn-sm" onClick={load}>Refresh</button>} />
      <PurposeBar>Real-time visibility into activity across incidents and operational records.</PurposeBar>

      {isAdmin && (
        <div className="section-card">
          <div className="section-head">Clear activity log</div>
          <div className="add-row" style={{ padding: "16px 18px" }}>
            <div className="form-field"><label>From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="form-field"><label>To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button className="btn btn-danger btn-sm" onClick={deleteRange} disabled={busy}>Delete range</button>
          </div>
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Recent activity</div>
        <div className="audit-list" style={{ padding: "8px 18px 16px" }}>
          {error && <div className="empty-hint">{error}</div>}
          {!error && rows === null && <div className="empty-hint">Loading...</div>}
          {!error && rows && rows.length === 0 && <div className="empty-hint">No activity recorded yet.</div>}
          {!error && rows && rows.map((r) => (
            <div className="audit-row" key={r.id}>
              <div className="audit-time">{new Date(r.at).toLocaleString()}</div>
              <div className="audit-who">{r.username || "system"}</div>
              <div className="audit-what">
                {r.incident_id && <span className="chip">{r.incident_id}</span>}{" "}
                {auditLabel(r.action)}{r.detail ? ": " + r.detail : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>
    </div>
  );
}
