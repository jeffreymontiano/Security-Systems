/**
 * What counts as a safe, storable external URL. Pure, no DB.
 *
 * Useful Links is a directory of addresses that other people will click, so the
 * scheme is the whole security question: a stored `javascript:` or `data:` URL
 * rendered into an href is script execution, not navigation. Only http and
 * https are allowed, and the check is on the PARSED protocol rather than a
 * string prefix — "  JavaScript:alert(1)" and "jav\tascript:alert(1)" both
 * defeat a startsWith() test and both are rejected here.
 *
 * The frontend runs an equivalent check for immediate feedback (see
 * usefulLinksShared.js), the same way roles.js is mirrored for the Vite build.
 * This one is authoritative: the API re-validates every write, because a
 * request does not have to come from the form.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Canonical form of a URL for storage and duplicate detection.
 *
 * Scheme and host are lowercased because they ARE case-insensitive per RFC
 * 3986 — "HTTPS://SSS.GOV.PH" and "https://sss.gov.ph" are the same address, so
 * treating them as two entries would be wrong. Path, query and fragment are
 * left exactly as typed: they are case-SENSITIVE, and a trailing slash or a
 * query parameter can be the difference between two legitimate pages. Nothing
 * else is normalised, deliberately.
 */
function canonicalUrl(raw) {
  const parsed = new URL(String(raw).trim());
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

/**
 * Validate a URL for Useful Links.
 *
 * Returns `{ ok: true, url }` with the canonical form, or `{ ok: false, error }`
 * carrying a message meant for the person who typed it. Never throws — a
 * malformed URL is an expected input here, not an exceptional one.
 */
function validateUrl(raw) {
  const trimmed = String(raw == null ? "" : raw).trim();
  if (!trimmed) return { ok: false, error: "URL is required." };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    // The common miss is a bare host: "www.example.com" parses as nothing at
    // all, so say what is missing rather than "invalid URL".
    return { ok: false, error: "Enter a full URL beginning with http:// or https:// (for example https://example.gov.ph)." };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    return { ok: false, error: "Only http:// and https:// links are allowed." };
  }
  // `new URL("https://")` throws, but "https:///path" and "http://?q=1" parse
  // with an empty host and would store an address that goes nowhere.
  if (!parsed.hostname) {
    return { ok: false, error: "That URL has no website address in it." };
  }

  return { ok: true, url: canonicalUrl(trimmed) };
}

module.exports = { validateUrl, canonicalUrl, ALLOWED_PROTOCOLS };
