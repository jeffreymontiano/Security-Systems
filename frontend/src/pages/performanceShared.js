// Shared helpers for the Performance Appraisal module. Mirrors the legacy
// PA_KPI_FIELDS and paStatusBadgeClass so labels/colors stay identical.

export const PA_STATUSES = ["Draft", "Submitted", "Finalized"];

export function paStatusBadgeClass(status) {
  if (status === "Draft") return "badge-closed";
  if (status === "Submitted") return "badge-progress";
  if (status === "Finalized") return "badge-resolved";
  return "badge-closed";
}

// The six KPI dimensions, each scored 1-5. The overall score is the average,
// computed server-side (shown as "X / 5").
export const PA_KPI_FIELDS = [
  { key: "attendanceScore", label: "Attendance" },
  { key: "incidentResponseScore", label: "Incident response" },
  { key: "patrolComplianceScore", label: "Patrol compliance" },
  { key: "dsrComplianceScore", label: "DSR submission compliance" },
  { key: "clientSatisfactionScore", label: "Client satisfaction" },
  { key: "appearanceDisciplineScore", label: "Appearance and discipline" },
];
