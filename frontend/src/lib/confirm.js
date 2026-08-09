// A drop-in, promise-returning replacement for `window.confirm`.
//
// Every one of the 26 confirms in this app is the same guard clause at the top
// of an async handler:
//
//     if (!window.confirm("Remove this shift assignment?")) return;
//     await api(...);
//
// so adoption is one word per site — `window.confirm(` becomes `await confirm(`
// — and the early return, the try/catch and the error handling around it are
// untouched. That mattered: rewriting 26 working flows into
// `setConfirming({...})` plus a callback would have been 26 chances to break a
// delete, all to arrive at the same dialog.
//
// Deliberately a module-level function served by ONE mounted host rather than a
// hook. A hook would need `const [confirm, dialog] = useConfirm()` plus a
// `{dialog}` slot inside all 16 components' render trees, several of which are
// nested sub-components — structural surgery on pages that work. This is the
// shape a toast library uses: import the function, call it from anywhere.
//
// The function lives here rather than beside the component because a module
// that exports both a component and a plain function breaks React Fast Refresh.

let opener = null;

// Called by <ConfirmHost/> on mount, and with null on unmount.
export function setConfirmOpener(fn) {
  opener = fn;
}

/**
 *   if (!(await confirm("Delete this draft?"))) return;
 *
 * A string is the message. An object is passed through to ConfirmModal, so a
 * destructive action can carry its own title and button wording:
 *
 *   await confirm({ title: "Delete this return?", body: "…", confirmLabel: "Delete", tone: "danger" })
 */
export function confirm(options) {
  const opts = typeof options === "string" ? { body: options } : (options || {});
  // No host mounted (a test, or something rendered outside the app shell):
  // fall back to the browser's own dialog rather than resolving true and
  // deleting something nobody agreed to.
  if (!opener) {
    return Promise.resolve(window.confirm(opts.body || opts.title || "Are you sure?"));
  }
  return opener(opts);
}
