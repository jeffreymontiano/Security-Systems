import { useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, apiUpload, downloadBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { AssetFormModal, IssueModal, ReturnModal } from "./AssetModals";
import {
  peso, assetStatusBadgeClass, issuanceStatusBadgeClass, conditionBadgeClass,
  classificationPath, shortDate,
} from "./assetsShared";

export default function AssetDetailModal({ assetId, onClose, onChanged }) {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [asset, setAsset] = useState(null);
  const [tree, setTree] = useState({ types: [], categories: [], subcategories: [] });
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [returning, setReturning] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try { setAsset(await api(`/assets/${assetId}`)); }
    catch (e) { setError(e.message); }
  }, [assetId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api("/assets/classification").then(setTree).catch(() => {}); }, []);

  async function refresh() { await load(); onChanged?.(); }

  async function receipt(i) {
    try { downloadBlobUrl(await apiBlobUrl(`/assets/issuances/${i.id}/receipt.pdf`), `ARE-${i.assetTag}-${i.employeeName}.pdf`); }
    catch (e) { setError(e.message); }
  }

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    try { await apiUpload(`/assets/${assetId}/attachments`, file); await load(); }
    catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function removeAttachment(att) {
    if (!window.confirm(`Remove "${att.filename}"?`)) return;
    try { await api(`/assets/${assetId}/attachments/${att.id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e.message); }
  }

  async function openAttachment(att) {
    try { window.open(await apiBlobUrl(`/assets/${assetId}/attachments/${att.id}`), "_blank"); }
    catch (e) { setError(e.message); }
  }

  async function retire() {
    if (!window.confirm("Delete this asset? If it has issuance history it will be retired instead, so the record of who held it survives.")) return;
    try {
      const r = await api(`/assets/${assetId}`, { method: "DELETE" });
      onChanged?.();
      if (r.deleted) onClose(); else await load();
    } catch (e) { setError(e.message); }
  }

  if (!asset) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading asset…"}</div>
        </div>
      </div>
    );
  }

  const open = (asset.issuances || []).filter((i) => ["Issued", "Partially Returned"].includes(i.status));
  const field = (label, value) => (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 13.5 }}>{value || "—"}</div>
    </div>
  );

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1000 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {asset.assetTag} — {asset.name}
            <span className={`badge ${assetStatusBadgeClass(asset.status)}`} style={{ marginLeft: 8 }}>{asset.status}</span>
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
            <div className="kpi-card"><div className="kpi-label">Tracking</div><div className="kpi-value" style={{ fontSize: 18 }}>{asset.trackingMode}</div></div>
            <div className="kpi-card"><div className="kpi-label">{asset.trackingMode === "Bulk" ? "Owned" : "Units"}</div><div className="kpi-value">{asset.trackingMode === "Bulk" ? asset.quantity : 1}</div></div>
            <div className="kpi-card"><div className="kpi-label">On issue</div><div className="kpi-value">{asset.onIssue}</div></div>
            <div className="kpi-card good"><div className="kpi-label">Available</div><div className="kpi-value">{asset.available}</div></div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {canEdit && asset.available > 0 && <button className="btn btn-gold" onClick={() => setIssuing(true)}>Issue this asset</button>}
            {canEdit && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
            {isAdmin && <button className="btn btn-danger" onClick={retire}>Delete / retire</button>}
          </div>

          <div className="section-card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="section-head" style={{ margin: "-20px -20px 16px" }}>Details</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
              {field("Classification", classificationPath(asset))}
              {field("Serial number", asset.serialNumber)}
              {field("Brand / model", [asset.brand, asset.model].filter(Boolean).join(" ") || null)}
              {field("Size", asset.size)}
              {field("Condition", <span className={`badge ${conditionBadgeClass(asset.condition)}`}>{asset.condition}</span>)}
              {field("Site / location", asset.site)}
              {field("Acquired", shortDate(asset.acquisitionDate))}
              {field("Cost", asset.acquisitionCost ? peso(asset.acquisitionCost) : null)}
              {field("Warranty expiry", shortDate(asset.warrantyExpiry))}
              {field("Replacement due", shortDate(asset.replacementDueDate))}
              {asset.trackingMode === "Bulk" && field("Reorder level", asset.reorderLevel)}
              {field("Currently held by", open.map((i) => i.employeeName).join(", ") || null)}
            </div>
            {asset.statusNote && (
              <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--text-mute)" }}>
                <strong>Status note:</strong> {asset.statusNote}
              </div>
            )}
            {asset.notes && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-mute)" }}>
                <strong>Notes:</strong> {asset.notes}
              </div>
            )}
          </div>

          <div className="section-card sticky-card">
            <div className="section-head">Issuance history ({(asset.issuances || []).length})</div>
            <table className="sticky-head">
              <thead>
                <tr><th>Issued to</th><th>Qty</th><th>Issued</th><th>Due back</th><th>Returned</th><th>Condition</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {!(asset.issuances || []).length && <tr className="empty-row"><td colSpan={8}>This asset has never been issued.</td></tr>}
                {(asset.issuances || []).map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.employeeName}</strong>
                      <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{[i.employeeNo, i.position, i.site].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>{i.quantity}</td>
                    <td style={{ fontSize: 12 }}>{shortDate(i.issuedDate)}</td>
                    <td style={{ fontSize: 12 }}>{shortDate(i.expectedReturnDate)}</td>
                    <td style={{ fontSize: 12 }}>{shortDate(i.returnedDate)}</td>
                    <td style={{ fontSize: 12 }}>{i.conditionOnReturn || i.conditionOnIssue}</td>
                    <td><span className={`badge ${issuanceStatusBadgeClass(i.status)}`}>{i.status}</span></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {canEdit && ["Issued", "Partially Returned"].includes(i.status) && (
                        <button className="btn btn-sm btn-primary" onClick={() => setReturning(i)}>Return</button>
                      )}
                      <button className="btn btn-sm btn-secondary" style={{ marginLeft: 6 }} onClick={() => receipt(i)}>Receipt</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-card" style={{ padding: 20, marginTop: 16 }}>
            <div className="section-head" style={{ margin: "-20px -20px 16px" }}>Attachments</div>
            <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 12 }}>
              Purchase receipts, warranty cards, or the signed acknowledgement receipt.
            </div>
            {!(asset.attachments || []).length && <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>Nothing attached.</div>}
            {(asset.attachments || []).map((att) => (
              <div key={att.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => openAttachment(att)}>{att.filename}</button>
                <span style={{ fontSize: 11, color: "var(--text-mute)" }}>{Math.round(att.size / 1024)} KB · {att.uploaded_by}</span>
                {canEdit && <button className="btn btn-sm btn-danger" onClick={() => removeAttachment(att)}>Remove</button>}
              </div>
            ))}
            {canEdit && (
              <label className="btn btn-secondary" style={{ cursor: "pointer", marginTop: 12, display: "inline-block" }}>
                {uploading ? "Uploading…" : "Attach a file"}
                <input type="file" style={{ display: "none" }} disabled={uploading}
                  onChange={(e) => { upload(e.target.files[0]); e.target.value = ""; }} />
              </label>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <AssetFormModal asset={asset} tree={tree} onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await refresh(); }} onError={setError} />
      )}
      {issuing && (
        <IssueModal presetAssetId={asset.id} onClose={() => setIssuing(false)}
          onSaved={async () => { setIssuing(false); await refresh(); }} onError={setError} />
      )}
      {returning && (
        <ReturnModal issuance={returning} onClose={() => setReturning(null)}
          onSaved={async () => { setReturning(null); await refresh(); }} onError={setError} />
      )}
    </div>
  );
}
