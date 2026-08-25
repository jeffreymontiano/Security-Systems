import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { confirm } from "../lib/confirm";
import toast from "../lib/toast";

/**
 * Retired attendance punches, and the way back.
 *
 * Deleting a punch on the register is a SOFT delete: the row is retired, not
 * erased, so a mistaken deletion is recoverable. That recoverability is the
 * entire justification for the design — it is what the schema change, the
 * nullable state and the filter on every read path are paid for with.
 *
 * Without this screen the restore existed only as an API call, which meant the
 * register offered a Delete button that READ as reversible and, for anyone
 * without a terminal and a bearer token, was not. An operations user who
 * deleted a punch in error could not undo it themselves — and neither could an
 * administrator working in the app.
 *
 * Gated on the SAME privilege as the Delete button and all three routes
 * (`perm.delete`), so nothing new is granted: whoever can retire a punch can
 * see what they retired and put it back.
 */
export default function RetiredPunches({ canRestore, onRestored }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api("/attendance/_all/deleted"));
      setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function restore(r) {
    if (!await confirm(
      `Restore the ${r.punchType} punch for ${r.guardName} at "${r.site}" on ${r.punchAtPh}?\n\n`
      + "It returns to the register, the attendance reports, payroll and billing. "
      + "Figures already computed do not change until the affected period is recomputed."
    )) return;
    setBusyId(r.id);
    try {
      const res = await api(`/attendance/${r.id}/restore`, { method: "PATCH" });
      // Naming the affected periods matters: billing and payroll read punches
      // live at compute time, so nothing is repriced by the restore itself.
      const periods = (res && res.affectedPeriods) || [];
      toast.success(periods.length
        ? `Punch restored. Recompute ${periods.length === 1 ? "this billing period" : "these billing periods"} `
          + `to reflect it: ${periods.map((p) => `${p.clientName} (${p.status})`).join(", ")}`
        : "Punch restored. It falls in no billing period yet.");
      await load();
      if (onRestored) await onRestored();
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  }

  return (
    <div className="section-card" style={{ margin: "16px 32px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>Retired punches</h3>
          <div style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 2 }}>
            A deleted punch is retired, never erased — its selfie and coordinates are kept.
            Restoring one returns it to every report, payslip and statement.
          </div>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}

      {loading ? <div className="empty-hint">Loading…</div> : rows.length === 0 ? (
        <div className="empty-hint">Nothing has been retired. Deleted punches appear here so they can be put back.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Guard</th><th>Site</th><th>Type</th><th>Punched</th>
              <th>Retired by</th><th>Retired</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Guard">
                  <strong>{r.guardName}</strong>
                  {r.employeeNo && <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.employeeNo}</div>}
                </td>
                <td data-label="Site">{r.site || "—"}</td>
                <td data-label="Type">{r.punchType}</td>
                <td data-label="Punched">{r.punchAtPh}</td>
                <td data-label="Retired by">{r.deletedBy || "—"}</td>
                <td data-label="Retired">{r.deletedAtPh}</td>
                <td data-label="">
                  {canRestore && (
                    <button className="btn btn-sm btn-outline" disabled={busyId === r.id}
                      onClick={() => restore(r)}>
                      {busyId === r.id ? "Restoring…" : "Restore"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
