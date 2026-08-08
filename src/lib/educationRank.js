// Educational attainment: the ordered levels, and the highest one an employee
// has reached.
//
// Pure — no database — like the other engines in this folder, because three
// callers need the same answer (the 201 File screen, the employee API, and any
// report that reads a 201 record) and they must not disagree about what a
// person has attained.
//
// THIS ARRAY IS THE RANK, AND IT IS ALSO THE DISPLAY ORDER. The Education tab's
// picker renders it in exactly this sequence, so there is one list and one
// order rather than a display order that quietly differs from the ranking. An
// earlier draft of this feature took the picker's own order as the rank, which
// put "College Undergraduate" above "Associate Degree" — reporting someone who
// completed a two-year degree as less educated than someone who left college
// without one.
//
// Mirrored at frontend/src/pages/employeeShared.js as EDUCATION_LEVEL_OPTIONS;
// a unit check asserts the two never drift, the same guarantee appBranding.js
// has.
//
// Ascending: index 0 is the least attainment, the last entry is the most.
const EDUCATION_LEVELS = [
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

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

// 1-based rank. 0 means "recorded, but not a level this system knows" — a
// legacy value or something typed straight into the database. Such an entry
// still counts as education; it simply loses to any known level.
function levelRank(level) {
  const want = str(level).toLowerCase();
  if (!want) return -1;                     // no level recorded at all
  const i = EDUCATION_LEVELS.findIndex((l) => l.toLowerCase() === want);
  return i === -1 ? 0 : i + 1;
}

// A year for tie-breaking. "2018" -> 2018; "2018-2022" -> 2022; anything with
// no four-digit year -> 0, which simply loses the tie-break.
function yearOf(v) {
  const years = str(v).match(/\d{4}/g);
  return years ? Math.max(...years.map(Number)) : 0;
}

// The highest attainment among an employee's education entries.
//
// Returns null when there is nothing to report — no entries, or entries that
// record a school but no level. The caller renders an em dash for that; it is
// an absence, not an error.
//
// Ties on the same level are broken by the later year graduated, then by the
// most recently added entry, so the answer is stable rather than arbitrary.
function highestEducation(entries = []) {
  let best = null;
  for (const e of entries) {
    const rank = levelRank(e && e.level);
    if (rank < 0) continue;                 // no level on this entry
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && yearOf(e.yearGraduated) > yearOf(best.entry.yearGraduated)) ||
      (rank === best.rank &&
        yearOf(e.yearGraduated) === yearOf(best.entry.yearGraduated) &&
        Number(e.id || 0) > Number(best.entry.id || 0))
    ) {
      best = { rank, entry: e };
    }
  }
  if (!best) return null;
  return {
    // The level as RECORDED, so an unrecognised value is reported honestly
    // rather than being dropped or mapped onto something it isn't.
    level: str(best.entry.level),
    rank: best.rank,
    known: best.rank > 0,
    schoolName: str(best.entry.schoolName),
    courseOrStrand: str(best.entry.courseOrStrand),
    yearGraduated: str(best.entry.yearGraduated),
  };
}

module.exports = { EDUCATION_LEVELS, levelRank, yearOf, highestEducation };
