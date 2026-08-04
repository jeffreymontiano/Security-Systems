import { useEffect, useState } from "react";
import { api, apiUpload } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";

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
];
const EMPTY_LETTERHEAD = Object.fromEntries(LETTERHEAD_FIELDS.map((f) => [f.key, ""]));

export default function SystemSettingsPage() {
  const { isAdmin } = useAuth();
  const { companyName, logoUrl, refresh } = useSettings();

  const [name, setName] = useState(companyName);
  const [letterhead, setLetterhead] = useState(EMPTY_LETTERHEAD);
  const [savingName, setSavingName] = useState(false);
  const [savingLetterhead, setSavingLetterhead] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // Load the letterhead once. Also re-seeds the name field from the server, so
  // this screen doesn't show the context's placeholder if it hasn't loaded yet.
  useEffect(() => {
    let cancelled = false;
    api("/settings")
      .then((s) => {
        if (cancelled) return;
        setName(s.companyName || "");
        setLetterhead(Object.fromEntries(LETTERHEAD_FIELDS.map((f) => [f.key, s[f.key] || ""])));
      })
      .catch(() => { /* keep whatever the context already gave us */ });
    return () => { cancelled = true; };
  }, []);

  // Non-admins never reach here (route + nav are adminOnly), but guard anyway.
  if (!isAdmin) {
    return (
      <div className="module-view">
        <ModuleHeader title="System Settings" subtitle="Company branding" />
        <div className="section-card" style={{ padding: 24 }}>
          Only an administrator can change company branding.
        </div>
      </div>
    );
  }

  function flash(setter, text) {
    setter(text);
    setTimeout(() => setter(""), 4000);
  }

  async function saveName() {
    if (!name.trim()) { setError("Company name is required."); return; }
    setSavingName(true);
    setError("");
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ companyName: name.trim() }) });
      await refresh();               // reflect immediately for this admin
      flash(setMsg, "Company name updated.");
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
      flash(setMsg, "Letterhead updated. It applies to the next statement you generate.");
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
      flash(setMsg, "Logo updated.");
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function removeLogo() {
    if (!window.confirm("Remove the company logo and revert to the default mark?")) return;
    setError("");
    try {
      await api("/settings/logo", { method: "DELETE" });
      await refresh();
      flash(setMsg, "Logo removed.");
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="module-view">
      <ModuleHeader title="System Settings" subtitle="Company branding applied across all modules and reports" />
      <PurposeBar>Set the company name, logo, and letterhead shown across every module, PDF report, export, and client Statement of Account. Changes apply to you immediately and to everyone else on their next page load.</PurposeBar>

      {msg && <div className="purpose-bar" style={{ background: "var(--teal-bg)", borderColor: "#bfe6d8", color: "var(--teal)" }}>{msg}</div>}
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
            {logoUrl && <button className="btn btn-danger" onClick={removeLogo} style={{ marginLeft: 10 }}>Remove</button>}
          </div>
        </div>
      </div>

      <div className="section-card" style={{ padding: 24, marginTop: 16 }}>
        <div className="section-head" style={{ margin: "-24px -24px 20px" }}>Letterhead</div>
        <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 18, maxWidth: 620 }}>
          Printed on client Statements of Account, beneath the company name and logo above.
          Leave a field blank to omit its line from the document.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {LETTERHEAD_FIELDS.map((f) => (
            <div className="form-field" key={f.key}>
              <label>{f.label}</label>
              <input
                type="text"
                value={letterhead[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setLetterhead((s) => ({ ...s, [f.key]: e.target.value }))}
              />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{f.hint}</div>
            </div>
          ))}
        </div>
        <button className="btn btn-gold" onClick={saveLetterhead} disabled={savingLetterhead} style={{ marginTop: 18 }}>
          {savingLetterhead ? "Saving…" : "Save letterhead"}
        </button>
      </div>
    </div>
  );
}
