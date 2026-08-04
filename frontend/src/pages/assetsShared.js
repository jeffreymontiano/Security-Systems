// Shared helpers for the Asset & Equipment Management module.

export function peso(n) {
  return `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const ASSET_VIEWS = [
  { key: "register", label: "Asset Register" },
  { key: "issuance", label: "Issuance & Returns" },
  { key: "alerts", label: "Alerts" },
  { key: "classification", label: "Classification" },
];

export const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged"];
export const ASSET_STATUSES = ["Available", "Issued", "Under Repair", "Lost", "Retired"];
export const TRACKING_MODES = ["Serialized", "Bulk"];

export function assetStatusBadgeClass(status) {
  if (status === "Available") return "badge-resolved";
  if (status === "Issued") return "badge-progress";
  if (status === "Under Repair") return "badge-open";
  if (status === "Lost") return "badge-open";
  if (status === "Retired") return "badge-closed";
  return "badge-closed";
}

export function issuanceStatusBadgeClass(status) {
  if (status === "Returned") return "badge-resolved";
  if (status === "Issued") return "badge-progress";
  if (status === "Partially Returned") return "badge-progress";
  if (status === "Lost" || status === "Damaged") return "badge-open";
  return "badge-closed";
}

export function conditionBadgeClass(condition) {
  if (condition === "New" || condition === "Good") return "badge-resolved";
  if (condition === "Fair") return "badge-progress";
  return "badge-open";
}

// "Security  ›  Peripherals  ›  Search Light" — the full classification path,
// which is how anyone actually refers to an asset.
export function classificationPath(a) {
  return [a?.typeName, a?.categoryName, a?.subcategoryName].filter(Boolean).join("  ›  ") || "—";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parsed by hand rather than through Date, which would re-read a bare date in
// the browser's timezone and can shift it a day.
export function shortDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Today in PH terms (UTC+8), so a return due "today" means today in Manila
// regardless of where the browser is.
export function phToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
