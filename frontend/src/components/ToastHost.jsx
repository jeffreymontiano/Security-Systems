import { useCallback, useEffect, useRef, useState } from "react";
import { setToastEmitter } from "../lib/toast";

// Renders the toast stack. Mounted once, in AppShell. See lib/toast.js for why
// this exists at all and why the app's 187 inline errors were left alone.

const TONE = {
  success: { icon: "bi-check-circle-fill", role: "status", live: "polite", ms: 4000 },
  info: { icon: "bi-info-circle-fill", role: "status", live: "polite", ms: 4500 },
  // An error is announced assertively and stays roughly twice as long: it is
  // the one a user most needs time to read, and most needs to not miss.
  error: { icon: "bi-exclamation-triangle-fill", role: "alert", live: "assertive", ms: 8000 },
};

export default function ToastHost() {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const h = timers.current.get(id);
    if (h) { clearTimeout(h); timers.current.delete(id); }
  }, []);

  useEffect(() => {
    // Captured here rather than read as `timers.current` in the cleanup: the
    // ref could point somewhere else by the time cleanup runs.
    const pending = timers.current;
    setToastEmitter((t) => {
      const tone = TONE[t.tone] ? t.tone : "info";
      const id = ++seq.current;
      // Keep the stack short. Five is already more than anyone reads.
      setItems((list) => [...list, { ...t, tone, id }].slice(-5));
      const ms = t.duration ?? TONE[tone].ms;
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    });
    return () => {
      setToastEmitter(null);
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, [dismiss]);

  // The region exists even when empty, so a screen reader is already watching it
  // when the first message arrives — a live region added at the same moment as
  // its content is frequently not announced.
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((t) => {
        const cfg = TONE[t.tone];
        return (
          <div
            key={t.id}
            className={`toast-item toast-${t.tone} shadow-sm`}
            role={cfg.role}
            aria-live={cfg.live}
          >
            <i className={`bi ${cfg.icon}`} aria-hidden="true" />
            <div className="toast-message">{t.message}</div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}
