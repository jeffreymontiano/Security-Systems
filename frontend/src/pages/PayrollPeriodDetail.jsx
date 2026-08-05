import { useEffect, useState, useCallback, Fragment } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { peso, periodStatusBadgeClass, dayTypeBadgeClass } from "./payrollShared";
import DisbursementModal from "./DisbursementModal";

export default function PayrollPeriodDetail({ periodId, onClose }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [period, setPeriod] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adjustLine, setAdjustLine] = useState(null);
  const [addComponentLine, setAddComponentLine] = useState(null);
  const [expandedLine, setExpandedLine] = useState(null);
  const [dayRows, setDayRows] = useState([]);
  const [showDisbursement, setShowDisbursement] = useState(false);

  // Per-day audit breakdown for one payslip, loaded on demand when a row is
  // expanded — this is what makes a premium defensible in a pay dispute.
  async function toggleDays(lineId) {
    if (expandedLine === lineId) { setExpandedLine(null); setDayRows([]); return; }
    setExpandedLine(lineId); setDayRows([]);
    try { setDayRows(await api(`/payroll/lines/${lineId}/days`)); }
    catch (e) { setError(e.message); }
  }

  const load = useCallback(async () => {
    try { setPeriod(await api(`/payroll/periods/${periodId}`)); }
    catch (e) { setError(e.message); }
  }, [periodId]);
  useEffect(() => { load(); }, [load]);

  async function compute() {
    setBusy(true); setError("");
    try { await api(`/payroll/periods/${periodId}/compute`, { method: "POST" }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setError("");
    try { await api(`/payroll/periods/${periodId}/approve`, { method: "PATCH" }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function markPaid() {
    if (!window.confirm("Mark this period as Paid? This locks it from further edits.")) return;
    setBusy(true); setError("");
    try { await api(`/payroll/periods/${periodId}/mark-paid`, { method: "PATCH" }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // PDF routes sit behind requireAuth, and a plain window.open / <a href>
  // can't attach the bearer token — it navigates instead of fetching, so the
  // server answers 401. Fetch as a blob with the header, like every other
  // module's report download does.
  async function downloadRegister() {
    setError("");
    try {
      const url = await apiBlobUrl(`/payroll/periods/${periodId}/register.pdf`);
      downloadBlobUrl(url, `payroll-register-${period.periodStart}_${period.periodEnd}.pdf`);
    } catch (e) { setError(e.message); }
  }
  async function downloadPayslip(line) {
    setError("");
    try {
      const url = await apiBlobUrl(`/payroll/lines/${line.id}/payslip.pdf`);
      downloadBlobUrl(url, `payslip-${line.employeeNo || line.id}-${period.periodStart}_${period.periodEnd}.pdf`);
    } catch (e) { setError(e.message); }
  }

  if (!period) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading payroll period…"}</div>
        </div>
      </div>
    );
  }

  const lines = period.lines || [];
  const totals = lines.reduce((acc, l) => ({
    gross: acc.gross + Number(l.grossPay), net: acc.net + Number(l.netPay),
    ded: acc.ded + Number(l.sssEe) + Number(l.philhealthEe) + Number(l.pagibigEe) + Number(l.withholdingTax) + Number(l.otherDeductions),
  }), { gross: 0, net: 0, ded: 0 });

  // An employee with no pay rate computes to a valid but entirely zero payslip.
  // That's correct arithmetic, but it's silent — surface it so nobody approves
  // a run without noticing someone was never set up for payroll.
  const unrated = lines.filter((l) => !Number(l.rateUsed));

  // Most recent compute across the lines — they are all written in one pass,
  // so any one of them dates the whole period.
  const computedAt = (() => {
    const stamps = lines.map((l) => l.computedAt).filter(Boolean).sort();
    if (stamps.length === 0) return null;
    const d = new Date(stamps[stamps.length - 1]);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
  })();

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1100 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{period.periodStart} to {period.periodEnd} <span className={`badge ${periodStatusBadgeClass(period.status)}`} style={{ marginLeft: 8 }}>{period.status}</span></h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", margin: "0 0 16px" }}>
            <div className="kpi-card"><div className="kpi-label">Employees</div><div className="kpi-value">{lines.length}</div></div>
            <div className="kpi-card"><div className="kpi-label">Total Gross</div><div className="kpi-value">{peso(totals.gross)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Total Deductions</div><div className="kpi-value">{peso(totals.ded)}</div></div>
            <div className="kpi-card good"><div className="kpi-label">Total Net</div><div className="kpi-value">{peso(totals.net)}</div></div>
          </div>

          {unrated.length > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--amber-bg, #fff7e6)", borderColor: "#f0dca0", color: "#8a6d1f" }}>
              <strong>{unrated.length} employee{unrated.length === 1 ? " has" : "s have"} no pay rate set</strong> — {unrated.length === 1 ? "their" : "their"} payslip{unrated.length === 1 ? "" : "s"} computed to ₱0.00.
              Set a daily or monthly rate on the Employee Rates tab, then Recompute.
              <div style={{ fontSize: 11.5, marginTop: 4 }}>{unrated.map((l) => l.employeeName).join(", ")}</div>
            </div>
          )}

          {/* Figures on this table are STORED, not derived on the fly, so after
              a pay-rule change they keep showing the previous calculation until
              the period is recomputed. Saying when they were computed makes
              that obvious instead of leaving stale numbers looking current. */}
          {computedAt && (
            <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 10 }}>
              Figures computed <strong>{computedAt}</strong>. If pay rules or rates have changed since,
              press <strong>Recompute</strong> to bring them up to date.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {canEdit && period.status !== "Paid" && <button className="btn btn-gold" onClick={compute} disabled={busy}>{busy ? "Computing…" : (lines.length ? "Recompute" : "Compute")}</button>}
            {canEdit && period.status === "Computed" && <button className="btn btn-primary" onClick={approve} disabled={busy}>Approve</button>}
            {isAdmin && period.status === "Approved" && <button className="btn btn-primary" onClick={markPaid} disabled={busy}>Mark Paid</button>}
            {/* Disbursement is prepared from an APPROVED period — once the
                figures are agreed but before the period is locked as Paid,
                which is when the money actually goes out. */}
            {["Approved", "Paid"].includes(period.status) && (
              <button className="btn btn-gold" onClick={() => setShowDisbursement(true)} disabled={lines.length === 0}>
                Prepare disbursement
              </button>
            )}
            <button className="btn btn-outline" onClick={downloadRegister} disabled={lines.length === 0}>Download register (PDF)</button>
          </div>

          <table className="sticky-head">
            <thead>
              <tr>
                <th>Employee</th><th>Site</th><th>Days</th>
                <th>Basic Pay</th><th>Night Diff</th><th>Built-in OT</th><th>Excess OT</th>
                <th>Holiday</th><th>Gross</th>
                <th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Other Ded.</th><th>Net Pay</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr className="empty-row"><td colSpan={16}>No payslip lines yet — click Compute to generate them from attendance, overtime, and leave.</td></tr>}
              {lines.map((l) => (
                <Fragment key={l.id}>
                <tr>
                  <td data-label="Employee">
                    <strong>{l.employeeName}</strong>
                    <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{l.employeeNo}</div>
                    {!Number(l.rateUsed) && <div style={{ fontSize: 11, color: "var(--red)", fontWeight: 600 }}>No pay rate set</div>}
                  </td>
                  <td data-label="Site">{l.site || "—"}</td>
                  <td data-label="Days">{l.presentDays}{Number(l.paidLeaveDays) > 0 ? ` +${l.paidLeaveDays}L` : ""}</td>
                  {/* Basic pay = the day rate for days actually worked (plus any
                      paid leave days), before any premium. */}
                  <td data-label="Basic Pay">{peso(l.regularPay)}</td>
                  <td data-label="Night Diff">
                    {peso(l.nightDiffPay)}
                    {Number(l.nightDiffMinutes) > 0 && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{l.nightDiffMinutes} min</div>}
                  </td>
                  <td data-label="Built-in OT">
                    {peso(l.builtinOtPay)}
                    {Number(l.builtinOtMinutes) > 0 && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{l.builtinOtMinutes} min</div>}
                  </td>
                  <td data-label="Excess OT">
                    {peso(l.excessOtPay)}
                    {Number(l.approvedOtMinutes) > 0 && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{l.approvedOtMinutes} min</div>}
                  </td>
                  <td data-label="Holiday">{peso(Number(l.holidayPremiumPay) + Number(l.holidayUnworkedPay))}</td>
                  <td data-label="Gross">{peso(l.grossPay)}</td>
                  <td data-label="SSS">{peso(l.sssEe)}</td>
                  <td data-label="PhilHealth">{peso(l.philhealthEe)}</td>
                  <td data-label="Pag-IBIG">{peso(l.pagibigEe)}</td>
                  <td data-label="Tax">{peso(l.withholdingTax)}</td>
                  <td data-label="Other Ded.">{peso(l.otherDeductions)}</td>
                  <td data-label="Net Pay">
                    <strong>{peso(l.netPay)}</strong>
                    {Number(l.deductionsDeferred) > 0 && (
                      <div style={{ fontSize: 11, color: "#8a6d1f" }} title="Deductions exceeded this period's pay; the balance carries to the next period.">
                        {peso(l.deductionsDeferred)} carried forward
                      </div>
                    )}
                    {Number(l.arrearsRecovered) > 0 && (
                      <div style={{ fontSize: 11, color: "var(--green, #2e7d32)" }}>
                        {peso(l.arrearsRecovered)} arrears recovered
                      </div>
                    )}
                  </td>
                  <td data-label="" style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => toggleDays(l.id)}>
                      {expandedLine === l.id ? "Hide days" : "Days"}
                    </button>{" "}
                    <button className="btn btn-sm btn-secondary" onClick={() => downloadPayslip(l)}>Payslip</button>{" "}
                    {canEdit && period.status !== "Paid" && (
                      <>
                        <button className="btn btn-sm btn-secondary" onClick={() => setAddComponentLine(l)}>+ Item</button>{" "}
                        <button className="btn btn-sm btn-secondary" onClick={() => setAdjustLine(l)}>Adjust</button>
                      </>
                    )}
                  </td>
                </tr>
                {expandedLine === l.id && (
                  <tr>
                    <td colSpan={16} style={{ background: "#fbfcfd", padding: "10px 14px" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)", marginBottom: 6 }}>
                        Day-by-day breakdown — {l.employeeName}
                      </div>
                      {dayRows.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-mute)" }}>Loading days…</div>
                      ) : (
                        <table style={{ fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th>Date</th><th>Day type</th><th>Worked</th><th>OT min</th>
                              <th>Night min</th><th>Base</th><th>OT pay</th><th>Night diff</th><th>Holiday</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dayRows.map((d) => (
                              <tr key={d.id}>
                                <td data-label="Date">{d.dutyDate}</td>
                                <td data-label="Day type">
                                  <span className={`badge ${dayTypeBadgeClass(d.dayType)}`}>{d.dayType}</span>
                                  {d.holidayName && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{d.holidayName}</div>}
                                  {d.isRestDay && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>Rest day</div>}
                                </td>
                                <td data-label="Worked">{d.worked ? "Yes" : "No"}</td>
                                <td data-label="OT min">{d.otMinutes || "—"}</td>
                                <td data-label="Night min">{(d.nightMinutes + d.nightOtMinutes) || "—"}</td>
                                <td data-label="Base">{peso(d.basePay)}</td>
                                <td data-label="OT pay">{peso(d.otPay)}</td>
                                <td data-label="Night diff">{peso(d.nightDiffPay)}</td>
                                <td data-label="Holiday">{peso(d.holidayPremium)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>

      {adjustLine && (
        <AdjustLineModal line={adjustLine} onClose={() => setAdjustLine(null)} onSaved={async () => { setAdjustLine(null); await load(); }} />
      )}
      {addComponentLine && (
        <AddLineComponentModal line={addComponentLine} onClose={() => setAddComponentLine(null)} onSaved={async () => { setAddComponentLine(null); await load(); }} />
      )}
      {showDisbursement && (
        <DisbursementModal period={period} onClose={() => setShowDisbursement(false)} />
      )}
    </div>
  );
}

function AdjustLineModal({ line, onClose, onSaved }) {
  const [otherDeductions, setOtherDeductions] = useState(String(line.otherDeductions || 0));
  const [note, setNote] = useState(line.otherDeductionsNote || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true); setError("");
    try {
      await api(`/payroll/lines/${line.id}`, {
        method: "PATCH", body: JSON.stringify({ otherDeductions: Number(otherDeductions) || 0, otherDeductionsNote: note }),
      });
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Adjust — {line.employeeName}</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field"><label>Other deductions (catch-all correction)</label><input type="number" min="0" step="0.01" value={otherDeductions} onChange={(e) => setOtherDeductions(e.target.value)} /></div>
          <div className="form-field"><label>Note</label><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for this manual adjustment" /></div>
          <p style={{ fontSize: 11.5, color: "var(--text-mute)" }}>For itemized earnings/deductions (allowances, loan installments), use "+ Item" instead — this field is a single catch-all correction.</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function AddLineComponentModal({ line, onClose, onSaved }) {
  const [components, setComponents] = useState([]);
  const [componentId, setComponentId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newComp, setNewComp] = useState({ name: "", kind: "Earning" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/payroll/components").then((c) => setComponents(c.filter((x) => x.active))).catch(() => {});
  }, []);

  async function createComponent() {
    if (!newComp.name.trim()) return;
    try {
      const c = await api("/payroll/components", {
        method: "POST",
        body: JSON.stringify({ name: newComp.name.trim(), kind: newComp.kind, category: newComp.kind === "Earning" ? "Allowance" : "Other" }),
      });
      setComponents((prev) => [...prev, c]);
      setComponentId(String(c.id));
      setShowNew(false);
    } catch (e) { setError(e.message); }
  }

  async function save() {
    if (!componentId || !amount) { setError("Please choose a pay component and enter an amount."); return; }
    setSaving(true); setError("");
    try {
      await api(`/payroll/lines/${line.id}/components`, {
        method: "POST", body: JSON.stringify({ componentId: Number(componentId), amount: Number(amount), note }),
      });
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Add earning / deduction — {line.employeeName}</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Pay component</label>
            {!showNew ? (
              <>
                <select value={componentId} onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__new__") { setShowNew(true); return; }
                  setComponentId(v);
                  // Pre-fill from the default set in Manage Lists, still editable.
                  const comp = components.find((c) => String(c.id) === String(v));
                  const def = comp ? Number(comp.defaultAmount) : 0;
                  setAmount(def > 0 ? String(def) : "");
                }}>
                  <option value="">— Select —</option>
                  {components.length === 0 && <option value="" disabled>(no active pay components — see note below)</option>}
                  {/* An empty optgroup renders as an unselectable header and
                      reads as a broken dropdown, so only show groups with items. */}
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
                    Pay components are pre-loaded but start <strong>inactive</strong>. Activate the ones you use in
                    {" "}<strong>Manage Lists → Pay Components</strong>, or pick <strong>+ Add new…</strong> to create one here.
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input type="text" placeholder="New component name" value={newComp.name} onChange={(e) => setNewComp((n) => ({ ...n, name: e.target.value }))} />
                <select value={newComp.kind} onChange={(e) => setNewComp((n) => ({ ...n, kind: e.target.value }))}>
                  <option value="Earning">Earning</option>
                  <option value="Deduction">Deduction</option>
                </select>
                <button className="btn btn-sm btn-primary" onClick={createComponent}>Add</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
              </div>
            )}
          </div>
          <div className="form-field">
            <label>Amount</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {(() => {
              const c = components.find((x) => String(x.id) === String(componentId));
              return c && Number(c.defaultAmount) > 0
                ? <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 3 }}>Default {peso(c.defaultAmount)} — editable</div>
                : null;
            })()}
          </div>
          <div className="form-field"><label>Note (optional)</label><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Adding…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
