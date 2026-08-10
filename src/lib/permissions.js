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

// Named so the exact string is written once. It is a role KEY, matched against
// users.role and the users_role_check constraint — a typo in a copy of it would
// be a silent access hole, not a crash. Mirrored for the UI in
// frontend/src/roles.js, which cannot import from here.
const OWNER_ROLE = "Owner / President / General Manager";

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
  // Read-only leadership view. Closed by default — see VIEW_RESTRICTED.
  { key: "executive",       label: "Executive Summary",                 mounts: ["executive-summary"] },
];

const MODULE_KEYS = MODULES.map((m) => m.key);
const MODULE_BY_MOUNT = new Map();
for (const m of MODULES) for (const mount of m.mounts) MODULE_BY_MOUNT.set(mount, m.key);

const ACTIONS = ["add", "edit", "delete"];

// Modules whose READING is restricted. This list is deliberately tiny and must
// stay that way.
//
// The Add/Edit/Delete matrix governs writes only — what a user may SEE has
// always been `requireAuth` plus the role checks, and every module is readable
// by every signed-in user. Executive Summary is the first exception: it is a
// leadership view that is closed by default and opened per user.
//
// So `view` is a fourth action that exists ONLY for the modules named here.
// effectivePermissions() hands back `view: true` for everything else, so no
// existing screen changes, and modulePermission() only tests it for these keys.
// Adding a module here closes it to everyone who is not granted it — do that
// deliberately, never as a tidy-up.
// Defined immediately after ACCESS_MATRIX below, because it is derived from it:
// every module the agency's table governs is view-restricted, since a blank
// cell in that table means the module is not that role's to open.

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

// The same exemption, for a different reason: destroying the cross-module audit
// history is not an ordinary "delete something in Incidents", even though the
// route happens to live in that router and the method happens to be DELETE.
// Without this, every role the matrix grants delete-on-Incidents — Owner and
// Operation Manager among them — could purge the audit log, because
// requireRole("Admin") defers to req.moduleGrant. Measured, not assumed: both
// returned 200 before this line existed.
const PROTECTED = /\/_all\/audit(\/|$)/i;

// True when the Add/Edit/Delete matrix must NOT confer authority on its own and
// the route's own requireRole() stays decisive. Two kinds of path qualify: a
// workflow step, and a protected administrative action.
const isWorkflowPath = (path) =>
  WORKFLOW.test(String(path || "")) || PROTECTED.test(String(path || ""));

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
const VIEW_ONLY = { add: false, edit: false, delete: false, view: true };

const only = (keys, grant) =>
  Object.fromEntries(MODULE_KEYS.map((k) => [k, keys.includes(k) ? grant : NONE]));
const merge = (...maps) => {
  const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...NONE, view: false }]));
  for (const map of maps) {
    for (const k of MODULE_KEYS) {
      const g = map[k];
      if (!g) continue;
      out[k] = {
        add: out[k].add || g.add,
        edit: out[k].edit || g.edit,
        delete: out[k].delete || g.delete,
        // Carried through, or a role granted `view` on a VIEW_RESTRICTED module
        // would lose it here and the default would silently be "no access".
        view: out[k].view || !!g.view,
      };
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// The agency's access matrix
// ---------------------------------------------------------------------------
//
// Transcribed from the agency's Module x Role table, which is the SOURCE OF
// TRUTH for defaults. One row per module, listing the roles marked "O".
//
// An "O" grants view + add + edit. DELETE is not in this table at all: only the
// Owner holds it (plus Admin, which short-circuits every check as the technical
// super user). See DELETE_ROLE below.
//
// A role absent from a row gets NO ACCESS to that module, including read — so
// these eighteen modules are all VIEW_RESTRICTED. That is the point of the
// table: a blank cell means the module is not theirs to open.
//
// Three modules are deliberately NOT in the table and keep their existing
// behaviour: `users` (Manage Users, administrator only), `executive`
// (Executive Summary, Owner plus a per-user grant) and the Security Operations
// Dashboard, which has no module key because it reads across modules and
// writes nothing.
const OWNER = "Owner / President / General Manager";
const OPS_MGR = "Operation Manager / Operation Officer / Supervisor";
const HR_ROLE = "HR";
const ACCT = "Accounting / Payroll";
const INSP = "Inspector / Investigator";
const SAO = "Admin Officer";              // displayed as "Security Admin Officer"

// The one role with delete, per the agency's third business rule.
const DELETE_ROLE = OWNER;

const ACCESS_MATRIX = {
  employees:       [OWNER, OPS_MGR, HR_ROLE, ACCT, SAO],
  attendance:      [OWNER, OPS_MGR, HR_ROLE, ACCT],
  leave:           [OWNER, OPS_MGR, HR_ROLE, ACCT],
  payroll:         [OWNER, ACCT],
  billing:         [OWNER, ACCT],
  recruitment:     [OWNER, OPS_MGR, HR_ROLE],
  assets:          [OWNER, OPS_MGR, HR_ROLE, ACCT, SAO],
  incidents:       [OWNER, OPS_MGR, INSP],
  deployment:      [OWNER, OPS_MGR, INSP],
  scheduling:      [OWNER, OPS_MGR, HR_ROLE, INSP],
  dsr:             [OWNER, OPS_MGR, INSP],
  securityReports: [OWNER, OPS_MGR, INSP, SAO],
  disciplinary:    [OWNER, OPS_MGR, HR_ROLE],
  performance:     [OWNER, OPS_MGR, HR_ROLE],
  training:        [OWNER, OPS_MGR, HR_ROLE],
  compliance:      [OWNER, OPS_MGR, HR_ROLE],
  lists:           [OWNER],
  settings:        [OWNER, HR_ROLE],
};

// Every module the table governs is read-gated, plus Executive Summary, which
// predates the table and is closed for its own reason. `users` is deliberately
// absent: Manage Users stays administrator-only through its route checks, and
// putting it here would change nothing except add a way to grant it.
const VIEW_RESTRICTED = new Set([...Object.keys(ACCESS_MATRIX), "executive"]);

// Build one role's defaults straight from the table, so the code cannot drift
// from the document: read the column, not a hand-maintained list.
const fromMatrix = (role) =>
  Object.fromEntries(MODULE_KEYS.map((k) => {
    const allowed = ACCESS_MATRIX[k] && ACCESS_MATRIX[k].includes(role);
    if (!allowed) return [k, { ...NONE, view: false }];
    return [k, { add: true, edit: true, delete: role === DELETE_ROLE, view: true }];
  }));

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

  // Every business role below is read STRAIGHT OFF the matrix. Editing the
  // agency's table is therefore the only thing needed to re-scope a role, and
  // no second list can disagree with it.
  //
  // The Owner additionally keeps Executive Summary, which is not in the table:
  // it is a read-only leadership view, so it carries `view` and no writes.
  [OWNER]: merge(fromMatrix(OWNER), { executive: { ...NONE, view: true } }),

  [OPS_MGR]: fromMatrix(OPS_MGR),
  [HR_ROLE]: fromMatrix(HR_ROLE),
  [ACCT]: fromMatrix(ACCT),

  // Displayed as "Security Admin Officer": the 201 File, Assets and the MDR.
  // The matrix restored the 201 File (removed in an earlier revision) and took
  // away Deployment, Recruitment, Compliance and System Settings. Confirmed
  // against the agency's table rather than inferred.
  [SAO]: fromMatrix(SAO),

  [INSP]: fromMatrix(INSP),

  // --- legacy, preserved EXACTLY as the code grants them today ---
  //
  // Derived from the routes, not guessed: every module's write routes are
  // requireRole("Admin", "Investigator") except Manage Users and System
  // Settings, which are requireRole("Admin") throughout. Deletes and workflow
  // steps are Admin-only, which is why there is no delete here.
  //
  // Getting this wrong in the generous direction would hand a legacy
  // Investigator the settings and user administration they have never had.
  //
  // They also need `view` stated explicitly now. Before the agency's matrix,
  // reading was open on every module and these roles relied on that; with
  // eighteen modules view-restricted, a legacy role carrying no `view` would
  // read NOTHING — a Viewer would see no module at all, and an Investigator
  // would be locked out of the very pages they still hold edit on. Executive
  // Summary is the one exception, because it was already closed to them.
  "Investigator": merge(
    only(MODULE_KEYS.filter((k) => k !== "users" && k !== "settings"), ADD_EDIT),
    only(MODULE_KEYS.filter((k) => k !== "executive"), VIEW_ONLY)
  ),
  "Viewer": only(MODULE_KEYS.filter((k) => k !== "executive"), VIEW_ONLY),
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// The effective matrix for a user: the role's defaults, with any per-user rows
// laid over the top. An unknown role grants nothing rather than everything —
// failing closed is the only safe direction for an authorisation check.
function effectivePermissions(role, overrides = []) {
  if (isSuperUser(role)) {
    return Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...ALL, view: true }]));
  }
  const base = ROLE_DEFAULTS[role] || only(MODULE_KEYS, NONE);
  const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...(base[k] || NONE) }]));
  for (const o of overrides || []) {
    const key = o && o.moduleKey;
    if (!key || !(key in out)) continue;
    out[key] = {
      add: !!o.canAdd,
      edit: !!o.canEdit,
      delete: !!o.canDelete,
      // An override row states view only for a restricted module; elsewhere the
      // rule below puts it back to true, so an old row cannot hide a screen.
      view: !!o.canView,
    };
  }
  // Reading is open on any module the agency's matrix does not govern (today
  // only Manage Users): those stay behind requireAuth and their route checks.
  for (const k of MODULE_KEYS) {
    if (!VIEW_RESTRICTED.has(k)) out[k].view = true;
    else if (out[k].view === undefined) out[k].view = false;

    // A granted write IMPLIES the right to open the module. Nobody can add an
    // employee to a screen they cannot reach, so an override that ticks Add or
    // Edit but leaves View unticked would grant a privilege and simultaneously
    // hide the only place to use it — the module would vanish entirely for that
    // user. Making it implied means an administrator cannot create that state
    // by accident, on the screen or through the API.
    if (out[k].add || out[k].edit || out[k].delete) out[k].view = true;
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
  ROLES, LEGACY_ROLES, ALL_ROLES, OWNER_ROLE, isSuperUser, ROLE_LABELS, labelForRole, VIEW_RESTRICTED,
  MODULES, MODULE_KEYS, ACTIONS, ROLE_DEFAULTS,
  actionFor, isWorkflowPath, effectivePermissions, can, moduleForMount, labelFor,
};
