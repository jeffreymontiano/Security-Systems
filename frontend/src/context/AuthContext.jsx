import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api, setToken, getToken, AuthError } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // "checking" | "authed" | "guest" — avoids flashing the login screen while
  // we're still asking the server whether an existing token is still valid.
  const [status, setStatus] = useState("checking");

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setStatus("guest");
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setStatus("guest");
      return;
    }
    api("/auth/me")
      .then((body) => {
        setUser(body.user);
        setStatus("authed");
      })
      .catch(() => {
        setToken(null);
        setStatus("guest");
      });
  }, []);

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
    return body.user;
  }, []);

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
