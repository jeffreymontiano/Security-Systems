import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import useModulePerms from "../lib/modulePerms";
import { confirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import StatusBadge from "../components/StatusBadge";
import ConfidentialFooter from "../components/ConfidentialFooter";
import UsefulLinkModal from "./UsefulLinkModal";
import { hostOf, isSafeHref } from "./usefulLinksShared";

const SUBTITLE = "Central directory of external portals and websites used across operations, HR, compliance and IT";

export default function UsefulLinksPage() {
  // Per-user Access Privileges, not the role — an administrator's override in
  // Manage Users is how everyone outside leadership reaches this module, and a
  // role flag cannot see one.
  const perm = useModulePerms();
  const isViewer = !perm.edit;

  const [links, setLinks] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [editing, setEditing] = useState(null);   // a link, or "new"
  const debounceRef = useRef(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = [];
      if (search.trim()) params.push(`search=${encodeURIComponent(search.trim())}`);
      if (categoryFilter) params.push(`category=${encodeURIComponent(categoryFilter)}`);
      if (statusFilter) params.push(`status=${encodeURIComponent(statusFilter)}`);
      setLinks(await api(`/useful-links${params.length ? "?" + params.join("&") : ""}`));
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, categoryFilter, statusFilter]);

  // Categories come from Manage List and nowhere else. Loaded once: renaming one
  // there is rare, and Refresh re-reads both.
  const loadCategories = useCallback(async () => {
    setCategories(await api("/meta/dropdown/url_category").catch(() => []));
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadList, 250);
    return () => clearTimeout(debounceRef.current);
  }, [loadList]);

  async function refreshAll() {
    await Promise.all([loadCategories(), loadList()]);
  }

  async function handleDelete(link) {
    const ok = await confirm({
      title: "Delete useful link?",
      body: `Are you sure you want to delete: "${link.name}"?`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/useful-links/${link.id}`, { method: "DELETE" });
      toast.success(`"${link.name}" deleted.`);
      await loadList();
    } catch (e) {
      setLoadError(e.message);
    }
  }

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={refreshAll}>Refresh</button>
      {perm.add && <button className="btn btn-gold" onClick={() => setEditing("new")}>+ Add Useful Link</button>}
    </>
  );

  const colSpan = isViewer && !perm.delete ? 4 : 5;

  return (
    <div className="module-view">
      <ModuleHeader icon="🔗" iconBg="var(--gold)" title="Useful Links" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>
        Keep the external portals operations depends on in one place, maintained by the agency rather than hardcoded.
      </PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search name, URL or description..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${links.length} link${links.length === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Useful links</div>
        <table>
          <thead>
            <tr>
              <th>Name</th><th>URL Category</th><th>URL</th><th>Status</th>
              {(perm.edit || perm.delete) && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={colSpan}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={colSpan}><div className="empty-hint">Loading...</div></td></tr>}
            {!loadError && !loading && links.length === 0 && (
              <tr><td colSpan={colSpan}>
                <div className="empty-hint">
                  No useful links have been added yet.
                  {perm.add && (
                    <>
                      {" "}
                      <button className="btn btn-gold btn-sm" style={{ marginTop: 10 }} onClick={() => setEditing("new")}>
                        + Add Useful Link
                      </button>
                    </>
                  )}
                </div>
              </td></tr>
            )}
            {!loadError && !loading && links.map((l) => (
              <tr key={l.id}>
                <td data-label="Name">
                  <strong>{l.name}</strong>
                  {l.description && (
                    <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginTop: 3 }}>{l.description}</div>
                  )}
                </td>
                <td data-label="URL Category"><span className="chip">{l.urlCategory}</span></td>
                <td data-label="URL">
                  {/* noopener noreferrer: the opened site must not get a handle
                      on this window, and CSOMS must not navigate away. */}
                  {isSafeHref(l.url)
                    ? <a href={l.url} target="_blank" rel="noopener noreferrer">{hostOf(l.url)}</a>
                    : <span title={l.url}>{hostOf(l.url)}</span>}
                </td>
                <td data-label="Status"><StatusBadge status={l.status} /></td>
                {(perm.edit || perm.delete) && (
                  <td data-label="Actions">
                    {perm.edit && (
                      <button className="btn btn-outline btn-sm" onClick={() => setEditing(l)}>Edit</button>
                    )}
                    {perm.delete && (
                      <button className="btn btn-outline btn-sm" style={{ marginLeft: 6 }} onClick={() => handleDelete(l)}>
                        Delete
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfidentialFooter />

      {editing && (
        <UsefulLinkModal
          link={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            toast.success(editing === "new" ? `"${saved.name}" added.` : `"${saved.name}" updated.`);
            await loadList();
          }}
        />
      )}
    </div>
  );
}
