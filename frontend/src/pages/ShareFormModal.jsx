import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * "Share form link" modal for the public submission forms (Admin only).
 * All share the same /auth/public-form-link endpoint, which returns one URL
 * per form.
 *
 * The incident report and Daily Security Report forms were WITHDRAWN: both are
 * now filed from inside CSOMS by an authenticated user, and their public routes
 * have been removed from src/routes/public.js. The five kinds below are what
 * remains — all of them things a guard genuinely needs without an account.
 */
const FORMS = {
  attendance: {
    urlKey: "attendanceUrl",
    heading: "Attendance form link",
    blurb: "Anyone with this link can submit a time IN/OUT record with a selfie and location, without logging in. Share it with your guards.",
  },
  leave: {
    urlKey: "leaveUrl",
    heading: "Leave request form link",
    blurb: "Anyone with this link can file a leave request without logging in. They enter their employee number to confirm their name and site, then submit for approval. Share it with your guards.",
  },
  missing: {
    urlKey: "missingUrl",
    heading: "Missing Time Log Request form link",
    blurb: "Anyone with this link can submit a Missing Time Log Request without logging in. They enter their employee number, pick the date and which log is missing, and explain why. An admin then reviews and corrects the attendance.",
  },
  myattendance: {
    urlKey: "myAttendanceUrl",
    heading: "My Attendance (self-service) link",
    blurb: "Anyone with this link can look up their own attendance for a date range (by employee number) and file a Missing Time Log Request for any problem date. They only ever see their own record.",
  },
  overtime: {
    urlKey: "overtimeUrl",
    heading: "Overtime Request form link",
    blurb: "Anyone with this link can file an Overtime Request without logging in. They enter their employee number, the date, how long they worked overtime, and why. An admin then reviews and approves the amount.",
  },
};

export default function ShareFormModal({ kind = "attendance", onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const form = FORMS[kind] || FORMS.attendance;
  const heading = form.heading;
  const blurb = form.blurb;

  useEffect(() => {
    api("/auth/public-form-link").then(setData).catch((e) => setError(e.message));
  }, []);

  const link = data ? data[form.urlKey] : null;

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
