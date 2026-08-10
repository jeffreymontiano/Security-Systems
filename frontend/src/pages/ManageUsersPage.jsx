import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import ConfirmModal from "../components/ConfirmModal";

const SUBTITLE = "Create and manage system accounts";
// Assignable roles. Served by the API so this screen can never offer one the
// server would reject; the list below is only the fallback if that call fails.
// A user still holding a legacy role keeps it visible in their own picker (see
// the "keep an existing value" option below) without it being offered to
// anyone else.
// Display names for the roles whose stored key differs from what the agency
// calls them. Mirrors ROLE_LABELS in src/lib/permissions.js; the catalogue
// supplies the real one, this covers the moment before it loads.
const FALLBACK_ROLE_LABELS = {
  "Admin": "System Administrator",
  "HR": "HR Manager/Officer",
  "Admin Officer": "Security Admin Officer",
};

const FALLBACK_ROLES = [
  "Admin",
  "Owner / President / General Manager",
  "Operation Manager / Operation Officer / Supervisor",
  "HR",
  "Accounting / Payroll",
  "Admin Officer",
  "Inspector / Investigator",
];

/**
 * Manage Users (Admin only). Mirrors the legacy Users settings pane:
 * create accounts, change a user's role inline, and deactivate/reactivate.
 *
 * The public report form links used to live here. They are shared from their own
 * module now — Incidents and Daily Security Report — so an admin finds the link
 * beside the register it feeds.
 */
export default function ManageUsersPage() {
  // `user` so an admin is not offered a Reset on their own row — there is a
  // proper self-service route for that, and the server refuses it here anyway.
  const { isAdmin, user } = useAuth();

  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [nu, setNu] = useState({ name: "", username: "", password: "", role: "Inspector / Investigator" });
  const [catalog, setCatalog] = useState(null);
  const [permUser, setPermUser] = useState(null);
  // The account an admin is about to reset, then the result. The temporary
  // password exists in this state and nowhere else — it is never stored.
  const [resetUser, setResetUser] = useState(null);
  const [resetResult, setResetResult] = useState(null);

  // Offered roles come from the server so this screen cannot present one the
  // API would reject. Legacy roles are excluded here deliberately.
  const assignableRoles = (catalog && catalog.roles ? catalog.roles : FALLBACK_ROLES)
    .filter((r) => !["Investigator", "Viewer"].includes(r));

  // The stored role key is what gets sent back on save; this only changes what
  // is READ. Every <option> keeps its value={key} for exactly that reason.
  const roleLabels = (catalog && catalog.roleLabels) || FALLBACK_ROLE_LABELS;
  const roleLabel = (r) => roleLabels[r] || r;

  const load = useCallback(async () => {
    try {
      setUsers(await api("/auth/users"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
    api("/auth/permission-catalog").then(setCatalog).catch(() => setCatalog(null));
  }, [isAdmin, load]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  async function createUser() {
    if (!nu.name.trim() || !nu.username.trim() || !nu.password) { alert("Fill in all fields."); return; }
    await guard(async () => {
      await api("/auth/users", {
        method: "POST",
        body: JSON.stringify({ name: nu.name.trim(), username: nu.username.trim(), password: nu.password, role: nu.role }),
      });
      setNu({ name: "", username: "", password: "", role: "Viewer" });
      await load();
    });
  }

  async function updateRole(id, role) {
    await guard(async () => {
      await api(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) });
      await load();
    });
  }

  async function resetPassword(u) {
    await guard(async () => {
      const r = await api(`/auth/users/${u.id}/reset-password`, { method: "POST" });
      setResetUser(null);
      setResetResult(r);
    });
  }

  async function toggleActive(id, active) {
    await guard(async () => {
      await api(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      await load();
    });
  }

  if (!isAdmin) {
    return (
      <div className="module-view">
        <ModuleHeader icon="👥" iconBg="var(--blue)" title="Manage Users" subtitle={SUBTITLE} />
        <div className="section-card"><div className="empty-hint">This section is available to administrators only.</div></div>
      </div>
    );
  }

  return (
    <div className="module-view">
      <ModuleHeader icon="👥" iconBg="var(--blue)" title="Manage Users" subtitle={SUBTITLE}
        actions={<button className="btn btn-outline btn-sm" onClick={load}>Refresh</button>} />
      <PurposeBar>Create accounts and control who can view, edit, or administer the system.</PurposeBar>

      <div className="section-card">
        <div className="section-head">Add a new user</div>
        <div style={{ padding: "16px 18px" }}>
          <div className="form-grid">
            <div className="form-field"><label>Full name</label>
              <input type="text" value={nu.name} onChange={(e) => setNu((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Juan Dela Cruz" />
            </div>
            <div className="form-field"><label>Username</label>
              <input type="text" value={nu.username} onChange={(e) => setNu((p) => ({ ...p, username: e.target.value }))} placeholder="e.g. jdelacruz" />
            </div>
            <div className="form-field"><label>Password</label>
              <input type="password" value={nu.password} onChange={(e) => setNu((p) => ({ ...p, password: e.target.value }))} placeholder="At least 8 characters" />
            </div>
            <div className="form-field"><label>Role</label>
              <select value={nu.role} onChange={(e) => setNu((p) => ({ ...p, role: e.target.value }))}>
                {assignableRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={createUser} disabled={busy}>Create user</button>
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Existing users</div>
        <div style={{ padding: "8px 18px 16px" }}>
          {error && <div className="empty-hint">{error}</div>}
          {!error && users === null && <div className="empty-hint">Loading...</div>}
          {!error && users && users.length === 0 && <div className="empty-hint">No users yet.</div>}
          {!error && users && users.map((u) => (
            <div className="settings-row" style={{ alignItems: "center" }} key={u.id}>
              <div style={{ flex: 1 }}>
                <strong>{u.name}</strong> · {u.username}
                <div style={{ fontSize: 11.5, color: "var(--text-mute)" }}>{u.active ? "Active" : "Deactivated"}</div>
              </div>
              <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value)} style={{ marginRight: 8, maxWidth: 250 }} disabled={busy}>
                {/* A legacy role stays visible for the user who still holds it,
                    so editing something else cannot silently reassign them. */}
                {!assignableRoles.includes(u.role) && <option value={u.role}>{roleLabel(u.role)} (legacy)</option>}
                {assignableRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
              {/* Admin-only, and the server enforces it independently — this
                  only avoids offering an action that would be refused. */}
              {isAdmin && u.id !== user?.id && (
                <button
                  className="btn btn-outline btn-sm" style={{ marginRight: 8 }}
                  onClick={() => setResetUser(u)} disabled={busy}
                  title={`Issue a temporary password for ${u.name}`}
                >
                  Reset password
                </button>
              )}
              <button className="btn btn-secondary btn-sm" style={{ marginRight: 8 }} onClick={() => setPermUser(u)} disabled={busy}>
                Privileges
              </button>
              <button
                className={`btn btn-sm ${u.active ? "btn-danger" : "btn-secondary"}`}
                onClick={() => toggleActive(u.id, u.active ? 0 : 1)}
                disabled={busy}
              >
                {u.active ? "Deactivate" : "Reactivate"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {resetUser && (
        <ConfirmModal
          title={`Reset the password for ${resetUser.name}?`}
          body={
            <>
              A new temporary password will be generated and shown to you <strong>once</strong>.
              {" "}
              <strong>{resetUser.name}</strong> will be signed out of every device immediately and must
              set their own password the next time they log in.
            </>
          }
          confirmLabel="Reset password"
          tone="danger"
          busy={busy}
          onConfirm={() => resetPassword(resetUser)}
          onCancel={() => setResetUser(null)}
        />
      )}

      {resetResult && (
        <TempPasswordModal result={resetResult} onClose={() => setResetResult(null)} />
      )}

      {permUser && (
        <PrivilegesModal
          user={permUser}
          catalog={catalog}
          onClose={() => setPermUser(null)}
          onSaved={load}
        />
      )}

      <ConfidentialFooter />
    </div>
  );
}

// Per-module Add / Edit / Delete for one user.
//
// Shows the ROLE DEFAULT beside each row, so an administrator can see whether a
// cell is a deliberate override or simply what the role already gives. Saving
// sends the whole matrix: a module left at its default is stored as an explicit
// row, which is what makes "revert to role default" a meaningful action.
// Shows the generated password ONCE. It is not stored anywhere — not in the
// audit log, not on the user record — so if it is lost the only remedy is to
// reset again, and the modal says so rather than letting an admin close it
// and find out later.
function TempPasswordModal({ result, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-overlay active" onClick={onClose} role="presentation">
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-labelledby="temp-pw-title">
        <div className="modal-header">
          <h2 id="temp-pw-title">Temporary password</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13.5, lineHeight: 1.7, marginTop: 0 }}>
            Give this to <strong>{result.name}</strong> ({result.username}). They will be asked to set
            their own password the next time they log in.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input readOnly value={result.temporaryPassword}
                   onFocus={(e) => e.target.select()}
                   style={{ flex: 1, fontFamily: "Consolas, monospace", fontSize: 15, letterSpacing: 1 }} />
            <button className="btn btn-primary btn-sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(result.temporaryPassword)
                        .then(() => setCopied(true)).catch(() => setCopied(true));
                    }}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="empty-hint" style={{ marginTop: 12, fontStyle: "normal" }}>
            This is shown once and is not stored anywhere. If it is lost, reset the password again.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function PrivilegesModal({ user, catalog, onClose, onSaved }) {
  // Same display-only mapping as the list above; the stored role is untouched.
  const roleLabel = ((catalog && catalog.roleLabels) || FALLBACK_ROLE_LABELS)[user.role] || user.role;
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const modules = (catalog && catalog.modules) || [];

  useEffect(() => {
    let cancelled = false;
    api(`/auth/users/${user.id}/permissions`)
      .then((d) => {
        if (cancelled) return;
        const byKey = Object.fromEntries((d.overrides || []).map((o) => [o.moduleKey, o]));
        setState({
          roleDefaults: d.roleDefaults || {},
          rows: Object.fromEntries(modules.map((m) => {
            const o = byKey[m.key];
            const eff = (d.effective && d.effective[m.key]) || {};
            return [m.key, {
              canAdd: o ? !!o.canAdd : !!eff.add,
              canEdit: o ? !!o.canEdit : !!eff.edit,
              canDelete: o ? !!o.canDelete : !!eff.delete,
              canView: o ? !!o.canView : !!eff.view,
              overridden: !!o,
            }];
          })),
        });
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
  }, [user.id, modules.length]);

  const isAdmin = user.role === "Admin";
  // Which modules have restricted READING. Served by the API so this screen can
  // never offer a View control the backend does not actually enforce.
  const viewRestricted = (catalog && catalog.viewRestricted) || [];

  function toggle(key, field) {
    setState((st) => ({ ...st, rows: { ...st.rows, [key]: { ...st.rows[key], [field]: !st.rows[key][field], overridden: true } } }));
  }
  function resetToRole() {
    setState((st) => ({
      ...st,
      rows: Object.fromEntries(modules.map((m) => {
        const d = st.roleDefaults[m.key] || {};
        return [m.key, { canAdd: !!d.add, canEdit: !!d.edit, canDelete: !!d.delete, canView: !!d.view, overridden: false }];
      })),
    }));
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      await api(`/auth/users/${user.id}/permissions`, {
        method: "PUT",
        body: JSON.stringify({
          permissions: modules.map((m) => ({
            moduleKey: m.key,
            canAdd: state.rows[m.key].canAdd,
            canEdit: state.rows[m.key].canEdit,
            canDelete: state.rows[m.key].canDelete,
            canView: state.rows[m.key].canView,
          })),
        }),
      });
      await onSaved?.();
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Access privileges &mdash; {user.name}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div>}

          {isAdmin ? (
            <div className="empty-hint">
              <strong>Admin</strong> is the super user and always holds every privilege in every module.
              Assign a different role to configure privileges.
            </div>
          ) : !state ? (
            <div className="empty-hint">Loading&hellip;</div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 14 }}>
                Role <strong>{roleLabel}</strong>. Ticking a box grants that privilege in that module; the server
                checks it independently on every request, so a hidden button is never the only protection.
                Unticking <strong>View</strong> closes the module entirely: it disappears from the sidebar and
                the page refuses to open. Granting Add, Edit or Delete implies View, since nobody can work in a
                module they cannot reach. <strong>Delete</strong> is reserved for the Owner.
              </div>
              <div className="section-card sticky-card" style={{ padding: 0, margin: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th style={{ width: 70, textAlign: "center" }}>View</th>
                      <th style={{ width: 70, textAlign: "center" }}>Add</th>
                      <th style={{ width: 70, textAlign: "center" }}>Edit</th>
                      <th style={{ width: 80, textAlign: "center" }}>Delete</th>
                      <th style={{ width: 110 }}>Role default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modules.map((m) => {
                      const row = state.rows[m.key] || {};
                      const d = state.roleDefaults[m.key] || {};
                      const restricted = viewRestricted.includes(m.key);
                      const dLabel = [d.view && restricted && "View", d.add && "Add", d.edit && "Edit", d.delete && "Delete"]
                        .filter(Boolean).join(", ") || "None";
                      return (
                        <tr key={m.key}>
                          <td data-label="Module">{m.label}</td>
                          <td data-label="View" style={{ textAlign: "center" }}>
                            {restricted ? (
                              <input type="checkbox" checked={!!row.canView} onChange={() => toggle(m.key, "canView")} />
                            ) : (
                              <span title="Reading this module is open to every signed-in user."
                                    style={{ color: "var(--text-mute)", fontSize: 11 }}>always</span>
                            )}
                          </td>
                          {["canAdd", "canEdit", "canDelete"].map((f) => (
                            <td key={f} data-label={f} style={{ textAlign: "center" }}>
                              <input type="checkbox" checked={!!row[f]} onChange={() => toggle(m.key, f)} />
                            </td>
                          ))}
                          <td data-label="Role default" style={{ fontSize: 11.5, color: "var(--text-mute)" }}>{dLabel}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          {!isAdmin && state && (
            <button className="btn btn-secondary" style={{ marginRight: "auto" }} onClick={resetToRole}>
              Reset to role defaults
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {!isAdmin && state && (
            <button className="btn btn-gold" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save privileges"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
