// Payout destination details captured on the 201 File.
//
// Pure — no database — like payrollEngine.js and billingEngine.js, because
// three callers need the same answers and must never disagree: the employee
// route validating a save, the disbursement builder deciding who to skip, and
// the UI warning before either.
//
// Nothing here knows about a payment provider. The stored value is the human
// choice; provider codes live in xenditChannels.js.

// What the agency can pay INTO. GoTyme is a digital bank, not an e-wallet —
// it is reached by bank account number, which is why it sits with BANK rather
// than with the wallets.
const WALLET_CHANNELS = ["GCASH", "PAYMAYA"];
const BANK_CHANNELS = ["GOTYME", "BANK"];
const PAYOUT_CHANNELS = [...WALLET_CHANNELS, ...BANK_CHANNELS];

const CHANNEL_LABELS = {
  GCASH: "GCash",
  PAYMAYA: "Maya (PayMaya)",
  GOTYME: "GoTyme Bank",
  BANK: "Other bank",
};

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isWallet = (channel) => WALLET_CHANNELS.includes(str(channel).toUpperCase());
const isBank = (channel) => BANK_CHANNELS.includes(str(channel).toUpperCase());

// A PH mobile number as the wallets record it: 11 digits starting 09.
// Spaces, dashes and a +63 prefix are tolerated on input and normalised away,
// because that is how people actually type a number.
function normaliseMobile(v) {
  let d = str(v).replace(/[\s()-]/g, "");
  if (d.startsWith("+63")) d = "0" + d.slice(3);
  else if (d.startsWith("63") && d.length === 12) d = "0" + d.slice(2);
  return d;
}
const isPhMobile = (v) => /^09\d{9}$/.test(normaliseMobile(v));

// Account numbers are sensitive but not secret. Shown as the last four so a
// person can confirm the right destination without the full number appearing
// on screen, in an export preview, or in an audit trail.
function maskAccount(v) {
  const s = str(v);
  if (!s) return "";
  if (s.length <= 4) return `•••• ${s}`;
  return `•••• ${s.slice(-4)}`;
}

// Validate a payout destination.
//
// Returns { ok, errors[], warnings[] }. The split matters: errors are things
// that would make a payout fail outright and so block a save; warnings are
// things that merely look wrong. A guard's number failing the 09XXXXXXXXX
// shape is a warning, not an error — the spec is explicit that an unusual
// number must not hard-block, because the person entering it may know
// something the pattern does not.
function validatePayout({ payoutChannel, payoutAccountNumber, payoutAccountName, payoutBankCode } = {}) {
  const channel = str(payoutChannel).toUpperCase();
  const account = str(payoutAccountNumber);
  const name = str(payoutAccountName);
  const bank = str(payoutBankCode);
  const errors = [];
  const warnings = [];

  // No channel at all is a valid state: a guard may be paid in cash, or their
  // details may simply not have been collected yet.
  if (!channel) {
    if (account || name || bank) {
      warnings.push("Payout details were entered but no payout channel is selected, so they will not be used.");
    }
    return { ok: true, errors, warnings, channel: "", account: "", name: "", bank: "" };
  }

  if (!PAYOUT_CHANNELS.includes(channel)) {
    errors.push(`"${payoutChannel}" is not a payout channel this system knows.`);
    return { ok: false, errors, warnings, channel, account, name, bank };
  }

  if (!name) errors.push("An account holder name is required whenever a payout channel is set.");
  if (!account) {
    errors.push(isWallet(channel)
      ? "A mobile number is required for an e-wallet payout."
      : "A bank account number is required for a bank payout.");
  }
  if (isBank(channel) && !bank) {
    errors.push(channel === "GOTYME"
      ? "A bank code is required — GoTyme is reached by bank account, not by mobile number."
      : "A bank must be selected for a bank payout.");
  }

  if (isWallet(channel) && account && !isPhMobile(account)) {
    warnings.push(`"${account}" does not look like a Philippine mobile number (09XXXXXXXXX). Check it before paying out.`);
  }
  if (isBank(channel) && account && isPhMobile(account)) {
    warnings.push("That looks like a mobile number. A bank payout needs the bank ACCOUNT number.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    channel,
    // Wallet numbers are stored normalised so the same person entered two
    // different ways produces one destination.
    account: isWallet(channel) ? normaliseMobile(account) : account,
    name,
    bank: isBank(channel) ? bank : "",
  };
}

// Is this employee ready to be paid electronically? Used by the disbursement
// builder to decide who to skip, with a reason a person can act on.
function payoutReadiness(employee = {}) {
  const v = validatePayout(employee);
  if (!str(employee.payoutChannel)) {
    return { ready: false, reason: "No payout channel set on the 201 File." };
  }
  if (!v.ok) return { ready: false, reason: v.errors[0] };
  return { ready: true, reason: null, warnings: v.warnings };
}

module.exports = {
  PAYOUT_CHANNELS,
  WALLET_CHANNELS,
  BANK_CHANNELS,
  CHANNEL_LABELS,
  isWallet,
  isBank,
  isPhMobile,
  normaliseMobile,
  maskAccount,
  validatePayout,
  payoutReadiness,
};
