import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import BillingPeriodDetail from "./BillingPeriodDetail";
import { peso, pct, billingStatusBadgeClass, BILLING_VIEWS, periodLabel } from "./billingShared";

const SUBTITLE = "Bill clients per detachment from the hours guards actually worked, and issue the Statement of Account";

export default function BillingPage() {
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
      <ModuleHeader title="Billing & Statement of Account" subtitle={SUBTITLE} actions={<button className="btn btn-outline btn-sm" onClick={() => setRevision((r) => r + 1)}>Refresh</button>} />
      <PurposeBar>
        Prices each detachment from the same attendance the payroll module pays from, so a day billed to the
        client and a day paid to the guard are always the same day. Deductions for unmanned hours and additions
        for relief or extra duty are derived automatically and stay editable until the statement is issued.
        Contract rates and fee percentages are admin-editable — verify them against the client contract.
      </PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0", flexWrap: "wrap" }}>
        {BILLING_VIEWS.map((v) => (
          <button key={v.key} className={`btn btn-sm ${view === v.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </div>

      {view === "periods" && <BillingPeriodsTab canEdit={canEdit} isAdmin={isAdmin} onOpen={setOpenPeriodId} onError={setError} revision={revision} />}
      {view === "clients" && <ClientsTab isAdmin={isAdmin} onError={setError} revision={revision} />}
      {view === "rules" && <BillingRulesTab isAdmin={isAdmin} onError={setError} revision={revision} />}

      <ConfidentialFooter />

      {openPeriodId && <BillingPeriodDetail periodId={openPeriodId} onClose={() => { setOpenPeriodId(null); }} />}
    </div>
  );
}

// The cadences the engine knows, mirrored for display only. The server's
// CADENCES map in billingEngine.js is authoritative — this exists so the form
// can SHOW the operands a choice resolves to before it is saved, which is what
// makes an inconsistent pair impossible to create by accident.
const CADENCE_OPTIONS = [
  { value: "", label: "Agency default", perMonth: null, days: null },
  { value: "semi_monthly", label: "Semi-monthly", perMonth: 2, days: 15 },
  { value: "monthly", label: "Monthly", perMonth: 1, days: 30 },
];

// ---- Billing periods --------------------------------------------------------

function BillingPeriodsTab({ canEdit, isAdmin, onOpen, onError, revision }) {
  const [periods, setPeriods] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api("/billing/periods"), api("/billing/clients")]);
      setPeriods(p); setClients(c);
    } catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  async function remove(id) {
    if (!await confirm("Delete this billing period? Every statement line it computed will be removed.")) return;
    try { await api(`/billing/periods/${id}`, { method: "DELETE" }); await load(); }
    catch (e) { onError(e.message); }
  }

  const activeClients = clients.filter((c) => c.active);

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
            {!loading && `${periods.length} billing period${periods.length === 1 ? "" : "s"}`}
          </div>
        </div>
        {canEdit && (
          <button className="btn btn-gold" onClick={() => setShowNew(true)} disabled={!activeClients.length}>
            + New billing period
          </button>
        )}
      </div>

      {!loading && !activeClients.length && (
        <div style={{ margin: "0 32px 12px", fontSize: 12.5, color: "var(--text-mute)" }}>
          Add a client and map at least one detachment on the <strong>Clients &amp; Detachments</strong> tab before billing.
        </div>
      )}

      <div className="section-card sticky-card">
        <div className="section-head">Billing periods</div>
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Client</th><th>Period covered</th><th>SOA No</th><th>Status</th>
              <th>Detachments</th><th>Billing cost</th><th>Net amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={8}>Loading billing periods…</td></tr>}
            {!loading && !periods.length && <tr className="empty-row"><td colSpan={8}>No billing periods yet.</td></tr>}
            {!loading && periods.map((p) => (
              <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
                <td><strong>{p.clientName}</strong></td>
                <td>{periodLabel(p.periodStart, p.periodEnd)}</td>
                <td>{p.soaNo || <span style={{ color: "var(--text-mute)" }}>—</span>}</td>
                <td><span className={`badge ${billingStatusBadgeClass(p.status)}`}>{p.status}</span></td>
                <td>{p.lineCount}</td>
                <td>{peso(p.totalBillingCost)}</td>
                <td><strong>{peso(p.totalNetAmount)}</strong></td>
                <td onClick={(e) => e.stopPropagation()}>
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
        <NewPeriodModal
          clients={activeClients}
          onClose={() => setShowNew(false)}
          onSaved={async (id) => { setShowNew(false); await load(); onOpen(id); }}
          onError={onError}
        />
      )}
    </>
  );
}

function NewPeriodModal({ clients, onClose, onSaved, onError }) {
  const [clientId, setClientId] = useState(clients[0]?.id || "");
  const [periodStart, setStart] = useState("");
  const [periodEnd, setEnd] = useState("");
  const [soaDate, setSoaDate] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!clientId || !periodStart || !periodEnd) { onError("A client, start date, and end date are required."); return; }
    setBusy(true);
    try {
      const r = await api("/billing/periods", {
        method: "POST",
        body: JSON.stringify({ clientId, periodStart, periodEnd, soaDate: soaDate || periodEnd }),
      });
      onSaved(r.id);
    } catch (e) { onError(e.message); setBusy(false); }
  }

  // How many days the chosen client's baseline covers, and how many this period
  // actually spans. The engine measures one against the other, so a mismatch
  // moves real money: a monthly client given a half-month period credits the
  // 15 unbilled days as "no calendar date" and halves the invoice. Legitimate
  // part-periods exist (mid-month onboarding, mid-cycle termination), so this
  // WARNS rather than blocks.
  const chosen = clients.find((c) => String(c.id) === String(clientId));
  const stdDays = (CADENCE_OPTIONS.find((o) => o.value === (chosen?.billingCadence || "")) || {}).days;
  const spanDays = (periodStart && periodEnd && periodEnd >= periodStart)
    ? Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 864e5) + 1
    : null;
  // One day either side is the ordinary month-length variation the calendar rule
  // exists to handle; beyond that it is likely the wrong dates.
  const lengthWarning = stdDays && spanDays && Math.abs(spanDays - stdDays) > 1;

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>New billing period</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div className="form-field">
            <label>Client</label>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {stdDays && (
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Billed {(CADENCE_OPTIONS.find((o) => o.value === chosen.billingCadence) || {}).label.toLowerCase()} —
                the period rate covers {stdDays} days.
              </div>
            )}
          </div>

          {lengthWarning && (
            <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--gold-bg, #FBF3DA)", borderColor: "#e6d7a8" }}>
              <strong>This period spans {spanDays} days, but {chosen.name}’s period rate covers {stdDays}.</strong>{" "}
              {spanDays < stdDays
                ? `The ${stdDays - spanDays} missing day(s) will be credited to the client as "no calendar date".`
                : `The ${spanDays - stdDays} extra day(s) will be billed as an augmentation.`}{" "}
              That is correct for a genuine part-period — a mid-month onboarding or a mid-cycle termination —
              but if the dates are wrong it moves real money. Check them before computing.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-field"><label>Period start</label><input type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="form-field"><label>Period end</label><input type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="form-field">
            <label>Statement date</label>
            <input type="date" value={soaDate} onChange={(e) => setSoaDate(e.target.value)} />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Printed on the statement. Defaults to the period end date.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Creating…" : "Create period"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Clients & detachments --------------------------------------------------

function ClientsTab({ isAdmin, onError, revision }) {
  const [clients, setClients] = useState([]);
  const [sites, setSites] = useState([]);
  const [unmapped, setUnmapped] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editClient, setEditClient] = useState(null);
  const [editSite, setEditSite] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api("/billing/clients"), api("/billing/sites")]);
      setClients(c); setSites(s.sites); setUnmapped(s.unmapped);
    } catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  async function removeClient(c) {
    if (!await confirm(`Remove "${c.name}"? If it has been billed before it will be deactivated instead, so its statements stay explainable.`)) return;
    try { await api(`/billing/clients/${c.id}`, { method: "DELETE" }); await load(); }
    catch (e) { onError(e.message); }
  }
  async function removeSite(s) {
    if (!await confirm(`Unmap "${s.site}" from ${s.clientName}? It will stop appearing on future statements.`)) return;
    try { await api(`/billing/sites/${s.id}`, { method: "DELETE" }); await load(); }
    catch (e) { onError(e.message); }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
            {!loading && `${clients.length} client${clients.length === 1 ? "" : "s"} · ${sites.length} detachment${sites.length === 1 ? "" : "s"}`}
          </div>
        </div>
        {isAdmin && (
          <>
            <button className="btn btn-secondary" onClick={() => setEditClient({})}>+ Client</button>
            <button className="btn btn-gold" onClick={() => setEditSite({})} disabled={!clients.length} style={{ marginLeft: 8 }}>+ Detachment</button>
          </>
        )}
      </div>

      <div className="section-card sticky-card">
        <div className="section-head">Clients</div>
        <table className="sticky-head">
          <thead>
            <tr><th>Client</th><th>Business address</th><th>Default contract rate</th><th>Detachments</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={6}>Loading clients…</td></tr>}
            {!loading && !clients.length && <tr className="empty-row"><td colSpan={6}>No clients yet.</td></tr>}
            {!loading && clients.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td style={{ color: "var(--text-mute)" }}>{c.address || "—"}</td>
                <td>
                  {c.contractRate ? peso(c.contractRate) : <span style={{ color: "var(--text-mute)" }}>agency default</span>}
                  {/* Shown here rather than as a seventh column: this table is a
                      .sticky-card, which cannot scroll horizontally, so every
                      column added is one that can become unreachable on a narrow
                      viewport. A client with neither override says nothing,
                      because "nothing" is the default. */}
                  {c.billingCadence && (
                    <div style={{ fontSize: 11, color: "#7A5C00", marginTop: 2 }}>
                      {(CADENCE_OPTIONS.find((o) => o.value === c.billingCadence) || {}).label || c.billingCadence}
                    </div>
                  )}
                  {(c.adminFeePercent != null || c.withholdingTaxPercent != null) && (
                    <div style={{ fontSize: 11, color: "#7A5C00", marginTop: 2 }}>
                      {c.adminFeePercent != null && `overhead ${pct(c.adminFeePercent)}`}
                      {c.adminFeePercent != null && c.withholdingTaxPercent != null && " · "}
                      {c.withholdingTaxPercent != null && `w/tax ${pct(c.withholdingTaxPercent)}`}
                    </div>
                  )}
                </td>
                <td>{c.siteCount}</td>
                <td><span className={`badge ${c.active ? "badge-resolved" : "badge-closed"}`}>{c.active ? "Active" : "Inactive"}</span></td>
                <td>
                  {isAdmin && (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={() => setEditClient(c)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => removeClient(c)} style={{ marginLeft: 6 }}>Remove</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Inner scrollport, NOT the app-wide .sticky-card pattern — deliberate,
          and reverting it reintroduces a real bug. .sticky-card sets
          overflow:visible so the card cannot capture the sticky header, but
          .app-main is a flex item with min-width:0, so a table wider than its
          card paints outside the viewport and NOTHING scrolls to it — the
          right-hand columns become unreachable, silently. This table's own
          header labels alone already exceed the card below 900px. See the
          .wide-card rule in index.css. */}
      <div className="section-card wide-card" style={{ marginTop: 16 }}>
        <div className="section-head">Detachments</div>
        <div className="wide-scroll">
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Site (as rostered)</th><th>Detachment name (on the statement)</th><th>Client</th>
              <th>Contract rate</th><th>Duty hours</th><th>Contracted guards</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={8}>Loading detachments…</td></tr>}
            {!loading && !sites.length && <tr className="empty-row"><td colSpan={8}>No detachments mapped yet.</td></tr>}
            {!loading && sites.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.site}</strong></td>
                <td>{s.detachmentName || s.site}</td>
                <td>{s.clientName}</td>
                <td>{s.contractRate ? peso(s.contractRate) : <span style={{ color: "var(--text-mute)" }}>inherits client</span>}</td>
                <td>{s.dutyHours ? `${Number(s.dutyHours)} h` : <span style={{ color: "var(--text-mute)" }}>default</span>}</td>
                <td>{s.contractedGuards ?? <span style={{ color: "var(--text-mute)" }}>from roster</span>}</td>
                <td><span className={`badge ${s.active ? "badge-resolved" : "badge-closed"}`}>{s.active ? "Active" : "Inactive"}</span></td>
                <td>
                  {isAdmin && (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={() => setEditSite(s)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => removeSite(s)} style={{ marginLeft: 6 }}>Unmap</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {!loading && unmapped.length > 0 && (
        <div className="section-card" style={{ marginTop: 16, padding: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Sites not mapped to a client</div>
          <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 10, maxWidth: 700 }}>
            These sites appear on the roster but belong to no client, so nothing is billed for them.
            They are listed rather than matched automatically: a statement names a post more fully than the
            roster does, so an automatic guess could bill the wrong detachment.
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {unmapped.map((s) => (
              <button
                key={s}
                className="btn btn-sm btn-secondary"
                disabled={!isAdmin || !clients.length}
                onClick={() => setEditSite({ site: s, detachmentName: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {editClient && (
        <ClientModal client={editClient} onClose={() => setEditClient(null)}
          onSaved={async () => { setEditClient(null); await load(); }} onError={onError} />
      )}
      {editSite && (
        <SiteModal site={editSite} clients={clients.filter((c) => c.active)} onClose={() => setEditSite(null)}
          onSaved={async () => { setEditSite(null); await load(); }} onError={onError} />
      )}
    </>
  );
}

function ClientModal({ client, onClose, onSaved, onError }) {
  const isNew = !client.id;
  const [name, setName] = useState(client.name || "");
  const [address, setAddress] = useState(client.address || "");
  const [contractRate, setRate] = useState(client.contractRate ?? "");
  // "" means no override — the agency-wide figure from Billing Rules applies,
  // exactly as it did before these fields existed. They start blank on a new
  // client for that reason, and a saved "" is stored as NULL, not as 0.
  const [adminFeePercent, setAdminFee] = useState(client.adminFeePercent ?? "");
  const [withholdingTaxPercent, setWht] = useState(client.withholdingTaxPercent ?? "");
  // "" inherits the agency-wide pair, exactly like the two percentages above.
  const [billingCadence, setCadence] = useState(client.billingCadence ?? "");
  const [active, setActive] = useState(client.active !== false);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { onError("A client name is required."); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: name.trim(), address, contractRate: contractRate === "" ? null : contractRate,
        adminFeePercent: adminFeePercent === "" ? null : adminFeePercent,
        withholdingTaxPercent: withholdingTaxPercent === "" ? null : withholdingTaxPercent,
        billingCadence: billingCadence === "" ? null : billingCadence,
        active,
      });
      if (isNew) await api("/billing/clients", { method: "POST", body });
      else await api(`/billing/clients/${client.id}`, { method: "PATCH", body });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>{isNew ? "New client" : "Edit client"}</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div className="form-field"><label>Client name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brookside Group of Companies" /></div>
          <div className="form-field"><label>Business address</label><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Km. 102 Mc. Arthur Hi-way, Brgy. Anupul, Bamban, Tarlac" /></div>
          <div className="form-field">
            <label>Default contract rate (monthly, per guard)</label>
            <input type="number" step="0.01" value={contractRate} onChange={(e) => setRate(e.target.value)} placeholder="33000" />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Leave blank to use the agency-wide default from Billing Rules. A detachment can override it.
            </div>
          </div>
          <div className="form-field">
            <label>Billing cadence</label>
            <select value={billingCadence} onChange={(e) => setCadence(e.target.value)}>
              {CADENCE_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {/* The resolved operands, shown before saving. They are ONE choice
                here on purpose: set independently, a monthly client left on a
                15-day standard over-bills a fully served month by ~48% and the
                statement looks entirely ordinary. */}
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              {(() => {
                const c = CADENCE_OPTIONS.find((o) => o.value === billingCadence) || CADENCE_OPTIONS[0];
                return c.perMonth
                  ? `Baseline = contract rate ÷ ${c.perMonth} × guards, covering ${c.days} days of full daily duty.`
                  : "Uses the agency-wide figures from Billing Rules. Existing clients stay on this.";
              })()}
            </div>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, margin: "18px 0 8px" }}>Commercial terms for this client</div>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 10, maxWidth: 480 }}>
            Both optional. Leave them blank and this client is billed at the agency-wide percentages in
            Billing Rules — which is what every client does unless someone negotiated otherwise. Entered as a
            decimal, the same as Billing Rules stores them.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-field">
              <label>Administrative overhead</label>
              <input type="number" step="0.0001" min="0" max="1" value={adminFeePercent}
                onChange={(e) => setAdminFee(e.target.value)} placeholder="agency default" />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                As a decimal (0.1224 = 12.24%).
              </div>
            </div>
            <div className="form-field">
              <label>Withholding tax</label>
              <input type="number" step="0.0001" min="0" max="1" value={withholdingTaxPercent}
                onChange={(e) => setWht(e.target.value)} placeholder="agency default" />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                As a decimal (0.02 = 2%). Applied to the administrative overhead.
              </div>
            </div>
          </div>
          {!isNew && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function SiteModal({ site, clients, onClose, onSaved, onError }) {
  const isNew = !site.id;
  const [siteOptions, setSiteOptions] = useState([]);
  const [clientId, setClientId] = useState(site.clientId || clients[0]?.id || "");
  const [siteName, setSiteName] = useState(site.site || "");
  const [detachmentName, setDetachment] = useState(site.detachmentName || "");
  const [contractRate, setRate] = useState(site.contractRate ?? "");
  const [dutyHours, setDuty] = useState(site.dutyHours ?? "");
  const [contractedGuards, setGuards] = useState(site.contractedGuards ?? "");
  const [active, setActive] = useState(site.active !== false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isNew) return;
    api("/billing/sites").then((r) => setSiteOptions(r.unmapped)).catch(() => {});
  }, [isNew]);

  async function save() {
    if (!clientId || !siteName.trim()) { onError("A client and a site are required."); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({
        clientId, site: siteName.trim(), detachmentName: detachmentName.trim() || siteName.trim(),
        contractRate: contractRate === "" ? null : contractRate,
        dutyHours: dutyHours === "" ? null : dutyHours,
        contractedGuards: contractedGuards === "" ? null : contractedGuards,
        active,
      });
      if (isNew) await api("/billing/sites", { method: "POST", body });
      else await api(`/billing/sites/${site.id}`, { method: "PATCH", body });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>{isNew ? "Map a detachment" : "Edit detachment"}</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div className="form-field">
            <label>Client</label>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Site (exactly as it appears on the roster)</label>
            {isNew ? (
              <input list="billing-site-options" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="BBGC" />
            ) : (
              <input value={siteName} disabled />
            )}
            <datalist id="billing-site-options">
              {siteOptions.map((s) => <option key={s} value={s} />)}
            </datalist>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Attendance is matched on this name. A mismatch bills nothing rather than the wrong post.
            </div>
          </div>
          <div className="form-field">
            <label>Detachment name (printed on the statement)</label>
            <input value={detachmentName} onChange={(e) => setDetachment(e.target.value)} placeholder="BBGC Farms" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div className="form-field">
              <label>Contract rate</label>
              <input type="number" step="0.01" value={contractRate} onChange={(e) => setRate(e.target.value)} placeholder="inherits client" />
            </div>
            <div className="form-field">
              <label>Duty hours</label>
              <input type="number" step="0.5" value={dutyHours} onChange={(e) => setDuty(e.target.value)} placeholder="12" />
            </div>
            <div className="form-field">
              <label>Contracted guards</label>
              <input type="number" value={contractedGuards} onChange={(e) => setGuards(e.target.value)} placeholder="from roster" />
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: -4, marginBottom: 12 }}>
            Contracted guards is the headcount the contract specifies — not how many different guards the roster
            shows, since two guards alternating one post is still one billed post. Leave blank to count the roster.
          </div>
          {!isNew && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Billing rules ----------------------------------------------------------

const RULE_FIELDS = [
  { key: "defaultContractRate", label: "Default contract rate", suffix: "₱ / month / guard", step: "0.01",
    hint: "Used when neither the detachment nor the client sets one." },
  { key: "periodsPerMonth", label: "Billing periods per month", suffix: "", step: "1",
    hint: "The period rate is the contract rate divided by this, times the guard count. 2 = semi-monthly." },
  { key: "standardPeriodDays", label: "Standard days per period", suffix: "days", step: "1",
    hint: "How many days of full daily duty the flat period rate covers. The rate does not move with the calendar, so a longer period (Aug 16–31 is 16 days) bills the extra days as an augmentation and a shorter one (Feb 16–28 is 13) credits the missing days back." },
  { key: "manHourDivisor", label: "Man-hour divisor", suffix: "days", step: "1",
    hint: "The man-hour rate is the monthly contract rate divided by this. The agency's template uses 365 — confirm it against the client contract." },
  { key: "adminFeePercent", label: "Administrative overhead", suffix: "as a decimal (0.1224 = 12.24%)", step: "0.0001",
    hint: "The agency's share of the billing cost. The rest is the amount due to guards and government." },
  { key: "withholdingTaxPercent", label: "Withholding tax", suffix: "as a decimal (0.02 = 2%)", step: "0.0001",
    hint: "Withheld by the client from the administrative overhead and deducted from the amount payable." },
  { key: "defaultDutyHours", label: "Default duty hours per shift", suffix: "hours", step: "0.5",
    hint: "The fallback for a detachment that sets no duty hours of its own. It is the DETACHMENT's value that converts billable hours into the 'N Days, N Hours' wording on the statement and sets the shift length a straight duty is measured against — this only supplies one where none was entered." },
];

function BillingRulesTab({ isAdmin, onError, revision }) {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try { const c = await api("/billing/config"); setCfg(c); setDraft(c); }
    catch (e) { onError(e.message); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  async function save() {
    setBusy(true);
    try {
      await api("/billing/config", { method: "PUT", body: JSON.stringify(draft) });
      await load();
      setSaved("Billing rules saved. Recompute any draft period to apply them.");
      setTimeout(() => setSaved(""), 5000);
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  if (!cfg || !draft) return <div className="section-card" style={{ padding: 24 }}>Loading billing rules…</div>;

  // The worked example makes an abstract percentage concrete, so a mistyped
  // rate is obvious before it reaches a client.
  const rate = Number(draft.defaultContractRate) || 0;
  const perMonth = Number(draft.periodsPerMonth) || 2;
  const divisor = Number(draft.manHourDivisor) || 365;
  const cost = (rate / perMonth) * 3;
  const admin = cost * (Number(draft.adminFeePercent) || 0);
  const wht = admin * (Number(draft.withholdingTaxPercent) || 0);

  return (
    <>
      {saved && <div className="purpose-bar" style={{ background: "var(--teal-bg)", borderColor: "#bfe6d8", color: "var(--teal)" }}>{saved}</div>}

      <div className="section-card" style={{ padding: 24 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Billing rules</div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 20, maxWidth: 720 }}>
          These are commercial terms, not statutory ones — they change when a contract is renegotiated.
          Nothing here is hardcoded in the computation. <strong>Verify every figure against the signed client
          contract before issuing a statement.</strong>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {RULE_FIELDS.map((f) => (
            <div className="form-field" key={f.key}>
              <label>{f.label}</label>
              <input
                type="number" step={f.step} disabled={!isAdmin}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                {f.suffix && <span style={{ display: "block" }}>{f.suffix}</span>}
                {f.hint}
              </div>
            </div>
          ))}
          <div className="form-field">
            <label>Statement number prefix</label>
            <input type="text" disabled={!isAdmin} value={draft.soaPrefix ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, soaPrefix: e.target.value }))} />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Numbers run as PREFIX-YEAR-NNN, e.g. SOA-2026-001.
            </div>
          </div>
        </div>

        <div style={{ marginTop: 22, padding: 16, background: "var(--bg-soft, #F3F6FA)", borderRadius: 8, fontSize: 12.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Worked example — 3 guards, no adjustments</div>
          <div style={{ color: "var(--text-mute)", lineHeight: 1.9 }}>
            Man-hour rate: {peso(rate / divisor)} &nbsp;·&nbsp; Period rate: {peso(cost)}<br />
            Administrative overhead: {peso(admin)} &nbsp;·&nbsp; Amount to guards and government: {peso(cost - admin)}<br />
            Withholding tax: {peso(wht)} &nbsp;·&nbsp; <strong>Client pays: {peso(cost - wht)}</strong>
          </div>
        </div>

        {isAdmin && (
          <button className="btn btn-gold" onClick={save} disabled={busy} style={{ marginTop: 18 }}>
            {busy ? "Saving…" : "Save billing rules"}
          </button>
        )}
      </div>
    </>
  );
}
