// Transient confirmations.
//
// The app had 187 `setError(...)` paths and ZERO success paths: it could tell
// you when something failed and never that it worked. A guard copies a roster
// and the screen just… redraws. The two `window.alert` calls in Scheduling were
// the only success feedback anywhere, and they blocked the thread to deliver it.
//
// This is for the "it worked" moment and nothing else. The 187 inline errors are
// deliberately left where they are: an error belongs next to the control that
// caused it, where it stays put while the user fixes the field. A toast that
// vanishes after four seconds is the wrong home for a validation message.
//
// The function lives here rather than beside the component because a module
// exporting both a component and a plain function breaks React Fast Refresh.

let emit = null;
let queued = [];

// Called by <ToastHost/> on mount, and with null on unmount.
export function setToastEmitter(fn) {
  emit = fn;
  if (fn && queued.length) {
    // Anything raised before the host mounted still gets shown.
    const pending = queued;
    queued = [];
    pending.forEach((t) => fn(t));
  }
}

function push(tone, message, options) {
  if (!message) return;
  const t = { tone, message, ...(options || {}) };
  if (emit) emit(t);
  else queued.push(t);
}

/**
 *   toast.success(`Copied ${n} assignment(s).`);
 *   toast.error("Could not reach the server.");
 *   toast.info("Nothing to copy — last week is empty.");
 */
export const toast = {
  success: (message, options) => push("success", message, options),
  error: (message, options) => push("error", message, options),
  info: (message, options) => push("info", message, options),
};

export default toast;
