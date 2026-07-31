import { useState } from "react";
import { api, apiUpload } from "../api/client";

/**
 * "Report new incident" modal. Mirrors the legacy #incidentModalOverlay:
 * core fields + evidence/witnesses/actions/attachments staged locally,
 * then persisted in sequence once "Save incident" is pressed (the
 * incident itself must exist first since every sub-resource endpoint
 * hangs off its id).
 */
export default function NewIncidentModal({ classifications, sites, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [site, setSite] = useState(sites[0] || "");
  const [classification, setClassification] = useState(classifications[0] || "");
  const [severity, setSeverity] = useState("High");
  const [description, setDescription] = useState("");
  const [reportedBy, setReportedBy] = useState("");
  const [assigned, setAssigned] = useState("");
  const [rootCause, setRootCause] = useState("");

  const [pendingEvidence, setPendingEvidence] = useState([]);
  const [pendingWitnesses, setPendingWitnesses] = useState([]);
  const [pendingActions, setPendingActions] = useState([]);
  const [pendingAttachments, setPendingAttachments] = useState([]);

  const [evTitle, setEvTitle] = useState("");
  const [evType, setEvType] = useState("Photo");
  const [evNote, setEvNote] = useState("");
  const [evFile, setEvFile] = useState(null);

  const [witName, setWitName] = useState("");
  const [witStatement, setWitStatement] = useState("");

  const [actType, setActType] = useState("Corrective");
  const [actDesc, setActDesc] = useState("");
  const [actOwner, setActOwner] = useState("");
  const [actDue, setActDue] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function addEvidence() {
    if (!evTitle.trim()) { alert("Enter an evidence title."); return; }
    setPendingEvidence((p) => [...p, { title: evTitle.trim(), type: evType, note: evNote.trim(), file: evFile }]);
    setEvTitle(""); setEvNote(""); setEvFile(null);
    const input = document.getElementById("pev_file");
    if (input) input.value = "";
  }
  function addWitness() {
    if (!witName.trim() || !witStatement.trim()) { alert("Enter both a witness name and statement."); return; }
    setPendingWitnesses((p) => [...p, { name: witName.trim(), statement: witStatement.trim() }]);
    setWitName(""); setWitStatement("");
  }
  function addAction() {
    if (!actDesc.trim()) { alert("Enter an action description."); return; }
    setPendingActions((p) => [...p, { type: actType, description: actDesc.trim(), owner: actOwner.trim(), dueDate: actDue }]);
    setActDesc(""); setActOwner(""); setActDue("");
  }
  function addAttachments(e) {
    setPendingAttachments((p) => [...p, ...Array.from(e.target.files)]);
    e.target.value = "";
  }

  async function handleSave() {
    if (!title.trim()) { alert("Please enter an incident title."); return; }
    setSaving(true);
    setError("");
    try {
      const payload = {
        title: title.trim(), date, site, classification, severity,
        description: description.trim(), reportedBy: reportedBy.trim(),
        assigned: assigned.trim(), rootCause: rootCause.trim(),
      };
      const newIncident = await api("/incidents", { method: "POST", body: JSON.stringify(payload) });
      const incId = newIncident.id;
      const errors = [];

      for (const e of pendingEvidence) {
        try {
          await api(`/incidents/${incId}/evidence`, { method: "POST", body: JSON.stringify({ title: e.title, type: e.type, note: e.note }) });
          if (e.file) await apiUpload(`/incidents/${incId}/attachments`, e.file);
        } catch (err) { errors.push(`Evidence "${e.title}": ${err.message}`); }
      }
      for (const w of pendingWitnesses) {
        try { await api(`/incidents/${incId}/witnesses`, { method: "POST", body: JSON.stringify(w) }); }
        catch (err) { errors.push(`Witness "${w.name}": ${err.message}`); }
      }
      for (const a of pendingActions) {
        try { await api(`/incidents/${incId}/actions`, { method: "POST", body: JSON.stringify(a) }); }
        catch (err) { errors.push(`Action "${a.description}": ${err.message}`); }
      }
      for (const f of pendingAttachments) {
        try { await apiUpload(`/incidents/${incId}/attachments`, f); }
        catch (err) { errors.push(`Attachment "${f.name}": ${err.message}`); }
      }

      onCreated(incId);
      if (errors.length) alert("Incident was created, but some items could not be saved:\n\n" + errors.join("\n"));
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
          <h2>Report new incident</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>}
          <div className="form-grid">
            <div className="form-field full">
              <label>Incident title</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unauthorized access at east perimeter gate" />
            </div>
            <div className="form-field">
              <label>Date of incident</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Site / facility <span className="hint">(customizable)</span></label>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Classification <span className="hint">(customizable)</span></label>
              <select value={classification} onChange={(e) => setClassification(e.target.value)}>
                {classifications.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
              </select>
            </div>
            <div className="form-field full">
              <label>Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened, where, and how it was discovered..." />
            </div>
            <div className="form-field">
              <label>Reported by</label>
              <input type="text" value={reportedBy} onChange={(e) => setReportedBy(e.target.value)} placeholder="Name" />
            </div>
            <div className="form-field">
              <label>Assigned investigator</label>
              <input type="text" value={assigned} onChange={(e) => setAssigned(e.target.value)} placeholder="Name" />
            </div>
            <div className="form-field full">
              <label>Root cause <span className="hint">(optional at this stage)</span></label>
              <textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="Document the underlying cause, if already known..." />
            </div>
          </div>

          <div className="section-divider">Evidence</div>
          <div className="entry-list">
            {pendingEvidence.map((e, idx) => (
              <div className="entry-card" key={idx}>
                <div className="entry-top">
                  <div>
                    <div className="entry-title">{e.title}</div>
                    <div className="entry-meta">{e.type}{e.file ? " · " + e.file.name : ""}</div>
                  </div>
                  <button type="button" className="entry-remove" onClick={() => setPendingEvidence((p) => p.filter((_, i) => i !== idx))}>Remove</button>
                </div>
                {e.note && <div className="entry-body">{e.note}</div>}
              </div>
            ))}
          </div>
          <div className="add-row">
            <div className="form-field"><label>Title</label><input type="text" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="e.g. CCTV clip - Camera 3" /></div>
            <div className="form-field"><label>Type</label>
              <select value={evType} onChange={(e) => setEvType(e.target.value)}>
                <option>Photo</option><option>Video</option><option>Document</option><option>Physical item</option><option>Other</option>
              </select>
            </div>
            <div className="form-field" style={{ flex: 2 }}><label>Notes</label><input type="text" value={evNote} onChange={(e) => setEvNote(e.target.value)} placeholder="Optional description" /></div>
            <div className="form-field"><label>File <span className="hint">(optional)</span></label>
              <input type="file" id="pev_file" accept="image/*,application/pdf,.doc,.docx,.txt" onChange={(e) => setEvFile(e.target.files[0] || null)} />
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={addEvidence}>Add</button>
          </div>

          <div className="section-divider">Witnesses</div>
          <div className="entry-list">
            {pendingWitnesses.map((w, idx) => (
              <div className="entry-card" key={idx}>
                <div className="entry-top">
                  <div className="entry-title">{w.name}</div>
                  <button type="button" className="entry-remove" onClick={() => setPendingWitnesses((p) => p.filter((_, i) => i !== idx))}>Remove</button>
                </div>
                <div className="entry-body">{w.statement}</div>
              </div>
            ))}
          </div>
          <div className="add-row">
            <div className="form-field"><label>Witness name</label><input type="text" value={witName} onChange={(e) => setWitName(e.target.value)} placeholder="Name or role" /></div>
            <div className="form-field" style={{ flex: 2 }}><label>Statement</label><input type="text" value={witStatement} onChange={(e) => setWitStatement(e.target.value)} placeholder="What they observed" /></div>
            <button type="button" className="btn btn-primary btn-sm" onClick={addWitness}>Add</button>
          </div>

          <div className="section-divider">Corrective / Preventive Actions</div>
          <div className="entry-list">
            {pendingActions.map((a, idx) => (
              <div className="entry-card" key={idx}>
                <div className="entry-top">
                  <div>
                    <div className="entry-title">{a.description}</div>
                    <div className="entry-meta">{a.type} · Owner: {a.owner || "—"} · Due: {a.dueDate || "—"}</div>
                  </div>
                  <button type="button" className="entry-remove" onClick={() => setPendingActions((p) => p.filter((_, i) => i !== idx))}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="add-row">
            <div className="form-field"><label>Type</label>
              <select value={actType} onChange={(e) => setActType(e.target.value)}>
                <option>Corrective</option><option>Preventive</option>
              </select>
            </div>
            <div className="form-field" style={{ flex: 2 }}><label>Description</label><input type="text" value={actDesc} onChange={(e) => setActDesc(e.target.value)} placeholder="Action to be taken" /></div>
            <div className="form-field"><label>Owner</label><input type="text" value={actOwner} onChange={(e) => setActOwner(e.target.value)} placeholder="Assigned to" /></div>
            <div className="form-field"><label>Due date</label><input type="date" value={actDue} onChange={(e) => setActDue(e.target.value)} /></div>
            <button type="button" className="btn btn-primary btn-sm" onClick={addAction}>Add</button>
          </div>

          <div className="section-divider">Attachments</div>
          <div className="attach-grid">
            {pendingAttachments.map((f, idx) => (
              <div className="attach-card" key={idx}>
                {/^image\//.test(f.type)
                  ? <img className="attach-thumb" src={URL.createObjectURL(f)} alt={f.name} />
                  : <div className="attach-icon">📎</div>}
                <div className="attach-name" title={f.name}>{f.name}</div>
                <div className="attach-meta">{(f.size / 1024).toFixed(0)} KB</div>
                <button type="button" className="attach-remove" title="Remove" onClick={() => setPendingAttachments((p) => p.filter((_, i) => i !== idx))}>&times;</button>
              </div>
            ))}
          </div>
          <label className="upload-drop" htmlFor="pendingAttachInput">
            <div>Click to add photos or documents</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB each · multiple allowed</div>
          </label>
          <input type="file" id="pendingAttachInput" style={{ display: "none" }} multiple accept="image/*,application/pdf,.doc,.docx,.txt" onChange={addAttachments} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving\u2026" : "Save incident"}</button>
        </div>
      </div>
    </div>
  );
}
