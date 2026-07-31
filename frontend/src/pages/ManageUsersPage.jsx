import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";

const SUBTITLE = "Create and manage system accounts";
const ROLES = ["Viewer", "Investigator", "Admin"];

/**
 * Manage Users (Admin only). Mirrors the legacy Users settings pane:
 * create accounts, change a user's role inline, deactivate/reactivate, and
 * retrieve the public (no-login) report form links. All calls hit the existing
 * /auth/users and /auth/public-form-link routes — no backend changes.
 */
export default function ManageUsersPage() {
  const { isAdmin } = useAuth();

  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [nu, setNu] = useState({ name: "", username: "", password: "", role: "Viewer" });
  const [formLinks, setFormLinks] = useState(null);
  const [copied, setCopied] = useState("");

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
    api("/auth/public-form-link").then(setFormLinks).catch(() => setFormLinks({ enabled: false }));
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

  async function toggleActive(id, active) {
    await guard(async () => {
      await api(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      await load();
    });
  }

  function copyLink(url, key) {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(""), 2000);
    }).catch(() => {});
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
                {ROLES.map((r) => <option key={r}>{r}</option>)}
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
              <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value)} style={{ marginRight: 8 }} disabled={busy}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
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

      {formLinks && (
        <div className="section-card">
          <div className="section-head">Public report form links</div>
          <div style={{ padding: "16px 18px" }}>
            {!formLinks.enabled ? (
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text)" }}>
                Public forms are not enabled yet. To turn them on, set a <code>PUBLIC_FORM_TOKEN</code> environment
                variable on the server (Render → your service → Environment), then restart the service. Once set,
                come back here to get shareable links.
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 10 }}>
                  Anyone with these links can submit a report without logging in.
                </p>
                {[
                  { label: "Incident report form", url: formLinks.url, key: "inc" },
                  { label: "Daily Security Report form", url: formLinks.dsrUrl, key: "dsr" },
                ].filter((l) => l.url).map((l) => (
                  <div key={l.key} style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mute)" }}>{l.label}</label>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <input type="text" readOnly value={l.url} style={{ flex: 1, fontSize: 12.5 }} />
                      <button className="btn btn-primary btn-sm" onClick={() => copyLink(l.url, l.key)}>
                        {copied === l.key ? "Copied!" : "Copy link"}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>
    </div>
  );
}
