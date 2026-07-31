import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { TR_STAGES } from "./trainingShared";
import ExpiryBadge from "./ExpiryBadge";

/**
 * Training record detail modal. Mirrors the legacy #trainingDetailModalOverlay:
 * a workflow stepper (Scheduled → In Progress → Completed → Cancelled) over four
 * sections (Training, Competency Exam, Certification, Notes). Records stay
 * editable in every stage except Cancelled (a terminal state). Course,
 * attendance, and exam result are Manage Lists dropdowns.
 */
export default function TrainingDetailModal({ recordId, isViewer, isAdmin, dropdowns, onClose, onChanged, onDeleted }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/training/${recordId}`);
      setC(data);
      setDraft({
        employeeName: data.employeeName || "",
        courseName: data.courseName || "",
        scheduledDate: data.scheduledDate || "",
        attendanceStatus: data.attendanceStatus || "",
        examScore: data.examScore || "",
        examResult: data.examResult || "",
        certificationName: data.certificationName || "",
        certificationIssueDate: data.certificationIssueDate || "",
        certificationExpiryDate: data.certificationExpiryDate || "",
        notes: data.notes || "",
      });
    } catch (e) {
      setError(e.message);
    }
  }, [recordId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!c) return;
    let cancelled = false;
    c.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/training/${c.id}/attachments/${a.id}`).then((url) => {
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

  const editable = !isViewer && c && c.status !== "Cancelled";

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function saveEdit() {
    await guard(async () => {
      const payload = {
        employeeName: draft.employeeName.trim(),
        scheduledDate: draft.scheduledDate,
        courseName: draft.courseName,
        attendanceStatus: draft.attendanceStatus,
        examScore: draft.examScore.trim(),
        examResult: draft.examResult,
        certificationName: draft.certificationName.trim(),
        certificationIssueDate: draft.certificationIssueDate || null,
        certificationExpiryDate: draft.certificationExpiryDate || null,
        notes: draft.notes.trim(),
      };
      await api(`/training/${recordId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await reload();
    });
  }

  async function setStage(stage) {
    await guard(async () => {
      await api(`/training/${recordId}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      await reload();
    });
  }

  async function deleteRecord() {
    if (!confirm("Delete this training record permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/training/${recordId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/training/${recordId}/attachments`, file);
      await reload();
    });
  }
  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/training/${recordId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }
  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/training/${recordId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }
  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/training/${recordId}/report.pdf`);
      downloadBlobUrl(url, `${c.code}-training-record.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Training Record</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">{error}</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  if (!c || !draft) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Training Record</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const stageIdx = TR_STAGES.indexOf(c.status);

  const field = (label, key, type) => (
    <div className="form-field">
      <label>{label}</label>
      {editable
        ? <input type={type || "text"} value={draft[key]} onChange={(e) => setField(key, e.target.value)} />
        : <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>}
    </div>
  );
  const selectField = (label, key, listKey) => {
    const options = dropdowns[listKey] || [];
    return (
      <div className="form-field">
        <label>{label}</label>
        {editable ? (
          <select value={draft[key]} onChange={(e) => setField(key, e.target.value)}>
            <option value="">—</option>
            {!options.includes(draft[key]) && draft[key] ? <option>{draft[key]}</option> : null}
            {options.map((v) => <option key={v}>{v}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>
        )}
      </div>
    );
  };
  const textField = (label, key) => (
    <div className="form-field full">
      <label>{label}</label>
      {editable
        ? <textarea value={draft[key]} onChange={(e) => setField(key, e.target.value)} />
        : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>}
    </div>
  );

  return (
    <div className="modal-overlay active">
      <div className="modal">
        <div className="modal-header">
          <h2>{c.code} — {c.employeeName}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="stepper">
            {TR_STAGES.map((s, idx) => {
              let cls = "";
              if (s === "Cancelled") {
                cls = c.status === "Cancelled" ? "current" : "";
              } else if (c.status !== "Cancelled") {
                if (idx < stageIdx) cls = "done";
                else if (idx === stageIdx) cls = "current";
              }
              const showCheck = idx < stageIdx && c.status !== "Cancelled";
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

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "16px 0" }}>
            <span className="chip">{c.site || "—"}</span>
            <span className="chip">{c.courseName || "—"}</span>
            {c.certificationExpiryDate && <ExpiryBadge date={c.certificationExpiryDate} />}
          </div>

          <div className="section-divider" style={{ marginTop: 0 }}>Training</div>
          <div className="form-grid">
            {field("Employee name", "employeeName")}
            {selectField("Course / training", "courseName", "training_type")}
            {field("Scheduled date", "scheduledDate", "date")}
            {selectField("Attendance", "attendanceStatus", "attendance_status")}
          </div>

          <div className="section-divider">Competency Exam</div>
          <div className="form-grid">
            {field("Score", "examScore")}
            {selectField("Result", "examResult", "exam_result")}
          </div>

          <div className="section-divider">Certification</div>
          <div className="form-grid">
            {field("Certification name", "certificationName")}
            {field("Issue date", "certificationIssueDate", "date")}
            {field("Expiry date", "certificationExpiryDate", "date")}
          </div>

          <div className="section-divider">Notes</div>
          <div className="form-grid">
            {textField("Notes", "notes")}
          </div>

          <div className="section-divider">Attachments</div>
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
          {c.attachments.length === 0 && <div className="empty-hint">No certificates or documents attached yet.</div>}
          {editable && (
            <>
              <label className="upload-drop" htmlFor="trAttachFileInput">
                <div>Click to upload a certificate or document</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
              </label>
              <input type="file" id="trAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          {editable && <button className="btn btn-secondary" onClick={saveEdit} disabled={busy}>Save changes</button>}
          <div style={{ flex: 1 }}></div>
          {isAdmin && <button className="btn btn-danger" onClick={deleteRecord} disabled={busy}>Delete record</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
