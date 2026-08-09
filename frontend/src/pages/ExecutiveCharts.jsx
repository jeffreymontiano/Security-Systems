import { PIE_COLORS } from "./dashboardShared";

// Charts for the Executive Summary, in the same hand-drawn SVG idiom as
// DashboardCharts.jsx.
//
// No chart library, deliberately. Recharts would pull in D3 for a page that
// draws four shapes, on a bundle already noted as heavy — and it would not help
// the PDF, which is rendered server-side by PDFKit and cannot run React. The
// same series that feed these components feed the PDF, so the printed page and
// the screen cannot drift.

const NAVY = "#152A4D";
const GOLD = "#D4AF37";
const BLUE = "#3E7CB1";
const RED = "#A32D2D";
const TEAL = "#0F6E56";
const AMBER = "#854F0B";

// A week label like "11 Aug". Weeks are PH weeks, computed on the server.
export function weekLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

function Empty({ label = "No data in this period." }) {
  return <div className="empty-hint" style={{ padding: "26px 0", textAlign: "center" }}>{label}</div>;
}

// ---------------------------------------------------------------------------
// Stacked columns. Used for attendance (present / late / absent) and for the
// OT split, where the whole point is the PROPORTION rather than the totals.
// ---------------------------------------------------------------------------
export function StackedBars({ title, hint, points, series, unit = "" }) {
  const W = 560, H = 210, pad = { t: 16, r: 10, b: 34, l: 34 };
  const chartW = W - pad.l - pad.r;
  const chartH = H - pad.t - pad.b;
  const totals = points.map((p) => series.reduce((s, k) => s + (p[k.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const gap = 8;
  const barW = points.length ? Math.max(6, (chartW - gap * (points.length - 1)) / points.length) : 0;

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      {hint && <div className="exec-chart-hint">{hint}</div>}
      {points.length === 0 ? <Empty /> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
               aria-label={`${title}. ${points.length} periods.`}>
            {/* Gridlines give the eye something to measure against; without them
                a stacked bar is only a vague impression. */}
            {[0, 0.5, 1].map((f) => {
              const y = pad.t + chartH * (1 - f);
              return (
                <g key={f}>
                  <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="#E7EAF0" strokeWidth="1" />
                  <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#8A93A2">
                    {Math.round(max * f)}
                  </text>
                </g>
              );
            })}
            {points.map((p, i) => {
              const x = pad.l + i * (barW + gap);
              let cursor = pad.t + chartH;
              return (
                <g key={p.label || i}>
                  {series.map((s) => {
                    const v = p[s.key] || 0;
                    if (v <= 0) return null;
                    const h = Math.max(1, (v / max) * chartH);
                    cursor -= h;
                    return (
                      <rect key={s.key} x={+x.toFixed(1)} y={+cursor.toFixed(1)}
                            width={+barW.toFixed(1)} height={+h.toFixed(1)} fill={s.color}>
                        <title>{`${p.label} — ${s.label}: ${v}${unit}`}</title>
                      </rect>
                    );
                  })}
                  <text x={x + barW / 2} y={H - pad.b + 13} textAnchor="middle" fontSize="9" fill="#5B6472">
                    {p.label}
                  </text>
                </g>
              );
            })}
            <line x1={pad.l} y1={pad.t + chartH} x2={W - pad.r} y2={pad.t + chartH} stroke="#C3C9D2" />
          </svg>
          <Legend series={series} />
        </>
      )}
    </div>
  );
}

function Legend({ series }) {
  return (
    <div className="exec-legend">
      {series.map((s) => (
        <span key={s.key} className="exec-legend-item">
          <span className="exec-legend-swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars. Sites have long names that do not fit under a column, and
// there can be many of them — a horizontal list stays readable either way.
// ---------------------------------------------------------------------------
export function HBars({ title, hint, rows, valueKey, label = "", color = NAVY }) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      {hint && <div className="exec-chart-hint">{hint}</div>}
      {rows.length === 0 ? <Empty /> : (
        <div className="exec-hbars">
          {rows.slice(0, 12).map((r) => (
            <div className="exec-hbar-row" key={r.site || r.label}>
              <span className="exec-hbar-label" title={r.site || r.label}>{r.site || r.label}</span>
              <span className="exec-hbar-track">
                <span
                  className="exec-hbar-fill"
                  style={{ width: `${Math.max(2, ((r[valueKey] || 0) / max) * 100)}%`, background: color }}
                />
              </span>
              <span className="exec-hbar-value">{r[valueKey] || 0}{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut. For a small set of statuses where the split is the message.
// ---------------------------------------------------------------------------
export function Donut({ title, hint, counts, colors }) {
  const entries = Object.entries(counts || {}).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const R = 52, C = 60, STROKE = 22;
  let offset = 0;
  const circumference = 2 * Math.PI * R;

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      {hint && <div className="exec-chart-hint">{hint}</div>}
      {total === 0 ? <Empty /> : (
        <div className="pie-card-body">
          <div className="pie-svg-wrap">
            <svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label={title}>
              {/* Drawn as one circle with dash offsets rather than arc paths —
                  fewer moving parts and no rounding seams between slices. */}
              {entries.map(([k, v], i) => {
                const len = (v / total) * circumference;
                const el = (
                  <circle
                    key={k} cx={C} cy={C} r={R} fill="none"
                    stroke={(colors && colors[k]) || PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={STROKE}
                    strokeDasharray={`${len} ${circumference - len}`}
                    strokeDashoffset={-offset}
                    transform={`rotate(-90 ${C} ${C})`}
                  >
                    <title>{`${k}: ${v} (${Math.round((v / total) * 100)}%)`}</title>
                  </circle>
                );
                offset += len;
                return el;
              })}
              <text x={C} y={C + 4} textAnchor="middle" fontSize="17" fontWeight="700" fill={NAVY}>{total}</text>
            </svg>
          </div>
          <div className="pie-legend">
            {entries.map(([k, v], i) => (
              <div className="pie-legend-row" key={k}>
                <span className="pie-swatch" style={{ background: (colors && colors[k]) || PIE_COLORS[i % PIE_COLORS.length] }} />
                <span className="pie-legend-label" title={k}>{k}</span>
                <span className="pie-legend-count">
                  {v}<span className="pie-legend-pct">({Math.round((v / total) * 100)}%)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const COLORS = { NAVY, GOLD, BLUE, RED, TEAL, AMBER };
