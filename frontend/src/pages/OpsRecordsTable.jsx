import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { statusOptionsFor, valueOptionsFor } from "./deploymentShared";

/**
 * One deployment sub-tab: an inline-editable table over ops_records of a single
 * record_type. Mirrors the legacy renderOpsContent + add/save/delete handlers.
 *
 * Each existing row is editable in place (date, site, label, optional status,
 * optional value, notes) with Save/Delete per row; a persistent add-row sits
 * below the table. Status/value columns render as dropdowns when the config
 * points at an options list, otherwise as free-text inputs. Viewers get a
 * read-only table with no edit controls or add-row.
 */
export default function OpsRecordsTable({ cfg, sites, dropdowns, isViewer, isAdmin }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Per-row edit drafts, keyed by record id.
  const [edits, setEdits] = useState({});

  // Add-row draft.
  const blankNew = useCallback(() => ({
    date: new Date().toISOString().slice(0, 10),
    site: "",
    label: "",
    status: statusOptionsFor(cfg, dropdowns)[0] || "",
    value: (valueOptionsFor(cfg, dropdowns) || [])[0] || "",
    notes: "",
  }), [cfg, dropdowns]);
  const [newRow, setNewRow] = useState(blankNew);

  // A tab may name its status column something specific, and a tab may have
  // no label field at all (the record IS the site + status on a date).
  const statusLabel = cfg.statusLabel || "Status";
  const hasLabel = cfg.hasLabel !== false;
  const statusOpts = statusOptionsFor(cfg, dropdowns);
  const valueOpts = valueOptionsFor(cfg, dropdowns);

  // "Full Name — 2026-0001" per active employee, for the tabs whose label is a
  // guard. `null` means the list is unavailable (not yet loaded, or the role
  // cannot read the 201 File) and the field stays a free-text input.
  const [employees, setEmployees] = useState(null);
  useEffect(() => {
    if (!cfg.labelFromEmployees) { setEmployees(null); return; }
    let active = true;
    api("/employees")
      .then((list) => {
        if (!active) return;
        const names = (Array.isArray(list) ? list : [])
          .filter((e) => e.employmentStatus !== "Separated")
          .map((e) => (e.employeeNo ? `${e.fullName} — ${e.employeeNo}` : e.fullName))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
        setEmployees(names);
      })
      .catch(() => { if (active) setEmployees(null); });
    return () => { active = false; };
  }, [cfg.labelFromEmployees, cfg.type]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api(`/ops/${cfg.type}`);
      setRows(data);
      const e = {};
      data.forEach((r) => {
        e[r.id] = {
          date: r.date, site: r.site || "", label: r.label,
          status: r.status || "", value: r.value || "", notes: r.notes || "",
        };
      });
      setEdits(e);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [cfg.type]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setNewRow(blankNew()); }, [blankNew]);

  function setEditField(id, key, val) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [key]: val } }));
  }
  function setNewField(key, val) {
    setNewRow((prev) => ({ ...prev, [key]: val }));
  }

  async function addRecord() {
    if (hasLabel && !newRow.label.trim()) { alert(`Please enter ${cfg.labelText.toLowerCase()}.`); return; }
    const payload = {
      date: newRow.date, site: newRow.site, label: newRow.label.trim(), notes: newRow.notes.trim(),
    };
    if (cfg.hasStatus) payload.status = newRow.status;
    if (cfg.hasValue) payload.value = (newRow.value || "").trim();
    try {
      await api(`/ops/${cfg.type}`, { method: "POST", body: JSON.stringify(payload) });
      await load();
    } catch (e) { alert(e.message); }
  }

  async function saveEdit(id) {
    const d = edits[id];
    const payload = { date: d.date, site: d.site, label: d.label.trim(), notes: d.notes.trim() };
    if (cfg.hasStatus) payload.status = d.status;
    if (cfg.hasValue) payload.value = (d.value || "").trim();
    try {
      await api(`/ops/${cfg.type}/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      await load();
    } catch (e) { alert(e.message); }
  }

  async function deleteRecord(id) {
    if (!confirm("Delete this record? This cannot be undone.")) return;
    try {
      await api(`/ops/${cfg.type}/${id}`, { method: "DELETE" });
      await load();
    } catch (e) { alert(e.message); }
  }

  /**
   * The guard picker, for the tabs whose label names a person.
   *
   * Options come from the 201 File and read "Full Name — 2026-0001", so two
   * guards with the same name are told apart by the number rather than by
   * whoever typed it. It replaces a free-text box that accepted anything,
   * including a guard who does not exist and a name spelled three ways.
   *
   * Two things it must not do:
   *  - lose an existing value. Records written before this have a plain typed
   *    name, which is not in the list; it is added as its own option so opening
   *    an old row for edit cannot silently blank the guard.
   *  - become unusable if the employee list cannot be read. If the fetch fails
   *    the field falls back to the original text input rather than offering an
   *    empty dropdown with no way to type.
   */
  const guardSelect = (value, onChange, key, className) => {
    if (!employees) {
      return <input type="text" className={className} value={value} placeholder={cfg.labelText}
                    onChange={(e) => onChange(e.target.value)} key={key} />;
    }
    const known = employees.some((o) => o === value);
    return (
      <select className={className} value={value} onChange={(e) => onChange(e.target.value)} key={key}>
        <option value="">Select {cfg.labelText.toLowerCase()}…</option>
        {value && !known && <option value={value}>{value} (not in the 201 File)</option>}
        {employees.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  };

  const siteSelect = (value, onChange, key) => (
    <select className="entry-edit-input" value={value} onChange={(e) => onChange(e.target.value)} key={key}>
      <option value="">—</option>
      {sites.map((s) => <option key={s}>{s}</option>)}
    </select>
  );

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 12 }}>{cfg.title}</div>

      {error && <div className="empty-hint">{error}</div>}

      {/* Data entry first — so adding records stays reachable without scrolling
          past a list that grows over time. Shown to non-viewers only. */}
      {!isViewer && !error && (
        <>
          <div className="section-divider" style={{ marginTop: 0 }}>Add new record</div>
          <div className="add-row">
            <div className="form-field"><label>Date</label>
              <input type="date" value={newRow.date} onChange={(e) => setNewField("date", e.target.value)} />
            </div>
            <div className="form-field"><label>Site</label>
              {siteSelect(newRow.site, (v) => setNewField("site", v))}
            </div>
            {hasLabel && <div className="form-field" style={{ flex: 2 }}><label>{cfg.labelText}</label>
              {cfg.labelFromEmployees
                ? guardSelect(newRow.label, (v) => setNewField("label", v), "new-label")
                : <input type="text" value={newRow.label} onChange={(e) => setNewField("label", e.target.value)} placeholder={cfg.labelText} />}
            </div>}
            {cfg.hasStatus && (
              <div className="form-field"><label>{statusLabel}</label>
                <select value={newRow.status} onChange={(e) => setNewField("status", e.target.value)}>
                  {statusOpts.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
            )}
            {cfg.hasValue && (
              <div className="form-field"><label>{cfg.valueLabel}</label>
                {valueOpts
                  ? <select value={newRow.value} onChange={(e) => setNewField("value", e.target.value)}>
                      {valueOpts.map((v) => <option key={v}>{v}</option>)}
                    </select>
                  : <input type="text" value={newRow.value} onChange={(e) => setNewField("value", e.target.value)} placeholder={cfg.valueLabel} />}
              </div>
            )}
            <div className="form-field" style={{ flex: 2 }}><label>Notes</label>
              <input type="text" value={newRow.notes} onChange={(e) => setNewField("notes", e.target.value)} placeholder="Optional" />
            </div>
            <button className="btn btn-primary btn-sm" onClick={addRecord}>Add</button>
          </div>

          <div className="section-divider">Records</div>
        </>
      )}

      {!error && loading && <div className="empty-hint">Loading...</div>}

      {!error && !loading && (
        rows.length ? (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Site</th>{hasLabel && <th>{cfg.labelText}</th>}
                  {cfg.hasStatus && <th>{statusLabel}</th>}
                  {cfg.hasValue && <th>{cfg.valueLabel}</th>}
                  <th>Notes</th>
                  {!isViewer && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = edits[r.id] || {};
                  return (
                    <tr key={r.id}>
                      <td data-label="Date">
                        {isViewer ? r.date : <input type="date" className="entry-edit-input" value={d.date} onChange={(e) => setEditField(r.id, "date", e.target.value)} />}
                      </td>
                      <td data-label="Site">
                        {isViewer ? (r.site || "—") : siteSelect(d.site, (v) => setEditField(r.id, "site", v))}
                      </td>
                      {hasLabel && <td data-label={cfg.labelText}>
                        {isViewer ? r.label
                          : cfg.labelFromEmployees
                            ? guardSelect(d.label, (v) => setEditField(r.id, "label", v), `lbl-${r.id}`, "entry-edit-input")
                            : <input type="text" className="entry-edit-input" value={d.label} onChange={(e) => setEditField(r.id, "label", e.target.value)} />}
                      </td>}
                      {cfg.hasStatus && (
                        <td data-label={statusLabel}>
                          {isViewer ? (r.status || "—") : (
                            <select className="entry-edit-input" value={d.status} onChange={(e) => setEditField(r.id, "status", e.target.value)}>
                              {statusOpts.map((s) => <option key={s}>{s}</option>)}
                            </select>
                          )}
                        </td>
                      )}
                      {cfg.hasValue && (
                        <td data-label={cfg.valueLabel}>
                          {isViewer ? (r.value || "—") : (
                            valueOpts
                              ? <select className="entry-edit-input" value={d.value} onChange={(e) => setEditField(r.id, "value", e.target.value)}>
                                  {valueOpts.map((v) => <option key={v}>{v}</option>)}
                                </select>
                              : <input type="text" className="entry-edit-input" value={d.value} onChange={(e) => setEditField(r.id, "value", e.target.value)} />
                          )}
                        </td>
                      )}
                      <td data-label="Notes">
                        {isViewer ? (r.notes || "—") : <input type="text" className="entry-edit-input" value={d.notes} onChange={(e) => setEditField(r.id, "notes", e.target.value)} />}
                      </td>
                      {!isViewer && (
                        <td data-label="Actions" style={{ whiteSpace: "nowrap" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => saveEdit(r.id)}>Save</button>
                          {isAdmin && <button className="entry-remove" style={{ marginLeft: 6 }} onClick={() => deleteRecord(r.id)}>Delete</button>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-hint">No records yet.</div>
      )}
    </div>
  );
}
