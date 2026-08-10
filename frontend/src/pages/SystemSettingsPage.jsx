import { useEffect, useState } from "react";
import { api, apiUpload } from "../api/client";
import { toast } from "../lib/toast";
import { confirm } from "../lib/confirm";
import useModulePerms from "../lib/modulePerms";
import { useSettings } from "../context/SettingsContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import { ABOUT_TEXT } from "../appBranding";

// Letterhead lines printed on the Statement of Account. They live here rather
// than in the Billing module because they identify the agency, not a billing
// run. SettingsContext deliberately doesn't carry them — it loads for every
// user on every page, and only this screen and the SOA need them.
const LETTERHEAD_FIELDS = [
  { key: "agencyTagline", label: "Tagline", hint: "Printed under the company name.", placeholder: "(THE EAGLE KING MARATHON)" },
  { key: "agencyAddress", label: "Main office address", hint: 'Printed as "Main Office: …".', placeholder: "BLK 9F LOT 45 Marina Homes, Brgy. Burot, Tarlac City" },
  { key: "agencyMobile", label: "Mobile number(s)", hint: 'Printed as "Mobile No. …".', placeholder: "0998-411-1107 / 0956-246-1891" },
  { key: "agencyEmail", label: "Email address", hint: 'Printed as "Email Address: …".', placeholder: "agency@example.com" },
  { key: "ownerName", label: "Owner / signatory", hint: "Signs the statement and receives payment.", placeholder: "2nd Lt. Juan Dela Cruz (Retired) PA" },
  { key: "ownerPosition", label: "Owner position", hint: "Printed beneath the signature.", placeholder: "General Manager / Owner" },
  { key: "agencyLtoNo", label: "LTO licence no.", hint: "On the Duty Detail Order letterhead — a PNP inspector checks it.", placeholder: "PSA-WGS-M00701-2024" },
  // Monthly Disposition Report letterhead. The MDR shows the LTO number AND
  // the date it expires, plus a named contact person — an RCSU reader needs to
  // know whom to call, which a general mobile number does not say.
  { key: "agencyLtoExpiry", label: "LTO licence expires", hint: 'On the MDR letterhead as "Expire on …".', type: "date" },
  { key: "agencyContactPerson", label: "Contact person", hint: "Named on the MDR letterhead.", placeholder: "Juan Dela Cruz" },
  { key: "agencyContactMobile", label: "Contact person's mobile", hint: "Falls back to the mobile number(s) above when blank.", placeholder: "0961 145 4922" },
];

// Where the agency files its Monthly Disposition Report, and to whom. An agency
// files with the same regional unit every month, so these are set once and
// pre-filled onto every new return; they stay editable on the return itself for
// a month that goes to a different region.
//
// The SUBJECT LINE is deliberately absent: it is composed from the region and
// the return's own month, which is what stops it naming a month the body and
// the certification disagree with.
// The two officers who sign agency documents, configured independently. They
// replace the single "Admin / Operation head" entry: an agency has both, and a
// document signed by the wrong one is wrong.
//
// The Operation Head signs a Duty Detail Order (it is an operational order) and
// inherited the old single value on upgrade, so no already-configured agency
// saw its DDO signatory change.
const SIGNATORY_FIELDS = [
  { key: "operationHeadName", label: "Operation Head name", hint: "Signs the Duty Detail Order.", placeholder: "2LT Juan Dela Cruz (RET) PA" },
  { key: "operationHeadPosition", label: "Operation Head position", hint: "Printed beneath that signature.", placeholder: "Operation Head" },
  { key: "adminOfficerName", label: "Admin Officer name", hint: "The administrative signatory, kept separate from the Operation Head.", placeholder: "Juan Dela Cruz" },
  { key: "adminOfficerPosition", label: "Admin Officer position", hint: "Printed beneath that signature.", placeholder: "Admin Officer" },
];

const FILING_FIELDS = [
  { key: "agencyRegion", label: "Region", hint: "Named in the subject line and the opening sentence.", placeholder: "Region 3" },
  { key: "agencyRcsuAddressee", label: "Addressed to", hint: 'The "TO:" line of the return.', placeholder: "C, RCSU 3" },
  { key: "agencyRcsuAttention", label: "Attention line", hint: "Printed beneath the addressee.", placeholder: "(Attn: C, SAGS)" },
];
// Both blocks save through the same PATCH, so they share one state object.
const ALL_SETTINGS_FIELDS = [...LETTERHEAD_FIELDS, ...SIGNATORY_FIELDS, ...FILING_FIELDS];
const EMPTY_LETTERHEAD = Object.fromEntries(ALL_SETTINGS_FIELDS.map((f) => [f.key, ""]));

// One renderer for both blocks. `type` is honoured so a date field gets a real
// date picker rather than free text — an LTO expiry typed as prose cannot be
// compared against today.
function SettingsFields({ fields, values, setValues }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
      {fields.map((f) => (
        <div className="form-field" key={f.key}>
          <label>{f.label}</label>
          <input
            type={f.type || "text"}
            value={values[f.key]}
            placeholder={f.placeholder}
            onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
          />
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{f.hint}</div>
        </div>
      ))}
    </div>
  );
}

export default function SystemSettingsPage() {
  // Whoever the matrix lets change settings, not whoever holds one role.
  const perm = useModulePerms();
  const { companyName, logoUrl, refresh } = useSettings();

  const [name, setName] = useState(companyName);
  const [letterhead, setLetterhead] = useState(EMPTY_LETTERHEAD);
  const [savingName, setSavingName] = useState(false);
  const [savingLetterhead, setSavingLetterhead] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  // Load the letterhead once. Also re-seeds the name field from the server, so
  // this screen doesn't show the context's placeholder if it hasn't loaded yet.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api("/settings")
      .then((s) => {
        if (cancelled) return;
        setName(s.companyName || "");
        setLetterhead(Object.fromEntries(ALL_SETTINGS_FIELDS.map((f) => [f.key, s[f.key] || ""])));
      })
      .catch(() => { /* keep whatever the context already gave us */ });
    return () => { cancelled = true; };
  }, [revision]);

  // Reached by anyone the matrix grants edit on `settings` — today Admin, the
  // Owner and the Security Admin Officer. The guard stays, for a direct URL.
  if (!perm.edit) {
    return (
      <div className="module-view">
        <ModuleHeader title="System Settings" subtitle="Company branding" actions={<button className="btn btn-outline btn-sm" onClick={() => { setRevision((r) => r + 1); refresh(); }}>Refresh</button>} />
        <div className="section-card" style={{ padding: 24 }}>
          You do not have permission to change company branding. An administrator can grant it in Manage Users.
        </div>
      </div>
    );
  }

  async function saveName() {
    if (!name.trim()) { setError("Company name is required."); return; }
    setSavingName(true);
    setError("");
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ companyName: name.trim() }) });
      await refresh();               // reflect immediately for this admin
      toast.success("Company name updated.");
    } catch (e) { setError(e.message); }
    finally { setSavingName(false); }
  }

  async function saveLetterhead() {
    if (!name.trim()) { setError("Company name is required."); return; }
    setSavingLetterhead(true);
    setError("");
    try {
      // The company name rides along because the endpoint requires it — the
      // letterhead is meaningless without the name it sits under.
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ companyName: name.trim(), ...letterhead }),
      });
      await refresh();
      toast.success("Letterhead updated. It applies to the next statement you generate.");
    } catch (e) { setError(e.message); }
    finally { setSavingLetterhead(false); }
  }

  async function uploadLogo(file) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await apiUpload("/settings/logo", file);
      await refresh();
      toast.success("Logo updated.");
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function removeLogo() {
    if (!await confirm("Remove the company logo and revert to the default mark?")) return;
    setError("");
    try {
      await api("/settings/logo", { method: "DELETE" });
      await refresh();
      toast.success("Logo removed.");
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="module-view">
      <ModuleHeader title="System Settings" subtitle="Company branding applied across all modules and reports" actions={<button className="btn btn-outline btn-sm" onClick={() => { setRevision((r) => r + 1); refresh(); }}>Refresh</button>} />
      <PurposeBar>Set the company name, logo, and letterhead shown across every module, PDF report, export, and client Statement of Account. Changes apply to you immediately and to everyone else on their next page load.</PurposeBar>
      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div className="section-card" style={{ padding: 24, marginBottom: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Company name</div>
        <div className="form-field" style={{ maxWidth: 480 }}>
          <label>Company name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brookside Farms Corporation" />
        </div>
        <button className="btn btn-gold" onClick={saveName} disabled={savingName} style={{ marginTop: 14 }}>
          {savingName ? "Saving\u2026" : "Save name"}
        </button>
      </div>

      <div className="section-card" style={{ padding: 24 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Company logo</div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <div style={{
            width: 96, height: 96, borderRadius: 12, background: "var(--navy)",
            display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0
          }}>
            {logoUrl
              ? <img src={logoUrl} alt="Company logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
              : <span style={{ color: "var(--gold)", fontSize: 12 }}>No logo</span>}
          </div>
          <div>
            <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 10, maxWidth: 360 }}>
              PNG or JPEG, up to 4MB. Used in the sidebar, module headers, and embedded in PDF reports.
            </div>
            <label className="btn btn-gold" style={{ cursor: "pointer" }}>
              {uploading ? "Uploading\u2026" : (logoUrl ? "Replace logo" : "Upload logo")}
              <input type="file" accept="image/png,image/jpeg" style={{ display: "none" }} disabled={uploading}
                onChange={(e) => { uploadLogo(e.target.files[0]); e.target.value = ""; }} />
            </label>
            {logoUrl && perm.delete && <button className="btn btn-danger" onClick={removeLogo} style={{ marginLeft: 10 }}>Remove</button>}
          </div>
        </div>
      </div>

      <div className="section-card" style={{ padding: 24, marginTop: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Letterhead</div>
        <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 18, maxWidth: 620 }}>
          Printed on client Statements of Account, beneath the company name and logo above.
          Leave a field blank to omit its line from the document.
        </div>
        <SettingsFields fields={LETTERHEAD_FIELDS} values={letterhead} setValues={setLetterhead} />
        <button className="btn btn-gold" onClick={saveLetterhead} disabled={savingLetterhead} style={{ marginTop: 18 }}>
          {savingLetterhead ? "Saving…" : "Save letterhead"}
        </button>
      </div>

      <div className="section-card" style={{ padding: 24, marginTop: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Signatories</div>
        <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 18, maxWidth: 620 }}>
          The two officers who sign agency documents. Every report that needs a signature reads these &mdash;
          nothing is hardcoded into an individual report. The <strong>Operation Head</strong> signs a Duty Detail
          Order; the <strong>Admin Officer</strong> is the administrative signatory.
        </div>
        <SettingsFields fields={SIGNATORY_FIELDS} values={letterhead} setValues={setLetterhead} />
        <button className="btn btn-gold" onClick={saveLetterhead} disabled={savingLetterhead} style={{ marginTop: 18 }}>
          {savingLetterhead ? "Saving…" : "Save signatories"}
        </button>
      </div>

      <div className="section-card" style={{ padding: 24, marginTop: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Statutory filing</div>
        <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 18, maxWidth: 620 }}>
          Where the Monthly Disposition Report is filed, and to whom. Every new return is pre-filled from these,
          so they are not re-typed each month &mdash; and each stays editable on the return itself for a month
          that goes to a different region. The subject line is composed from the region and the return's month,
          so it can never name a month the body and the certification disagree with.
        </div>
        <SettingsFields fields={FILING_FIELDS} values={letterhead} setValues={setLetterhead} />
        <button className="btn btn-gold" onClick={saveLetterhead} disabled={savingLetterhead} style={{ marginTop: 18 }}>
          {savingLetterhead ? "Saving…" : "Save filing details"}
        </button>
      </div>

      {/* Authorship and licence of the SOFTWARE. Deliberately separate from
          everything above it on this page, which is the CLIENT's branding —
          the agency's own name, logo and letterhead. These lines are fixed and
          are not configurable per client. */}
      <div className="section-card" style={{ padding: 24, marginTop: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>About</div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: "var(--text)", maxWidth: 760 }}>
          {ABOUT_TEXT}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 14 }}>
          The company name, logo and letterhead set on this page are your agency's branding and appear across
          the app and on every report. They are separate from the authorship above, which identifies the
          software itself.
        </div>
      </div>
    </div>
  );
}
