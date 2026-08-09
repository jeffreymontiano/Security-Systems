import { useCallback, useEffect, useRef, useState } from "react";
import { setPromptOpener } from "../lib/prompt";

// Serves every `prompt()` call. Mounted once, in AppShell, and renders nothing
// until something asks. See lib/prompt.js for the return contract, which is
// window.prompt's and must stay that way.
export default function PromptHost() {
  const [pending, setPending] = useState(null);
  const [value, setValue] = useState("");
  const resolve = useRef(null);
  const inputRef = useRef(null);
  const restoreTo = useRef(null);

  const settle = useCallback((answer) => {
    setPending(null);
    setValue("");
    const r = resolve.current;
    resolve.current = null;
    if (r) r(answer);
    // Put focus back where it was, the way a dialog should.
    const back = restoreTo.current;
    restoreTo.current = null;
    if (back && typeof back.focus === "function") {
      try { back.focus({ preventScroll: true }); } catch { /* gone from the DOM */ }
    }
  }, []);

  useEffect(() => {
    setPromptOpener((opts) => new Promise((res) => {
      if (resolve.current) resolve.current(null);
      resolve.current = res;
      restoreTo.current = document.activeElement;
      setValue(opts.defaultValue ?? "");
      setPending(opts);
    }));
    return () => {
      setPromptOpener(null);
      if (resolve.current) { resolve.current(null); resolve.current = null; }
    };
  }, []);

  // Focus the field and select what is in it, so typing replaces the default —
  // which is what window.prompt does, and what a rename most often wants.
  useEffect(() => {
    if (!pending) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (typeof el.select === "function") el.select();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); settle(null); return; }
      // Tab is trapped between the field and the two buttons.
      if (e.key !== "Tab") return;
      const root = document.getElementById("prompt-dialog");
      if (!root) return;
      const items = [...root.querySelectorAll("input, textarea, button")].filter((n) => !n.disabled);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  if (!pending) return null;
  const { message, title, confirmLabel = "OK", cancelLabel = "Cancel", multiline } = pending;

  return (
    <div className="modal-overlay active" onClick={() => settle(null)} role="presentation">
      <form
        id="prompt-dialog"
        className="modal"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
        // role is declared here so DialogBehavior leaves this alone: it manages
        // its own focus and Escape, and being enhanced twice would double them.
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        onSubmit={(e) => { e.preventDefault(); settle(value); }}
      >
        <div className="modal-header">
          <h2 id="prompt-dialog-title">{title || "Enter a value"}</h2>
          <button type="button" className="modal-close" onClick={() => settle(null)} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-field full">
            <label htmlFor="prompt-dialog-input">{message}</label>
            {multiline ? (
              <textarea
                id="prompt-dialog-input"
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            ) : (
              <input
                id="prompt-dialog-input"
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={() => settle(null)}>
            {cancelLabel}
          </button>
          {/* Submitting the form is what Enter in the field already does, so
              there is one path in rather than two that can drift. */}
          <button type="submit" className="btn btn-primary">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
