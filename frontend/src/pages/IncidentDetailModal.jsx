import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import { WORKFLOW_STAGES, daysBetween, sevBadgeClass, fileIcon, auditLabel } from "./incidentShared";

/**
 * Full incident detail modal: workflow stepper + tabs (Overview, Root cause,
 * Evidence, Witnesses, CAPA, Attachments, Activity log). Mirrors the legacy
 * #detailModalOverlay 1:1 against the same backend endpoints. Re-fetches the
 * single incident after every mutation (rather than the whole list) and
 * calls onChanged() so the parent table/counts stay in sync.
 */
export default function IncidentDetailModal({ incidentId, canEdit = false, canDelete = false, onClose, onChanged, onDeleted }) {
  const [inc, setInc] = useState(null);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");

  const [rootCauseDraft, setRootCauseDraft] = useState("");

  // --- Edit mode -----------------------------------------------------------
  //
  // ONE toggle for the whole modal: every tab's controls answer to it, rather
  // than each field carrying its own pencil. `draft` buffers the Overview
  // fields so Cancel has something to discard -- the other tabs save
  // immediately through their own endpoints and always have, which is why
  // Cancel can only speak for the details (see cancelEdit below).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  // Reference data for the two dropdowns, loaded once when edit mode opens.
  const [sites, setSites] = useState([]);
  const [classifications, setClassifications] = useState([]);

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

  // The seven Overview fields the PATCH route accepts. Resolved date is NOT
  // here: it is set by the stage transition, and typing one that disagrees with
  // the stage would make the record contradict itself.
  const EDITABLE = ["site", "classification", "date", "severity", "reportedBy", "assigned", "description"];

  // Closed incidents are read-only. Tested as "not Closed" rather than by
  // position in WORKFLOW_STAGES, because rows written before that list existed
  // carry status 'Reported' (the column default) and would otherwise land at
  // index -1 and behave unpredictably.
  const isClosed = inc && inc.status === "Closed";
  const mayEdit = canEdit && !isClosed;
  // Something is actually different from what was loaded.
  const dirty = !!draft && (
    EDITABLE.some((f) => (draft[f] ?? "") !== (inc?.[f] ?? "")) ||
    rootCauseDraft.trim() !== (inc?.rootCause ?? "").trim()
  );

  async function startEdit() {
    setDraft(Object.fromEntries(EDITABLE.map((f) => [f, inc[f] ?? ""])));
    setEditing(true);
    if (sites.length === 0) {
      api("/meta/sites").then(setSites).catch(() => {});
      api("/meta/classifications").then(setClassifications).catch(() => {});
    }
  }

  // Cancel can only speak for what it buffered. Evidence, witnesses, corrective
  // actions and attachments write the moment they are added, here and before
  // this feature existed, so saying "discard changes" without qualification
  // would promise to undo things that are already saved.
  async function cancelEdit() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard changes?",
        body: "This will discard changes to incident details only — items already added to Evidence/Witnesses/etc. will remain.",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        tone: "danger",
      });
      if (!ok) return false;
    }
    setDraft(null);
    setRootCauseDraft(inc?.rootCause || "");
    setEditing(false);
    return true;
  }

  async function saveEdit() {
    // Only what actually changed. The route ignores undefined keys and returns
    // early when nothing is set, but sending everything would write an audit
    // entry naming every field on a save that altered one.
    const body = {};
    for (const f of EDITABLE) if ((draft[f] ?? "") !== (inc[f] ?? "")) body[f] = draft[f];
    if (rootCauseDraft.trim() !== (inc.rootCause ?? "").trim()) body.rootCause = rootCauseDraft.trim();
    if (Object.keys(body).length === 0) { setEditing(false); setDraft(null); return; }

    setSaving(true);
    try {
      // The status can have moved to Closed since this modal opened -- by
      // another user, or in another tab. Re-read before writing and refuse on
      // the server's 409 rather than reporting a success that did not happen.
      const fresh = await api(`/incidents/${incidentId}`);
      if (fresh.status === "Closed") {
        setError("This incident was Closed while you were editing. Your changes were not saved.");
        setInc(fresh);
        setEditing(false); setDraft(null);
        return;
      }
      await api(`/incidents/${incidentId}`, { method: "PATCH", body: JSON.stringify(body) });
      await reload();
      setEditing(false); setDraft(null);
      toast.success("Incident details saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Closing while editing must not silently drop the work. Routed through the
  // same confirmation as Cancel so the wording is identical wherever it appears.
  async function requestClose() {
    if (editing && !(await cancelEdit())) return;
    onClose();
  }

  // A tab close or a refresh never reaches requestClose, so the browser's own
  // prompt is the only guard available there. Registered ONLY while there are
  // unsaved details -- an unconditional handler would nag on every close.
  useEffect(() => {
    if (!editing || !dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, dirty]);

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
          <button className="modal-close" onClick={requestClose}>&times;</button>
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
                  onClick={(!mayEdit || editing) ? undefined : () => setStage(s)}
                  title={`Set status to ${s}`}
                  style={(!mayEdit || editing) ? { cursor: "default" } : undefined}
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
                <div className="form-field"><label>Site</label>
                  {editing ? (
                    <select value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })}>
                      {/* The incident's own site is offered even when it is no longer on the
                          configured list, so opening an old incident cannot silently re-point it. */}
                      {inc.site && !sites.includes(inc.site) && <option value={inc.site}>{inc.site}</option>}
                      {sites.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  ) : <div>{inc.site}</div>}
                </div>
                <div className="form-field"><label>Classification</label>
                  {editing ? (
                    <select value={draft.classification} onChange={(e) => setDraft({ ...draft, classification: e.target.value })}>
                      {inc.classification && !classifications.includes(inc.classification) &&
                        <option value={inc.classification}>{inc.classification}</option>}
                      {classifications.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  ) : <div><span className="chip">{inc.classification}</span></div>}
                </div>
                <div className="form-field"><label>Date reported</label>
                  {editing
                    ? <input type="date" value={draft.date || ""} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                    : <div>{inc.date}</div>}
                </div>
                <div className="form-field"><label>Severity</label>
                  {editing ? (
                    <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>
                      {["Critical", "High", "Medium", "Low"].map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  ) : <div><span className={`badge ${sevBadgeClass(inc.severity)}`}>{inc.severity}</span></div>}
                </div>
                <div className="form-field"><label>Reported by</label>
                  {editing
                    ? <input type="text" value={draft.reportedBy || ""} onChange={(e) => setDraft({ ...draft, reportedBy: e.target.value })} />
                    : <div>{inc.reportedBy || "—"}</div>}
                </div>
                <div className="form-field"><label>Assigned investigator</label>
                  {editing
                    ? <input type="text" value={draft.assigned || ""} onChange={(e) => setDraft({ ...draft, assigned: e.target.value })} />
                    : <div>{inc.assigned || "—"}</div>}
                </div>
                <div className="form-field full"><label>Description</label>
                  {editing
                    ? <textarea rows={5} value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    : <div style={{ whiteSpace: "pre-wrap" }}>{inc.description || "—"}</div>}
                </div>
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
                  readOnly={!mayEdit}
                  value={rootCauseDraft}
                  onChange={(e) => setRootCauseDraft(e.target.value)}
                  placeholder="Document the underlying cause of this incident..."
                />
              </div>
              {mayEdit &&<button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveRootCause}>Save root cause</button>}
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
                      {mayEdit &&<button className="entry-remove" onClick={() => removeEntry("evidence", e.id)}>Remove</button>}
                    </div>
                    {e.note && <div className="entry-body">{e.note}</div>}
                  </div>
                )) : <div className="empty-hint">No evidence logged yet.</div>}
              </div>
              {mayEdit &&(
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
                      {mayEdit &&<button className="entry-remove" onClick={() => removeEntry("witnesses", w.id)}>Remove</button>}
                    </div>
                    <div className="entry-body">{w.statement}</div>
                  </div>
                )) : <div className="empty-hint">No witness statements recorded yet.</div>}
              </div>
              {mayEdit &&(
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
                          {!mayEdit ? (
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
                          {!mayEdit ? (
                            <span className={`badge ${a.status === "Completed" ? "badge-resolved" : "badge-progress"}`}>{a.status}</span>
                          ) : (
                            <select
                              value={edit.status}
                              onChange={(e) => setActionEdits((prev) => ({ ...prev, [a.id]: { ...edit, status: e.target.value } }))}
                            >
                              <option>Pending</option><option>In Progress</option><option>Completed</option>
                            </select>
                          )}
                          {mayEdit &&<button className="btn btn-secondary btn-sm" onClick={() => saveActionEdit(a.id)}>Save</button>}
                          {mayEdit &&<button className="entry-remove" onClick={() => removeEntry("actions", a.id)}>Remove</button>}
                        </div>
                      </div>
                    </div>
                  );
                }) : <div className="empty-hint">No corrective or preventive actions logged yet.</div>}
              </div>
              {mayEdit &&(
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
                    {mayEdit &&<button className="attach-remove" title="Remove" onClick={() => removeAttachment(a.id)}>&times;</button>}
                  </div>
                ))}
              </div>
              {inc.attachments.length === 0 && <div className="empty-hint">No photos or documents attached yet.</div>}
              {mayEdit &&(
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
          {/* Edit replaces itself with Save + Cancel. Delete is disabled while
              editing so a stray click cannot destroy work in progress, and the
              Closed case shows a DISABLED button rather than none -- a missing
              button reads as a permissions fault, a disabled one explains. */}
          {!editing && mayEdit && <button className="btn btn-primary" onClick={startEdit}>Edit</button>}
          {!editing && canEdit && isClosed && (
            <button className="btn btn-primary" disabled
              title="Closed incidents cannot be edited. Reopen it first if it needs changing.">Edit</button>
          )}
          {editing && (
            <>
              <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
              <button className="btn btn-outline" onClick={cancelEdit} disabled={saving}>Cancel</button>
            </>
          )}
          {canDelete && <button className="btn btn-danger" onClick={deleteIncident} disabled={editing}>Delete incident</button>}
          <button className="btn btn-secondary" onClick={requestClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
