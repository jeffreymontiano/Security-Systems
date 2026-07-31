// Shared helpers for the Incident Reporting & Investigation module.
// Mirrors the equivalent globals from the legacy public/index.html so
// behavior (labels, day-count math, badge colors) stays identical.

export const WORKFLOW_STAGES = ["Open", "Under Investigation", "Resolved", "Closed"];

export function daysBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

export function statusBadgeClass(status) {
  if (status === "Open") return "badge-open";
  if (status === "Under Investigation") return "badge-progress";
  if (status === "Resolved") return "badge-resolved";
  if (status === "Closed") return "badge-closed";
  return "badge-open";
}

export function sevBadgeClass(sev) {
  return "badge-sev-" + String(sev || "").toLowerCase();
}

export function fileIcon(mimetype) {
  if (mimetype === "application/pdf") return "\u{1F4C4}";
  if (mimetype && (mimetype.includes("word") || mimetype.includes("document"))) return "\u{1F4C4}";
  return "\u{1F4CE}";
}

const AUDIT_LABELS = {
  created: "Created incident",
  updated: "Updated details",
  stage_change: "Changed status",
  evidence_added: "Added evidence",
  evidence_removed: "Removed evidence",
  witness_added: "Added witness statement",
  witnesses_removed: "Removed witness statement",
  action_added: "Added corrective/preventive action",
  action_updated: "Updated corrective/preventive action",
  actions_removed: "Removed action",
  attachment_added: "Uploaded attachment",
  attachment_removed: "Removed attachment",
  deleted: "Deleted incident",
};

export function auditLabel(action) {
  return AUDIT_LABELS[action] || action;
}
