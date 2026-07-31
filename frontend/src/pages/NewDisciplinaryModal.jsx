import { useState } from "react";
import { api } from "../api/client";

/**
 * "New disciplinary case" modal. Mirrors the legacy #disciplinaryModalOverlay:
 * employee name and violation date are required; violation type is a dropdown
 * from the violation_type list. The rest of the HR workflow (NTE, explanation,
 * hearing, penalty, attachments) is filled in later from the detail view, so
 * this form is deliberately minimal — it just opens the case.
 */
export default function NewDisciplinaryModal({ sites, violationTypes, onClose, onCreated }) {
  const [employeeName, setEmployeeName] = useState("");
  const [site, setSite] = useState(sites[0] || "");
  const [violationType, setViolationType] = useState(violationTypes[0] || "");
  const [violationDate, setViolationDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!employeeName.trim()) { alert("Please enter the employee's name."); return; }
    if (!violationDate) { alert("Please choose a violation date."); return; }
    setSaving(true);
    setError("");
    try {
      const c = await api("/disciplinary", {
        method: "POST",
        body: JSON.stringify({
          employeeName: employeeName.trim(), site, violationType, violationDate,
          description: description.trim(),
        }),
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
          <h2>New disciplinary case</h2>
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
            <div className="form-field"><label>Violation type</label>
              <select value={violationType} onChange={(e) => setViolationType(e.target.value)}>
                {violationTypes.map((v) => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Violation date</label>
              <input type="date" value={violationDate} onChange={(e) => setViolationDate(e.target.value)} />
            </div>
            <div className="form-field full"><label>Violation description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened..." />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Open case"}</button>
        </div>
      </div>
    </div>
  );
}
