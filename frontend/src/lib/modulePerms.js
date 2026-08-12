import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Reads the CURRENT user's per-module Add / Edit / Delete privileges — the
 * matrix an administrator sets in Manage Users — for the module the user is
 * looking at.
 *
 * Why this exists. The privileges were already saved, already delivered to the
 * browser by /auth/my-permissions, and already enforced by the API. The one
 * broken link was the UI: pages gated their buttons on the ROLE flags
 * (`isViewer` / `isAdmin`), which cannot see a per-user override. So a user
 * denied Add still saw the button and got a 403 on click, and a user granted
 * Add never saw it at all. This hook is what a page gates on instead.
 *
 * It is for HIDING a control that would be refused — never for authorising one.
 * The server re-checks every write independently (`modulePermission()` wraps
 * each router in server.js), and a hidden button has never been the protection.
 */

// Route -> the module key the permission matrix uses. The keys must match
// MODULE_KEYS in src/lib/permissions.js exactly; a typo would silently read as
// "no privileges" and hide every control on that page. The verification suite
// asserts both directions of this map against the server's own catalogue.
//
// `null` means the route has no module in the matrix and stays governed by the
// role checks it already uses:
//   /live-feed   restricted by role (Owner / Admin), not by the matrix
export const ROUTE_MODULE = {
  "/201-file": "employees",
  "/attendance": "attendance",
  "/leave": "leave",
  "/payroll": "payroll",
  "/billing": "billing",
  "/assets": "assets",
  "/recruitment": "recruitment",
  "/dashboard": "dashboard",
  "/incidents": "incidents",
  "/deployment": "deployment",
  "/scheduling": "scheduling",
  "/dsr": "dsr",
  "/security-reports": "securityReports",
  "/disciplinary": "disciplinary",
  "/performance": "performance",
  "/training": "training",
  "/compliance": "compliance",
  "/useful-links": "usefulLinks",
  "/executive-summary": "executive",
  "/manage-users": "users",
  "/manage-lists": "lists",
  "/system-settings": "settings",
  "/live-feed": null,
};

// Nested routes ("/incidents/42") resolve to their base module, the same way
// ModuleHeader resolves its icon.
export function moduleKeyForPath(pathname) {
  const first = "/" + String(pathname || "").split("/").filter(Boolean)[0];
  return first === "/" ? null : (ROUTE_MODULE[first] ?? null);
}

/**
 * `{ key, add, edit, delete: … }` for the current route, or for `explicitKey`
 * when a component sits outside its module's route (a modal rendered from
 * elsewhere, say).
 *
 * When the route has no module key, every action comes back `null` rather than
 * `false` — a page can then tell "not governed by the matrix" apart from
 * "governed and denied", and keep its existing role gate instead of silently
 * hiding its controls.
 */
export default function useModulePerms(explicitKey) {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const key = explicitKey || moduleKeyForPath(pathname);

  return useMemo(() => ({
    key,
    add: key ? can(key, "add") : null,
    edit: key ? can(key, "edit") : null,
    delete: key ? can(key, "delete") : null,
  }), [key, can]);
}
