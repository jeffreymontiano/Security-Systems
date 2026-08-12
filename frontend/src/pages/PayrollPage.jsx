import { useEffect, useMemo, useState, useCallback } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import PayrollPeriodDetail from "./PayrollPeriodDetail";
import { peso, periodStatusBadgeClass, thirteenthMonthStatusBadgeClass, STATUTORY_TABS } from "./payrollShared";

const SUBTITLE = "Compute pay, statutory deductions, and benefits from attendance, overtime, and leave";

const VIEWS = [
  { key: "periods", label: "Pay Periods" },
  { key: "rates", label: "Employee Rates" },
  { key: "assignments", label: "Employee Assignments" },
  { key: "statutory", label: "Statutory Tables" },
  { key: "thirteenth", label: "13th Month Pay" },
];

export default function PayrollPage() {
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
  const canEdit = !isViewer;
  const [view, setView] = useState("periods");
  const [error, setError] = useState("");
  // Bumped by Refresh. Each tab lists it in its load effect, so the click
  // refetches without remounting the tab and losing its filters.
  const [revision, setRevision] = useState(0);
  const [openPeriodId, setOpenPeriodId] = useState(null);

  return (
    <div className="module-view">
      <ModuleHeader title="Payroll & Benefits" subtitle={SUBTITLE} actions={<button className="btn btn-outline btn-sm" onClick={() => setRevision((r) => r + 1)}>Refresh</button>} />
      <PurposeBar>
        Turns attendance, approved overtime, and approved leave into gross pay, government-mandated deductions
        (SSS/PhilHealth/Pag-IBIG/withholding tax), net pay, payslips, and 13th-month pay. Statutory figures and
        pay components are admin-editable — verify them against the latest official issuances before relying on them.
      </PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0", flexWrap: "wrap" }}>
        {VIEWS.map((v) => (
          <button key={v.key} className={`btn btn-sm ${view === v.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </div>

      {view === "periods" && <PayPeriodsTab canEdit={canEdit} isAdmin={isAdmin} onOpen={setOpenPeriodId} onError={setError} revision={revision} />}
      {view === "rates" && <EmployeeRatesTab canEdit={canEdit} onError={setError} revision={revision} />}
      {view === "assignments" && <EmployeeAssignmentsTab canEdit={canEdit} onError={setError} revision={revision} />}
      {view === "statutory" && <StatutoryTablesTab isAdmin={isAdmin} onError={setError} revision={revision} />}
      {view === "thirteenth" && <ThirteenthMonthTab canEdit={canEdit} isAdmin={isAdmin} onError={setError} revision={revision} />}

      <ConfidentialFooter />

      {openPeriodId && <PayrollPeriodDetail periodId={openPeriodId} onClose={() => setOpenPeriodId(null)} />}
    </div>
  );
}

// ---- Pay Periods ------------------------------------------------------------

const CUTOFF_LABEL = {
  second: "the 2nd cutoff (16th–end of month)",
  first: "the 1st cutoff (1st–15th)",
  split: "both cutoffs (half each)",
};

function PayPeriodsTab({ canEdit, isAdmin, onOpen, onError, revision }) {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [cutoff, setCutoff] = useState(null);

  const load = useCallback(async () => {
    try { setPeriods(await api("/payroll/periods")); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  // Show the active statutory-cutoff rule here so it's obvious which payslip
  // carries the contributions, without digging into the config tab.
  useEffect(() => {
    api("/payroll/config")
      .then((rows) => {
        const pr = rows.find((r) => r.key === "pay_rules");
        setCutoff(pr?.config?.statutoryCutoff || "second");
      })
      .catch(() => {});
  }, []);

  async function remove(id) {
    if (!await confirm("Delete this payroll period? All its computed lines will be removed.")) return;
    try { await api(`/payroll/periods/${id}`, { method: "DELETE" }); await load(); }
    catch (e) { onError(e.message); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{!loading && `${periods.length} period${periods.length === 1 ? "" : "s"}`}</div>
        </div>
        {canEdit && <button className="btn btn-gold" onClick={() => setShowNew(true)}>+ New pay period</button>}
      </div>

      {cutoff && (
        <div style={{ margin: "0 32px 12px", fontSize: 12, color: "var(--text-mute)" }}>
          SSS / PhilHealth / Pag-IBIG are currently deducted on <strong>{CUTOFF_LABEL[cutoff] || cutoff}</strong>.
          {" "}Change this under <strong>Statutory Tables → Pay Rules</strong>.
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Semi-monthly pay periods</div>
        <table>
          <thead>
            <tr><th>Period</th><th>Pay date</th><th>Status</th><th>Employees</th><th>Total Gross</th><th>Total Net</th><th></th></tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={7}>Loading pay periods…</td></tr>}
            {!loading && periods.length === 0 && <tr className="empty-row"><td colSpan={7}>No pay periods yet.</td></tr>}
            {!loading && periods.map((p) => (
              <tr key={p.id}>
                <td data-label="Period"><strong>{p.periodStart} to {p.periodEnd}</strong></td>
                <td data-label="Pay date">{p.payDate || "—"}</td>
                <td data-label="Status"><span className={`badge ${periodStatusBadgeClass(p.status)}`}>{p.status}</span></td>
                <td data-label="Employees">{p.lineCount}</td>
                <td data-label="Total Gross">{peso(p.totalGross)}</td>
                <td data-label="Total Net">{peso(p.totalNet)}</td>
                <td data-label="" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => onOpen(p.id)}>Open</button>{" "}
                  {isAdmin && p.status !== "Paid" && (
                    <button className="btn btn-sm btn-danger" onClick={() => remove(p.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewPeriodModal onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await load(); onOpen(id); }} />
      )}
    </>
  );
}

function NewPeriodModal({ onClose, onCreated }) {
  const today = new Date();
  const day = today.getDate();
  const y = today.getFullYear(), m = today.getMonth();
  const firstHalf = day <= 15;
  const defaultStart = firstHalf ? new Date(y, m, 1) : new Date(y, m, 16);
  const defaultEnd = firstHalf ? new Date(y, m, 15) : new Date(y, m + 1, 0);
  const iso = (d) => d.toISOString().slice(0, 10);

  const [form, setForm] = useState({ periodStart: iso(defaultStart), periodEnd: iso(defaultEnd), payDate: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setSaving(true); setError("");
    try {
      const res = await api("/payroll/periods", { method: "POST", body: JSON.stringify(form) });
      onCreated(res.id);
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>New pay period</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-row">
            <div className="form-field"><label>Period start</label><input type="date" value={form.periodStart} onChange={set("periodStart")} /></div>
            <div className="form-field"><label>Period end</label><input type="date" value={form.periodEnd} min={form.periodStart} onChange={set("periodEnd")} /></div>
          </div>
          <div className="form-field"><label>Pay date (optional)</label><input type="date" value={form.payDate} onChange={set("payDate")} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Creating…" : "Create period"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Employee Rates ---------------------------------------------------------

function EmployeeRatesTab({ canEdit, onError, revision }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState({});

  const load = useCallback(async () => {
    try {
      const all = await api("/employees");
      setEmployees(all.filter((e) => e.employmentStatus === "Active"));
    } catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => `${e.fullName} ${e.employeeNo} ${e.position} ${e.site}`.toLowerCase().includes(q));
  }, [employees, search]);

  async function save(emp, field, value) {
    setSaving((s) => ({ ...s, [emp.id]: true }));
    try {
      await api(`/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
      await load();
    } catch (e) { onError(e.message); }
    finally { setSaving((s) => ({ ...s, [emp.id]: false })); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <input type="text" className="search-input" placeholder="Search name, number, position, or site..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{!loading && `${rows.length} active employee${rows.length === 1 ? "" : "s"}`}</div>
      </div>
      {/* Inner scrollport, NOT the app-wide .sticky-card pattern — deliberate,
          and reverting it reintroduces a real bug. .sticky-card sets
          overflow:visible so the card cannot capture the sticky header, but
          .app-main is a flex item with min-width:0, so a table wider than its
          card paints outside the viewport and NOTHING scrolls to it — the
          right-hand columns become unreachable, silently. This table's own
          header labels alone already exceed the card below 900px. See the
          .wide-card rule in index.css. */}
      <div className="section-card wide-card">
        <div className="section-head">Pay rates</div>
        <div className="wide-scroll">
        <table className="sticky-head">
          <thead><tr><th>Employee No</th><th>Name</th><th>Position</th><th>Site</th><th>Pay Type</th><th>Daily Rate</th><th>Monthly Rate</th><th>Tax Exempt</th></tr></thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={8}>Loading employees…</td></tr>}
            {!loading && rows.length === 0 && <tr className="empty-row"><td colSpan={8}>No active employees match your search.</td></tr>}
            {!loading && rows.map((e) => (
              <tr key={e.id}>
                <td data-label="Employee No">{e.employeeNo || "—"}</td>
                <td data-label="Name"><strong>{e.fullName}</strong></td>
                <td data-label="Position" style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{e.position || "—"}</td>
                <td data-label="Site">{e.site ? <span className="chip">{e.site}</span> : "—"}</td>
                <td data-label="Pay Type">
                  {canEdit ? (
                    <select defaultValue={e.payType || "Daily"} disabled={saving[e.id]} onChange={(ev) => save(e, "payType", ev.target.value)}>
                      <option value="Daily">Daily</option>
                      <option value="Monthly">Monthly</option>
                    </select>
                  ) : (e.payType || "Daily")}
                </td>
                <td data-label="Daily Rate">
                  {canEdit ? (
                    <input type="number" min="0" step="0.01" defaultValue={e.dailyRate || ""} style={{ width: 100 }} disabled={saving[e.id]}
                      onBlur={(ev) => { const v = ev.target.value === "" ? null : Number(ev.target.value); if (v !== (e.dailyRate ?? null)) save(e, "dailyRate", v); }} />
                  ) : (e.dailyRate != null ? peso(e.dailyRate) : "—")}
                </td>
                <td data-label="Monthly Rate">
                  {canEdit ? (
                    <input type="number" min="0" step="0.01" defaultValue={e.monthlyRate || ""} style={{ width: 110 }} disabled={saving[e.id]}
                      onBlur={(ev) => { const v = ev.target.value === "" ? null : Number(ev.target.value); if (v !== (e.monthlyRate ?? null)) save(e, "monthlyRate", v); }} />
                  ) : (e.monthlyRate != null ? peso(e.monthlyRate) : "—")}
                </td>
                <td data-label="Tax Exempt" title="Minimum-wage earners are exempt from income tax under RA 9504.">
                  {canEdit ? (
                    <input type="checkbox" checked={!!e.taxExempt} disabled={saving[e.id]}
                      onChange={(ev) => save(e, "taxExempt", ev.target.checked)} />
                  ) : (e.taxExempt ? "Yes" : "No")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}

// ---- Employee Assignments (recurring allowances / loans + info-only benefits) ----

function EmployeeAssignmentsTab({ canEdit, onError, revision }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [components, setComponents] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [benefits, setBenefits] = useState([]);
  const [picker, setPicker] = useState({ componentId: "", amount: "", totalOwed: "", note: "" });
  const [newComponent, setNewComponent] = useState({ show: false, name: "", kind: "Earning" });
  const [benefitForm, setBenefitForm] = useState({ benefitName: "", provider: "", effectiveDate: "", notes: "" });

  // `revision` is listed so Refresh reloads this tab too. It is the only tab
  // here that loads with a bare useEffect rather than the shared `load`
  // callback, so a blanket edit to the load effects would have skipped it and
  // left Refresh silently doing nothing on this one tab.
  useEffect(() => {
    api("/leave/employees").then((e) => setEmployees(Array.isArray(e) ? e : [])).catch(() => {});
  }, [revision]);

  const loadForEmployee = useCallback(async (id) => {
    if (!id) { setAssignments([]); setBenefits([]); return; }
    try {
      const [a, b] = await Promise.all([
        api(`/payroll/employee-components/${id}`),
        api(`/payroll/employee-benefits/${id}`),
      ]);
      setAssignments(a); setBenefits(b);
    } catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { loadForEmployee(employeeId); }, [employeeId, loadForEmployee]);
  useEffect(() => {
    api("/payroll/components").then((c) => setComponents(c.filter((x) => x.active))).catch(() => {});
  }, []);

  async function createComponent() {
    if (!newComponent.name.trim()) return;
    try {
      const c = await api("/payroll/components", {
        method: "POST",
        body: JSON.stringify({ name: newComponent.name.trim(), kind: newComponent.kind, category: newComponent.kind === "Earning" ? "Allowance" : "Other" }),
      });
      setComponents((prev) => [...prev, c]);
      setPicker((p) => ({ ...p, componentId: String(c.id) }));
      setNewComponent({ show: false, name: "", kind: "Earning" });
    } catch (e) { onError(e.message); }
  }

  const selectedComponent = components.find((c) => String(c.id) === String(picker.componentId));

  async function addAssignment() {
    if (!employeeId || !picker.componentId || !picker.amount) return;
    try {
      await api(`/payroll/employee-components/${employeeId}/${picker.componentId}`, {
        method: "PUT",
        body: JSON.stringify({
          amount: Number(picker.amount),
          totalOwed: picker.totalOwed === "" ? null : Number(picker.totalOwed),
          balanceRemaining: picker.totalOwed === "" ? null : Number(picker.totalOwed),
          note: picker.note, active: true,
        }),
      });
      setPicker({ componentId: "", amount: "", totalOwed: "", note: "" });
      await loadForEmployee(employeeId);
    } catch (e) { onError(e.message); }
  }

  async function toggleAssignment(a, active) {
    try {
      await api(`/payroll/employee-components/${employeeId}/${a.componentId}`, {
        method: "PUT", body: JSON.stringify({ amount: a.amount, totalOwed: a.totalOwed, balanceRemaining: a.balanceRemaining, note: a.note, active }),
      });
      await loadForEmployee(employeeId);
    } catch (e) { onError(e.message); }
  }

  async function removeAssignment(a) {
    if (!await confirm(`Remove the ${a.name} assignment for this employee?`)) return;
    try { await api(`/payroll/employee-components/${employeeId}/${a.componentId}`, { method: "DELETE" }); await loadForEmployee(employeeId); }
    catch (e) { onError(e.message); }
  }

  async function addBenefit() {
    if (!benefitForm.benefitName.trim()) return;
    try {
      await api("/payroll/employee-benefits", { method: "POST", body: JSON.stringify({ employeeId: Number(employeeId), ...benefitForm }) });
      setBenefitForm({ benefitName: "", provider: "", effectiveDate: "", notes: "" });
      await loadForEmployee(employeeId);
    } catch (e) { onError(e.message); }
  }
  async function removeBenefit(id) {
    try { await api(`/payroll/employee-benefits/${id}`, { method: "DELETE" }); await loadForEmployee(employeeId); }
    catch (e) { onError(e.message); }
  }

  return (
    <div className="section-card">
      <div className="section-head">Recurring allowances, loans &amp; benefits</div>
      <div style={{ padding: "14px 18px 0" }}>
        <div className="form-field" style={{ maxWidth: 360 }}>
          <label>Employee</label>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— Select employee —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}{e.employeeNo ? ` (${e.employeeNo})` : ""}</option>)}
          </select>
        </div>
      </div>

      {employeeId && (
        <div style={{ padding: 18 }}>
          <h4 style={{ margin: "0 0 8px" }}>Recurring pay components</h4>
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Amount / Cutoff</th><th>Balance remaining</th><th>Active</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {assignments.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 6 : 5}>No recurring assignments yet.</td></tr>}
              {assignments.map((a) => (
                <tr key={a.componentId}>
                  <td data-label="Name"><strong>{a.name}</strong>{a.note ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{a.note}</div> : null}</td>
                  <td data-label="Kind">{a.kind}</td>
                  <td data-label="Amount / Cutoff">{peso(a.amount)}</td>
                  <td data-label="Balance remaining">{a.balanceRemaining != null ? peso(a.balanceRemaining) : "—"}</td>
                  <td data-label="Active">{a.active ? "Yes" : "No"}</td>
                  {canEdit && (
                    <td data-label="" style={{ whiteSpace: "nowrap" }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => toggleAssignment(a, !a.active)}>{a.active ? "Pause" : "Resume"}</button>{" "}
                      <button className="btn btn-sm btn-danger" onClick={() => removeAssignment(a)}>Remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {canEdit && (
            <div className="add-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="form-field" style={{ minWidth: 200 }}>
                <label>Pay component</label>
                {!newComponent.show ? (
                  <>
                    <select value={picker.componentId} onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__new__") { setNewComponent({ show: true, name: "", kind: "Earning" }); return; }
                      // Seed the amount from the component's default set in
                      // Manage Lists. Left editable: the default is a starting
                      // point, not a lock — one guard's Rice Allowance may
                      // differ from another's.
                      const comp = components.find((c) => String(c.id) === String(v));
                      const def = comp ? Number(comp.defaultAmount) : 0;
                      setPicker((p) => ({ ...p, componentId: v, amount: def > 0 ? String(def) : "" }));
                    }}>
                      <option value="">— Select —</option>
                      {components.length === 0 && <option value="" disabled>(no active pay components — see note below)</option>}
                      {/* Only render a group that actually has entries: an empty
                          optgroup renders as an unselectable header, which reads
                          as a broken dropdown. */}
                      {components.some((c) => c.kind === "Earning") && (
                        <optgroup label="Earnings">
                          {components.filter((c) => c.kind === "Earning").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </optgroup>
                      )}
                      {components.some((c) => c.kind === "Deduction") && (
                        <optgroup label="Deductions">
                          {components.filter((c) => c.kind === "Deduction").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </optgroup>
                      )}
                      <option value="__new__">+ Add new…</option>
                    </select>
                    {components.length === 0 && (
                      <div style={{ fontSize: 11.5, color: "#8a6d1f", marginTop: 4 }}>
                        Allowances, bonuses and loan types are pre-loaded but start <strong>inactive</strong>. Turn on the
                        ones you offer in <strong>Manage Lists → Pay Components</strong>, or pick <strong>+ Add new…</strong> to create one here.
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input type="text" placeholder="New component name" value={newComponent.name} onChange={(e) => setNewComponent((n) => ({ ...n, name: e.target.value }))} />
                    <select value={newComponent.kind} onChange={(e) => setNewComponent((n) => ({ ...n, kind: e.target.value }))}>
                      <option value="Earning">Earning</option>
                      <option value="Deduction">Deduction</option>
                    </select>
                    <button className="btn btn-sm btn-primary" onClick={createComponent}>Add</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setNewComponent({ show: false, name: "", kind: "Earning" })}>Cancel</button>
                  </div>
                )}
              </div>
              <div className="form-field" style={{ maxWidth: 150 }}>
                <label>Amount / cutoff</label>
                <input type="number" min="0" step="0.01" value={picker.amount} onChange={(e) => setPicker((p) => ({ ...p, amount: e.target.value }))} />
                {selectedComponent && Number(selectedComponent.defaultAmount) > 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 3 }}>
                    Default {peso(selectedComponent.defaultAmount)} — editable
                  </div>
                )}
              </div>
              {selectedComponent?.category === "Loan" && (
                <div className="form-field" style={{ maxWidth: 140 }}>
                  <label>Total owed (loans)</label>
                  <input type="number" min="0" step="0.01" value={picker.totalOwed} onChange={(e) => setPicker((p) => ({ ...p, totalOwed: e.target.value }))} />
                </div>
              )}
              <div className="form-field" style={{ minWidth: 160 }}>
                <label>Note (optional)</label>
                <input type="text" value={picker.note} onChange={(e) => setPicker((p) => ({ ...p, note: e.target.value }))} />
              </div>
              <button className="btn btn-primary btn-sm" onClick={addAssignment}>Assign</button>
            </div>
          )}

          <h4 style={{ margin: "22px 0 8px" }}>Non-cash benefits (HMO, insurance — informational only)</h4>
          <table>
            <thead><tr><th>Benefit</th><th>Provider</th><th>Effective</th><th>Notes</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {benefits.length === 0 && <tr className="empty-row"><td colSpan={canEdit ? 5 : 4}>No benefit enrollments recorded.</td></tr>}
              {benefits.map((b) => (
                <tr key={b.id}>
                  <td data-label="Benefit"><strong>{b.benefitName}</strong></td>
                  <td data-label="Provider">{b.provider || "—"}</td>
                  <td data-label="Effective">{b.effectiveDate || "—"}</td>
                  <td data-label="Notes" style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{b.notes || "—"}</td>
                  {canEdit && <td data-label=""><button className="btn btn-sm btn-danger" onClick={() => removeBenefit(b.id)}>Remove</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && (
            <div className="add-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <div className="form-field"><label>Benefit name</label><input type="text" placeholder="e.g. HMO" value={benefitForm.benefitName} onChange={(e) => setBenefitForm((f) => ({ ...f, benefitName: e.target.value }))} /></div>
              <div className="form-field"><label>Provider</label><input type="text" value={benefitForm.provider} onChange={(e) => setBenefitForm((f) => ({ ...f, provider: e.target.value }))} /></div>
              <div className="form-field"><label>Effective date</label><input type="date" value={benefitForm.effectiveDate} onChange={(e) => setBenefitForm((f) => ({ ...f, effectiveDate: e.target.value }))} /></div>
              <div className="form-field" style={{ minWidth: 160 }}><label>Notes</label><input type="text" value={benefitForm.notes} onChange={(e) => setBenefitForm((f) => ({ ...f, notes: e.target.value }))} /></div>
              <button className="btn btn-secondary btn-sm" onClick={addBenefit}>Add</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Statutory Tables --------------------------------------------------------

function StatutoryTablesTab({ isAdmin, onError, revision }) {
  const [configs, setConfigs] = useState(null);
  const [tab, setTab] = useState("sss");
  const [draft, setDraft] = useState(null);
  // Which tab the draft was copied from. setDraft happens in an effect, i.e.
  // AFTER the render that follows a tab click — so for one frame `draft` still
  // holds the PREVIOUS tab's config. Rendering a bracket editor against a
  // config that has no brackets array threw and blanked the whole app, so the
  // editors are held back until the draft matches the tab.
  const [draftKey, setDraftKey] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api("/payroll/config");
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
      setConfigs(byKey);
    } catch (e) { onError(e.message); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  useEffect(() => {
    if (configs && configs[tab]) {
      setDraft(JSON.parse(JSON.stringify(configs[tab].config)));
      setDraftKey(tab);
    }
  }, [configs, tab]);

  async function save() {
    setSaving(true);
    try {
      await api(`/payroll/config/${tab}`, { method: "PUT", body: JSON.stringify({ config: draft }) });
      await load();
    } catch (e) { onError(e.message); }
    finally { setSaving(false); }
  }

  if (!configs) return <div className="section-card" style={{ padding: 18 }}>Loading statutory tables…</div>;

  // Draft belongs to the tab being shown? Keep the tab bar mounted either way
  // so switching never looks frozen; only the panel body waits.
  const ready = draft && draftKey === tab;

  return (
    <div className="section-card sticky-card">
      <div className="tabs" style={{ margin: 0, padding: "14px 18px 0", flexWrap: "wrap" }}>
        {STATUTORY_TABS.map((t) => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {!ready && <div style={{ padding: 18 }}>Loading…</div>}
      {ready && <div style={{ padding: 18 }}>
        <p style={{ fontSize: 12, color: "var(--amber, #b8860b)", background: "var(--amber-bg, #fff7e6)", border: "1px solid #f0dca0", borderRadius: 6, padding: "8px 12px", marginTop: 0 }}>
          These are starting defaults, not authoritative figures. Verify against the latest official SSS / PhilHealth / Pag-IBIG / BIR issuance before relying on computed payroll.
        </p>

        {tab === "sss" && <BracketEditor brackets={draft.brackets} cols={["minMsc", "maxMsc", "msc", "ee", "er", "ec"]} onChange={(b) => setDraft({ ...draft, brackets: b })} readOnly={!isAdmin} />}
        {tab === "withholding_tax" && <BracketEditor brackets={draft.brackets} cols={["min", "max", "base", "rate"]} onChange={(b) => setDraft({ ...draft, brackets: b })} readOnly={!isAdmin} />}
        {tab === "philhealth" && (
          <SimpleFieldsEditor draft={draft} setDraft={setDraft} readOnly={!isAdmin}
            fields={[["ratePercent", "Rate (%)"], ["floor", "Floor (₱)"], ["ceiling", "Ceiling (₱)"]]} />
        )}
        {tab === "pagibig" && (
          <SimpleFieldsEditor draft={draft} setDraft={setDraft} readOnly={!isAdmin}
            fields={[["employeeRateLow", "Employee rate (low, e.g. 0.01)"], ["employeeRateHigh", "Employee rate (high, e.g. 0.02)"], ["threshold", "Threshold (₱)"], ["employerRate", "Employer rate"], ["salaryCap", "Salary cap (₱)"]]} />
        )}
        {tab === "pay_rules" && (
          <>
            <SimpleFieldsEditor draft={draft} setDraft={setDraft} readOnly={!isAdmin}
              fields={[["otMultiplier", "Ordinary-day OT multiplier (e.g. 1.25)"], ["monthlyDivisor", "Monthly divisor (days)"], ["graceMinutes", "Grace minutes"], ["otThresholdMinutes", "OT threshold minutes"]]}
              selectFields={{
                statutoryCutoff: {
                  label: "When to deduct SSS / PhilHealth / Pag-IBIG",
                  wide: true,
                  hint: "Which payslip the month's contributions are withheld from. Income tax is not affected by this — it is assessed on every cutoff.",
                  options: [
                    { value: "second", label: "2nd cutoff only — 16th to end of month (whole month's contribution)" },
                    { value: "first", label: "1st cutoff only — 1st to 15th (whole month's contribution)" },
                    { value: "split", label: "Split evenly — half on each cutoff" },
                  ],
                },
              }} />
            <div className="form-field" style={{ marginTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" disabled={!isAdmin} checked={draft.withholdingTaxEnabled !== false}
                  onChange={(e) => setDraft({ ...draft, withholdingTaxEnabled: e.target.checked })} />
                Withhold income tax
              </label>
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Uncheck to stop withholding income tax for <strong>everyone</strong> — some agencies don't tax
                their guards at all. To exempt only certain people (minimum-wage earners are exempt under
                RA 9504) leave this on and tick <strong>Tax exempt</strong> for them on the Employee Rates tab.
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 10 }}>
              <strong>Statutory deduction cutoff</strong> controls which payslip the month's SSS/PhilHealth/Pag-IBIG
              cash is taken from ("second" = the 16–30/31 run). Income tax is unaffected by that setting: it is
              assessed on every cutoff with half the month's contributions subtracted from each tax base, so the
              tax burden stays even across the month.
            </p>
          </>
        )}
        {tab === "premium_rules" && (
          <>
            <SimpleFieldsEditor draft={draft} setDraft={setDraft} readOnly={!isAdmin}
              fields={[
                ["nightDiffPercent", "Night differential rate (0.10 = 10%)"],
                ["nightStartHour", "Night window starts (hour, 22 = 10PM)"],
                ["nightEndHour", "Night window ends (hour, 6 = 6AM)"],
                ["regularHolidayWorked", "Regular holiday — worked (2.00 = 200%)"],
                ["regularHolidayOt", "Regular holiday — OT (2.60)"],
                ["regularHolidayUnworkedPay", "Regular holiday — unworked (1.00 = 100%)"],
                ["specialDayWorked", "Special non-working — worked (1.30)"],
                ["specialDayOt", "Special non-working — OT (1.69)"],
                ["specialDayUnworkedPay", "Special non-working — unworked (0 = no work, no pay)"],
              ]} />
            <div className="form-field" style={{ marginTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" disabled={!isAdmin} checked={draft.requirePresenceDayBefore !== false}
                  onChange={(e) => setDraft({ ...draft, requirePresenceDayBefore: e.target.checked })} />
                Require presence the workday before for unworked regular-holiday pay (Art. 94)
              </label>
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                On: a guard absent the day before a regular holiday receives no holiday pay — the legal rule.
                Off: unworked regular holidays are always paid.
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 10 }}>
              Night differential applies to hours worked inside the window above, valued at that day's
              applicable rate — so night hours on a holiday are uplifted by the holiday multiplier first.
              Note: a holiday falling on a rest day pays the plain holiday rate; rest-day premium is not implemented.
            </p>
          </>
        )}

        {isAdmin && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        )}
      </div>}
    </div>
  );
}

function BracketEditor({ brackets, cols, onChange, readOnly }) {
  // Defensive default: a config row saved without a brackets array (hand-edited
  // JSON, a partial save) must render an empty editor, not crash the page.
  const rows = Array.isArray(brackets) ? brackets : [];
  function update(i, key, value) {
    const next = rows.map((b, idx) => (idx === i ? { ...b, [key]: value === "" ? null : Number(value) } : b));
    onChange(next);
  }
  function addRow() { onChange([...rows, Object.fromEntries(cols.map((c) => [c, 0]))]); }
  function removeRow(i) { onChange(rows.filter((_, idx) => idx !== i)); }

  return (
    <div>
      {/* Own scrollport: .section-card's overflow:hidden would otherwise stop
          the header sticking to the page. */}
      <table className="sticky-head">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}{!readOnly && <th></th>}</tr></thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  {readOnly ? (b[c] ?? "—") : (
                    <input type="number" step="0.01" style={{ width: 90 }} value={b[c] ?? ""} onChange={(e) => update(i, c, e.target.value)} />
                  )}
                </td>
              ))}
              {!readOnly && <td><button className="btn btn-sm btn-danger" onClick={() => removeRow(i)}>Remove</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={addRow}>+ Add bracket</button>}
    </div>
  );
}

function SimpleFieldsEditor({ draft, setDraft, fields, selectFields, readOnly }) {
  return (
    <div className="form-grid">
      {fields.map(([key, label]) => (
        <div className="form-field" key={key}>
          <label>{label}</label>
          {readOnly ? <div style={{ padding: "4px 0" }}>{draft[key]}</div> : (
            <input type="number" step="0.0001" value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
          )}
        </div>
      ))}
      {/* Options accept either a bare string or {value,label}, so stored
          config values can stay terse while the UI reads plainly. */}
      {selectFields && Object.entries(selectFields).map(([key, cfg]) => {
        const opts = cfg.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
        const current = opts.find((o) => o.value === draft[key]);
        return (
          <div className="form-field" key={key} style={cfg.wide ? { gridColumn: "1 / -1" } : undefined}>
            <label>{cfg.label}</label>
            {readOnly ? <div style={{ padding: "4px 0" }}>{current ? current.label : draft[key]}</div> : (
              <select value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {cfg.hint && <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{cfg.hint}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---- 13th Month Pay ----------------------------------------------------------

function ThirteenthMonthTab({ canEdit, isAdmin, onError, revision }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await api(`/payroll/thirteenth-month?year=${year}`)); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [year, onError]);
  useEffect(() => { load(); }, [load, revision]);

  async function compute() {
    setComputing(true);
    try { await api("/payroll/thirteenth-month/compute", { method: "POST", body: JSON.stringify({ year }) }); await load(); }
    catch (e) { onError(e.message); }
    finally { setComputing(false); }
  }

  async function approve(id) {
    try { await api(`/payroll/thirteenth-month/${id}/approve`, { method: "PATCH" }); await load(); }
    catch (e) { onError(e.message); }
  }
  async function markPaid(id) {
    try { await api(`/payroll/thirteenth-month/${id}/mark-paid`, { method: "PATCH" }); await load(); }
    catch (e) { onError(e.message); }
  }
  // Behind requireAuth — must be fetched with the bearer token rather than
  // navigated to, or the server answers 401.
  async function downloadPayslip(r) {
    try {
      const url = await apiBlobUrl(`/payroll/thirteenth-month/${r.id}/payslip.pdf`);
      downloadBlobUrl(url, `13th-month-${r.employeeNo || r.id}-${r.year}.pdf`);
    } catch (e) { onError(e.message); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="form-field" style={{ maxWidth: 120 }}>
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>
        </div>
        {canEdit && <button className="btn btn-gold" onClick={compute} disabled={computing}>{computing ? "Computing…" : "Compute for this year"}</button>}
      </div>
      <div className="section-card sticky-card">
        <div className="section-head">13th month pay — {year}</div>
        <table className="sticky-head">
          <thead><tr><th>Employee No</th><th>Name</th><th>Total Basic Earned</th><th>13th Month Pay</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr className="empty-row"><td colSpan={6}>No 13th-month records computed for {year} yet.</td></tr>}
            {!loading && rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Employee No">{r.employeeNo || "—"}</td>
                <td data-label="Name"><strong>{r.employeeName}</strong></td>
                <td data-label="Total Basic Earned">{peso(r.totalBasicEarned)}</td>
                <td data-label="13th Month Pay">{peso(r.amount)}</td>
                <td data-label="Status"><span className={`badge ${thirteenthMonthStatusBadgeClass(r.status)}`}>{r.status}</span></td>
                <td data-label="" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => downloadPayslip(r)}>Payslip</button>{" "}
                  {canEdit && r.status === "Draft" && <button className="btn btn-sm btn-primary" onClick={() => approve(r.id)}>Approve</button>}{" "}
                  {isAdmin && r.status === "Approved" && <button className="btn btn-sm btn-primary" onClick={() => markPaid(r.id)}>Mark Paid</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
