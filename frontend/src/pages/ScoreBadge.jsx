import { scoreBadgeClass } from "./complianceShared";

/** Audit score badge: "<n>%" colored by threshold, or an em dash when unscored. */
export default function ScoreBadge({ score }) {
  if (score === null || score === undefined) return <span style={{ color: "var(--text-mute)" }}>—</span>;
  return <span className={`badge ${scoreBadgeClass(score)}`}>{score}%</span>;
}
