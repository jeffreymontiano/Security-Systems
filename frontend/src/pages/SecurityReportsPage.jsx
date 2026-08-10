import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import ConfidentialFooter from "../components/ConfidentialFooter";
import MdrDetail from "./MdrDetail";
import { mdrStatusBadgeClass, monthLabel, monthOptions, defaultPeriodMonth, shortDate } from "./mdrShared";

const SUBTITLE = "File the agency's statutory returns — starting with the Monthly Disposition Report to RCSU";

// The module is built to host more than one return. A tab strip with a single
// tab looks odd, so the strip renders only once there is a second report type
// to switch to; the shape is here so adding one is a list entry.
const TABS = [
  { key: "mdr", label: "Monthly Disposition Report" },
];

export default function SecurityReportsPage() {
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
  const [tab, setTab] = useState(TABS[0].key);
  // Bumped by the header Refresh; the MDR list lists it in its load effect.
  const [revision, setRevision] = useState(0);

  return (
    <div className="module-view">
      <ModuleHeader icon="🗂" iconBg="var(--gold)" title="Security Reports" subtitle={SUBTITLE} actions={<button className="btn btn-outline btn-sm" onClick={() => setRevision((r) => r + 1)}>Refresh</button>} />
      <PurposeBar>
        The Monthly Disposition Report is the monthly return filed with the Regional Civil Security Unit under
        RA 11917 &mdash; the agency's clients in the region, the guards posted there under their LESP licences,
        the firearms deployed, the officers, and the month's gains and losses.
      </PurposeBar>

      {TABS.length > 1 && (
        <div className="tabs" style={{ margin: "18px 32px 0" }}>
          {TABS.map((t) => (
            <button key={t.key} className={`tab-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "mdr" && <MdrList isViewer={isViewer} canAdd={perm.add} revision={revision} />}

      <ConfidentialFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MdrList({ isViewer, canAdd = false, revision }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = [];
      if (year) qs.push(`year=${encodeURIComponent(year)}`);
      if (status) qs.push(`status=${encodeURIComponent(status)}`);
      setRows(await api(`/security-reports/mdr${qs.length ? "?" + qs.join("&") : ""}`));
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [year, status]);

  useEffect(() => { load(); }, [load, revision]);

  const years = [...new Set(rows.map((r) => String(r.periodMonth || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const thisYear = String(new Date().getFullYear());
  const yearOptions = [...new Set([thisYear, String(Number(thisYear) - 1), ...years])].sort().reverse();

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>
            {yearOptions.map((y) => <option key={y}>{y}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option>Draft</option>
            <option>Finalised</option>
            <option>Submitted</option>
          </select>
        </div>
        {/* .toolbar is already justify-content:space-between, so a second child
            sits right without a class of its own. */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn btn-outline btn-sm" onClick={load}>Refresh</button>
          {canAdd && <button className="btn btn-gold" onClick={() => setCreating(true)}>+ New MDR</button>}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">Monthly Disposition Reports</div>
        <table>
          <thead>
            <tr>
              <th>Month</th><th>Region</th><th>To</th>
              <th style={{ textAlign: "right" }}>Clients</th>
              <th style={{ textAlign: "right" }}>Guards</th>
              <th style={{ textAlign: "right" }}>Firearms</th>
              <th>Status</th><th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {loadError && <tr><td colSpan={8}><div className="empty-hint">{loadError}</div></td></tr>}
            {!loadError && loading && <tr><td colSpan={8}><div className="empty-hint">Loading…</div></td></tr>}
            {!loadError && !loading && rows.length === 0 && (
              <tr><td colSpan={8}><div className="empty-hint">
                No Monthly Disposition Reports yet.{!isViewer && " Press “+ New MDR” to start the month's return."}
              </div></td></tr>
            )}
            {!loadError && !loading && rows.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ cursor: "pointer" }}>
                <td data-label="Month"><strong>{r.monthLabel || monthLabel(r.periodMonth)}</strong></td>
                <td data-label="Region">{r.region || "—"}</td>
                <td data-label="To">{r.addressee || "—"}</td>
                <td data-label="Clients" style={{ textAlign: "right" }}>{r.clientCount}</td>
                <td data-label="Guards" style={{ textAlign: "right" }}>{r.guardCount}</td>
                <td data-label="Firearms" style={{ textAlign: "right" }}>{r.firearmCount}</td>
                <td data-label="Status"><span className={`badge ${mdrStatusBadgeClass(r.status)}`}>{r.status}</span></td>
                <td data-label="Submitted">{r.submittedDate ? shortDate(r.submittedDate) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewMdrModal
          existing={rows}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await load(); setOpenId(id); }}
          onOpenExisting={(id) => { setCreating(false); setOpenId(id); }}
        />
      )}

      {openId && (
        <MdrDetail
          reportId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onDeleted={async () => { setOpenId(null); await load(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function NewMdrModal({ existing, onClose, onCreated, onOpenExisting }) {
  const [periodMonth, setPeriodMonth] = useState(defaultPeriodMonth());
  const [region, setRegion] = useState("");
  const [carryForward, setCarryForward] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clash, setClash] = useState(null);

  // The region defaults from System Settings so it is not typed each month.
  useEffect(() => {
    api("/settings").then((s) => setRegion(s.agencyRegion || "")).catch(() => {});
  }, []);

  async function create() {
    setSaving(true);
    setError("");
    setClash(null);
    try {
      const res = await api("/security-reports/mdr", {
        method: "POST",
        body: JSON.stringify({ periodMonth, region, carryForward }),
      });
      onCreated(res.id);
    } catch (e) {
      setError(e.message);
      // One return per month per region. The API says which one already exists,
      // so offer to open it rather than leaving the user stuck.
      if (e.body && e.body.existingId) setClash(e.body.existingId);
    } finally {
      setSaving(false);
    }
  }

  const prior = existing.find((r) => r.periodMonth === periodMonth && r.region === region);

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Monthly Disposition Report</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="empty-hint" style={{ color: "var(--danger)", marginBottom: 14 }}>
              {error}
              {clash && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => onOpenExisting(clash)}>
                    Open the existing return
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="form-grid">
            <div className="form-field">
              <label>Report month</label>
              <select value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}>
                {monthOptions().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                Drives the subject line, the certification and the filename — so they can never disagree.
              </div>
            </div>
            <div className="form-field">
              <label>Region</label>
              <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Region 3" />
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
                From System Settings. Change it only when filing for a different region.
              </div>
            </div>
          </div>

          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", marginTop: 16, fontSize: 13 }}>
            <input type="checkbox" checked={carryForward} onChange={(e) => setCarryForward(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Carry forward last month's officers and client blocks.
              <span style={{ color: "var(--text-mute)" }}>
                {" "}Guards are never carried forward — who was posted is pulled fresh from the records.
              </span>
            </span>
          </label>

          {prior && (
            <div className="empty-hint" style={{ marginTop: 14 }}>
              A return for {monthLabel(periodMonth)} in {region} already exists.
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={create} disabled={saving || !periodMonth}>
            {saving ? "Creating…" : "Create return"}
          </button>
        </div>
      </div>
    </div>
  );
}
