import { expiryStatus } from "./trainingShared";

/**
 * Certification-expiry indicator, matching the legacy expiryBadge():
 *   no date        → em dash
 *   past           → red "Expired <date>"
 *   within 30 days → blue "Expires <date>"
 *   otherwise      → plain date
 */
export default function ExpiryBadge({ date }) {
  const status = expiryStatus(date);
  if (status === "none") return <span style={{ color: "var(--text-mute)" }}>—</span>;
  if (status === "expired") return <span className="badge badge-open">Expired {date}</span>;
  if (status === "soon") return <span className="badge badge-progress">Expires {date}</span>;
  return <span style={{ color: "var(--text)" }}>{date}</span>;
}
