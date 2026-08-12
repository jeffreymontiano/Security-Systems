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
  // No Notes column: "Site note" IS this tab's free-text field, and a second
  // one beside it only invites the same remark in two places.
  { type: "site_status", tab: "Site Status", title: "Site status monitoring",
    labelText: "Site note", hasNotes: false,
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
  // No label field on either count: the record is a NUMBER for a site on a
  // date, and Notes already carries anything worth writing about it. The
  // "Description" box invited the same remark in two places, as Site Status's
  // did.
  { type: "visitor_count", tab: "Visitor Count", title: "Visitor count",
    hasLabel: false, hasStatus: false, hasValue: true, valueLabel: "Visitor count" },
  { type: "vehicle_count", tab: "Vehicle Count", title: "Vehicle count",
    hasLabel: false, hasStatus: false, hasValue: true, valueLabel: "Vehicle count" },
];

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

// Bucket label for a time axis. Shared by every trend the analytics blocks
// draw.
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

// ---------------------------------------------------------------------------
// Analytics charts for the operational records tabs
// ---------------------------------------------------------------------------
//
// Same approach as the charts above: geometry computed here, drawn as plain SVG
// by the component. No charting dependency — adding one for three shapes would
// bring a bundle and a theming layer to replace about sixty lines of maths.
//
// Colours come from the brand tokens. Gold is 2.42:1 on white, under the 3:1
// text minimum, so it is only ever a large fill: every label and axis is navy
// or muted, never gold.
export const CHART = {
  navy: "var(--navy)",
  gold: "var(--gold)",
  blue: "var(--blue)",
  red: "var(--red)",
  teal: "var(--teal)",
  muted: "var(--text-mute)",
  grid: "var(--border)",
};

/**
 * A line chart over time buckets.
 *
 * Returns a polyline path plus the points, so the caller can draw dots and
 * hover targets. A single bucket has no line to draw, and is reported as one
 * point — a chart claiming a trend from one reading would be a lie.
 */
export function lineChartGeometry(points, { width = 560, height = 200 } = {}) {
  const padding = { top: 16, right: 14, bottom: 34, left: 38 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (!points.length) return { width, height, empty: true, dots: [], path: "", yTicks: [] };

  const maxVal = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? chartW / (points.length - 1) : 0;
  const dots = points.map((p, i) => {
    const x = padding.left + (points.length > 1 ? i * stepX : chartW / 2);
    const y = padding.top + chartH - (p.value / maxVal) * chartH;
    return { x: +x.toFixed(1), y: +y.toFixed(1), value: p.value, label: p.label,
             // Only every other label when the buckets are dense, so the axis
             // does not turn into overlapping ink.
             showLabel: points.length <= 8 || i % 2 === 0 };
  });
  const path = dots.map((d, i) => `${i ? "L" : "M"} ${d.x} ${d.y}`).join(" ");
  const area = dots.length > 1
    ? `${path} L ${dots[dots.length - 1].x} ${padding.top + chartH} L ${dots[0].x} ${padding.top + chartH} Z`
    : "";
  const yTicks = [0, 0.5, 1].map((f) => ({
    y: +(padding.top + chartH - f * chartH).toFixed(1),
    value: Math.round(maxVal * f),
  }));
  return { width, height, empty: false, dots, path, area, yTicks,
           baselineY: padding.top + chartH, left: padding.left, right: width - padding.right };
}

/**
 * A stacked bar per bucket — used for Daily Manning, where the question is not
 * "how many records" but "how many of them were on duty".
 *
 * `series` is an ordered list of { key, color }; the first is drawn at the
 * bottom. Buckets are drawn to the SAME total height only when the counts
 * match, so an unusually busy day still reads as taller.
 */
export function stackedBarGeometry(buckets, series, { width = 560, height = 200 } = {}) {
  const padding = { top: 16, right: 14, bottom: 34, left: 38 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (!buckets.length) return { width, height, empty: true, bars: [], yTicks: [] };

  const totals = buckets.map((b) => series.reduce((n, s) => n + (b.counts[s.key] || 0), 0));
  const maxVal = Math.max(1, ...totals);
  const gap = 6;
  // Capped, then centred: four monthly buckets across the full width give bars
  // 120px wide, which reads as four blocks of colour rather than a series. The
  // cap keeps a sparse chart looking like the same chart as a dense one.
  const slot = (chartW - gap * (buckets.length - 1)) / buckets.length;
  const barW = Math.max(6, Math.min(46, slot));
  const step = barW + gap;
  const originX = padding.left + (chartW - (step * buckets.length - gap)) / 2;

  const bars = buckets.map((b, i) => {
    const x = originX + i * step;
    let cursor = padding.top + chartH;
    const segments = series.map((s) => {
      const count = b.counts[s.key] || 0;
      const h = count ? Math.max(1, (count / maxVal) * chartH) : 0;
      cursor -= h;
      return { key: s.key, color: s.color, count, y: +cursor.toFixed(1), h: +h.toFixed(1) };
    }).filter((seg) => seg.count > 0);
    return { x: +x.toFixed(1), w: +barW.toFixed(1), label: b.label, total: totals[i], segments, counts: b.counts,
             showLabel: buckets.length <= 8 || i % 2 === 0, labelY: height - padding.bottom + 14 };
  });
  const yTicks = [0, 0.5, 1].map((f) => ({
    y: +(padding.top + chartH - f * chartH).toFixed(1),
    value: Math.round(maxVal * f),
  }));
  return { width, height, empty: false, bars, yTicks, maxVal,
           yOf: (v) => +(padding.top + chartH - (v / maxVal) * chartH).toFixed(1),
           baselineY: padding.top + chartH, left: padding.left, right: width - padding.right };
}

/**
 * Horizontal bars, for the by-site breakdown.
 *
 * Horizontal on purpose: the site names are long ("Burot Egg Store",
 * "Saluyot Egg Store") and as vertical-axis labels they would be rotated or
 * clipped. A fixed label gutter keeps them readable and left-aligned.
 */
/**
 * Horizontal bars, one row per category.
 *
 * A row may carry `parts: [{ key, value, color }]`, in which case the bar is
 * returned pre-split into `segments` laid end to end — the by-site bars on the
 * compliance tabs stack good against exception the same way their trend does.
 * Rows without `parts` come back exactly as before, which is what keeps the
 * plain per-site bars on the other tabs unchanged.
 *
 * Scaling is on the row TOTAL either way, so a split bar and a plain bar of the
 * same total are the same length.
 */
export function hBarGeometry(rows, { width = 560, labelWidth = 132, barH = 22, gap = 8 } = {}) {
  if (!rows.length) return { width, height: 40, empty: true, bars: [] };
  const chartW = width - labelWidth - 52;               // 52 leaves room for the value
  const maxVal = Math.max(1, ...rows.map((r) => r.value));
  const bars = rows.map((r, i) => {
    const w = Math.max(2, (r.value / maxVal) * chartW);
    const y = i * (barH + gap);
    let segments = null;
    if (r.parts && r.parts.length) {
      let cursor = labelWidth;
      segments = r.parts
        // A zero part is dropped rather than drawn 0px wide: a site with only
        // Complete records must read as one clean navy bar, not navy with an
        // invisible sliver of red claiming an exception it does not have.
        .filter((p) => p.value > 0)
        .map((p) => {
          const sw = Math.max(2, (p.value / (r.value || 1)) * w);
          const seg = { key: p.key, color: p.color, value: p.value, x: +cursor.toFixed(1), w: +sw.toFixed(1) };
          cursor += sw;
          return seg;
        });
    }
    return {
      label: r.label, value: r.value,
      y, h: barH,
      x: labelWidth, w: +w.toFixed(1),
      valueX: labelWidth + w + 6,
      segments,
    };
  });
  return { width, height: rows.length * (barH + gap), empty: false, bars, labelWidth };
}

/**
 * What each operational-records tab measures.
 *
 * The six tabs share one layout and differ only in what counts as "good" and
 * whether the headline is a rate or a total — so this is a table, not six
 * components. What counts as compliant is NOT here: it is a flag on the list
 * value itself (`dropdown_options.isCompliant`), because the values are
 * admin-editable and a copy in this file could disagree with them. Everything
 * not marked compliant is an exception and shown in the danger tone.
 *
 * Only the dashboard's own tabs appear here. Deployment & Post Management
 * renders the same table component, and a tab absent from this map gets no
 * analytics block at all — which is why its seven tabs are unaffected.
 */
/**
 * Compare a stored status against a configured one.
 *
 * The stored value and the configured value are the SAME string in normal
 * operation, so this only matters when they have drifted — a value typed with
 * different capitalisation, or carrying a non-breaking space picked up from a
 * paste. Those classify every record as an exception and turn the whole
 * dashboard red with no error anywhere, which is the failure this softens.
 *
 * NFKC folds a no-break space to an ordinary one; runs of whitespace collapse;
 * case is ignored. It does NOT rescue a genuine rename ("Complete" ->
 * "Completed") — nothing at this layer can, which is why the list is also
 * guarded against deleting a value still in use.
 *
 * Comparison only. Nothing here rewrites what is stored.
 */
export function normaliseStatus(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export const sameStatus = (a, b) => normaliseStatus(a) === normaliseStatus(b);

/**
 * One series per STATUS, for the tabs that show every condition rather than a
 * compliant/exception split.
 *
 * Order and membership come from the list, so a value added in Manage Lists
 * appears without a code change, and any status found in the data but missing
 * from the list is appended rather than dropped — it still has to be counted.
 *
 * COLOUR is the one place a name is read. That is a coupling, and a deliberate
 * one: getting "Breach" red rather than whatever the palette happened to give
 * it is the point of the request. The blast radius is cosmetic and it degrades
 * rather than breaking — a renamed value falls through to its compliant colour
 * or the next palette entry, and every FIGURE on the page stays correct
 * because those read isCompliant, never a name. Matching is via sameStatus, so
 * re-casing or padding still lands.
 */
const STATUS_TONE = [
  { match: ["Normal", "OK", "Clear"],                    color: "var(--teal)" },
  { match: ["Alert", "Warning", "Caution"],              color: "var(--amber)" },
  { match: ["Breach", "Incident", "Security Breach"],    color: "var(--red)" },
  { match: ["Incomplete", "Partial", "Short"],            color: "var(--amber)" },
  { match: ["No Guards", "Unmanned", "Vacant"],           color: "var(--red)" },
  { match: ["Under Maintenance", "Maintenance"],         color: "var(--text-mute)" },
];

// Anything unrecognised, and not flagged compliant, cycles through these so two
// unknown values never share a colour.
const STATUS_FALLBACK = ["var(--blue)", "var(--gold)", "var(--navy)", "#7B4B94", "#C46A2B"];

export function statusSeries(statusList, present = []) {
  const known = (statusList || []).map((o) => o.value);
  const extra = present.filter((s) => s && s !== "(none)" && !known.some((k) => sameStatus(k, s)));
  const all = [...known, ...extra];

  let fallbackAt = 0;
  return all.map((value) => {
    const tone = STATUS_TONE.find((t) => t.match.some((m) => sameStatus(m, value)));
    const compliant = (statusList || []).some((o) => o.isCompliant && sameStatus(o.value, value));
    const color = tone ? tone.color
      : compliant ? "var(--teal)"
      : STATUS_FALLBACK[fallbackAt++ % STATUS_FALLBACK.length];
    return { key: value, label: value, color };
  });
}

// ---------------------------------------------------------------------------
// Reporting windows, for the count tabs only
// ---------------------------------------------------------------------------
//
// On Visitor and Vehicle Count the Period dropdown selects a WINDOW and the
// chart draws one bucket per day (or per month) inside it: "the daily activity
// for August", not "one bar per month". The four operational tabs keep reading
// Period as the bucket size, which is why none of this is shared with them.
//
// ops_records.date is a PH-local YYYY-MM-DD string with no time of day, so a
// day is the finest bucket that exists. Daily therefore means recent days, not
// hours — there is nothing finer to show and inventing it would be a lie.

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Monday-first, matching the Mon–Sun axis the weekly view draws.
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** The window a Period + reference resolve to: { from, to, unit }. */
export function windowFor(period, ref, today = new Date()) {
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (period === "weekly") {
    const start = ref ? new Date(ref + "T00:00:00") : startOfWeek(now);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    return { from: ymd(start), to: ymd(end), unit: "day" };
  }
  if (period === "monthly") {
    const [y, m] = (ref || `${now.getFullYear()}-${pad(now.getMonth() + 1)}`).split("-").map(Number);
    return { from: `${y}-${pad(m)}-01`, to: ymd(new Date(y, m, 0)), unit: "day" };
  }
  if (period === "quarterly") {
    const [y, q] = (ref || `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`)
      .split("-Q").map(Number);
    const first = (q - 1) * 3;
    return { from: `${y}-${pad(first + 1)}-01`, to: ymd(new Date(y, first + 3, 0)), unit: "month" };
  }
  if (period === "yearly") {
    const y = Number(ref || now.getFullYear());
    return { from: `${y}-01-01`, to: `${y}-12-31`, unit: "month" };
  }
  // Daily: the most recent 14 days, ending today. `ref` names the end day so
  // an earlier fortnight can still be reached from the selector.
  const end = ref ? new Date(ref + "T00:00:00") : now;
  const start = new Date(end); start.setDate(start.getDate() - 13);
  return { from: ymd(start), to: ymd(end), unit: "day" };
}

/**
 * What the Reference Period dropdown offers, newest first.
 *
 * Always anchored on TODAY, never on where the data happens to be: opening a
 * tab on the current month and finding it empty is a true answer, and silently
 * jumping to the last month with records would hide that.
 */
export function refOptions(period, today = new Date()) {
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const out = [];
  if (period === "weekly") {
    let w = startOfWeek(now);
    for (let i = 0; i < 12; i++) {
      const end = new Date(w); end.setDate(end.getDate() + 6);
      const sameMonth = w.getMonth() === end.getMonth();
      out.push({ value: ymd(w),
        label: sameMonth
          ? `${MONTHS[w.getMonth()].slice(0, 3)} ${w.getDate()}–${end.getDate()}, ${end.getFullYear()}`
          : `${MONTHS[w.getMonth()].slice(0, 3)} ${w.getDate()} – ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}, ${end.getFullYear()}` });
      w = new Date(w); w.setDate(w.getDate() - 7);
    }
    return out;
  }
  if (period === "monthly") {
    for (let i = 0; i < 18; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({ value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
                 label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    return out;
  }
  if (period === "quarterly") {
    let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
    for (let i = 0; i < 8; i++) {
      out.push({ value: `${y}-Q${q}`, label: `Q${q} ${y}` });
      q -= 1; if (q === 0) { q = 4; y -= 1; }
    }
    return out;
  }
  if (period === "yearly") {
    for (let i = 0; i < 5; i++) out.push({ value: String(now.getFullYear() - i), label: String(now.getFullYear() - i) });
    return out;
  }
  // Daily: rolling fortnights, each named by the day it ends on.
  for (let i = 0; i < 6; i++) {
    const end = new Date(now); end.setDate(end.getDate() - i * 14);
    const start = new Date(end); start.setDate(start.getDate() - 13);
    out.push({ value: ymd(end),
      label: i === 0 ? "Recent 14 days"
        : `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()} – ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}` });
  }
  return out;
}

export const defaultRef = (period, today = new Date()) => (refOptions(period, today)[0] || {}).value || "";

/** Axis label. Weekly reads as weekdays, which is the whole point of it. */
export function windowBucketLabel(bucket, unit, period) {
  const d = new Date(bucket + "T00:00:00");
  if (isNaN(d.getTime())) return bucket;
  if (unit === "month") return `${MONTHS[d.getMonth()].slice(0, 3)}`;
  if (period === "weekly") return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(d.getDay() + 6) % 7];
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

/** Long form, for the tooltip: "August 5, 2026" or "August 2026". */
export function windowBucketFull(bucket, unit) {
  const d = new Date(bucket + "T00:00:00");
  if (isNaN(d.getTime())) return bucket;
  return unit === "month"
    ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
    : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export const OPS_ANALYTICS = {
  guard_deployment: {
    kind: "rate",
    headline: "On-duty rate", exceptionsLabel: "Not on duty",
    trend: "stacked", trendTitle: "On duty vs other",
    stackedSites: true,
  },
  // Site Condition is MULTI-STATE, so it gets a series per condition rather
  // than the compliant/exception split the other three use. That was the
  // question deferred when stackedSites was introduced: folding Alert, Breach
  // and Under Maintenance into one red "problem" band would have answered
  // "is anything wrong" while hiding which of the three it was, and the whole
  // reason to look at this tab is to tell them apart.
  //
  // `stackMode: "status"` is what selects that. The other tabs stay binary:
  // on duty vs not, complete vs not, where the second band genuinely is one
  // thing.
  site_status: {
    kind: "rate", stackMode: "status",
    headline: "Normal", exceptionsLabel: "Alert or breach",
    trend: "stacked", trendTitle: "Site status activity",
    stackedSites: true,
  },
  // Stacked, like Patrol Video and for the same reason: a count-per-bucket line
  // is one uninformative dot at these volumes, while the split answers the
  // question the tab exists to ask.
  //
  // This status list has THREE values — Complete, Incomplete, No Guards — and
  // the two exception values collapse into one red series. Nothing here does
  // that mapping: both the KPI card and the chart derive the exception as
  // "everything that is not a good status", so they cannot disagree, and a
  // fourth value added from Manage Lists lands in the same series with no code
  // change. The legend says "Incomplete or no guards" because that is
  // `exceptionsLabel`, the same string the card above it prints.
  // Multi-state, like Site Condition: "No Guards" is a different severity from
  // "Incomplete", and the point of the tab is to tell them apart. Patrol Video
  // stays binary because Complete vs Incomplete genuinely is two things.
  site_manning: {
    kind: "rate", stackMode: "status",
    headline: "Complete", exceptionsLabel: "Incomplete or no guards",
    trend: "stacked", trendTitle: "Manning records",
    stackedSites: true,
  },
  // Stacked rather than a line: at these volumes a count-per-bucket line is a
  // single dot that says nothing, while the same records split Complete vs
  // Incomplete answer the question the tab exists to ask. The card keeps its
  // "Patrol records" heading — only the chart inside it changed.
  patrol_video: {
    kind: "rate",
    headline: "Complete", exceptionsLabel: "Incomplete",
    trend: "stacked", trendTitle: "Patrol records",
    stackedSites: true,
  },
  // These two read Period as a reporting WINDOW and draw one bar per day or
  // per month inside it. `windowed` is what selects that; the four
  // operational tabs do not carry it and are untouched.
  visitor_count: {
    kind: "total", headline: "Total visitors", windowed: true, noun: "visitor",
    trend: "bars", trendTitle: "Visitors over time",
  },
  vehicle_count: {
    kind: "total", headline: "Total vehicles", windowed: true, noun: "vehicle",
    trend: "bars", trendTitle: "Vehicles over time",
  },
};
