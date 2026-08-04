// Asset availability and alert derivation.
//
// Pure — no database — for the same reason payrollEngine.js and
// billingEngine.js are: three callers need these answers (the register list,
// the issue form's validation, and the alerts tab) and they must never
// disagree about whether an item can be handed out.

const { phDateOf, addDays } = require("./phTime");

const num = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

// An issuance is OPEN while the item, or part of it, is still with the
// holder. 'Lost' and 'Damaged' close it — the item is written off, not
// awaited — which is why they are not in this set.
const OPEN_ISSUANCE_STATUSES = ["Issued", "Partially Returned"];
const isOpen = (i) => OPEN_ISSUANCE_STATUSES.includes(i.status);

// What is still out for one issuance row.
function outstandingQuantity(issuance) {
  if (!isOpen(issuance)) return 0;
  return Math.max(0, num(issuance.quantity, 1) - num(issuance.quantityReturned));
}

// How many units of an asset can be issued right now.
//
//   Serialized  the item is one thing: it is available only when nothing is
//               out on it AND its status says it is fit to issue. A radio
//               under repair is not available even though nobody holds it.
//   Bulk        owned less outstanding. Derived from the ledger rather than
//               stored, so a stock figure can never drift from the issuances
//               that produced it.
function availableQuantity(asset, issuances = []) {
  const outstanding = issuances
    .filter((i) => String(i.assetId) === String(asset.id))
    .reduce((s, i) => s + outstandingQuantity(i), 0);

  if (asset.trackingMode === "Bulk") {
    if (asset.status === "Retired") return 0;
    return Math.max(0, num(asset.quantity, 0) - outstanding);
  }
  if (asset.status !== "Available") return 0;
  return outstanding > 0 ? 0 : 1;
}

// The status a serialized asset should carry given its open issuances. Used
// after every issue and return so the register and the ledger stay in step —
// nothing sets an asset to Issued by hand.
function derivedSerializedStatus(asset, issuances = []) {
  // Manual states are deliberate statements about the item itself and are
  // never overwritten by issuance activity.
  if (["Under Repair", "Lost", "Retired"].includes(asset.status)) return asset.status;
  const out = issuances
    .filter((i) => String(i.assetId) === String(asset.id))
    .reduce((s, i) => s + outstandingQuantity(i), 0);
  return out > 0 ? "Issued" : "Available";
}

// Everything the Alerts tab reports, derived on read. Nothing here is stored:
// an alert is a fact about today, and a stored one is a stale one.
//
//   overdue        due back before today and still out
//   dueSoon        due back within `dueSoonDays`
//   replacement    warranty or planned replacement date reached / approaching
//   lowStock       bulk stock at or below its reorder level
//
// `today` is PH local, not the server's UTC date — a return due "today" must
// mean today in Manila.
function deriveAlerts({ assets = [], issuances = [], today = null, dueSoonDays = 7, replacementWindowDays = 30 }) {
  const now = today || phDateOf(Date.now());
  const soonCutoff = addDays(now, dueSoonDays);
  const replacementCutoff = addDays(now, replacementWindowDays);

  const overdue = [];
  const dueSoon = [];
  for (const i of issuances) {
    if (!isOpen(i) || !i.expectedReturnDate) continue;
    const due = String(i.expectedReturnDate).slice(0, 10);
    const entry = { ...i, dueDate: due, daysOverdue: daysBetween(due, now) };
    if (due < now) overdue.push(entry);
    else if (due <= soonCutoff) dueSoon.push({ ...entry, daysUntilDue: daysBetween(now, due) });
  }

  const replacement = [];
  const lowStock = [];
  const byId = new Map();
  for (const i of issuances) {
    const k = String(i.assetId);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(i);
  }
  for (const a of assets) {
    if (a.status === "Retired") continue;
    const warranty = a.warrantyExpiry ? String(a.warrantyExpiry).slice(0, 10) : null;
    const planned = a.replacementDueDate ? String(a.replacementDueDate).slice(0, 10) : null;
    // Whichever comes first is the one worth acting on.
    const dates = [
      warranty && warranty <= replacementCutoff ? { kind: "Warranty expiry", date: warranty } : null,
      planned && planned <= replacementCutoff ? { kind: "Replacement due", date: planned } : null,
    ].filter(Boolean).sort((x, y) => x.date.localeCompare(y.date));
    if (dates.length) {
      replacement.push({ ...a, alertKind: dates[0].kind, alertDate: dates[0].date, expired: dates[0].date < now });
    }
    if (a.trackingMode === "Bulk" && num(a.reorderLevel) > 0) {
      const available = availableQuantity(a, byId.get(String(a.id)) || []);
      if (available <= num(a.reorderLevel)) lowStock.push({ ...a, available });
    }
  }

  overdue.sort((x, y) => y.daysOverdue - x.daysOverdue);
  dueSoon.sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  replacement.sort((x, y) => x.alertDate.localeCompare(y.alertDate));
  lowStock.sort((x, y) => x.available - y.available);

  return {
    overdue, dueSoon, replacement, lowStock,
    counts: {
      overdue: overdue.length, dueSoon: dueSoon.length,
      replacement: replacement.length, lowStock: lowStock.length,
      total: overdue.length + dueSoon.length + replacement.length + lowStock.length,
    },
  };
}

// Whole days from `from` to `to`, both 'YYYY-MM-DD'. Dates are compared at
// UTC midnight so no timezone can shift the count by a day.
function daysBetween(from, to) {
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// Next asset tag in a per-classification series, e.g. SEC-RAD-0007. Callers
// pass the tags already in use; this is deliberately not a database sequence
// because an admin may type their own tag (an engraved serial, a client's
// property number) and the series must simply skip past it.
function nextAssetTag(prefix, existingTags = []) {
  // Letters, digits and internal hyphens survive, so "SEC-RAD" yields
  // SEC-RAD-0001 rather than SECRAD-0001. Anything else is dropped, because
  // the prefix is interpolated into a regex below.
  const clean = (prefix || "AST").toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/^-+|-+$/g, "") || "AST";
  const re = new RegExp(`^${clean}-(\\d+)$`);
  let max = 0;
  for (const t of existingTags) {
    const m = re.exec(String(t || "").toUpperCase());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${clean}-${String(max + 1).padStart(4, "0")}`;
}

module.exports = {
  OPEN_ISSUANCE_STATUSES,
  isOpen,
  outstandingQuantity,
  availableQuantity,
  derivedSerializedStatus,
  deriveAlerts,
  daysBetween,
  nextAssetTag,
};
