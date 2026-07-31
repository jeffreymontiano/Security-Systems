import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import {
  PIE_COLORS, pieEntries, pieSlicePaths,
  TREND_CONFIG, formatBucketLabel, columnChartGeometry,
} from "./dashboardShared";

/** SVG pie/donut card (matches legacy pieCard). */
export function PieCard({ title, counts }) {
  const entries = pieEntries(counts);
  const total = entries.reduce((s, [, c]) => s + c, 0);
  const { empty, single, paths } = pieSlicePaths(counts);

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="pie-card-body">
        <div className="pie-svg-wrap">
          <svg viewBox="0 0 120 120" width="110" height="110">
            {empty ? (
              <circle cx="60" cy="60" r="52" fill="#F0F2F5" />
            ) : single ? (
              <circle cx="60" cy="60" r="52" fill={paths[0].fill} />
            ) : (
              paths.map((p, idx) => (
                <path key={idx} d={p.d} fill={p.fill} stroke="#fff" strokeWidth="1.5" />
              ))
            )}
          </svg>
        </div>
        <div className="pie-legend">
          {entries.length === 0 ? (
            <div className="empty-hint">No data yet.</div>
          ) : (
            entries.map(([label, count], idx) => (
              <div className="pie-legend-row" key={label}>
                <span className="pie-swatch" style={{ background: PIE_COLORS[idx % PIE_COLORS.length] }}></span>
                <span className="pie-legend-label" title={label}>{label}</span>
                <span className="pie-legend-count">
                  {count}<span className="pie-legend-pct">({total ? Math.round((count / total) * 100) : 0}%)</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** One trend column chart with its own site + period selectors. */
export function TrendChart({ type, sites }) {
  const cfg = TREND_CONFIG[type];
  const [period, setPeriod] = useState("monthly");
  const [site, setSite] = useState("");
  const [points, setPoints] = useState(null); // null=loading, []=empty
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setPoints(null);
    setError("");
    try {
      const qs = `period=${encodeURIComponent(period)}` + (site ? `&site=${encodeURIComponent(site)}` : "");
      const rows = await api(`/ops/${type}/timeseries?${qs}`);
      setPoints(rows.map((r) => ({ label: formatBucketLabel(r.bucket, period), value: Number(r[cfg.metric]) || 0 })));
    } catch (e) {
      setError(e.message);
    }
  }, [type, period, site, cfg.metric]);

  useEffect(() => { load(); }, [load]);

  const geo = points ? columnChartGeometry(points) : null;

  return (
    <div>
      <div className="trend-card-head">
        <h3>{cfg.title}</h3>
        <div className="trend-card-controls">
          <select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      </div>
      <div>
        {error && <div className="empty-hint">{error}</div>}
        {!error && points === null && <div className="empty-hint">Loading...</div>}
        {!error && points && points.length === 0 && <div className="empty-hint">No data yet for this period.</div>}
        {!error && points && points.length > 0 && (
          <svg viewBox={`0 0 ${geo.width} ${geo.height}`} width="100%" height="180">
            {geo.bars.map((b, i) => (
              <g key={i}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.color} rx="2" />
                {b.showValue && (
                  <text x={b.x + b.w / 2} y={b.y - 4} fontSize="9" textAnchor="middle" fill="#152A4D" fontWeight="700">{b.value}</text>
                )}
                <text x={b.x + b.w / 2} y={b.labelY} fontSize="8" textAnchor="middle" fill="#5B6472">{b.label}</text>
              </g>
            ))}
            {geo.baseline && (
              <line x1={geo.baseline.x1} y1={geo.baseline.y1} x2={geo.baseline.x2} y2={geo.baseline.y2} stroke="#DCE1E8" />
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
