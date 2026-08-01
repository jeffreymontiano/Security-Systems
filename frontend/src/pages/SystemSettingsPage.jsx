import { useState } from "react";
import { api, apiUpload } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";

export default function SystemSettingsPage() {
  const { isAdmin } = useAuth();
  const { companyName, logoUrl, refresh } = useSettings();

  const [name, setName] = useState(companyName);
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

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
      <PurposeBar>Set the company name and logo shown across every module, PDF report, and export. Changes apply to you immediately and to everyone else on their next page load.</PurposeBar>

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
    </div>
  );
}
