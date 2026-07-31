import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { RC_STAGES, rcStatusBadgeClass } from "./recruitmentShared";

/**
 * Applicant detail modal. Mirrors the legacy #recruitmentDetailModalOverlay:
 * a 7-node pipeline stepper (Applied → … → Onboarded) plus a separate
 * "Mark as Rejected" action, over six tabs:
 *   Screening & Interview, Hiring & Contract (section forms with Save),
 *   Onboarding Checklist, Uniform & Equipment (child collections),
 *   Attachments, Notes.
 * Editable for any non-Viewer unless the applicant is Rejected (read-only).
 * Reaching "Hired" auto-stamps hire date + Active employment status server-side.
 */
export default function RecruitmentDetailModal({ applicantId, isViewer, isAdmin, dropdowns, onClose, onChanged, onDeleted }) {
  const [a, setA] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("screening");
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  // Section drafts (Screening & Interview, Hiring & Contract, Notes).
  const [scr, setScr] = useState(null);
  const [hire, setHire] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");

  // Add-row drafts for the two child collections.
  const [newItem, setNewItem] = useState({ itemText: "", notes: "" });
  const [newEquip, setNewEquip] = useState({ itemName: "", issuedDate: "" });

  const load = useCallback(async () => {
    try {
      const data = await api(`/recruitment/${applicantId}`);
      setA(data);
      setScr({
        fullName: data.fullName || "",
        position: data.position || "",
        interviewDate: data.interviewDate || "",
        backgroundCheckStatus: data.backgroundCheckStatus || "",
        licenseStatus: data.licenseStatus || "",
        medicalExamStatus: data.medicalExamStatus || "",
        interviewNotes: data.interviewNotes || "",
      });
      setHire({
        hireDate: data.hireDate || "",
        contractIssuedDate: data.contractIssuedDate || "",
        employmentStatus: data.employmentStatus || "",
      });
      setNotesDraft(data.notes || "");
    } catch (e) {
      setError(e.message);
    }
  }, [applicantId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!a) return;
    let cancelled = false;
    a.attachments.filter((att) => /^image\//.test(att.mimetype)).forEach((att) => {
      apiBlobUrl(`/recruitment/${a.id}/attachments/${att.id}`).then((url) => {
        if (!cancelled) setThumbs((t) => ({ ...t, [att.id]: url }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.attachments]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  const editable = !isViewer && a && a.status !== "Rejected";

  // --- Stage / delete ---
  async function setStage(stage) {
    await guard(async () => {
      await api(`/recruitment/${applicantId}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      await reload();
    });
  }
  async function deleteApplicant() {
    if (!confirm("Delete this applicant record permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/recruitment/${applicantId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  // --- Section saves ---
  async function saveScreening() {
    await guard(async () => {
      await api(`/recruitment/${applicantId}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: scr.fullName.trim(),
          position: scr.position,
          interviewDate: scr.interviewDate || null,
          interviewNotes: scr.interviewNotes.trim(),
          backgroundCheckStatus: scr.backgroundCheckStatus,
          licenseStatus: scr.licenseStatus,
          medicalExamStatus: scr.medicalExamStatus,
        }),
      });
      await reload();
    });
  }
  async function saveHiring() {
    await guard(async () => {
      await api(`/recruitment/${applicantId}`, {
        method: "PATCH",
        body: JSON.stringify({
          hireDate: hire.hireDate || null,
          contractIssuedDate: hire.contractIssuedDate || null,
          employmentStatus: hire.employmentStatus,
        }),
      });
      await reload();
    });
  }
  async function saveNotes() {
    await guard(async () => {
      await api(`/recruitment/${applicantId}`, { method: "PATCH", body: JSON.stringify({ notes: notesDraft.trim() }) });
      await reload();
      alert("Notes saved.");
    });
  }

  // --- Onboarding checklist ---
  async function addItem() {
    if (!newItem.itemText.trim()) { alert("Enter a checklist item."); return; }
    await guard(async () => {
      await api(`/recruitment/${applicantId}/checklist`, {
        method: "POST",
        body: JSON.stringify({ itemText: newItem.itemText.trim(), notes: newItem.notes.trim() }),
      });
      setNewItem({ itemText: "", notes: "" });
      await reload();
    });
  }
  async function toggleItem(itemId, completed) {
    await guard(async () => {
      await api(`/recruitment/${applicantId}/checklist/${itemId}`, { method: "PATCH", body: JSON.stringify({ completed }) });
      await reload();
    });
  }
  async function removeItem(itemId) {
    await guard(async () => {
      await api(`/recruitment/${applicantId}/checklist/${itemId}`, { method: "DELETE" });
      await reload();
    });
  }

  // --- Equipment issuance ---
  async function addEquip() {
    if (!newEquip.itemName.trim()) { alert("Enter an item name."); return; }
    await guard(async () => {
      await api(`/recruitment/${applicantId}/equipment`, {
        method: "POST",
        body: JSON.stringify({ itemName: newEquip.itemName.trim(), issuedDate: newEquip.issuedDate || null }),
      });
      setNewEquip({ itemName: "", issuedDate: "" });
      await reload();
    });
  }
  async function removeEquip(itemId) {
    await guard(async () => {
      await api(`/recruitment/${applicantId}/equipment/${itemId}`, { method: "DELETE" });
      await reload();
    });
  }

  // --- Attachments ---
  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/recruitment/${applicantId}/attachments`, file);
      await reload();
    });
  }
  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/recruitment/${applicantId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }
  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/recruitment/${applicantId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }
  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/recruitment/${applicantId}/report.pdf`);
      downloadBlobUrl(url, `${a.code}-applicant-record.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Applicant</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">{error}</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  if (!a || !scr || !hire) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Applicant</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const stageIdx = RC_STAGES.indexOf(a.status);
  const rejected = a.status === "Rejected";
  const tabBtn = (name, label) => (
    <button className={`tab-btn ${tab === name ? "active" : ""}`} onClick={() => setTab(name)}>{label}</button>
  );

  // Editable/readonly field helpers bound to a given draft + setter.
  const field = (draft, setDraft, label, key, type) => (
    <div className="form-field">
      <label>{label}</label>
      {editable
        ? <input type={type || "text"} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        : <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(a[key] || "") || "—"}</div>}
    </div>
  );
  const selectField = (draft, setDraft, label, key, listKey) => {
    const options = dropdowns[listKey] || [];
    return (
      <div className="form-field">
        <label>{label}</label>
        {editable ? (
          <select value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
            <option value="">—</option>
            {!options.includes(draft[key]) && draft[key] ? <option>{draft[key]}</option> : null}
            {options.map((v) => <option key={v}>{v}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(a[key] || "") || "—"}</div>
        )}
      </div>
    );
  };

  return (
    <div className="modal-overlay active">
      <div className="modal">
        <div className="modal-header">
          <h2>{a.code} — {a.fullName}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="stepper">
            {RC_STAGES.map((s, idx) => {
              let cls = "";
              if (!rejected) {
                if (idx < stageIdx) cls = "done";
                else if (idx === stageIdx) cls = "current";
              }
              const showCheck = idx < stageIdx && !rejected;
              return (
                <div
                  className={`step ${cls}`}
                  key={s}
                  onClick={editable ? () => setStage(s) : undefined}
                  title={`Set status to ${s}`}
                  style={editable ? undefined : { cursor: "default" }}
                >
                  <div className="step-line"></div>
                  <div className="step-dot">{showCheck ? "\u2713" : idx + 1}</div>
                  <div className="step-label">{s}</div>
                </div>
              );
            })}
          </div>
          <div style={{ margin: "10px 0 16px" }}>
            {!isViewer && !rejected && (
              <button className="btn btn-danger btn-sm" onClick={() => setStage("Rejected")}>Mark as Rejected</button>
            )}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <span className={`badge ${rcStatusBadgeClass(a.status)}`} style={{ fontSize: 12 }}>{a.status}</span>
            <span className="chip">{a.position || "—"}</span>
            <span className="chip">{a.site || "—"}</span>
          </div>

          <div className="tabs">
            {tabBtn("screening", "Screening & Interview")}
            {tabBtn("hiring", "Hiring & Contract")}
            {tabBtn("onboarding", `Onboarding Checklist (${a.checklist.length})`)}
            {tabBtn("equipment", `Uniform & Equipment (${a.equipment.length})`)}
            {tabBtn("attachments", `Attachments (${a.attachments.length})`)}
            {tabBtn("notes", "Notes")}
          </div>

          {tab === "screening" && (
            <div className="tab-pane active">
              <div className="form-grid">
                {field(scr, setScr, "Full name", "fullName")}
                {selectField(scr, setScr, "Position applied for", "position", "position_title")}
                {field(scr, setScr, "Interview date", "interviewDate", "date")}
                {selectField(scr, setScr, "Background check", "backgroundCheckStatus", "background_check_status")}
                {selectField(scr, setScr, "License / certification verification", "licenseStatus", "license_verification_status")}
                {selectField(scr, setScr, "Medical examination", "medicalExamStatus", "medical_exam_status")}
                <div className="form-field full">
                  <label>Interview notes</label>
                  {editable
                    ? <textarea value={scr.interviewNotes} onChange={(e) => setScr({ ...scr, interviewNotes: e.target.value })} />
                    : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(a.interviewNotes || "") || "—"}</div>}
                </div>
              </div>
              {editable && <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveScreening}>Save</button>}
            </div>
          )}

          {tab === "hiring" && (
            <div className="tab-pane active">
              <div className="form-grid">
                {field(hire, setHire, "Hire date", "hireDate", "date")}
                {field(hire, setHire, "Contract issued date", "contractIssuedDate", "date")}
                {selectField(hire, setHire, "Employment status", "employmentStatus", "employment_status")}
              </div>
              {editable && <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveHiring}>Save</button>}
            </div>
          )}

          {tab === "onboarding" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {a.checklist.length ? a.checklist.map((item) => (
                  <div className="entry-card" key={item.id}>
                    <div className="entry-top">
                      <div>
                        <div className="entry-title">{item.itemText}</div>
                        {item.notes && <div className="entry-meta">{item.notes}</div>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`badge ${item.completed === "Yes" ? "badge-resolved" : "badge-closed"}`}>{item.completed === "Yes" ? "Done" : "Pending"}</span>
                        {editable && (
                          <button className="btn btn-secondary btn-sm" onClick={() => toggleItem(item.id, item.completed === "Yes" ? "No" : "Yes")}>
                            {item.completed === "Yes" ? "Mark pending" : "Mark done"}
                          </button>
                        )}
                        {editable && <button className="entry-remove" onClick={() => removeItem(item.id)}>Remove</button>}
                      </div>
                    </div>
                  </div>
                )) : <div className="empty-hint">No onboarding checklist items yet.</div>}
              </div>
              {editable && (
                <div className="add-row">
                  <div className="form-field" style={{ flex: 2 }}><label>Checklist item</label>
                    <input type="text" value={newItem.itemText} onChange={(e) => setNewItem((p) => ({ ...p, itemText: e.target.value }))} placeholder="e.g. Sign employment contract" />
                  </div>
                  <div className="form-field" style={{ flex: 2 }}><label>Notes</label>
                    <input type="text" value={newItem.notes} onChange={(e) => setNewItem((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional" />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addItem}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "equipment" && (
            <div className="tab-pane active">
              <div className="entry-list">
                {a.equipment.length ? a.equipment.map((item) => (
                  <div className="entry-card" key={item.id}>
                    <div className="entry-top">
                      <div>
                        <div className="entry-title">{item.itemName}</div>
                        <div className="entry-meta">{item.issuedDate ? "Issued " + item.issuedDate : "Not yet issued"}{item.notes ? " · " + item.notes : ""}</div>
                      </div>
                      {editable && <button className="entry-remove" onClick={() => removeEquip(item.id)}>Remove</button>}
                    </div>
                  </div>
                )) : <div className="empty-hint">No equipment issued yet.</div>}
              </div>
              {editable && (
                <div className="add-row">
                  <div className="form-field" style={{ flex: 2 }}><label>Item</label>
                    <input type="text" value={newEquip.itemName} onChange={(e) => setNewEquip((p) => ({ ...p, itemName: e.target.value }))} placeholder="e.g. Uniform (2 sets), Duty belt" />
                  </div>
                  <div className="form-field"><label>Issued date</label>
                    <input type="date" value={newEquip.issuedDate} onChange={(e) => setNewEquip((p) => ({ ...p, issuedDate: e.target.value }))} />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addEquip}>Add</button>
                </div>
              )}
            </div>
          )}

          {tab === "attachments" && (
            <div className="tab-pane active">
              <div className="attach-grid">
                {a.attachments.map((att) => (
                  <div className="attach-card" key={att.id}>
                    {/^image\//.test(att.mimetype)
                      ? <img className="attach-thumb" src={thumbs[att.id]} alt={att.filename} onClick={() => viewAttachment(att.id)} />
                      : <div className="attach-icon" onClick={() => viewAttachment(att.id)}>{fileIcon(att.mimetype)}</div>}
                    <div className="attach-name" title={att.filename}>{att.filename}</div>
                    <div className="attach-meta">{(att.size / 1024).toFixed(0)} KB</div>
                    {!isViewer && <button className="attach-remove" title="Remove" onClick={() => removeAttachment(att.id)}>&times;</button>}
                  </div>
                ))}
              </div>
              {a.attachments.length === 0 && <div className="empty-hint">No resume or documents attached yet.</div>}
              {editable && (
                <>
                  <label className="upload-drop" htmlFor="rcAttachFileInput">
                    <div>Click to upload a resume or document</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
                  </label>
                  <input type="file" id="rcAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
                </>
              )}
            </div>
          )}

          {tab === "notes" && (
            <div className="tab-pane active">
              <div className="form-field full">
                <label>Notes</label>
                {editable
                  ? <textarea style={{ minHeight: 120 }} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} />
                  : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(a.notes || "") || "—"}</div>}
              </div>
              {editable && <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={saveNotes}>Save notes</button>}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          <div style={{ flex: 1 }}></div>
          {isAdmin && <button className="btn btn-danger" onClick={deleteApplicant} disabled={busy}>Delete applicant</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
