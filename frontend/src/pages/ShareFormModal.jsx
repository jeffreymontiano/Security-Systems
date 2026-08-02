import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * "Share form link" modal for the public submission forms (Admin only).
 * Handles the incident report form (kind="incident", default), the Daily
 * Security Report form (kind="dsr"), the attendance form (kind="attendance"),
 * and the leave request form (kind="leave"). All share the same
 * /auth/public-form-link endpoint, which returns one URL per form.
 */
export default function ShareFormModal({ kind = "incident", onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const isDsr = kind === "dsr";
  const isAttendance = kind === "attendance";
  const isLeave = kind === "leave";
  const isMissing = kind === "missing";
  const isMyAttendance = kind === "myattendance";
  const heading = isMyAttendance
    ? "My Attendance (self-service) link"
    : isMissing
    ? "Missing Time Log Request form link"
    : isLeave
    ? "Leave request form link"
    : isAttendance
    ? "Attendance form link"
    : isDsr
    ? "Daily Security Report form link"
    : "Incident report form link";
  const blurb = isMyAttendance
    ? "Anyone with this link can look up their own attendance for a date range (by employee number) and file a Missing Time Log Request for any problem date. They only ever see their own record."
    : isMissing
    ? "Anyone with this link can submit a Missing Time Log Request without logging in. They enter their employee number, pick the date and which log is missing, and explain why. An admin then reviews and corrects the attendance."
    : isLeave
    ? "Anyone with this link can file a leave request without logging in. They enter their employee number to confirm their name and site, then submit for approval. Share it with your guards."
    : isAttendance
    ? "Anyone with this link can submit a time IN/OUT record with a selfie and location, without logging in. Share it with your guards."
    : isDsr
    ? "Anyone with this link can submit a Daily Security Report (saved as a draft) without logging in."
    : "Anyone with this link can submit an incident report without logging in.";

  useEffect(() => {
    api("/auth/public-form-link").then(setData).catch((e) => setError(e.message));
  }, []);

  const link = data
    ? (isMyAttendance ? data.myAttendanceUrl : isMissing ? data.missingUrl : isLeave ? data.leaveUrl : isAttendance ? data.attendanceUrl : isDsr ? data.dsrUrl : data.url)
    : null;

  function copyLink() {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setCopied(true));
  }

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h2>{heading}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint">{error}</div>}
          {!error && !data && <div className="empty-hint">Loading...</div>}
          {!error && data && !data.enabled && (
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text)" }}>
              Public forms are not enabled yet. To turn them on, set a <code>PUBLIC_FORM_TOKEN</code>{" "}
              environment variable on the server (Render &rarr; your service &rarr; Environment), then restart
              the service. Once set, come back here to get a shareable link.
            </p>
          )}
          {!error && data && data.enabled && (
            <>
              <p style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 10 }}>
                {blurb}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="text" readOnly value={link} style={{ flex: 1, fontSize: 12.5 }} onFocus={(e) => e.target.select()} />
                <button className="btn btn-primary btn-sm" onClick={copyLink}>Copy link</button>
              </div>
              {copied && <div style={{ fontSize: 12, color: "var(--blue-dark)", marginTop: 8 }}>Link copied to clipboard.</div>}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
