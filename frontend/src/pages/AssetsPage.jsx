import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import AssetDetailModal from "./AssetDetailModal";
import { IssueModal, ReturnModal, AssetFormModal } from "./AssetModals";
import {
  peso, ASSET_VIEWS, ASSET_STATUSES,
  assetStatusBadgeClass, issuanceStatusBadgeClass, conditionBadgeClass,
  classificationPath, shortDate, phToday,
} from "./assetsShared";

const SUBTITLE = "Track every issued asset — security and non-security — from issuance to return";

export default function AssetsPage() {
  const { isViewer, isAdmin } = useAuth();
  const canEdit = !isViewer;
  const [view, setView] = useState("register");
  const [error, setError] = useState("");
  const [openAssetId, setOpenAssetId] = useState(null);
  // Bumped whenever something changes, so sibling tabs reload rather than
  // showing a stale count.
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);

  return (
    <div className="module-view">
      <ModuleHeader title="Asset & Equipment Management" subtitle={SUBTITLE} />
      <PurposeBar>
        One register for uniforms, radios, body cameras, flashlights, keys and office equipment alike.
        What is available is derived from the issuance ledger rather than stored, so stock can never drift
        from who is actually holding what — and every hand-over prints an acknowledgement receipt.
      </PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0", flexWrap: "wrap" }}>
        {ASSET_VIEWS.map((v) => (
          <button key={v.key} className={`btn btn-sm ${view === v.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </div>

      {view === "register" && <RegisterTab canEdit={canEdit} revision={revision} onChanged={bump} onOpen={setOpenAssetId} onError={setError} />}
      {view === "issuance" && <IssuanceTab canEdit={canEdit} revision={revision} onChanged={bump} onError={setError} />}
      {view === "alerts" && <AlertsTab revision={revision} onError={setError} />}
      {view === "classification" && <ClassificationTab canEdit={canEdit} isAdmin={isAdmin} revision={revision} onChanged={bump} onError={setError} />}

      <ConfidentialFooter />

      {openAssetId && (
        <AssetDetailModal
          assetId={openAssetId}
          onClose={() => setOpenAssetId(null)}
          onChanged={bump}
        />
      )}
    </div>
  );
}

// Loads the classification tree once per revision. Every form needs all three
// levels to cascade, so fetching it in one place keeps the pickers consistent.
function useClassification(revision, onError) {
  const [tree, setTree] = useState({ types: [], categories: [], subcategories: [] });
  useEffect(() => {
    api("/assets/classification").then(setTree).catch((e) => onError?.(e.message));
  }, [revision, onError]);
  return tree;
}

// ---- Asset register ---------------------------------------------------------

function RegisterTab({ canEdit, revision, onChanged, onOpen, onError }) {
  const tree = useClassification(revision, onError);
  const [assets, setAssets] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [filters, setFilters] = useState({ typeId: "", categoryId: "", subcategoryId: "", status: "", q: "" });

  const query = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
    return p.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, s] = await Promise.all([
        api(`/assets${query ? `?${query}` : ""}`),
        api("/assets/stats"),
      ]);
      setAssets(a); setStats(s);
    } catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [query, onError]);
  useEffect(() => { load(); }, [load, revision]);

  const categories = tree.categories.filter((c) => !filters.typeId || String(c.typeId) === String(filters.typeId));
  const subcategories = tree.subcategories.filter((s) => !filters.categoryId || String(s.categoryId) === String(filters.categoryId));

  async function downloadInventory() {
    try {
      downloadBlobUrl(await apiBlobUrl(`/assets/report/inventory.pdf${query ? `?${query}` : ""}`), `asset-inventory-${phToday()}.pdf`);
    } catch (e) { onError(e.message); }
  }

  return (
    <>
      {stats && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", margin: "16px 32px 0" }}>
          <div className="kpi-card"><div className="kpi-label">Assets</div><div className="kpi-value">{stats.totals.assets}</div></div>
          <div className="kpi-card good"><div className="kpi-label">Available units</div><div className="kpi-value">{stats.totals.available}</div></div>
          <div className="kpi-card"><div className="kpi-label">On issue</div><div className="kpi-value">{stats.totals.onIssue}</div></div>
          <div className="kpi-card danger"><div className="kpi-label">Repair / lost</div><div className="kpi-value">{stats.totals.underRepair + stats.totals.lost}</div></div>
          <div className="kpi-card"><div className="kpi-label">Acquisition value</div><div className="kpi-value" style={{ fontSize: 19 }}>{peso(stats.totals.value)}</div></div>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-left" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" placeholder="Search tag, item, serial…" value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 200 }} />
          <select value={filters.typeId} onChange={(e) => setFilters((f) => ({ ...f, typeId: e.target.value, categoryId: "", subcategoryId: "" }))}>
            <option value="">All asset types</option>
            {tree.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value, subcategoryId: "" }))}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={filters.subcategoryId} onChange={(e) => setFilters((f) => ({ ...f, subcategoryId: e.target.value }))}>
            <option value="">All sub-categories</option>
            {subcategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">All statuses</option>
            {ASSET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button className="btn btn-secondary" onClick={downloadInventory}>Inventory PDF</button>
        {canEdit && <button className="btn btn-gold" onClick={() => setShowNew(true)} style={{ marginLeft: 8 }}>+ New asset</button>}
      </div>

      <div className="section-card sticky-card">
        <div className="section-head">Asset register</div>
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Asset tag</th><th>Item</th><th>Classification</th><th>Serial</th>
              <th>Qty</th><th>On issue</th><th>Available</th><th>Condition</th><th>Status</th><th>Site</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={10}>Loading the asset register…</td></tr>}
            {!loading && !assets.length && <tr className="empty-row"><td colSpan={10}>No assets match this view.</td></tr>}
            {!loading && assets.map((a) => (
              <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => onOpen(a.id)}>
                <td><strong>{a.assetTag}</strong></td>
                <td>
                  {a.name}
                  {a.brand || a.model ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{[a.brand, a.model, a.size].filter(Boolean).join(" · ")}</div> : null}
                </td>
                <td style={{ fontSize: 12 }}>{classificationPath(a)}</td>
                <td style={{ fontSize: 12 }}>{a.serialNumber || "—"}</td>
                <td>{a.trackingMode === "Bulk" ? a.quantity : 1}</td>
                <td>{a.onIssue || 0}</td>
                <td><strong style={{ color: a.available > 0 ? "var(--teal)" : "var(--text-mute)" }}>{a.available}</strong></td>
                <td><span className={`badge ${conditionBadgeClass(a.condition)}`}>{a.condition}</span></td>
                <td><span className={`badge ${assetStatusBadgeClass(a.status)}`}>{a.status}</span></td>
                <td style={{ fontSize: 12 }}>{a.site || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <AssetFormModal tree={tree} onClose={() => setShowNew(false)}
          onSaved={async () => { setShowNew(false); onChanged(); await load(); }} onError={onError} />
      )}
    </>
  );
}

// ---- Issuance & returns -----------------------------------------------------

function IssuanceTab({ canEdit, revision, onChanged, onError }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openOnly, setOpenOnly] = useState(true);
  const [q, setQ] = useState("");
  const [showIssue, setShowIssue] = useState(false);
  const [returning, setReturning] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (openOnly) p.set("open", "true");
    if (q) p.set("q", q);
    try { setRows(await api(`/assets/issuances/all${p.toString() ? `?${p}` : ""}`)); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [openOnly, q, onError]);
  useEffect(() => { load(); }, [load, revision]);

  async function receipt(i) {
    try { downloadBlobUrl(await apiBlobUrl(`/assets/issuances/${i.id}/receipt.pdf`), `Accountability-Form-${i.assetTag}-${i.employeeName}.pdf`); }
    catch (e) { onError(e.message); }
  }

  const todayStr = phToday();

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="text" placeholder="Search guard, tag, serial…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Outstanding only
          </label>
          <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>{!loading && `${rows.length} record${rows.length === 1 ? "" : "s"}`}</div>
        </div>
        {canEdit && <button className="btn btn-gold" onClick={() => setShowIssue(true)}>+ Issue equipment</button>}
      </div>

      <div className="section-card sticky-card">
        <div className="section-head">Issuance ledger</div>
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Issued to</th><th>Asset</th><th>Serial</th><th>Qty</th>
              <th>Issued</th><th>Due back</th><th>Returned</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr className="empty-row"><td colSpan={9}>Loading the issuance ledger…</td></tr>}
            {!loading && !rows.length && <tr className="empty-row"><td colSpan={9}>Nothing issued yet.</td></tr>}
            {!loading && rows.map((i) => {
              const overdue = ["Issued", "Partially Returned"].includes(i.status) && i.expectedReturnDate && i.expectedReturnDate < todayStr;
              return (
                <tr key={i.id}>
                  <td>
                    <strong>{i.employeeName}</strong>
                    <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{[i.employeeNo, i.position, i.site].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>
                    {i.assetTag}
                    <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{i.assetName}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>{i.serialNumber || "—"}</td>
                  <td>{i.quantityReturned > 0 && i.quantityReturned < i.quantity ? `${i.quantity - i.quantityReturned} of ${i.quantity}` : i.quantity}</td>
                  <td style={{ fontSize: 12 }}>{shortDate(i.issuedDate)}</td>
                  <td style={{ fontSize: 12, color: overdue ? "var(--red)" : undefined, fontWeight: overdue ? 700 : undefined }}>
                    {shortDate(i.expectedReturnDate)}{overdue ? " · overdue" : ""}
                  </td>
                  <td style={{ fontSize: 12 }}>{shortDate(i.returnedDate)}</td>
                  <td><span className={`badge ${issuanceStatusBadgeClass(i.status)}`}>{i.status}</span></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {canEdit && ["Issued", "Partially Returned"].includes(i.status) && (
                      <button className="btn btn-sm btn-primary" onClick={() => setReturning(i)}>Return</button>
                    )}
                    <button className="btn btn-sm btn-secondary" style={{ marginLeft: 6 }} onClick={() => receipt(i)}>Form</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showIssue && (
        <IssueModal onClose={() => setShowIssue(false)}
          onSaved={async () => { setShowIssue(false); onChanged(); await load(); }} onError={onError} />
      )}
      {returning && (
        <ReturnModal issuance={returning} onClose={() => setReturning(null)}
          onSaved={async () => { setReturning(null); onChanged(); await load(); }} onError={onError} />
      )}
    </>
  );
}

// ---- Alerts -----------------------------------------------------------------

function AlertsTab({ revision, onError }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api("/assets/alerts/all").then(setData).catch((e) => onError(e.message));
  }, [revision, onError]);

  if (!data) return <div className="section-card" style={{ padding: 24 }}>Loading alerts…</div>;

  const block = (title, hint, rows, columns, empty) => (
    <div className="section-card sticky-card" style={{ marginTop: 16 }}>
      <div className="section-head">{title} ({rows.length})</div>
      <div style={{ fontSize: 12, color: "var(--text-mute)", padding: "10px 16px 0" }}>{hint}</div>
      <table className="sticky-head">
        <thead><tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}</tr></thead>
        <tbody>
          {!rows.length && <tr className="empty-row"><td colSpan={columns.length}>{empty}</td></tr>}
          {rows.map((r, idx) => (
            <tr key={r.id ?? idx}>{columns.map((c) => <td key={c.label}>{c.render(r)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", margin: "16px 32px 0" }}>
        <div className="kpi-card danger"><div className="kpi-label">Overdue returns</div><div className="kpi-value">{data.counts.overdue}</div></div>
        <div className="kpi-card"><div className="kpi-label">Due within 7 days</div><div className="kpi-value">{data.counts.dueSoon}</div></div>
        <div className="kpi-card"><div className="kpi-label">Replacement / warranty</div><div className="kpi-value">{data.counts.replacement}</div></div>
        <div className="kpi-card"><div className="kpi-label">Low stock</div><div className="kpi-value">{data.counts.lowStock}</div></div>
      </div>

      {block("Overdue returns",
        "Past their expected return date and still with the holder.",
        data.overdue,
        [
          { label: "Holder", render: (r) => <><strong>{r.employeeName}</strong><div style={{ fontSize: 11, color: "var(--text-mute)" }}>{[r.position, r.site].filter(Boolean).join(" · ")}</div></> },
          { label: "Asset", render: (r) => <>{r.assetTag}<div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.assetName}</div></> },
          { label: "Due", render: (r) => shortDate(r.dueDate) },
          { label: "Days overdue", render: (r) => <strong style={{ color: "var(--red)" }}>{r.daysOverdue}</strong> },
          { label: "Outstanding", render: (r) => `${Number(r.quantity) - Number(r.quantityReturned)} of ${r.quantity}` },
        ],
        "Nothing is overdue.")}

      {block("Due back soon",
        "Coming due in the next 7 days — worth a reminder before they become overdue.",
        data.dueSoon,
        [
          { label: "Holder", render: (r) => r.employeeName },
          { label: "Asset", render: (r) => `${r.assetTag} — ${r.assetName}` },
          { label: "Due", render: (r) => shortDate(r.dueDate) },
          { label: "In", render: (r) => `${r.daysUntilDue} day${r.daysUntilDue === 1 ? "" : "s"}` },
        ],
        "Nothing due in the next week.")}

      {block("Replacement & warranty",
        "Warranty expiring or a planned replacement date reached within 30 days.",
        data.replacement,
        [
          { label: "Asset", render: (r) => <><strong>{r.assetTag}</strong><div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.name}</div></> },
          { label: "Classification", render: (r) => <span style={{ fontSize: 12 }}>{classificationPath(r)}</span> },
          { label: "Reason", render: (r) => r.alertKind },
          { label: "Date", render: (r) => <span style={{ color: r.expired ? "var(--red)" : undefined, fontWeight: r.expired ? 700 : undefined }}>{shortDate(r.alertDate)}{r.expired ? " · passed" : ""}</span> },
          { label: "Condition", render: (r) => <span className={`badge ${conditionBadgeClass(r.condition)}`}>{r.condition}</span> },
        ],
        "No replacements coming due.")}

      {block("Low stock",
        "Bulk stock at or below its reorder level. Available is what is owned less what is out on issue.",
        data.lowStock,
        [
          { label: "Asset", render: (r) => <><strong>{r.assetTag}</strong><div style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.name}</div></> },
          { label: "Classification", render: (r) => <span style={{ fontSize: 12 }}>{classificationPath(r)}</span> },
          { label: "Owned", render: (r) => r.quantity },
          { label: "Available", render: (r) => <strong style={{ color: "var(--red)" }}>{r.available}</strong> },
          { label: "Reorder at", render: (r) => r.reorderLevel },
        ],
        "No stock is running low.")}
    </>
  );
}

// ---- Classification ---------------------------------------------------------

function ClassificationTab({ canEdit, isAdmin, revision, onChanged, onError }) {
  const [tree, setTree] = useState({ types: [], categories: [], subcategories: [] });
  const [selectedType, setSelectedType] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTree(await api("/assets/classification")); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load, revision]);

  const categories = tree.categories.filter((c) => selectedType && String(c.typeId) === String(selectedType));
  const subcategories = tree.subcategories.filter((s) => selectedCategory && String(s.categoryId) === String(selectedCategory));

  async function add(level, name, parentId) {
    try {
      await api(`/assets/classification/${level}`, { method: "POST", body: JSON.stringify({ name, parentId }) });
      onChanged(); await load();
    } catch (e) { onError(e.message); }
  }
  async function rename(level, row) {
    const name = window.prompt(`Rename "${row.name}" to:`, row.name);
    if (!name || name === row.name) return;
    try {
      await api(`/assets/classification/${level}/${row.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      onChanged(); await load();
    } catch (e) { onError(e.message); }
  }
  async function toggle(level, row) {
    try {
      await api(`/assets/classification/${level}/${row.id}`, { method: "PATCH", body: JSON.stringify({ active: !row.active }) });
      onChanged(); await load();
    } catch (e) { onError(e.message); }
  }
  async function remove(level, row) {
    if (!window.confirm(`Delete "${row.name}"?`)) return;
    try {
      await api(`/assets/classification/${level}/${row.id}`, { method: "DELETE" });
      if (level === "types" && String(selectedType) === String(row.id)) setSelectedType(null);
      if (level === "categories" && String(selectedCategory) === String(row.id)) setSelectedCategory(null);
      onChanged(); await load();
    } catch (e) { onError(e.message); }
  }

  return (
    <>
      <div style={{ margin: "16px 32px 0", fontSize: 12.5, color: "var(--text-mute)", maxWidth: 860 }}>
        Asset Type → Category → Sub-Category. These lists belong to this module alone — they are not the shared
        dropdowns under Manage Lists, and nothing outside Asset &amp; Equipment Management uses them. Pick a row on
        the left to maintain the level beneath it.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, margin: "12px 32px 0" }}>
        <ClassColumn
          title="Asset Type" level="types" rows={tree.types} loading={loading}
          selectedId={selectedType} onSelect={(id) => { setSelectedType(id); setSelectedCategory(null); }}
          canEdit={canEdit} isAdmin={isAdmin} onAdd={(name) => add("types", name, null)}
          onRename={(r) => rename("types", r)} onToggle={(r) => toggle("types", r)} onDelete={(r) => remove("types", r)}
          placeholder="e.g. Security"
        />
        <ClassColumn
          title="Category" level="categories" rows={categories} loading={loading}
          selectedId={selectedCategory} onSelect={setSelectedCategory}
          canEdit={canEdit && !!selectedType} isAdmin={isAdmin} onAdd={(name) => add("categories", name, selectedType)}
          onRename={(r) => rename("categories", r)} onToggle={(r) => toggle("categories", r)} onDelete={(r) => remove("categories", r)}
          placeholder="e.g. Peripherals"
          empty={selectedType ? "No categories under this type yet." : "Select an asset type."}
        />
        <ClassColumn
          title="Sub-Category" level="subcategories" rows={subcategories} loading={loading}
          selectedId={null} onSelect={() => {}}
          canEdit={canEdit && !!selectedCategory} isAdmin={isAdmin} onAdd={(name) => add("subcategories", name, selectedCategory)}
          onRename={(r) => rename("subcategories", r)} onToggle={(r) => toggle("subcategories", r)} onDelete={(r) => remove("subcategories", r)}
          placeholder="e.g. Search Light"
          empty={selectedCategory ? "No sub-categories under this category yet." : "Select a category."}
        />
      </div>
    </>
  );
}

function ClassColumn({ title, rows, loading, selectedId, onSelect, canEdit, isAdmin, onAdd, onRename, onToggle, onDelete, placeholder, empty }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="section-card" style={{ padding: 0 }}>
      <div className="section-head">{title}</div>
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        <table>
          <tbody>
            {loading && <tr className="empty-row"><td>Loading…</td></tr>}
            {!loading && !rows.length && <tr className="empty-row"><td>{empty || "Nothing here yet."}</td></tr>}
            {!loading && rows.map((r) => (
              <tr key={r.id}
                onClick={() => onSelect(r.id)}
                style={{
                  cursor: onSelect ? "pointer" : undefined,
                  background: String(selectedId) === String(r.id) ? "var(--bg-soft, #EEF2F7)" : undefined,
                }}>
                <td>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ opacity: r.active ? 1 : 0.5 }}>
                      {r.name}
                      {!r.active && <span className="badge badge-closed" style={{ marginLeft: 6 }}>Inactive</span>}
                      {r.assetCount > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-mute)" }}>{r.assetCount} asset{r.assetCount === 1 ? "" : "s"}</span>}
                    </span>
                    {canEdit && (
                      <span style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-sm btn-secondary" onClick={() => onRename(r)}>Rename</button>
                        <button className="btn btn-sm btn-secondary" style={{ marginLeft: 4 }} onClick={() => onToggle(r)}>
                          {r.active ? "Deactivate" : "Activate"}
                        </button>
                        {isAdmin && <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => onDelete(r)}>Delete</button>}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6, padding: 12, borderTop: "1px solid var(--border, #e4e9f0)" }}>
          <input value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onAdd(draft.trim()); setDraft(""); } }} />
          <button className="btn btn-sm btn-gold" disabled={!draft.trim()}
            onClick={() => { onAdd(draft.trim()); setDraft(""); }}>Add</button>
        </div>
      )}
    </div>
  );
}
