import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { fileIcon } from "./incidentShared";
import { DA_STAGES } from "./disciplinaryShared";

/**
 * Disciplinary case detail modal. Mirrors the legacy #disciplinaryDetailModalOverlay:
 * a workflow stepper (Open → Under Review → Resolved → Closed; only an Admin can
 * move a case to Closed) over five structured HR sections. Fields are editable
 * unless the viewer is read-only or the case is Closed (the backend also blocks
 * edits on Closed). Includes attachments, a PDF report, and Admin delete.
 */
/**
 * Which date fields a penalty uses, and what they are called.
 *
 * `suspensionStart` is the UNIVERSAL "effective from" date for every penalty
 * that has one; `suspensionEnd` belongs to Suspension alone. Both columns
 * already existed -- an RTU and a Termination reuse the start column rather
 * than gaining one of their own, because three columns meaning "the date this
 * penalty takes effect" could only ever disagree.
 *
 * A penalty absent from this map carries no dates at all (None, Verbal
 * Warning, Written Warning), and saveEdit() writes NULL to both for it.
 */
const PENALTY_DATES = {
  Suspension:  { start: "Suspension start", end: "Suspension end" },
  RTU:         { start: "RTU date",         end: null },
  Termination: { start: "Termination date", end: null },
};

export default function DisciplinaryDetailModal({ caseId, isViewer, isAdmin, canDelete = false, violationTypes, penaltyTypes, onClose, onChanged, onDeleted }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/disciplinary/${caseId}`);
      setC(data);
      setDraft({
        employeeName: data.employeeName || "",
        violationType: data.violationType || "",
        violationDate: data.violationDate || "",
        description: data.description || "",
        nteDate: data.nteDate || "",
        nteDetails: data.nteDetails || "",
        employeeExplanation: data.employeeExplanation || "",
        hearingDate: data.hearingDate || "",
        hearingNotes: data.hearingNotes || "",
        penalty: data.penalty || "",
        suspensionStart: data.suspensionStart || "",
        suspensionEnd: data.suspensionEnd || "",
      });
    } catch (e) {
      setError(e.message);
    }
  }, [caseId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    if (!c) return;
    let cancelled = false;
    c.attachments.filter((a) => /^image\//.test(a.mimetype)).forEach((a) => {
      apiBlobUrl(`/disciplinary/${c.id}/attachments/${a.id}`).then((url) => {
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

  const editable = !isViewer && c && c.status !== "Closed";

  // Which date fields this case's penalty uses. Null for a penalty with none,
  // and null before the case has loaded.
  const penaltyDates = draft ? (PENALTY_DATES[draft.penalty] || null) : null;

  function setField(key, value) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // A date field the new penalty does not use must not keep a value from
      // the old one: a suspensionEnd left over from a Suspension would give an
      // RTU a range it does not have, and the DTR reads these dates.
      if (key === "penalty") {
        const spec = PENALTY_DATES[value];
        if (!spec) { next.suspensionStart = ""; next.suspensionEnd = ""; }
        else if (!spec.end) { next.suspensionEnd = ""; }
      }
      return next;
    });
  }

  async function saveEdit() {
    await guard(async () => {
      const payload = {
        employeeName: draft.employeeName.trim(),
        violationDate: draft.violationDate,
        description: draft.description.trim(),
        nteDate: draft.nteDate || null,
        nteDetails: draft.nteDetails.trim(),
        employeeExplanation: draft.employeeExplanation.trim(),
        hearingDate: draft.hearingDate || null,
        hearingNotes: draft.hearingNotes.trim(),
        // Derived from the penalty rather than sent blind, so a value left on a
        // hidden field -- by legacy data, or by a penalty changed in another
        // session -- can never be written. The clear in setField keeps the form
        // honest; this keeps the RECORD honest.
        suspensionStart: penaltyDates ? (draft.suspensionStart || null) : null,
        suspensionEnd: penaltyDates?.end ? (draft.suspensionEnd || null) : null,
        violationType: draft.violationType,
        penalty: draft.penalty,
      };
      // A Termination penalty ends the employment, so the route REFUSES the save
      // with 409 until the intent is explicit. Ask, then retry with the
      // acknowledgement -- rather than pre-empting with a dialog the server
      // might not have wanted, which would train people to click through it.
      try {
        await api(`/disciplinary/${caseId}`, { method: "PATCH", body: JSON.stringify(payload) });
      } catch (e) {
        if (!/terminated and remove them from every roster/i.test(e.message || "")) throw e;
        if (!window.confirm(`${e.message}

This cannot be undone from this screen.`)) return;
        await api(`/disciplinary/${caseId}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, confirmTermination: true }),
        });
      }
      await reload();
    });
  }

  async function setStage(stage) {
    await guard(async () => {
      await api(`/disciplinary/${caseId}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      await reload();
    });
  }

  async function deleteCase() {
    if (!confirm("Delete this disciplinary case permanently? This cannot be undone.")) return;
    await guard(async () => {
      await api(`/disciplinary/${caseId}`, { method: "DELETE" });
      onDeleted();
    });
  }

  async function uploadAttachment(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await guard(async () => {
      await apiUpload(`/disciplinary/${caseId}/attachments`, file);
      await reload();
    });
  }

  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment?")) return;
    await guard(async () => {
      await api(`/disciplinary/${caseId}/attachments/${attId}`, { method: "DELETE" });
      await reload();
    });
  }

  async function viewAttachment(attId) {
    await guard(async () => {
      const url = await apiBlobUrl(`/disciplinary/${caseId}/attachments/${attId}`);
      window.open(url, "_blank");
    });
  }

  async function downloadReport() {
    await guard(async () => {
      const url = await apiBlobUrl(`/disciplinary/${caseId}/report.pdf`);
      downloadBlobUrl(url, `${c.code}-disciplinary-case.pdf`);
    });
  }

  if (error) {
    return (
      <div className="modal-overlay active">
        <div className="modal">
          <div className="modal-header"><h2>Disciplinary Case</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
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
          <div className="modal-header"><h2>Disciplinary Case</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body"><div className="empty-hint">Loading...</div></div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const stageIdx = DA_STAGES.indexOf(c.status);

  // Editable text/date field, or read-only display when locked.
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
  const selectField = (label, key, options) => (
    <div className="form-field">
      <label>{label}</label>
      {editable
        ? <select value={draft[key]} onChange={(e) => setField(key, e.target.value)}>
            {/* include the current value even if it's no longer in the list */}
            {!options.includes(draft[key]) && draft[key] ? <option>{draft[key]}</option> : null}
            {options.map((o) => <option key={o}>{o}</option>)}
          </select>
        : <div style={{ fontSize: 13, padding: "6px 0", color: "var(--text)" }}>{(c[key] || "") || "—"}</div>}
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
            {DA_STAGES.map((s, idx) => {
              let cls = "";
              if (idx < stageIdx) cls = "done";
              else if (idx === stageIdx) cls = "current";
              const canClick = editable && !(s === "Closed" && !isAdmin);
              return (
                <div
                  className={`step ${cls}`}
                  key={s}
                  onClick={canClick ? () => setStage(s) : undefined}
                  title={`Set status to ${s}`}
                  style={canClick ? undefined : { cursor: "default" }}
                >
                  <div className="step-line"></div>
                  <div className="step-dot">{idx < stageIdx ? "\u2713" : idx + 1}</div>
                  <div className="step-label">{s}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "16px 0" }}>
            <span className="chip">{c.site || "—"}</span>
            <span className="chip">{c.violationType || "—"}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Violation date: {c.violationDate}</span>
          </div>

          <div className="section-divider" style={{ marginTop: 0 }}>Violation</div>
          <div className="form-grid">
            {field("Employee name", "employeeName")}
            {selectField("Violation type", "violationType", violationTypes)}
            {field("Violation date", "violationDate", "date")}
            {textField("Violation description", "description")}
          </div>

          <div className="section-divider">Notice to Explain (NTE)</div>
          <div className="form-grid">
            {field("NTE date", "nteDate", "date")}
            {textField("NTE details", "nteDetails")}
          </div>

          <div className="section-divider">Employee Explanation</div>
          <div className="form-grid">
            {textField("Explanation submitted", "employeeExplanation")}
          </div>

          <div className="section-divider">Administrative Hearing</div>
          <div className="form-grid">
            {field("Hearing date", "hearingDate", "date")}
            {textField("Hearing notes", "hearingNotes")}
          </div>

          <div className="section-divider">Penalty</div>
          <div className="form-grid">
            {selectField("Penalty", "penalty", penaltyTypes)}
            {penaltyDates && field(penaltyDates.start, "suspensionStart", "date")}
            {penaltyDates?.end && field(penaltyDates.end, "suspensionEnd", "date")}
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
          {!isViewer && c.status !== "Closed" && (
            <>
              <label className="upload-drop" htmlFor="daAttachFileInput">
                <div>Click to upload a supporting document</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Images, PDF, Word, or text files · up to 8MB</div>
              </label>
              <input type="file" id="daAttachFileInput" style={{ display: "none" }} onChange={uploadAttachment} accept="image/*,application/pdf,.doc,.docx,.txt" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" style={{ color: "var(--navy)", borderColor: "var(--border)" }} onClick={downloadReport} disabled={busy}>Download PDF report</button>
          {editable && <button className="btn btn-secondary" onClick={saveEdit} disabled={busy}>Save changes</button>}
          <div style={{ flex: 1 }}></div>
          {canDelete && <button className="btn btn-danger" onClick={deleteCase} disabled={busy}>Delete case</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
