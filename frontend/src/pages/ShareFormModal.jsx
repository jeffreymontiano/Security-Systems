import { useEffect, useState } from "react";
import { api } from "../api/client";

/** "Share report link" modal for the public incident-report form (Admin only). */
export default function ShareFormModal({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api("/auth/public-form-link").then(setData).catch((e) => setError(e.message));
  }, []);

  function copyLink() {
    if (!data?.url) return;
    navigator.clipboard.writeText(data.url).then(() => setCopied(true)).catch(() => setCopied(true));
  }

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h2>Incident report form link</h2>
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
                Anyone with this link can submit an incident report without logging in.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="text" readOnly value={data.url} style={{ flex: 1, fontSize: 12.5 }} onFocus={(e) => e.target.select()} />
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
