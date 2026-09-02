import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useSettings } from "../context/SettingsContext";
import useModulePerms from "../lib/modulePerms";
import { halvesEndingNow, periodTitle } from "../lib/payrollPeriods";
import { buildDtrWorkbook } from "./dtrWorkbook";
import { toast } from "../lib/toast";
import { confirm } from "../lib/confirm";
import { prompt } from "../lib/prompt";

/**
 * Daily Time Record — one grid per detachment for one semi-monthly cutoff.
 *
 * Everything on screen comes from GET /attendance-reports/dtr, which reads the
 * same computeReport() the register, the reports and payroll read. Nothing is
 * recomputed here: a second derivation would eventually disagree with the
 * register about a day, on a document the client countersigns.
 *
 * Each guard occupies TWO rows — DS above, NS below — which is how the agency's
 * own approved DTRs lay it out, and what lets one guard hold two duties on one
 * date (a straight duty fills both bands) without the cells contending.
 */

const CUTOFF_COUNT = 4;   // "latest 4", per the agency's requirement

// Zero-duty codes never count toward Days or Hours; they explain a day nobody
// worked. Toned so an exception is visible without reading the legend.
const NOTE_TONE = {
  DO: { bg: "#E7EAF0", fg: "#3C4A60" },
  A: { bg: "#FBE3E1", fg: "#912018" },
  RTU: { bg: "#FFF1D6", fg: "#8A5A00" },
  REL: { bg: "#E3F0FB", fg: "#0B4F82" },
  SR: { bg: "#F3E8FB", fg: "#5B2A86" },
};
const LEAVE_TONE = { bg: "#E6F4EA", fg: "#1E6B3A" };

// ONE <td> per cell, always. The double-click handler and tooltip are passed in
// rather than the caller wrapping this in another <td>: a <td> inside a <td> is
// invalid, and the parser hoists it into extra sibling cells — measured at 463
// cells reading "12" where only 239 duties exist.
function Cell({ value, note, band, ...cellProps }) {
  const base = { textAlign: "center", padding: "2px 0" };
  if (value) {
    return (
      <td {...cellProps} style={{ ...base, fontWeight: 700, fontSize: 11,
        background: band === "NS" ? "#0B2545" : "#FFF7CC",
        color: band === "NS" ? "#fff" : "#1a1a1a" }}>{value}</td>
    );
  }
  if (note) {
    const tone = NOTE_TONE[note] || LEAVE_TONE;
    return (
      <td {...cellProps} style={{ ...base, fontSize: 9.5, fontWeight: 600,
        background: tone.bg, color: tone.fg }}>{note}</td>
    );
  }
  return <td {...cellProps} style={base} />;
}

function SiteGrid({ site, days, canEditRtu, onRtu, onRemoveRtu, rtuByKey }) {
  return (
    <div className="section-card" style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>
          DETACHMENT/POST: {site.detachmentName}
          {!site.mapped && (
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: "var(--red)" }}>
              not mapped to a client — showing the roster site name
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-mute)" }}>
          COMPANY NAME: {site.clientName || <em>— no client mapped —</em>}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ background: "#EEF2F7" }}>
            <th rowSpan={2} style={{ width: 26, fontSize: 10 }}>No.</th>
            <th rowSpan={2} style={{ textAlign: "left", minWidth: 150, fontSize: 10 }}>Name</th>
            <th rowSpan={2} style={{ width: 26, fontSize: 10 }}>Sh</th>
            {days.map((d) => (
              <th key={d.date} style={{ fontSize: 8.5, fontWeight: 600, padding: "1px 0",
                color: d.weekday === "SUN" ? "var(--red)" : "var(--text-mute)" }}>{d.weekday}</th>
            ))}
            <th rowSpan={2} style={{ width: 30, fontSize: 10 }}>DS</th>
            <th rowSpan={2} style={{ width: 30, fontSize: 10 }}>NS</th>
            <th rowSpan={2} style={{ width: 36, fontSize: 10 }}>Days</th>
            <th rowSpan={2} style={{ width: 42, fontSize: 10 }}>Hours</th>
          </tr>
          <tr style={{ background: "#2F4A6D", color: "#fff" }}>
            {days.map((d) => (
              <th key={d.date} style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 0" }}>{d.day}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {site.guards.map((g, i) => {
            const worked = (c) => Boolean(c.ds || c.ns);
            return [
              <tr key={`${g.guardName}-ds`} style={{ borderTop: "1px solid var(--border)" }}>
                <td rowSpan={2} style={{ textAlign: "center", fontSize: 10 }}>{i + 1}</td>
                <td rowSpan={2} style={{ fontWeight: 600 }}>{g.guardName}</td>
                <td style={{ fontSize: 8.5, color: "var(--text-mute)", textAlign: "center" }}>DS</td>
                {g.cells.map((c) => (
                  <Cell key={c.date} value={c.ds} note={!worked(c) ? c.note : null} band="DS" />
                ))}
                <td style={{ textAlign: "center", fontWeight: 600 }}>{g.ds}</td>
                <td rowSpan={2} style={{ textAlign: "center", color: "var(--text-mute)" }} />
                <td rowSpan={2} style={{ textAlign: "center", fontWeight: 700 }}>{g.days}</td>
                <td rowSpan={2} style={{ textAlign: "center", fontWeight: 700 }}>{g.hours}</td>
              </tr>,
              <tr key={`${g.guardName}-ns`}>
                <td style={{ fontSize: 8.5, color: "var(--text-mute)", textAlign: "center" }}>NS</td>
                {g.cells.map((c) => {
                  const rtu = rtuByKey.get(`${g.guardName}|${c.date}`);
                  return (
                    <Cell key={c.date} value={c.ns} note={null} band="NS"
                      onDoubleClick={canEditRtu
                        ? () => (rtu ? onRemoveRtu(rtu) : onRtu(g.guardName, c.date, site.site))
                        : undefined}
                      title={canEditRtu
                        ? (rtu ? `RTU: ${rtu.reason} — double-click to remove` : "Double-click to mark Return To Unit")
                        : undefined} />
                  );
                })}
                <td style={{ textAlign: "center", fontWeight: 600 }}>{g.ns}</td>
              </tr>,
            ];
          })}
          {Array.from({ length: site.blankSlots }).map((_, i) => (
            <tr key={`blank-${i}`} style={{ borderTop: "1px solid var(--border)", height: 26 }}>
              <td style={{ textAlign: "center", fontSize: 10, color: "var(--text-mute)" }}>
                {site.guards.length + i + 1}
              </td>
              <td colSpan={days.length + 2} />
              <td style={{ textAlign: "center", color: "var(--text-mute)" }}>0</td>
              <td style={{ textAlign: "center", color: "var(--text-mute)" }}>0</td>
              <td style={{ textAlign: "center", color: "var(--text-mute)" }}>0</td>
            </tr>
          ))}
          <tr style={{ background: "#EEF2F7", fontWeight: 700, borderTop: "2px solid var(--border)" }}>
            <td colSpan={3} style={{ fontSize: 10 }}>TOTAL man-hours</td>
            {site.perDayHours.map((h, i) => (
              <td key={i} style={{ textAlign: "center", fontSize: 10 }}>{h}</td>
            ))}
            <td style={{ textAlign: "center" }}>{site.totals.ds}</td>
            <td style={{ textAlign: "center" }}>{site.totals.ns}</td>
            <td style={{ textAlign: "center", color: "var(--red)" }}>{site.totals.days}</td>
            <td style={{ textAlign: "center", color: "var(--red)" }}>{site.totals.hours}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 40, marginTop: 14, fontSize: 12 }}>
        <div>
          <div style={{ color: "var(--text-mute)" }}>Checked by:</div>
          <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", minWidth: 190, fontWeight: 700 }}>
            {site.preparedName || " "}
          </div>
          <div style={{ fontStyle: "italic", color: "var(--text-mute)", fontSize: 11 }}>
            {site.preparedTitle || " "}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-mute)" }}>Certified correct by:</div>
          <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", minWidth: 190, fontWeight: 700 }}>
            {site.repName || " "}
          </div>
          <div style={{ fontStyle: "italic", color: "var(--text-mute)", fontSize: 11 }}>
            {site.repTitle || (site.repName ? " " : "set the client's representative in System Settings")}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DtrTab() {
  const perm = useModulePerms();
  const { settings } = useSettings();
  const periods = useMemo(() => halvesEndingNow(CUTOFF_COUNT), []);
  const [periodIdx, setPeriodIdx] = useState(0);
  const [siteFilter, setSiteFilter] = useState("");
  const [dtr, setDtr] = useState(null);
  const [rtu, setRtu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const period = periods[periodIdx];
  // The allowlist that governs correcting a punch's site also governs RTU. The
  // UI copy only decides whether to offer the control; the route re-checks.
  const canEditRtu = Boolean(perm.edit);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [d, r] = await Promise.all([
        api(`/attendance-reports/dtr?from=${period.from}&to=${period.to}`),
        api(`/attendance-reports/rtu?from=${period.from}&to=${period.to}`).catch(() => []),
      ]);
      setDtr(d);
      setRtu(Array.isArray(r) ? r : []);
    } catch (e) {
      setError(e.message || "Could not load the DTR.");
      setDtr(null);
    } finally {
      setLoading(false);
    }
  }, [period.from, period.to]);

  useEffect(() => { load(); }, [load]);

  const rtuByKey = useMemo(
    () => new Map(rtu.map((r) => [`${r.guardName}|${r.dutyDate}`, r])),
    [rtu]
  );

  async function markRtu(guardName, dutyDate, site) {
    // prompt() returns null on CANCEL, exactly like window.prompt — resolving ""
    // instead would read as a deliberate blank reason, which the route refuses.
    const why = await prompt(
      `Return to unit — ${guardName} on ${dutyDate}.
Reason (health or disciplinary); it prints on the DTR the client signs.`,
      "",
      { title: "Return To Unit", confirmLabel: "Record" }
    );
    if (why === null || !String(why).trim()) return;
    setBusy(true);
    try {
      await api("/attendance-reports/rtu", {
        method: "POST",
        body: JSON.stringify({ guardName, dutyDate, site, reason: String(why).trim() }),
      });
      toast.success(`Return to unit recorded for ${guardName}.`);
      await load();
    } catch (e) {
      setError(e.message || "Could not record the return to unit.");
    } finally { setBusy(false); }
  }

  async function removeRtu(rec) {
    if (!(await confirm(`Remove the return-to-unit record for ${rec.guardName} on ${rec.dutyDate}?`))) return;
    setBusy(true);
    try {
      await api(`/attendance-reports/rtu/${rec.id}`, { method: "DELETE" });
      toast.success("Return to unit removed.");
      await load();
    } catch (e) {
      setError(e.message || "Could not remove the record.");
    } finally { setBusy(false); }
  }

  async function downloadPdf() {
    setBusy(true);
    try {
      const url = await apiBlobUrl(`/attendance-reports/dtr.pdf?from=${period.from}&to=${period.to}`);
      downloadBlobUrl(url, `DTR-${period.from}_${period.to}.pdf`);
    } catch (e) {
      setError(e.message || "Could not download the PDF.");
    } finally { setBusy(false); }
  }

  function downloadExcel() {
    if (!dtr) return;
    setBusy(true);
    import("xlsx").then((XLSX) => {
      const wb = buildDtrWorkbook(XLSX, dtr, {
        companyName: settings?.companyName || "",
        preparedName: dtr.branding?.preparedName || "",
        preparedTitle: dtr.branding?.preparedTitle || "",
      });
      XLSX.writeFile(wb, `DTR-${period.from}_${period.to}.xlsx`);
    }).catch((e) => setError(e.message || "Could not build the workbook."))
      .finally(() => setBusy(false));
  }

  const sites = useMemo(() => {
    if (!dtr) return [];
    const withSignatory = dtr.sites.map((s) => ({
      ...s,
      preparedName: dtr.branding?.preparedName || "",
      preparedTitle: dtr.branding?.preparedTitle || "",
    }));
    return siteFilter ? withSignatory.filter((s) => s.site === siteFilter) : withSignatory;
  }, [dtr, siteFilter]);

  return (
    <div style={{ margin: "16px 32px 0" }}>
      <div className="section-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="form-field" style={{ minWidth: 210 }}>
            <label htmlFor="dtr-cutoff">Cut-off</label>
            <select id="dtr-cutoff" value={periodIdx} onChange={(e) => setPeriodIdx(Number(e.target.value))}>
              {periods.map((p, i) => (
                <option key={p.from} value={i}>{periodTitle(p)}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ minWidth: 190 }}>
            <label htmlFor="dtr-site">Detachment</label>
            <select id="dtr-site" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
              <option value="">All detachments</option>
              {(dtr?.sites || []).map((s) => (
                <option key={s.site} value={s.site}>{s.detachmentName}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-outline btn-sm" onClick={load} disabled={loading || busy}>Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={downloadPdf} disabled={loading || busy || !dtr}>
            Download PDF
          </button>
          <button className="btn btn-secondary btn-sm" onClick={downloadExcel} disabled={loading || busy || !dtr}>
            Download Excel
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-mute)" }}>
          {(dtr?.legend || []).map(([code, meaning]) => (
            <span key={code} style={{ marginRight: 14, whiteSpace: "nowrap" }}>
              <strong>{code}</strong> = {meaning}
            </span>
          ))}
        </div>
        {canEditRtu && (
          <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-mute)" }}>
            Double-click a guard's <strong>NS</strong> cell to mark or clear a Return To Unit for that day.
          </div>
        )}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
      {dtr?.problems?.length > 0 && (
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>
          <strong>This DTR does not foot.</strong> Do not issue it until these are resolved:
          <ul style={{ margin: "6px 0 0 18px" }}>
            {dtr.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {loading && <div className="section-card">Loading…</div>}
      {!loading && dtr && sites.length === 0 && (
        <div className="section-card" style={{ color: "var(--text-mute)" }}>
          No attendance recorded for this cut-off.
        </div>
      )}
      {!loading && sites.map((s) => (
        <SiteGrid
          key={s.site}
          site={s}
          days={dtr.days}
          canEditRtu={canEditRtu}
          rtuByKey={rtuByKey}
          onRtu={markRtu}
          onRemoveRtu={removeRtu}
        />
      ))}
    </div>
  );
}
