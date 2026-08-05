import { useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import {
  shortDate, periodPhrase, phToday, ddoStateBadgeClass,
  DESIGNATIONS, SHIFT_SUGGESTIONS, RANKS,
} from "./ddoShared";

// The Duty Detail Order tab. Unlike every other tab in this module it is not a
// view over the generic ops_records table — a DDO is the document required by
// RA 10591 and Rule 39 s.154-156 of RA 11917 authorising a named guard to bear
// a named firearm at a named post, so it has its own shape and its own PDF.
export default function DutyDetailOrders({ sites = [] }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showFormText, setShowFormText] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrders(await api(`/ddo/orders${siteFilter ? `?site=${encodeURIComponent(siteFilter)}` : ""}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [siteFilter]);
  useEffect(() => { load(); }, [load]);

  async function remove(o) {
    if (!window.confirm(`Delete this draft order for ${o.site}?`)) return;
    try { await api(`/ddo/orders/${o.id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && (
        <div className="purpose-bar" style={{ margin: "0 0 12px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 12, maxWidth: 860 }}>
        The order authorising each guard to bear a specified firearm at a specified post, under RA 10591 and
        Rule 39 §154-156 of RA 11917. Guards come from the 201 File and firearms from the Asset register, so an
        order cannot name someone who has left or a firearm the agency does not hold. Valid thirty days.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All posts</option>
          {sites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${orders.length} order${orders.length === 1 ? "" : "s"}`}
        </div>
        <div style={{ flex: 1 }} />
        {isAdmin && <button className="btn btn-sm btn-secondary" onClick={() => setShowFormText(true)}>Form text</button>}
        {canEdit && <button className="btn btn-sm btn-gold" onClick={() => setShowNew(true)}>+ New duty detail order</button>}
      </div>

      <table>
        <thead>
          <tr>
            <th>DDO No.</th><th>Post</th><th>Order date</th><th>Inclusive dates</th>
            <th>Personnel</th><th>Armed</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr className="empty-row"><td colSpan={8}>Loading duty detail orders…</td></tr>}
          {!loading && !orders.length && <tr className="empty-row"><td colSpan={8}>No duty detail orders yet.</td></tr>}
          {!loading && orders.map((o) => (
            <tr key={o.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(o.id)}>
              <td><strong>{o.ddoNo || <span style={{ color: "var(--text-mute)" }}>draft</span>}</strong></td>
              <td>{o.site}</td>
              <td>{shortDate(o.orderDate)}</td>
              <td>{periodPhrase(o.fromDate, o.toDate)}</td>
              <td>{o.lineCount}</td>
              <td>{o.armedCount}</td>
              <td>
                <span className={`badge ${ddoStateBadgeClass(o.state)}`}>{o.state}</span>
                {o.state === "Issued" && o.daysRemaining !== null && o.daysRemaining <= 7 && (
                  <div style={{ fontSize: 11, color: "var(--red)" }}>lapses in {o.daysRemaining} day{o.daysRemaining === 1 ? "" : "s"}</div>
                )}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                {isAdmin && o.status === "Draft" && (
                  <button className="btn btn-sm btn-danger" onClick={() => remove(o)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showNew && (
        <NewOrderModal sites={sites} onClose={() => setShowNew(false)}
          onSaved={async (id) => { setShowNew(false); await load(); setOpenId(id); }} onError={setError} />
      )}
      {openId && (
        <OrderDetail orderId={openId} sites={sites} onClose={() => setOpenId(null)}
          onChanged={load} />
      )}
      {showFormText && <FormTextModal onClose={() => setShowFormText(false)} onError={setError} />}
    </>
  );
}

// ---- New order --------------------------------------------------------------

function NewOrderModal({ sites, onClose, onSaved, onError }) {
  const [site, setSite] = useState(sites[0] || "");
  const [orderDate, setOrderDate] = useState(phToday());
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!site) { onError("A post is required."); return; }
    setBusy(true);
    try {
      const r = await api("/ddo/orders", { method: "POST", body: JSON.stringify({ site, orderDate }) });
      onSaved(r.id);
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>New duty detail order</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div className="form-field">
            <label>Post</label>
            <select value={site} onChange={(e) => setSite(e.target.value)}>
              {!sites.length && <option value="">No sites configured</option>}
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              From Manage Lists → Sites / Facilities. Each post keeps its own number series.
            </div>
          </div>
          <div className="form-field">
            <label>Order date</label>
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              The inclusive dates default to thirty days from here, as the form's own instruction (d) requires.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Creating…" : "Create draft"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Order detail -----------------------------------------------------------

function OrderDetail({ orderId, sites, onClose, onChanged }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [firearms, setFirearms] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editLine, setEditLine] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api(`/ddo/orders/${orderId}`)); }
    catch (e) { setError(e.message); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    Promise.all([api("/employees"), api("/ddo/firearms")])
      .then(([e, f]) => { setEmployees(e.filter((x) => x.employmentStatus === "Active")); setFirearms(f); })
      .catch(() => {});
  }, []);

  async function refresh() { await load(); onChanged?.(); }

  async function act(path, method = "PATCH", confirmText, body) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError("");
    try { await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function download() {
    setError("");
    try {
      downloadBlobUrl(await apiBlobUrl(`/ddo/orders/${orderId}/ddo.pdf`),
        `DDO-${data.order.ddoNo || "DRAFT"}-${data.order.site}.pdf`);
    } catch (e) { setError(e.message); }
  }

  async function fromRoster() {
    setBusy(true); setError("");
    try {
      const r = await api(`/ddo/orders/${orderId}/lines/from-roster`, { method: "POST" });
      await refresh();
      if (!r.added) setError(`No new personnel found on the roster for this post and period${r.skipped ? ` (${r.skipped} already listed or not active)` : ""}.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function removeLine(l) {
    if (!window.confirm(`Remove ${l.guardName} from this order?`)) return;
    try { await api(`/ddo/lines/${l.id}`, { method: "DELETE" }); await refresh(); }
    catch (e) { setError(e.message); }
  }

  if (!data) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading duty detail order…"}</div>
        </div>
      </div>
    );
  }

  const { order, lines, conflicts = [], blockers = [] } = data;
  const isDraft = order.status === "Draft";

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1180 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            Duty Detail Order {order.ddoNo || "(draft)"} — {order.site}
            <span className={`badge ${ddoStateBadgeClass(order.state)}`} style={{ marginLeft: 8 }}>{order.state}</span>
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
            <div className="kpi-card"><div className="kpi-label">Personnel</div><div className="kpi-value">{lines.length}</div></div>
            <div className="kpi-card"><div className="kpi-label">Armed</div><div className="kpi-value">{lines.filter((l) => l.firearmSerial).length}</div></div>
            <div className="kpi-card"><div className="kpi-label">Inclusive dates</div><div className="kpi-value" style={{ fontSize: 15 }}>{periodPhrase(order.fromDate, order.toDate)}</div></div>
            <div className={`kpi-card ${order.state === "Expired" ? "danger" : ""}`}>
              <div className="kpi-label">Validity</div>
              <div className="kpi-value" style={{ fontSize: 15 }}>
                {order.state === "Issued" ? `${order.daysRemaining} day${order.daysRemaining === 1 ? "" : "s"} left`
                  : order.state === "Expired" ? "Lapsed" : "—"}
              </div>
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 12px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>
              <strong>Cannot be issued as it stands:</strong>
              <ul style={{ margin: "6px 0 0 18px" }}>{conflicts.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
            </div>
          )}
          {isDraft && blockers.length > 0 && (
            <div className="purpose-bar" style={{ margin: "0 0 12px", background: "var(--gold-bg, #FBF3DA)", borderColor: "#e6d7a8" }}>
              <ul style={{ margin: "0 0 0 18px" }}>{blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {canEdit && isDraft && <button className="btn btn-gold" onClick={() => setEditLine({})}>+ Add personnel</button>}
            {canEdit && isDraft && <button className="btn btn-secondary" onClick={fromRoster} disabled={busy}>Add guards from roster</button>}
            {isAdmin && isDraft && (
              <button className="btn btn-primary" disabled={busy || !!conflicts.length || !!blockers.length}
                onClick={() => act(`/ddo/orders/${orderId}/issue`, "PATCH",
                  "Issue this duty detail order? It is assigned its number and its wording is frozen.")}>
                Issue order
              </button>
            )}
            {isAdmin && order.status === "Issued" && (
              <>
                <button className="btn btn-gold" disabled={busy}
                  onClick={() => act(`/ddo/orders/${orderId}/amend`, "PATCH",
                    `Amend order ${order.ddoNo}? It returns to draft so you can correct it, keeping its number, and is reissued under that same number.`)}>
                  Amend order
                </button>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => act(`/ddo/orders/${orderId}/cancel`, "PATCH",
                    "Cancel this order? The record of what was authorised is kept.")}>
                  Cancel order
                </button>
              </>
            )}
            <button className="btn btn-secondary" onClick={download}>Download DDO</button>
          </div>

          <div className="section-card sticky-card">
            <div className="section-head">Security personnel detailed</div>
            <table className="sticky-head">
              <thead>
                <tr>
                  <th>Name of guard</th><th>Designation</th><th>Place of duty</th><th>Time of shift</th>
                  <th>Make calibre</th><th>FAs serial no.</th><th>Licence valid to</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!lines.length && <tr className="empty-row"><td colSpan={8}>No personnel listed yet.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.rank} {l.guardName}</strong>
                      {l.employmentStatus && l.employmentStatus !== "Active" && (
                        <div style={{ fontSize: 11, color: "var(--red)" }}>{l.employmentStatus}</div>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>{l.designation}</td>
                    <td style={{ fontSize: 12 }}>{l.placeOfDuty || <span style={{ color: "var(--red)" }}>not set</span>}</td>
                    <td style={{ fontSize: 12 }}>{l.shift || "—"}</td>
                    <td style={{ fontSize: 12 }}>{l.firearmCaliber || "—"}</td>
                    <td style={{ fontSize: 12 }}>{l.firearmSerial || "—"}</td>
                    <td style={{ fontSize: 12 }}>{l.firearmLicenceExpiry ? shortDate(l.firearmLicenceExpiry) : "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {canEdit && isDraft && (
                        <>
                          <button className="btn btn-sm btn-secondary" onClick={() => setEditLine(l)}>Edit</button>
                          <button className="btn btn-sm btn-danger" style={{ marginLeft: 6 }} onClick={() => removeLine(l)}>Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isDraft && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-mute)" }}>
              Issued {order.issuedAt} by {order.issuedBy}. The wording is frozen as it stood at that moment —
              editing the form text later cannot change an order already in a guard's possession.
              {order.status === "Issued" && " To correct a detail, use Amend order: it returns to draft, keeps its number, and is reissued under that same number."}
            </div>
          )}
        </div>
      </div>

      {editLine && (
        <LineModal
          line={editLine} orderId={orderId} sites={sites}
          employees={employees} firearms={firearms} defaultPlace={order.site}
          onClose={() => setEditLine(null)}
          onSaved={async () => { setEditLine(null); await refresh(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---- One line of the duty table ---------------------------------------------

function LineModal({ line, orderId, employees, firearms, defaultPlace, onClose, onSaved, onError }) {
  const isNew = !line?.id;
  const [f, setF] = useState({
    employeeId: line?.employeeId || "",
    guardName: line?.guardName || "",
    rank: line?.rank || "SG",
    designation: line?.designation || "SECURITY GUARD",
    placeOfDuty: line?.placeOfDuty || defaultPlace || "",
    shift: line?.shift || "",
    assetId: line?.assetId || "",
    firearmCaliber: line?.firearmCaliber || "",
    firearmSerial: line?.firearmSerial || "",
    firearmLicenceExpiry: line?.firearmLicenceExpiry || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const chosenFirearm = firearms.find((x) => String(x.id) === String(f.assetId));

  // Choosing a different firearm refills the three particulars from the
  // register, so a swap can never leave the previous weapon's serial behind.
  // Make calibre is the register's brand and model joined.
  function pickFirearm(assetId) {
    const a = firearms.find((x) => String(x.id) === String(assetId));
    setF((s) => ({
      ...s,
      assetId,
      firearmCaliber: a ? ([a.brand, a.model].filter(Boolean).join(" ") || a.caliber || "") : "",
      firearmSerial: a ? (a.serialNumber || "") : "",
      firearmLicenceExpiry: a ? (a.licenceExpiry || "") : "",
    }));
  }

  async function save() {
    if (!f.employeeId && !f.guardName.trim()) { onError("Select the guard being detailed."); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({
        ...f,
        employeeId: f.employeeId || null,
        assetId: f.assetId || null,
      });
      if (isNew) await api(`/ddo/orders/${orderId}/lines`, { method: "POST", body });
      else await api(`/ddo/lines/${line.id}`, { method: "PATCH", body });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isNew ? "Add personnel to the order" : `Edit ${line.guardName}`}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label>Guard *</label>
            <select value={f.employeeId} onChange={(e) => set("employeeId", e.target.value)}>
              <option value="">Select from the 201 File…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}{e.employeeNo ? ` (${e.employeeNo})` : ""}{e.site ? ` — ${e.site}` : ""}</option>
              ))}
            </select>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Only active employees are offered — a DDO must not detail someone who has left.
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 12 }}>
            <div className="form-field">
              <label>Rank</label>
              <input list="ddo-ranks" value={f.rank} onChange={(e) => set("rank", e.target.value.toUpperCase())} />
              <datalist id="ddo-ranks">{RANKS.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
            <div className="form-field">
              <label>Designation on this detail</label>
              <input list="ddo-designations" value={f.designation}
                onChange={(e) => set("designation", e.target.value.toUpperCase())} />
              <datalist id="ddo-designations">{DESIGNATIONS.map((d) => <option key={d} value={d} />)}</datalist>
            </div>
          </div>
          <div className="form-field">
            <label>Place of duty</label>
            <input value={f.placeOfDuty} onChange={(e) => set("placeOfDuty", e.target.value)}
              placeholder="BBGC GATE SO. PASCUALA, CAPAS, TARLAC" />
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              The full postal description printed on the order, not just the site code.
            </div>
          </div>
          <div className="form-field">
            <label>Time of shift</label>
            <input list="ddo-shifts" value={f.shift} onChange={(e) => set("shift", e.target.value.toUpperCase())}
              placeholder="0600H-1800H" />
            <datalist id="ddo-shifts">{SHIFT_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div className="form-field">
            <label>Firearm issued</label>
            <select value={f.assetId} onChange={(e) => pickFirearm(e.target.value)}>
              <option value="">Unarmed — no firearm on this line</option>
              {firearms.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.assetTag} · {[x.brand, x.model].filter(Boolean).join(" ") || x.caliber || x.name}
                  {x.serialNumber ? ` · ${x.serialNumber}` : ""}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              Picking one fills the three particulars below from the Asset register. They stay editable —
              the register is not always complete, and the order still has to print the correct details.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field">
              <label>Make calibre</label>
              <input value={f.firearmCaliber} onChange={(e) => set("firearmCaliber", e.target.value)}
                placeholder="Rock Island Armory STK100" />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                The asset's brand and model, joined.
              </div>
            </div>
            <div className="form-field">
              <label>FAs serial no.</label>
              <input value={f.firearmSerial} onChange={(e) => set("firearmSerial", e.target.value)} />
            </div>
            <div className="form-field">
              <label>Licence valid to</label>
              <input type="date" value={f.firearmLicenceExpiry}
                onChange={(e) => set("firearmLicenceExpiry", e.target.value)} />
              {chosenFirearm && !chosenFirearm.licenceExpiry && (
                <div style={{ fontSize: 11.5, color: "var(--gold-dark, #7A5C00)", marginTop: 4 }}>
                  Not recorded on {chosenFirearm.assetTag} — set it here for this order, and on the asset so it
                  carries forward.
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save line"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- The admin-editable boilerplate -----------------------------------------

function FormTextModal({ onClose, onError }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api("/ddo/config")
      .then((c) => setCfg({
        ...c,
        references: c.referencesJson || [],
        instructions: c.instructionsJson || [],
      }))
      .catch((e) => onError(e.message));
  }, [onError]);

  function setList(key, idx, value) {
    setCfg((c) => ({ ...c, [key]: c[key].map((x, i) => (i === idx ? { ...x, text: value } : x)) }));
  }

  async function save() {
    setBusy(true);
    try {
      await api("/ddo/config", { method: "PUT", body: JSON.stringify(cfg) });
      setSaved("Saved. Orders already issued keep the wording they were issued under.");
      setTimeout(() => setSaved(""), 5000);
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  if (!cfg) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">Loading form text…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Duty Detail Order — form text</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {saved && <div className="purpose-bar" style={{ margin: "0 0 12px", background: "var(--teal-bg)", borderColor: "#bfe6d8", color: "var(--teal)" }}>{saved}</div>}
          <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 16 }}>
            The references and instructions printed on every new order. <strong>Verify against the current
            DOLE and PNP issuances before relying on them.</strong> Editing here never alters an order that has
            already been issued — each one keeps a copy of the wording it went out with.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <div className="form-field">
              <label>Form version</label>
              <input value={cfg.formVersion || ""} onChange={(e) => setCfg({ ...cfg, formVersion: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Validity (days)</label>
              <input type="number" min="1" value={cfg.validityDays || 30}
                onChange={(e) => setCfg({ ...cfg, validityDays: e.target.value })} />
            </div>
          </div>
          <div className="form-field">
            <label>Default purpose of detail</label>
            <input value={cfg.defaultPurpose || ""} onChange={(e) => setCfg({ ...cfg, defaultPurpose: e.target.value })} />
          </div>

          <div className="section-head" style={{ margin: "18px 0 12px" }}>1 — References</div>
          {cfg.references.map((r, i) => (
            <div className="form-field" key={i}>
              <label>{r.letter}</label>
              <textarea rows={2} value={r.text} onChange={(e) => setList("references", i, e.target.value)} />
            </div>
          ))}

          <div className="form-field" style={{ marginTop: 12 }}>
            <label>4 — Assignment statement</label>
            <textarea rows={2} value={cfg.assignmentStatement || ""}
              onChange={(e) => setCfg({ ...cfg, assignmentStatement: e.target.value })} />
          </div>

          <div className="section-head" style={{ margin: "18px 0 12px" }}>5 — Specific instructions</div>
          {cfg.instructions.map((r, i) => (
            <div className="form-field" key={i}>
              <label>{r.letter}</label>
              <textarea rows={3} value={r.text} onChange={(e) => setList("instructions", i, e.target.value)} />
            </div>
          ))}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, marginTop: 12 }}>
            <div className="form-field">
              <label>6 — Closing line</label>
              <input value={cfg.closingLine || ""} onChange={(e) => setCfg({ ...cfg, closingLine: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Authority line</label>
              <input value={cfg.authorityLine || ""} onChange={(e) => setCfg({ ...cfg, authorityLine: e.target.value })} />
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
            The signatory beneath the authority line comes from System Settings → Admin / Operation head.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save form text"}</button>
        </div>
      </div>
    </div>
  );
}
