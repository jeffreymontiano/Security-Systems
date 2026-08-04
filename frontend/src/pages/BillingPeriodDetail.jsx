import { Fragment, useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { peso, hours, billingStatusBadgeClass, periodLabel } from "./billingShared";

export default function BillingPeriodDetail({ periodId, onClose }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editLine, setEditLine] = useState(null);
  const [expandedLine, setExpanded] = useState(null);
  const [dayRows, setDayRows] = useState([]);

  const load = useCallback(async () => {
    try { setData(await api(`/billing/periods/${periodId}`)); }
    catch (e) { setError(e.message); }
  }, [periodId]);
  useEffect(() => { load(); }, [load]);

  // The days behind a derived figure, loaded on demand. This is what answers
  // "which day did you deduct, and for whom?" when a client queries a
  // statement — the reason billing_line_days exists at all.
  async function toggleDays(lineId) {
    if (expandedLine === lineId) { setExpanded(null); setDayRows([]); return; }
    setExpanded(lineId); setDayRows([]);
    try { setDayRows(await api(`/billing/lines/${lineId}/days`)); }
    catch (e) { setError(e.message); }
  }

  async function act(path, method = "PATCH", confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError("");
    try { await api(path, { method }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // PDFs sit behind requireAuth. window.open can't attach the bearer token and
  // comes back 401 — fetch as a blob with the header instead.
  async function download(path, filename) {
    setError("");
    try { downloadBlobUrl(await apiBlobUrl(path), filename); }
    catch (e) { setError(e.message); }
  }

  if (!data) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading billing period…"}</div>
        </div>
      </div>
    );
  }

  const { period, lines } = data;
  const isDraft = period.status === "Draft";
  const sum = (k) => lines.reduce((s, l) => s + Number(l[k] || 0), 0);

  // Any line whose billed quantity isn't the one attendance derived. Surfaced
  // as a KPI so nobody issues an edited statement believing it was computed.
  const overridden = lines.filter(
    (l) => l.guardsOverride != null || l.lessHoursOverride != null || l.addHoursOverride != null
  );

  const computedAt = (() => {
    const stamps = lines.map((l) => l.computedAt).filter(Boolean).sort();
    if (!stamps.length) return null;
    const d = new Date(stamps[stamps.length - 1]);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
  })();

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1240 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {period.clientName} — {periodLabel(period.periodStart, period.periodEnd)}
            <span className={`badge ${billingStatusBadgeClass(period.status)}`} style={{ marginLeft: 8 }}>{period.status}</span>
            {period.soaNo && <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-mute)" }}>{period.soaNo}</span>}
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
            <div className="kpi-card"><div className="kpi-label">Detachments</div><div className="kpi-value">{lines.length}</div></div>
            <div className="kpi-card"><div className="kpi-label">Guards billed</div><div className="kpi-value">{sum("guards")}</div></div>
            <div className="kpi-card"><div className="kpi-label">Billing cost</div><div className="kpi-value" style={{ fontSize: 20 }}>{peso(sum("billingCost"))}</div></div>
            <div className="kpi-card good"><div className="kpi-label">Client pays</div><div className="kpi-value" style={{ fontSize: 20 }}>{peso(sum("netAmount"))}</div></div>
          </div>

          {!lines.length && (
            <div className="purpose-bar" style={{ margin: "0 0 14px" }}>
              No detachments computed yet. Press <strong>Compute</strong> to derive each detachment's billable
              hours from attendance for {periodLabel(period.periodStart, period.periodEnd)}.
            </div>
          )}

          {overridden.length > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--gold-bg, #FBF3DA)", borderColor: "#e6d7a8" }}>
              {overridden.length} line{overridden.length === 1 ? " has" : "s have"} a manually entered quantity that
              differs from attendance. Recompute will keep those edits — clear an override to return to the derived figure.
            </div>
          )}

          {computedAt && (
            <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 10 }}>
              Last computed {computedAt}. Attendance corrections approved after that are not reflected until you recompute.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {canEdit && isDraft && (
              <button className="btn btn-gold" onClick={() => act(`/billing/periods/${periodId}/compute`, "POST")} disabled={busy}>
                {busy ? "Working…" : lines.length ? "Recompute from attendance" : "Compute from attendance"}
              </button>
            )}
            {isAdmin && isDraft && lines.length > 0 && (
              <button className="btn btn-primary" onClick={() => act(`/billing/periods/${periodId}/issue`, "PATCH",
                "Issue this statement? Its figures are frozen and it is assigned a statement number.")} disabled={busy}>
                Issue statement
              </button>
            )}
            {isAdmin && period.status === "Issued" && (
              <>
                <button className="btn btn-primary" onClick={() => act(`/billing/periods/${periodId}/mark-paid`, "PATCH",
                  "Mark this statement as paid? This locks the period.")} disabled={busy}>
                  Mark paid
                </button>
                <button className="btn btn-secondary" onClick={() => act(`/billing/periods/${periodId}/reopen`, "PATCH",
                  "Reopen this statement for correction? It keeps its statement number.")} disabled={busy}>
                  Reopen
                </button>
              </>
            )}
            {lines.length > 0 && (
              <>
                <button className="btn btn-secondary"
                  onClick={() => download(`/billing/periods/${periodId}/soa.pdf`, `SOA-${period.clientName}-${period.periodStart}_${period.periodEnd}.pdf`)}>
                  Download all statements
                </button>
                <button className="btn btn-secondary"
                  onClick={() => download(`/billing/periods/${periodId}/summary.pdf`, `billing-summary-${period.periodStart}_${period.periodEnd}.pdf`)}>
                  Computation sheet
                </button>
              </>
            )}
          </div>

          <div className="section-card sticky-card">
            <div className="section-head">Statement lines</div>
            <table className="sticky-head">
              <thead>
                <tr>
                  <th>Detachment</th><th>Guards</th><th>Period rate</th>
                  <th>LESS hrs</th><th>LESS amt</th><th>ADD hrs</th><th>ADD amt</th>
                  <th>Billing cost</th><th>Due for guard</th><th>Admin fee</th><th>2% W/tax</th><th>Net amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!lines.length && <tr className="empty-row"><td colSpan={13}>Nothing computed yet.</td></tr>}
                {lines.map((l) => (
                  <Fragment key={l.id}>
                    <tr>
                      <td>
                        <strong>{l.detachmentName || l.site}</strong>
                        {(l.detachmentName && l.detachmentName !== l.site) &&
                          <div style={{ fontSize: 11, color: "var(--text-mute)" }}>rostered as {l.site}</div>}
                      </td>
                      <td>
                        {l.guards}
                        {l.guardsOverride != null && <OverrideTag derived={l.derivedGuards} />}
                      </td>
                      <td>{peso(l.billingPeriodRate)}</td>
                      <td>
                        {hours(l.lessHours)}
                        {l.lessHoursOverride != null && <OverrideTag derived={`${Number(l.derivedLessHours)} h`} />}
                      </td>
                      <td style={{ color: Number(l.lessAmount) > 0 ? "var(--red)" : undefined }}>
                        {Number(l.lessAmount) > 0 ? `(${peso(l.lessAmount)})` : peso(0)}
                      </td>
                      <td>
                        {hours(l.addHours)}
                        {l.addHoursOverride != null && <OverrideTag derived={`${Number(l.derivedAddHours)} h`} />}
                      </td>
                      <td style={{ color: Number(l.addAmount) > 0 ? "var(--teal)" : undefined }}>{peso(l.addAmount)}</td>
                      <td><strong>{peso(l.billingCost)}</strong></td>
                      <td>{peso(l.dueForGuard)}</td>
                      <td>{peso(l.adminFee)}</td>
                      <td>{peso(l.withholdingTax)}</td>
                      <td><strong>{peso(l.netAmount)}</strong></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => toggleDays(l.id)}>
                          {expandedLine === l.id ? "Hide days" : "Days"}
                        </button>
                        {canEdit && isDraft && (
                          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 6 }} onClick={() => setEditLine(l)}>Adjust</button>
                        )}
                        <button className="btn btn-sm btn-gold" style={{ marginLeft: 6 }}
                          onClick={() => download(`/billing/lines/${l.id}/soa.pdf`, `SOA-${l.detachmentName || l.site}-${period.periodStart}_${period.periodEnd}.pdf`)}>
                          SOA
                        </button>
                      </td>
                    </tr>
                    {expandedLine === l.id && (
                      <tr>
                        <td colSpan={13} style={{ background: "var(--bg-soft, #F7F9FC)", padding: 14 }}>
                          <DayBreakdown rows={dayRows} line={l} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {lines.length > 0 && (
                  <tr style={{ fontWeight: 700, background: "var(--bg-soft, #F3F6FA)" }}>
                    <td>TOTAL</td>
                    <td>{sum("guards")}</td>
                    <td>{peso(sum("billingPeriodRate"))}</td>
                    <td>{hours(sum("lessHours"))}</td>
                    <td>{peso(sum("lessAmount"))}</td>
                    <td>{hours(sum("addHours"))}</td>
                    <td>{peso(sum("addAmount"))}</td>
                    <td>{peso(sum("billingCost"))}</td>
                    <td>{peso(sum("dueForGuard"))}</td>
                    <td>{peso(sum("adminFee"))}</td>
                    <td>{peso(sum("withholdingTax"))}</td>
                    <td>{peso(sum("netAmount"))}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editLine && (
        <AdjustLineModal
          line={editLine}
          onClose={() => setEditLine(null)}
          onSaved={async () => { setEditLine(null); await load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function OverrideTag({ derived }) {
  return (
    <span
      title={`Attendance derived ${derived}`}
      style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "var(--gold-bg, #FBF3DA)", color: "#7A5C00", whiteSpace: "nowrap" }}
    >
      edited
    </span>
  );
}

function DayBreakdown({ rows, line }) {
  if (!rows.length) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
        No adjustments derived for {line.detachmentName || line.site} — every rostered shift was worked in full,
        with no relief or extra duty.
      </div>
    );
  }
  const less = rows.filter((r) => r.kind === "less");
  const add = rows.filter((r) => r.kind === "add");
  const total = (list) => list.reduce((s, r) => s + Number(r.hours), 0);

  const table = (title, list, colour) => (
    <div style={{ flex: "1 1 320px" }}>
      <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, color: colour }}>
        {title} — {total(list).toLocaleString(undefined, { maximumFractionDigits: 2 })} h
      </div>
      {!list.length && <div style={{ fontSize: 12, color: "var(--text-mute)" }}>None.</div>}
      {list.length > 0 && (
        <table style={{ fontSize: 12 }}>
          <thead><tr><th>Date</th><th>Guard</th><th>Reason</th><th>Hours</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{r.dutyDate}</td>
                <td>{r.guardName || "—"}</td>
                <td>{r.reason}</td>
                <td>{Number(r.hours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <>
      <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 10 }}>
        Derived from attendance. These are the days behind the LESS and ADDITIONAL figures — the evidence for
        this line if the client queries it.
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {table("LESS — service not delivered", less, "var(--red)")}
        {table("ADDITIONAL — service beyond contract", add, "var(--teal)")}
      </div>
    </>
  );
}

function AdjustLineModal({ line, onClose, onSaved, onError }) {
  // "" means "no override" — fall back to the derived figure. A stored null is
  // what clears it, which is why these start empty rather than pre-filled.
  const [guards, setGuards] = useState(line.guardsOverride ?? "");
  const [less, setLess] = useState(line.lessHoursOverride ?? "");
  const [add, setAdd] = useState(line.addHoursOverride ?? "");
  const [remarksLess, setRemarksLess] = useState(line.remarksLess || "");
  const [remarksAdd, setRemarksAdd] = useState(line.remarksAdd || "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/billing/lines/${line.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          guardsOverride: guards === "" ? null : Number(guards),
          lessHoursOverride: less === "" ? null : Number(less),
          addHoursOverride: add === "" ? null : Number(add),
          remarksLess, remarksAdd,
        }),
      });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  const derivedGuardsNote = line.contractedGuards
    ? `contract says ${line.contractedGuards}; roster shows ${line.derivedGuards}`
    : `roster shows ${line.derivedGuards}`;

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Adjust {line.detachmentName || line.site}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 16 }}>
            Leave a field blank to bill what attendance derived. A value here overrides it and survives
            recomputing, so a deliberate correction can't be lost by pressing Recompute.
          </div>
          <div className="form-field">
            <label>Guards billed</label>
            <input type="number" value={guards} onChange={(e) => setGuards(e.target.value)} placeholder={String(line.guards)} />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>Currently billing {line.guards} — {derivedGuardsNote}.</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-field">
              <label>LESS hours</label>
              <input type="number" step="0.25" value={less} onChange={(e) => setLess(e.target.value)} placeholder={String(Number(line.derivedLessHours))} />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>Attendance derived {Number(line.derivedLessHours)} h.</div>
            </div>
            <div className="form-field">
              <label>ADDITIONAL hours</label>
              <input type="number" step="0.25" value={add} onChange={(e) => setAdd(e.target.value)} placeholder={String(Number(line.derivedAddHours))} />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>Attendance derived {Number(line.derivedAddHours)} h.</div>
            </div>
          </div>
          <div className="form-field">
            <label>LESS remark</label>
            <input value={remarksLess} onChange={(e) => setRemarksLess(e.target.value)} placeholder="Printed before the LESS line on the statement" />
          </div>
          <div className="form-field">
            <label>ADDITIONAL remark</label>
            <input value={remarksAdd} onChange={(e) => setRemarksAdd(e.target.value)} placeholder="Printed before the ADDITIONAL line on the statement" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save & reprice"}</button>
        </div>
      </div>
    </div>
  );
}
