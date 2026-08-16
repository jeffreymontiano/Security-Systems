// Shared helpers for the Billing & SOA module.

// The web UI shows a real ₱ — browsers have fonts containing it. Generated
// PDFs must not; see src/lib/pdfMoney.js for why.
export function peso(n) {
  return `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function hours(n) {
  const v = Number(n || 0);
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
}

// 0.02 -> "2%", 0.1224 -> "12.24%". Percentages are stored as the decimal the
// engine multiplies by, matching billing_config, so every display of one goes
// through here rather than each caller multiplying by 100 its own way.
export function pct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return "";
  return `${String(Number((n * 100).toFixed(4)))}%`;
}

export function billingStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Issued") return "badge-progress";
  if (status === "Paid") return "badge-resolved";
  return "badge-closed";
}

export const BILLING_VIEWS = [
  { key: "periods", label: "Billing Periods" },
  { key: "clients", label: "Clients & Detachments" },
  { key: "rules", label: "Billing Rules" },
];

// A quantity is "overridden" when someone typed a value instead of accepting
// what attendance derived. Surfaced everywhere the figure appears, so an
// edited statement never looks like a computed one.
export function isOverridden(line, field) {
  return line[field] !== null && line[field] !== undefined;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "July 16 to 31, 2025" — the wording the agency's statements use. Parsed by
// hand rather than through Date, which would re-read a bare date in the
// browser's timezone and can shift it a day.
export function periodLabel(start, end) {
  if (!start || !end) return "";
  const [sy, sm, sd] = String(start).split("-").map(Number);
  const [ey, em, ed] = String(end).split("-").map(Number);
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd} to ${ed}, ${sy}`;
  if (sy === ey) return `${MONTHS[sm - 1]} ${sd} to ${MONTHS[em - 1]} ${ed}, ${sy}`;
  return `${MONTHS[sm - 1]} ${sd}, ${sy} to ${MONTHS[em - 1]} ${ed}, ${ey}`;
}
