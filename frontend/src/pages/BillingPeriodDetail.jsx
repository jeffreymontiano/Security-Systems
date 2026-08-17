import { Fragment, useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import { peso, hours, pct, billingStatusBadgeClass, periodLabel } from "./billingShared";

export default function BillingPeriodDetail({ periodId, onClose }) {
  const { isAdmin } = useAuth();
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
  const canEdit = !isViewer;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editLine, setEditLine] = useState(null);
  const [expandedLine, setExpanded] = useState(null);
  const [dayRows, setDayRows] = useState([]);
  // Attendance sites with hours in this period that no detachment claims.
  // Populated by the compute response, not by load(), because it describes the
  // run rather than the stored period.
  const [unmapped, setUnmapped] = useState([]);

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
    if (confirmText && !await confirm(confirmText)) return;
    setBusy(true); setError("");
    try { await api(path, { method }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // Compute is its own handler because its RESPONSE matters: billing now reads
  // attendance by site with no roster fallback, so a site nobody has mapped is
  // hours that cannot reach any statement. The server names them; dropping the
  // response on the floor would hide exactly the thing that needs acting on.
  async function compute() {
    setBusy(true); setError("");
    try {
      const r = await api(`/billing/periods/${periodId}/compute`, { method: "POST" });
      setUnmapped(Array.isArray(r?.unmappedSites) ? r.unmappedSites : []);
      await load();
    } catch (e) { setError(e.message); }
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

  // Duty days the derivation refused to price because their attendance is
  // incomplete — a time in with no time out. Held out of both LESS and ADD, and
  // blocking Issue: the server refuses it with a 409 as well, so this is what
  // stops the click, not the only thing that does.
  const pendingLines = lines.filter((l) => Number(l.pendingReviewDays) > 0);
  const pendingDayCount = pendingLines.reduce((s, l) => s + Number(l.pendingReviewDays), 0);

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

          <div className="kpi-grid" data-cols="4" style={{ marginBottom: 16 }}>
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

          {unmapped.length > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--gold-bg, #FBF3DA)", borderColor: "#e6d7a8" }}>
              <strong>{unmapped.length} site{unmapped.length === 1 ? "" : "s"} with attendance in this period {unmapped.length === 1 ? "is" : "are"} not mapped to any client:</strong>{" "}
              {unmapped.join(", ")}. Billing reads attendance by site and there is no roster fallback, so
              those man-hours cannot reach any statement. Map {unmapped.length === 1 ? "it" : "them"} on{" "}
              <strong>Clients &amp; Detachments</strong> and recompute, or leave {unmapped.length === 1 ? "it" : "them"} unmapped
              deliberately if {unmapped.length === 1 ? "that site is" : "those sites are"} not billable.
            </div>
          )}

          {pendingDayCount > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg, #FBEDED)", borderColor: "#f0c9c9" }}>
              <strong>{pendingDayCount} duty day{pendingDayCount === 1 ? "" : "s"} held out of this computation.</strong>{" "}
              {pendingDayCount === 1 ? "A guard timed in and never timed out" : "Guards timed in and never timed out"} at{" "}
              {pendingLines.map((l) => l.detachmentName || l.site).join(", ")}, so {pendingDayCount === 1 ? "that day is" : "those days are"}{" "}
              billed neither as service delivered nor as service missed — charging a full shift and deducting one are both
              claims the record cannot support. Settle {pendingDayCount === 1 ? "it" : "them"} in{" "}
              <strong>Attendance &rarr; Absence Monitoring &rarr; No time-out</strong>: approving a Missing Time Log request
              supplies the missing punch, after which a recompute bills the day normally. This statement cannot be issued
              until then. Press <strong>Days</strong> on a line to see which dates and guards.
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
              <button className="btn btn-gold" onClick={compute} disabled={busy}>
                {busy ? "Working…" : lines.length ? "Recompute from attendance" : "Compute from attendance"}
              </button>
            )}
            {isAdmin && isDraft && lines.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={() => act(`/billing/periods/${periodId}/issue`, "PATCH",
                  "Issue this statement? Its figures are frozen and it is assigned a statement number.")}
                disabled={busy || pendingDayCount > 0}
                title={pendingDayCount > 0
                  ? `${pendingDayCount} duty day(s) have a time in with no time out and are held out of the computation. Settle them in Absence Monitoring, then recompute.`
                  : undefined}
              >
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

          {/* Inner scrollport, NOT the app-wide .sticky-card pattern — deliberate,
              and reverting it reintroduces a real bug. .sticky-card sets
              overflow:visible so the card cannot capture the sticky header, but
              .app-main is a flex item with min-width:0, so a table wider than its
              card paints outside the viewport and NOTHING scrolls to it — the
              right-hand columns become unreachable, silently. This table's own
              header labels alone already exceed the card below 900px. See the
              .wide-card rule in index.css. */}
          <div className="section-card wide-card">
            <div className="section-head">Statement lines</div>
            <div className="wide-scroll">
            <table className="sticky-head">
              <thead>
                <tr>
                  <th>Detachment</th><th>Guards</th><th>Period rate</th>
                  <th>LESS hrs</th><th>LESS amt</th><th>AUGMENT hrs</th><th>AUGMENT amt</th>
                  {/* Not "2% W/tax" — a client may carry its own withholding
                      rate, so the header states the column, not a figure. */}
                  <th>Billing cost</th><th>Due for guard</th><th>Admin fee</th><th>W/tax</th><th>Net amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!lines.length && <tr className="empty-row"><td colSpan={13}>Nothing computed yet.</td></tr>}
                {lines.map((l) => (
                  <Fragment key={l.id}>
                    <tr>
                      <td>
                        <strong>{l.detachmentName || l.site}</strong>
                        {Number(l.pendingReviewDays) > 0 && (
                          <span
                            className="badge badge-open"
                            style={{ marginLeft: 6, whiteSpace: "nowrap" }}
                            title={`${l.pendingReviewDays} duty day(s) timed in with no time out — held out of LESS and ADD until corrected.`}
                          >
                            {l.pendingReviewDays} pending review
                          </span>
                        )}
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
                        {Number(l.addHoursManual) > 0 && (
                          <span
                            title={`Includes ${Number(l.addHoursManual)} h entered by hand as billable excess, on top of the derived figure.`}
                            style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "var(--teal-bg, #E3F2EC)", color: "#1E5E3A", whiteSpace: "nowrap" }}
                          >
                            +{Number(l.addHoursManual)} manual
                          </span>
                        )}
                      </td>
                      <td style={{ color: Number(l.addAmount) > 0 ? "var(--teal)" : undefined }}>{peso(l.addAmount)}</td>
                      <td><strong>{peso(l.billingCost)}</strong></td>
                      <td>{peso(l.dueForGuard)}</td>
                      <td title={l.adminFeePercentUsed != null ? `Administrative overhead at ${pct(l.adminFeePercentUsed)}` : undefined}>
                        {peso(l.adminFee)}
                      </td>
                      <td title={l.withholdingTaxPercentUsed != null ? `Withholding tax at ${pct(l.withholdingTaxPercentUsed)} of the administrative overhead` : undefined}>
                        {peso(l.withholdingTax)}
                      </td>
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
        No adjustments derived for {line.detachmentName || line.site} — every day in the period met its
        contracted man-hours exactly, with nothing short and nothing over.
      </div>
    );
  }
  const less = rows.filter((r) => r.kind === "less");
  const add = rows.filter((r) => r.kind === "add");
  // Neither LESS nor ADD: days the derivation declined to price at all.
  const pending = rows.filter((r) => r.kind === "pending");
  const total = (list) => list.reduce((s, r) => s + Number(r.hours), 0);

  const table = (title, list, colour, hoursNote) => (
    <div style={{ flex: "1 1 320px" }}>
      <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, color: colour }}>
        {title} — {total(list).toLocaleString(undefined, { maximumFractionDigits: 2 })} h
        {hoursNote && <span style={{ fontWeight: 400, color: "var(--text-mute)" }}> {hoursNote}</span>}
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
        Derived from attendance at this post — the roster is not consulted. Each day is one figure: the
        man-hours actually worked, less the man-hours contracted. A day is therefore either short or over,
        never both. This is the evidence for the line if the client queries it.
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {table("LESS — days short of contracted man-hours", less, "var(--red)")}
        {table("AUGMENTATION — days over contracted man-hours", add, "var(--teal)")}
        {pending.length > 0 &&
          table("PENDING REVIEW — not billed either way", pending, "#7A5C00", "(not charged)")}
      </div>
      {pending.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 10, maxWidth: 760 }}>
          A pending shift has a time in and no time out, so it counts <strong>zero</strong> man-hours — which is
          why it shows 0 h, and why it pushes its day further short. The client is credited for hours nobody can
          evidence; approving a Missing Time Log request in Absence Monitoring supplies the missing punch, and a
          recompute counts those hours and shrinks the shortfall. Until then this statement cannot be issued.
        </div>
      )}
    </>
  );
}

function AdjustLineModal({ line, onClose, onSaved, onError }) {
  // "" means "no override" — fall back to the derived figure. A stored null is
  // what clears it, which is why these start empty rather than pre-filled.
  const [guards, setGuards] = useState(line.guardsOverride ?? "");
  const [less, setLess] = useState(line.lessHoursOverride ?? "");
  const [add, setAdd] = useState(line.addHoursOverride ?? "");
  // Additive, not an override — starts at whatever is already charged, and 0
  // means "nothing extra" rather than "unset". Hence Number(), not "".
  const [addManual, setAddManual] = useState(
    Number(line.addHoursManual) > 0 ? Number(line.addHoursManual) : ""
  );
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
          addHoursManual: addManual === "" ? 0 : Number(addManual),
          remarksLess, remarksAdd,
        }),
      });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  // "attendance shows", not "roster shows" — the roster is no longer read by
  // billing at all, and derivedGuards now counts the distinct guards who worked
  // a completed shift at this post.
  const derivedGuardsNote = line.contractedGuards
    ? `contract says ${line.contractedGuards}; attendance shows ${line.derivedGuards} guard(s) actually worked here`
    : `attendance shows ${line.derivedGuards} guard(s) actually worked here`;

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Adjust {line.detachmentName || line.site}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 16 }}>
            Leave a field blank to bill what attendance derived. A value in the first three <em>overrides</em> it
            and survives recomputing, so a deliberate correction can't be lost by pressing Recompute.
            Manual ADDITIONAL hours are different — they are <em>added to</em> the derived figure, not instead of it.
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
            <label>Manual ADDITIONAL hours (billable excess)</label>
            <input type="number" step="0.25" min="0" value={addManual}
              onChange={(e) => setAddManual(e.target.value)} placeholder="0" />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Added <strong>on top of</strong> the figure above, not instead of it — for approved overtime the
              client agreed to pay. Attendance nets each day into one figure, so genuine billable excess has to
              be entered here. Currently charging {Number(line.addHours) || 0} h in total.
            </div>
          </div>
          {/* The derivation already writes these. Showing them as the placeholder
              means a blank field is visibly "use the derived wording" rather
              than "print nothing", and typing overrides it. */}
          <div className="form-field">
            <label>LESS remark</label>
            <input value={remarksLess} onChange={(e) => setRemarksLess(e.target.value)}
              placeholder={line.derivedRemarkLess || "Printed before the LESS line on the statement"} />
            {line.derivedRemarkLess && (
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Leave blank to print the derived wording: <em>{line.derivedRemarkLess}</em>
              </div>
            )}
          </div>
          <div className="form-field">
            <label>ADDITIONAL remark</label>
            <input value={remarksAdd} onChange={(e) => setRemarksAdd(e.target.value)}
              placeholder={line.derivedRemarkAdd || "Printed before the ADDITIONAL line on the statement"} />
            {line.derivedRemarkAdd && (
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Leave blank to print the derived wording: <em>{line.derivedRemarkAdd}</em>
              </div>
            )}
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
