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
// OWNER was added here and in permissions.js TOGETHER, when the payroll override
// allowlists were wired. A role trusted to override a statutory contribution is
// not plausibly untrusted to correct a punch's site. Admin and the Operations
// role are unchanged; this was an addition.
export const ATTENDANCE_EDIT_ROLES = [
  "Admin",
  "Operation Manager / Operation Officer / Supervisor",
  OWNER_ROLE,
];

// Who may correct a computed payslip figure, and who may reopen a PAID period
// so it can be corrected at all. Mirrors PAYROLL_OVERRIDE_ROLES /
// PAYROLL_STATUTORY_OVERRIDE_ROLES / PAYROLL_REOPEN_ROLES in
// src/lib/permissions.js, which is what ENFORCES them.
//
// These copies decide whether to DRAW a control. Gating the reopen button on
// `isAdmin` instead — which is what the first cut of this screen did — silently
// withholds from the Owner a power the server grants them, which is the same
// decision reversed at the UI layer rather than an access control.
export const PAYROLL_OVERRIDE_ROLES = ["Admin", OWNER_ROLE, "Accounting / Payroll"];
export const PAYROLL_REOPEN_ROLES = ["Admin", OWNER_ROLE];

export const mayEditPayrollFigure = (role) => PAYROLL_OVERRIDE_ROLES.includes(role);
export const mayReopenPayrollPeriod = (role) => PAYROLL_REOPEN_ROLES.includes(role);
