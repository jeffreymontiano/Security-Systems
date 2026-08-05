// Internal payout choice  ->  Xendit channel code.
//
// This is the ONLY place a provider's codes appear. Employee records store the
// human choice (GCASH / PAYMAYA / GOTYME / BANK), so re-coding a channel — or
// swapping provider entirely — changes this file and nothing else. No 201 File
// record has to be rewritten.
//
// !! CONFIRM WITH XENDIT DURING ONBOARDING BEFORE ANY REAL MONEY MOVES !!
// The e-wallet codes below are the documented PH ones. The BANK codes are NOT
// confirmed and are deliberately left empty rather than guessed: an invented
// code would produce a file that looks right and pays no one, or worse, pays
// the wrong rail. An empty code exports as blank and is visibly incomplete.

// E-wallets. `account_number` is the recipient's registered MOBILE number.
const EWALLET_CODES = {
  GCASH: "PH_GCASH",
  PAYMAYA: "PH_PAYMAYA",
};

// Banks and digital banks. `account_number` is a BANK ACCOUNT number.
//
// GoTyme is a digital bank, so it is reached through Xendit's bank/InstaPay
// channel list, not the e-wallet list. Its exact code must come from Xendit's
// Payouts channel-code list at onboarding.
const BANK_CODES = {
  // GOTYME: "PH_...",   // TODO: confirm GoTyme's bank channel code with Xendit
};

// Per-successful-payout disbursement fee, in pesos, used only to show an
// estimate before a file is uploaded. It moves no money and is labelled an
// estimate in the UI, which is why it sits here as a named constant rather
// than in an admin-editable table.
//
// Xendit publishes a flat PHP 10 per successful PH disbursement. Two things
// are expected to change it and are NOT modelled here:
//   - a per-transaction processing fee added to all transactions from 1 Oct 2026
//   - a monthly minimum invoice (~USD 50) that a low-value payout account may fall under
const DISBURSEMENT_FEE_PHP = 10;

// The Xendit channel code for an internal choice, or "" when it is not yet
// confirmed. Callers must treat "" as "not ready", never as a default.
function xenditChannelCode(payoutChannel, payoutBankCode) {
  const c = String(payoutChannel || "").trim().toUpperCase();
  if (EWALLET_CODES[c]) return EWALLET_CODES[c];
  if (c === "GOTYME") return BANK_CODES.GOTYME || "";
  // A generic bank carries its own code, captured per employee, because the
  // list of banks is long and changes on Xendit's side, not ours.
  if (c === "BANK") return String(payoutBankCode || "").trim().toUpperCase();
  return "";
}

// True when a destination can actually be addressed today. Used to warn in the
// UI that a row will export with a blank channel code.
const hasConfirmedCode = (payoutChannel, payoutBankCode) =>
  xenditChannelCode(payoutChannel, payoutBankCode) !== "";

module.exports = {
  EWALLET_CODES,
  BANK_CODES,
  DISBURSEMENT_FEE_PHP,
  xenditChannelCode,
  hasConfirmedCode,
};
