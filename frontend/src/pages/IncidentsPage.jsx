import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../api/client";
import { loadXLSX } from "../lib/loadXLSX";
import { useAuth } from "../context/AuthContext";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import ShareFormModal from "./ShareFormModal";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import NewIncidentModal from "./NewIncidentModal";
import IncidentDetailModal from "./IncidentDetailModal";
import GlobalAuditModal from "./GlobalAuditModal";
import { daysBetween, statusBadgeClass, sevBadgeClass, countChipClass } from "./incidentShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Central Security Operations Management System";

export default function IncidentsPage() {
  const { isAdmin } = useAuth();
  // Add / Edit / Delete follow the per-user privilege matrix. isAdmin stays for
  // the two genuinely admin-only controls below (public form link, activity log).
  const perm = useModulePerms();

  const [incidents, setIncidents] = useState([]);
  const [classifications, setClassifications] = useState([]);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");
  const [filterSite, setFilterSite] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const [showNewModal, setShowNewModal] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [inc, cls, st] = await Promise.all([
        api("/incidents"),
        api("/meta/classifications"),
        api("/meta/sites"),
      ]);
      setIncidents(inc);
      setClassifications(cls);
      setSites(st);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const siteOptions = useMemo(() => {
    const used = new Set(incidents.map((i) => i.site));
    return [...new Set([...sites, ...used])].sort();
  }, [sites, incidents]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return incidents
      .filter((i) => {
        const hay = [i.title, i.id, i.site, i.description, i.reportedBy, i.assigned].join(" ").toLowerCase();
        if (q && !hay.includes(q)) return false;
        if (filterClass && i.classification !== filterClass) return false;
        if (filterStatus && i.status !== filterStatus) return false;
        if (filterSite && i.site !== filterSite) return false;
        if (filterSeverity && i.severity !== filterSeverity) return false;
        if (filterFrom && i.date < filterFrom) return false;
        if (filterTo && i.date > filterTo) return false;
        return true;
      })
      .sort((a, b) => {
        // Newest event date first; when dates tie, break by the internal
        // case number (INC-####) descending so the newest record stays on top
        // — matching the backend's "date DESC, id DESC" ordering.
        const byDate = new Date(b.date) - new Date(a.date);
        if (byDate !== 0) return byDate;
        const numA = parseInt(String(a.id).replace(/\D/g, ""), 10) || 0;
        const numB = parseInt(String(b.id).replace(/\D/g, ""), 10) || 0;
        return numB - numA;
      });
  }, [incidents, search, filterClass, filterStatus, filterSite, filterSeverity, filterFrom, filterTo]);

  // Caseload summary for the stat cards. Computed over all incidents (not the
  // filtered view) so supervisors get a stable read of the whole register.
  const stats = useMemo(() => {
    const isOpen = (i) => i.status !== "Resolved" && i.status !== "Closed";
    const openHigh = incidents.filter((i) => isOpen(i) && (i.severity === "High" || i.severity === "Critical")).length;
    const openMedium = incidents.filter((i) => isOpen(i) && i.severity === "Medium").length;
    const settled = incidents.filter((i) => i.status === "Resolved" || i.status === "Closed").length;
    return { openHigh, openMedium, settled, total: incidents.length };
  }, [incidents]);

  const [exporting, setExporting] = useState(false);

  async function exportDataExcel() {
    let XLSX;
    setExporting(true);
    try {
      XLSX = await loadXLSX();
    } catch {
      setExporting(false);
      alert("The Excel export library didn't load. Check your internet connection and try again.");
      return;
    }
    setExporting(false);

    const incidentRows = incidents.map((i) => ({
      "Incident ID": i.id,
      "Title": i.title,
      "Date reported": i.date,
      "Site / facility": i.site,
      "Classification": i.classification,
      "Severity": i.severity,
      "Status": i.status,
      "Reported by": i.reportedBy || "",
      "Assigned investigator": i.assigned || "",
      "Description": i.description || "",
      "Root cause": i.rootCause || "",
      "Resolved date": i.resolvedDate || "",
      "Resolution (days)": i.resolvedDate ? daysBetween(i.date, i.resolvedDate) : "",
    }));

    const evidenceRows = [];
    const witnessRows = [];
    const actionRows = [];
    incidents.forEach((i) => {
      (i.evidence || []).forEach((e) => evidenceRows.push({
        "Incident ID": i.id, "Incident title": i.title,
        "Evidence title": e.title, "Type": e.type, "Notes": e.note || "",
      }));
      (i.witnesses || []).forEach((w) => witnessRows.push({
        "Incident ID": i.id, "Incident title": i.title,
        "Witness": w.name, "Statement": w.statement,
      }));
      (i.actions || []).forEach((a) => actionRows.push({
        "Incident ID": i.id, "Incident title": i.title,
        "Type": a.type, "Description": a.description,
        "Owner": a.owner || "", "Due date": a.dueDate || "", "Status": a.status,
      }));
    });

    const total = incidents.length;
    const open = incidents.filter((i) => i.status !== "Resolved" && i.status !== "Closed").length;
    const resolvedList = incidents.filter((i) => i.resolvedDate);
    const avgRes = resolvedList.length
      ? Math.round(resolvedList.reduce((s, i) => s + daysBetween(i.date, i.resolvedDate), 0) / resolvedList.length)
      : 0;
    const classCounts = {};
    incidents.forEach((i) => { classCounts[i.classification] = (classCounts[i.classification] || 0) + 1; });
    const kpiRows = [
      { "Metric": "Total incidents", "Value": total },
      { "Metric": "Open cases", "Value": open },
      { "Metric": "Average resolution time (days)", "Value": avgRes },
      { "Metric": "Repeat classifications (2+ cases)", "Value": Object.values(classCounts).filter((c) => c > 1).length },
      { "Metric": "Report generated", "Value": new Date().toISOString().slice(0, 10) },
    ];
    const byClassRows = Object.entries(classCounts).map(([k, v]) => ({ "Classification": k, "Incident count": v }));

    const wb = XLSX.utils.book_new();
    const wsSummary = XLSX.utils.json_to_sheet(kpiRows);
    wsSummary["!cols"] = [{ wch: 34 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "KPI Summary");

    const wsByClass = XLSX.utils.json_to_sheet(byClassRows);
    wsByClass["!cols"] = [{ wch: 28 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsByClass, "By Classification");

    const wsIncidents = XLSX.utils.json_to_sheet(incidentRows);
    wsIncidents["!cols"] = [{ wch: 10 }, { wch: 34 }, { wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 22 }, { wch: 16 }, { wch: 18 }, { wch: 44 }, { wch: 36 }, { wch: 13 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsIncidents, "Incidents");

    const wsEvidence = XLSX.utils.json_to_sheet(evidenceRows);
    wsEvidence["!cols"] = [{ wch: 10 }, { wch: 34 }, { wch: 26 }, { wch: 14 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsEvidence, "Evidence");

    const wsWitness = XLSX.utils.json_to_sheet(witnessRows);
    wsWitness["!cols"] = [{ wch: 10 }, { wch: 34 }, { wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsWitness, "Witness Statements");

    const wsActions = XLSX.utils.json_to_sheet(actionRows);
    wsActions["!cols"] = [{ wch: 10 }, { wch: 34 }, { wch: 12 }, { wch: 40 }, { wch: 18 }, { wch: 13 }, { wch: 13 }];
    XLSX.utils.book_append_sheet(wb, wsActions, "Corrective Actions");

    const wsClass = XLSX.utils.json_to_sheet(classifications.map((c) => ({ "Classification": c })));
    wsClass["!cols"] = [{ wch: 28 }];
    XLSX.utils.book_append_sheet(wb, wsClass, "Classifications List");

    const wsSites = XLSX.utils.json_to_sheet(sites.map((s) => ({ "Site / facility": s })));
    wsSites["!cols"] = [{ wch: 24 }];
    XLSX.utils.book_append_sheet(wb, wsSites, "Sites List");

    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `csoms-incident-report-${stamp}.xlsx`);
  }

  function exportDataJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      system: "Brookside Farms CSOMS - Incident Reporting & Investigation",
      incidents,
      classifications,
      sites,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `csoms-incident-data-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const actions = (
    <>
      {isAdmin && <button className="btn btn-outline" onClick={() => setShowShare(true)}>Share report form link</button>}
      <button className="btn btn-outline" onClick={exportDataExcel} disabled={exporting}>{exporting ? "Preparing\u2026" : "Export to Excel"}</button>
      <button className="btn btn-outline" onClick={exportDataJson}>Export (JSON backup)</button>
      {isAdmin && <button className="btn btn-outline" onClick={() => setShowAudit(true)}>Activity log</button>}
      {perm.add && <button className="btn btn-gold" onClick={() => setShowNewModal(true)}>+ New incident</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="!" title="Incident Reporting & Investigation" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Track, investigate, and resolve security incidents with full documentation.</PurposeBar>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            type="text" className="search-input" placeholder="Search title, site, or ID..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)}>
            <option value="">All classifications</option>
            {classifications.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Open">Open</option>
            <option value="Under Investigation">Under Investigation</option>
            <option value="Resolved">Resolved</option>
            <option value="Closed">Closed</option>
          </select>
          <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
            <option value="Critical">Critical</option>
          </select>
          <input type="date" title="From date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          <input type="date" title="To date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} incident${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {!loading && !loadError && (
        <div className="kpi-grid" data-cols="4">
          <KpiCard label={<>Open &middot; High / Critical</>} value={stats.openHigh} tone="danger" icon="bi-exclamation-octagon" />
          <KpiCard label={<>Open &middot; Medium</>} value={stats.openMedium} tone="warn" icon="bi-exclamation-triangle" />
          <KpiCard label={<>Resolved / Closed</>} value={stats.settled} tone="good" icon="bi-check2-circle" />
          <KpiCard label={<>Total incidents</>} value={stats.total} tone="neutral" icon="bi-clipboard-data" />
        </div>
      )}

      <div className="section-card">
        <div className="section-head">Incident register</div>
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Date</th><th>Title</th><th>Site</th><th>Classification</th>
              <th>Severity</th><th>Status</th><th>Resolution (days)</th>
              <th>Root Cause</th><th>Evidence</th><th>Witnesses</th><th>CAPA</th><th>Attachments</th>
            </tr>
          </thead>
          <tbody>
            {loadError && (
              <tr className="empty-row"><td colSpan={13}>{loadError}</td></tr>
            )}
            {!loadError && loading && (
              <tr className="empty-row"><td colSpan={13}>Loading incidents...</td></tr>
            )}
            {!loadError && !loading && rows.length === 0 && (
              <tr className="empty-row"><td colSpan={13}>No incidents match your filters.</td></tr>
            )}
            {!loadError && rows.map((i) => {
              const resDays = i.resolvedDate ? daysBetween(i.date, i.resolvedDate) : "\u2014";
              const rootCauseText = i.rootCause
                ? (i.rootCause.length > 60 ? i.rootCause.slice(0, 60) + "\u2026" : i.rootCause)
                : null;
              return (
                <tr key={i.id} onClick={() => setDetailId(i.id)} style={{ cursor: "pointer" }}>
                  <td data-label="ID"><strong>{i.id}</strong></td>
                  <td data-label="Date">{i.date}</td>
                  <td data-label="Title">{i.title}</td>
                  <td data-label="Site"><span className="chip">{i.site}</span></td>
                  <td data-label="Classification">{i.classification}</td>
                  <td data-label="Severity"><span className={`badge ${sevBadgeClass(i.severity)}`}>{i.severity}</span></td>
                  <td data-label="Status"><span className={`badge ${statusBadgeClass(i.status)}`}>{i.status}</span></td>
                  <td data-label="Resolution (days)">{resDays}</td>
                  <td data-label="Root Cause" title={i.rootCause || ""}>
                    {rootCauseText || <span className="empty-hint" style={{ padding: 0 }}>Not yet determined</span>}
                  </td>
                  <td data-label="Evidence"><span className={countChipClass(i.evidence.length)}>{i.evidence.length}</span></td>
                  <td data-label="Witnesses"><span className={countChipClass(i.witnesses.length)}>{i.witnesses.length}</span></td>
                  <td data-label="CAPA"><span className={countChipClass(i.actions.length)}>{i.actions.length}</span></td>
                  <td data-label="Attachments"><span className={countChipClass(i.attachments.length)}>{i.attachments.length}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfidentialFooter />

      {showNewModal && (
        <NewIncidentModal
          classifications={classifications}
          sites={sites}
          onClose={() => setShowNewModal(false)}
          onCreated={async (incId) => {
            setShowNewModal(false);
            await loadData();
            setDetailId(incId);
          }}
        />
      )}

      {detailId && (
        <IncidentDetailModal
          incidentId={detailId}
          canEdit={perm.edit}
          canDelete={perm.delete}
          onClose={() => setDetailId(null)}
          onChanged={loadData}
          onDeleted={async () => {
            setDetailId(null);
            await loadData();
          }}
        />
      )}

      {showAudit && <GlobalAuditModal onClose={() => setShowAudit(false)} />}
      {showShare && <ShareFormModal kind="incident" onClose={() => setShowShare(false)} />}
    </div>
  );
}
