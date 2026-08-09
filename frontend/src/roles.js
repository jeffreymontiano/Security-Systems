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
