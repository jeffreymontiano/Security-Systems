import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { CA_STAGES, caStatusBadgeClass, compliantBadgeClass } from "./complianceShared";

/**
 * Compliance audit detail modal. Mirrors #complianceDetailModalOverlay:
 * a workflow stepper (Scheduled → In Progress → Completed → Cancelled) plus a
 * tabbed body — Compliance Checklist, Corrective Actions, Attachments, Notes.
 *
 * The audit overview (site/area/auditor/date) is set at creation; here the user
 * edits Notes and manages the two child collections. Both collections support
 * inline add / edit (Save) / remove. The audit score is computed server-side
 * (% "Yes" of Yes+No items, N/A excluded) and refreshes after every checklist
 * change. Editable for any non-Viewer (no stage lock).
 */
export default function ComplianceDetailModal({ auditId, isViewer, isAdmin, correctiveStatuses, onClose, onChanged, onDeleted }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("checklist");
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  // Notes draft + per-row edit drafts.
  const [notesDraft, setNotesDraft] = useState("");
  const [itemEdits, setItemEdits] = useState({});
  const [actionEdits, setActionEdits] = useState({});

  // Add-row drafts.
  const [newItem, setNewItem] = useState({ itemText: "", compliant: "N/A", notes: "" });
  const [newAction, setNewAction] = useState({ description: "", owner: "", dueDate: "" });

  const statusOptions = correctiveStatuses.length ? correctiveStatuses : ["Pending", "In Progress", "Completed"];

  const load = useCallback(async () => {
    try {
      const data = await api(`/compliance/${auditId}`);
      setC(data);
      setNotesDraft(data.notes || "");
      const ie = {};
      data.checklist.forEach((it) => { ie[it.id] = { itemText: it.itemText, compliant: it.compliant, notes: it.notes || "" }; });
      setItemEdits(ie);
      const ae = {};
      data.correctiveActions.forEach((a) => { ae[a.id] = { description: a.description, status: a.status }; });
      setActionEdits(ae);
    } catch (e) {
      setError(e.message);
    }
  }, [auditId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!c) return;
    let cancelled = false;
    c.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/compliance/${c.id}/attachments/${a.id}`).then((url) => {
        if (!cancelled) setThumbs((t) => ({ ...t, [a.id]: url }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.attachments]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  const editable = !isViewer;

  // --- Stage / notes / delete ---
  async function setStage(stage) {
    await guard(async () => {
      await api(`/compliance/${auditId}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      await reload();
    });
  }
  async function saveNotes() {
    await guard(async () => {
      await api(`/compliance/${auditId}`, { method: "PATCH", body: JSON.stringify({ notes: notesDraft.trim() }) });
      await reload();
      alert("Notes saved.");
    });
  }
  async function deleteAudit() {
    if (!confirm("Delete this audit permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/compliance/${auditId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  // --- Checklist ---
  async function addItem() {
    if (!newItem.itemText.trim()) { alert("Enter a checklist item."); return; }
    await guard(async () => {
      await api(`/compliance/${auditId}/checklist`, {
        method: "POST",
        body: JSON.stringify({ itemText: newItem.itemText.trim(), compliant: newItem.compliant, notes: newItem.notes.trim() }),
      });
      setNewItem({ itemText: "", compliant: "N/A", notes: "" });
      await reload();
    });
  }
  async function saveItem(itemId) {
    const d = itemEdits[itemId];
    if (!d || !d.itemText.trim()) { alert("Checklist item text is required."); return; }
    await guard(async () => {
      await api(`/compliance/${auditId}/checklist/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ itemText: d.itemText.trim(), compliant: d.compliant, notes: d.notes.trim() }),
      });
      await reload();
    });
  }
  async function removeItem(itemId) {
    await guard(async () => {
      await api(`/compliance/${auditId}/checklist/${itemId}`, { method: "DELETE" });
      await reload();
    });
  }

  // --- Corrective actions ---
  async function addAction() {
    if (!newAction.description.trim()) { alert("Enter an action description."); return; }
    await guard(async () => {
      await api(`/compliance/${auditId}/actions`, {
        method: "POST",
        body: JSON.stringify({ description: newAction.description.trim(), owner: newAction.owner.trim(), dueDate: newAction.dueDate || null }),
      });
      setNewAction({ description: "", owner: "", dueDate: "" });
      await reload();
    });
  }
  async function saveAction(actionId) {
    const d = actionEdits[actionId];
    if (!d || !d.description.trim()) { alert("Description cannot be empty."); return; }
    await guard(async () => {
      await api(`/compliance/${auditId}/actions/${actionId}`, {
        method: "PATCH",
        body: JSON.stringify({ description: d.description.trim(), status: d.status }),
      });
      await reload();
    });
  }
  async function removeAction(actionId) {
    await guard(async () => {
      await api(`/compliance/${auditId}/actions/${actionId}`, { method: "DELETE" });
      await reload();
    });
  }

  // --- Attachments ---
  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/compliance/${auditId}/attachments`, file);
      await reload();
    });
  }
  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/compliance/${auditId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }
  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/compliance/${auditId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }
  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/compliance/${auditId}/report.pdf`);
      downloadBlobUrl(url, `${c.code}-compliance-audit.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Compliance Audit</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">{error}</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Compliance Audit</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const stageIdx = CA_STAGES.indexOf(c.status);
  const tabBtn = (name, label) => (
    <button className={`tab-btn ${tab === name ? "active" : ""}`} onClick={() => setTab(name)}>{label}</button>
  );

  return (
    <div className="modal-overlay active">
      <div className="modal">
        <div className="modal-header">
          <h2>{c.code} — {c.site || "Audit"}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="stepper">
            {CA_STAGES.map((s, idx) => {
              let cls = "";
              if (idx < stageIdx) cls = "done";
              else if (idx === stageIdx) cls = "current";
              return (
                <div
                  className={`step ${cls}`}
                  key={s}
                  onClick={editable ? () => setStage(s) : undefined}
                  title={`Set status to ${s}`}
                  style={editable ? undefined : { cursor: "default" }}
                >
                  <div className="step-line"></div>
                  <div className="step-dot">{idx < stageIdx ? "\u2713" : idx + 1}</div>
                  <div className="step-label">{s}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "16px 0" }}>
            <span className={`badge ${caStatusBadgeClass(c.status)}`}>{c.status}</span>
            <span className="chip">{c.complianceArea || "—"}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Auditor: {c.auditorName || "—"}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Audit date: {c.auditDate}</span>
            {c.score !== null && c.score !== undefined && (
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>Audit score: {c.score}%</span>
            )}
          </div>

          <div className="tabs">
            {tabBtn("checklist", `Compliance Checklist (${c.checklist.length})`)}
            {tabBtn("actions", `Corrective Actions (${c.correctiveActions.length})`)}
            {tabBtn("attachments", `Attachments (${c.attachments.length})`)}
            {tabBtn("notes", "Notes")}
          </div>

          {tab === "checklist" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {c.checklist.length ? c.checklist.map((item) => {
                  const d = itemEdits[item.id] || { itemText: item.itemText, compliant: item.compliant, notes: item.notes || "" };
                  return (
                    <div className="entry-card" key={item.id}>
                      <div className="entry-top" style={{ alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {editable ? (
                            <>
                              <input type="text" className="entry-edit-input" style={{ width: "100%", fontWeight: 700, marginBottom: 4 }}
                                value={d.itemText} onChange={(e) => setItemEdits((p) => ({ ...p, [item.id]: { ...d, itemText: e.target.value } }))} />
                              <input type="text" className="entry-edit-input" style={{ width: "100%", fontSize: 12 }} placeholder="Notes"
                                value={d.notes} onChange={(e) => setItemEdits((p) => ({ ...p, [item.id]: { ...d, notes: e.target.value } }))} />
                            </>
                          ) : (
                            <>
                              <div className="entry-title">{item.itemText}</div>
                              {item.notes && <div className="entry-meta">{item.notes}</div>}
                            </>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          {editable ? (
                            <select value={d.compliant} onChange={(e) => setItemEdits((p) => ({ ...p, [item.id]: { ...d, compliant: e.target.value } }))}>
                              <option>Yes</option><option>No</option><option>N/A</option>
                            </select>
                          ) : (
                            <span className={`badge ${compliantBadgeClass(item.compliant)}`}>{item.compliant}</span>
                          )}
                          {editable && <button className="btn btn-secondary btn-sm" onClick={() => saveItem(item.id)}>Save</button>}
                          {editable && <button className="entry-remove" onClick={() => removeItem(item.id)}>Remove</button>}
                        </div>
                      </div>
                    </div>
                  );
                }) : <div className="empty-hint">No checklist items yet.</div>}
              </div>
              {editable && (
                <div className="add-row">
                  <div className="form-field" style={{ flex: 2 }}><label>Checklist item</label>
                    <input type="text" value={newItem.itemText} onChange={(e) => setNewItem((p) => ({ ...p, itemText: e.target.value }))} placeholder="e.g. Guard in proper uniform" />
                  </div>
                  <div className="form-field"><label>Compliant</label>
                    <select value={newItem.compliant} onChange={(e) => setNewItem((p) => ({ ...p, compliant: e.target.value }))}>
                      <option>Yes</option><option>No</option><option>N/A</option>
                    </select>
                  </div>
                  <div className="form-field" style={{ flex: 2 }}><label>Notes</label>
                    <input type="text" value={newItem.notes} onChange={(e) => setNewItem((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional" />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addItem}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "actions" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {c.correctiveActions.length ? c.correctiveActions.map((act) => {
                  const d = actionEdits[act.id] || { description: act.description, status: act.status };
                  return (
                    <div className="entry-card" key={act.id}>
                      <div className="entry-top" style={{ alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {editable ? (
                            <input type="text" className="entry-edit-input" style={{ width: "100%", fontWeight: 700, marginBottom: 4 }}
                              value={d.description} onChange={(e) => setActionEdits((p) => ({ ...p, [act.id]: { ...d, description: e.target.value } }))} />
                          ) : (
                            <div className="entry-title">{act.description}</div>
                          )}
                          <div className="entry-meta">Owner: {act.owner || "—"} · Due: {act.dueDate || "—"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          {editable ? (
                            <select value={d.status} onChange={(e) => setActionEdits((p) => ({ ...p, [act.id]: { ...d, status: e.target.value } }))}>
                              {!statusOptions.includes(d.status) && d.status ? <option>{d.status}</option> : null}
                              {statusOptions.map((s) => <option key={s}>{s}</option>)}
                            </select>
                          ) : (
                            <span className={`badge ${act.status === "Completed" ? "badge-resolved" : "badge-progress"}`}>{act.status}</span>
                          )}
                          {editable && <button className="btn btn-secondary btn-sm" onClick={() => saveAction(act.id)}>Save</button>}
                          {editable && <button className="entry-remove" onClick={() => removeAction(act.id)}>Remove</button>}
                        </div>
                      </div>
                    </div>
                  );
                }) : <div className="empty-hint">No corrective actions logged yet.</div>}
              </div>
              {editable && (
                <div className="add-row">
                  <div className="form-field" style={{ flex: 2 }}><label>Description</label>
                    <input type="text" value={newAction.description} onChange={(e) => setNewAction((p) => ({ ...p, description: e.target.value }))} placeholder="Action to be taken" />
                  </div>
                  <div className="form-field"><label>Owner</label>
                    <input type="text" value={newAction.owner} onChange={(e) => setNewAction((p) => ({ ...p, owner: e.target.value }))} placeholder="Assigned to" />
                  </div>
                  <div className="form-field"><label>Due date</label>
                    <input type="date" value={newAction.dueDate} onChange={(e) => setNewAction((p) => ({ ...p, dueDate: e.target.value }))} />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addAction}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "attachments" && (
            <div className="tab-pane active">
              <div className="attach-grid">
                {c.attachments.map((a) => (
                  <div className="attach-card" key={a.id}>
                    {/^image\//.test(a.mimetype)
                      ? <img className="attach-thumb" src={thumbs[a.id]} alt={a.filename} onClick={() => viewAttachment(a.id)} />
                      : <div className="attach-icon" onClick={() => viewAttachment(a.id)}>{fileIcon(a.mimetype)}</div>}
                    <div className="attach-name" title={a.filename}>{a.filename}</div>
                    <div className="attach-meta">{(a.size / 1024).toFixed(0)} KB</div>
                    {!isViewer && <button className="attach-remove" title="Remove" onClick={() => removeAttachment(a.id)}>&times;</button>}
                  </div>
                ))}
              </div>
              {c.attachments.length === 0 && <div className="empty-hint">No photos or documents attached yet.</div>}
              {editable && (
                <>
                  <label className="upload-drop" htmlFor="caAttachFileInput">
                    <div>Click to upload a photo or document</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
                  </label>
                  <input type="file" id="caAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
                </>
              )}
            </div>
          )}

          {tab === "notes" && (
            <div className="tab-pane active">
              <div className="form-field full">
                <label>Audit notes</label>
                {editable
                  ? <textarea style={{ minHeight: 120 }} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} />
                  : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c.notes || "") || "—"}</div>}
              </div>
              {editable && <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveNotes}>Save notes</button>}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          <div style={{ flex: 1 }}></div>
          {isAdmin && <button className="btn btn-danger" onClick={deleteAudit} disabled={busy}>Delete audit</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
