import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

// Global branding settings (company name + logo), loaded once when the app
// mounts and exposed to every module via useSettings(). Mirrors AuthContext's
// shape. After an Admin saves changes, they call refresh() so the new branding
// shows immediately for them; everyone else picks it up on their next load.
const SettingsContext = createContext(null);

const DEFAULT_NAME = "Brookside Farms Corporation";

export function SettingsProvider({ children }) {
  const [companyName, setCompanyName] = useState(DEFAULT_NAME);
  const [hasLogo, setHasLogo] = useState(false);
  // Cache-busting token: appended to the logo URL so the <img> refetches after
  // the logo changes instead of showing a stale cached image.
  const [logoVersion, setLogoVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await api("/settings");
      setCompanyName(s.companyName || DEFAULT_NAME);
      setHasLogo(!!s.hasLogo);
      setLogoVersion(s.logoVersion || 0);
    } catch {
      // On failure, keep the defaults so the app still renders branded text.
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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
