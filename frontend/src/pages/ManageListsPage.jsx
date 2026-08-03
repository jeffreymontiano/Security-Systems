import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import { LIST_TABS } from "./manageListsShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

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
    if (activeTab.kind === "payroll") return; // self-fetching PayrollComponentsTab below
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
          {activeTab.kind === "payroll" ? (
            <PayrollComponentsTab canManage={canAdd} />
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>

      <ConfidentialFooter />
    </div>
  );
}

// ---- Pay Components (Earnings & Deductions) --------------------------------
// A flat string can't carry the tax/frequency information the payroll engine
// needs (see src/lib/payrollEngine.js), so this tab renders a richer row than
// the plain named/dropdown lists above — but it's still one add/edit/
// deactivate screen, backed by /api/payroll/components. "Remove" deactivates
// (active:false) rather than deleting, so applied history in
// payroll_line_components always survives.
const CATEGORY_OPTIONS = {
  Earning: ["Allowance", "Incentive", "Bonus", "Benefit", "Other"],
  Deduction: ["Loan", "Government", "Other"],
};
const FREQUENCY_OPTIONS = ["Per Period", "Monthly (1st cutoff)", "One-time", "Annual"];

function PayrollComponentsTab({ canManage }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "Earning", category: "Allowance", taxable: false, frequency: "Per Period", defaultAmount: "" });

  const load = useCallback(async () => {
    try { setRows(await api("/payroll/components")); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function guard(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  async function addComponent() {
    if (!draft.name.trim()) return;
    await guard(async () => {
      await api("/payroll/components", {
        method: "POST",
        body: JSON.stringify({ ...draft, defaultAmount: Number(draft.defaultAmount) || 0 }),
      });
      setDraft({ name: "", kind: "Earning", category: "Allowance", taxable: false, frequency: "Per Period", defaultAmount: "" });
      await load();
    });
  }

  async function patch(id, body) {
    await guard(async () => {
      await api(`/payroll/components/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    });
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 0, marginBottom: 12 }}>
        These feed the Payroll &amp; Benefits module's payslip earnings and deductions. Seeded entries start
        <strong> inactive</strong> — activate and price only what Brookside actually offers.
      </p>

      {canManage && (
        <div className="add-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <div className="form-field" style={{ flex: 2, minWidth: 160 }}>
            <label>Name</label>
            <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Rice Allowance" />
          </div>
          <div className="form-field">
            <label>Kind</label>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, category: CATEGORY_OPTIONS[e.target.value][0] })}>
              <option value="Earning">Earning</option>
              <option value="Deduction">Deduction</option>
            </select>
          </div>
          <div className="form-field">
            <label>Category</label>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORY_OPTIONS[draft.kind].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Frequency</label>
            <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}>
              {FREQUENCY_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="form-field" style={{ maxWidth: 110 }}>
            <label>Default amount</label>
            <input type="number" min="0" step="0.01" value={draft.defaultAmount} onChange={(e) => setDraft({ ...draft, defaultAmount: e.target.value })} />
          </div>
          <div className="form-field" style={{ maxWidth: 90 }}>
            <label>Taxable</label>
            <input type="checkbox" checked={draft.taxable} onChange={(e) => setDraft({ ...draft, taxable: e.target.checked })} style={{ width: 18, height: 18, marginTop: 6 }} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={addComponent} disabled={busy}>Add</button>
        </div>
      )}

      {error && <div className="empty-hint">{error}</div>}
      {!error && rows === null && <div className="empty-hint">Loading...</div>}
      {!error && rows && rows.length === 0 && <div className="empty-hint">No pay components yet.</div>}
      {!error && rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Kind</th><th>Category</th><th>Frequency</th><th>Default Amount</th><th>Taxable</th><th>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                <td data-label="Name"><strong>{c.name}</strong></td>
                <td data-label="Kind">{c.kind}</td>
                <td data-label="Category">
                  {canManage ? (
                    <select value={c.category} onChange={(e) => patch(c.id, { category: e.target.value })} disabled={busy}>
                      {CATEGORY_OPTIONS[c.kind].map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  ) : c.category}
                </td>
                <td data-label="Frequency">
                  {canManage ? (
                    <select value={c.frequency} onChange={(e) => patch(c.id, { frequency: e.target.value })} disabled={busy}>
                      {FREQUENCY_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  ) : c.frequency}
                </td>
                <td data-label="Default Amount">
                  {canManage ? (
                    <input type="number" min="0" step="0.01" defaultValue={c.defaultAmount} style={{ width: 90 }}
                      onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== Number(c.defaultAmount)) patch(c.id, { defaultAmount: v }); }} />
                  ) : `₱${Number(c.defaultAmount).toFixed(2)}`}
                </td>
                <td data-label="Taxable">
                  {canManage ? (
                    <input type="checkbox" checked={c.taxable} onChange={(e) => patch(c.id, { taxable: e.target.checked })} disabled={busy} />
                  ) : (c.taxable ? "Yes" : "No")}
                </td>
                <td data-label="Active">
                  {canManage ? (
                    <button className={`btn btn-sm ${c.active ? "btn-secondary" : "btn-primary"}`} onClick={() => patch(c.id, { active: !c.active })} disabled={busy}>
                      {c.active ? "Deactivate" : "Activate"}
                    </button>
                  ) : (c.active ? "Yes" : "No")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
