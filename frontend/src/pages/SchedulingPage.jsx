import { useEffect, useMemo, useState, useCallback } from "react";
import SortableTh, { compareBy, nextSort } from "../components/SortableTh";
import ConfidentialFooter from "../components/ConfidentialFooter";
import { api } from "../api/client";
import { confirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import useModulePerms from "../lib/modulePerms";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";

const SUBTITLE = "Plan guard shift rotations and rest days across all sites";
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- date helpers (local, no external lib) ---
// Local YYYY-MM-DD (NOT toISOString, which converts to UTC and can shift the
// day for +8 timezones — that was making roster cells miss their date).
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Normalize a dutyDate coming from the API (may be "2026-07-28" or a full ISO
// timestamp like "2026-07-28T00:00:00.000Z") to a plain YYYY-MM-DD for matching.
function normalizeDate(v) {
  if (!v) return "";
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // back to Sunday
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// Day, Night and Straight Duty read as three distinct things on the roster.
// A straight duty crosses midnight exactly as a night shift does, so colouring
// by `crossesMidnight` alone showed the two identically.
const SHIFT_STYLE = {
  Day:      { bg: "#DCEAF7", fg: "var(--navy)", border: "#B9D4EC", dim: 0.75 },
  Night:    { bg: "var(--navy)", fg: "#fff", border: "var(--navy-dark)", dim: 0.85 },
  Straight: { bg: "var(--gold)", fg: "#3A2E05", border: "#A5851F", dim: 0.8 },
  // Teal: the fourth colour in the brand palette, and far enough from the pale
  // blue of a day shift and the navy of a night shift to be told apart at a
  // glance on a dense roster.
  Broken:   { bg: "var(--teal)", fg: "#fff", border: "#0A5341", dim: 0.85 },
};

// How each kind is named and explained in the roster legend. Kept beside
// SHIFT_STYLE so a new kind is described in exactly one place: add it to both
// (and to SHIFT_KINDS in routes/scheduling.js) and the legend picks it up.
const KIND_LABEL = {
  Day: "Day shift",
  Night: "Night shift",
  Straight: "Straight duty (24h)",
  Broken: "Broken shift",
};
const KIND_HINT = {
  Straight: "A continuous 24-hour tour, e.g. 06:00 to 06:00 the next day.",
  Broken: "One duty day worked in two stretches, e.g. 06:00-12:00 then 00:00-06:00.",
};
// Display order. Anything not listed still appears, after these.
const KIND_ORDER = ["Day", "Night", "Straight", "Broken"];

// The legend is DERIVED, never hardcoded: it reports the kinds that actually
// exist, so creating a shift template makes its kind appear with no code change.
//
// Entries are per KIND rather than per template, because that is what the
// roster cells are coloured by — two templates of the same kind get the same
// swatch, so listing them separately would imply a distinction the roster does
// not draw. The template names using each kind are shown on the entry instead,
// which keeps the link to Shift Templates visible.
//
// Assignments are read as well as templates: a kind on screen must never be
// missing from the legend just because its template was since deleted.
function buildLegend(templates, assignments) {
  const byKind = new Map();
  const add = (kind, name) => {
    if (!SHIFT_STYLE[kind]) return;
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    if (name) byKind.get(kind).add(name);
  };
  for (const t of templates || []) {
    if (t.active === false) continue;
    add(shiftKindOf(t), t.name);
  }
  for (const a of assignments || []) add(shiftKindOf(a), a.shiftName);

  const present = [...byKind.keys()];
  const ordered = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...present.filter((k) => !KIND_ORDER.includes(k)).sort(),
  ];
  // A template called "Night Shift" under the kind "Night shift" adds nothing
  // but noise, so a name that simply restates its kind is dropped. Templates
  // that say something the kind does not — "24H Straight Duty", "Graveyard" —
  // are kept, which is the whole reason the names are shown.
  const flatten = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ordered.map((kind) => {
    const label = KIND_LABEL[kind] || kind;
    return {
      kind,
      label,
      hint: KIND_HINT[kind] || "",
      names: [...byKind.get(kind)].filter((n) => flatten(n) !== flatten(label)).sort(),
      style: SHIFT_STYLE[kind],
    };
  });
}

// The server states the kind on every assignment. The fallbacks only matter for
// a row written before that column existed and not yet backfilled — a 20-hour
// or longer span is a straight duty, anything else crossing midnight is a
// night shift.
function shiftKindOf(a) {
  if (!a) return null;
  // Two ranges can only be a broken shift, whatever else the row says.
  if (String(a.startTime2 || "").trim() && String(a.endTime2 || "").trim()) return "Broken";
  if (SHIFT_STYLE[a.shiftKind]) return a.shiftKind;
  const toMin = (t) => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };
  const s = toMin(a.startTime), e = toMin(a.endTime);
  if (!Number.isNaN(s) && !Number.isNaN(e)) {
    if (e + (a.crossesMidnight ? 1440 : 0) - s >= 1200) return "Straight";
  }
  return (a.crossesMidnight || /night/i.test(a.shiftName || "")) ? "Night" : "Day";
}

const shiftCellStyle = (a) => SHIFT_STYLE[shiftKindOf(a)] || SHIFT_STYLE.Day;

// "06:00–12:00" for an ordinary shift; "06:00–12:00 + 00:00–06:00" for a
// broken one. A split shift showing only its first stretch is indisputably
// wrong on a roster - the guard is also on duty overnight.
function shiftTimes(a) {
  if (!a || !a.startTime) return "";
  const first = `${a.startTime}–${a.endTime}`;
  const two = String(a.startTime2 || "").trim() && String(a.endTime2 || "").trim();
  return two ? `${first} + ${a.startTime2}–${a.endTime2}` : first;
}

export default function SchedulingPage() {
  // Resolved from the per-user Access Privileges matrix, not from the role.
  // An administrator's override in Manage Users now governs these controls;
  // where no override exists the role default still applies, unchanged.
  const perm = useModulePerms();
  const isViewer = !perm.edit;
  const canEdit = !isViewer;

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [assignments, setAssignments] = useState([]);
  const [restDays, setRestDays] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [shiftNameList, setShiftNameList] = useState([]); // from Manage Lists (shift_assignments_shift)
  const [siteList, setSiteList] = useState([]);           // from Manage Lists (sites)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterSite, setFilterSite] = useState("");
  // Roster order. Name ascending is how the roster has always opened, so the
  // default changes nothing; the header is now just able to say so.
  const [sort, setSort] = useState({ key: "guardName", dir: "asc" });
  function toggleSort(key) {
    setSort((s) => nextSort(s, key));
  }

  const [showAssign, setShowAssign] = useState(false);
  const [assignPrefill, setAssignPrefill] = useState(null);
  const [showRestDay, setShowRestDay] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showRemove, setShowRemove] = useState(false);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const loadWeek = useCallback(async () => {
    setLoading(true);
    try {
      const from = toISO(weekStart);
      const to = toISO(addDays(weekStart, 6));
      const [asn, tmpls, emps] = await Promise.all([
        api(`/scheduling/assignments?from=${from}&to=${to}`),
        api("/scheduling/templates"),
        api("/scheduling/employees"),
      ]);
      // Rest days fetched separately and tolerantly: if the endpoint isn't
      // available yet (older backend) it shouldn't blank the whole roster.
      let rest = [];
      try { rest = await api(`/scheduling/rest-days?from=${from}&to=${to}`); }
      catch (e) { rest = []; }
      setAssignments(asn);
      setRestDays(Array.isArray(rest) ? rest : []);
      setTemplates(tmpls);
      setEmployees(emps);
      setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [weekStart]);

  useEffect(() => { loadWeek(); }, [loadWeek]);

  // Load the configurable dropdowns from Manage Lists once: shift names
  // (shift_assignments_shift) and sites. Both fall back to empty on error.
  useEffect(() => {
    let active = true;
    Promise.all([
      api("/meta/dropdown/shift_assignments_shift").catch(() => []),
      api("/meta/sites").catch(() => []),
    ]).then(([shifts, sites]) => {
      if (!active) return;
      setShiftNameList(Array.isArray(shifts) ? shifts : []);
      setSiteList(Array.isArray(sites) ? sites : []);
    });
    return () => { active = false; };
  }, []);

  const siteOptions = useMemo(() => {
    const set = new Set(siteList);
    assignments.forEach((a) => { if (a.site) set.add(a.site); });
    restDays.forEach((r) => { if (r.site) set.add(r.site); });
    return [...set].sort();
  }, [siteList, assignments, restDays]);

  // Recomputed whenever templates or the week's roster change, so a shift type
  // added in Shift Templates shows in the legend as soon as the list reloads.
  const legend = useMemo(() => buildLegend(templates, assignments), [templates, assignments]);

  // Build guard rows: unique guards with a shift OR a rest day this week,
  // filtered by site. Each cell is either a shift assignment or a rest day.
  const grid = useMemo(() => {
    const filteredAsn = filterSite ? assignments.filter((a) => a.site === filterSite) : assignments;
    const filteredRest = filterSite ? restDays.filter((r) => r.site === filterSite) : restDays;
    const byGuard = new Map();
    function rowFor(item) {
      const key = item.employeeId != null ? `e${item.employeeId}` : `n:${item.guardName}`;
      if (!byGuard.has(key)) byGuard.set(key, { employeeId: item.employeeId, employeeNo: item.employeeNo || "", guardName: item.guardName, site: item.site, cells: {}, rest: {} });
      return byGuard.get(key);
    }
    for (const a of filteredAsn) {
      rowFor(a).cells[normalizeDate(a.dutyDate)] = a;
    }
    for (const r of filteredRest) {
      rowFor(r).rest[normalizeDate(r.dutyDate)] = r;
    }
    return [...byGuard.values()].sort((a, b) => compareBy(a, b, sort.key, sort.dir));
  }, [assignments, restDays, filterSite, sort]);

  async function removeAssignment(id) {
    if (!await confirm("Remove this shift assignment?")) return;
    try { await api(`/scheduling/assignments/${id}`, { method: "DELETE" }); await loadWeek(); }
    catch (e) { setError(e.message); }
  }

  // Mark an empty cell as a rest day for this guard+date.
  async function markRestDay(employeeId, dutyDate) {
    if (!employeeId) { setError("This roster row isn't linked to a 201 File employee, so a rest day can't be marked."); return; }
    try {
      await api("/scheduling/rest-days", { method: "POST", body: JSON.stringify({ employeeId, dutyDate }) });
      await loadWeek();
      setError("");
    } catch (e) { setError(e.message); }
  }

  // Remove a rest-day marker (click the REST chip).
  async function removeRestDay(id) {
    try { await api(`/scheduling/rest-days/${id}`, { method: "DELETE" }); await loadWeek(); }
    catch (e) { setError(e.message); }
  }

  // Open the Assign Shift modal pre-filled for a specific guard + date.
  function openAssignFor(employeeId, dutyDate, site) {
    setAssignPrefill({ employeeId: String(employeeId), fromDate: dutyDate, toDate: dutyDate, site: site || "" });
    setShowAssign(true);
  }

  async function copyPrevWeek() {
    const prev = toISO(addDays(weekStart, -7));
    if (!await confirm("Copy last week's roster into this week? Existing entries won't be duplicated.")) return;
    try {
      const res = await api("/scheduling/assignments/copy-week", { method: "POST", body: JSON.stringify({ fromStart: prev }) });
      await loadWeek();
      setError("");
      toast.success(`Copied ${res.copied} assignment(s)${res.skipped ? `, skipped ${res.skipped} already present` : ""}.`);
    } catch (e) { setError(e.message); }
  }

  const actions = (
    <>
      <button className="btn btn-outline btn-sm" onClick={loadWeek}>Refresh</button>
      {canEdit && <>
      <button className="btn btn-outline" onClick={() => setShowTemplates(true)}>Manage shifts</button>
      <button className="btn btn-outline" onClick={copyPrevWeek}>Copy last week</button>
      <button className="btn btn-outline" onClick={() => setShowRemove(true)}>Remove shifts</button>
      <button className="btn btn-gold" onClick={() => setShowRestDay(true)}>+ Assign rest day</button>
      <button className="btn btn-gold" onClick={() => { setAssignPrefill(null); setShowAssign(true); }}>+ Assign shift</button>
      </>}
    </>
  );

  return (
    <div className="module-view">
      <ModuleHeader title="Shift Scheduling &amp; Rest Day Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Plan guard rotations week by week. Assign guards from the 201 File to shift templates per day, or mark rest days. A day with no shift is an implicit rest day; click an empty cell to mark it explicitly. Use "Copy last week" to roll a rotating roster forward.</PurposeBar>

      {error && <div className="purpose-bar" style={{ background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}

      <div className="toolbar">
        <div className="toolbar-left" style={{ alignItems: "center", gap: 10 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>&larr; Prev</button>
          <strong style={{ fontSize: 13.5 }}>
            {weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} &ndash;{" "}
            {addDays(weekStart, 6).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </strong>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next &rarr;</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</button>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* This roster uses an INNER scrollport (.wide-scroll below) rather than
          the app-wide .sticky-card pattern that about ten other tables use. That
          is deliberate, and reverting it to .sticky-card reintroduces a real bug
          — please read this before "making it consistent".

          .sticky-card works by setting overflow:visible on the card, because an
          overflow-x:auto ancestor captures the sticky containing block and the
          frozen header dies. Its comment in index.css used to claim a table too
          wide for its card would then "push the page instead — visible and
          recoverable". That is NOT true in this layout: .app-main is a flex item
          with min-width:0, so the overflow paints outside the viewport and
          nothing scrolls to it. Measured on this roster (990px table): at 1100px
          153px of columns were unreachable, at 900px 353px, at 768px 255px —
          window.scrollX stayed 0 and .app-main.scrollLeft stayed 0. Friday and
          Saturday simply could not be seen on a common laptop.

          An inner scrollport keeps BOTH properties: the header pins to the top
          of this box, and horizontal overflow stays scrollable inside it, so
          every day column remains reachable at every width. */}
      <div className="section-card wide-card">
        <div className="section-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Weekly roster</span>
          {/* Derived from the shift templates, not a hardcoded list — see
              buildLegend(). Wraps and stays right-aligned so a fourth or fifth
              kind cannot push the "Weekly roster" title out of the bar. */}
          <span
            className="roster-legend"
            role="list"
            aria-label="Shift types on this roster"
          >
            {legend.map((l) => (
              <span
                key={l.kind}
                role="listitem"
                className="roster-legend-item"
                title={[l.hint, l.names.length ? `Templates: ${l.names.join(", ")}` : ""].filter(Boolean).join(" ")}
              >
                <span
                  className="roster-legend-swatch"
                  style={{ background: l.style.bg, borderColor: l.style.border }}
                  aria-hidden="true"
                />
                {l.label}
                {l.names.length > 0 && (
                  <span className="roster-legend-names">{l.names.join(", ")}</span>
                )}
              </span>
            ))}
            {/* A rest day is the absence of a shift, so it has no template and
                is always shown. */}
            <span role="listitem" className="roster-legend-item">
              <span
                className="roster-legend-swatch"
                style={{ background: "#EDEFF2", borderColor: "#C3C9D2", borderStyle: "dashed" }}
                aria-hidden="true"
              />
              Rest day
            </span>
          </span>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-mute)" }}>Loading roster…</div>
        ) : grid.length === 0 ? (
          <div style={{ padding: 24, color: "var(--text-mute)" }}>
            No shifts or rest days for this week{filterSite ? ` at ${filterSite}` : ""}. Use "+ Assign shift" or "+ Assign rest day" to add one.
          </div>
        ) : (
          /* One table inside one scrollport, so the header cells ARE the column
             definitions and cannot drift from the body on either axis.
             sticky-head also switches to border-collapse:separate, since a
             collapsed border grid cannot position a th. */
          <div className="wide-scroll">
          <table className="sticky-head" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <SortableTh label="Employee No" sortKey="employeeNo" sort={sort} onSort={toggleSort} style={{ minWidth: 90 }} />
                <SortableTh label="Name" sortKey="guardName" sort={sort} onSort={toggleSort} style={{ minWidth: 130 }} />
                <SortableTh label="Site" sortKey="site" sort={sort} onSort={toggleSort} style={{ minWidth: 90 }} />
                {weekDays.map((d, i) => (
                  <th key={i} style={{ textAlign: "center", minWidth: 96 }}>
                    {DAY_LABELS[i]}<br /><span style={{ fontWeight: 400, color: "var(--text-mute)" }}>{d.getDate()}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, ri) => (
                <tr key={ri}>
                  <td data-label="Employee No">{row.employeeNo || "—"}</td>
                  <td data-label="Name"><strong>{row.guardName}</strong></td>
                  <td data-label="Site">{row.site || "—"}</td>
                  {weekDays.map((d, ci) => {
                    const iso = toISO(d);
                    const rest = row.rest[iso];
                    // A rest day and shift shouldn't coexist, but if legacy data
                    // has both, the rest day takes visual precedence.
                    const a = rest ? null : row.cells[iso];
                    const style = shiftCellStyle(a);
                    return (
                      <td key={ci} style={{ textAlign: "center", verticalAlign: "middle" }}>
                        {a ? (
                          <div
                            title={canEdit ? "Click to remove" : ""}
                            onClick={canEdit ? () => removeAssignment(a.id) : undefined}
                            style={{
                              cursor: canEdit ? "pointer" : "default",
                              background: style.bg, color: style.fg, border: `1px solid ${style.border}`,
                              borderRadius: 6, padding: "5px 6px", fontSize: 11, lineHeight: 1.3,
                            }}
                          >
                            <div style={{ fontWeight: 700 }}>{a.shiftName || "Shift"}</div>
                            {a.startTime && <div style={{ opacity: style.dim }}>{shiftTimes(a)}</div>}
                            {shiftKindOf(a) === "Straight" && (
                              <div style={{ opacity: 0.9, fontWeight: 700, letterSpacing: 0.3 }}>24H STRAIGHT</div>
                            )}
                          </div>
                        ) : rest ? (
                          <div
                            title={canEdit ? (rest.hasPrevShift ? `Click to restore ${rest.prevShiftName || "shift"}` : "Click to remove rest day") : "Rest day"}
                            onClick={canEdit ? () => removeRestDay(rest.id) : undefined}
                            style={{
                              cursor: canEdit ? "pointer" : "default",
                              background: "#EDEFF2", color: "var(--text-mute)",
                              border: "1px dashed #C3C9D2",
                              borderRadius: 6, padding: "5px 6px", fontSize: 10.5, fontWeight: 700,
                              letterSpacing: 0.3,
                            }}
                          >
                            REST DAY
                            {rest.hasPrevShift && <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: 0, marginTop: 2, opacity: 0.8 }}>↩ {rest.prevShiftName || "shift"}</div>}
                          </div>
                        ) : canEdit && row.employeeId ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "stretch" }}>
                            <button
                              title="Assign a shift on this day"
                              onClick={() => openAssignFor(row.employeeId, iso, row.site)}
                              style={{
                                background: "none", border: "1px dashed #D5DBE3", cursor: "pointer",
                                color: "var(--text-mute)", fontSize: 10, borderRadius: 5, padding: "3px 4px",
                              }}
                            >
                              + Assign shift
                            </button>
                            <button
                              title="Mark as rest day"
                              onClick={() => markRestDay(row.employeeId, iso)}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                color: "#AEB6C2", fontSize: 10, padding: 0,
                              }}
                            >
                              or rest day
                            </button>
                          </div>
                        ) : (
                          <span style={{ color: "#CBD2DC" }}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* The shared component, not a hand-written line: it reads the agency's
          name from System Settings. This page had its own copy with the name
          hardcoded, so it kept printing a former client's name on a footer that
          says CONFIDENTIAL while every other page had already been corrected. */}
      <ConfidentialFooter />

      {showAssign && (
        <AssignShiftModal
          employees={employees} templates={templates} weekDays={weekDays} siteList={siteOptions}
          prefill={assignPrefill}
          onClose={() => { setShowAssign(false); setAssignPrefill(null); }}
          onSaved={async () => { setShowAssign(false); setAssignPrefill(null); await loadWeek(); }}
        />
      )}
      {showRestDay && (
        <AssignRestDayModal
          employees={employees} weekDays={weekDays} siteList={siteOptions}
          onClose={() => setShowRestDay(false)}
          onSaved={async () => { setShowRestDay(false); await loadWeek(); }}
        />
      )}
      {showRemove && (
        <RemoveShiftsModal
          employees={employees}
          onClose={() => setShowRemove(false)}
          onDone={async () => { setShowRemove(false); await loadWeek(); }}
        />
      )}
      {showTemplates && (
        <ShiftTemplatesModal
          templates={templates}
          shiftNameList={shiftNameList}
          siteList={siteList}
          onClose={() => setShowTemplates(false)}
          onChanged={loadWeek}
        />
      )}
    </div>
  );
}

// --- Assign a guard to a shift on a date -----------------------------------
function AssignShiftModal({ employees, templates, weekDays, siteList = [], prefill = null, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState(prefill?.employeeId || "");
  const [shiftTemplateId, setShiftTemplateId] = useState("");
  const [site, setSite] = useState(prefill?.site || "");
  // Tracks whether the admin has manually edited Site. Once they have, we stop
  // auto-overwriting it when the guard selection changes. Pre-filled site counts
  // as touched so a guard change doesn't wipe it.
  const [siteTouched, setSiteTouched] = useState(!!prefill?.site);
  const firstDay = weekDays[0] ? toISO(weekDays[0]) : "";
  const lastDay = weekDays[6] ? toISO(weekDays[6]) : "";
  const [fromDate, setFromDate] = useState(prefill?.fromDate || firstDay);
  const [toDate, setToDate] = useState(prefill?.toDate || prefill?.fromDate || firstDay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  // When a guard is selected, auto-fill Site from their 201 File site — unless
  // the admin has already overridden it manually.
  function onGuardChange(id) {
    setEmployeeId(id);
    if (!siteTouched) {
      const emp = employees.find((e) => String(e.id) === String(id));
      setSite(emp?.site || "");
    }
  }

  // Merge the guard's own site into the options so it always appears even if it
  // isn't in this week's roster-derived list yet.
  const siteChoices = useMemo(() => {
    const set = new Set(siteList);
    if (site) set.add(site);
    return [...set].sort();
  }, [siteList, site]);

  async function save() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!fromDate) { setError("Please choose a start date."); return; }
    const end = toDate || fromDate;
    if (end < fromDate) { setError("The 'To' date can't be before the 'From' date."); return; }
    setSaving(true); setError(""); setResult("");
    try {
      const res = await api("/scheduling/assignments/range", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(employeeId),
          shiftTemplateId: shiftTemplateId ? Number(shiftTemplateId) : null,
          site: site || "",
          fromDate, toDate: end,
        }),
      });
      // If some days were skipped as duplicates, tell the user rather than fail.
      if (res.skipped > 0 && res.created === 0) {
        setError(`All ${res.skipped} day(s) in that range were already assigned.`);
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Assign shift</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Guard (from 201 File)</label>
            <select value={employeeId} onChange={(e) => onGuardChange(e.target.value)}>
              <option value="">— Select guard —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Shift</label>
            <select value={shiftTemplateId} onChange={(e) => setShiftTemplateId(e.target.value)}>
              <option value="">— Select shift —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.site ? ` · ${t.site}` : ""} ({shiftTimes(t)})</option>)}
            </select>
            {templates.length === 0 && <div className="hint" style={{ marginTop: 6, color: "var(--text-mute)", fontSize: 12 }}>No shift templates yet — add one via "Manage shifts" first.</div>}
          </div>
          <div className="form-field">
            <label>Site</label>
            <select value={site} onChange={(e) => { setSite(e.target.value); setSiteTouched(true); }}>
              <option value="">— Select site —</option>
              {siteChoices.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="hint" style={{ marginTop: 6, color: "var(--text-mute)", fontSize: 12 }}>
              Auto-filled from the guard's 201 File site — change it if they're covering a different site.
            </div>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="hint" style={{ color: "var(--text-mute)", fontSize: 12, marginTop: 8 }}>
            The shift will be assigned to the guard on every day from the start to the end date (inclusive). Leave "To" the same as "From" for a single day.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Assigning…" : "Assign"}</button>
        </div>
      </div>
    </div>
  );
}

// --- Assign rest day(s) to a guard over a date range ------------------------
function AssignRestDayModal({ employees, weekDays, siteList = [], onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState("");
  const [site, setSite] = useState("");
  const [siteTouched, setSiteTouched] = useState(false);
  const firstDay = weekDays[0] ? toISO(weekDays[0]) : "";
  const [fromDate, setFromDate] = useState(firstDay);
  const [toDate, setToDate] = useState(firstDay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function onGuardChange(id) {
    setEmployeeId(id);
    if (!siteTouched) {
      const emp = employees.find((e) => String(e.id) === String(id));
      setSite(emp?.site || "");
    }
  }

  const siteChoices = useMemo(() => {
    const set = new Set(siteList);
    if (site) set.add(site);
    return [...set].sort();
  }, [siteList, site]);

  async function save() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!fromDate) { setError("Please choose a start date."); return; }
    const end = toDate || fromDate;
    if (end < fromDate) { setError("The 'To' date can't be before the 'From' date."); return; }
    setSaving(true); setError("");
    try {
      const res = await api("/scheduling/rest-days/range", {
        method: "POST",
        body: JSON.stringify({ employeeId: Number(employeeId), site: site || "", fromDate, toDate: end }),
      });
      if (res.skipped > 0 && res.created === 0) {
        setError(`All ${res.skipped} day(s) in that range were already marked as rest days.`);
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Assign rest day</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Guard (from 201 File)</label>
            <select value={employeeId} onChange={(e) => onGuardChange(e.target.value)}>
              <option value="">— Select guard —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Site</label>
            <select value={site} onChange={(e) => { setSite(e.target.value); setSiteTouched(true); }}>
              <option value="">— Select site —</option>
              {siteChoices.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="hint" style={{ marginTop: 6, color: "var(--text-mute)", fontSize: 12 }}>
              Auto-filled from the guard's 201 File site.
            </div>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="hint" style={{ color: "var(--text-mute)", fontSize: 12, marginTop: 8 }}>
            Every day from the start to the end date (inclusive) will be marked as a rest day. Leave "To" the same as "From" for a single day.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? "Saving…" : "Assign rest day"}</button>
        </div>
      </div>
    </div>
  );
}

// --- Remove shifts by guard + date range ------------------------------------
function RemoveShiftsModal({ employees, onClose, onDone }) {
  const [employeeId, setEmployeeId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (!employeeId) { setError("Please select a guard."); return; }
    if (!fromDate) { setError("Please choose a start date."); return; }
    const end = toDate || fromDate;
    if (end < fromDate) { setError("The 'To' date can't be before the 'From' date."); return; }
    if (!await confirm("Remove all shift assignments for this guard within the selected date range? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      const res = await api("/scheduling/assignments/remove-range", {
        method: "POST",
        body: JSON.stringify({ employeeId: Number(employeeId), fromDate, toDate: end }),
      });
      toast.success(`Removed ${res.removed} shift assignment(s).`);
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Remove shifts</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="form-field">
            <label>Guard (from 201 File)</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">— Select guard —</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.employeeNo ? ` (${emp.employeeNo})` : ""}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>From date</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
            </div>
            <div className="form-field">
              <label>To date</label>
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="hint" style={{ color: "var(--text-mute)", fontSize: 12, marginTop: 8 }}>
            All of this guard's shifts from the start to the end date (inclusive) will be removed.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? "Removing…" : "Remove shifts"}</button>
        </div>
      </div>
    </div>
  );
}

// --- Manage shift templates -------------------------------------------------
function ShiftTemplatesModal({ templates, shiftNameList, siteList, onClose, onChanged }) {
  const [add, setAdd] = useState({ name: "", startTime: "", endTime: "", crossesMidnight: false, shiftKind: "", startTime2: "", endTime2: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addTemplate() {
    if (!add.name.trim()) { setError("Please select a shift name."); return; }
    if (!add.startTime || !add.endTime) { setError("Start and end times are required."); return; }
    setSaving(true); setError("");
    try {
      await api("/scheduling/templates", { method: "POST", body: JSON.stringify(add) });
      setAdd({ name: "", startTime: "", endTime: "", crossesMidnight: false, shiftKind: "", startTime2: "", endTime2: "" });
      await onChanged();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function removeTemplate(id) {
    if (!await confirm("Deactivate this shift template? Existing roster entries keep their times.")) return;
    try { await api(`/scheduling/templates/${id}`, { method: "DELETE" }); await onChanged(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>Shift templates</h2><button className="modal-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          {error && <div className="purpose-bar" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "#f0c9c9", color: "var(--red)" }}>{error}</div>}
          <div className="entry-list" style={{ marginBottom: 16 }}>
            {templates.length === 0 && <div className="empty-hint">No shift templates yet.</div>}
            {templates.map((t) => (
              <div className="entry-card" key={t.id}>
                <div className="entry-top">
                  <div>
                    <div className="entry-title">
                      {t.name}
                      {shiftKindOf(t) === "Straight"
                        ? <span className="badge badge-progress" style={{ marginLeft: 6 }}>straight duty 24h</span>
                        : shiftKindOf(t) === "Broken"
                        ? <span className="badge badge-progress" style={{ marginLeft: 6 }}>broken shift</span>
                        : t.crossesMidnight && <span className="badge badge-closed" style={{ marginLeft: 6 }}>overnight</span>}
                    </div>
                    <div className="entry-meta">{[t.site, shiftTimes(t)].filter(Boolean).join("  ·  ")}</div>
                  </div>
                  <button className="entry-remove" onClick={() => removeTemplate(t.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="add-row">
            <div className="form-field"><label>Shift name</label>
              <select value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })}>
                <option value="">— Select shift —</option>
                {/* keep an existing custom value visible if not in the list */}
                {add.name && !shiftNameList.includes(add.name) && <option value={add.name}>{add.name}</option>}
                {shiftNameList.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="form-field"><label>Start</label><input type="time" value={add.startTime} onChange={(e) => setAdd({ ...add, startTime: e.target.value })} /></div>
            <div className="form-field"><label>End</label><input type="time" value={add.endTime} onChange={(e) => setAdd({ ...add, endTime: e.target.value })} /></div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={add.crossesMidnight} onChange={(e) => setAdd({ ...add, crossesMidnight: e.target.checked })} /> Overnight
            </label>
            {/* The second stretch of a BROKEN (split) shift. Filling both makes
                the template a broken shift; the server derives the kind from
                their presence, so the Kind picker below need not be touched.
                A second range starting at or before the first means the next
                day, which is what 06:00-12:00 then 00:00-06:00 describes. */}
            <div className="form-field"><label>Split start <span className="hint">optional</span></label>
              <input type="time" value={add.startTime2} onChange={(e) => setAdd({ ...add, startTime2: e.target.value })} />
            </div>
            <div className="form-field"><label>Split end <span className="hint">optional</span></label>
              <input type="time" value={add.endTime2} onChange={(e) => setAdd({ ...add, endTime2: e.target.value })} />
            </div>
            {/* Left blank the server derives it from the times, which is right
                almost always. Stated explicitly only when a tour that looks
                like a night shift is really a 24-hour straight duty. */}
            <div className="form-field"><label>Kind</label>
              <select value={add.shiftKind} onChange={(e) => setAdd({ ...add, shiftKind: e.target.value })}>
                <option value="">Derive from the times</option>
                <option value="Day">Day</option>
                <option value="Night">Night</option>
                <option value="Straight">Straight duty (24h)</option>
                <option value="Broken">Broken shift (split)</option>
              </select>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-gold" onClick={addTemplate} disabled={saving}>{saving ? "Adding…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
