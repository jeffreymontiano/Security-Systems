// Useful Links helpers shared by the page and its modal.
//
// The URL check here mirrors src/lib/urlSafety.js, the way roles.js mirrors the
// role keys: the Vite build is separate and cannot import from src/. It exists
// for IMMEDIATE feedback while typing, never as the protection — the API
// re-validates every write, because a request does not have to come from this
// form. If the two ever disagree, the server is right.

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * `{ ok: true }` or `{ ok: false, error }`, with the same wording the API uses
 * so a field does not say one thing before a save and another after it.
 */
export function checkUrl(raw) {
  const trimmed = String(raw == null ? "" : raw).trim();
  if (!trimmed) return { ok: false, error: "URL is required." };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter a full URL beginning with http:// or https:// (for example https://example.gov.ph)." };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    return { ok: false, error: "Only http:// and https:// links are allowed." };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "That URL has no website address in it." };
  }
  return { ok: true };
}

/**
 * The host, for the register's compact second line. Falls back to the raw
 * string rather than throwing — a row must render even if a URL predates the
 * validation somehow.
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Only ever called with a value that already passed checkUrl / the API, but the
// guard stays: this decides whether a string becomes a live href, and an
// unexpected scheme must render as text rather than as something clickable.
export function isSafeHref(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
}
