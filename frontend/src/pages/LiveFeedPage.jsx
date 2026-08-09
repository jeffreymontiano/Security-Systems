import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import { auditLabel } from "./incidentShared";
import ConfidentialFooter from "../components/ConfidentialFooter";
import { OWNER_ROLE } from "../roles";

const SUBTITLE = "Real-time log of activity across all modules";

/**
 * Live Feed — the system-wide activity log. Mirrors the legacy Live Activity
 * Feed: it reads the most recent audit-log entries from /incidents/_all/audit
 * (the shared audit_log table every module writes to) and, for Admins, offers a
 * date-range purge via DELETE /incidents/_all/audit.
 *
 * Access is closed: the audit log names who did what across every module, so it
 * is limited to the Owner / President / General Manager and the System
 * Administrator. Hiding the sidebar entry is not enough — this guard answers a
 * user who types the URL, and GET /incidents/_all/audit refuses independently.
 * The purge stays Admin-only, both here and on the route.
 */
export default function LiveFeedPage() {
  const { isAdmin, user } = useAuth();
  const mayView = isAdmin || user?.role === OWNER_ROLE;

  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    // Don't fetch what the API will refuse — an unauthorised visitor would get
    // a screen of 403 text instead of a clear answer about access.
    if (!mayView) return;
    setRows(null);
    setError("");
    try {
      setRows(await api("/incidents/_all/audit?limit=50"));
    } catch (e) {
      setError(e.message);
    }
  }, [mayView]);

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

  // Typing the URL directly lands here. No Refresh action is offered, because
  // there is nothing to refresh.
  if (!mayView) {
    return (
      <div className="module-view">
        <ModuleHeader icon="☰" iconBg="var(--navy)" title="Live Activity Feed" subtitle={SUBTITLE} />
        <div className="section-card">
          <div className="section-head">Access restricted</div>
          <div style={{ padding: 18, fontSize: 13.5, lineHeight: 1.7 }}>
            The activity log records who did what across every module, so it is limited to
            the Owner / President / General Manager and the System Administrator.
          </div>
        </div>
        <ConfidentialFooter />
      </div>
    );
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

      <ConfidentialFooter />
    </div>
  );
}
