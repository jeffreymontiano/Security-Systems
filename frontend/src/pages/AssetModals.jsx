import { useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { CONDITIONS, TRACKING_MODES, ASSET_STATUSES, classificationPath, shortDate, phToday } from "./assetsShared";

// The three modals shared by the register page and the asset detail view.
// They live in their own file so neither of those has to import the other —
// a cycle that works today only because function declarations hoist.

// ---- New / edit asset -------------------------------------------------------

export function AssetFormModal({ asset, tree, onClose, onSaved, onError }) {
  const isNew = !asset?.id;
  const [f, setF] = useState(() => ({
    assetTag: asset?.assetTag || "", name: asset?.name || "", description: asset?.description || "",
    typeId: asset?.typeId || "", categoryId: asset?.categoryId || "", subcategoryId: asset?.subcategoryId || "",
    trackingMode: asset?.trackingMode || "Serialized",
    serialNumber: asset?.serialNumber || "", brand: asset?.brand || "", model: asset?.model || "",
    size: asset?.size || "", quantity: asset?.quantity ?? 1, reorderLevel: asset?.reorderLevel ?? 0,
    condition: asset?.condition || "Good", status: asset?.status || "Available", site: asset?.site || "",
    acquisitionDate: asset?.acquisitionDate?.slice(0, 10) || "", acquisitionCost: asset?.acquisitionCost ?? "",
    warrantyExpiry: asset?.warrantyExpiry?.slice(0, 10) || "", replacementDueDate: asset?.replacementDueDate?.slice(0, 10) || "",
    statusNote: asset?.statusNote || "", notes: asset?.notes || "",
  }));
  const [busy, setBusy] = useState(false);
  const [sites, setSites] = useState([]);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  // Sites come from the shared Sites / Facilities list in Manage Lists — the
  // same list attendance, scheduling and deployment already use — so a post
  // is named identically everywhere rather than retyped per asset.
  useEffect(() => {
    api("/meta/sites")
      .then((s) => setSites(Array.isArray(s) ? s : []))
      .catch(() => setSites([]));
  }, []);

  // An asset saved before a site was renamed or removed from that list still
  // carries the old value. Offer it as a choice rather than silently blanking
  // the field on the next save.
  const siteOptions = f.site && !sites.includes(f.site) ? [...sites, f.site] : sites;

  const categories = tree.categories.filter((c) => String(c.typeId) === String(f.typeId) && c.active);
  const subcategories = tree.subcategories.filter((s) => String(s.categoryId) === String(f.categoryId) && s.active);

  // Suggest a tag once the classification is chosen, from the type and
  // sub-category initials — SEC-SEA-0001 for Security > Search Light.
  async function suggestTag() {
    const typeName = tree.types.find((t) => String(t.id) === String(f.typeId))?.name || "";
    const subName = tree.subcategories.find((s) => String(s.id) === String(f.subcategoryId))?.name
      || tree.categories.find((c) => String(c.id) === String(f.categoryId))?.name || "";
    const prefix = [typeName.replace(/[^A-Za-z]/g, "").slice(0, 3), subName.replace(/[^A-Za-z]/g, "").slice(0, 3)]
      .filter(Boolean).join("-").toUpperCase() || "AST";
    try {
      const r = await api(`/assets/next-tag?prefix=${encodeURIComponent(prefix)}`);
      set("assetTag", r.assetTag);
    } catch (e) { onError(e.message); }
  }

  async function save() {
    if (!f.assetTag.trim()) { onError("An asset tag is required."); return; }
    if (!f.name.trim()) { onError("An asset name is required."); return; }
    if (!f.typeId) { onError("An asset type is required."); return; }
    if (!f.categoryId) { onError("An asset category is required."); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({ ...f, subcategoryId: f.subcategoryId || null });
      if (isNew) await api("/assets", { method: "POST", body });
      else await api(`/assets/${asset.id}`, { method: "PATCH", body });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isNew ? "New asset" : `Edit ${asset.assetTag}`}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="section-head" style={{ margin: "0 0 14px" }}>Classification</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field">
              <label>Asset type *</label>
              <select value={f.typeId} onChange={(e) => setF((s) => ({ ...s, typeId: e.target.value, categoryId: "", subcategoryId: "" }))}>
                <option value="">Select…</option>
                {tree.types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Category *</label>
              <select value={f.categoryId} disabled={!f.typeId}
                onChange={(e) => setF((s) => ({ ...s, categoryId: e.target.value, subcategoryId: "" }))}>
                <option value="">{f.typeId ? "Select…" : "Pick a type first"}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Sub-category</label>
              <select value={f.subcategoryId} disabled={!f.categoryId} onChange={(e) => set("subcategoryId", e.target.value)}>
                <option value="">{f.categoryId ? "Select…" : "Pick a category first"}</option>
                {subcategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          <div className="section-head" style={{ margin: "18px 0 14px" }}>Item</div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 12 }}>
            <div className="form-field">
              <label>Asset tag *</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={f.assetTag} onChange={(e) => set("assetTag", e.target.value)} placeholder="SEC-RAD-0001" />
                {isNew && <button className="btn btn-sm btn-secondary" type="button" onClick={suggestTag}>Auto</button>}
              </div>
            </div>
            <div className="form-field">
              <label>Item name *</label>
              <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Handheld Radio" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field"><label>Brand</label><input value={f.brand} onChange={(e) => set("brand", e.target.value)} /></div>
            <div className="form-field"><label>Model</label><input value={f.model} onChange={(e) => set("model", e.target.value)} /></div>
            <div className="form-field"><label>Serial number</label><input value={f.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} /></div>
            <div className="form-field"><label>Size</label><input value={f.size} onChange={(e) => set("size", e.target.value)} placeholder="e.g. Large" /></div>
          </div>

          <div className="form-field">
            <label>Tracking</label>
            <select value={f.trackingMode} onChange={(e) => set("trackingMode", e.target.value)}>
              {TRACKING_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
              <strong>Serialized</strong> — one physical unit with its own serial, issued to one person at a time
              (a radio, a body camera, a laptop). <strong>Bulk</strong> — a pooled stock issued in quantities
              (uniform shirts in one size, flashlights).
            </div>
          </div>

          {f.trackingMode === "Bulk" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <div className="form-field">
                <label>Quantity owned</label>
                <input type="number" min="0" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Reorder level</label>
                <input type="number" min="0" value={f.reorderLevel} onChange={(e) => set("reorderLevel", e.target.value)} />
                <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                  Raises a low-stock alert when available stock falls to this. 0 disables it.
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field">
              <label>Condition</label>
              <select value={f.condition} onChange={(e) => set("condition", e.target.value)}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Status</label>
              <select value={f.status} onChange={(e) => set("status", e.target.value)}>
                {ASSET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Issued is set by the ledger, not by hand.
              </div>
            </div>
            <div className="form-field">
              <label>Site / location</label>
              <select value={f.site} onChange={(e) => set("site", e.target.value)}>
                <option value="">Unassigned</option>
                {siteOptions.map((s) => (
                  <option key={s} value={s}>{s}{sites.includes(s) ? "" : " (no longer listed)"}</option>
                ))}
              </select>
              {!sites.length && (
                <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                  No sites yet — add them under Manage Lists → Sites / Facilities.
                </div>
              )}
            </div>
          </div>

          <div className="section-head" style={{ margin: "18px 0 14px" }}>Acquisition &amp; replacement</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field"><label>Acquired</label><input type="date" value={f.acquisitionDate} onChange={(e) => set("acquisitionDate", e.target.value)} /></div>
            <div className="form-field"><label>Cost (per unit)</label><input type="number" step="0.01" value={f.acquisitionCost} onChange={(e) => set("acquisitionCost", e.target.value)} /></div>
            <div className="form-field"><label>Warranty expiry</label><input type="date" value={f.warrantyExpiry} onChange={(e) => set("warrantyExpiry", e.target.value)} /></div>
            <div className="form-field"><label>Replacement due</label><input type="date" value={f.replacementDueDate} onChange={(e) => set("replacementDueDate", e.target.value)} /></div>
          </div>
          <div className="form-field"><label>Notes</label><textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save asset"}</button>
        </div>
      </div>
    </div>
  );
}

export function IssueModal({ presetAssetId, onClose, onSaved, onError }) {
  const [assets, setAssets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [f, setF] = useState({
    assetId: presetAssetId || "", employeeId: "", quantity: 1,
    issuedDate: phToday(), expectedReturnDate: "", purpose: "", conditionOnIssue: "Good",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    Promise.all([api("/assets"), api("/employees")])
      .then(([a, e]) => {
        setAssets(a);
        setEmployees(e.filter((x) => x.employmentStatus === "Active"));
      })
      .catch((err) => onError(err.message));
  }, [onError]);

  const chosen = assets.find((a) => String(a.id) === String(f.assetId));
  // Only offer what can actually be handed over — an item under repair or
  // already out is not a choice, and finding that out after filling the form
  // would be worse.
  const issuable = assets.filter((a) => a.available > 0 || String(a.id) === String(f.assetId));

  // The accountability form is only meaningful for an issuance that exists —
  // it carries a form number and has to reconcile with the ledger later — so
  // downloading it records the hand-over first, then fetches the PDF.
  async function save(withForm) {
    if (!f.assetId) { onError("Select an asset to issue."); return; }
    if (!f.employeeId) { onError("Select the employee receiving it."); return; }
    setBusy(true);
    try {
      const r = await api("/assets/issuances", { method: "POST", body: JSON.stringify(f) });
      if (withForm) {
        const asset = assets.find((a) => String(a.id) === String(f.assetId));
        const employee = employees.find((e) => String(e.id) === String(f.employeeId));
        // A failed download must not read as a failed issue — the hand-over is
        // already recorded and the form is available from the ledger.
        try {
          downloadBlobUrl(
            await apiBlobUrl(`/assets/issuances/${r.id}/receipt.pdf`),
            `Accountability-Form-${asset?.assetTag || r.id}-${employee?.fullName || ""}.pdf`
          );
        } catch (e) {
          onError(`Issued, but the accountability form could not be downloaded (${e.message}). It is available from the ledger.`);
        }
      }
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Issue equipment</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div className="form-field">
            <label>Asset *</label>
            <select value={f.assetId} onChange={(e) => set("assetId", e.target.value)}>
              <option value="">Select an available asset…</option>
              {issuable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.assetTag} — {a.name}{a.serialNumber ? ` (${a.serialNumber})` : ""} · {a.available} available
                </option>
              ))}
            </select>
            {chosen && <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{classificationPath(chosen)}</div>}
            {!issuable.length && <div style={{ fontSize: 11.5, color: "var(--red)", marginTop: 4 }}>Nothing is currently available to issue.</div>}
          </div>
          <div className="form-field">
            <label>Issue to *</label>
            <select value={f.employeeId} onChange={(e) => set("employeeId", e.target.value)}>
              <option value="">Select an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}{e.employeeNo ? ` (${e.employeeNo})` : ""}{e.site ? ` — ${e.site}` : ""}</option>
              ))}
            </select>
          </div>
          {chosen?.trackingMode === "Bulk" && (
            <div className="form-field">
              <label>Quantity</label>
              <input type="number" min="1" max={chosen.available} value={f.quantity} onChange={(e) => set("quantity", e.target.value)} />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{chosen.available} available.</div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <div className="form-field"><label>Issued on</label><input type="date" value={f.issuedDate} onChange={(e) => set("issuedDate", e.target.value)} /></div>
            <div className="form-field">
              <label>Expected return</label>
              <input type="date" value={f.expectedReturnDate} onChange={(e) => set("expectedReturnDate", e.target.value)} />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>Drives the overdue alert. Leave blank for open-ended issue.</div>
            </div>
            <div className="form-field">
              <label>Condition on issue</label>
              <select value={f.conditionOnIssue} onChange={(e) => set("conditionOnIssue", e.target.value)}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="form-field"><label>Purpose / remarks</label><input value={f.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="Night shift duty at BBGC" /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={() => save(true)} disabled={busy}
            title="Records the hand-over and downloads the Equipment Accountability Form for the guard to sign">
            {busy ? "Issuing…" : "Issue & download form"}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={() => save(false)} disabled={busy}>{busy ? "Issuing…" : "Issue & record"}</button>
        </div>
      </div>
    </div>
  );
}

export function ReturnModal({ issuance, onClose, onSaved, onError }) {
  const outstanding = Number(issuance.quantity) - Number(issuance.quantityReturned);
  const [f, setF] = useState({
    outcome: "Returned", quantity: outstanding, returnedDate: phToday(),
    conditionOnReturn: "Good", returnNotes: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      await api(`/assets/issuances/${issuance.id}/return`, { method: "PATCH", body: JSON.stringify(f) });
      onSaved();
    } catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Return {issuance.assetTag}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 14 }}>
            {issuance.assetName} held by <strong>{issuance.employeeName}</strong> since {shortDate(issuance.issuedDate)}.
            {" "}{outstanding} unit{outstanding === 1 ? "" : "s"} outstanding.
          </div>
          <div className="form-field">
            <label>Outcome</label>
            <select value={f.outcome} onChange={(e) => set("outcome", e.target.value)}>
              <option value="Returned">Returned</option>
              <option value="Lost">Reported lost</option>
              <option value="Damaged">Returned damaged / written off</option>
            </select>
            {f.outcome !== "Returned" && (
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Writes off all {outstanding} outstanding unit{outstanding === 1 ? "" : "s"} and takes the asset out of circulation.
              </div>
            )}
          </div>
          {f.outcome === "Returned" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
              <div className="form-field">
                <label>Quantity returned</label>
                <input type="number" min="1" max={outstanding} value={f.quantity} onChange={(e) => set("quantity", e.target.value)} />
              </div>
              <div className="form-field"><label>Returned on</label><input type="date" value={f.returnedDate} onChange={(e) => set("returnedDate", e.target.value)} /></div>
              <div className="form-field">
                <label>Condition</label>
                <select value={f.conditionOnReturn} onChange={(e) => set("conditionOnReturn", e.target.value)}>
                  {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="form-field"><label>Remarks</label><textarea rows={2} value={f.returnNotes} onChange={(e) => set("returnNotes", e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={busy}>{busy ? "Recording…" : "Record return"}</button>
        </div>
      </div>
    </div>
  );
}
