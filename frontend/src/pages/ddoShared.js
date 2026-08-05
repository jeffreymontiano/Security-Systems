// Shared helpers for the Duty Detail Order tab.

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Parsed by hand rather than through Date, which would re-read a bare date in
// the browser's timezone and can shift it a day.
const parts = (d) => String(d || "").slice(0, 10).split("-").map(Number);

export function shortDate(iso) {
  const [y, m, d] = parts(iso);
  if (!y || !m || !d) return "—";
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

export function periodPhrase(from, to) {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (!fy || !ty) return "—";
  if (fy === ty && fm === tm) return `${MONTHS[fm - 1]} ${fd}-${td}, ${fy}`;
  if (fy === ty) return `${MONTHS[fm - 1]} ${fd} to ${MONTHS[tm - 1]} ${td}, ${fy}`;
  return `${MONTHS[fm - 1]} ${fd}, ${fy} to ${MONTHS[tm - 1]} ${td}, ${ty}`;
}

// Today in PH terms (UTC+8), so validity reads the same wherever the browser is.
export function phToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function ddoStateBadgeClass(state) {
  if (state === "Issued") return "badge-resolved";
  if (state === "Draft") return "badge-closed";
  if (state === "Expired") return "badge-open";
  if (state === "Cancelled") return "badge-closed";
  return "badge-closed";
}

// The designations the source form uses. Free text is still allowed — a post
// may need a wording nobody anticipated — so this is a datalist, not a select.
export const DESIGNATIONS = ["SECURITY GUARD", "RELIEVER", "SECURITY OFFICER", "SHIFT-IN-CHARGE", "DETACHMENT COMMANDER"];

// Likewise for shifts: the form carries clock windows and the word BROKEN.
export const SHIFT_SUGGESTIONS = ["0600H-1800H", "1800H-0600H", "0800H-1700H", "BROKEN"];

export const RANKS = ["SG", "SO", "SS", "LG"];
