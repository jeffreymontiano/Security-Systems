const API_BASE = "/api";

function getToken() {
  return sessionStorage.getItem("csoms_token");
}
export function setToken(token) {
  if (token) sessionStorage.setItem("csoms_token", token);
  else sessionStorage.removeItem("csoms_token");
}

// Thrown when a request comes back 401, so callers/AuthContext can react
// (e.g. bounce to the login screen) without every call site checking status.
export class AuthError extends Error {}

/**
 * Generic JSON request helper. Mirrors the old vanilla `api()` function:
 * attaches the bearer token, throws on non-2xx with the server's error
 * message, and throws AuthError specifically on 401 so callers can
 * distinguish "not logged in" from "bad request."
 */
export async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(API_BASE + path, { ...opts, headers });

  if (res.status === 401) {
    setToken(null);
    throw new AuthError("Your session expired. Please log in again.");
  }

  let body = null;
  try { body = await res.json(); } catch { /* no body */ }

  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

/**
 * Multipart file upload helper (attachments). Doesn't set Content-Type —
 * the browser sets the multipart boundary automatically for FormData.
 */
export async function apiUpload(path, file, extraFields = {}) {
  const formData = new FormData();
  formData.append("file", file);
  Object.entries(extraFields).forEach(([k, v]) => formData.append(k, v));

  const token = getToken();
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(API_BASE + path, { method: "POST", headers, body: formData });

  if (res.status === 401) {
    setToken(null);
    throw new AuthError("Your session expired. Please log in again.");
  }
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((body && body.error) || "Upload failed.");
  return body;
}

/**
 * Fetches a binary response (attachment view, PDF report) as a blob URL,
 * since these endpoints need the Authorization header, which plain <a href>
 * or <img src> can't attach.
 */
export async function apiBlobUrl(path) {
  const token = getToken();
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) {
    setToken(null);
    throw new AuthError("Your session expired. Please log in again.");
  }
  if (!res.ok) throw new Error("Could not load file.");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function downloadBlobUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { getToken };
