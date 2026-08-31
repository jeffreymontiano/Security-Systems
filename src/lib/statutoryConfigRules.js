/**
 * Validation for the six payroll_statutory_config rows. Pure - no DB, no I/O.
 *
 * WHY THIS EXISTS (Known Gap 22). `PUT /payroll/config/:key` accepted any
 * object. Three separate money incidents came out of that, and every one of
 * them stored a value that LOOKED plausible:
 *
 *   1. philhealth.ratePercent = 0.025 instead of 5 - the premium computed as
 *      0.025% of monthly comp, PHP 2.14 against PHP 427.50: a 99.5%
 *      under-withholding on both shares of every line computed while it stood.
 *   2. A rule value read through `?? default` arriving as NaN.
 *   3. pagibig.employerRate missing - `cfg?.employerRate || 0` made it a
 *      silent zero, so the agency's own share vanished while the employee's
 *      stayed correct and nothing on screen looked wrong.
 *
 * The engine was right in all three. The INPUT was not, and nothing checked it.
 *
 * SO THE BANDS ARE DELIBERATELY GENEROUS. They exist to catch order-of-
 * magnitude slips, zeros and missing keys - not to police policy. PhilHealth's
 * premium is legislated to rise; a band tight enough to argue with a real rate
 * change would be worse than no band at all, because it would be edited away.
 *
 * A `min` above 0 is how "zero is never legal here" is expressed. Where zero IS
 * legal - a grace window, a floor, the tax-exempt bottom bracket - `min` is 0
 * and the value passes untouched.
 */

const CONFIG_KEYS = ["sss", "philhealth", "pagibig", "withholding_tax", "pay_rules", "premium_rules"];

const CUTOFF_VALUES = ["first", "second", "split"];

// A number or a numeric string, and nothing else. `Number(null)`, `Number([])`
// and `Number("")` are all a finite 0 - the coercion trap that has now appeared
// three times in this system. Absent must never read as a deliberate zero.
function numeric(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// field spec: { min, max, int, nullable, why, note }
// `why` is used when the value is exactly 0 and 0 is out of band, because
// "must be at least 0.001" does not tell an admin what a zero would have DONE.
const SPECS = {
  philhealth: {
    fields: {
      ratePercent: {
        min: 0.5, max: 20,
        why: "a zero rate removes PhilHealth from every payslip entirely",
        note: "a PERCENT, not a fraction: 5 means 5%",
      },
      floor: { min: 0, max: 1000000 },
      ceiling: {
        min: 1, max: 10000000,
        why: "a zero ceiling clamps every contribution base to 0, so nothing is withheld",
      },
    },
    cross(c, add) {
      const floor = numeric(c.floor);
      const ceiling = numeric(c.ceiling);
      if (floor !== undefined && ceiling !== undefined && ceiling <= floor) {
        add("ceiling", `is ${ceiling}, which is not above the floor of ${floor}`,
          "a ceiling greater than the floor");
      }
    },
  },

  pagibig: {
    fields: {
      employeeRateLow: {
        min: 0.001, max: 0.1,
        why: "a zero rate removes the employee's Pag-IBIG contribution",
      },
      employeeRateHigh: {
        min: 0.001, max: 0.1,
        why: "a zero rate removes the employee's Pag-IBIG contribution",
      },
      // This string is rendered in the admin config banner, so it says what a
      // zero DOES rather than referring to the incident it came from. The
      // history belongs in the file header, not in a message an admin reads.
      employerRate: {
        min: 0.001, max: 0.1,
        why: "a zero rate silently removes the agency's own Pag-IBIG share, while the "
          + "employee's stays correct and nothing else looks wrong",
      },
      threshold: { min: 0, max: 100000 },
      salaryCap: {
        min: 1000, max: 1000000,
        why: "a zero cap makes the contribution base 0, so both shares compute to nothing",
      },
    },
    cross(c, add) {
      const lo = numeric(c.employeeRateLow);
      const hi = numeric(c.employeeRateHigh);
      if (lo !== undefined && hi !== undefined && hi < lo) {
        add("employeeRateHigh", `is ${hi}, below the low-tier rate of ${lo}`,
          "the high tier to be at least the low tier");
      }
    },
  },

  pay_rules: {
    fields: {
      otMultiplier: { min: 1, max: 3, why: "a zero multiplier makes all overtime unpaid" },
      monthlyDivisor: {
        min: 20, max: 31,
        why: "a zero divisor makes every daily-rate guard's monthly compensation 0, "
          + "which zeroes the entire statutory block",
      },
      graceMinutes: { min: 0, max: 120 },
      otThresholdMinutes: { min: 0, max: 240 },
    },
    enums: {
      sssCutoff: CUTOFF_VALUES,
      philhealthCutoff: CUTOFF_VALUES,
      pagibigCutoff: CUTOFF_VALUES,
    },
    booleans: ["withholdingTaxEnabled"],
  },

  premium_rules: {
    fields: {
      nightDiffPercent: { min: 0, max: 1, note: "a FRACTION, not a percent: 0.10 means 10%" },
      nightStartHour: { min: 0, max: 23, int: true },
      nightEndHour: { min: 0, max: 23, int: true },
      regularHolidayWorked: { min: 1, max: 4 },
      regularHolidayOt: { min: 1, max: 5 },
      regularHolidayUnworkedPay: { min: 0, max: 2 },
      specialDayWorked: { min: 1, max: 3 },
      specialDayOt: { min: 1, max: 4 },
      specialDayUnworkedPay: { min: 0, max: 2 },
    },
    booleans: ["requirePresenceDayBefore"],
  },

  sss: {
    // ee and er start above zero: a bracket that contributes nothing is not a
    // bracket. `ec` may be 0 - it is not read by the engine yet (Gap 30) and a
    // table without it is coherent.
    brackets: {
      cols: {
        minMsc: { min: 0, max: 200000 },
        maxMsc: { min: 0, max: 200000 },
        msc: { min: 0, max: 200000 },
        ee: { min: 0.01, max: 20000 },
        er: { min: 0.01, max: 20000 },
        ec: { min: 0, max: 5000 },
      },
      lower: "minMsc",
      upper: "maxMsc",
    },
  },

  withholding_tax: {
    // base 0 and rate 0 are LEGITIMATE and must stay legal: the bottom band
    // (0 - 10,416) is tax-exempt and is seeded exactly that way.
    brackets: {
      cols: {
        min: { min: 0, max: 100000000 },
        max: { min: 0, max: 100000000, nullable: true },
        base: { min: 0, max: 100000000 },
        rate: { min: 0, max: 0.6 },
      },
      lower: "min",
      upper: "max",
      openTop: true, // exactly one row may carry max: null, and it must be the highest
    },
    strings: ["frequency"],
  },
};

function validateStatutoryConfig(key, config) {
  const errors = [];
  const add = (field, why, expected) => errors.push({ field, why, expected });

  if (!CONFIG_KEYS.includes(key)) {
    return {
      ok: false,
      errors: [{ field: "key", why: `"${key}" is not a statutory config key`, expected: CONFIG_KEYS.join(", ") }],
    };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: [{ field: "config", why: "is not an object", expected: "a config object" }] };
  }

  const spec = SPECS[key];
  const known = new Set([
    ...Object.keys(spec.fields || {}),
    ...Object.keys(spec.enums || {}),
    ...(spec.booleans || []),
    ...(spec.strings || []),
    ...(spec.brackets ? ["brackets"] : []),
  ]);

  for (const [field, rule] of Object.entries(spec.fields || {})) {
    checkNumber(config[field], field, rule, add);
  }
  for (const [field, values] of Object.entries(spec.enums || {})) {
    const v = config[field];
    if (v === undefined || v === null) add(field, "is missing", `one of ${values.join(" | ")}`);
    else if (!values.includes(v)) add(field, `is ${JSON.stringify(v)}`, `one of ${values.join(" | ")}`);
  }
  for (const field of spec.booleans || []) {
    if (typeof config[field] !== "boolean") {
      add(field, config[field] === undefined ? "is missing" : `is ${JSON.stringify(config[field])}`,
        "true or false");
    }
  }
  for (const field of spec.strings || []) {
    const v = config[field];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
      add(field, `is ${JSON.stringify(v)}`, "a non-empty string");
    }
  }

  if (spec.brackets) checkBrackets(config.brackets, spec.brackets, add);
  if (spec.cross) spec.cross(config, add);

  // An unknown key is not harmless: `employerrate` for `employerRate` is
  // silently ignored by the engine and shows up only as a missing required
  // field with no clue why. Naming it points at the typo instead of leaving it
  // to be found in a payslip.
  for (const field of Object.keys(config)) {
    if (!known.has(field)) {
      add(field,
        "is not a recognised setting for this table (a misspelling is ignored by the engine, never applied)",
        `one of: ${[...known].join(", ")}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function checkNumber(raw, field, rule, add, where = "") {
  const label = where ? `${where}.${field}` : field;
  if (raw === undefined || raw === null) {
    if (rule.nullable) return;
    add(label, "is missing", describe(rule));
    return;
  }
  const n = numeric(raw);
  if (n === undefined) {
    add(label, `is ${JSON.stringify(raw)}, which is not a number`, describe(rule));
    return;
  }
  if (rule.int && !Number.isInteger(n)) {
    add(label, `is ${n}, which is not a whole number`, describe(rule));
    return;
  }
  if (n < rule.min || n > rule.max) {
    const why = n === 0 && rule.why ? `is 0 - ${rule.why}` : `is ${n}, outside the accepted range`;
    add(label, why, describe(rule));
  }
}

function describe(rule) {
  let s = `${rule.int ? "a whole number" : "a number"} between ${rule.min} and ${rule.max}`;
  if (rule.nullable) s += " (or null)";
  if (rule.note) s += ` - ${rule.note}`;
  return s;
}

function checkBrackets(rows, spec, add) {
  if (!Array.isArray(rows) || rows.length === 0) {
    add("brackets", rows === undefined ? "is missing" : "is empty or not a list",
      "at least one bracket row");
    return;
  }
  const cols = Object.keys(spec.cols);
  rows.forEach((row, i) => {
    const where = `brackets[${i}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      add(where, "is not an object", "a bracket row");
      return;
    }
    for (const [col, rule] of Object.entries(spec.cols)) checkNumber(row[col], col, rule, add, where);
    for (const col of Object.keys(row)) {
      if (!cols.includes(col)) {
        add(`${where}.${col}`, "is not a recognised bracket column", `one of: ${cols.join(", ")}`);
      }
    }
    const lo = numeric(row[spec.lower]);
    const hi = row[spec.upper] === null ? null : numeric(row[spec.upper]);
    if (lo !== undefined && hi !== undefined && hi !== null && hi < lo) {
      add(`${where}.${spec.upper}`, `is ${hi}, below ${spec.lower} of ${lo}`, `at least ${spec.lower}`);
    }
  });

  const openRows = rows.filter((r) => r && r[spec.upper] === null);
  if (spec.openTop) {
    if (openRows.length > 1) {
      add("brackets", `${openRows.length} rows have no upper bound`,
        `exactly one open-ended top bracket (${spec.upper}: null)`);
    }
  } else if (openRows.length > 0) {
    add("brackets", `${openRows.length} row(s) have a null ${spec.upper}`,
      "every bracket to carry an upper bound");
  }

  // Overlaps and GAPS. The gap is the dangerous one and it is invisible: the
  // engine's lookup finds no bracket for a compensation inside it and falls
  // back to brackets[0], the LOWEST - so a missing middle bracket silently
  // under-withholds rather than erroring. The real tables leave a 1-peso step
  // between rows (maxMsc 5000 then minMsc 5001), so 1 is the tolerated step.
  const sorted = rows
    .map((r, i) => ({
      i,
      lo: numeric(r && r[spec.lower]),
      hi: r && r[spec.upper] === null ? Infinity : numeric(r && r[spec.upper]),
    }))
    .filter((r) => r.lo !== undefined && r.hi !== undefined)
    .sort((a, b) => a.lo - b.lo);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    const cur = sorted[k];
    if (prev.hi === Infinity) {
      add("brackets", `the open-ended bracket (row ${prev.i}) is not the highest`,
        "the row with no upper bound to be the top bracket");
      continue;
    }
    if (cur.lo <= prev.hi) {
      add("brackets", `rows ${prev.i} and ${cur.i} overlap (${prev.hi} then ${cur.lo})`,
        "bracket ranges that do not overlap");
    } else if (cur.lo - prev.hi > 1) {
      add("brackets",
        `rows ${prev.i} and ${cur.i} leave a gap (${prev.hi} then ${cur.lo}) - a value inside it `
        + "silently falls to the LOWEST bracket",
        "consecutive brackets with no gap");
    }
  }
}

// The single string the config screen's error banner shows. It carries EVERY
// failing field, because `api()` surfaces body.error and nothing else - a
// summary count with the detail in a sibling array would never be read.
function describeErrors(key, errors) {
  const n = errors.length;
  return `${n} value${n === 1 ? "" : "s"} refused in the ${key} table. `
    + errors.map((e) => `${e.field} ${e.why}; expected ${e.expected}.`).join(" ");
}

module.exports = { validateStatutoryConfig, describeErrors, CONFIG_KEYS };
