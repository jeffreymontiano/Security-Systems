import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * "New disciplinary case" modal. Mirrors the legacy #disciplinaryModalOverlay:
 * employee name and violation date are required; violation type is a dropdown
 * from the violation_type list. The rest of the HR workflow (NTE, explanation,
 * hearing, penalty, attachments) is filled in later from the detail view, so
 * this form is deliberately minimal — it just opens the case.
 */
export default function NewDisciplinaryModal({ sites, violationTypes, onClose, onCreated }) {
  // Picked from the 201 File rather than typed. A misspelled name tied a case
  // to nobody, so the case could not be found from the employee's record.
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  useEffect(() => {
    // Active only, the same filter the Duty Detail Order's guard picker uses:
    // a disciplinary case is opened against someone currently employed.
    api("/employees")
      .then((rows) => setEmployees(rows.filter((e) => e.employmentStatus === "Active")))
      .catch(() => setEmployees([]));
  }, []);
  const [site, setSite] = useState(sites[0] || "");
  const [violationType, setViolationType] = useState(violationTypes[0] || "");
  const [violationDate, setViolationDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    const picked = employees.find((e) => String(e.id) === String(employeeId));
    if (!picked) { setError("Please choose the employee this case is against."); return; }
    if (!violationDate) { alert("Please choose a violation date."); return; }
    setSaving(true);
    setError("");
    try {
      const c = await api("/disciplinary", {
        method: "POST",
        body: JSON.stringify({
          // Both are sent: the id links the case to the register, the NAME is
          // a snapshot so the case keeps printing who it was raised against
          // even if that record is later corrected.
          employeeName: picked.fullName, employeeId: picked.id,
          site, violationType, violationDate,
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
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Select an employee…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}{e.employeeNo ? ` — ${e.employeeNo}` : ""}
                  </option>
                ))}
              </select>
              {employees.length === 0 && (
                <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                  No active employees found in the Employee Master File.
                </div>
              )}
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
