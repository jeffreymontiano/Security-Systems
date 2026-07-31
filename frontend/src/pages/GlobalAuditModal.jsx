import { useEffect, useState } from "react";
import { api } from "../api/client";
import { auditLabel } from "./incidentShared";

/** System-wide activity log (Admin only). Mirrors #globalAuditModalOverlay. */
export default function GlobalAuditModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/incidents/_all/audit?limit=300").then(setRows).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>System-wide activity log</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="audit-list">
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
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
