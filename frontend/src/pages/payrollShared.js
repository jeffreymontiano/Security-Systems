// Shared helpers for the Payroll & Benefits module.

export function peso(n) {
  return `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function periodStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Computed") return "badge-progress";
  if (status === "Approved") return "badge-resolved";
  if (status === "Paid") return "badge-resolved";
  return "badge-closed";
}

export function thirteenthMonthStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Approved") return "badge-progress";
  if (status === "Paid") return "badge-resolved";
  return "badge-closed";
}

export const STATUTORY_TABS = [
  { key: "sss", label: "SSS" },
  { key: "philhealth", label: "PhilHealth" },
  { key: "pagibig", label: "Pag-IBIG" },
  { key: "withholding_tax", label: "Withholding Tax" },
  { key: "pay_rules", label: "Pay Rules" },
  { key: "premium_rules", label: "Night Diff & Holiday" },
];

// How a computed day was classified, for the per-day payslip breakdown.
export function dayTypeBadgeClass(dayType) {
  if (dayType === "Regular Holiday") return "badge-open";
  if (dayType === "Special Non-Working") return "badge-progress";
  return "badge-closed";
}
