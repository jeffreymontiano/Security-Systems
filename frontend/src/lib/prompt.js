// A promise-returning replacement for `window.prompt`.
//
// The last native browser dialog in the app. Four call sites — two rejection
// reasons, an asset rename, and a leave-credit adjustment — all of the same
// shape, so adoption is one word per site and the surrounding logic is
// untouched.
//
// The RETURN CONTRACT is window.prompt's, exactly, because the call sites
// depend on it:
//
//   null    the user cancelled          (AssetsPage tests `!name`,
//   "..."   whatever they typed          LeaveManagement tests `raw == null`)
//
// Resolving "" instead of null on cancel would make LeaveManagement treat a
// cancelled credit edit as a deliberate blank and fall through, so this is not
// a detail to tidy up.
//
// The function lives here rather than beside the component because a module
// exporting both a component and a plain function breaks React Fast Refresh.

let opener = null;

// Called by <PromptHost/> on mount, and with null on unmount.
export function setPromptOpener(fn) {
  opener = fn;
}

/**
 *   const note = await prompt("Reason for rejection (optional):", "");
 *   if (note === null) return;            // cancelled
 *
 * Options are passed to the dialog: { title, confirmLabel, multiline, type }.
 */
export function prompt(message, defaultValue = "", options) {
  // No host mounted (a test, or something rendered outside the app shell):
  // fall back to the browser's own dialog, which has the same contract.
  if (!opener) return Promise.resolve(window.prompt(message, defaultValue));
  return opener({ message, defaultValue: defaultValue ?? "", ...(options || {}) });
}
