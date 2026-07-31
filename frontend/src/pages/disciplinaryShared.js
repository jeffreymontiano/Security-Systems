// Shared helpers for the Disciplinary Action & Infraction Management module.
// Mirrors the legacy DA_STAGES and daStatusBadgeClass so labels and colors
// stay identical to the vanilla app.

export const DA_STAGES = ["Open", "Under Review", "Resolved", "Closed"];

export function daStatusBadgeClass(status) {
  if (status === "Open") return "badge-open";
  if (status === "Under Review") return "badge-progress";
  if (status === "Resolved") return "badge-resolved";
  if (status === "Closed") return "badge-closed";
  return "badge-open";
}
