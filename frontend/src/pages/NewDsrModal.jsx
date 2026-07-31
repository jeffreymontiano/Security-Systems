import { useState } from "react";
import { api } from "../api/client";
import { DSR_TEXT_FIELDS } from "./dsrShared";

/**
 * "Create Daily Security Report" modal. Mirrors the legacy #dsrModalOverlay:
 * date is required, site/shift are chosen here (they can't be edited later —
 * only the body fields and submittedBy are editable in the detail view), and
 * the report is always created in Draft status. On success the parent opens
 * the new report's detail view.
 */
export default function NewDsrModal({ sites, onClose, onCreated }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [site, setSite] = useState(sites[0] || "");
  const [shift, setShift] = useState("Day Shift");
  const [submittedBy, setSubmittedBy] = useState("");
  const [body, setBody] = useState(() =>
    Object.fromEntries(DSR_TEXT_FIELDS.map((f) => [f.key, ""]))
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setField(key, value) {
    setBody((b) => ({ ...b, [key]: value }));
  }

  async function handleSave() {
    if (!date) { alert("Please choose a date."); return; }
    setSaving(true);
    setError("");
    try {
      const payload = {
        date, site, shift, submittedBy: submittedBy.trim(),
        ...Object.fromEntries(DSR_TEXT_FIELDS.map((f) => [f.key, (body[f.key] || "").trim()])),
      };
      const report = await api("/dsr", { method: "POST", body: JSON.stringify(payload) });
      onCreated(report.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2>Create Daily Security Report</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="form-field"><label>Site</label>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Shift</label>
              <select value={shift} onChange={(e) => setShift(e.target.value)}>
                <option>Day Shift</option><option>Night Shift</option>
              </select>
            </div>
            <div className="form-field"><label>Submitted by</label>
              <input type="text" value={submittedBy} onChange={(e) => setSubmittedBy(e.target.value)} placeholder="Guard / shift supervisor name" />
            </div>
            {DSR_TEXT_FIELDS.map((f) => (
              <div className={`form-field${f.full ? " full" : ""}`} key={f.key}>
                <label>{f.label}</label>
                <textarea value={body[f.key]} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.placeholder} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Save as draft"}</button>
        </div>
      </div>
    </div>
  );
}
