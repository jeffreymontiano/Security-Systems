import { useState } from "react";
import { api } from "../api/client";

/**
 * "New training record" modal. Mirrors the legacy #trainingModalOverlay:
 * employee name and scheduled date are required; course is a dropdown from the
 * training_type list. Attendance, exam, and certification details are filled in
 * later from the detail view, so this form just assigns the training.
 */
export default function NewTrainingModal({ sites, courseTypes, onClose, onCreated }) {
  const [employeeName, setEmployeeName] = useState("");
  const [site, setSite] = useState(sites[0] || "");
  const [courseName, setCourseName] = useState(courseTypes[0] || "");
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!employeeName.trim()) { alert("Please enter the employee's name."); return; }
    if (!scheduledDate) { alert("Please choose a scheduled date."); return; }
    setSaving(true);
    setError("");
    try {
      const c = await api("/training", {
        method: "POST",
        body: JSON.stringify({ employeeName: employeeName.trim(), site, courseName, scheduledDate }),
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
          <h2>New training record</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field"><label>Employee name</label>
              <input type="text" value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-field"><label>Site</label>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Course / training</label>
              <select value={courseName} onChange={(e) => setCourseName(e.target.value)}>
                {courseTypes.map((v) => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Scheduled date</label>
              <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Assign training"}</button>
        </div>
      </div>
    </div>
  );
}
