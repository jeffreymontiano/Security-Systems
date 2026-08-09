import { useEffect } from "react";

// Keyboard and screen-reader behaviour for every dialog in the app, applied in
// ONE place rather than at 68 call sites.
//
// There are 68 dialogs across 34 files and they are all the same shape:
//
//     <div className="modal-overlay active" onClick={onClose}>
//       <div className="modal" onClick={stopPropagation}>
//         <div className="modal-header"><h2>…</h2><button className="modal-close">×</button></div>
//
// and between them they carried `role="dialog"` exactly zero times. No focus
// trap, no focus restore, no Escape, and the page behind stayed scrollable.
// Converting all 68 to a shared <Modal> component would touch every page and
// restructure markup that works; this attaches the same behaviour to the markup
// that is already there, and covers any dialog added later for free.
//
// It does NOT invent a close path. Escape clicks the dialog's own
// `.modal-close`, so whatever that button already does — discard a draft, warn
// about unsaved edits — is what Escape does too, and there is no second copy of
// the close logic to drift.
//
// A dialog that already declares a `role` is left alone: ConfirmModal handles
// its own focus and Escape, and enhancing it twice would fire Cancel twice.
export default function DialogBehavior() {
  useEffect(() => {
    let current = null;      // the .modal element currently enhanced
    let restoreTo = null;    // what had focus before it opened
    let prevOverflow = "";
    let seq = 0;

    const FOCUSABLE = [
      "a[href]", "button:not([disabled])", "input:not([disabled])",
      "select:not([disabled])", "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");

    // The LAST one in document order is the topmost, which is what a nested
    // dialog needs — the first would trap focus in the one underneath.
    const topDialog = () => {
      const all = document.querySelectorAll(".modal-overlay.active > .modal");
      return all.length ? all[all.length - 1] : null;
    };

    function enhance(el) {
      current = el;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");

      // Name the dialog from its own heading, so it is announced as something
      // more useful than "dialog".
      const h = el.querySelector(".modal-header h2, .modal-header h1, .modal-header h3");
      if (h) {
        if (!h.id) h.id = `dlg-title-${++seq}`;
        el.setAttribute("aria-labelledby", h.id);
      }

      restoreTo = document.activeElement;
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      // Focus the first real control, or the dialog itself. Not the close
      // button by preference — landing on × makes Enter dismiss the thing the
      // user just opened.
      const first = el.querySelector(FOCUSABLE);
      const target = (first && !first.classList.contains("modal-close")) ? first : el;
      if (target === el && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      try { target.focus({ preventScroll: true }); } catch { /* focus is best-effort */ }
    }

    function release() {
      document.body.style.overflow = prevOverflow;
      // Only take focus back if it is still inside the dialog that closed —
      // otherwise the user has already moved on and we would yank them back.
      if (restoreTo && typeof restoreTo.focus === "function" &&
          (!document.activeElement || document.activeElement === document.body ||
           (current && current.contains(document.activeElement)))) {
        try { restoreTo.focus({ preventScroll: true }); } catch { /* gone from the DOM */ }
      }
      current = null;
      restoreTo = null;
    }

    function sync() {
      const el = topDialog();
      if (el === current) return;
      if (current) release();
      if (el && !el.getAttribute("role")) enhance(el);
      else current = el && el.getAttribute("role") ? null : current;
    }

    function onKeyDown(e) {
      if (!current || !document.contains(current)) return;

      if (e.key === "Escape") {
        const close = current.querySelector(".modal-close");
        if (close) { e.preventDefault(); close.click(); }
        return;
      }

      if (e.key !== "Tab") return;
      const items = [...current.querySelectorAll(FOCUSABLE)]
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("keydown", onKeyDown, true);
    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown, true);
      if (current) release();
    };
  }, []);

  return null;
}
