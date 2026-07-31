// Shared helpers for the Training & Certification Management module. Mirrors
// the legacy TR_STAGES, trStatusBadgeClass, daysUntil, and expiry logic so
// labels, colors, and the 30-day expiry window stay identical.

export const TR_STAGES = ["Scheduled", "In Progress", "Completed", "Cancelled"];

export function trStatusBadgeClass(status) {
  if (status === "Scheduled") return "badge-open";
  if (status === "In Progress") return "badge-progress";
  if (status === "Completed") return "badge-resolved";
  if (status === "Cancelled") return "badge-closed";
  return "badge-open";
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

// Expiry status for a certification date: "none" | "expired" | "soon" | "ok".
export function expiryStatus(dateStr) {
  if (!dateStr) return "none";
  const d = daysUntil(dateStr);
  if (d < 0) return "expired";
  if (d <= 30) return "soon";
  return "ok";
}

// Dropdown lists this module uses (Manage Lists).
export const TRAINING_LIST_KEYS = ["training_type", "attendance_status", "exam_result"];
