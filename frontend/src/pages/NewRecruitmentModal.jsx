import { useState } from "react";
import { api } from "../api/client";

/**
 * "New applicant" modal. Mirrors the legacy #recruitmentModalOverlay:
 * full name and application date are required; position is a dropdown from the
 * position_title list. The rest of the hiring pipeline is filled in later from
 * the detail view, so this form just records the application.
 */
export default function NewRecruitmentModal({ sites, positionTypes, onClose, onCreated }) {
  const [fullName, setFullName] = useState("");
  const [position, setPosition] = useState(positionTypes[0] || "");
  const [site, setSite] = useState(sites[0] || "");
  const [applicationDate, setApplicationDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!fullName.trim()) { alert("Please enter the applicant's name."); return; }
    if (!applicationDate) { alert("Please choose an application date."); return; }
    setSaving(true);
    setError("");
    try {
      const a = await api("/recruitment", {
        method: "POST",
        body: JSON.stringify({ fullName: fullName.trim(), position, site, applicationDate }),
      });
      onCreated(a.id);
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
          <h2>New applicant</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field"><label>Full name</label>
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Applicant's full name" />
            </div>
            <div className="form-field"><label>Position applied for</label>
              <select value={position} onChange={(e) => setPosition(e.target.value)}>
                {positionTypes.map((v) => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Site</label>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Application date</label>
              <input type="date" value={applicationDate} onChange={(e) => setApplicationDate(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Add applicant"}</button>
        </div>
      </div>
    </div>
  );
}
