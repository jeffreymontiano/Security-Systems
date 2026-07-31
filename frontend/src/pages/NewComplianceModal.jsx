import { useState } from "react";
import { api } from "../api/client";

/**
 * "New compliance audit" modal. Mirrors the legacy #complianceModalOverlay:
 * only the audit date is required. Compliance area is a dropdown from the
 * compliance_area list. The checklist, corrective actions, and notes are filled
 * in later from the detail view, so this form just schedules the audit.
 */
export default function NewComplianceModal({ sites, areaOptions, onClose, onCreated }) {
  const [site, setSite] = useState(sites[0] || "");
  const [complianceArea, setComplianceArea] = useState(areaOptions[0] || "");
  const [auditDate, setAuditDate] = useState(new Date().toISOString().slice(0, 10));
  const [auditorName, setAuditorName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!auditDate) { alert("Please choose an audit date."); return; }
    setSaving(true);
    setError("");
    try {
      const c = await api("/compliance", {
        method: "POST",
        body: JSON.stringify({ site, complianceArea, auditDate, auditorName: auditorName.trim() }),
      });
      onCreated(c.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h2>New compliance audit</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field"><label>Site</label>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Compliance area</label>
              <select value={complianceArea} onChange={(e) => setComplianceArea(e.target.value)}>
                {areaOptions.map((v) => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Audit date</label>
              <input type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)} />
            </div>
            <div className="form-field"><label>Auditor</label>
              <input type="text" value={auditorName} onChange={(e) => setAuditorName(e.target.value)} placeholder="Name" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Schedule audit"}</button>
        </div>
      </div>
    </div>
  );
}
