import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { paStatusBadgeClass, PA_KPI_FIELDS } from "./performanceShared";

/**
 * Performance Appraisal detail modal. Mirrors #performanceDetailModalOverlay:
 *
 *  - Workflow: Draft → Submitted → Finalized. Submit is Admin/Investigator;
 *    Finalize and Reopen are Admin-only. Editable while Draft or Submitted;
 *    Finalized is read-only until an Admin reopens (backend enforces this too).
 *  - Six KPI dimensions scored 1-5 via selects; the overall score is the
 *    server-computed average (shown "X / 5") and refreshes after each save.
 *  - Promotion recommendation is a Manage Lists dropdown (promotion_recommendation).
 */
export default function PerformanceDetailModal({ appraisalId, isViewer, isAdmin, canDelete = false, promotionOptions, onClose, onChanged, onDeleted }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/performance/${appraisalId}`);
      setC(data);
      const d = {
        employeeName: data.employeeName || "",
        evaluationDate: data.evaluationDate || "",
        evaluatorName: data.evaluatorName || "",
        supervisorComments: data.supervisorComments || "",
        clientFeedback: data.clientFeedback || "",
        competencyAssessment: data.competencyAssessment || "",
        promotionRecommended: data.promotionRecommended || "",
        promotionNotes: data.promotionNotes || "",
      };
      PA_KPI_FIELDS.forEach((k) => {
        d[k.key] = (data[k.key] === null || data[k.key] === undefined) ? "" : String(data[k.key]);
      });
      setDraft(d);
    } catch (e) {
      setError(e.message);
    }
  }, [appraisalId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!c) return;
    let cancelled = false;
    c.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/performance/${c.id}/attachments/${a.id}`).then((url) => {
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

  const editable = !isViewer && c && (c.status === "Draft" || c.status === "Submitted");

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function saveEdit() {
    await guard(async () => {
      const payload = {
        employeeName: draft.employeeName.trim(),
        evaluationDate: draft.evaluationDate,
        evaluatorName: draft.evaluatorName.trim(),
        supervisorComments: draft.supervisorComments.trim(),
        clientFeedback: draft.clientFeedback.trim(),
        competencyAssessment: draft.competencyAssessment.trim(),
        promotionRecommended: draft.promotionRecommended,
        promotionNotes: draft.promotionNotes.trim(),
      };
      PA_KPI_FIELDS.forEach((k) => { payload[k.key] = draft[k.key]; }); // "" or "1".."5"; backend coerces
      await api(`/performance/${appraisalId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await reload();
    });
  }

  async function submitAppraisal() {
    if (!confirm("Submit this appraisal for finalization? You won't be able to make further edits unless it's reopened.")) return;
    await guard(async () => {
      await api(`/performance/${appraisalId}/submit`, { method: "POST" });
      await reload();
    });
  }
  async function finalize() {
    await guard(async () => {
      await api(`/performance/${appraisalId}/finalize`, { method: "POST" });
      await reload();
    });
  }
  async function reopen() {
    if (!confirm("Reopen this appraisal for editing?")) return;
    await guard(async () => {
      await api(`/performance/${appraisalId}/reopen`, { method: "POST" });
      await reload();
    });
  }
  async function deleteAppraisal() {
    if (!confirm("Delete this appraisal permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/performance/${appraisalId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/performance/${appraisalId}/attachments`, file);
      await reload();
    });
  }
  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/performance/${appraisalId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }
  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/performance/${appraisalId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }
  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/performance/${appraisalId}/report.pdf`);
      downloadBlobUrl(url, `${c.code}-performance-appraisal.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Performance Appraisal</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
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
          <div className="modal-header"><h2>Performance Appraisal</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const field = (label, key, type) => (
    <div className="form-field">
      <label>{label}</label>
      {editable
        ? <input type={type || "text"} value={draft[key]} onChange={(e) => setField(key, e.target.value)} />
        : <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>}
    </div>
  );
  const textField = (label, key) => (
    <div className="form-field full">
      <label>{label}</label>
      {editable
        ? <textarea value={draft[key]} onChange={(e) => setField(key, e.target.value)} />
        : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>}
    </div>
  );
  const kpiField = (kpi) => (
    <div className="form-field" key={kpi.key}>
      <label>{kpi.label}</label>
      {editable ? (
        <select value={draft[kpi.key]} onChange={(e) => setField(kpi.key, e.target.value)}>
          <option value="">—</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}
        </select>
      ) : (
        <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>
          {c[kpi.key] !== null && c[kpi.key] !== undefined ? c[kpi.key] + " / 5" : "—"}
        </div>
      )}
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
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <span className={`badge ${paStatusBadgeClass(c.status)}`} style={{ fontSize: 12 }}>{c.status}</span>
            <span className="chip">{c.site || "—"}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Evaluated by {c.evaluatorName || "—"}</span>
            {c.overallScore !== null && c.overallScore !== undefined && (
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>Overall: {c.overallScore} / 5</span>
            )}
            {c.finalizedBy && (
              <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
                Finalized by {c.finalizedBy} on {new Date(c.finalizedAt).toLocaleDateString()}
              </span>
            )}
          </div>

          <div className="section-divider" style={{ marginTop: 0 }}>Overview</div>
          <div className="form-grid">
            {field("Employee name", "employeeName")}
            {field("Evaluation date", "evaluationDate", "date")}
            {field("Evaluator (Supervisor / Operation Officer)", "evaluatorName")}
          </div>

          <div className="section-divider">KPI Scores <span className="hint">(1–5)</span></div>
          <div className="form-grid">
            {PA_KPI_FIELDS.map(kpiField)}
          </div>

          <div className="section-divider">Supervisor / Operation Officer Rating</div>
          <div className="form-grid">
            {textField("Comments", "supervisorComments")}
          </div>

          <div className="section-divider">Client Feedback</div>
          <div className="form-grid">
            {textField("Feedback", "clientFeedback")}
          </div>

          <div className="section-divider">Competency Assessment</div>
          <div className="form-grid">
            {textField("Assessment", "competencyAssessment")}
          </div>

          <div className="section-divider">Promotion Recommendation</div>
          <div className="form-grid">
            <div className="form-field">
              <label>Recommendation</label>
              {editable ? (
                <select value={draft.promotionRecommended} onChange={(e) => setField("promotionRecommended", e.target.value)}>
                  {!promotionOptions.includes(draft.promotionRecommended) && draft.promotionRecommended ? <option>{draft.promotionRecommended}</option> : null}
                  {promotionOptions.map((v) => <option key={v}>{v}</option>)}
                </select>
              ) : (
                <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c.promotionRecommended || "") || "—"}</div>
              )}
            </div>
            {textField("Notes", "promotionNotes")}
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
          {c.attachments.length === 0 && <div className="empty-hint">No supporting documents attached yet.</div>}
          {editable && (
            <>
              <label className="upload-drop" htmlFor="paAttachFileInput">
                <div>Click to upload a supporting document</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
              </label>
              <input type="file" id="paAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          {editable && <button className="btn btn-secondary" onClick={saveEdit} disabled={busy}>Save changes</button>}
          {!isViewer && c.status === "Draft" && <button className="btn btn-primary" onClick={submitAppraisal} disabled={busy}>Submit for finalization</button>}
          {isAdmin && c.status === "Submitted" && <button className="btn btn-primary" onClick={finalize} disabled={busy}>Finalize</button>}
          {isAdmin && c.status === "Finalized" && <button className="btn btn-secondary" onClick={reopen} disabled={busy}>Reopen for editing</button>}
          <div style={{ flex: 1 }}></div>
          {canDelete && <button className="btn btn-danger" onClick={deleteAppraisal} disabled={busy}>Delete appraisal</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
