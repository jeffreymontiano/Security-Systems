import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import KpiCard from "../components/KpiCard";
import {
  CHART, OPS_ANALYTICS, formatBucketLabel, sameStatus, statusSeries,
  windowFor, refOptions, defaultRef, windowBucketLabel, windowBucketFull,
  lineChartGeometry, stackedBarGeometry, hBarGeometry,
} from "./dashboardShared";

/**
 * The analytics block above each operational-records tab: three KPI cards, a
 * trend chart, and a by-site breakdown.
 *
 * One component for all six tabs, configured by OPS_ANALYTICS — the tabs differ
 * in what counts as "good" and whether the headline is a rate or a total, not
 * in shape.
 *
 * Every figure comes from the SQL aggregation endpoints, never from the records
 * table on screen: GET /ops/:type caps at 200 rows, so a count taken from the
 * list would describe a truncated window while presenting itself as the period
 * total.
 *
 * The KPIs and the by-site bars are scoped to the SAME window the trend draws —
 * `from` is the first bucket the trend returned — so a reader comparing the
 * cards against the chart is comparing like with like.
 */
const PERIODS = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "yearly", label: "Yearly" },
];

// `revision` is bumped by OpsRecordsTable after every add, edit and delete.
// Without it the cards, the trend and the by-site bars kept showing the figures
// from before the change while the table right below them updated — the block
// only refetched when its OWN filters moved, so a record added under it was
// invisible until someone pressed Refresh. Same counter pattern the Assets,
// Billing, Payroll and Security Reports shells use to refresh a tab without
// remounting it and losing its filters.
export default function OpsAnalytics({ cfg, sites = [], revision = 0 }) {
  const spec = OPS_ANALYTICS[cfg.type];
  const [site, setSite] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [trend, setTrend] = useState(null);     // buckets for the chart
  const [summary, setSummary] = useState(null); // totals for the cards + by-site
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // [{value, isCompliant}] for this tab's status list, or null until it loads.
  const [statusList, setStatusList] = useState(null);
  // Count tabs only: which week / month / quarter / year is being reported on.
  const windowed = !!(spec && spec.windowed);
  const [ref, setRef] = useState(() => (spec && spec.windowed ? defaultRef("monthly") : ""));

  const load = useCallback(async () => {
    if (!spec) return;
    setLoading(true); setError("");
    try {
      const q = new URLSearchParams({ period });
      if (site) q.set("site", site);

      // A windowed tab asks for every bucket in its reporting window, including
      // the empty ones, so the chart covers the whole month rather than only the
      // days that happen to have records.
      const win = windowed ? windowFor(period, ref) : null;
      if (win) { q.set("from", win.from); q.set("to", win.to); q.set("bucket", win.unit); }

      // The stacked trend needs the status dimension; the others only need a
      // count (or a sum, for the numeric tabs).
      const stacked = spec.trend === "stacked";
      const rows = await api(`/ops/${cfg.type}/${stacked ? "timeseries-by-status" : "timeseries"}?${q}`);

      const buckets = stacked
        ? groupByBucket(rows)
        : rows.map((r) => ({
            bucket: r.bucket,
            // pg returns SUM() as a string; Number() or the chart scales by
            // lexicographic order and draws nonsense.
            value: spec.kind === "total" ? Number(r.total_value || 0) : r.count,
            count: r.count,
          }));

      // The cards and the by-site bars read the SAME window the chart drew, so
      // the total can never describe a different range from the bars above it.
      const sq = new URLSearchParams();
      if (site) sq.set("site", site);
      if (win) { sq.set("from", win.from); sq.set("to", win.to); }
      else if (buckets.length) sq.set("from", buckets[0].bucket);
      setSummary(await api(`/ops/${cfg.type}/summary?${sq}`));
      setTrend(buckets);
    } catch (e) {
      setError(e.message); setTrend(null); setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [cfg.type, site, period, spec, windowed, ref, revision]);

  useEffect(() => { if (windowed) setRef(defaultRef(period)); }, [period, windowed]);

  useEffect(() => { load(); }, [load]);

  // Which values count as compliant is a property of the LIST now, not of a
  // constant in this file. Fetched here rather than taken from the page's
  // dropdown lists, which carry the values but not their flags.
  useEffect(() => {
    let cancelled = false;
    if (!cfg.statusListKey) { setStatusList([]); return undefined; }
    api(`/meta/dropdown/${cfg.statusListKey}/detail`)
      .then((rows) => { if (!cancelled) setStatusList(rows); })
      .catch(() => { if (!cancelled) setStatusList([]); });
    return () => { cancelled = true; };
  }, [cfg.statusListKey]);

  // `spec` carries the SHAPE of the tab; the classification now comes from the
  // list. Merged into one object so every consumer below keeps reading
  // `spec.goodStatuses` and nothing else had to change.
  const statusOpts = useMemo(() => (statusList || []).map((o) => o.value), [statusList]);
  const effSpec = useMemo(() => (spec
    ? { ...spec, statusList: statusList || [],
        goodStatuses: (statusList || []).filter((o) => o.isCompliant).map((o) => o.value) }
    : spec), [spec, statusList]);

  // Until the list arrives there is nothing to classify BY, and rendering then
  // would show 0% for one frame - the exact wrong number this stage exists to
  // stop printing.
  const classReady = !spec || spec.kind !== "rate" || statusList !== null;

  const drift = useMemo(() => detectDrift(effSpec, summary, statusOpts, classReady), [effSpec, summary, statusOpts, classReady]);
  const kpis = useMemo(() => (summary ? buildKpis(effSpec, summary, trend, drift, period) : []), [effSpec, summary, trend, drift, period]);

  if (!spec) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="section-divider" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}>Analytics</span>
        <select value={site} onChange={(e) => setSite(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", textTransform: "none", fontWeight: 400 }}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", textTransform: "none", fontWeight: 400 }}>
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {/* Third filter, count tabs only: WHICH week/month/quarter/year. The
            other four tabs read Period as a bucket size and have no window to
            choose, so they do not get this control. */}
        {windowed && (
          <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Reference period"
                  style={{ fontSize: 12, padding: "4px 8px", textTransform: "none", fontWeight: 400 }}>
            {refOptions(period).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      {error && <div className="empty-hint">{error}</div>}
      {!error && (loading || !classReady) && <div className="empty-hint">Loading analytics…</div>}

      {!error && !loading && classReady && summary && (
        <>
          {drift && <DriftNotice drift={drift} spec={effSpec} cfg={cfg} />}

          <div className="kpi-grid ops-analytics-kpis" data-cols="3" style={{ margin: "0 0 16px" }}>
            {kpis.map((k) => (
              <KpiCard key={k.label} label={k.label} value={k.value} note={k.note} tone={k.tone} icon={k.icon} />
            ))}
          </div>

          {/* When the classification cannot be trusted, the charts drop the
              good/bad split and show plain counts. Leaving them split would put
              a confident navy-vs-red breakdown directly beside a card saying the
              figure cannot be calculated — two opposite claims on one screen,
              and the chart is the more persuasive of the two. Counting records
              needs no classification, so that much is still honest. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <ChartPanel title={drift ? `${effSpec.trendTitle} (count only)` : effSpec.trendTitle}>
              {drift
                ? <LineTrend buckets={countOnly(trend, effSpec)} period={period} spec={effSpec} />
                : effSpec.trend === "stacked"
                  ? <StackedTrend buckets={trend} period={period} spec={effSpec} />
                  : effSpec.windowed
                    ? <WindowTrend buckets={trend} period={period} spec={effSpec} site={site} />
                    : <LineTrend buckets={trend} period={period} spec={effSpec} />}
            </ChartPanel>
            <ChartPanel title="By site">
              <SiteBars summary={summary} spec={drift ? { ...effSpec, stackedSites: false } : effSpec} />
            </ChartPanel>
          </div>
        </>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

/**
 * Collapse a stacked tab's per-status buckets to a plain count per bucket, for
 * the drift fallback. A line chart of "how many records" says nothing about
 * compliance, which is the point: it is the most that can be claimed while the
 * list and the data disagree.
 */
function countOnly(buckets, spec) {
  if (!buckets) return [];
  if (spec.trend !== "stacked") return buckets;
  return buckets.map((b) => ({
    bucket: b.bucket,
    value: Object.values(b.counts || {}).reduce((n, c) => n + c, 0),
  }));
}

// [{bucket,status,count}] -> [{bucket, counts:{status:count}}], oldest first.
function groupByBucket(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.bucket)) map.set(r.bucket, { bucket: r.bucket, counts: {} });
    map.get(r.bucket).counts[r.status] = r.count;
  }
  return [...map.values()];
}

/**
 * Has the classification drifted away from the list it depends on?
 *
 * Two ways this goes wrong, and neither used to say anything at all — the page
 * simply reported 0% and coloured everything red, which reads as "the sites are
 * failing" rather than "this figure is meaningless":
 *
 *  - the status this tab classifies by is no longer in the list, so NO record
 *    can be counted as compliant; or
 *  - individual records hold a status the list no longer offers.
 *
 * Returns null when it cannot tell. An empty list means the dropdowns have not
 * loaded yet, and reporting that as drift would put a warning on a page that is
 * merely still loading.
 */
function detectDrift(spec, summary, statusOpts, classReady = true) {
  if (!spec || spec.kind !== "rate" || !summary || !classReady) return null;
  if (!statusOpts || !statusOpts.length) return null;

  // The good statuses now COME FROM the list, so they can no longer be missing
  // from it — that failure is gone by construction. What replaces it is a list
  // where nothing is ticked as compliant, which is equally unclassifiable and
  // is what an administrator sees if they clear the flags.
  const noneCompliant = !(spec.goodStatuses || []).length;

  // '(none)' is the SQL placeholder for a blank status. A record with nothing
  // recorded is a gap in the data, not a drifted list, and flagging it here
  // would cry wolf on older rows that legitimately have none.
  const unknown = Object.entries(summary.byStatus || {})
    .filter(([s]) => s !== "(none)" && !statusOpts.some((o) => sameStatus(o, s)))
    .map(([status, count]) => ({ status, count }));

  if (!noneCompliant && !unknown.length) return null;
  return { noneCompliant, unknown, records: unknown.reduce((n, u) => n + u.count, 0) };
}

function DriftNotice({ drift, spec, cfg }) {
  const listName = cfg.statusLabel || "status";
  return (
    <div
      className="empty-hint ops-analytics-drift"
      style={{ border: "1px solid var(--red)", borderLeftWidth: 4, borderRadius: 6,
               padding: "10px 12px", margin: "0 0 14px", color: "var(--text)", fontStyle: "normal" }}
    >
      <strong>This figure cannot be calculated.</strong>{" "}
      {drift.noneCompliant && (
        <>
          No value in the {listName} list is marked as compliant, so no record
          can be counted as such. Tick the compliant value in Manage Lists.{" "}
        </>
      )}
      {drift.records > 0 && (
        <>
          {drift.records} record{drift.records === 1 ? " holds" : "s hold"} a {listName.toLowerCase()} that
          is not in the list: {drift.unknown.map((u) => `"${u.status}" (${u.count})`).join(", ")}.{" "}
          Correct the list or those records in Manage Lists, then reload.
        </>
      )}
    </div>
  );
}

/**
 * The three cards. A rate tab leads with the percentage that matters; a count
 * tab leads with the total, because "83% of visitors" means nothing.
 *
 * The exceptions card is always the danger tone — it is the number someone is
 * meant to act on, and it reads as zero when there is nothing wrong.
 *
 * When the list has drifted, both the rate and the exception count read "—"
 * rather than a number. Either would be arithmetic over a classification that
 * is known to be wrong, and a confident wrong figure is worse than an admitted
 * unknown — that is exactly how the earlier 0% read as a real compliance
 * failure. The record count stays, because counting rows needs no
 * classification.
 */
function buildKpis(spec, summary, buckets, drift, period) {
  const total = summary.total || 0;
  if (spec.kind === "total") {
    // Strictly greater, so a tie keeps the EARLIEST bucket - buckets arrive
    // oldest first.
    const busiest = (buckets || []).reduce((best, b) => (b.value > (best?.value ?? -1) ? b : best), null);

    if (spec.windowed) {
      const unit = windowFor(period, null).unit;
      // "Peak visitor day" / "Peak vehicle month" - the label states what a
      // bucket IS, so the number is not read against the wrong granularity.
      const peakLabel = `Peak ${spec.noun} ${unit === "month" ? "month" : "day"}`;
      const peaked = busiest && busiest.value > 0;
      return [
        { label: spec.headline, value: fmt(summary.numericTotal || 0),
          note: `Across ${total} record${total === 1 ? "" : "s"}`, tone: "neutral", icon: "bi-people" },
        { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
        { label: peakLabel, value: peaked ? fmt(busiest.value) : 0,
          note: peaked ? windowBucketFull(busiest.bucket, unit) : "No activity in this period",
          tone: "danger", icon: "bi-graph-up-arrow" },
      ];
    }

    return [
      { label: spec.headline, value: fmt(summary.numericTotal || 0), note: `Across ${total} record${total === 1 ? "" : "s"}`, tone: "neutral", icon: "bi-people" },
      { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
      { label: "Busiest bucket", value: busiest ? fmt(busiest.value) : 0, note: busiest ? busiest.bucket : "No data yet", tone: "danger", icon: "bi-graph-up-arrow" },
    ];
  }
  if (drift) {
    return [
      { label: spec.headline, value: "—", note: "Cannot classify — see above", tone: "warn", icon: "bi-question-circle" },
      { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
      { label: spec.exceptionsLabel, value: "—", note: "Not counted while the list disagrees", tone: "warn", icon: "bi-exclamation-triangle" },
    ];
  }

  // Summed over what the API actually returned rather than looked up by exact
  // key, so a drifted spelling still lands on the right side.
  const good = Object.entries(summary.byStatus || {})
    .filter(([status]) => (spec.goodStatuses || []).some((g) => sameStatus(g, status)))
    .reduce((n, [, count]) => n + count, 0);
  const bad = total - good;
  const rate = total ? Math.round((good / total) * 100) : 0;
  return [
    { label: spec.headline, value: `${rate}%`, note: `${good} of ${total}`, tone: rate >= 90 ? "good" : rate >= 70 ? "warn" : "danger", icon: "bi-check2-circle" },
    { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
    { label: spec.exceptionsLabel, value: bad, note: bad ? "Needs attention" : "None", tone: "danger", icon: "bi-exclamation-triangle" },
  ];
}

// The hover breakdown, as a native SVG <title>. Reads:
//   Aug 26
//   Normal: 5
//   Alert: 2
//   Total: 7
const tooltipText = (heading, rows) => [
  heading,
  ...rows.map((r) => `${r.label}: ${r.value}`),
  `Total: ${rows.reduce((n, r) => n + r.value, 0)}`,
].join("\n");

const fmt = (n) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10).toLocaleString();

function ChartPanel({ title, children }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: "#fff", minWidth: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--navy)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * The count tabs' trend: one vertical bar per bucket in the reporting window,
 * with a dashed average across it.
 *
 * Every bucket is drawn, including the zero ones - a month with three quiet
 * days should look quiet, and dropping them would silently compress the axis
 * so the remaining days read as consecutive.
 */
function WindowTrend({ buckets, period, spec, site }) {
  const unit = windowFor(period, null).unit;
  const rows = buckets || [];
  const series = [{ key: "v", label: spec.headline, color: CHART.navy }];
  const shaped = rows.map((b) => ({
    label: windowBucketLabel(b.bucket, unit, period),
    counts: { v: b.value },
    bucket: b.bucket,
  }));
  const g = stackedBarGeometry(shaped, series, { height: 210 });
  if (g.empty) return <div className="empty-hint">No {spec.noun} records available for the selected period.</div>;

  const total = rows.reduce((n, b) => n + b.value, 0);
  // Averaged over every bucket in the window, not only the ones with records:
  // "visitors per day this month" has to count the quiet days or it is not a
  // per-day figure.
  const avg = rows.length ? total / rows.length : 0;
  const avgY = g.yOf(avg);
  const per = unit === "month" ? "month" : "day";

  return (
    <>
      <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" height={g.height} role="img"
           aria-label={`${spec.trendTitle}: ${shaped.map((b, i) => `${b.label} ${rows[i].value}`).join(", ")}. Average ${avg.toFixed(1)} per ${per}.`}>
        {g.yTicks.map((t) => (
          <g key={t.y}>
            <line x1={g.left} y1={t.y} x2={g.right} y2={t.y} stroke={CHART.grid} strokeWidth="1" />
            <text x={g.left - 6} y={t.y + 3} textAnchor="end" fontSize="9" fill={CHART.muted}>{t.value}</text>
          </g>
        ))}
        {g.bars.map((bar, i) => (
          <g key={i}>
            <title>{[
              windowBucketFull(shaped[i].bucket, unit),
              site ? `Site: ${site}` : null,
              `${spec.noun === "visitor" ? "Visitors" : "Vehicles"}: ${rows[i].value}`,
            ].filter(Boolean).join("\n")}</title>
            {bar.segments.map((seg) => (
              <rect key={seg.key} x={bar.x} y={seg.y} width={bar.w} height={seg.h} fill={seg.color} rx="2" />
            ))}
            {bar.showLabel && <text x={bar.x + bar.w / 2} y={bar.labelY} textAnchor="middle" fontSize="9" fill={CHART.muted}>{bar.label}</text>}
          </g>
        ))}
        {/* Dashed, and under the value labels: a reference, not a series. */}
        {avg > 0 && (
          <line x1={g.left} y1={avgY} x2={g.right} y2={avgY} stroke={CHART.red}
                strokeWidth="1.5" strokeDasharray="5 4" opacity="0.85" />
        )}
      </svg>
      <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11, color: "var(--text-mute)", flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: CHART.navy, display: "inline-block" }} />
          {spec.noun === "visitor" ? "Visitors" : "Vehicles"}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 0, borderTop: `2px dashed ${CHART.red}`, display: "inline-block" }} />
          Average: {avg.toFixed(avg < 10 ? 1 : 0)} {spec.noun}s/{per}
        </span>
      </div>
    </>
  );
}

function LineTrend({ buckets, period, spec }) {
  const points = (buckets || []).map((b) => ({ value: b.value, label: formatBucketLabel(b.bucket, period) }));
  const g = lineChartGeometry(points);
  if (g.empty) return <div className="empty-hint">No data yet for this period.</div>;
  return (
    <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" height={g.height} role="img"
         aria-label={`${spec.trendTitle}: ${points.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
      {g.yTicks.map((t) => (
        <g key={t.y}>
          <line x1={g.left} y1={t.y} x2={g.right} y2={t.y} stroke={CHART.grid} strokeWidth="1" />
          <text x={g.left - 6} y={t.y + 3} textAnchor="end" fontSize="9" fill={CHART.muted}>{t.value}</text>
        </g>
      ))}
      {g.area && <path d={g.area} fill="var(--navy)" opacity="0.10" />}
      <path d={g.path} fill="none" stroke={CHART.navy} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {g.dots.map((d, i) => (
        <g key={i}>
          <circle cx={d.x} cy={d.y} r="3.5" fill={CHART.gold} stroke={CHART.navy} strokeWidth="1.5" />
          {d.showLabel && <text x={d.x} y={g.baselineY + 14} textAnchor="middle" fontSize="9" fill={CHART.muted}>{d.label}</text>}
        </g>
      ))}
    </svg>
  );
}

function StackedTrend({ buckets, period, spec }) {
  // Good first so it sits at the bottom of each bar, where the eye reads the
  // baseline: the height above it IS the exceptions.
  //
  // The exception series is RED on every tab, the same `--red` the exceptions
  // KPI card uses for its top border. That card is always the danger tone, so
  // the bar segment above the baseline and the card now carry one meaning
  // rather than two colours for the same fact. Gold said nothing in particular
  // and is 2.42:1 on white, a weak signal for the number someone must act on.
  //
  // A tab with stackMode "status" gets one series per condition instead, so
  // Alert, Breach and Under Maintenance stay distinguishable rather than
  // merging into a single "not normal" band.
  const byStatus = spec.stackMode === "status";
  const present = [...new Set((buckets || []).flatMap((b) => Object.keys(b.counts || {})))];
  const series = byStatus
    ? statusSeries(spec.statusList, present)
    : [
        { key: "__good", label: spec.goodStatuses.join(" / "), color: CHART.navy },
        { key: "__other", label: spec.exceptionsLabel, color: CHART.red },
      ];
  const shaped = (buckets || []).map((b) => {
    if (byStatus) {
      // Counts are keyed by the series key, matched leniently so a padded or
      // re-cased stored value still lands on its own series.
      const counts = {};
      for (const s of series) {
        counts[s.key] = Object.entries(b.counts)
          .filter(([status]) => sameStatus(status, s.key))
          .reduce((n, [, c]) => n + c, 0);
      }
      return { label: formatBucketLabel(b.bucket, period), counts };
    }
    const good = Object.entries(b.counts)
      .filter(([status]) => spec.goodStatuses.some((g) => sameStatus(g, status)))
      .reduce((n, [, count]) => n + count, 0);
    const all = Object.values(b.counts).reduce((n, c) => n + c, 0);
    return { label: formatBucketLabel(b.bucket, period), counts: { __good: good, __other: all - good } };
  });
  const g = stackedBarGeometry(shaped, series);
  if (g.empty) return <div className="empty-hint">No data yet for this period.</div>;
  return (
    <>
      {/* The spoken summary takes its wording from the tab's own good statuses.
          It read "N on duty of M" for every tab, which was Daily Manning's
          phrasing borrowed by a chart about patrol videos. */}
      <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" height={g.height} role="img"
           aria-label={`${spec.trendTitle}: ${shaped.map((b) => {
             const total = series.reduce((n, sr) => n + (b.counts[sr.key] || 0), 0);
             // Built from the series rather than the two binary keys, which read
             // "undefined ... of NaN" once a tab had four of them.
             return byStatus
               ? `${b.label} ${series.map((sr) => `${b.counts[sr.key] || 0} ${sr.label}`).join(", ")} of ${total}`
               : `${b.label} ${b.counts.__good || 0} ${series[0].label} of ${total}`;
           }).join("; ")}`}>
        {g.yTicks.map((t) => (
          <g key={t.y}>
            <line x1={g.left} y1={t.y} x2={g.right} y2={t.y} stroke={CHART.grid} strokeWidth="1" />
            <text x={g.left - 6} y={t.y + 3} textAnchor="end" fontSize="9" fill={CHART.muted}>{t.value}</text>
          </g>
        ))}
        {g.bars.map((bar, i) => (
          <g key={i}>
            {/* On the bar group, not each segment: hovering anywhere on the
                column gives the whole breakdown, which is the question being
                asked, and a one-record segment is too thin to hit. */}
            <title>{tooltipText(bar.label, series.map((sr) => ({
              label: sr.label, value: bar.counts ? (bar.counts[sr.key] || 0) : 0,
            })))}</title>
            {bar.segments.map((seg) => (
              <rect key={seg.key} x={bar.x} y={seg.y} width={seg.h === 0 ? 0 : bar.w} height={seg.h} fill={seg.color} rx="2" />
            ))}
            {bar.showLabel && <text x={bar.x + bar.w / 2} y={bar.labelY} textAnchor="middle" fontSize="9" fill={CHART.muted}>{bar.label}</text>}
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11, color: "var(--text-mute)" }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * The by-site breakdown.
 *
 * On the three compliance tabs (`stackedSites`) each site's bar is split good
 * against exception, so the panel answers "which sites are the problem" rather
 * than only "how many records came from where". Everywhere else it stays one
 * plain navy bar per site.
 *
 * The split reuses the tab's own `goodStatuses` — exception is the site's total
 * minus its good statuses — so "No Guards" folds in beside "Incomplete" exactly
 * as it does in the KPI card and the trend, and a fourth value added from
 * Manage Lists needs no code change.
 *
 * No legend: this panel sits beside the trend, which carries one for the same
 * two colours.
 */
function SiteBars({ summary, spec }) {
  const stacked = !!spec.stackedSites;

  let rows;
  if (stacked) {
    const byStatus = spec.stackMode === "status";
    const seriesDef = byStatus
      ? statusSeries(spec.statusList, (summary.bySiteStatus || []).map((r) => r.status))
      : null;
    const perSite = new Map();
    for (const r of summary.bySiteStatus || []) {
      if (!perSite.has(r.site)) perSite.set(r.site, { good: 0, other: 0, byKey: {} });
      const bucket = perSite.get(r.site);
      if (spec.goodStatuses.some((g) => sameStatus(g, r.status))) bucket.good += r.count;
      else bucket.other += r.count;
      if (seriesDef) {
        const hit = seriesDef.find((s) => sameStatus(s.key, r.status));
        if (hit) bucket.byKey[hit.key] = (bucket.byKey[hit.key] || 0) + r.count;
      }
    }
    rows = [...perSite.entries()].map(([site, c]) => ({
      label: site,
      value: c.good + c.other,
      good: c.good,
      other: c.other,
      breakdown: seriesDef ? seriesDef.map((s) => ({ label: s.label, value: c.byKey[s.key] || 0 })) : null,
      parts: seriesDef
        ? seriesDef.map((s) => ({ key: s.key, value: c.byKey[s.key] || 0, color: s.color }))
        : [
            { key: "good", value: c.good, color: CHART.navy },
            { key: "other", value: c.other, color: CHART.red },
          ],
    }));
  } else {
    rows = (summary.bySite || [])
      .map((r) => ({ label: r.site, value: spec.kind === "total" ? Number(r.numericTotal || 0) : r.count }));
  }

  rows = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);

  const g = hBarGeometry(rows);
  if (g.empty) return <div className="empty-hint">No data yet for this period.</div>;

  const describe = (r) => (stacked
    ? `${r.label} ${r.good} ${spec.goodStatuses.join(" / ")} and ${r.other} ${spec.exceptionsLabel} of ${r.value}`
    : `${r.label} ${r.value}`);

  return (
    <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" height={g.height} role="img"
         aria-label={`By site: ${rows.map(describe).join(", ")}`}>
      {g.bars.map((b, i) => (
        <g key={i}>
          <title>{tooltipText(b.label, rows[i] && rows[i].breakdown
            ? rows[i].breakdown
            : [{ label: spec.goodStatuses.join(" / ") || "Compliant", value: (rows[i] || {}).good || 0 },
               { label: spec.exceptionsLabel, value: (rows[i] || {}).other || 0 }])}</title>
          {/* Site names are long, so they get their own left gutter rather than
              being rotated under a vertical axis. */}
          <text x="0" y={b.y + b.h / 2 + 3} fontSize="10.5" fill="var(--text)">{clip(b.label)}</text>
          {b.segments
            ? b.segments.map((seg) => (
                <rect key={seg.key} x={seg.x} y={b.y} width={seg.w} height={b.h} fill={seg.color} rx="3" />
              ))
            : <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={CHART.navy} rx="3" />}
          {/* The count stays the site TOTAL, as it always has: the bar's length
              is the total either way, and per-segment numbers at this size
              would not fit beside a short segment. */}
          <text x={b.valueX} y={b.y + b.h / 2 + 3} fontSize="10.5" fill={CHART.muted}>{fmt(b.value)}</text>
        </g>
      ))}
    </svg>
  );
}

const clip = (s) => (String(s).length > 20 ? String(s).slice(0, 19) + "…" : String(s));
