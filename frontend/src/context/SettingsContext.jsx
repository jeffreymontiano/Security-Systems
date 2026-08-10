import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "./AuthContext";

// Global branding settings (company name + logo), loaded once when the app
// mounts and exposed to every module via useSettings(). Mirrors AuthContext's
// shape. After an Admin saves changes, they call refresh() so the new branding
// shows immediately for them; everyone else picks it up on their next load.
const SettingsContext = createContext(null);

// Empty, never a guessed agency name. This value is only ever on screen while
// /settings is in flight or after it failed, and a hardcoded name there is not
// a neutral placeholder — it is a DIFFERENT agency's name presented as this
// one's. Consumers render nothing rather than something wrong.
const DEFAULT_NAME = "";

export function SettingsProvider({ children }) {
  const { status } = useAuth();
  const [companyName, setCompanyName] = useState(DEFAULT_NAME);
  const [hasLogo, setHasLogo] = useState(false);
  // Cache-busting token: appended to the logo URL so the <img> refetches after
  // the logo changes instead of showing a stale cached image.
  const [logoVersion, setLogoVersion] = useState(0);

  // `path` differs by session state: a guest can only read the public subset,
  // which is all the login screen needs.
  const load = useCallback(async (path) => {
    try {
      const s = await api(path);
      setCompanyName(s.companyName || DEFAULT_NAME);
      setHasLogo(!!s.hasLogo);
      setLogoVersion(s.logoVersion || 0);
    } catch {
      // On failure, keep the defaults so the app still renders branded text.
    }
  }, []);

  // Kept for System Settings, which calls it after saving so the new branding
  // shows immediately for the admin who changed it.
  const refresh = useCallback(() => load("/settings"), [load]);

  // Re-read the branding whenever the session becomes authenticated, not just
  // once at mount.
  //
  // This provider mounts while the user is still a GUEST — the login screen is
  // rendered inside it — so the mount-time fetch has no bearer token, 401s, and
  // falls back to the default. Nothing then re-ran it after login, so anyone who
  // arrived at the login screen kept the fallback branding for their entire
  // session: the wrong agency name in the sidebar, every module header and every
  // page footer. A user whose session was restored from sessionStorage saw the
  // real branding, which is why it looked like a per-role problem.
  useEffect(() => {
    if (status === "authed") load("/settings");
    // The login screen is branded too, and its visitor has no token — so it
    // reads the public subset (name + whether a logo exists) instead.
    else if (status === "guest") load("/settings/public");
  }, [status, load]);

  // Full URL for the logo image, cache-busted by version. Null when no logo is
  // set, so consumers can fall back to the default mark.
  const logoUrl = hasLogo ? `/api/settings/logo?v=${logoVersion}` : null;

  const value = { companyName, hasLogo, logoUrl, logoVersion, refresh };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
