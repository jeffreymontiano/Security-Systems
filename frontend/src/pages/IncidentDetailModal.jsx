import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { WORKFLOW_STAGES, daysBetween, sevBadgeClass, fileIcon, auditLabel } from "./incidentShared";

/**
 * Full incident detail modal: workflow stepper + tabs (Overview, Root cause,
 * Evidence, Witnesses, CAPA, Attachments, Activity log). Mirrors the legacy
 * #detailModalOverlay 1:1 against the same backend endpoints. Re-fetches the
 * single incident after every mutation (rather than the whole list) and
 * calls onChanged() so the parent table/counts stay in sync.
 */
export default function IncidentDetailModal({ incidentId, isViewer, isAdmin, onClose, onChanged, onDeleted }) {
  const [inc, setInc] = useState(null);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");

  const [rootCauseDraft, setRootCauseDraft] = useState("");

  const [evTitle, setEvTitle] = useState("");
  const [evType, setEvType] = useState("Photo");
  const [evNote, setEvNote] = useState("");

  const [witName, setWitName] = useState("");
  const [witStatement, setWitStatement] = useState("");

  const [actType, setActType] = useState("Corrective");
  const [actDesc, setActDesc] = useState("");
  const [actOwner, setActOwner] = useState("");
  const [actDue, setActDue] = useState("");
  const [actStatus, setActStatus] = useState("Pending");
  const [actionEdits, setActionEdits] = useState({});

  const [thumbs, setThumbs] = useState({});
  const [auditRows, setAuditRows] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/incidents/${incidentId}`);
      setInc(data);
      setRootCauseDraft(data.rootCause || "");
      const edits = {};
      data.actions.forEach((a) => { edits[a.id] = { description: a.description, status: a.status }; });
      setActionEdits(edits);
    } catch (e) {
      setError(e.message);
    }
  }, [incidentId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (tab === "activity") {
      setAuditRows(null);
      api(`/incidents/${incidentId}/audit`).then(setAuditRows).catch(() => setAuditRows([]));
    }
  }, [tab, incidentId]);

  useEffect(() => {
    if (!inc) return;
    let cancelled = false;
    inc.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/incidents/${inc.id}/attachments/${a.id}`).then((url) => {
        if (!cancelled) setThumbs((t) => ({ ...t, [a.id]: url }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inc?.attachments]);

  async function withErrorHandling(fn) {
    try { await fn(); } catch (e) { alert(e.message); }
  }

  async function setStage(stage) {
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      await reload();
    });
  }

  async function saveRootCause() {
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}`, { method: "PATCH", body: JSON.stringify({ rootCause: rootCauseDraft.trim() }) });
      await reload();
      alert("Root cause saved.");
    });
  }

  async function addEvidence() {
    if (!evTitle.trim()) { alert("Enter an evidence title."); return; }
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/evidence`, { method: "POST", body: JSON.stringify({ title: evTitle.trim(), type: evType, note: evNote.trim() }) });
      setEvTitle(""); setEvNote("");
      await reload();
    });
  }

  async function addWitness() {
    if (!witName.trim() || !witStatement.trim()) { alert("Enter both a witness name and statement."); return; }
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/witnesses`, { method: "POST", body: JSON.stringify({ name: witName.trim(), statement: witStatement.trim() }) });
      setWitName(""); setWitStatement("");
      await reload();
    });
  }

  async function addAction() {
    if (!actDesc.trim()) { alert("Enter an action description."); return; }
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: actType, description: actDesc.trim(), owner: actOwner.trim(), dueDate: actDue, status: actStatus }),
      });
      setActDesc(""); setActOwner(""); setActDue("");
      await reload();
    });
  }

  async function saveActionEdit(actionId) {
    const edit = actionEdits[actionId];
    if (!edit || !edit.description.trim()) { alert("Description cannot be empty."); return; }
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/actions/${actionId}`, {
        method: "PATCH",
        body: JSON.stringify({ description: edit.description.trim(), status: edit.status }),
      });
      await reload();
    });
  }

  async function removeEntry(listName, id) {
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/${listName}/${id}`, { method: "DELETE" });
      await reload();
    });
  }

  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await withErrorHandling(async () => {
      await apiUpload(`/incidents/${incidentId}/attachments`, file);
      await reload();
    });
  }

  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }

  async function viewAttachment(attId) {
    await withErrorHandling(async () => {
      const url = await apiBlobUrl(`/incidents/${incidentId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }

  async function downloadReport() {
    await withErrorHandling(async () => {
      const url = await apiBlobUrl(`/incidents/${incidentId}/report.pdf`);
      downloadBlobUrl(url, `${incidentId}-incident-report.pdf`);
    });
  }

  async function deleteIncident() {
    if (!confirm("Delete this incident permanently? This cannot be undone.")) return;
    await withErrorHandling(async () => {
      await api(`/incidents/${incidentId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Incident detail</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">{error}</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  if (!inc) return null;

  const stageIdx = WORKFLOW_STAGES.indexOf(inc.status);
  const tabBtn = (name, label) => (
    <button className={`tab-btn ${tab === name ? "active" : ""}`} onClick={() => setTab(name)}>{label}</button>
  );

  return (
    <div className="modal-overlay active">
      <div className="modal">
        <div className="modal-header">
          <h2>{inc.id} — {inc.title}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="stepper">
            {WORKFLOW_STAGES.map((s, idx) => {
              let cls = "";
              if (idx < stageIdx) cls = "done";
              else if (idx === stageIdx) cls = "current";
              return (
                <div
                  className={`step ${cls}`}
                  key={s}
                  onClick={isViewer ? undefined : () => setStage(s)}
                  title={`Set status to ${s}`}
                  style={isViewer ? { cursor: "default" } : undefined}
                >
                  <div className="step-line"></div>
                  <div className="step-dot">{idx < stageIdx ? "\u2713" : idx + 1}</div>
                  <div className="step-label">{s}</div>
                </div>
              );
            })}
          </div>

          <div className="tabs">
            {tabBtn("overview", "Overview")}
            {tabBtn("investigation", "Root cause")}
            {tabBtn("evidence", `Evidence (${inc.evidence.length})`)}
            {tabBtn("witnesses", `Witness statements (${inc.witnesses.length})`)}
            {tabBtn("actions", `Corrective actions / CAPA (${inc.actions.length})`)}
            {tabBtn("attachments", `Attachments (${inc.attachments.length})`)}
            {tabBtn("activity", "Activity log")}
          </div>

          {tab === "overview" && (
            <div className="tab-pane active">
              <div className="form-grid">
                <div className="form-field"><label>Site</label><div>{inc.site}</div></div>
                <div className="form-field"><label>Classification</label><div><span className="chip">{inc.classification}</span></div></div>
                <div className="form-field"><label>Date reported</label><div>{inc.date}</div></div>
                <div className="form-field"><label>Severity</label><div><span className={`badge ${sevBadgeClass(inc.severity)}`}>{inc.severity}</span></div></div>
                <div className="form-field"><label>Reported by</label><div>{inc.reportedBy || "\u2014"}</div></div>
                <div className="form-field"><label>Assigned investigator</label><div>{inc.assigned || "\u2014"}</div></div>
                <div className="form-field full"><label>Description</label><div style={{ whiteSpace: "pre-wrap" }}>{inc.description || "\u2014"}</div></div>
                {inc.resolvedDate && (
                  <div className="form-field"><label>Resolved date</label><div>{inc.resolvedDate} ({daysBetween(inc.date, inc.resolvedDate)} days)</div></div>
                )}
              </div>
            </div>
          )}

          {tab === "investigation" && (
            <div className="tab-pane active">
              <div className="form-field full">
                <label>Root cause analysis</label>
                <textarea
                  style={{ minHeight: 120 }}
                  readOnly={isViewer}
                  value={rootCauseDraft}
                  onChange={(e) => setRootCauseDraft(e.target.value)}
                  placeholder="Document the underlying cause of this incident..."
                />
              </div>
              {!isViewer && <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveRootCause}>Save root cause</button>}
            </div>
          )}

          {tab === "evidence" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {inc.evidence.length ? inc.evidence.map((e) => (
                  <div className="entry-card" key={e.id}>
                    <div className="entry-top">
                      <div>
                        <div className="entry-title">{e.title}</div>
                        <div className="entry-meta">{e.type}</div>
                      </div>
                      {!isViewer && <button className="entry-remove" onClick={() => removeEntry("evidence", e.id)}>Remove</button>}
                    </div>
                    {e.note && <div className="entry-body">{e.note}</div>}
                  </div>
                )) : <div className="empty-hint">No evidence logged yet.</div>}
              </div>
              {!isViewer && (
                <div className="add-row">
                  <div className="form-field"><label>Title</label><input type="text" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="e.g. CCTV clip - Camera 3" /></div>
                  <div className="form-field"><label>Type</label>
                    <select value={evType} onChange={(e) => setEvType(e.target.value)}>
                      <option>Photo</option><option>Video</option><option>Document</option><option>Physical item</option><option>Other</option>
                    </select>
                  </div>
                  <div className="form-field" style={{ flex: 2 }}><label>Notes</label><input type="text" value={evNote} onChange={(e) => setEvNote(e.target.value)} placeholder="Optional description or chain-of-custody note" /></div>
                  <button className="btn btn-primary btn-sm" onClick={addEvidence}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "witnesses" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {inc.witnesses.length ? inc.witnesses.map((w) => (
                  <div className="entry-card" key={w.id}>
                    <div className="entry-top">
                      <div className="entry-title">{w.name}</div>
                      {!isViewer && <button className="entry-remove" onClick={() => removeEntry("witnesses", w.id)}>Remove</button>}
                    </div>
                    <div className="entry-body">{w.statement}</div>
                  </div>
                )) : <div className="empty-hint">No witness statements recorded yet.</div>}
              </div>
              {!isViewer && (
                <>
                  <div className="add-row">
                    <div className="form-field"><label>Witness name</label><input type="text" value={witName} onChange={(e) => setWitName(e.target.value)} placeholder="Name or role" /></div>
                  </div>
                  <div className="form-field full" style={{ marginTop: 8 }}>
                    <label>Statement</label>
                    <textarea value={witStatement} onChange={(e) => setWitStatement(e.target.value)} placeholder="Record what the witness observed..." />
                  </div>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={addWitness}>Add statement</button>
                </>
              )}
            </div>
          )}

          {tab === "actions" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {inc.actions.length ? inc.actions.map((a) => {
                  const edit = actionEdits[a.id] || { description: a.description, status: a.status };
                  return (
                    <div className="entry-card" key={a.id}>
                      <div className="entry-top" style={{ alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {isViewer ? (
                            <div className="entry-title">{a.description}</div>
                          ) : (
                            <input
                              type="text" className="entry-edit-input" style={{ width: "100%", fontWeight: 700, marginBottom: 4 }}
                              value={edit.description}
                              onChange={(e) => setActionEdits((prev) => ({ ...prev, [a.id]: { ...edit, description: e.target.value } }))}
                            />
                          )}
                          <div className="entry-meta">{a.type} · Owner: {a.owner || "—"} · Due: {a.dueDate || "—"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          {isViewer ? (
                            <span className={`badge ${a.status === "Completed" ? "badge-resolved" : "badge-progress"}`}>{a.status}</span>
                          ) : (
                            <select
                              value={edit.status}
                              onChange={(e) => setActionEdits((prev) => ({ ...prev, [a.id]: { ...edit, status: e.target.value } }))}
                            >
                              <option>Pending</option><option>In Progress</option><option>Completed</option>
                            </select>
                          )}
                          {!isViewer && <button className="btn btn-secondary btn-sm" onClick={() => saveActionEdit(a.id)}>Save</button>}
                          {!isViewer && <button className="entry-remove" onClick={() => removeEntry("actions", a.id)}>Remove</button>}
                        </div>
                      </div>
                    </div>
                  );
                }) : <div className="empty-hint">No corrective or preventive actions logged yet.</div>}
              </div>
              {!isViewer && (
                <div className="add-row">
                  <div className="form-field"><label>Type</label>
                    <select value={actType} onChange={(e) => setActType(e.target.value)}>
                      <option>Corrective</option><option>Preventive</option>
                    </select>
                  </div>
                  <div className="form-field" style={{ flex: 2 }}><label>Description</label><input type="text" value={actDesc} onChange={(e) => setActDesc(e.target.value)} placeholder="Action to be taken" /></div>
                  <div className="form-field"><label>Owner</label><input type="text" value={actOwner} onChange={(e) => setActOwner(e.target.value)} placeholder="Assigned to" /></div>
                  <div className="form-field"><label>Due date</label><input type="date" value={actDue} onChange={(e) => setActDue(e.target.value)} /></div>
                  <div className="form-field"><label>Status</label>
                    <select value={actStatus} onChange={(e) => setActStatus(e.target.value)}>
                      <option>Pending</option><option>In Progress</option><option>Completed</option>
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addAction}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "attachments" && (
            <div className="tab-pane active">
              <div className="attach-grid">
                {inc.attachments.map((a) => (
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
              {inc.attachments.length === 0 && <div className="empty-hint">No photos or documents attached yet.</div>}
              {!isViewer && (
                <>
                  <label className="upload-drop" htmlFor="attachFileInput">
                    <div>Click to upload a photo or document</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
                  </label>
                  <input type="file" id="attachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
                </>
              )}
            </div>
          )}

          {tab === "activity" && (
            <div className="tab-pane active">
              <div className="audit-list">
                {auditRows === null && <div className="empty-hint">Loading activity...</div>}
                {auditRows && auditRows.length === 0 && <div className="empty-hint">No activity recorded yet.</div>}
                {auditRows && auditRows.map((r) => (
                  <div className="audit-row" key={r.id}>
                    <div className="audit-time">{new Date(r.at).toLocaleString()}</div>
                    <div className="audit-who">{r.username || "system"}</div>
                    <div className="audit-what">{auditLabel(r.action)}{r.detail ? ": " + r.detail : ""}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport}>Download PDF report</button>
          <div style={{ flex: 1 }}></div>
          {isAdmin && <button className="btn btn-danger" onClick={deleteIncident}>Delete incident</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
