// Roles, modules, and who may add / edit / delete what.
//
// Pure — no database — like the other engines here, because the same answer is
// needed in three places (the API guard, the Manage Users screen, and the UI
// that hides a button) and they must not disagree. The backend is the one that
// ENFORCES; the frontend only reads this to avoid offering an action that would
// be refused.
//
// EXTENDS the existing authorisation rather than replacing it. requireAuth and
// the JWT session are untouched, every existing requireRole() call still runs,
// and a user with no permission rows behaves exactly as they do today — that is
// what ROLE_DEFAULTS below encodes. Per-user rows only ever refine it.

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

// The roles an administrator can now assign.
const ROLES = [
  "Admin",
  "Owner / President / General Manager",
  "Operation Manager / Operation Officer / Supervisor",
  "HR",
  "Accounting / Payroll",
  "Admin Officer",
  "Inspector / Investigator",
];

// Roles that predate the list above. Still valid so no existing user row
// becomes invalid or loses access, but not offered for new users. An admin
// moves them across when convenient.
const LEGACY_ROLES = ["Investigator", "Viewer"];

const ALL_ROLES = [...ROLES, ...LEGACY_ROLES];

// What each role is CALLED on screen. Display only — the strings above stay the
// stored keys and are never rewritten.
//
// They have to. The role value is load-bearing in six places: 212 requireRole()
// calls, the ROLE_DEFAULTS keys below, isSuperUser(), useAuth()'s isAdmin /
// isViewer, the users.role column and its users_role_check CHECK constraint,
// and the `role` claim inside every JWT already issued. Renaming the stored
// value would need a migration, a constraint change and 212 edits, and would
// log out every signed-in user the moment it deployed.
//
// A role missing from this map displays under its own name, so adding a role
// needs no entry here.
const ROLE_LABELS = {
  "Admin": "System Administrator",
  "HR": "HR Manager/Officer",
  "Admin Officer": "Security Admin Officer",
};

function labelForRole(role) {
  return ROLE_LABELS[role] || role;
}

// Admin is the super user: it short-circuits every check, exactly as
// requireRole() has always done.
const isSuperUser = (role) => role === "Admin";

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

// One entry per thing an administrator would recognise as a module. `mounts`
// lists the /api prefixes it owns, which is how a request is attributed to a
// module — several mounts can belong to one module (attendance owns four), and
// one module can be reached through more than one router (deployment owns both
// the ops records and the duty detail orders).
const MODULES = [
  { key: "employees",       label: "Employee Master File (201 File)",   mounts: ["employees"] },
  { key: "attendance",      label: "Attendance & Timekeeping",          mounts: ["attendance", "attendance-reports", "absence-monitoring", "overtime"] },
  { key: "leave",           label: "Leave Management",                  mounts: ["leave"] },
  { key: "payroll",         label: "Payroll & Benefits",                mounts: ["payroll"] },
  { key: "billing",         label: "Billing & Statement of Account",    mounts: ["billing"] },
  { key: "assets",          label: "Asset & Equipment Management",      mounts: ["assets"] },
  { key: "recruitment",     label: "Recruitment, Hiring & Onboarding",  mounts: ["recruitment"] },
  { key: "incidents",       label: "Incident Reporting & Investigation", mounts: ["incidents"] },
  { key: "deployment",      label: "Deployment & Post Management",      mounts: ["ops", "ddo"] },
  { key: "scheduling",      label: "Shift Scheduling",                  mounts: ["scheduling"] },
  { key: "dsr",             label: "Daily Security Report",             mounts: ["dsr"] },
  { key: "securityReports", label: "Security Reports (MDR)",            mounts: ["security-reports"] },
  { key: "disciplinary",    label: "Disciplinary Action",               mounts: ["disciplinary"] },
  { key: "performance",     label: "Performance Appraisal",             mounts: ["performance"] },
  { key: "training",        label: "Training & Certification",          mounts: ["training"] },
  { key: "compliance",      label: "Compliance & Audit",                mounts: ["compliance"] },
  { key: "users",           label: "Manage Users",                      mounts: ["auth"] },
  { key: "lists",           label: "Manage Lists",                      mounts: ["meta"] },
  { key: "settings",        label: "System Settings",                   mounts: ["settings"] },
];

const MODULE_KEYS = MODULES.map((m) => m.key);
const MODULE_BY_MOUNT = new Map();
for (const m of MODULES) for (const mount of m.mounts) MODULE_BY_MOUNT.set(mount, m.key);

const ACTIONS = ["add", "edit", "delete"];

// ---------------------------------------------------------------------------
// What a request is trying to do
// ---------------------------------------------------------------------------

// POST endpoints that change the state of something that already exists rather
// than creating a record. They are edits, and asking for "add" to finalise a
// payroll period would be plainly wrong. Kept explicit and short: a POST not
// listed here creates something.
const ACTION_POST = /\/(compute|recompute|finalise|finalize|reopen|submit|issue|cancel|amend|approve|reject|restore|prepare|mark-paid|markpaid|from-records|from-roster|bulk|retire|return)(\/|$)/i;

// WORKFLOW steps: advancing a document through its lifecycle — finalising a
// return, issuing an order, approving a request, marking a period paid.
//
// These are NOT plain edits. A route guarding one with requireRole("Admin") is
// stating a business rule that goes beyond "may this person change records in
// this module", and the Add/Edit/Delete matrix must not quietly override it:
// holding "edit" on Security Reports should let someone build a return, not
// file it with the PNP.
//
// So a workflow step requires BOTH — the module's edit privilege AND whatever
// role the route itself demands. Ordinary create/update/delete is governed by
// the matrix alone.
const WORKFLOW = /\/(compute|recompute|finalise|finalize|reopen|submit|issue|cancel|amend|approve|reject|restore|mark-paid|markpaid|retire)(\/|$)/i;

const isWorkflowPath = (path) => WORKFLOW.test(String(path || ""));

// null means "no permission needed" — reads are governed by requireAuth and the
// existing role checks, not by this matrix, which is about Add / Edit / Delete.
function actionFor(method, path) {
  const m = String(method || "").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  if (m === "DELETE") return "delete";
  if (m === "PUT" || m === "PATCH") return "edit";
  if (m === "POST") return ACTION_POST.test(String(path || "")) ? "edit" : "add";
  return null;
}

// ---------------------------------------------------------------------------
// Defaults per role
// ---------------------------------------------------------------------------

const NONE = { add: false, edit: false, delete: false };
const ALL = { add: true, edit: true, delete: true };
const ADD_EDIT = { add: true, edit: true, delete: false };

const only = (keys, grant) =>
  Object.fromEntries(MODULE_KEYS.map((k) => [k, keys.includes(k) ? grant : NONE]));
const merge = (...maps) => {
  const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, NONE]));
  for (const map of maps) {
    for (const k of MODULE_KEYS) {
      const g = map[k];
      if (!g) continue;
      out[k] = {
        add: out[k].add || g.add,
        edit: out[k].edit || g.edit,
        delete: out[k].delete || g.delete,
      };
    }
  }
  return out;
};

const OPERATIONS = ["incidents", "deployment", "scheduling", "dsr", "securityReports", "attendance", "assets"];
const PEOPLE = ["employees", "recruitment", "leave", "training", "disciplinary", "performance"];
const MONEY = ["payroll", "billing"];

// A user's starting point. Every one of these is a DEFAULT: an administrator
// overrides any cell per user from Manage Users.
//
// The two legacy roles reproduce EXACTLY what they can do today, so upgrading
// changes nobody's access until an administrator decides otherwise:
//   Investigator  add + edit across the modules, never delete (delete has
//                 always been requireRole("Admin"))
//   Viewer        read-only — requireRole has never let a Viewer past
const ROLE_DEFAULTS = {
  // Admin never consults this table (isSuperUser short-circuits), but it is
  // filled in so the Manage Users screen can show what Admin holds.
  "Admin": only(MODULE_KEYS, ALL),

  "Owner / President / General Manager":
    merge(only([...OPERATIONS, ...PEOPLE, ...MONEY, "compliance", "lists", "settings"], ALL)),

  "Operation Manager / Operation Officer / Supervisor":
    merge(only(OPERATIONS, ALL), only(["compliance"], ADD_EDIT)),

  "HR": merge(only(PEOPLE, ALL), only(["attendance"], ADD_EDIT)),

  "Accounting / Payroll": merge(only(MONEY, ALL), only(["attendance"], ADD_EDIT)),

  // Displayed as "Security Admin Officer". Scoped to the six modules the
  // agency asked for and nothing else. It previously held Manage Lists and the
  // 201 File; both are deliberately gone.
  //
  // `settings` is add+edit and NOT delete, which is the shape the role already
  // had — deleting configuration is not part of the job. Workflow steps
  // (issue, finalise, approve, mark paid) remain Admin-only regardless, via the
  // WORKFLOW exemption, so this grants building a document, not filing it.
  //
  // Accounts that already held the old wider scope are NOT re-scoped by this
  // change: db.js freezes their existing access into explicit rows first. See
  // the "Security Admin Officer" backfill there.
  "Admin Officer": merge(
    only(["assets", "deployment", "securityReports", "recruitment", "compliance"], ALL),
    only(["settings"], ADD_EDIT)
  ),

  "Inspector / Investigator": merge(only(["incidents", "dsr", "compliance"], ADD_EDIT)),

  // --- legacy, preserved EXACTLY as the code grants them today ---
  //
  // Derived from the routes, not guessed: every module's write routes are
  // requireRole("Admin", "Investigator") except Manage Users and System
  // Settings, which are requireRole("Admin") throughout. Deletes and workflow
  // steps are Admin-only, which is why there is no delete here.
  //
  // Getting this wrong in the generous direction would hand a legacy
  // Investigator the settings and user administration they have never had.
  "Investigator": only(MODULE_KEYS.filter((k) => k !== "users" && k !== "settings"), ADD_EDIT),
  "Viewer": only(MODULE_KEYS, NONE),
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// The effective matrix for a user: the role's defaults, with any per-user rows
// laid over the top. An unknown role grants nothing rather than everything —
// failing closed is the only safe direction for an authorisation check.
function effectivePermissions(role, overrides = []) {
  if (isSuperUser(role)) return Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...ALL }]));
  const base = ROLE_DEFAULTS[role] || only(MODULE_KEYS, NONE);
  const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...(base[k] || NONE) }]));
  for (const o of overrides || []) {
    const key = o && o.moduleKey;
    if (!key || !(key in out)) continue;
    out[key] = {
      add: !!o.canAdd,
      edit: !!o.canEdit,
      delete: !!o.canDelete,
    };
  }
  return out;
}

function can(permissions, moduleKey, action) {
  if (!action) return true;                       // a read
  if (!moduleKey) return true;                    // not a module route
  const g = permissions && permissions[moduleKey];
  return !!(g && g[action]);
}

const moduleForMount = (mount) => MODULE_BY_MOUNT.get(String(mount || "").replace(/^\/+/, "")) || null;
const labelFor = (key) => (MODULES.find((m) => m.key === key) || {}).label || key;

module.exports = {
  ROLES, LEGACY_ROLES, ALL_ROLES, isSuperUser, ROLE_LABELS, labelForRole,
  MODULES, MODULE_KEYS, ACTIONS, ROLE_DEFAULTS,
  actionFor, isWorkflowPath, effectivePermissions, can, moduleForMount, labelFor,
};
