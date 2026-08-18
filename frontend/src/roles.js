// Role KEYS the UI needs to test against, mirrored from src/lib/permissions.js
// (the frontend is a separate Vite build and cannot import from src/).
//
// These are the stored strings — what lives in users.role, what the
// users_role_check constraint allows, and what every requireRole() call
// compares. They are NOT display names: "Admin" shows as "System
// Administrator" via ROLE_LABELS, and the two must never be confused.
//
// Hiding a nav item with these is a convenience, never the access control.
// The server re-checks independently on every request.
export const OWNER_ROLE = "Owner / President / General Manager";

// Who may correct the SITE or RECORD type on an attendance punch. Mirrors
// ATTENDANCE_EDIT_ROLES in src/lib/permissions.js, which is what ENFORCES it —
// this copy only decides whether to draw the button.
//
// An explicit allowlist rather than the Add/Edit/Delete matrix: editing a
// punch's site moves billable hours between CLIENTS, and four roles hold edit
// on attendance that must not have it.
//
// PENDING GRANT: "Owner / President / General Manager" is to be added here and
// in permissions.js together, alongside its other pending access (Executive
// Summary and Live Feed). The role already exists — it is assignable today — so
// this is an exclusion in force, not a placeholder.
export const ATTENDANCE_EDIT_ROLES = [
  "Admin",
  "Operation Manager / Operation Officer / Supervisor",
];
