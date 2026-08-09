import { useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import { peso } from "./payrollShared";

// Stage 1 of payroll disbursement: turn an approved pay period into a file the
// finance person uploads to the payment provider.
//
// This screen moves no money. It shows exactly who will be paid, who will not
// and why, and what the payout will cost — so all of that is visible BEFORE
// anything leaves the building.
export default function DisbursementModal({ period, onClose }) {
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
  const canEdit = !isViewer;
  const [batch, setBatch] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBatch(await api(`/payroll/periods/${period.id}/disbursement`));
    } catch (e) {
      // 404 simply means nothing has been prepared yet — the normal first
      // visit, not a failure worth shouting about.
      if (!/no disbursement/i.test(e.message)) setError(e.message);
      setBatch(null);
    } finally { setLoading(false); }
  }, [period.id]);
  useEffect(() => { load(); }, [load]);

  async function prepare() {
    setBusy(true); setError("");
    try {
      const r = await api(`/payroll/periods/${period.id}/disbursement`, { method: "POST" });
      setBatch(r);
      setSkipped(r.skipped || []);
    } catch (e) {
      setError(e.message);
      // A refusal still carries the per-guard reasons, which are the useful
      // part — surface them rather than only the headline.
      if (e.body?.skipped) setSkipped(e.body.skipped);
    } finally { setBusy(false); }
  }

  async function download() {
    setError("");
    try {
      downloadBlobUrl(
        await apiBlobUrl(`/payroll/disbursement/${batch.id}/file`),
        `disbursement-batch${batch.id}-${period.periodStart}_${period.periodEnd}.csv`
      );
      await load();
    } catch (e) { setError(e.message); }
  }

  async function discard() {
    if (!await confirm("Delete this disbursement batch? Do this only if it has not been uploaded to the payment provider — then fix the affected 201 Files and prepare it again.")) return;
    setBusy(true); setError("");
    try {
      await api(`/payroll/disbursement/${batch.id}`, { method: "DELETE" });
      setBatch(null); setSkipped([]);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const s = batch?.summary;

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1040 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            Disbursement — {period.periodStart} to {period.periodEnd}
            {batch && <span className={`badge ${batch.status === "Exported" ? "badge-resolved" : "badge-closed"}`} style={{ marginLeft: 8 }}>{batch.status}</span>}
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="purpose-bar" style={{ margin: "0 0 14px" }}>
            Prepares the file your finance person uploads to the payment provider. <strong>CSOMS never moves
            money</strong> — it only produces the instruction. The provider draws each payout from a balance the
            agency has topped up in advance, so make sure that balance covers the total below before uploading.
          </div>

          {loading && <div className="empty-hint">Loading…</div>}

          {!loading && !batch && (
            <div className="section-card" style={{ padding: 24, textAlign: "center" }}>
              <div style={{ fontSize: 13.5, color: "var(--text-mute)", marginBottom: 16, maxWidth: 560, marginLeft: "auto", marginRight: "auto" }}>
                Nothing prepared yet. This reads each guard's net pay from the approved payslips and their payout
                destination from the 201 File, and lists anyone who cannot be paid electronically so you can fix
                them first.
              </div>
              {canEdit && <button className="btn btn-gold" onClick={prepare} disabled={busy}>{busy ? "Preparing…" : "Prepare disbursement"}</button>}
            </div>
          )}

          {!loading && batch && (
            <>
              <div className="kpi-grid" data-cols="4" style={{ marginBottom: 16 }}>
                <div className="kpi-card"><div className="kpi-label">Guards to pay</div><div className="kpi-value">{s.employeeCount}</div></div>
                <div className="kpi-card good"><div className="kpi-label">Total to disburse</div><div className="kpi-value" style={{ fontSize: 20 }}>{peso(s.totalNet)}</div></div>
                <div className="kpi-card"><div className="kpi-label">Estimated fee</div><div className="kpi-value" style={{ fontSize: 20 }}>{peso(s.estimatedFee)}</div></div>
                <div className="kpi-card"><div className="kpi-label">Funding needed</div><div className="kpi-value" style={{ fontSize: 20 }}>{peso(Number(s.totalNet) + Number(s.estimatedFee))}</div></div>
              </div>

              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 14 }}>
                Fee is an estimate only: {peso(s.feePerPayout)} per successful payout × {s.employeeCount}. The
                provider has announced a per-transaction processing fee from October 2026 and a monthly minimum
                invoice, neither of which is included here — confirm both before relying on this figure.
              </div>

              {s.unconfirmedChannelCount > 0 && (
                <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--amber-bg, #fff7e6)", borderColor: "#f0dca0", color: "#8a6d1f" }}>
                  <strong>{s.unconfirmedChannelCount} row{s.unconfirmedChannelCount === 1 ? "" : "s"} will export with a blank channel code.</strong>{" "}
                  Those destinations have no confirmed provider code yet, so the file cannot route them. Get the
                  code from the provider and add it before uploading — the amounts are correct, only the routing
                  is missing.
                </div>
              )}

              {skipped.length > 0 && (
                <div className="section-card" style={{ padding: 16, marginBottom: 16, borderLeft: "3px solid var(--amber, #d9a441)" }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Not included ({skipped.length})</div>
                  <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 10 }}>
                    These guards are on the payroll but not on this file. Fix the reason on their 201 File, then
                    delete and prepare the batch again.
                  </div>
                  <table>
                    <thead><tr><th>Guard</th><th>Reason</th></tr></thead>
                    <tbody>
                      {skipped.map((k, idx) => (
                        <tr key={idx}>
                          <td><strong>{k.guardName}</strong></td>
                          <td style={{ fontSize: 12.5 }}>{k.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {canEdit && <button className="btn btn-gold" onClick={download}>Download disbursement file</button>}
                {isAdmin && <button className="btn btn-danger" onClick={discard} disabled={busy}>Delete batch</button>}
              </div>

              {batch.exportedAtPh && (
                <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 12 }}>
                  Last exported {batch.exportedAtPh} by {batch.exportedBy}.
                </div>
              )}

              <div className="section-card sticky-card">
                <div className="section-head">Payouts on this file</div>
                <table className="sticky-head">
                  <thead>
                    <tr><th>Guard</th><th>Channel</th><th>Account</th><th>Account name</th><th>Net amount</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {!batch.items.length && <tr className="empty-row"><td colSpan={6}>No payable guards.</td></tr>}
                    {batch.items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <strong>{i.guardName}</strong>
                          <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{i.employeeNo}</div>
                        </td>
                        <td style={{ fontSize: 12.5 }}>
                          {i.payoutChannel}
                          {!i.channelCodeConfirmed && (
                            <div style={{ fontSize: 11, color: "#8a6d1f" }}>no channel code yet</div>
                          )}
                        </td>
                        <td style={{ fontSize: 12.5, fontFamily: "monospace" }}>{i.payoutAccountNumber}</td>
                        <td style={{ fontSize: 12.5 }}>{i.payoutAccountName}</td>
                        <td><strong>{peso(i.netAmount)}</strong></td>
                        <td><span className="badge badge-closed">{i.status}</span></td>
                      </tr>
                    ))}
                    {batch.items.length > 0 && (
                      <tr style={{ fontWeight: 700, background: "var(--bg-soft, #F3F6FA)" }}>
                        <td colSpan={4}>TOTAL</td>
                        <td>{peso(s.totalNet)}</td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 12 }}>
                Account numbers are masked here. The full number appears only inside the downloaded file.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
