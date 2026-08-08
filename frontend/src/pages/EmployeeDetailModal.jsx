import { useEffect, useState, useCallback } from "react";
import { api, apiUpload, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { EMPLOYMENT_STATUSES, GENDER_OPTIONS, CIVIL_STATUS_OPTIONS, EDUCATION_LEVEL_OPTIONS, EMPLOYMENT_TYPE_OPTIONS, expiryState, fileSize, PAYOUT_CHANNEL_OPTIONS, payoutKind, maskAccount, looksLikePhMobile } from "./employeeShared";

const TABS = ["Personal & IDs", "Education", "Employment", "Documents"];

// A select's empty option reads "— Select <field> —". Lower-casing the whole
// label mangles an acronym: "LESP category" became "lesp category". Only words
// that are not already fully upper-case get lowered, so LESP, SSS and TIN keep
// their casing while "Civil status" still reads naturally.
const placeholderLabel = (label) =>
  String(label).split(" ").map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(" ");

const DOC_TYPES = [
  "NBI Clearance", "Police Clearance", "Medical Certificate", "Security License",
  "Employment Contract", "SSS ID", "PhilHealth ID", "Pag-IBIG ID", "TIN ID",
  "Barangay Clearance", "Drug Test Result", "Training Certificate", "Other",
];

export default function EmployeeDetailModal({ employeeId, isViewer, onClose, onChanged, onDeleted, siteOptions = [] }) {
  const [emp, setEmp] = useState(null);
  const [tab, setTab] = useState(TABS[0]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await api(`/employees/${employeeId}`);
      setEmp(data);
      setForm(data);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [employeeId]);

  useEffect(() => { load(); }, [load]);

  const canEdit = !isViewer;

  async function saveCore() {
    try {
      await api(`/employees/${employeeId}`, { method: "PATCH", body: JSON.stringify(form) });
      setEditing(false);
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); }
  }

  async function removeEmployee() {
    if (!window.confirm("Delete this employee record and all its documents? This cannot be undone.")) return;
    try {
      await api(`/employees/${employeeId}`, { method: "DELETE" });
      onDeleted?.();
    } catch (e) { setError(e.message); }
  }

  if (!emp) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading\u2026</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading employee record\u2026"}</div>
        </div>
      </div>
    );
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{emp.fullName}{emp.employeeNo ? `  ·  ${emp.employeeNo}` : ""}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>

          {tab === "Personal & IDs" && (
            <PersonalTab emp={emp} form={form} set={set} editing={editing} canEdit={canEdit} siteOptions={siteOptions} />
          )}
          {tab === "Education" && (
            <EducationTab employeeId={employeeId} rows={emp.education} highest={emp.highestEducation} canEdit={canEdit} reload={async () => { await load(); onChanged?.(); }} setError={setError} />
          )}
          {tab === "Employment" && (
            <EmploymentTab employeeId={employeeId} rows={emp.employment} canEdit={canEdit} reload={async () => { await load(); onChanged?.(); }} setError={setError} />
          )}
          {tab === "Documents" && (
            <DocumentsTab employeeId={employeeId} rows={emp.documents} canEdit={canEdit} reload={async () => { await load(); onChanged?.(); }} setError={setError} />
          )}
        </div>
        <div className="modal-footer">
          {canEdit && tab === "Personal & IDs" && !editing && (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit details</button>
          )}
          {canEdit && tab === "Personal & IDs" && editing && (
            <>
              <button className="btn btn-secondary" onClick={() => { setEditing(false); setForm(emp); }}>Cancel</button>
              <button className="btn btn-gold" onClick={saveCore}>Save changes</button>
            </>
          )}
          {canEdit && !editing && (
            <button className="btn btn-danger" onClick={removeEmployee} style={{ marginRight: "auto" }}>Delete</button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---- Personal & IDs tab ----------------------------------------------------
// The highest level from the Education tab, computed on the server so the
// screen, the API and any report agree. Read-only in every state — it is a
// conclusion drawn from the education entries, not a field anyone fills in.
function DerivedEducation({ emp }) {
  const h = emp.highestEducation;
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ fontSize: 13.5, color: "var(--text)" }}>
        {h && h.level ? h.level : "—"}
        {h && !h.known && (
          <span className="badge badge-progress" style={{ marginLeft: 8 }}>Unrecognised level</span>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 2 }}>
        {h
          ? `From the Education tab${h.schoolName ? ` — ${h.schoolName}` : ""}${h.yearGraduated ? ` (${h.yearGraduated})` : ""}`
          : "No educational history recorded."}
      </div>
    </div>
  );
}

function PersonalTab({ emp, form, set, editing, canEdit, siteOptions }) {
  // The LESP categories are admin-maintained in Manage Lists, so they are read
  // from there rather than hardcoded here. A failure falls back to an empty
  // list: the field then keeps whatever value the record already holds (see the
  // "keep an existing value visible" branch below) instead of clearing it.
  const [lespCategories, setLespCategories] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api("/meta/dropdown/lesp_category")
      .then((v) => { if (!cancelled) setLespCategories(Array.isArray(v) ? v : []); })
      .catch(() => { /* leave empty; the stored value still shows */ });
    return () => { cancelled = true; };
  }, []);

  // Field defs: [key, label, type]. type "select" pulls options from the map
  // below; anything else is a text/date input.
  const fields = [
    ["fullName", "Full name"], ["employeeNo", "Employee number"], ["position", "Position"],
    ["site", "Site", "select"], ["dateHired", "Date hired", "date"],
    ["birthDate", "Birth date", "date"], ["gender", "Gender", "select"], ["civilStatus", "Civil status", "select"],
    ["contactNumber", "Contact number"], ["email", "Email"], ["address", "Address"],
    ["sssNo", "SSS number"], ["philhealthNo", "PhilHealth number"], ["pagibigNo", "Pag-IBIG number"], ["tinNo", "TIN"],
    // The three LESP fields travel together: the Monthly Disposition Report
    // prints the number, its category and its expiry against every guard, and
    // a lapsed licence is the thing RCSU reads that return to catch. Captured
    // once here rather than re-keyed onto each month's filing.
    //
    // Category is a "select" fed from Manage Lists, NOT a hardcoded list —
    // PNP-SOSIA revises the categories and a new one must not need a deploy.
    ["lespNo", "LESP number"],
    ["lespCategory", "LESP category", "select"],
    ["lespExpiry", "LESP expiry", "date"],
    // Derived from the Education tab, never typed. Type "derived" renders as
    // plain text even in edit mode, so nobody hunts for a field to fill in.
    ["highestEducation", "Highest educational attainment", "derived"],
    // Clearance and examination dates. Kept together and after the licence
    // block, because they are the same kind of fact: things that lapse and
    // have to be renewed.
    ["policeClearanceExpiry", "National Police Clearance expiry", "date"],
    ["lastMedicalExam", "Last medical examination", "date"],
    ["lastNeuroExam", "Last neuro examination", "date"],
    ["lastDrugTestExam", "Last drug test examination", "date"],
    ["emergencyContactName", "Emergency contact"], ["emergencyContactNumber", "Emergency number"], ["emergencyContactRelation", "Relationship"],
    ["payType", "Pay type", "select"], ["dailyRate", "Daily rate", "number"], ["monthlyRate", "Monthly rate", "number"],
  ];
  const optionsFor = {
    gender: GENDER_OPTIONS,
    civilStatus: CIVIL_STATUS_OPTIONS,
    site: siteOptions || [],
    lespCategory: lespCategories,
    payType: ["Daily", "Monthly"],
  };
  return (
    <div>
      {editing && canEdit && (
        <div className="form-field" style={{ marginBottom: 14 }}>
          <label>Employment status</label>
          <select value={form.employmentStatus || ""} onChange={set("employmentStatus")}>
            {EMPLOYMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      )}
      <div className="form-grid">
        {fields.map(([key, label, type]) => (
          <div className="form-field" key={key}>
            <label>{label}</label>
            {type === "derived" ? (
              <DerivedEducation emp={emp} />
            ) : editing && canEdit ? (
              type === "select" ? (
                <select value={form[key] || ""} onChange={set(key)}>
                  <option value="">{`\u2014 Select ${placeholderLabel(label)} \u2014`}</option>
                  {/* Keep an existing value visible even if it's not in the current option list */}
                  {form[key] && !(optionsFor[key] || []).includes(form[key]) && (
                    <option value={form[key]}>{form[key]}</option>
                  )}
                  {(optionsFor[key] || []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input type={type || "text"} value={form[key] || ""} onChange={set(key)} />
              )
            ) : (
              <div style={{ fontSize: 13.5, color: "var(--text)", padding: "4px 0" }}>{emp[key] || "\u2014"}</div>
            )}
          </div>
        ))}
      </div>

      <PayoutDetails emp={emp} form={form} set={set} editing={editing} canEdit={canEdit} />
    </div>
  );
}

// ---- Payout details --------------------------------------------------------
// Where this guard's net pay is sent when payroll is disbursed. Grouped and
// labelled separately from the personal fields because it is the one block on
// this form that moves money.
function PayoutDetails({ emp, form, set, editing, canEdit }) {
  const live = editing && canEdit ? form : emp;
  const channel = live.payoutChannel || "";
  const kind = payoutKind(channel);
  // What the account number MEANS depends on the channel — a mobile number for
  // the wallets, a bank account number for GoTyme and banks. With no channel
  // chosen yet it is neither, so it must not claim to be one: labelling an
  // unset field "Bank account number" reads as though e-wallets are not
  // supported at all.
  const accountLabel = kind === "wallet" ? "Mobile number"
    : kind === "bank" ? "Bank account number"
    : "Account number";

  // Warn, never block. The number may be unusual and still correct — the
  // person entering it may know something the pattern does not.
  const mobileWarning =
    kind === "wallet" && live.payoutAccountNumber && !looksLikePhMobile(live.payoutAccountNumber);

  return (
    <div style={{ marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12.5, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
        Payout details
      </div>
      <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 14, maxWidth: 640 }}>
        Where this employee's net pay is sent when a payroll disbursement is prepared. Leave the channel unset
        for anyone paid another way — they will simply be listed as skipped on the disbursement, not treated
        as an error.
      </div>

      {!editing || !canEdit ? (
        <>
          <div className="form-grid">
            <ReadField label="Payout channel" value={PAYOUT_CHANNEL_OPTIONS.find((o) => o.value === channel)?.label || "—"} />
            <ReadField label="Account name" value={emp.payoutAccountName || "—"} />
            {/* Masked on display: enough to confirm the destination, not enough
                to reuse it. The full number only ever reaches the export file. */}
            <ReadField label={accountLabel} value={emp.payoutAccountNumber ? maskAccount(emp.payoutAccountNumber) : "—"} />
            {kind === "bank" && <ReadField label="Bank code" value={emp.payoutBankCode || "—"} />}
          </div>
          {/* Every field on this tab is read-only until Edit details is
              pressed. That is obvious for fields already carrying a value and
              much less so for a whole group that is empty, so say it. */}
          {!channel && canEdit && (
            <div style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 10 }}>
              Press <strong>Edit details</strong> above to set a GCash, Maya, GoTyme or bank account for payroll crediting.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="form-grid">
            <div className="form-field">
              <label>Payout channel</label>
              <select value={channel} onChange={set("payoutChannel")}>
                {PAYOUT_CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {channel && (
              <div className="form-field">
                <label>Account holder name</label>
                <input value={form.payoutAccountName || ""} onChange={set("payoutAccountName")} placeholder="As registered with the wallet or bank" />
                <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}>
                  A payout can fail or misroute if this does not match the account's own records.
                </div>
              </div>
            )}
            {channel && (
              <div className="form-field">
                <label>{accountLabel}</label>
                <input
                  value={form.payoutAccountNumber || ""}
                  onChange={set("payoutAccountNumber")}
                  placeholder={kind === "wallet" ? "09XXXXXXXXX" : "Account number"}
                />
                {mobileWarning && (
                  <div style={{ fontSize: 11.5, color: "#8a6d1f", marginTop: 4 }}>
                    That does not look like an 11-digit PH mobile number (09XXXXXXXXX). Saving is allowed — check it before the next payout.
                  </div>
                )}
              </div>
            )}
            {kind === "bank" && (
              <div className="form-field">
                <label>Bank code</label>
                <input value={form.payoutBankCode || ""} onChange={set("payoutBankCode")} placeholder="e.g. PH_GOTYME" />
                <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}>
                  {channel === "GOTYME"
                    ? "GoTyme is a digital bank — it needs a bank code and the account number, not a mobile number."
                    : "The payment provider's code for this bank."}
                </div>
              </div>
            )}
          </div>
          {channel && (
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 10 }}>
              Account numbers are shown masked everywhere in the app and never written to the audit trail — the
              full number appears only in the disbursement file itself.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ReadField({ label, value }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <div style={{ fontSize: 13.5, color: "var(--text)", padding: "4px 0" }}>{value}</div>
    </div>
  );
}

// ---- Education tab ---------------------------------------------------------
function EducationTab({ employeeId, rows, highest, canEdit, reload, setError }) {
  const [add, setAdd] = useState({ level: "", schoolName: "", courseOrStrand: "", yearGraduated: "" });
  async function addRow() {
    if (!add.schoolName.trim()) { setError("School name is required."); return; }
    try {
      await api(`/employees/${employeeId}/education`, { method: "POST", body: JSON.stringify(add) });
      setAdd({ level: "", schoolName: "", courseOrStrand: "", yearGraduated: "" });
      await reload();
    } catch (e) { setError(e.message); }
  }
  async function removeRow(id) {
    try { await api(`/employees/${employeeId}/education/${id}`, { method: "DELETE" }); await reload(); }
    catch (e) { setError(e.message); }
  }
  return (
    <div>
      {/* The conclusion these entries add up to, shown where the evidence is so
          it visibly changes as entries are added or removed. Server-derived —
          the same value the Personal & IDs tab shows. */}
      <div className="section-card" style={{ padding: "12px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>
          Highest educational attainment
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 3 }}>
          {highest && highest.level ? highest.level : "—"}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 2 }}>
          {highest
            ? [highest.schoolName, highest.courseOrStrand, highest.yearGraduated].filter(Boolean).join("  ·  ")
              || "Derived from the entries below."
            : "No educational history recorded."}
        </div>
      </div>

      <div className="entry-list">
        {rows.length === 0 && <div className="empty-hint">No educational history recorded.</div>}
        {rows.map((r) => (
          <div className="entry-card" key={r.id}>
            <div className="entry-top">
              <div>
                <div className="entry-title">{r.schoolName}</div>
                <div className="entry-meta">
                  {[r.level, r.courseOrStrand, r.yearGraduated].filter(Boolean).join("  ·  ") || "\u2014"}
                </div>
              </div>
              {canEdit && <button className="entry-remove" onClick={() => removeRow(r.id)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="add-row">
          <div className="form-field"><label>Level</label>
            <select value={add.level} onChange={(e) => setAdd({ ...add, level: e.target.value })}>
              <option value="">{"\u2014 Select level \u2014"}</option>
              {EDUCATION_LEVEL_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="form-field"><label>School name</label><input type="text" placeholder="Angeles University" value={add.schoolName} onChange={(e) => setAdd({ ...add, schoolName: e.target.value })} /></div>
          <div className="form-field"><label>Course / strand</label><input type="text" value={add.courseOrStrand} onChange={(e) => setAdd({ ...add, courseOrStrand: e.target.value })} /></div>
          <div className="form-field"><label>Year graduated / highest reached</label><input type="text" placeholder="2018" value={add.yearGraduated} onChange={(e) => setAdd({ ...add, yearGraduated: e.target.value })} /></div>
          <button className="btn btn-secondary" onClick={addRow}>Add</button>
        </div>
      )}
    </div>
  );
}

// ---- Employment history tab ------------------------------------------------
function EmploymentTab({ employeeId, rows, canEdit, reload, setError }) {
  const [add, setAdd] = useState({ companyName: "", position: "", employmentType: "", yearsEmployed: "", dateResigned: "" });
  async function addRow() {
    if (!add.companyName.trim()) { setError("Company name is required."); return; }
    try {
      await api(`/employees/${employeeId}/employment`, { method: "POST", body: JSON.stringify(add) });
      setAdd({ companyName: "", position: "", employmentType: "", yearsEmployed: "", dateResigned: "" });
      await reload();
    } catch (e) { setError(e.message); }
  }
  async function removeRow(id) {
    try { await api(`/employees/${employeeId}/employment/${id}`, { method: "DELETE" }); await reload(); }
    catch (e) { setError(e.message); }
  }
  return (
    <div>
      <div className="entry-list">
        {rows.length === 0 && <div className="empty-hint">No employment history recorded.</div>}
        {rows.map((r) => (
          <div className="entry-card" key={r.id}>
            <div className="entry-top">
              <div>
                <div className="entry-title">{r.companyName}</div>
                <div className="entry-meta">
                  {[r.position, r.employmentType, r.yearsEmployed, r.dateResigned ? `until ${r.dateResigned}` : ""].filter(Boolean).join("  ·  ") || "\u2014"}
                </div>
              </div>
              {canEdit && <button className="entry-remove" onClick={() => removeRow(r.id)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="add-row">
          <div className="form-field"><label>Company name</label><input type="text" placeholder="Previous employer" value={add.companyName} onChange={(e) => setAdd({ ...add, companyName: e.target.value })} /></div>
          <div className="form-field"><label>Position</label><input type="text" value={add.position} onChange={(e) => setAdd({ ...add, position: e.target.value })} /></div>
          <div className="form-field"><label>Employment status</label>
            <select value={add.employmentType} onChange={(e) => setAdd({ ...add, employmentType: e.target.value })}>
              <option value="">{"\u2014 Select status \u2014"}</option>
              {EMPLOYMENT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="form-field"><label>Years employed</label><input type="text" placeholder="2018-2021" value={add.yearsEmployed} onChange={(e) => setAdd({ ...add, yearsEmployed: e.target.value })} /></div>
          <div className="form-field"><label>Date resigned / last employed</label><input type="date" value={add.dateResigned} onChange={(e) => setAdd({ ...add, dateResigned: e.target.value })} /></div>
          <button className="btn btn-secondary" onClick={addRow}>Add</button>
        </div>
      )}
    </div>
  );
}

// ---- Documents tab ---------------------------------------------------------
function DocumentsTab({ employeeId, rows, canEdit, reload, setError }) {
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [uploading, setUploading] = useState(false);

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await apiUpload(`/employees/${employeeId}/documents`, file, { docType, issueDate, expiryDate });
      setIssueDate(""); setExpiryDate("");
      await reload();
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function view(docId) {
    try { const url = await apiBlobUrl(`/employees/${employeeId}/documents/${docId}`); window.open(url, "_blank"); }
    catch (e) { setError(e.message); }
  }
  async function download(doc) {
    try { const url = await apiBlobUrl(`/employees/${employeeId}/documents/${doc.id}`); downloadBlobUrl(url, doc.filename); }
    catch (e) { setError(e.message); }
  }
  async function remove(docId) {
    try { await api(`/employees/${employeeId}/documents/${docId}`, { method: "DELETE" }); await reload(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div>
      {canEdit && (
        <div className="add-row" style={{ marginBottom: 16 }}>
          <div className="form-field"><label>Document type</label>
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-field"><label>Issue date</label><input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
          <div className="form-field"><label>Expiry date</label><input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></div>
          <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
            {uploading ? "Uploading\u2026" : "Upload file"}
            <input type="file" style={{ display: "none" }} disabled={uploading}
              onChange={(e) => { upload(e.target.files[0]); e.target.value = ""; }} />
          </label>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Type</th><th>File</th><th>Size</th><th>Expiry</th><th>Uploaded</th><th></th></tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr className="empty-row"><td colSpan={6}>No documents uploaded.</td></tr>}
          {rows.map((d) => {
            const exp = expiryState(d.expiryDate);
            return (
              <tr key={d.id}>
                <td data-label="Type">{d.docType || "\u2014"}</td>
                <td data-label="File"><a href="#" onClick={(e) => { e.preventDefault(); view(d.id); }}>{d.filename}</a></td>
                <td data-label="Size">{fileSize(d.size)}</td>
                <td data-label="Expiry">
                  {d.expiryDate ? <span className={`badge ${exp.cls}`}>{exp.label}</span> : "\u2014"}
                </td>
                <td data-label="Uploaded">{(d.uploaded_at || "").slice(0, 10)}</td>
                <td data-label="" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => download(d)}>Download</button>
                  {canEdit && <button className="btn btn-sm btn-danger" onClick={() => remove(d.id)} style={{ marginLeft: 6 }}>Remove</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
