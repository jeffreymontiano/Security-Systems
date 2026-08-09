// One KPI tile.
//
// Wraps the app's existing `.kpi-card` / `.kpi-label` / `.kpi-value` markup so
// every module renders the same thing, and adds what the modernisation asks
// for: a Bootstrap Icon, a soft shadow, a softer corner, and an optional trend
// indicator.
//
// It deliberately does NOT introduce Bootstrap's `.card`. `.kpi-card` lives
// inside `.kpi-grid`, which carries the 32px horizontal margin that keeps tiles
// aligned with `.section-card` beside them; swapping in Bootstrap's card and
// container padding is exactly the double-inset bug that margin exists to
// prevent. Bootstrap contributes the utilities (`shadow-sm`, `rounded-4`), the
// app keeps the layout.
//
// Nothing here fetches: a page passes the number it already loaded.

// The three tones `.kpi-card` actually styles (a coloured top border), plus the
// explicit no-tone. Anything else is passed straight through rather than
// swallowed, so adopting this component cannot silently drop a class a page was
// already setting — Training and Recruitment pass `cls:"blue"`, for which there
// is no rule in index.css today. It is inert either way; dropping it here would
// still have been a change made behind the page's back.
const TONE_CLASS = { good: "good", warn: "warn", danger: "danger", neutral: "" };

// Trend is presentational only — the caller decides what "up" means, because up
// is good for headcount and bad for absences.
const TREND = {
  up: { icon: "bi-arrow-up-short", cls: "text-success" },
  down: { icon: "bi-arrow-down-short", cls: "text-danger" },
  flat: { icon: "bi-dash", cls: "text-body-secondary" },
};

/**
 * <KpiCard label="Active" value={stats.active} tone="good" icon="bi-people" />
 * <KpiCard label="Absent" value={n} tone="danger" note="vs 3 last week"
 *          trend="up" trendLabel="up 2 on last week" />
 */
export default function KpiCard({
  label,
  value,
  note,
  tone = "neutral",
  icon,
  trend,
  trendLabel,
  className = "",
  // A peso total needs a smaller number than a count of four does, and Assets
  // already shrank its "Acquisition value" tile before this component existed.
  // Kept as an escape hatch so adopting KpiCard did not silently re-enlarge it.
  valueStyle,
  ...rest
}) {
  const t = TREND[trend];
  return (
    <div
      className={`kpi-card shadow-sm rounded-4 ${TONE_CLASS[tone] ?? tone ?? ""} ${className}`.trim()}
      {...rest}
    >
      <div className="d-flex align-items-center gap-2">
        {icon && (
          // Decorative: the label beside it already carries the meaning, so it
          // is hidden from assistive tech rather than read out twice.
          <i className={`bi ${icon} text-body-secondary`} aria-hidden="true" />
        )}
        <div className="kpi-label">{label}</div>
      </div>

      <div className="kpi-value" style={valueStyle}>{value ?? "—"}</div>

      {(note || t) && (
        <div className="kpi-note d-flex align-items-center gap-1">
          {t && (
            <>
              <i className={`bi ${t.icon} ${t.cls}`} aria-hidden="true" />
              {/* The direction is a colour and a glyph; spell it out for anyone
                  who gets neither. */}
              <span className="visually-hidden">{trendLabel || trend}</span>
            </>
          )}
          {note && <span>{note}</span>}
        </div>
      )}
    </div>
  );
}
