// Shared helpers for the Daily Security Report module. Mirrors the legacy
// dsrStatusBadgeClass so status colors stay identical to the vanilla app.

export function dsrStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Submitted") return "badge-progress";
  if (status === "Approved") return "badge-resolved";
  if (status === "Rejected") return "badge-open";
  return "badge-closed";
}

// Free-text body fields shared between the create form, the editable detail
// view, and the read-only detail view. `full` controls the wide layout.
export const DSR_TEXT_FIELDS = [
  { key: "shiftTurnover", label: "Shift turnover notes", full: true, placeholder: "What the incoming shift needs to know..." },
  { key: "visitorLog", label: "Visitor log", full: false, placeholder: "Summary of visitors during this shift" },
  { key: "vehicleLog", label: "Vehicle log", full: false, placeholder: "Summary of vehicles during this shift" },
  { key: "patrolReport", label: "Patrol report", full: true, placeholder: "Patrol rounds conducted, times, findings..." },
  { key: "securityObservations", label: "Security observations", full: true, placeholder: "Anything noteworthy observed during the shift" },
  { key: "siteIssues", label: "Site issues", full: true, placeholder: "Equipment, facility, or access issues to flag" },
];
