// Config for the Deployment & Post Management module. Mirrors the legacy
// OPS_TYPES entries in group "m11" exactly: each sub-tab is a config-driven
// table over the shared ops_records shape (date, site, label, status?, value?,
// notes). `statusListKey` / `valueListKey` point at live-editable dropdown
// lists (managed under "Manage Lists"); `statusOptions` is a static fallback.

export const DEPLOYMENT_TABS = [
  { type: "site_profiles",        tab: "Site Profiles",         title: "Site profiles",              labelText: "Site profile name", hasStatus: false, hasValue: true,  valueLabel: "Client / contract ref." },
  { type: "post_orders",          tab: "Post Orders",           title: "Post orders",                labelText: "Post order title",  hasStatus: true,  statusListKey: "post_orders_status", hasValue: false },
  { type: "deployment_planning",  tab: "Deployment Planning",   title: "Deployment planning",        labelText: "Guard name", labelFromEmployees: true,        hasStatus: true,  statusListKey: "deployment_planning_status", hasValue: true, valueLabel: "Post / shift" },
  { type: "reliever_management",  tab: "Reliever Management",   title: "Reliever management",        labelText: "Reliever name",     hasStatus: true,  statusListKey: "reliever_management_status", hasValue: true, valueLabel: "Covering for" },
  { type: "vacancy_tracking",     tab: "Vacancy Tracking",      title: "Vacancy tracking",           labelText: "Post name",         hasStatus: true,  statusListKey: "vacancy_tracking_status", hasValue: false },
  { type: "shift_assignments",    tab: "Shift Assignments",     title: "Shift assignments",          labelText: "Guard name", labelFromEmployees: true,        hasStatus: true,  statusListKey: "shift_assignments_status", hasValue: true, valueLabel: "Shift", valueListKey: "shift_assignments_shift" },
  { type: "manpower_requirements",tab: "Manpower Requirements", title: "Site manpower requirements", labelText: "Post / role",       hasStatus: false, hasValue: true,  valueLabel: "Guards required" },
  // Not an ops_records view. A Duty Detail Order is the document required by
  // RA 10591 and Rule 39 s.154-156 of RA 11917 authorising a named guard to
  // bear a named firearm at a named post, so it has its own tables, its own
  // workflow and its own PDF. "kind" tells DeploymentPage to render its
  // component instead of the generic table.
  { type: "duty_detail_order", tab: "Detail Duty Order", title: "Duty detail orders", kind: "custom" },
];

// Config lookup by record type.
export const DEPLOYMENT_CONFIG = Object.fromEntries(DEPLOYMENT_TABS.map((t) => [t.type, t]));

// The dropdown lists this module needs (deduped from the tab configs).
export const DEPLOYMENT_LIST_KEYS = [
  ...new Set(
    DEPLOYMENT_TABS.flatMap((t) => [t.statusListKey, t.valueListKey].filter(Boolean))
  ),
];

// Tabs backed by the generic ops_records table, as opposed to those that bring
// their own component.
export const isOpsRecordTab = (cfg) => !cfg || cfg.kind !== "custom";

// Resolve the option list for a config's status / value column: prefer the
// live dropdown list, fall back to any static array, else null.
export function statusOptionsFor(cfg, dropdowns) {
  return (cfg.statusListKey && dropdowns[cfg.statusListKey]) || cfg.statusOptions || [];
}
export function valueOptionsFor(cfg, dropdowns) {
  return (cfg.valueListKey && dropdowns[cfg.valueListKey]) || cfg.valueOptions || null;
}
