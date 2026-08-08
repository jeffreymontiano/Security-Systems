// Shared helpers for the Employee Master File (201 File) / HR module.
// Mirrors incidentShared.js conventions: small pure helpers for badge classes
// and light formatting, no component logic.

export const EMPLOYMENT_STATUSES = ["Active", "Separated", "Suspended", "On Leave"];

// Fixed dropdown option lists (hardcoded — small, stable sets that don't need
// to be editable via List Settings). Site is intentionally NOT here; it's
// sourced from the List Settings module instead.
export const GENDER_OPTIONS = ["Male", "Female"];

// Where an employee's net pay is sent. The stored value is this human choice —
// the payment provider's own channel codes live server-side in
// src/lib/xenditChannels.js, so a provider change never touches a 201 File.
//
// GoTyme is a digital BANK, not an e-wallet: it is reached by bank account
// number, which is why it needs a bank code and sits with BANK below.
export const PAYOUT_CHANNEL_OPTIONS = [
  { value: "", label: "— Not set (paid another way) —" },
  { value: "GCASH", label: "GCash", kind: "wallet" },
  { value: "PAYMAYA", label: "Maya (PayMaya)", kind: "wallet" },
  { value: "GOTYME", label: "GoTyme Bank", kind: "bank" },
  { value: "BANK", label: "Other bank", kind: "bank" },
];

export const payoutKind = (channel) =>
  PAYOUT_CHANNEL_OPTIONS.find((o) => o.value === channel)?.kind || null;

// Sensitive, not secret: show enough to confirm the destination, not enough to
// reuse it. Mirrors maskAccount() in src/lib/payoutDetails.js.
export function maskAccount(v) {
  const s = String(v || "").trim();
  if (!s) return "—";
  return s.length <= 4 ? `•••• ${s}` : `•••• ${s.slice(-4)}`;
}

// The wallets record an 11-digit PH mobile. A number failing this is worth
// flagging but never blocking — see payoutDetails.js for why.
export const looksLikePhMobile = (v) =>
  /^09\d{9}$/.test(String(v || "").replace(/[\s()-]/g, "").replace(/^\+63/, "0").replace(/^63(?=\d{10}$)/, "0"));

export const CIVIL_STATUS_OPTIONS = [
  "Single", "Married", "Widowed", "Legally Separated", "Annulled", "Divorced",
];

// Education levels, in ASCENDING order of attainment. The order is the RANK —
// "Highest Educational Attainment" on the 201 File is derived from it — so the
// picker deliberately lists them lowest-first rather than in some separate
// display order that could quietly disagree with the ranking.
//
// Note "College Undergraduate" sits BELOW "Associate Degree": an associate
// degree is a completed two-year credential, while an undergraduate has not
// finished one. The two were the other way round before attainment was derived,
// which would have reported a graduate as less educated than a leaver.
//
// Mirrors EDUCATION_LEVELS in src/lib/educationRank.js, which is the canonical
// copy; a unit check asserts the two never drift.
export const EDUCATION_LEVEL_OPTIONS = [
  "Junior High School",
  "Senior High School",
  "High School Graduate",
  "Vocational / Technical Certificate",
  "College Undergraduate",
  "Associate Degree",
  "Bachelor's Degree",
  "Postgraduate Diploma",
  "Master's Degree",
];

// Employment type/status on an employment-history entry (the nature of the
// engagement at that job), distinct from the employee's overall status above.
export const EMPLOYMENT_TYPE_OPTIONS = [
  "Regular", "Probationary", "Fixed-Term (Contractual)", "Project-Based",
  "Seasonal", "Casual", "OJT",
];

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
