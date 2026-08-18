/**
 * Which commit is actually running.
 *
 * Deploys here are backend-only as often as not, and the only deploy signature
 * available from outside was the frontend bundle's content hash — which does
 * not move when no frontend file changed. Three server-only deploys in a row
 * could not be confirmed from outside at all: the process was healthy either
 * way, and Render's zero-downtime swap means even a restart is invisible.
 *
 * Resolved ONCE at boot, because it cannot change while the process lives.
 *
 * Order matters. An environment variable set by the platform is authoritative:
 * it describes the commit that was BUILT, which is the question being asked.
 * Reading .git is the local-development fallback and is deliberately last —
 * in a container it would describe whatever happened to be copied in, and
 * that is only trustworthy because the image is built from a clean checkout.
 */
const fs = require("fs");
const path = require("path");

function fromGitDir() {
  try {
    const gitDir = path.join(__dirname, "..", "..", ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    // Detached HEAD holds the sha outright; otherwise it points at a ref.
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(4).trim();
    const refPath = path.join(gitDir, ref);
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim();
    // A packed ref, once loose refs have been gc'd.
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(" ")[0] : null;
  } catch {
    return null;   // not a checkout, or unreadable — reported as "unknown"
  }
}

const commit =
  process.env.RENDER_GIT_COMMIT        // Render sets this on every deploy
  || process.env.GIT_COMMIT            // generic, settable as a build arg
  || process.env.SOURCE_VERSION        // Heroku-style, harmless to accept
  || fromGitDir()
  || null;

const branch = process.env.RENDER_GIT_BRANCH || null;

module.exports = {
  commit,
  // What a human compares against `git log --oneline`. Never invent a value:
  // "unknown" is an honest answer and a wrong sha is worse than none.
  shortCommit: commit ? String(commit).slice(0, 7) : "unknown",
  branch,
  startedAt: new Date().toISOString(),
};
