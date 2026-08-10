import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

// Change your own password. Available from every module header, because it is
// rendered once inside ModuleHeader rather than per page.
//
// The endpoint takes no user id: the account changed is always the one the
// token identifies, so this screen cannot be pointed at somebody else.
//
// `forced` is the after-a-reset case — an administrator issued a temporary
// password and the account must set its own before doing anything. That
// version cannot be dismissed.
export default function ChangePasswordModal({ forced = false, onClose, onChanged }) {
  const { logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  useEffect(() => {
    if (forced) return;                      // a forced change has no way out
    function onKey(e) { if (e.key === "Escape" && !busy) onClose?.(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [forced, busy, onClose]);

  // Checked here only to save a round trip and to say so beside the field; the
  // server enforces all of it independently.
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit = !busy && current && next.length >= 8 && next === confirm && !sameAsCurrent;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const r = await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setDone(true);
      onChanged?.();
      // Changing the password ends every session that predates it, this one
      // included. Rather than let the next request fail with a puzzling 401,
      // say so and send them back to the login screen.
      if (r && r.reauthenticate) setTimeout(() => logout(), 2200);
    } catch (err) {
      setError(err.message || "Could not change the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay is-app-dialog active"
      onClick={() => { if (!forced && !busy && !done) onClose?.(); }}
      role="presentation"
    >
      <form
        className="modal"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chpw-title"
      >
        <div className="modal-header">
          <h2 id="chpw-title">{forced ? "Set a new password" : "Change password"}</h2>
          {!forced && (
            <button type="button" className="modal-close" onClick={() => onClose?.()} disabled={busy} aria-label="Close">
              &times;
            </button>
          )}
        </div>

        <div className="modal-body">
          {done ? (
            <div className="empty-hint" style={{ padding: "10px 0", fontStyle: "normal" }}>
              <i className="bi bi-check-circle-fill" style={{ color: "var(--teal)" }} aria-hidden="true" />{" "}
              Password changed. You will be signed out so you can log in with it.
            </div>
          ) : (
            <>
              {forced && (
                <div className="empty-hint" style={{ marginBottom: 12, fontStyle: "normal" }}>
                  An administrator reset your password. Choose your own before continuing.
                </div>
              )}
              {error && (
                <div className="empty-hint" style={{ color: "var(--red)", marginBottom: 10, fontStyle: "normal" }}>
                  {error}
                </div>
              )}

              <div className="form-field full">
                <label htmlFor="chpw-current">{forced ? "Temporary password" : "Current password"}</label>
                <input
                  id="chpw-current" ref={firstRef} type="password" autoComplete="current-password"
                  value={current} onChange={(e) => setCurrent(e.target.value)}
                />
              </div>
              <div className="form-field full" style={{ marginTop: 10 }}>
                <label htmlFor="chpw-new">
                  New password <span className="hint">at least 8 characters</span>
                </label>
                <input
                  id="chpw-new" type="password" autoComplete="new-password"
                  value={next} onChange={(e) => setNext(e.target.value)}
                  aria-invalid={tooShort || sameAsCurrent ? "true" : undefined}
                />
                {tooShort && <span className="hint" style={{ color: "var(--red)" }}>Too short.</span>}
                {sameAsCurrent && (
                  <span className="hint" style={{ color: "var(--red)" }}>
                    That is the password you are already using.
                  </span>
                )}
              </div>
              <div className="form-field full" style={{ marginTop: 10 }}>
                <label htmlFor="chpw-confirm">Confirm new password</label>
                <input
                  id="chpw-confirm" type="password" autoComplete="new-password"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  aria-invalid={mismatch ? "true" : undefined}
                />
                {mismatch && <span className="hint" style={{ color: "var(--red)" }}>The two do not match.</span>}
              </div>
            </>
          )}
        </div>

        {!done && (
          <div className="modal-footer">
            {!forced && (
              <button type="button" className="btn btn-secondary" onClick={() => onClose?.()} disabled={busy}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {busy ? "Changing…" : "Change password"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
