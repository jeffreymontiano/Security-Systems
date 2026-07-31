// Shared helpers for the Compliance & Audit module. Mirrors the legacy
// CA_STAGES, caStatusBadgeClass, and scoreBadge so labels/colors stay identical.

export const CA_STAGES = ["Scheduled", "In Progress", "Completed", "Cancelled"];

export function caStatusBadgeClass(status) {
  if (status === "Scheduled") return "badge-open";
  if (status === "In Progress") return "badge-progress";
  if (status === "Completed") return "badge-resolved";
  if (status === "Cancelled") return "badge-closed";
  return "badge-open";
}

// Audit score badge class: >=80 green, >=50 blue, else red.
export function scoreBadgeClass(score) {
  return score >= 80 ? "badge-resolved" : (score >= 50 ? "badge-progress" : "badge-open");
}

// Checklist compliant badge: Yes green, No red, N/A grey.
export function compliantBadgeClass(value) {
  if (value === "Yes") return "badge-resolved";
  if (value === "No") return "badge-open";
  return "badge-closed";
}
