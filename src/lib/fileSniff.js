/**
 * What a file actually IS, read from its leading bytes. Pure, no DB, no I/O.
 *
 * `req.file.mimetype` is whatever the browser said, and a public form's caller
 * need not be a browser — a multipart part can claim `image/png` and carry
 * anything at all. The existing forms trust that header. For the missing-time-
 * log uploads, which are public and unauthenticated, the claim is checked
 * against the bytes and a disagreement is refused.
 *
 * This is not virus scanning and does not pretend to be: nothing here inspects
 * content for malice. It establishes that a file offered as a JPEG is a JPEG,
 * so what an administrator later downloads is the kind of thing the form said
 * it accepted. The stored bytes are opaque and never executed; the download
 * route serves them as an attachment with the sniffed type.
 */

// Only the three types the form accepts. Deliberately not a general registry —
// an unrecognised signature is a rejection, not a lookup miss.
const SIGNATURES = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },   // "%PDF"
];

/**
 * The MIME type the bytes say this is, or null if it matches none of them.
 */
function sniffType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[i] !== sig.bytes[i]) { hit = false; break; }
    }
    if (hit) return sig.mime;
  }
  return null;
}

/**
 * `{ ok: true, mime }` when the bytes are one of the accepted types AND the
 * declared type agrees, else `{ ok: false, error }`.
 *
 * Agreement is checked because a mismatch is a signal in itself: a part
 * labelled `application/pdf` whose bytes are a JPEG is not a user error worth
 * silently correcting on a public endpoint.
 *
 * jpg/jpeg are treated as one; every other pairing must match exactly.
 */
function checkUpload(buffer, declaredMime) {
  const actual = sniffType(buffer);
  if (!actual) {
    return { ok: false, error: "That file is not a JPEG, PNG or PDF. Please attach a photo or a PDF." };
  }
  const declared = String(declaredMime || "").toLowerCase().split(";")[0].trim();
  const same = declared === actual || (actual === "image/jpeg" && declared === "image/jpg");
  if (!same) {
    return { ok: false, error: "That file's contents do not match its type. Please re-save it and try again." };
  }
  return { ok: true, mime: actual };
}

module.exports = { sniffType, checkUpload, SIGNATURES };
