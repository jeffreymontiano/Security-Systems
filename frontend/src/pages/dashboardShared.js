// Config + pure-SVG chart helpers for the Security Operations Dashboard.
// The legacy dashboard uses NO charting library — pies and column charts are
// hand-rolled SVG. These helpers reproduce that output exactly.

import { daysBetween } from "./incidentShared";

// --- Operational Records sub-tabs (legacy OPS_TYPES group "m5") ---
// `type` is the stored record_type and never changes with a tab's NAME — the
// rows already in ops_records are keyed by it. "Guard Deployment" is displayed
// as "Daily Manning"; its records are still `guard_deployment`.
//
// Duty Roster, GPS Monitoring and Daily Metrics were retired at the agency's
// request. Their record types stay valid in the database, so existing rows are
// untouched and readable if a tab is ever restored — dropping them from the
// CHECK constraint would have rejected data that is already there.
export const M5_TABS = [
  { type: "guard_deployment", tab: "Daily Manning", title: "Daily manning",
    labelText: "Guard name", labelFromEmployees: true,
    hasStatus: true, statusLabel: "Deployment Status", statusListKey: "deployment_status", hasValue: false },
  { type: "site_status", tab: "Site Status", title: "Site status monitoring",
    labelText: "Site note",
    hasStatus: true, statusLabel: "Site Condition", statusListKey: "site_condition", hasValue: false },
  // No label field: the record is the site's manning state on a date, and the
  // site has its own column. `hasLabel: false` stores an empty label rather
  // than inventing a name for a record that does not have one.
  { type: "site_manning", tab: "Site Manning Status", title: "Site manning status",
    hasLabel: false,
    hasStatus: true, statusLabel: "Site Manning Status", statusListKey: "site_manning_status", hasValue: false },
  // The guard is the label here, so it stays required — unlike Site Manning
  // Status, where the record has no person attached to it.
  { type: "patrol_video", tab: "Patrol Video", title: "Patrol video",
    labelText: "Guard name", labelFromEmployees: true,
    hasStatus: true, statusLabel: "Video Patrol Status", statusListKey: "video_patrol_status",
    // Post Type describes the POST, so it reads between Site and the guard
    // rather than after the status.
    hasValue: true, valueLabel: "Post Type", valueListKey: "post_type", valueBeforeLabel: true },
  { type: "visitor_count", tab: "Visitor Count", title: "Visitor count",
    labelText: "Description", hasStatus: false, hasValue: true, valueLabel: "Visitor count" },
  { type: "vehicle_count", tab: "Vehicle Count", title: "Vehicle count",
    labelText: "Description", hasStatus: false, hasValue: true, valueLabel: "Vehicle count" },
];

// --- Trend column charts config ---
export const TREND_CONFIG = {
  site_status:   { title: "Site status activity", metric: "count",       metricLabel: "Status updates" },
  visitor_count: { title: "Visitor count",        metric: "total_value", metricLabel: "Visitors" },
  vehicle_count: { title: "Vehicle count",        metric: "total_value", metricLabel: "Vehicles" },
};

export const PIE_COLORS = ["#152A4D", "#3E7CB1", "#D4AF37", "#A32D2D", "#2E7D5B", "#7B4B94", "#C46A2B", "#5B6472"];

// --- KPIs computed from live incidents (legacy renderKPIs used DATA.incidents) ---
export function computeKpis(incidents) {
  const total = incidents.length;
  const open = incidents.filter((i) => i.status !== "Resolved" && i.status !== "Closed").length;
  const resolvedList = incidents.filter((i) => i.resolvedDate);
  const avgRes = resolvedList.length
    ? Math.round(resolvedList.reduce((s, i) => s + daysBetween(i.date, i.resolvedDate), 0) / resolvedList.length)
    : 0;
  const classCounts = {};
  incidents.forEach((i) => { classCounts[i.classification] = (classCounts[i.classification] || 0) + 1; });
  const repeat = Object.values(classCounts).filter((c) => c > 1).length;

  const now = new Date();
  const earliest = incidents.length
    ? Math.min(...incidents.map((i) => new Date(i.date).getTime()), now.getTime())
    : now.getTime();
  const weeksSpan = Math.max(1, Math.round((now - new Date(earliest)) / (1000 * 60 * 60 * 24 * 7)) || 1);
  const freq = total ? (total / weeksSpan).toFixed(2) : "0.00";

  // `cls` is the tone class the tile has always carried; `icon` is a Bootstrap
  // Icon name and is decorative only — the label beside it carries the meaning,
  // so KpiCard hides it from assistive tech rather than reading it out twice.
  return [
    { label: "Total incidents", value: total, note: "All time", cls: "", icon: "bi-clipboard-data" },
    { label: "Open cases", value: open, note: "Active investigations", cls: open > 0 ? "danger" : "good", icon: "bi-folder2-open" },
    { label: "Avg resolution time", value: avgRes + "d", note: "Report to resolve", cls: "warn", icon: "bi-hourglass-split" },
    { label: "Incident frequency", value: freq + "/wk", note: "Rolling average", cls: "", icon: "bi-graph-up" },
    { label: "Repeat classifications", value: repeat, note: "Categories with 2+ cases", cls: repeat > 0 ? "warn" : "good", icon: "bi-arrow-repeat" },
  ];
}

export function countBy(incidents, key) {
  const out = {};
  incidents.forEach((i) => { const k = i[key]; out[k] = (out[k] || 0) + 1; });
  return out;
}

// --- Pie/donut SVG (matches legacy pieSliceSvg) ---
function polarToXY(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

export function pieEntries(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

export function pieSlicePaths(counts) {
  const entries = pieEntries(counts);
  const total = entries.reduce((s, [, c]) => s + c, 0);
  if (entries.length === 0 || total === 0) return { empty: true, paths: [] };
  const cx = 60, cy = 60, r = 52;
  if (entries.length === 1) {
    return { empty: false, single: true, paths: [{ d: null, fill: PIE_COLORS[0] }] };
  }
  let angle = 0;
  const paths = entries.map(([, count], idx) => {
    const slice = (count / total) * 360;
    const start = polarToXY(cx, cy, r, angle);
    const end = polarToXY(cx, cy, r, angle + slice);
    const largeArc = slice > 180 ? 1 : 0;
    const d = `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
    angle += slice;
    return { d, fill: PIE_COLORS[idx % PIE_COLORS.length] };
  });
  return { empty: false, paths };
}

// --- Column chart geometry (matches legacy columnChartSvg) ---
export function formatBucketLabel(bucket, period) {
  const d = new Date(bucket + "T00:00:00");
  if (isNaN(d.getTime())) return bucket;
  if (period === "daily") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (period === "weekly") return "Wk " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (period === "monthly") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  if (period === "quarterly") return "Q" + (Math.floor(d.getMonth() / 3) + 1) + " " + d.getFullYear();
  if (period === "yearly") return String(d.getFullYear());
  return bucket;
}

export function columnChartGeometry(points) {
  const width = 320, height = 190, padding = { top: 18, right: 8, bottom: 38, left: 8 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (points.length === 0) return { width, height, bars: [], baseline: null };
  const maxVal = Math.max(1, ...points.map((p) => p.value));
  const gap = 6;
  const barW = Math.max(6, (chartW - gap * (points.length - 1)) / points.length);
  const bars = points.map((p, i) => {
    const barH = Math.max(1, Math.round((p.value / maxVal) * chartH));
    const x = padding.left + i * (barW + gap);
    const y = padding.top + (chartH - barH);
    return {
      x: +x.toFixed(1), y: +y.toFixed(1), w: +barW.toFixed(1), h: barH,
      color: PIE_COLORS[i % PIE_COLORS.length], value: p.value, label: p.label,
      showValue: barW > 14, labelY: height - padding.bottom + 13,
    };
  });
  const baseline = { x1: padding.left, y1: padding.top + chartH, x2: width - padding.right, y2: padding.top + chartH };
  return { width, height, bars, baseline };
}
