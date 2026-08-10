// Tab definitions for Manage Lists, in the same order and with the same labels
// as the legacy Settings pane. "kind" distinguishes the backend shapes:
//   - "named": /meta/classifications and /meta/sites — support add, inline
//     rename (cascades to existing incidents), and delete.
//   - "dropdown": /meta/dropdown/:listKey — support add and delete only.
//   - "payroll": /api/payroll/components — the Payroll & Benefits module's
//     earnings/deductions catalog. Richer than a flat string (kind, category,
//     taxable, frequency, default amount), so it renders its own editor
//     (PayrollComponentsTab in ManageListsPage.jsx) instead of the generic
//     named/dropdown row, but still lives here since it's list-like config.
//   - "holidays": /api/payroll/holidays — the holiday calendar driving holiday
//     pay. Two axes: type (Regular / Special Non-Working) sets the multiplier,
//     sites sets who it applies to (empty = nationwide, populated = a LOCAL
//     holiday). Rendered by HolidaysTab in ManageListsPage.jsx.
export const LIST_TABS = [
  { key: "classifications", label: "Classifications", kind: "named" },
  { key: "sites", label: "Sites / Facilities", kind: "named" },
  { key: "payroll_components", label: "Pay Components (Earnings & Deductions)", kind: "payroll" },
  { key: "payroll_holidays", label: "Holidays", kind: "holidays" },
  { key: "deployment_status", label: "Daily Manning – Deployment Status", kind: "dropdown" },
  { key: "site_condition", label: "Site Status – Site Condition", kind: "dropdown" },
  { key: "site_manning_status", label: "Site Manning Status", kind: "dropdown" },
  { key: "video_patrol_status", label: "Patrol Video – Video Patrol Status", kind: "dropdown" },
  { key: "post_orders_status", label: "Post Orders – Status", kind: "dropdown" },
  { key: "deployment_planning_status", label: "Deployment Planning – Status", kind: "dropdown" },
  { key: "reliever_management_status", label: "Reliever Management – Status", kind: "dropdown" },
  { key: "vacancy_tracking_status", label: "Vacancy Tracking – Status", kind: "dropdown" },
  { key: "shift_assignments_status", label: "Shift Assignments – Status", kind: "dropdown" },
  { key: "shift_assignments_shift", label: "Shift Assignments – Shift", kind: "dropdown" },
  { key: "violation_type", label: "Violation Type", kind: "dropdown" },
  { key: "penalty_type", label: "Penalty", kind: "dropdown" },
  { key: "promotion_recommendation", label: "Promotion Recommendation", kind: "dropdown" },
  { key: "training_type", label: "Training Type", kind: "dropdown" },
  { key: "attendance_status", label: "Attendance Status", kind: "dropdown" },
  { key: "exam_result", label: "Exam Result", kind: "dropdown" },
  { key: "compliance_area", label: "Compliance Area", kind: "dropdown" },
  { key: "corrective_action_status", label: "Corrective Action Status", kind: "dropdown" },
  { key: "position_title", label: "Position Title", kind: "dropdown" },
  { key: "background_check_status", label: "Background Check Status", kind: "dropdown" },
  { key: "license_verification_status", label: "License Verification Status", kind: "dropdown" },
  { key: "medical_exam_status", label: "Medical Exam Status", kind: "dropdown" },
  { key: "employment_status", label: "Employment Status", kind: "dropdown" },
  { key: "lesp_category", label: "LESP Category", kind: "dropdown" },
];
