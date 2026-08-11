import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import KpiCard from "../components/KpiCard";
import {
  CHART, OPS_ANALYTICS, formatBucketLabel,
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

export default function OpsAnalytics({ cfg, sites = [] }) {
  const spec = OPS_ANALYTICS[cfg.type];
  const [site, setSite] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [trend, setTrend] = useState(null);     // buckets for the chart
  const [summary, setSummary] = useState(null); // totals for the cards + by-site
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!spec) return;
    setLoading(true); setError("");
    try {
      const q = new URLSearchParams({ period });
      if (site) q.set("site", site);

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
          }));

      const sq = new URLSearchParams();
      if (site) sq.set("site", site);
      if (buckets.length) sq.set("from", buckets[0].bucket);
      setSummary(await api(`/ops/${cfg.type}/summary?${sq}`));
      setTrend(buckets);
    } catch (e) {
      setError(e.message); setTrend(null); setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [cfg.type, site, period, spec]);

  useEffect(() => { load(); }, [load]);

  const kpis = useMemo(() => (summary ? buildKpis(spec, summary, trend) : []), [spec, summary, trend]);

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
      </div>

      {error && <div className="empty-hint">{error}</div>}
      {!error && loading && <div className="empty-hint">Loading analytics…</div>}

      {!error && !loading && summary && (
        <>
          <div className="kpi-grid ops-analytics-kpis" data-cols="3" style={{ margin: "0 0 16px" }}>
            {kpis.map((k) => (
              <KpiCard key={k.label} label={k.label} value={k.value} note={k.note} tone={k.tone} icon={k.icon} />
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <ChartPanel title={spec.trendTitle}>
              {spec.trend === "stacked"
                ? <StackedTrend buckets={trend} period={period} spec={spec} />
                : <LineTrend buckets={trend} period={period} spec={spec} />}
            </ChartPanel>
            <ChartPanel title="By site">
              <SiteBars summary={summary} spec={spec} />
            </ChartPanel>
          </div>
        </>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

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
 * The three cards. A rate tab leads with the percentage that matters; a count
 * tab leads with the total, because "83% of visitors" means nothing.
 *
 * The exceptions card is always the danger tone — it is the number someone is
 * meant to act on, and it reads as zero when there is nothing wrong.
 */
function buildKpis(spec, summary, buckets) {
  const total = summary.total || 0;
  if (spec.kind === "total") {
    const busiest = (buckets || []).reduce((best, b) => (b.value > (best?.value ?? -1) ? b : best), null);
    return [
      { label: spec.headline, value: fmt(summary.numericTotal || 0), note: `Across ${total} record${total === 1 ? "" : "s"}`, tone: "neutral", icon: "bi-people" },
      { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
      { label: "Busiest bucket", value: busiest ? fmt(busiest.value) : 0, note: busiest ? busiest.bucket : "No data yet", tone: "danger", icon: "bi-graph-up-arrow" },
    ];
  }
  const good = (spec.goodStatuses || []).reduce((n, k) => n + (summary.byStatus[k] || 0), 0);
  const bad = total - good;
  const rate = total ? Math.round((good / total) * 100) : 0;
  return [
    { label: spec.headline, value: `${rate}%`, note: `${good} of ${total}`, tone: rate >= 90 ? "good" : rate >= 70 ? "warn" : "danger", icon: "bi-check2-circle" },
    { label: "Records in period", value: total, note: "Entries logged", tone: "neutral", icon: "bi-journal-text" },
    { label: spec.exceptionsLabel, value: bad, note: bad ? "Needs attention" : "None", tone: "danger", icon: "bi-exclamation-triangle" },
  ];
}

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
  const series = [
    { key: "__good", label: spec.goodStatuses.join(" / "), color: CHART.navy },
    { key: "__other", label: spec.exceptionsLabel, color: CHART.red },
  ];
  const shaped = (buckets || []).map((b) => {
    const good = spec.goodStatuses.reduce((n, k) => n + (b.counts[k] || 0), 0);
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
           aria-label={`${spec.trendTitle}: ${shaped.map((b) => `${b.label} ${b.counts.__good} ${series[0].label} of ${b.counts.__good + b.counts.__other}`).join(", ")}`}>
        {g.yTicks.map((t) => (
          <g key={t.y}>
            <line x1={g.left} y1={t.y} x2={g.right} y2={t.y} stroke={CHART.grid} strokeWidth="1" />
            <text x={g.left - 6} y={t.y + 3} textAnchor="end" fontSize="9" fill={CHART.muted}>{t.value}</text>
          </g>
        ))}
        {g.bars.map((bar, i) => (
          <g key={i}>
            {bar.segments.map((seg) => (
              <rect key={seg.key} x={bar.x} y={seg.y} width={bar.w} height={seg.h} fill={seg.color} rx="2" />
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
    const perSite = new Map();
    for (const r of summary.bySiteStatus || []) {
      if (!perSite.has(r.site)) perSite.set(r.site, { good: 0, other: 0 });
      const bucket = perSite.get(r.site);
      if (spec.goodStatuses.includes(r.status)) bucket.good += r.count;
      else bucket.other += r.count;
    }
    rows = [...perSite.entries()].map(([site, c]) => ({
      label: site,
      value: c.good + c.other,
      good: c.good,
      other: c.other,
      parts: [
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
