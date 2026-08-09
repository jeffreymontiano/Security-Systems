import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmModal from "./ConfirmModal";
import { setConfirmOpener } from "../lib/confirm";

// Serves every `confirm()` call in the app. Mounted once, in AppShell, and
// renders nothing until something asks. See lib/confirm.js for why this is a
// single host rather than a hook used at 16 call sites.
export default function ConfirmHost() {
  const [pending, setPending] = useState(null);
  // Resolving is an event, not something to render.
  const resolve = useRef(null);

  const settle = useCallback((answer) => {
    setPending(null);
    const r = resolve.current;
    resolve.current = null;
    if (r) r(answer);
  }, []);

  useEffect(() => {
    setConfirmOpener((opts) => new Promise((res) => {
      // If a previous dialog somehow never settled, settle it false rather than
      // leaving its caller awaiting forever.
      if (resolve.current) resolve.current(false);
      resolve.current = res;
      setPending(opts);
    }));
    return () => {
      setConfirmOpener(null);
      if (resolve.current) { resolve.current(false); resolve.current = null; }
    };
  }, []);

  if (!pending) return null;
  return (
    <ConfirmModal
      {...pending}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
