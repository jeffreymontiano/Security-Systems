// The disbursement file.
//
// A neutral CSV whose columns map one-for-one onto Xendit's bulk payout
// fields, so Stage 2 (calling the payout API directly) needs no format change
// and a provider swap is a change to this file alone.
//
// Pure — no database — so the exact bytes that reach the finance person can be
// asserted in a test without standing anything up.

const { xenditChannelCode } = require("./xenditChannels");

const COLUMNS = [
  "reference",
  "channel",
  "channel_code",
  "account_number",
  "account_name",
  "amount",
  "currency",
  "description",
];

// The idempotency key. In Stage 2 this becomes Xendit's external reference, so
// a retried payout can never pay twice — which is the whole reason it is
// derived from stable ids rather than a timestamp or a row order.
const itemReference = (batchId, employeeId) => `batch${batchId}-emp${employeeId}`;

// Amounts: plain decimal, two places, no symbol, no thousands separators.
// A comma inside a CSV field would be read as a column break, and a peso sign
// is not a number to anything downstream.
const amountFor = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

// RFC 4180 quoting: wrap anything containing a comma, quote or newline, and
// double any embedded quote. A guard named "Dela Cruz, Jr." must not shift
// every column after it.
function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (values) => values.map(csvField).join(",");

// One CSV row per guard.
//
// `description` is what the guard sees on their statement, so it names the
// agency and the period rather than a batch id nobody outside this system
// could interpret.
function buildRows({ batch, items, period, companyName }) {
  const label = `${companyName || "Payroll"} payroll ${period.periodStart}..${period.periodEnd}`;
  return items.map((i) => [
    itemReference(batch.id, i.employeeId),
    i.payoutChannel || "",
    xenditChannelCode(i.payoutChannel, i.payoutBankCode),
    i.payoutAccountNumber || "",
    i.payoutAccountName || "",
    amountFor(i.netAmount),
    "PHP",
    label,
  ]);
}

function buildCsv({ batch, items, period, companyName }) {
  const rows = buildRows({ batch, items, period, companyName });
  // Trailing newline: POSIX text convention, and some spreadsheet importers
  // drop the final record without it.
  return [csvRow(COLUMNS), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

// The filename the finance person will see in their downloads folder — dated
// and named so two pay periods can never be confused for one another.
const fileNameFor = (batch, period) =>
  `disbursement-batch${batch.id}-${period.periodStart}_${period.periodEnd}.csv`;

module.exports = { COLUMNS, itemReference, amountFor, csvField, buildRows, buildCsv, fileNameFor };
