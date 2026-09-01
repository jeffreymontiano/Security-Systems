import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { confirm } from "../lib/confirm";
import { prompt } from "../lib/prompt";
import toast from "../lib/toast";

/**
 * Correct a computed payslip figure.
 *
 * An override says "the engine should have ASSESSED X" — it is fed BACK INTO
 * computeEmployeeLine, which then re-runs its own gross → priority/cap/arrears
 * ladder beneath it. That is why the derived totals are absent from this list
 * and cannot be edited here: netPay is what disbursement pays, and an
 * overridden net would reconcile to nothing against its own itemised payslip.
 * Override the components; the totals fall out.
 *
 * Nothing here reprices anything. The figures move on the next RECOMPUTE, which
 * is the same rule billing follows, and the modal says so rather than leaving
 * an admin to wonder why the row did not change.
 */

// Mirrors OVERRIDABLE_FIELDS in src/lib/payrollEngine.js. A copy, because the
// frontend cannot import from src/ — and a deliberately SHORT one: it only
// decides what to draw. The server re-asserts membership on every write, so a
// field missing here is un-editable, never un-guarded.
const FIELDS = [
  { key: "regularPay", label: "Basic pay" },
  { key: "nightDiffPay", label: "Night differential" },
  { key: "builtinOtPay", label: "Built-in OT" },
  { key: "excessOtPay", label: "Excess OT" },
  { key: "holidayPremiumPay", label: "Holiday premium" },
  { key: "holidayUnworkedPay", label: "Holiday (unworked)" },
  { key: "otherEarnings", label: "Other earnings" },
  { key: "lateUndertimeDeduction", label: "Late / undertime" },
  { key: "sssEe", label: "SSS (employee)", statutory: true },
  { key: "philhealthEe", label: "PhilHealth (employee)", statutory: true },
  { key: "pagibigEe", label: "Pag-IBIG (employee)", statutory: true },
  { key: "withholdingTax", label: "Withholding tax", statutory: true },
  // EMPLOYER shares. These were gated out while nothing displayed them; the
  // Monthly Statutory Remittance report now does, which is what makes an
  // override to them verifiable. They do not appear on the payslip and must
  // not -- an employer share is not the guard's money, and correcting one
  // changes what the agency remits, not what is paid. Check the result on
  // Payroll -> Statutory Remittance for the month the period falls in.
  { key: "sssEr", label: "SSS (employer)", statutory: true },
  { key: "sssEc", label: "SSS EC (employer only)", statutory: true },
  { key: "philhealthEr", label: "PhilHealth (employer)", statutory: true },
  { key: "pagibigEr", label: "Pag-IBIG (employer)", statutory: true },
  { key: "otherDeductions", label: "Other deductions" },
];

// FIRST-PAINT SEED ONLY -- not the source of truth (Known Gap 29).
//
// The server owns this list (STATUTORY_REASON_CATEGORIES in
// lib/payrollOverrides.js) and VALIDATES against it, and the overrides endpoint
// already returns it as `reasonCategories`. The modal now renders the server's
// copy; this constant survives solely to fill the dropdown for the moment
// between the modal opening and that fetch resolving.
//
// It must NOT be deleted. The category <select> is not behind the loading
// guard, so removing the seed would leave an admin who opens the modal on a
// statutory field with an EMPTY dropdown until the fetch lands -- and a save in
// that window posts reasonCategory: "" and is refused with a 400.
//
// If the server list is ever edited, this may fall out of date and that is
// harmless: it is replaced the moment the response arrives, and a selection it
// left behind is re-seeded (see load()).
const CATEGORY_SEED = [
  "Correction of a mis-assessed premium",
  "Retroactive adjustment",
  "Employee dispute",
  "Agency policy decision",
];

const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PayrollOverrideModal({ periodId, line, onClose, onChanged }) {
  const [rows, setRows] = useState([]);
  const [field, setField] = useState("otherDeductions");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  // The list the dropdown renders. Seeded locally so it is never empty, then
  // replaced by the server's own list once load() resolves.
  const [categories, setCategories] = useState(CATEGORY_SEED);
  const [category, setCategory] = useState(CATEGORY_SEED[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const spec = FIELDS.find((f) => f.key === field) || FIELDS[0];
  // Statutory corrections demand a category and a longer reason: the record has
  // to explain a change to what the agency remits, not merely note it.
  const isStatutory = !!spec.statutory;
  const minReason = isStatutory ? 25 : 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The endpoint answers { overrides: [...], reasonCategories: [...] }, NOT
      // a bare array. Calling .filter() on the envelope threw
      // "n.filter is not a function" on every open of this modal -- not only
      // when the guard had no standing corrections, which is what the shape
      // made it look like.
      //
      // Normalised HERE rather than by changing the response: the envelope also
      // carries reasonCategories, which is the server's own list and is worth
      // keeping. `?? []` covers a future response that omits the key entirely,
      // so this cannot throw again on shape alone.
      const res = await api(`/payroll/periods/${periodId}/overrides`);
      const all = Array.isArray(res) ? res : (res?.overrides ?? []);
      setRows(all.filter((r) => r.employeeId === line.employeeId));

      // The SERVER's category list, which it also validates against, replaces
      // the local seed (Known Gap 29). Guarded on non-empty: an old response,
      // or a future one that drops the key, must fall back to the seed rather
      // than empty the dropdown and make a statutory override unsubmittable.
      const served = Array.isArray(res?.reasonCategories) ? res.reasonCategories.filter(Boolean) : [];
      if (served.length) {
        setCategories(served);
        // Re-seed a selection the server no longer offers. Without this a
        // renamed category could still be submitted -- and refused with a 400
        // naming a list the admin can see is different -- which is the same
        // drift this fix exists to remove, one layer along.
        setCategory((cur) => (served.includes(cur) ? cur : served[0]));
      }
      setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [periodId, line.employeeId]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setError("");
    try {
      const body = { employeeId: line.employeeId, fieldName: field, value: Number(value), reason };
      if (isStatutory) body.reasonCategory = category;
      const res = await api(`/payroll/periods/${periodId}/overrides`, {
        method: "POST", body: JSON.stringify(body),
      });
      toast.success(res.note || "Override recorded.");
      setValue(""); setReason("");
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function reconfirm(r) {
    if (!await confirm(
      `Re-confirm the ${r.fieldName} override for ${r.employeeName}?\n\n`
      + `The engine computed ${peso(r.computedValue)} when this was set and now computes `
      + `${peso(r.staleComputedValue)}. Re-confirming accepts the new figure as the base and `
      + `keeps your override of ${peso(r.overrideValue)}.`
    )) return;
    try {
      await api(`/payroll/overrides/${r.id}/reconfirm`, { method: "PATCH" });
      toast.success("Override re-confirmed against the new computed base.");
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    const why = await prompt(
      `Remove the ${r.fieldName} override for ${r.employeeName}? `
      + "Why is this correction being withdrawn? (at least 10 characters)",
      "", { title: "Remove correction", confirmLabel: "Remove", multiline: true }
    );
    // prompt() resolves null on cancel — an empty string would be a deliberate blank.
    if (why === null) return;
    try {
      await api(`/payroll/overrides/${r.id}`, { method: "DELETE", body: JSON.stringify({ reason: why }) });
      toast.success("Override removed. The engine's own figure applies on the next recompute.");
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setError(e.message); }
  }

  const current = Number(line[field] ?? 0);

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Correct a figure — {line.employeeName}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div className="form-row">
            <div className="form-field">
              <label>Field</label>
              <select value={field} onChange={(e) => setField(e.target.value)}>
                {FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}{f.statutory ? " — statutory" : ""}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Engine computed</label>
              <input type="text" value={peso(current)} readOnly disabled />
            </div>
            <div className="form-field">
              <label>Corrected to</label>
              <input type="number" min="0" step="0.01" value={value}
                     onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
            </div>
          </div>

          {isStatutory && (
            <div className="form-field">
              <label>Category <span style={{ color: "var(--red)" }}>*</span></label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}

          <div className="form-field">
            <label>
              Reason <span style={{ color: "var(--red)" }}>*</span>
              <span className="hint"> — at least {minReason} characters; this is the only place the correction is explained</span>
            </label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                      placeholder={isStatutory
                        ? "Why the assessed contribution was wrong, and what it should have been."
                        : "Why this figure is being corrected."} />
            <div style={{ fontSize: 11, color: reason.trim().length >= minReason ? "var(--text-mute)" : "var(--red)" }}>
              {reason.trim().length} / {minReason}
            </div>
          </div>

          <p style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
            Net pay, gross pay and the arrears figures cannot be corrected directly — they are
            derived. Correcting a component lets the engine re-derive them through its own
            deduction ladder, so a freed peso still flows to the next contribution and then to
            arrears. <strong>Nothing changes on the payslip until this period is recomputed.</strong>
          </p>

          <div className="section-divider" style={{ marginTop: 6 }}>
            Standing corrections for this guard
          </div>
          {loading ? <div className="empty-hint">Loading…</div> : rows.length === 0 ? (
            <div className="empty-hint">No corrections recorded on this line.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Field</th><th>Engine</th><th>Corrected</th><th>Reason</th><th>By</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Field">
                      {r.fieldName}
                      {r.status === "stale" && (
                        <div style={{ fontSize: 10.5, color: "#8a6d1f", fontWeight: 600 }}
                             title="The engine now computes a different base for this field. Approve is blocked until this is reviewed.">
                          ⚠ base moved — needs review
                        </div>
                      )}
                    </td>
                    <td data-label="Engine">{peso(r.computedValue)}</td>
                    <td data-label="Corrected"><strong>{peso(r.overrideValue)}</strong></td>
                    <td data-label="Reason" style={{ fontSize: 11.5 }}>{r.reason}</td>
                    <td data-label="By" style={{ fontSize: 11.5 }}>{r.createdBy}</td>
                    <td data-label="">
                      {r.status === "stale" && (
                        <button className="btn btn-sm btn-secondary" onClick={() => reconfirm(r)}>Re-confirm</button>
                      )}{" "}
                      <button className="btn btn-sm btn-outline" onClick={() => remove(r)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-gold" onClick={save}
                  disabled={saving || value === "" || reason.trim().length < minReason}>
            {saving ? "Recording…" : "Record correction"}
          </button>
        </div>
      </div>
    </div>
  );
}
