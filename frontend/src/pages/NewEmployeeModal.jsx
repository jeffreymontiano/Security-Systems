import { useState } from "react";
import { api } from "../api/client";
import { EMPLOYMENT_STATUSES } from "./employeeShared";

// Create form for a new 201 record. Only full name is required; everything else
// can be filled in later from the detail view. Mirrors NewIncidentModal's
// structure (controlled fields, single submit, error surface).
export default function NewEmployeeModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    employeeNo: "", fullName: "", position: "", site: "", dateHired: "",
    employmentStatus: "Active", contactNumber: "", email: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!form.fullName.trim()) { setError("Full name is required."); return; }
    setSaving(true);
    setError("");
    try {
      const created = await api("/employees", { method: "POST", body: JSON.stringify(form) });
      onCreated(created.id);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New employee</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label>Full name <span style={{ color: "var(--red)" }}>*</span></label>
              <input type="text" value={form.fullName} onChange={set("fullName")} placeholder="Juan Dela Cruz" />
            </div>
            <div className="form-field">
              <label>Employee number</label>
              <input type="text" value={form.employeeNo} onChange={set("employeeNo")} placeholder="e.g. 2024-0142" />
            </div>
            <div className="form-field">
              <label>Position</label>
              <input type="text" value={form.position} onChange={set("position")} placeholder="Security Guard" />
            </div>
            <div className="form-field">
              <label>Site / detachment</label>
              <input type="text" value={form.site} onChange={set("site")} placeholder="BFC" />
            </div>
            <div className="form-field">
              <label>Date hired</label>
              <input type="date" value={form.dateHired} onChange={set("dateHired")} />
            </div>
            <div className="form-field">
              <label>Employment status</label>
              <select value={form.employmentStatus} onChange={set("employmentStatus")}>
                {EMPLOYMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Contact number</label>
              <input type="text" value={form.contactNumber} onChange={set("contactNumber")} placeholder="09XX XXX XXXX" />
            </div>
            <div className="form-field">
              <label>Email</label>
              <input type="text" value={form.email} onChange={set("email")} placeholder="name@example.com" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving\u2026" : "Create employee"}</button>
        </div>
      </div>
    </div>
  );
}
