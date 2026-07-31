import { useState } from "react";
import { api } from "../api/client";

/**
 * "New performance appraisal" modal. Mirrors the legacy #performanceModalOverlay:
 * employee name and evaluation date are required. KPI scores and the rest of the
 * evaluation are filled in later from the detail view, so this form just opens a
 * Draft appraisal.
 */
export default function NewPerformanceModal({ sites, onClose, onCreated }) {
  const [employeeName, setEmployeeName] = useState("");
  const [site, setSite] = useState(sites[0] || "");
  const [evaluationDate, setEvaluationDate] = useState(new Date().toISOString().slice(0, 10));
  const [evaluatorName, setEvaluatorName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!employeeName.trim()) { alert("Please enter the employee's name."); return; }
    if (!evaluationDate) { alert("Please choose an evaluation date."); return; }
    setSaving(true);
    setError("");
    try {
      const c = await api("/performance", {
        method: "POST",
        body: JSON.stringify({
          employeeName: employeeName.trim(), site, evaluationDate,
          evaluatorName: evaluatorName.trim(),
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
          <h2>New performance appraisal</h2>
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
            <div className="form-field"><label>Evaluation date</label>
              <input type="date" value={evaluationDate} onChange={(e) => setEvaluationDate(e.target.value)} />
            </div>
            <div className="form-field"><label>Evaluator (Supervisor / Operation Officer)</label>
              <input type="text" value={evaluatorName} onChange={(e) => setEvaluatorName(e.target.value)} placeholder="Name" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Open appraisal"}</button>
        </div>
      </div>
    </div>
  );
}
