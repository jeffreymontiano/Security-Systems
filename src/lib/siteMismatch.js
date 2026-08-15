/**
 * Does a manually-chosen duty site disagree with the roster? Pure, no DB.
 *
 * Both public forms let the submitter pick the site, because a guard on relief
 * duty works somewhere other than their assigned post and that choice drives
 * billing. The cost of getting it wrong is asymmetric and invisible: punches
 * are matched to roster rows by guardName|site, so a punch at a site the guard
 * is not rostered at matches NOTHING. The rostered post then reads Absent and
 * bills that client a LESS, while the punch reads as an unrostered duty day and
 * bills the other client an ADD. One wrong selection moves money at two clients
 * in opposite directions, and nothing on screen says so.
 *
 * So the comparison is made once, here, at submission — and the answer is
 * recorded on the row rather than recomputed later, because the roster can be
 * edited afterwards and the record must say what was true when it was filed.
 */

/**
 * Compare two site names the way the rest of the system compares list values:
 * case-, whitespace- and NFKC-insensitive. A pasted no-break space or a
 * different capitalisation is the same post, not a mismatch worth holding a
 * record out of billing for.
 */
function sameSite(a, b) {
  const norm = (s) =>
    String(s == null ? "" : s)
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * `rosteredSites` is every site the guard is rostered at on that date — plural,
 * because a broken shift or a same-day transfer can legitimately produce two.
 * The submitted site matching ANY of them is agreement.
 *
 * Returns { mismatch, rosteredSite }:
 *   mismatch=false, rosteredSite=<the matching one>   — they agree
 *   mismatch=true,  rosteredSite=<the rostered one(s)> — they disagree
 *   mismatch=false, rosteredSite=null                 — NOT ROSTERED AT ALL
 *
 * That last case is deliberately NOT a mismatch. An unrostered duty day is
 * already a first-class thing here: billing bills it as an ADD (a reliever or
 * an extra post), and attendance shows it as its own Present row. Flagging it
 * would hold a legitimate, already-handled case out of billing.
 */
function evaluateSite(submittedSite, rosteredSites) {
  const roster = (Array.isArray(rosteredSites) ? rosteredSites : [rosteredSites])
    .map((s) => String(s == null ? "" : s).trim())
    .filter(Boolean);

  if (roster.length === 0) return { mismatch: false, rosteredSite: null };

  const hit = roster.find((r) => sameSite(r, submittedSite));
  if (hit) return { mismatch: false, rosteredSite: hit };

  // Joined so the admin sees what the roster actually said, not just "no".
  return { mismatch: true, rosteredSite: roster.join(", ") };
}

module.exports = { sameSite, evaluateSite };
