// One badge, one status vocabulary.
//
// Fourteen modules each carry their own `*BadgeClass(status)` helper, and the
// same word is not always the same colour between them — "Submitted" is
// progress in one module and resolved in another. This component does NOT
// change that: a module passes its own mapper and gets byte-identical output,
// so adopting it is safe one page at a time. What it centralises is the MARKUP,
// so the dot, the sizing and the aria semantics stop being re-typed.
//
// The palette stays the app's own: muted fills with dark text and a leading
// status dot. Bootstrap's `.text-bg-danger` and friends are solid saturated
// blocks with white text — heavier than these tables want, and the brief is
// explicit that information density and the Brookside identity survive this
// migration. The contextual MEANING is already Bootstrap's (danger / warning /
// success / secondary); only the weight differs.

// The union of every module's vocabulary, for pages that have no mapper of
// their own. A word absent here falls back to the neutral "closed" grey rather
// than throwing or inventing a colour.
const DEFAULT_STATUS_CLASS = {
  // needs attention
  Open: "badge-open", Rejected: "badge-open", Lost: "badge-open",
  Suspended: "badge-open", "Under Repair": "badge-open", Absent: "badge-open",
  Overdue: "badge-open", Expired: "badge-open",
  // in motion
  "In Progress": "badge-progress", "Under Review": "badge-progress",
  "Under Investigation": "badge-progress", Pending: "badge-progress",
  Submitted: "badge-progress", Issued: "badge-progress", Computed: "badge-progress",
  Finalised: "badge-progress", "Partially Returned": "badge-progress",
  "On Leave": "badge-progress", Scheduled: "badge-progress",
  // settled
  Resolved: "badge-resolved", Approved: "badge-resolved", Completed: "badge-resolved",
  Active: "badge-resolved", Available: "badge-resolved", Paid: "badge-resolved",
  Returned: "badge-resolved", Finalized: "badge-resolved", Verified: "badge-resolved",
  // ended / inert
  Closed: "badge-closed", Cancelled: "badge-closed", Draft: "badge-closed",
  Retired: "badge-closed", Separated: "badge-closed", Applied: "badge-closed",
  // informational
  Present: "badge-present",
};

// Severity is its own axis and follows Bootstrap's contextual meaning exactly:
// Critical and High are danger, Medium warning, Low secondary.
const SEVERITY_CLASS = {
  Critical: "badge-sev-critical",
  High: "badge-sev-high",
  Medium: "badge-sev-medium",
  Low: "badge-sev-low",
};

export function statusBadgeClass(status) {
  return DEFAULT_STATUS_CLASS[status] || "badge-closed";
}
export function severityBadgeClass(severity) {
  return SEVERITY_CLASS[severity] || "badge-closed";
}

/**
 * <StatusBadge status="Open" />
 * <StatusBadge status={r.status} toClass={dsrStatusBadgeClass} />   // keep a module's own mapping
 * <StatusBadge severity="High" />
 * <StatusBadge status="Draft" title="Not yet filed with RCSU" />
 *
 * `toClass` wins over everything, so a module keeps its own colours while still
 * getting the shared markup.
 */
export default function StatusBadge({
  status,
  severity,
  toClass,
  className = "",
  title,
  ...rest
}) {
  const label = status ?? severity ?? "";
  const cls = toClass
    ? toClass(label)
    : severity !== undefined
      ? severityBadgeClass(severity)
      : statusBadgeClass(status);

  return (
    <span
      className={`badge ${cls} ${className}`.trim()}
      title={title}
      // Read out as a status rather than as loose text, so the colour is not
      // the only thing carrying the meaning.
      role="status"
      aria-label={title ? `${label} — ${title}` : label}
      {...rest}
    >
      {label || "—"}
    </span>
  );
}
