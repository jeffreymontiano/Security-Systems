import { useEffect, useRef } from "react";

// A replacement for the 26 `window.confirm()` calls scattered across 16 pages.
//
// State-driven React, styled with the app's existing modal classes — no
// Bootstrap JS, no `data-bs-*`. `window.confirm` blocks the main thread, cannot
// be styled, cannot say WHY an action is destructive, and on a slow delete gives
// no way to show progress. This can do all three.
//
// Deliberately uncontrolled about the outcome: it calls back and lets the page
// own the async work, because the pages already handle their own errors.

/**
 *   const [confirming, setConfirming] = useState(null);
 *   ...
 *   {confirming && (
 *     <ConfirmModal
 *       title="Delete this draft return?"
 *       body="Everything on it goes with it. This cannot be undone."
 *       confirmLabel="Delete draft"
 *       tone="danger"
 *       busy={busy}
 *       onConfirm={async () => { await remove(confirming); setConfirming(null); }}
 *       onCancel={() => setConfirming(null)}
 *     />
 *   )}
 */
export default function ConfirmModal({
  title = "Are you sure?",
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",          // "danger" | "gold" | "primary"
  busy = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  // Focus lands on CANCEL, not on the destructive button: a stray Enter after
  // opening a delete dialog should not delete anything.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  // Escape closes, and Tab is trapped inside the dialog so keyboard focus
  // cannot wander into the page behind it while it is open.
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) { e.preventDefault(); onCancel?.(); return; }
      if (e.key !== "Tab") return;
      const a = cancelRef.current, b = confirmRef.current;
      if (!a || !b) return;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const confirmClass =
    tone === "gold" ? "btn btn-gold" : tone === "primary" ? "btn btn-primary" : "btn btn-danger";

  return (
    <div
      className="modal-overlay is-app-dialog active"
      // Clicking the backdrop cancels, but never mid-action.
      onClick={() => { if (!busy) onCancel?.(); }}
      role="presentation"
    >
      <div
        className="modal"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby={body ? "confirm-modal-body" : undefined}
      >
        <div className="modal-header">
          <h2 id="confirm-modal-title">{title}</h2>
          <button
            className="modal-close"
            onClick={() => onCancel?.()}
            disabled={busy}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {body && (
          <div className="modal-body" id="confirm-modal-body" style={{ fontSize: 13.5, lineHeight: 1.7 }}>
            {body}
          </div>
        )}

        <div className="modal-footer">
          <button ref={cancelRef} className="btn btn-secondary" onClick={() => onCancel?.()} disabled={busy}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} className={confirmClass} onClick={() => onConfirm?.()} disabled={busy}>
            {busy && <span className="spinner-border spinner-border-sm" aria-hidden="true" />}
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
