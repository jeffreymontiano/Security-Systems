import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import { LIST_TABS } from "./manageListsShared";

const SUBTITLE = "Customize dropdown values used across the system";

/**
 * Manage Lists. Tabbed editor over the two "named" lists (Classifications,
 * Sites — add / inline rename / delete) and the 19 generic dropdown lists
 * (add / delete only). Mirrors the legacy Settings pane; every call hits the
 * existing /meta routes.
 *
 * Backend role rules (unchanged): add + rename are Admin/Investigator; delete is
 * Admin only; and the backend refuses to delete the last remaining value in a
 * list. The UI reflects those rules.
 */
export default function ManageListsPage() {
  const { isViewer, isAdmin } = useAuth();

  const [activeKey, setActiveKey] = useState(LIST_TABS[0].key);
  const [values, setValues] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [renameDrafts, setRenameDrafts] = useState({});

  const activeTab = LIST_TABS.find((t) => t.key === activeKey);

  const endpointBase = useCallback((tab) => {
    if (tab.kind === "named") return `/meta/${tab.key}`;
    return `/meta/dropdown/${tab.key}`;
  }, []);

  const load = useCallback(async () => {
    setValues(null);
    setError("");
    setNewValue("");
    try {
      const rows = await api(endpointBase(activeTab));
      setValues(rows);
      setRenameDrafts(Object.fromEntries(rows.map((v) => [v, v])));
    } catch (e) {
      setError(e.message);
    }
  }, [activeTab, endpointBase]);

  useEffect(() => { load(); }, [load]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  async function addValue() {
    const val = newValue.trim();
    if (!val) return;
    await guard(async () => {
      const body = activeTab.kind === "named" ? { name: val } : { value: val };
      await api(endpointBase(activeTab), { method: "POST", body: JSON.stringify(body) });
      await load();
    });
  }

  async function renameValue(oldVal) {
    const newVal = (renameDrafts[oldVal] || "").trim();
    if (!newVal || newVal === oldVal) return;
    await guard(async () => {
      await api(`/meta/${activeTab.key}/${encodeURIComponent(oldVal)}`, {
        method: "PATCH", body: JSON.stringify({ name: newVal }),
      });
      await load();
    });
  }

  async function removeValue(val) {
    const noun = activeTab.kind === "named" ? "value" : "option";
    if (!confirm(`Remove this ${noun}? Existing records keep their current value.`)) return;
    await guard(async () => {
      const url = activeTab.kind === "named"
        ? `/meta/${activeTab.key}/${encodeURIComponent(val)}`
        : `/meta/dropdown/${activeTab.key}/${encodeURIComponent(val)}`;
      await api(url, { method: "DELETE" });
      await load();
    });
  }

  const canAdd = !isViewer;      // add + rename: Admin/Investigator
  const canDelete = isAdmin;     // delete: Admin only

  return (
    <div className="module-view">
      <ModuleHeader icon="📋" iconBg="var(--blue)" title="Manage Lists" subtitle={SUBTITLE}
        actions={<button className="btn btn-outline btn-sm" onClick={load}>Refresh</button>} />
      <PurposeBar>Customize the dropdown options used throughout the system's modules.</PurposeBar>

      <div className="section-card">
        <div className="tabs" style={{ margin: 0, padding: "14px 18px 0", flexWrap: "wrap" }}>
          {LIST_TABS.map((t) => (
            <button
              key={t.key}
              className={`tab-btn ${activeKey === t.key ? "active" : ""}`}
              onClick={() => setActiveKey(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: "16px 18px" }}>
          {canAdd && (
            <div className="add-row" style={{ marginBottom: 12 }}>
              <div className="form-field" style={{ flex: 1 }}>
                <label>New {activeTab.label}</label>
                <input
                  type="text" value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addValue(); }}
                  placeholder="Type a value and click Add"
                />
              </div>
              <button className="btn btn-primary btn-sm" onClick={addValue} disabled={busy}>Add</button>
            </div>
          )}

          {error && <div className="empty-hint">{error}</div>}
          {!error && values === null && <div className="empty-hint">Loading...</div>}
          {!error && values && values.length === 0 && <div className="empty-hint">No values in this list yet.</div>}
          {!error && values && values.map((v) => (
            <div className="settings-row" key={v}>
              {activeTab.kind === "named" && canAdd ? (
                <input
                  type="text"
                  value={renameDrafts[v] ?? v}
                  onChange={(e) => setRenameDrafts((p) => ({ ...p, [v]: e.target.value }))}
                  onBlur={() => renameValue(v)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
              ) : (
                <input type="text" value={v} disabled />
              )}
              {canDelete && (
                <button className="btn btn-danger btn-sm" onClick={() => removeValue(v)} disabled={busy}>Remove</button>
              )}
            </div>
          ))}

          {activeTab.kind === "named" && canAdd && (
            <p style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 8 }}>
              Renaming a {activeTab.key === "sites" ? "site" : "classification"} updates existing incident records to match.
            </p>
          )}
        </div>
      </div>

      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>
    </div>
  );
}
