// Single source of truth for sidebar navigation. Adding a new module means
// adding one entry here — the sidebar, routing, and active-state highlighting
// all derive from this instead of being hand-maintained in three places
// (as they were in the old index.html).
export const NAV_SECTIONS = [
  {
    label: "Core Layer",
    items: [
      { path: "/201-file", label: "Employee Master File (201 File) / HR Module", icon: "\u{1F4C7}" },
      { path: "/attendance", label: "Attendance & Timekeeping", icon: "\u23F1" },
      { path: "/leave", label: "Leave Management", icon: "\u{1F4C5}" },
      { path: "/payroll", label: "Payroll & Benefits", icon: "\u{1F4B0}" },
      { path: "/billing", label: "Billing & Statement of Account", icon: "\u{1F9FE}" },
      { path: "/assets", label: "Asset & Equipment Management", icon: "\u{1F6E0}" },
      { path: "/recruitment", label: "Recruitment, Hiring & Onboarding", icon: "\u{1F464}" },
    ],
  },
  {
    label: "Operation Layer",
    items: [
      { path: "/dashboard", label: "Security Operations Dashboard", icon: "\u25C9" },
      { path: "/incidents", label: "Incident Reporting & Investigation", icon: "!" },
      { path: "/deployment", label: "Deployment & Post Management", icon: "\u{1F4CD}" },
      { path: "/scheduling", label: "Shift Scheduling", icon: "\u{1F4C5}" },
      { path: "/dsr", label: "Daily Security Report", icon: "\u{1F4CB}" },
      { path: "/security-reports", label: "Security Reports", icon: "\u{1F5C2}" },
    ],
  },
  {
    label: "Compliance Layer",
    items: [
      { path: "/disciplinary", label: "Disciplinary Action & Infraction Management", icon: "\u2696" },
      { path: "/performance", label: "Performance Appraisal", icon: "\u{1F4C8}" },
      { path: "/training", label: "Training & Certification Management", icon: "\u{1F393}" },
      { path: "/compliance", label: "Compliance & Audit", icon: "\u2705" },
    ],
  },
  {
    label: "System Administration Layer",
    items: [
      { path: "/manage-users", label: "Manage Users", icon: "\u{1F465}", adminOnly: true },
      { path: "/manage-lists", label: "Manage Lists", icon: "\u{1F4CB}", hideForViewer: true },
      { path: "/system-settings", label: "System Settings", icon: "\u2699", adminOnly: true },
      { path: "/live-feed", label: "Live Feed", icon: "\u2630" },
    ],
  },
];
