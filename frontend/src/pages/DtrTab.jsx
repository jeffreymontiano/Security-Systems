import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiBlobUrl, downloadBlobUrl } from "../api/client";
import { useSettings } from "../context/SettingsContext";
import { halvesEndingNow, periodTitle } from "../lib/payrollPeriods";
import { buildDtrWorkbook } from "./dtrWorkbook";

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
// worked. Toned so an exception is visible without reading the legend. S / RTU /
// T are disciplinary penalties, sourced from disciplinary_cases.
const NOTE_TONE = {
  DO: { bg: "#E7EAF0", fg: "#3C4A60" },
  A: { bg: "#FBE3E1", fg: "#912018" },
  S: { bg: "#FDE7D2", fg: "#8A4B00" },
  RTU: { bg: "#FFF1D6", fg: "#8A5A00" },
  T: { bg: "#F6D9D6", fg: "#7A1710" },
  REL: { bg: "#E3F0FB", fg: "#0B4F82" },
  SR: { bg: "#F3E8FB", fg: "#5B2A86" },
};
const LEAVE_TONE = { bg: "#E6F4EA", fg: "#1E6B3A" };

// ONE <td> per cell, always. A <td> inside a <td> is invalid, and the parser
// hoists it into extra sibling cells — measured at 463 cells reading "12" where
// only 239 duties exist.
//
// `flagged` marks a penalty that fell on a day the guard actually punched in: a
// red ring plus a "!" so the anomaly reads off the grid, and it is also listed
// below the sheet.
function Cell({ value, note, band, flagged }) {
  const base = { textAlign: "center", padding: "2px 0" };
  if (value) {
    return (
      <td style={{ ...base, fontWeight: 700, fontSize: 11,
        background: band === "NS" ? "#0B2545" : "#FFF7CC",
        color: band === "NS" ? "#fff" : "#1a1a1a" }}>{value}</td>
    );
  }
  if (note) {
    const tone = NOTE_TONE[note] || LEAVE_TONE;
    return (
      <td style={{ ...base, fontSize: 9.5, fontWeight: 600,
        background: tone.bg, color: tone.fg,
        boxShadow: flagged ? "inset 0 0 0 2px var(--red)" : undefined }}
        title={flagged ? "Penalty on a day the guard punched in — see the list below" : undefined}>
        {note}{flagged ? <sup style={{ color: "var(--red)" }}>!</sup> : null}
      </td>
    );
  }
  return <td style={base} />;
}

function SiteGrid({ site, days }) {
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
                  <Cell key={c.date} value={c.ds} note={!worked(c) ? c.note : null} band="DS"
                    flagged={!worked(c) && c.flagged} />
                ))}
                <td style={{ textAlign: "center", fontWeight: 600 }}>{g.ds}</td>
                <td rowSpan={2} style={{ textAlign: "center", color: "var(--text-mute)" }} />
                <td rowSpan={2} style={{ textAlign: "center", fontWeight: 700 }}>{g.days}</td>
                <td rowSpan={2} style={{ textAlign: "center", fontWeight: 700 }}>{g.hours}</td>
              </tr>,
              <tr key={`${g.guardName}-ns`}>
                <td style={{ fontSize: 8.5, color: "var(--text-mute)", textAlign: "center" }}>NS</td>
                {g.cells.map((c) => (
                  <Cell key={c.date} value={c.ns} note={null} band="NS" />
                ))}
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

      {site.conflicts && site.conflicts.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--red)" }}>
          <strong>Penalty on a worked day</strong> — a guard punched in on a day their
          penalty bars. Verify before issuing:
          <ul style={{ margin: "4px 0 0 18px", color: "var(--text)" }}>
            {site.conflicts.map((x, i) => (
              <li key={i}>{x.guard} — {x.date} ({x.code})</li>
            ))}
          </ul>
        </div>
      )}

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
  const { settings } = useSettings();
  const periods = useMemo(() => halvesEndingNow(CUTOFF_COUNT), []);
  const [periodIdx, setPeriodIdx] = useState(0);
  const [siteFilter, setSiteFilter] = useState("");
  const [dtr, setDtr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const period = periods[periodIdx];

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const d = await api(`/attendance-reports/dtr?from=${period.from}&to=${period.to}`);
      setDtr(d);
    } catch (e) {
      setError(e.message || "Could not load the DTR.");
      setDtr(null);
    } finally {
      setLoading(false);
    }
  }, [period.from, period.to]);

  useEffect(() => { load(); }, [load]);

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
    // Group the punch-conflict flags onto the detachment they belong to, so each
    // sheet lists its own.
    const bySite = new Map();
    for (const c of dtr.penaltyConflicts || []) {
      if (!bySite.has(c.site)) bySite.set(c.site, []);
      bySite.get(c.site).push(c);
    }
    const withSignatory = dtr.sites.map((s) => ({
      ...s,
      preparedName: dtr.branding?.preparedName || "",
      preparedTitle: dtr.branding?.preparedTitle || "",
      conflicts: bySite.get(s.site) || [],
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
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-mute)" }}>
          Suspension, RTU and Termination come from the Disciplinary module. A penalty on a
          day the guard punched in is ringed in red and listed under that detachment.
        </div>
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
        <SiteGrid key={s.site} site={s} days={dtr.days} />
      ))}
    </div>
  );
}
