import { useCallback, useEffect, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import { useAuth } from "../context/AuthContext";
import {
  mdrStatusBadgeClass, severityBadgeClass, monthLabel, shortDate,
  RANKS, FIREARM_CLASSES, isEditable,
} from "./mdrShared";

// The Monthly Disposition Report, laid out in the reference return's own order:
// letterhead details, then sections 1-5, then the certification and signatures.
//
// Sections 1 and 3 are rendered READ-ONLY and labelled as computed. They are
// counts over the return's own body and are derived on the server; an editable
// summary is how a document ends up disagreeing with itself.
//
// Nothing here decides whether the return can be filed. `issues` and `verdict`
// arrive from the server's engine and are displayed as given.
export default function MdrDetail({ reportId, onClose, onChanged, onDeleted }) {
  const { isViewer, isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api(`/security-reports/mdr/${reportId}`));
      setError("");
    } catch (e) { setError(e.message); }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  // Every mutation goes through here: one place to show a failure, one place to
  // reload, and one place that keeps the list in step.
  const act = useCallback(async (label, path, opts) => {
    setBusy(label);
    setError("");
    try {
      await api(`/security-reports${path}`, opts);
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally { setBusy(""); }
  }, [load, onChanged]);

  if (!data) {
    return (
      <div className="modal-overlay active" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header"><h2>Loading…</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
          <div className="modal-body">{error || "Loading the return…"}</div>
        </div>
      </div>
    );
  }

  const { report, clients, officers, movements, section1, section3, issues, verdict } = data;
  const editable = isEditable(report) && !isViewer;

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal modal-xl" style={{ maxWidth: 1180 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span>Monthly Disposition Report &mdash; {report.monthLabel || monthLabel(report.periodMonth)}</span>
            <span className={`badge ${mdrStatusBadgeClass(report.status)}`}>{report.status}</span>
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="empty-hint" style={{ color: "var(--danger)", marginBottom: 14 }}>{error}</div>}

          {!editable && report.status !== "Draft" && (
            <div className="empty-hint" style={{ marginBottom: 16 }}>
              This return is <strong>{report.status}</strong> and frozen &mdash; what it says is what was filed.
              {report.status === "Finalised" && isAdmin && " Reopen it to make a correction."}
              {report.status === "Submitted" && " A submitted return cannot be reopened; file an amended return instead."}
            </div>
          )}

          <Findings issues={issues} verdict={verdict} report={report} />
          <Header report={report} editable={editable} act={act} />
          <Section1 section1={section1} />
          <Section2 clients={clients} report={report} editable={editable} act={act} />
          <Section3 section3={section3} />
          <Section4 officers={officers} editable={editable} act={act} reportId={report.id} />
          <Section5 movements={movements} editable={editable} act={act} reportId={report.id} />
          <Certification report={report} editable={editable} act={act} />
        </div>

        <div className="modal-footer">
          {/* Left group. One `marginRight: auto` on the WRAPPER, not on each
              button — two of them would spread the buttons apart instead of
              pushing the pair left. */}
          <div style={{ display: "flex", gap: 8, marginRight: "auto" }}>
          {isAdmin && report.status === "Draft" && (
            <button
              className="btn btn-danger"
              disabled={!!busy}
              onClick={async () => {
                if (!await confirm("Delete this draft return and everything on it?")) return;
                setBusy("delete");
                try {
                  await api(`/security-reports/mdr/${report.id}`, { method: "DELETE" });
                  onDeleted?.();
                } catch (e) { setError(e.message); setBusy(""); }
              }}
            >Delete draft</button>
          )}
          <DownloadButton report={report} setError={setError} />
          </div>
          <WorkflowButtons report={report} verdict={verdict} isAdmin={isAdmin} busy={busy} act={act} />
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// The PDF sits behind requireAuth, so it must be fetched with the bearer token
// and handed to the browser as a blob. window.open cannot attach the token and
// would come back 401.
function DownloadButton({ report, setError }) {
  const [busy, setBusy] = useState(false);
  const name = `MDR-${(report.region || "region").replace(/[^A-Za-z0-9]+/g, "-")}-${(report.monthLabel || report.periodMonth).replace(/\s+/g, "")}.pdf`;
  return (
    <button
      className="btn btn-outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setError("");
        try {
          downloadBlobUrl(await apiBlobUrl(`/security-reports/mdr/${report.id}/mdr.pdf`), name);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }}
    >
      {busy ? "Preparing…" : report.status === "Draft" ? "Download draft PDF" : "Download PDF"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

function WorkflowButtons({ report, verdict, isAdmin, busy, act }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  if (!isAdmin) return null;

  if (report.status === "Draft") {
    // The verdict shown here is the same one the finalise route will reach, so
    // the button's state and the outcome cannot differ.
    const blocked = verdict.blocking.length > 0;
    return (
      <>
        {asking && (
          <OverrideModal
            advisory={verdict.advisory}
            reason={reason}
            setReason={setReason}
            onCancel={() => { setAsking(false); setReason(""); }}
            onConfirm={async () => {
              const ok = await act("finalise", `/mdr/${report.id}/finalise`, {
                method: "PATCH", body: JSON.stringify({ overrideReason: reason }),
              });
              if (ok) { setAsking(false); setReason(""); }
            }}
            busy={busy === "finalise"}
          />
        )}
        <button
          className="btn btn-gold"
          disabled={blocked || !!busy}
          title={blocked ? "Correct the blocking findings above first." : ""}
          onClick={() => {
            if (verdict.advisory.length) { setAsking(true); return; }
            act("finalise", `/mdr/${report.id}/finalise`, { method: "PATCH", body: JSON.stringify({}) });
          }}
        >
          {busy === "finalise" ? "Finalising…" : "Finalise"}
        </button>
      </>
    );
  }

  if (report.status === "Finalised") {
    return (
      <>
        <button className="btn btn-secondary" disabled={!!busy}
          onClick={() => act("reopen", `/mdr/${report.id}/reopen`, { method: "PATCH" })}>
          {busy === "reopen" ? "Reopening…" : "Reopen"}
        </button>
        <button className="btn btn-gold" disabled={!!busy}
          onClick={() => act("submit", `/mdr/${report.id}/submit`, { method: "PATCH", body: JSON.stringify({}) })}>
          {busy === "submit" ? "Recording…" : "Mark submitted"}
        </button>
      </>
    );
  }
  return null;
}

// Finalising over outstanding administrative findings needs a reason, and the
// findings being waived are shown so the reason is written against something.
function OverrideModal({ advisory, reason, setReason, onCancel, onConfirm, busy }) {
  return (
    <div className="modal-overlay active" style={{ zIndex: 1200 }} onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>File with {advisory.length} outstanding {advisory.length === 1 ? "finding" : "findings"}?</h2>
          <button className="modal-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: "var(--text-mute)", marginBottom: 14 }}>
            These are administrative gaps, not legal defects, so the return can still be filed. The reason and
            the exact findings below are recorded on it, so the record shows what was filed knowingly.
          </div>
          <ul style={{ fontSize: 12.5, lineHeight: 1.7, margin: "0 0 16px", paddingLeft: 20 }}>
            {advisory.map((i, n) => <li key={n}>{i.message}</li>)}
          </ul>
          <div className="form-field">
            <label>Reason for filing as it stands</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. LESP renewal for two guards lodged with SOSIA on 12 Feb; receipts on file."
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-gold" disabled={!reason.trim() || busy} onClick={onConfirm}>
            {busy ? "Finalising…" : "Finalise anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function Findings({ issues, verdict, report }) {
  const blocking = issues.filter((i) => i.severity === "blocking");
  const advisory = issues.filter((i) => i.severity !== "blocking");

  if (report.overrideReason) {
    return (
      <div className="section-card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Filed with a recorded exception</div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>{report.overrideReason}</div>
        {Array.isArray(report.overrideIssuesJson) && report.overrideIssuesJson.length > 0 && (
          <ul style={{ fontSize: 12, color: "var(--text-mute)", lineHeight: 1.7, margin: 0, paddingLeft: 20 }}>
            {report.overrideIssuesJson.map((i, n) => <li key={n}>{i.message}</li>)}
          </ul>
        )}
      </div>
    );
  }

  if (!issues.length) {
    return (
      <div className="empty-hint" style={{ marginBottom: 16 }}>
        Nothing outstanding on this return.
      </div>
    );
  }

  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">
        Findings &mdash; {blocking.length} blocking, {advisory.length} advisory
      </div>
      <div style={{ padding: "14px 18px" }}>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)", marginBottom: 12 }}>
          {blocking.length > 0
            ? "Blocking findings are legal or data-integrity defects and must be corrected before the return can be finalised."
            : "Advisory findings can be filed over with a recorded reason."}
        </div>
        {[...blocking, ...advisory].map((i, n) => (
          <div key={n} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "5px 0", fontSize: 13 }}>
            <span className={`badge ${severityBadgeClass(i.severity)}`} style={{ flexShrink: 0 }}>
              {i.severity === "blocking" ? "Blocking" : "Advisory"}
            </span>
            <span>{i.message}</span>
          </div>
        ))}
        {verdict.code === "override-required" && (
          <div style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 12 }}>
            Finalising will ask for a reason.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — addressee, region, dates, all pre-filled from System Settings
// ---------------------------------------------------------------------------

function Header({ report, editable, act }) {
  const [form, setForm] = useState({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setForm({
      addressee: report.addressee || "", attention: report.attention || "",
      region: report.region || "", reportDate: report.reportDate || "",
      periodMonth: report.periodMonth || "",
    });
    setDirty(false);
  }, [report]);

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setDirty(true); };

  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">Addressee &amp; filing details</div>
      <div style={{ padding: 18 }}>
        {/* Not editable, and deliberately so: composed from the region and the
            month, which is what stops it naming a month the body and the
            certification disagree with. */}
        <div style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.7 }}>
          <div><strong>Subject:</strong> {report.subject}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
            Composed from the region and the report month &mdash; not typed, so it always matches the body and
            the certification.
          </div>
        </div>

        <div className="form-grid">
          <Field label="To" value={form.addressee} onChange={set("addressee")} editable={editable} placeholder="C, RCSU 3" />
          <Field label="Attention" value={form.attention} onChange={set("attention")} editable={editable} placeholder="(Attn: C, SAGS)" />
          <Field label="Region" value={form.region} onChange={set("region")} editable={editable} placeholder="Region 3" />
          <Field label="Date of report" value={form.reportDate} onChange={set("reportDate")} editable={editable} type="date" />
        </div>

        {editable && dirty && (
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 14 }}
            onClick={() => act("header", `/mdr/${report.id}`, { method: "PATCH", body: JSON.stringify(form) })}>
            Save filing details
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, editable, type = "text", placeholder, hint }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {editable
        ? <input type={type} value={value || ""} onChange={onChange} placeholder={placeholder} />
        : <div style={{ fontSize: 13.5, padding: "4px 0" }}>{(type === "date" ? shortDate(value) : value) || "—"}</div>}
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Firearms deployed per province — DERIVED
// ---------------------------------------------------------------------------

function Section1({ section1 }) {
  return (
    <div className="section-card sticky-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">1. Number of Firearms Deployed in Provinces</div>
      <Computed />
      <table>
        <thead>
          <tr><th>Province</th><th>Small Arms</th><th>Light Weapons</th></tr>
        </thead>
        <tbody>
          {section1.rows.length === 0 && (
            <tr><td colSpan={3}><div className="empty-hint">No firearms reported.</div></td></tr>
          )}
          {section1.rows.map((r) => (
            <tr key={r.province}>
              <td data-label="Province">{r.province}</td>
              <td data-label="Small Arms">{r.smallArms || "—"}</td>
              <td data-label="Light Weapons">{r.lightWeapons || "—"}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700 }}>
            <td data-label="">TOTAL</td>
            <td data-label="Small Arms">{section1.total.smallArms}</td>
            <td data-label="Light Weapons">{section1.total.lightWeapons}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Computed() {
  return (
    <div style={{ padding: "12px 18px 0", fontSize: 11.5, color: "var(--text-mute)" }}>
      Computed from the guards and firearms listed in section 2 &mdash; not stored, so this can never disagree
      with the body of the return.
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Disposition of clients, guards and firearms
// ---------------------------------------------------------------------------

function Section2({ clients, report, editable, act }) {
  const [adding, setAdding] = useState(false);
  const [detachments, setDetachments] = useState([]);

  useEffect(() => {
    if (!editable) return;
    api("/security-reports/mdr/lookup/detachments").then(setDetachments).catch(() => setDetachments([]));
  }, [editable]);

  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">2. Disposition of Clients, Guards and Firearms</div>
      <div style={{ padding: 18 }}>
        {clients.length === 0 && (
          <div className="empty-hint" style={{ marginBottom: editable ? 14 : 0 }}>
            No clients on this return yet.{editable && " Add a client block, then pull its guards from the records."}
          </div>
        )}

        {clients.map((c) => (
          <ClientBlock key={c.id} client={c} editable={editable} act={act} reportId={report.id} />
        ))}

        {editable && (
          adding
            ? <AddClient detachments={detachments} reportId={report.id} act={act} onDone={() => setAdding(false)} />
            : <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>+ Add client block</button>
        )}
      </div>
    </div>
  );
}

function AddClient({ detachments, reportId, act, onDone }) {
  const [billingSiteId, setBillingSiteId] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [province, setProvince] = useState("");

  return (
    <div className="section-card" style={{ padding: 16, marginTop: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Add a client block</div>
      <div className="form-grid">
        <div className="form-field">
          <label>Detachment</label>
          <select value={billingSiteId} onChange={(e) => setBillingSiteId(e.target.value)}>
            <option value="">— Type the client by hand —</option>
            {detachments.map((d) => (
              <option key={d.id} value={d.id}>{d.detachmentName || d.clientName} ({d.site})</option>
            ))}
          </select>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
            Linking a detachment lets the guards be pulled from the records. Name and address prefill from it.
          </div>
        </div>
        <div className="form-field">
          <label>Province</label>
          <input value={province} onChange={(e) => setProvince(e.target.value)} placeholder="Bulacan" />
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
            Sections 1 and 3 group by province.
          </div>
        </div>
        <div className="form-field">
          <label>Client name {billingSiteId && <span style={{ color: "var(--text-mute)" }}>(optional)</span>}</label>
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Address {billingSiteId && <span style={{ color: "var(--text-mute)" }}>(optional)</span>}</label>
          <input value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="btn btn-secondary btn-sm" onClick={onDone}>Cancel</button>
        <button className="btn btn-gold btn-sm"
          disabled={!billingSiteId && !clientName.trim()}
          onClick={async () => {
            const ok = await act("add-client", `/mdr/${reportId}/clients`, {
              method: "POST",
              body: JSON.stringify({
                billingSiteId: billingSiteId || null,
                clientName, clientAddress, province,
              }),
            });
            if (ok) onDone();
          }}>Add block</button>
      </div>
    </div>
  );
}

function ClientBlock({ client, editable, act, reportId }) {
  const [addingGuard, setAddingGuard] = useState(false);
  const cols = 9;

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        gap: 12, flexWrap: "wrap", marginBottom: 8,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{client.clientName || "(unnamed client)"}</div>
          <div style={{ fontSize: 12, color: "var(--text-mute)" }}>
            {client.clientAddress || "no address"}
            {" · "}
            {client.province
              ? client.province
              : <span style={{ color: "var(--danger)" }}>no province set</span>}
            {" · "}{client.personnel.length} {client.personnel.length === 1 ? "guard" : "guards"}
          </div>
        </div>
        {editable && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {client.billingSiteId && (
              <button className="btn btn-secondary btn-sm"
                onClick={() => act("pull", `/mdr/clients/${client.id}/from-records`, { method: "POST" })}>
                Pull guards from records
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => setAddingGuard(true)}>+ Add guard</button>
            <button className="btn btn-danger btn-sm"
              onClick={async () => {
                if (!await confirm(`Remove ${client.clientName} and its guards from this return?`)) return;
                act("del-client", `/mdr/clients/${client.id}`, { method: "DELETE" });
              }}>Remove</button>
          </div>
        )}
      </div>

      {/* A licence number and a serial number are fixed-format identifiers: a
          line break inside one turns "R03-202212000347" into two half numbers
          and makes the value unreadable at a glance. They are set nowrap and
          the whole table scrolls sideways instead — the same rule the DDO's
          PDF columns follow. Guard names may wrap; they are prose. */}
      <div className="section-card sticky-card" style={{ padding: 0, margin: 0, overflowX: "auto" }}>
        <table style={{ minWidth: 1010 }}>
          <thead>
            <tr>
              <th style={{ width: 38 }} title="Running number across the whole return">No.</th>
              <th style={{ width: 38 }} title="Number within this client block">No.</th>
              <th style={{ width: 52 }}>Rank</th>
              <th style={{ minWidth: 168 }}>Name of Security Guard</th>
              <th style={{ whiteSpace: "nowrap" }}>Licence Number</th>
              <th style={{ whiteSpace: "nowrap" }}>Expiry Date</th>
              <th>Make</th>
              <th>Kind</th>
              <th style={{ whiteSpace: "nowrap" }}>Serial Number</th>
              <th style={{ whiteSpace: "nowrap" }}>Expiry Date</th>
              {editable && <th style={{ width: 118 }} />}
            </tr>
          </thead>
          <tbody>
            {client.personnel.length === 0 && (
              <tr><td colSpan={cols + (editable ? 2 : 1)}>
                <div className="empty-hint">No guards listed for this client.</div>
              </td></tr>
            )}
            {client.personnel.map((p) => (
              <GuardRows key={p.id} p={p} editable={editable} act={act} reportId={reportId} />
            ))}
          </tbody>
        </table>
      </div>

      {addingGuard && editable && (
        <AddGuard clientId={client.id} reportId={reportId} act={act} onDone={() => setAddingGuard(false)} />
      )}
    </div>
  );
}

// Identifier columns never break mid-value.
const NOWRAP = { whiteSpace: "nowrap" };

// One guard row, plus a continuation row for each firearm beyond the first —
// which is how a guard holding both a pistol and a shotgun prints.
function GuardRows({ p, editable, act, reportId }) {
  const [editing, setEditing] = useState(false);
  const [addingFa, setAddingFa] = useState(false);
  const fas = p.firearms.length ? p.firearms : [null];

  if (editing) {
    return (
      <tr>
        <td colSpan={editable ? 11 : 10}>
          <EditGuard p={p} act={act} onDone={() => setEditing(false)} />
        </td>
      </tr>
    );
  }

  return (
    <>
      {fas.map((f, i) => (
        <tr key={f ? f.id : "none"}>
          <td data-label="No.">{i === 0 ? p.runningNo : ""}</td>
          <td data-label="No.">{i === 0 ? p.lineNo : ""}</td>
          <td data-label="Rank">{i === 0 ? p.rank : ""}</td>
          <td data-label="Guard">{i === 0 ? (p.guardName || "—") : ""}</td>
          <td data-label="Licence" style={NOWRAP}>{i === 0 ? (p.licenceNo || "—") : ""}</td>
          <td data-label="Expiry" style={NOWRAP}>{i === 0 ? (p.licenceExpiry || "—") : ""}</td>
          <td data-label="Make">{f ? (f.make || "—") : ""}</td>
          <td data-label="Kind">{f ? (f.kind || "—") : ""}</td>
          <td data-label="Serial" style={NOWRAP}>{f ? (f.serialNo || "—") : ""}</td>
          <td data-label="Expiry" style={NOWRAP}>{f ? (f.licenceExpiry || "—") : ""}</td>
          {editable && (
            <td data-label="" style={{ whiteSpace: "nowrap" }}>
              {i === 0 && (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Edit</button>{" "}
                  <button className="btn btn-secondary btn-sm" onClick={() => setAddingFa(true)}>+ FA</button>{" "}
                  <button className="btn btn-danger btn-sm"
                    onClick={() => act("del-guard", `/mdr/personnel/${p.id}`, { method: "DELETE" })}>Remove</button>
                </>
              )}
              {f && (
                <button className="btn btn-danger btn-sm" style={{ marginLeft: i === 0 ? 6 : 0 }}
                  title="Remove this firearm"
                  onClick={() => act("del-fa", `/mdr/firearms/${f.id}`, { method: "DELETE" })}>&minus; FA</button>
              )}
            </td>
          )}
        </tr>
      ))}
      {addingFa && (
        <tr><td colSpan={11}>
          <AddFirearm personnelId={p.id} act={act} onDone={() => setAddingFa(false)} reportId={reportId} />
        </td></tr>
      )}
    </>
  );
}

function EditGuard({ p, act, onDone }) {
  const [f, setF] = useState({
    guardName: p.guardName || "", rank: p.rank || "SG",
    licenceNo: p.licenceNo || "", licenceExpiry: p.licenceExpiry || "",
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div style={{ padding: "8px 2px" }}>
      <div className="form-grid">
        <div className="form-field">
          <label>Name of security guard</label>
          <input value={f.guardName} onChange={set("guardName")} />
        </div>
        <div className="form-field">
          <label>Rank</label>
          <input value={f.rank} onChange={set("rank")} list="mdr-ranks" placeholder="SG" />
          <datalist id="mdr-ranks">{RANKS.map((r) => <option key={r} value={r} />)}</datalist>
        </div>
        <div className="form-field">
          <label>LESP number</label>
          <input value={f.licenceNo} onChange={set("licenceNo")} />
        </div>
        <div className="form-field">
          <label>LESP expiry</label>
          <input type="date" value={f.licenceExpiry} onChange={set("licenceExpiry")} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" onClick={onDone}>Cancel</button>
        <button className="btn btn-gold btn-sm" onClick={async () => {
          const ok = await act("edit-guard", `/mdr/personnel/${p.id}`, { method: "PATCH", body: JSON.stringify(f) });
          if (ok) onDone();
        }}>Save guard</button>
      </div>
    </div>
  );
}

function AddGuard({ clientId, reportId, act, onDone }) {
  const [f, setF] = useState({ guardName: "", rank: "SG", licenceNo: "", licenceExpiry: "" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div className="section-card" style={{ padding: 16, marginTop: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Add a guard by hand</div>
      <div className="form-grid">
        <div className="form-field"><label>Name of security guard</label><input value={f.guardName} onChange={set("guardName")} /></div>
        <div className="form-field">
          <label>Rank</label>
          <input value={f.rank} onChange={set("rank")} list="mdr-ranks" />
        </div>
        <div className="form-field"><label>LESP number</label><input value={f.licenceNo} onChange={set("licenceNo")} /></div>
        <div className="form-field"><label>LESP expiry</label><input type="date" value={f.licenceExpiry} onChange={set("licenceExpiry")} /></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" onClick={onDone}>Cancel</button>
        <button className="btn btn-gold btn-sm" disabled={!f.guardName.trim()} onClick={async () => {
          const ok = await act("add-guard", `/mdr/${reportId}/personnel`, {
            method: "POST", body: JSON.stringify({ ...f, clientId }),
          });
          if (ok) onDone();
        }}>Add guard</button>
      </div>
    </div>
  );
}

function AddFirearm({ personnelId, act, onDone }) {
  const [firearms, setFirearms] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [f, setF] = useState({ make: "", kind: "", serialNo: "", licenceExpiry: "", firearmClass: "" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Firearms come from the asset register, so a return cannot name something
  // the agency does not own. The DDO's own endpoint already serves exactly this
  // list, filtered to firearms that are neither Retired nor Lost.
  useEffect(() => { api("/ddo/firearms").then(setFirearms).catch(() => setFirearms([])); }, []);

  return (
    <div style={{ padding: "10px 2px" }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Add a firearm to this guard</div>
      <div className="form-grid">
        <div className="form-field">
          <label>From the asset register</label>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">— Enter the particulars by hand —</option>
            {firearms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.assetTag} · {a.brand || a.name} {a.caliber || ""} {a.serialNumber ? `· ${a.serialNumber}` : ""}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 4 }}>
            Picking one fills the make, kind, serial and licence expiry from the register.
          </div>
        </div>
        <div className="form-field">
          <label>Class</label>
          <select value={f.firearmClass} onChange={set("firearmClass")}>
            <option value="">Derive from the calibre</option>
            {FIREARM_CLASSES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        {!assetId && (
          <>
            <div className="form-field"><label>Make</label><input value={f.make} onChange={set("make")} placeholder="Armscor" /></div>
            <div className="form-field"><label>Kind</label><input value={f.kind} onChange={set("kind")} placeholder="9MM" /></div>
            <div className="form-field"><label>Serial number</label><input value={f.serialNo} onChange={set("serialNo")} /></div>
            <div className="form-field"><label>Licence expiry</label><input type="date" value={f.licenceExpiry} onChange={set("licenceExpiry")} /></div>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" onClick={onDone}>Cancel</button>
        <button className="btn btn-gold btn-sm"
          disabled={!assetId && !f.serialNo.trim()}
          onClick={async () => {
            const ok = await act("add-fa", `/mdr/personnel/${personnelId}/firearms`, {
              method: "POST", body: JSON.stringify({ assetId: assetId || null, ...f }),
            });
            if (ok) onDone();
          }}>Add firearm</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Recapitulation — DERIVED
// ---------------------------------------------------------------------------

function Section3({ section3 }) {
  const { provinces, rows, distinctGuards } = section3;
  const mismatch = distinctGuards && distinctGuards.total !== rows[0].total;
  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">3. Recapitulation</div>
      <Computed />
      <table>
        <thead>
          <tr>
            <th>Deployed</th>
            {provinces.map((p) => <th key={p} style={{ textAlign: "right" }}>{p.toUpperCase()}</th>)}
            <th style={{ textAlign: "right" }}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {provinces.length === 0 && (
            <tr><td colSpan={2}><div className="empty-hint">No clients on this return yet.</div></td></tr>
          )}
          {provinces.length > 0 && rows.map((r) => (
            <tr key={r.label}>
              <td data-label="">{r.label}</td>
              {provinces.map((p) => <td key={p} data-label={p} style={{ textAlign: "right" }}>{r.byProvince[p]}</td>)}
              <td data-label="TOTAL" style={{ textAlign: "right", fontWeight: 700 }}>{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {mismatch && (
        <div style={{ padding: "12px 18px", fontSize: 12, color: "var(--text-mute)" }}>
          {rows[0].total} postings across {distinctGuards.total} distinct guards &mdash; someone is reported at
          two posts. Ordinary for a mid-month transfer; both figures are shown rather than one being chosen.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Officers
// ---------------------------------------------------------------------------

const OFFICER_FIELDS = [
  ["name", "Name of officer / staff"],
  ["designation", "Designation"],
  ["homeAddress", "Home address"],
  ["contactNumbers", "Contact numbers"],
];

function Section4({ officers, editable, act, reportId }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">4. List of officers and their respective designation</div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }}>No.</th>
            {OFFICER_FIELDS.map(([, l]) => <th key={l}>{l}</th>)}
            {editable && <th style={{ width: 90 }} />}
          </tr>
        </thead>
        <tbody>
          {officers.length === 0 && (
            <tr><td colSpan={editable ? 6 : 5}><div className="empty-hint">No officers listed.</div></td></tr>
          )}
          {officers.map((o, i) => (
            <tr key={o.id}>
              <td data-label="No.">{i + 1}</td>
              {OFFICER_FIELDS.map(([k, l]) => <td key={k} data-label={l}>{o[k] || "—"}</td>)}
              {editable && (
                <td data-label="">
                  <button className="btn btn-danger btn-sm"
                    onClick={() => act("del-officer", `/mdr/officers/${o.id}`, { method: "DELETE" })}>Remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div style={{ padding: 18 }}>
          {adding
            ? <RowForm fields={OFFICER_FIELDS} onCancel={() => setAdding(false)}
                onSave={async (v) => {
                  const ok = await act("add-officer", `/mdr/${reportId}/officers`, { method: "POST", body: JSON.stringify(v) });
                  if (ok) setAdding(false);
                }} />
            : <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>+ Add officer</button>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Gains and losses
// ---------------------------------------------------------------------------

// The two halves differ ONLY in their column labels. The source sheet gives
// the GAIN table the LOSSES headers ("DATE TERMINATED", "CAUSE(S) OF
// TERMINATION"), which reads wrong for a guard being gained.
const MOVEMENT_FIELDS = {
  Gain: [
    ["guardName", "Name of guard"],
    ["postingPlace", "Posting place"],
    ["effectiveDate", "Date hired / deployed", "date"],
    ["cause", "Remarks"],
  ],
  Loss: [
    ["guardName", "Name of guard"],
    ["postingPlace", "Last posting place"],
    ["effectiveDate", "Date terminated", "date"],
    ["cause", "Cause(s) of termination"],
  ],
};

function Section5({ movements, editable, act, reportId }) {
  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 16 }}>
      <div className="section-head">5. Gains and Losses</div>
      <MovementTable title="A. GAIN" kind="Gain" rows={movements.gains} editable={editable} act={act} reportId={reportId} />
      <MovementTable title="B. LOSSES" kind="Loss" rows={movements.losses} editable={editable} act={act} reportId={reportId} />
    </div>
  );
}

function MovementTable({ title, kind, rows, editable, act, reportId }) {
  const [adding, setAdding] = useState(false);
  const fields = MOVEMENT_FIELDS[kind];
  return (
    <div style={{ padding: "0 0 8px" }}>
      <div style={{ fontWeight: 700, fontSize: 13, padding: "14px 18px 8px" }}>{title}</div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }}>No.</th>
            {fields.map(([, l]) => <th key={l}>{l}</th>)}
            {editable && <th style={{ width: 90 }} />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={editable ? 6 : 5}>
              <div className="empty-hint">{kind === "Gain" ? "No guards gained this month." : "No guards lost this month."}</div>
            </td></tr>
          )}
          {rows.map((m, i) => (
            <tr key={m.id}>
              <td data-label="No.">{i + 1}</td>
              {fields.map(([k, l, t]) => (
                <td key={k} data-label={l}>{(t === "date" ? shortDate(m[k]) : m[k]) || "—"}</td>
              ))}
              {editable && (
                <td data-label="">
                  <button className="btn btn-danger btn-sm"
                    onClick={() => act("del-movement", `/mdr/movements/${m.id}`, { method: "DELETE" })}>Remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div style={{ padding: "12px 18px 4px" }}>
          {adding
            ? <RowForm fields={fields} onCancel={() => setAdding(false)}
                onSave={async (v) => {
                  const ok = await act("add-movement", `/mdr/${reportId}/movements`, {
                    method: "POST", body: JSON.stringify({ ...v, kind }),
                  });
                  if (ok) setAdding(false);
                }} />
            : <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                + Add {kind === "Gain" ? "gain" : "loss"}
              </button>}
        </div>
      )}
    </div>
  );
}

// A small add-row form driven by a field list, so section 4 and both halves of
// section 5 share one implementation rather than three near-identical ones.
function RowForm({ fields, onCancel, onSave }) {
  const [v, setV] = useState(Object.fromEntries(fields.map(([k]) => [k, ""])));
  const [saving, setSaving] = useState(false);
  return (
    <div className="section-card" style={{ padding: 16 }}>
      <div className="form-grid">
        {fields.map(([k, label, type]) => (
          <div className="form-field" key={k}>
            <label>{label}</label>
            <input type={type || "text"} value={v[k]} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-gold btn-sm" disabled={saving}
          onClick={async () => { setSaving(true); await onSave(v); setSaving(false); }}>Add</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Certification and signatures
// ---------------------------------------------------------------------------

function Certification({ report, editable, act }) {
  const [f, setF] = useState({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setF({
      preparedByName: report.preparedByName || "", preparedByPosition: report.preparedByPosition || "",
      notedByName: report.notedByName || "", notedByPosition: report.notedByPosition || "",
    });
    setDirty(false);
  }, [report]);
  const set = (k) => (e) => { setF((s) => ({ ...s, [k]: e.target.value })); setDirty(true); };

  return (
    <div className="section-card" style={{ padding: 0, marginBottom: 4 }}>
      <div className="section-head">Certification &amp; signatures</div>
      <div style={{ padding: 18 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{report.certification}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 18 }}>
          Rendered from the report month. {report.status !== "Draft" && "Frozen as filed."}
        </div>
        <div className="form-grid">
          <Field label="Prepared by" value={f.preparedByName} onChange={set("preparedByName")} editable={editable} />
          <Field label="Position" value={f.preparedByPosition} onChange={set("preparedByPosition")} editable={editable} />
          <Field label="Noted by" value={f.notedByName} onChange={set("notedByName")} editable={editable} />
          <Field label="Position" value={f.notedByPosition} onChange={set("notedByPosition")} editable={editable} />
        </div>
        {editable && dirty && (
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 14 }}
            onClick={() => act("signatories", `/mdr/${report.id}`, { method: "PATCH", body: JSON.stringify(f) })}>
            Save signatories
          </button>
        )}
      </div>
    </div>
  );
}
