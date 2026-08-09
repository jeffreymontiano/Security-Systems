// Shared helpers for the Recruitment, Hiring & Onboarding module. Mirrors the
// legacy RC_STAGES, rcStatusBadgeClass, and renderRecruitmentKpis.

// The 7 pipeline stages shown in the stepper. "Rejected" is intentionally NOT a
// stepper node — it's a separate "Mark as Rejected" action, matching the legacy
// app (the backend still accepts it as a valid stage).
export const RC_STAGES = ["Applied", "Screening", "Interview", "Background & Medical Checks", "Approved", "Hired", "Onboarded"];

export function rcStatusBadgeClass(status) {
  if (status === "Rejected") return "badge-open";
  if (status === "Hired" || status === "Onboarded") return "badge-resolved";
  if (status === "Applied") return "badge-closed";
  return "badge-progress";
}

// Dropdown lists used across the New form + detail sections.
export const RECRUITMENT_LIST_KEYS = [
  "position_title", "background_check_status", "license_verification_status",
  "medical_exam_status", "employment_status",
];

// Build KPI cards from the /recruitment/_all/stats payload (real stored data).
export function buildRecruitmentKpis(stats) {
  return [
    {
      label: "Time-to-Hire",
      value: stats.avgTimeToHireDays !== null && stats.avgTimeToHireDays !== undefined ? stats.avgTimeToHireDays + "d" : "—",
      note: "Avg. application to hire date", cls: "blue", icon: "bi-speedometer2",
    },
    {
      label: "Hiring Success Rate",
      value: stats.hiringSuccessRate !== null && stats.hiringSuccessRate !== undefined ? stats.hiringSuccessRate + "%" : "—",
      note: `${stats.hired} hired of ${stats.hired + stats.rejected} decided`,
      cls: (stats.hiringSuccessRate !== null && stats.hiringSuccessRate >= 60) ? "good" : "warn", icon: "bi-percent",
    },
    {
      label: "New Hire Retention",
      value: stats.retentionRate !== null && stats.retentionRate !== undefined ? stats.retentionRate + "%" : "—",
      note: `${stats.everHired - stats.separated} of ${stats.everHired} still active`,
      cls: (stats.retentionRate !== null && stats.retentionRate >= 80) ? "good" : "warn", icon: "bi-person-check",
    },
    { label: "Total Applicants", value: stats.total, note: "All time", cls: "blue", icon: "bi-people" },
  ];
}
