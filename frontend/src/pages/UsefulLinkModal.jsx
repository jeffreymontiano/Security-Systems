import { useState } from "react";
import { api } from "../api/client";
import { checkUrl } from "./usefulLinksShared";

/**
 * Add / edit a useful link. One modal for both, because the fields are
 * identical and a separate "edit" copy is a second place for them to drift.
 *
 * `link` absent = create. Categories come from Manage List -> URL Category and
 * are never hardcoded here; the server validates the chosen value again on
 * save.
 */
export default function UsefulLinkModal({ link, categories, onClose, onSaved }) {
  const editing = !!link;

  const [name, setName] = useState(link?.name || "");
  const [url, setUrl] = useState(link?.url || "");
  const [urlCategory, setUrlCategory] = useState(link?.urlCategory || categories[0] || "");
  const [description, setDescription] = useState(link?.description || "");
  const [status, setStatus] = useState(link?.status || "Active");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");

    if (!name.trim()) { setError("Link name is required."); return; }
    const checked = checkUrl(url);
    if (!checked.ok) { setError(checked.error); return; }
    if (!urlCategory) { setError("URL category is required."); return; }

    setSaving(true);
    try {
      const body = JSON.stringify({
        name: name.trim(), url: url.trim(), urlCategory,
        description: description.trim(), status,
      });
      const saved = editing
        ? await api(`/useful-links/${link.id}`, { method: "PATCH", body })
        : await api("/useful-links", { method: "POST", body });
      onSaved(saved);
    } catch (e) {
      // Stays beside the control that caused it rather than becoming a toast:
      // a duplicate URL or a rejected category is something to fix here.
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay active">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h2>{editing ? "Edit useful link" : "Add useful link"}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="empty-hint" style={{ color: "var(--red, #B3261E)", padding: "8px 0" }}>{error}</div>
          )}
          <div className="form-grid">
            <div className="form-field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="ul-name">Link name <span style={{ color: "var(--red, #B3261E)" }}>*</span></label>
              <input
                id="ul-name" type="text" value={name} maxLength={200}
                placeholder="PNP-SOSIA LESP Validation Portal"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="form-field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="ul-url">URL <span style={{ color: "var(--red, #B3261E)" }}>*</span></label>
              <input
                id="ul-url" type="text" value={url}
                placeholder="https://example.gov.ph/portal"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label htmlFor="ul-category">URL category <span style={{ color: "var(--red, #B3261E)" }}>*</span></label>
              <select id="ul-category" value={urlCategory} onChange={(e) => setUrlCategory(e.target.value)}>
                {/* An empty list means nobody has configured the list yet; say
                    so rather than rendering a silently empty picker. */}
                {categories.length === 0 && <option value="">No categories configured</option>}
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="ul-status">Status</label>
              <select id="ul-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option>Active</option>
                <option>Inactive</option>
              </select>
            </div>

            <div className="form-field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="ul-description">Description</label>
              <textarea
                id="ul-description" rows={3} value={description} maxLength={1000}
                placeholder="What this site is for, and who needs it."
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-gold" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add link"}
          </button>
        </div>
      </div>
    </div>
  );
}
