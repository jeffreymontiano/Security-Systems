// Admin overrides on a payroll line — validation and recompute reconciliation.
//
// Pure: no DB access, so the rules can be tested without a database and cannot
// drift between the API and the compute path. The SUBSTITUTION itself lives in
// payrollEngine.js, because an override has to flow through the engine's own
// priority/cap/arrears ladder rather than be patched on afterwards.

const {
  OVERRIDABLE_FIELDS, OVERRIDABLE_STATUTORY, DERIVED_FIELDS, OVERRIDE_FIELD_CLASS,
} = require("./payrollEngine");

// A statutory override is a COMPLIANCE event, so its reason is structured
// rather than free text alone: "why" has to be answerable from the record
// months later, by someone who was not in the room.
const STATUTORY_REASON_CATEGORIES = [
  "Correction of a mis-assessed premium",
  "Retroactive adjustment",
  "Employee dispute",
  "Agency policy decision",
];
const MIN_REASON = 20;             // any override: 10 let "correction" through,
                                   // which tells an auditor nothing
const MIN_STATUTORY_REASON = 25;   // statutory: a sentence, not a word

/**
 * Is this a legal override to record? Returns { ok } or { ok:false, error }.
 *
 * Rejects rather than coerces, deliberately. `Number(null)` and `Number([])`
 * are both a finite 0, so a coercing check would accept an ABSENT value as a
 * deliberate "set this field to zero" — the same trap that produced NaN payroll
 * columns from a malformed rule value and a 99.5% PhilHealth under-withholding
 * from `ratePercent: 0.025`. An explicit 0 IS a real override and stays legal.
 */
function validateOverride({ fieldName, value, reason, reasonCategory } = {}) {
  if (!fieldName || typeof fieldName !== "string") {
    return { ok: false, error: "A field name is required." };
  }
  if (DERIVED_FIELDS.includes(fieldName)) {
    return {
      ok: false,
      error: `"${fieldName}" is a derived total and cannot be overridden. `
        + "Override the components it is built from and the total follows, so the "
        + "payslip always reconciles.",
    };
  }
  if (!OVERRIDABLE_FIELDS.includes(fieldName)) {
    return { ok: false, error: `"${fieldName}" is not an overridable payroll field.` };
  }

  let num;
  if (typeof value === "number") num = value;
  else if (typeof value === "string" && value.trim() !== "") num = Number(value);
  else return { ok: false, error: "An override value must be a number." };
  if (!Number.isFinite(num)) return { ok: false, error: "An override value must be a finite number." };
  if (num < 0) return { ok: false, error: "An override value cannot be negative." };

  const text = String(reason == null ? "" : reason).trim();
  if (!text) return { ok: false, error: "A reason is required for every override." };

  const isStatutory = OVERRIDABLE_STATUTORY.includes(fieldName);
  const min = isStatutory ? MIN_STATUTORY_REASON : MIN_REASON;
  if (text.length < min) {
    return {
      ok: false,
      error: isStatutory
        ? `A statutory override changes what is remitted, so its reason must be at least ${min} characters explaining why.`
        : `Please give a reason of at least ${min} characters.`,
    };
  }
  if (isStatutory && !STATUTORY_REASON_CATEGORIES.includes(String(reasonCategory || ""))) {
    return {
      ok: false,
      error: "A statutory override needs a reason category: "
        + STATUTORY_REASON_CATEGORIES.join(" / ") + ".",
    };
  }

  return {
    ok: true,
    value: Math.round((num + Number.EPSILON) * 100) / 100,
    reason: text,
    reasonCategory: isStatutory ? String(reasonCategory) : (reasonCategory ? String(reasonCategory) : null),
    fieldClass: OVERRIDE_FIELD_CLASS[fieldName],
    isStatutory,
  };
}

/**
 * The engine's overrides map for one employee, from their stored rows.
 *
 * A STALE override is still applied. Principle: do not auto-clear (that would
 * silently undo a human decision) and do not silently keep (that would let a
 * correction ride a base it was never taken against). It is applied AND
 * flagged, and the flag blocks Approve — the flag is what makes it not silent.
 */
function overridesMapFor(rows) {
  const map = new Map();
  for (const r of rows || []) map.set(r.fieldName, Number(r.overrideValue));
  return map;
}

/**
 * Compare each stored override against what the engine computed THIS run.
 *
 * `applied[].computedValue` is the value the override displaced on this
 * compute; the stored `computedValue` is the snapshot from when a human decided
 * to disagree with it. When they differ, the ground moved underneath the
 * override.
 *
 * The worked example is the PhilHealth incident: a rate typo made the engine
 * assess PHP 2.14, and the repair moved it to PHP 427.50. An override taken
 * against 2.14 must not silently ride the corrected figure — the whole point of
 * keeping the snapshot is to be able to notice that.
 *
 * Returns only rows whose status should CHANGE, so a no-op compute writes
 * nothing.
 */
function reconcileOverrides(stored, applied) {
  const freshByField = new Map((applied || []).map((a) => [a.field, Number(a.computedValue)]));
  const cents = (n) => Math.round(Number(n) * 100);
  const changes = [];
  for (const row of stored || []) {
    if (!freshByField.has(row.fieldName)) continue;   // not applied this run
    const fresh = freshByField.get(row.fieldName);
    const moved = cents(fresh) !== cents(row.computedValue);
    if (moved && row.status !== "stale") {
      changes.push({ id: row.id, status: "stale", staleComputedValue: fresh, fieldName: row.fieldName });
    } else if (moved && row.status === "stale" && cents(fresh) !== cents(row.staleComputedValue)) {
      // Already stale, but the base moved AGAIN. Re-record the newest figure so
      // the reviewer is shown what the engine says now, not an older divergence.
      changes.push({ id: row.id, status: "stale", staleComputedValue: fresh, fieldName: row.fieldName });
    } else if (!moved && row.status === "stale") {
      // The base came BACK to the value the override was taken against — a
      // recompute after a config repair being undone, for instance. It is no
      // longer a divergence, so it stops blocking Approve.
      //
      // AUTOMATIC, BUT NEVER SILENT. Leaving a period permanently unapprovable
      // over a divergence that no longer exists is the worse failure, so the
      // clear is automatic — but it is a status change on a money record, so the
      // caller audits it. `returnedTo` carries the figure the base came back to
      // so the entry can name it rather than say only that something changed.
      changes.push({
        id: row.id, status: "active", staleComputedValue: null,
        fieldName: row.fieldName, returnedTo: fresh,
      });
    }
  }
  return changes;
}

module.exports = {
  STATUTORY_REASON_CATEGORIES, MIN_REASON, MIN_STATUTORY_REASON,
  validateOverride, overridesMapFor, reconcileOverrides,
};
