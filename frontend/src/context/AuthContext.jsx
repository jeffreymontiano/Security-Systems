import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api, setToken, getToken, AuthError } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // "checking" | "authed" | "guest" — avoids flashing the login screen while
  // we're still asking the server whether an existing token is still valid.
  const [status, setStatus] = useState("checking");
  // The signed-in user's effective Add/Edit/Delete matrix, as resolved by the
  // SERVER. Loaded alongside the session; null until it arrives.
  const [permissions, setPermissions] = useState(null);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setPermissions(null);
    setStatus("guest");
  }, []);

  // Fetched, never inferred from the role in the browser: the server owns
  // the resolution, and a copy of those rules here could drift from it.
  const loadPermissions = useCallback(() => {
    api("/auth/my-permissions")
      .then((d) => setPermissions(d && d.permissions ? d.permissions : {}))
      .catch(() => setPermissions({}));   // fail closed: offer nothing
  }, []);

  // May this user do `action` in `moduleKey`? Used to hide a control, never
  // to authorise: the API re-checks every write regardless.
  const canDo = useCallback((moduleKey, action) => {
    if (user?.role === "Admin") return true;
    if (!permissions) return false;       // unknown yet -> do not offer
    const g = permissions[moduleKey];
    return !!(g && g[action]);
  }, [permissions, user]);

  useEffect(() => {
    if (!getToken()) {
      setStatus("guest");
      return;
    }
    api("/auth/me")
      .then((body) => {
        setUser(body.user);
        setStatus("authed");
        // Restoring a session must load the matrix too, or a refreshed tab
        // would offer nothing until the next login.
        loadPermissions();
      })
      .catch(() => {
        setToken(null);
        setStatus("guest");
      });
  }, [loadPermissions]);

  const login = useCallback(async (username, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Login failed.");
    setToken(body.token);
    setUser(body.user);
    setStatus("authed");
    loadPermissions();
    return body.user;
  }, [loadPermissions]);

  // Any api() call can throw AuthError on a stale/expired token; components
  // can call this from a catch block instead of duplicating the logout logic.
  const handleAuthError = useCallback((err) => {
    if (err instanceof AuthError) {
      logout();
      return true;
    }
    return false;
  }, [logout]);

  const value = {
    user,
    status,
    isViewer: user?.role === "Viewer",
    isAdmin: user?.role === "Admin",
    // What this user may add / edit / delete, per module, as the SERVER
    // resolves it. Used only to avoid offering an action that would be
    // refused — the backend decides independently on every write, and a
    // hidden button is not security.
    permissions,
    can: canDo,
    login,
    logout,
    handleAuthError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
