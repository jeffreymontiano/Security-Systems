// Shared helpers for the Employee Master File (201 File) / HR module.
// Mirrors incidentShared.js conventions: small pure helpers for badge classes
// and light formatting, no component logic.

export const EMPLOYMENT_STATUSES = ["Active", "Separated", "Suspended", "On Leave"];

// Map an employment status to one of the existing badge classes in index.css.
// Reuses the same visual language as incident statuses so the whole system
// reads consistently.
export function employmentStatusClass(status) {
  if (status === "Active") return "badge-resolved";   // teal/green = good standing
  if (status === "On Leave") return "badge-progress";  // amber = temporary
  if (status === "Suspended") return "badge-open";     // red = attention
  if (status === "Separated") return "badge-closed";   // grey = ended
  return "badge-closed";
}

// Days until a document expires (negative = already expired). Null when there's
// no expiry date. Dates are stored as plain YYYY-MM-DD strings like the rest of
// the system.
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  if (isNaN(target)) return null;
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// Expiry state for a document, used to render a small inline badge on
// clearances / licenses. Returns null when the document has no expiry date.
export function expiryState(expiryDate) {
  const d = daysUntil(expiryDate);
  if (d === null) return null;
  if (d < 0) return { cls: "badge-open", label: "Expired" };
  if (d <= 30) return { cls: "badge-progress", label: `Expires in ${d}d` };
  return { cls: "badge-resolved", label: "Valid" };
}

// A short, friendly file-size string for the documents list.
export function fileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Class for the small numeric count chips (documents / education / employment),
// matching the countChipClass pattern from the redesigned incident register.
export function countChipClass(n) {
  return "chip chip-count" + (Number(n) > 0 ? "" : " chip-zero");
}
