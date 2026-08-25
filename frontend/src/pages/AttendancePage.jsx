import { useEffect, useMemo, useState, useCallback } from "react";
import { api, apiBlobUrl } from "../api/client";
import { confirm } from "../lib/confirm";
import useModulePerms from "../lib/modulePerms";
import { useAuth } from "../context/AuthContext";
import { ATTENDANCE_EDIT_ROLES } from "../roles";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import ShareFormModal from "./ShareFormModal";
import AttendanceReports from "./AttendanceReports";
import AbsenceMonitoring from "./AbsenceMonitoring";
import RetiredPunches from "./RetiredPunches";
import AttendanceRecordModal from "./AttendanceRecordModal";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Monitor guard attendance and deployment in real time across all sites";

// Small component that fetches an auth-protected selfie as a blob URL (a bare
// <img src> can't send the token, so we load it via apiBlobUrl like other
// protected images in the app).
function SelfieThumb({ recordId }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; let objUrl = null;
    apiBlobUrl(`/attendance/${recordId}/selfie`)
      .then((u) => { if (active) { objUrl = u; setUrl(u); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [recordId]);
  // A fetch that FAILED must not render the same dash as a record that never
  // had a selfie: one is a fault to chase, the other is normal, and showing
  // both as "—" is what made a correction record look broken.
  if (failed) return (
    <span style={{ color: "var(--red)", fontSize: 11 }} title="The selfie could not be loaded. It may have been removed, or the request was refused.">
      &#9888; failed
    </span>
  );
  if (!url) return <span style={{ color: "var(--text-mute)", fontSize: 12 }}>…</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt="Selfie" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
    </a>
  );
}

// Why a record has no selfie and no coordinates.
//
// A punch created by approving a Missing Time Log request is typed by an
// administrator, not submitted at a gate — nobody took a photo and nobody was
// anywhere, so both columns are legitimately empty. Saying so is the whole
// point: a bare dash reads as a broken image, which is exactly how this was
// first reported.
function isCorrection(r) {
  return String(r && r.createdBy || "").startsWith("correction:");
}
function NotCaptured({ r, what }) {
  const corrected = isCorrection(r);
  return (
    <span
      style={{ color: "var(--text-mute)", fontSize: 11 }}
      title={corrected
        ? `No ${what} — this record was created by an approved Missing Time Log correction, not submitted at a post.`
        : `No ${what} was recorded with this punch.`}
    >
      {corrected ? "— not captured" : "—"}
    </span>
  );
}

// A correction punch has no capture of its own, but the request that produced
// it may carry a selfie, coordinates and attachments. Point at those rather
// than showing a dash beside evidence that plainly exists.
//
// Rendered ONLY when the source request really holds something — both are
// optional on that form, so a link to an empty review page would be worse than
// the honest empty state. The API decides via correctionHasEvidence.
//
// Deliberately per ROW, not per day: an OUT-only correction leaves the original
// IN punch untouched, and that row keeps showing its own real selfie. A
// day-level banner would wrongly imply both halves were corrected.
function EvidenceOnRequest({ r, onOpen }) {
  const code = "MTL-" + String(r.correctionRequestId).padStart(4, "0");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`This time was set by an approved Missing Time Log correction. The guard's selfie, location and any files they attached are on request ${code}.`}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        color: "var(--blue)", fontSize: 11, textAlign: "left", textDecoration: "underline",
      }}
    >
      Evidence on {code}
    </button>
  );
}

/**
 * The current week in PH terms, Sunday to Saturday.
 *
 * Everything here is done on a UTC clock shifted by +8 rather than through the
 * browser's local timezone: PH is UTC+8 with no DST, so the shift is exact, and
 * reading a local-timezone Date back as a calendar date is where every
 * day-boundary defect in this system has come from.
 *
 * Sunday-start matches startOfWeek() in SchedulingPage, so the Attendance
 * Register and the Weekly Roster agree on what "this week" means.
 */
function currentWeek() {
  const nowPh = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const sunday = new Date(nowPh);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const saturday = new Date(sunday);
  saturday.setUTCDate(saturday.getUTCDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(sunday), to: iso(saturday) };
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  // Always display in Philippine time regardless of the viewer's browser zone.
  return d.toLocaleString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function AttendancePage() {
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const { user } = useAuth();
  const role = user && user.role;
  const isViewer = !perm.edit;
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [filterSite, setFilterSite] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterGuard, setFilterGuard] = useState("");
  // Register date range, defaulting to the CURRENT WEEK.
  //
  // Sunday-to-Saturday, matching the Weekly Roster's own week so the two
  // screens never describe different spans as "this week".
  //
  // Derived in PH time, not the browser's: the rows below are filtered on each
  // punch's PH calendar date, and a viewer east or west of UTC+8 would
  // otherwise get a week boundary a day out from the data it filters.
  // "Clear dates" still empties both and returns the unbounded view.
  const [fromDate, setFromDate] = useState(() => currentWeek().from);
  const [toDate, setToDate] = useState(() => currentWeek().to);
  const [employeeList, setEmployeeList] = useState([]);
  const [allSites, setAllSites] = useState([]);
  // Inline correction of a guard's wrong site / wrong record type. Gated on the
  // explicit role allowlist the API enforces, NOT on the Add/Edit/Delete matrix:
  // moving a punch to another site moves billable hours between clients, and
  // four roles hold edit on attendance that must not have it. Drawing the button
  // is a convenience; ATTENDANCE_EDIT_ROLES in src/lib/permissions.js is the
  // check.
  const canEditRecords = ATTENDANCE_EDIT_ROLES.includes(role);
  // DELETE is a different privilege from the site/record edit, and is granted
  // per user from Manage Users rather than by the allowlist. Conflating the two
  // cut both ways: an Owner holding delete saw no actions column at all, while
  // an Operations user WITHOUT the grant was shown a Delete button that 403s.
  // perm.delete already means "Admin, or the matrix grants it", which is what
  // the API enforces.
  const canDeleteRecords = perm.delete;
  const showActions = canEditRecords || canDeleteRecords;
  const [editingId, setEditingId] = useState(null);
  const [editSite, setEditSite] = useState("");
  const [editType, setEditType] = useState("IN");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [editNotice, setEditNotice] = useState(null);
  // The guard whose read-only timesheet is open, or null.
  const [viewingRecordFor, setViewingRecordFor] = useState(null);
  const [showShare, setShowShare] = useState(false);
  const [view, setView] = useState("register"); // "register" | "reports"

  const loadData = useCallback(async () => {
    try {
      const rows = await api("/attendance");
      setRecords(rows);
      setLoadError("");
    } catch (e) { setLoadError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Active guards for the Guard filter dropdown, from the ATTENDANCE module.
  //
  // This used to read /leave/employees, which is gated by Leave Management: a
  // user holding attendance but not leave got this page with an EMPTY dropdown
  // and no way to scope the register to one guard. A screen should not need a
  // second module's permission to fill its own filter.
  useEffect(() => {
    let active = true;
    api("/attendance/_all/guards")
      .then((emps) => { if (active) setEmployeeList(Array.isArray(emps) ? emps : []); })
      .catch(() => { /* keep empty */ });
    return () => { active = false; };
  }, []);

  // Load the full Site list from Manage Lists so the Site filter shows every
  // configured site, not only those already present in attendance records.
  useEffect(() => {
    let active = true;
    api("/meta/sites")
      .then((sites) => { if (active) setAllSites(Array.isArray(sites) ? sites : []); })
      .catch(() => { /* fall back to sites derived from records */ });
    return () => { active = false; };
  }, []);

  const siteOptions = useMemo(() => {
    // Full master list from Manage Lists, plus any site already present in
    // records (so nothing in the data is unfilterable). Default remains "All sites".
    const set = new Set(allSites);
    records.forEach((r) => { if (r.site) set.add(r.site); });
    return [...set].sort();
  }, [allSites, records]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const g = filterGuard.trim().toLowerCase();
    // Punches are UTC instants but guards work in PH time, so the range is
    // compared against the PH calendar date — otherwise a 06:00 PH punch
    // (22:00 UTC the previous day) would fall outside its own duty date.
    const phDate = (iso) => new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    return records.filter((r) => {
      if (q && !`${r.guardName} ${r.site}`.toLowerCase().includes(q)) return false;
      if (filterSite && r.site !== filterSite) return false;
      if (filterType && r.punchType !== filterType) return false;
      if (g && (r.guardName || "").trim().toLowerCase() !== g) return false;
      if (fromDate || toDate) {
        const d = phDate(r.punchAt);
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
      }
      return true;
    });
  }, [records, search, filterSite, filterType, filterGuard, fromDate, toDate]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const todays = records.filter((r) => new Date(r.punchAt).toDateString() === today);
    return {
      todayIn: todays.filter((r) => r.punchType === "IN").length,
      todayOut: todays.filter((r) => r.punchType === "OUT").length,
      todayTotal: todays.length,
      total: records.length,
    };
  }, [records]);

  async function removeRecord(id, e) {
    e.stopPropagation();
    // The wording has to say what actually happens. This is a SOFT delete: the
    // punch is retired and can be restored from the Retired tab. "Delete this
    // attendance record?" read exactly like an erasure, which both overstated
    // the consequence and hid the way back.
    if (!await confirm(
      "Retire this attendance record?\n\n"
      + "It is removed from the register, the attendance reports, payroll and billing, "
      + "but not erased — you can put it back from the Retired tab. Figures already "
      + "computed do not change until the affected period is recomputed."
    )) return;
    try { await api(`/attendance/${id}`, { method: "DELETE" }); await loadData(); }
    catch (err) { setLoadError(err.message); }
  }

  // --- Correcting a guard's wrong site or wrong record type ----------------
  //
  // Both are picked by the guard on the public form and both are sometimes
  // wrong. Correcting them before the period is billed is the normal path, so
  // it is a plain inline edit — no modal, no workflow.
  //
  // The API decides what is allowed; these controls only avoid offering an
  // action that would be refused. A record inside an issued or paid statement
  // is refused there, and that refusal is shown in the row.
  function startEdit(r, e) {
    e.stopPropagation();
    setEditingId(r.id);
    setEditSite(r.site || "");
    setEditType(r.punchType);
    setEditError("");
  }
  function cancelEdit(e) {
    if (e) e.stopPropagation();
    setEditingId(null); setEditError("");
  }
  async function saveEdit(r, e) {
    e.stopPropagation();
    setEditBusy(true); setEditError("");
    try {
      const res = await api(`/attendance/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({ site: editSite, punchType: editType }),
      });
      setEditingId(null);
      await loadData();
      // The edit changes what a recompute WILL produce; it does not reprice
      // anything by itself. Say so, naming the periods, rather than leaving the
      // admin to assume the statement already moved.
      if (!res.unchanged) {
        setEditNotice({
          guardName: r.guardName,
          siteMismatch: res.siteMismatch,
          rosteredSite: res.rosteredSite,
          periods: res.affectedPeriods || [],
        });
      }
    } catch (err) {
      // Kept in the row: the refusal explains why this particular record cannot
      // be edited, and a banner at the top of a long register would not be read.
      setEditError(err.message);
    } finally {
      setEditBusy(false);
    }
  }

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadData}>Refresh</button>
      {perm.add && <button className="btn btn-outline" onClick={() => setShowShare(true)}>Share attendance link</button>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader title="Attendance &amp; Timekeeping Module" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Monitor guard attendance and deployment in real time across all sites. Guards submit time records with a selfie and location via the shared attendance link.</PurposeBar>

      <div style={{ display: "flex", gap: 6, margin: "16px 32px 0" }}>
        <button className={`btn btn-sm ${view === "register" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("register")}>Register</button>
        <button className={`btn btn-sm ${view === "reports" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("reports")}>Reports</button>
        <button className={`btn btn-sm ${view === "absence" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("absence")}>Absence Monitoring</button>
        {/* Only offered to whoever may delete: the same privilege the Delete
            button and all three retire/restore routes already require. */}
        {perm.delete && (
          <button className={`btn btn-sm ${view === "retired" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("retired")}>Retired</button>
        )}
      </div>

      {view === "reports" && <AttendanceReports siteOptions={siteOptions} />}

      {view === "absence" && <AbsenceMonitoring siteOptions={siteOptions} />}

      {view === "retired" && perm.delete && (
        <RetiredPunches canRestore={perm.delete} onRestored={loadData} />
      )}

      {view === "register" && (
      <>
      <div className="toolbar">
        <div className="toolbar-left">
          <input type="text" className="search-input" placeholder="Search name or site..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All records</option>
            <option value="IN">Time IN</option>
            <option value="OUT">Time OUT</option>
          </select>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={filterGuard} onChange={(e) => setFilterGuard(e.target.value)}>
            <option value="">All guards</option>
            {employeeList.map((emp) => <option key={emp.id} value={emp.fullName}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
          </select>
          {/* A timesheet is per person, so this needs a specific guard. Disabled
              rather than hidden on "All guards": the control stays where the
              reader found it and says why it cannot be used. */}
          <button
            className="btn btn-outline btn-sm"
            disabled={!filterGuard}
            onClick={() => setViewingRecordFor(filterGuard)}
            title={filterGuard
              ? `Open ${filterGuard}'s daily time record`
              : "Choose a specific guard first — a timesheet is per person."}
          >
            View Attendance Record
          </button>
          <label style={{ fontSize: 11, color: "var(--text-mute)", display: "flex", flexDirection: "column", gap: 2 }}>
            From
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label style={{ fontSize: 11, color: "var(--text-mute)", display: "flex", flexDirection: "column", gap: 2 }}>
            To
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} />
          </label>
          {(fromDate || toDate) && (
            <button className="btn btn-sm btn-secondary" onClick={() => { setFromDate(""); setToDate(""); }}>Clear dates</button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          {!loading && `${rows.length} record${rows.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {!loading && !loadError && (
        <div className="kpi-grid" data-cols="4">
          <KpiCard label={<>Time IN today</>} value={stats.todayIn} tone="good" icon="bi-box-arrow-in-right" />
          <KpiCard label={<>Time OUT today</>} value={stats.todayOut} tone="danger" icon="bi-box-arrow-right" />
          <KpiCard label={<>Records today</>} value={stats.todayTotal} tone="neutral" icon="bi-calendar-day" />
          <KpiCard label={<>Total records</>} value={stats.total} tone="neutral" icon="bi-archive" />
        </div>
      )}

      {/* An edit changes what a recompute WILL produce; it reprices nothing by
          itself, because billing reads punches live at compute time. Saying so
          — and naming the periods — matches the notice the billing period screen
          already carries about corrections not being reflected until recompute. */}
      {editNotice && (
        <div className="section-card" style={{ borderLeft: "3px solid var(--blue)", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              <strong>Record updated for {editNotice.guardName}.</strong>{" "}
              {editNotice.periods.length > 0 ? (
                <>This change is not on any statement yet — open{" "}
                  <strong>Billing &amp; Statement of Account</strong> and recompute{" "}
                  {editNotice.periods.length === 1 ? "the draft period for " : "the draft periods for "}
                  <strong>{[...new Set(editNotice.periods.map((p) => p.clientName))].join(", ")}</strong> to apply it.
                </>
              ) : (
                <>This punch falls in no billing period yet, so it will be picked up whenever the period covering it is computed.</>
              )}
              {editNotice.siteMismatch && (
                <div style={{ color: "var(--red)", marginTop: 6 }}>
                  The corrected site disagrees with the roster ({editNotice.rosteredSite || "—"}), so the day is
                  held for review. Align the shift schedule with the corrected attendance to clear it — the hold
                  is there to stop money moving between clients unnoticed.
                </div>
              )}
            </div>
            <button className="btn btn-sm btn-secondary" onClick={() => setEditNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="section-card sticky-card">
        <div className="section-head">Attendance register</div>
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Selfie</th><th>Employee No</th><th>Guard</th><th>Site</th><th>Record</th><th>Date &amp; time</th><th>Location</th>
              {showActions && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loadError && <tr className="empty-row"><td colSpan={showActions ? 8 : 7}>{loadError}</td></tr>}
            {!loadError && loading && <tr className="empty-row"><td colSpan={showActions ? 8 : 7}>Loading attendance…</td></tr>}
            {!loadError && !loading && rows.length === 0 && <tr className="empty-row"><td colSpan={showActions ? 8 : 7}>No attendance records match your filters.</td></tr>}
            {!loadError && rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Selfie">
                  {r.hasSelfie
                    ? <SelfieThumb recordId={r.id} />
                    : r.correctionHasEvidence
                      ? <EvidenceOnRequest r={r} onOpen={() => setView("absence")} />
                      : <NotCaptured r={r} what="selfie" />}
                </td>
                <td data-label="Employee No">{r.employeeNo || "—"}</td>
                <td data-label="Guard"><strong>{r.guardName}</strong></td>
                <td data-label="Site">
                  {editingId === r.id ? (
                    // The master Sites / Facilities list, which is what the
                    // server validates against — offering a site only present
                    // in old records would just earn a 400.
                    <select value={editSite} onChange={(ev) => setEditSite(ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()} style={{ fontSize: 12, minWidth: 150 }}>
                      {!allSites.includes(editSite) && editSite && <option value={editSite}>{editSite}</option>}
                      {allSites.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : r.site ? <span className="chip">{r.site}</span> : "—"}
                  {r.siteMismatch === true && (
                    <div style={{ fontSize: 10.5, color: "var(--red)", fontWeight: 600, marginTop: 3 }}>
                      ⚠ Roster says {r.rosteredSite || "another site"} — held for review
                    </div>
                  )}
                </td>
                <td data-label="Record">
                  {editingId === r.id ? (
                    <select value={editType} onChange={(ev) => setEditType(ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()} style={{ fontSize: 12 }}>
                      <option value="IN">Time IN</option>
                      <option value="OUT">Time OUT</option>
                    </select>
                  ) : (
                    <span className={`badge ${r.punchType === "IN" ? "badge-resolved" : "badge-open"}`}>Time {r.punchType}</span>
                  )}
                  {r.createdBy && String(r.createdBy).startsWith("correction:") && (
                    <div style={{ fontSize: 10.5, color: "var(--teal, #0e7c86)", fontWeight: 600, marginTop: 3 }}>
                      ✎ Corrected via approved request
                    </div>
                  )}
                  {editingId === r.id && editError && (
                    <div style={{ fontSize: 11.5, color: "var(--red)", background: "var(--red-bg)",
                      border: "1px solid #f0c9c9", borderRadius: 6, padding: "6px 8px", marginTop: 6, lineHeight: 1.5 }}>
                      {editError}
                    </div>
                  )}
                </td>
                <td data-label="Date & time">{fmtDateTime(r.punchAt)}</td>
                <td data-label="Location">
                  {r.mapsUrl
                    ? <a href={r.mapsUrl} target="_blank" rel="noopener noreferrer">View on map</a>
                    : r.correctionHasEvidence
                      ? <EvidenceOnRequest r={r} onOpen={() => setView("absence")} />
                      : <NotCaptured r={r} what="location" />}
                </td>
                {showActions && (
                  <td data-label="" style={{ whiteSpace: "nowrap" }}>
                    {editingId === r.id ? (
                      <>
                        <button className="btn btn-sm btn-primary" disabled={editBusy}
                          onClick={(e) => saveEdit(r, e)}>{editBusy ? "Saving…" : "Save"}</button>{" "}
                        <button className="btn btn-sm btn-secondary" onClick={cancelEdit}>Cancel</button>
                      </>
                    ) : (
                      <>
                        {canEditRecords && (
                          <>
                            <button className="btn btn-sm btn-outline" onClick={(e) => startEdit(r, e)}
                              title="Correct the site or the record type">Edit</button>{" "}
                          </>
                        )}
                        {canDeleteRecords && (
                          <button className="btn btn-sm btn-danger" onClick={(e) => removeRecord(r.id, e)}>Delete</button>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      <ConfidentialFooter />

      {showShare && <ShareFormModal kind="attendance" onClose={() => setShowShare(false)} />}

      {viewingRecordFor && (
        <AttendanceRecordModal
          guardName={viewingRecordFor}
          // The register's From date, so the timesheet opens on the period the
          // reader is already filtered to rather than always on today's half.
          initialDate={fromDate || ""}
          onClose={() => setViewingRecordFor(null)}
        />
      )}
    </div>
  );
}
