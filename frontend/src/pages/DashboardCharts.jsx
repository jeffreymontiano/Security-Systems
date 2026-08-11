import { PIE_COLORS, pieEntries, pieSlicePaths } from "./dashboardShared";

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
