import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { dsrStatusBadgeClass, DSR_TEXT_FIELDS } from "./dsrShared";

/**
 * Daily Security Report detail modal. Mirrors the legacy #dsrDetailModalOverlay:
 *
 *  - Header shows status badge + site/shift chips + submitter/approver line.
 *  - Body fields (submittedBy + the six text blocks) render as editable
 *    textareas when editable, plain text otherwise. Date/site/shift are set at
 *    creation and are NOT editable here (matching the vanilla app).
 *  - "editable" = not a Viewer AND status is Draft or Submitted. The backend
 *    additionally blocks edits once Approved/Rejected until an Admin reopens.
 *  - Footer buttons are role- and status-conditional:
 *      Download PDF (all) · Save changes (editable) · Submit (Draft, non-viewer)
 *      · Approve/Reject (Submitted, Admin) · Reopen (Approved/Rejected, Admin)
 *      · Delete (Admin) · Close (all)
 */
export default function DsrDetailModal({ dsrId, isViewer, isAdmin, onClose, onChanged, onDeleted }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null); // editable field values
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api(`/dsr/${dsrId}`);
      setReport(r);
      setDraft({
        submittedBy: r.submittedBy || "",
        ...Object.fromEntries(DSR_TEXT_FIELDS.map((f) => [f.key, r[f.key] || ""])),
      });
    } catch (e) {
      setError(e.message);
    }
  }, [dsrId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!report) return;
    let cancelled = false;
    report.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/dsr/${report.id}/attachments/${a.id}`).then((url) => {
        if (!cancelled) setThumbs((t) => ({ ...t, [a.id]: url }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.attachments]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  const editable = !isViewer && report && (report.status === "Draft" || report.status === "Submitted");

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function saveEdit() {
    await guard(async () => {
      const payload = {
        submittedBy: (draft.submittedBy || "").trim(),
        ...Object.fromEntries(DSR_TEXT_FIELDS.map((f) => [f.key, (draft[f.key] || "").trim()])),
      };
      await api(`/dsr/${dsrId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await reload();
    });
  }

  async function submitReport() {
    if (!confirm("Submit this report for approval? You won't be able to make further edits unless it's reopened.")) return;
    await guard(async () => {
      await api(`/dsr/${dsrId}/submit`, { method: "POST" });
      await reload();
    });
  }

  async function approve() {
    await guard(async () => {
      await api(`/dsr/${dsrId}/approve`, { method: "POST" });
      await reload();
    });
  }

  async function reject() {
    const reason = prompt("Reason for rejection (optional):") || "";
    await guard(async () => {
      await api(`/dsr/${dsrId}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
      await reload();
    });
  }

  async function reopen() {
    if (!confirm("Reopen this report for editing? Its approval status will be cleared.")) return;
    await guard(async () => {
      await api(`/dsr/${dsrId}/reopen`, { method: "POST" });
      await reload();
    });
  }

  async function deleteReport() {
    if (!confirm("Delete this report permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/dsr/${dsrId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/dsr/${dsrId}/attachments`, file);
      await reload();
    });
  }

  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/dsr/${dsrId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }

  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/dsr/${dsrId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }

  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/dsr/${dsrId}/report.pdf`);
      downloadBlobUrl(url, `${report.code}-daily-security-report.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Daily Security Report</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">{error}</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  if (!report || !draft) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Daily Security Report</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const r = report;

  const renderField = (label, key, full) => (
    <div className={`form-field${full ? " full" : ""}`} key={key}>
      <label>{label}</label>
      {editable
        ? <textarea value={draft[key]} onChange={(e) => setField(key, e.target.value)} />
        : <div style={{ whiteSpace: "pre-wrap", fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(r[key] || "") || "—"}</div>}
    </div>
  );

  return (
    <div className="modal-overlay active">
      <div className="modal">
        <div className="modal-header">
          <h2>{r.code} — {r.date}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <span className={`badge ${dsrStatusBadgeClass(r.status)}`} style={{ fontSize: 12 }}>{r.status}</span>
            <span className="chip">{r.site || "—"}</span>
            <span className="chip">{r.shift || "—"}</span>
            {r.submittedBy && <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Submitted by {r.submittedBy}</span>}
            {r.approvedBy && (
              <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
                {r.status === "Rejected" ? "Rejected" : "Approved"} by {r.approvedBy} on {new Date(r.approvedAt).toLocaleDateString()}
              </span>
            )}
          </div>

          <div className="form-grid">
            {renderField("Submitted by", "submittedBy", false)}
            {DSR_TEXT_FIELDS.map((f) => renderField(f.label, f.key, f.full))}
          </div>

          <div className="section-divider">Attachments</div>
          <div className="attach-grid">
            {r.attachments.map((a) => (
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
          {r.attachments.length === 0 && <div className="empty-hint">No photos or documents attached yet.</div>}
          {!isViewer && (
            <>
              <label className="upload-drop" htmlFor="dsrAttachFileInput">
                <div>Click to upload a photo or document</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
              </label>
              <input type="file" id="dsrAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          {editable && <button className="btn btn-secondary" onClick={saveEdit} disabled={busy}>Save changes</button>}
          {!isViewer && r.status === "Draft" && <button className="btn btn-primary" onClick={submitReport} disabled={busy}>Submit for approval</button>}
          {isAdmin && r.status === "Submitted" && <button className="btn btn-primary" onClick={approve} disabled={busy}>Approve</button>}
          {isAdmin && r.status === "Submitted" && <button className="btn btn-danger" onClick={reject} disabled={busy}>Reject</button>}
          {isAdmin && (r.status === "Approved" || r.status === "Rejected") && <button className="btn btn-secondary" onClick={reopen} disabled={busy}>Reopen for editing</button>}
          {isAdmin && <button className="btn btn-danger" onClick={deleteReport} disabled={busy}>Delete report</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
