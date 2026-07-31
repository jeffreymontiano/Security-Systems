// Config for the Deployment & Post Management module. Mirrors the legacy
// OPS_TYPES entries in group "m11" exactly: each sub-tab is a config-driven
// table over the shared ops_records shape (date, site, label, status?, value?,
// notes). `statusListKey` / `valueListKey` point at live-editable dropdown
// lists (managed under "Manage Lists"); `statusOptions` is a static fallback.

export const DEPLOYMENT_TABS = [
  { type: "site_profiles",        tab: "Site Profiles",         title: "Site profiles",              labelText: "Site profile name", hasStatus: false, hasValue: true,  valueLabel: "Client / contract ref." },
  { type: "post_orders",          tab: "Post Orders",           title: "Post orders",                labelText: "Post order title",  hasStatus: true,  statusListKey: "post_orders_status", hasValue: false },
  { type: "deployment_planning",  tab: "Deployment Planning",   title: "Deployment planning",        labelText: "Guard name",        hasStatus: true,  statusListKey: "deployment_planning_status", hasValue: true, valueLabel: "Post / shift" },
  { type: "reliever_management",  tab: "Reliever Management",   title: "Reliever management",        labelText: "Reliever name",     hasStatus: true,  statusListKey: "reliever_management_status", hasValue: true, valueLabel: "Covering for" },
  { type: "vacancy_tracking",     tab: "Vacancy Tracking",      title: "Vacancy tracking",           labelText: "Post name",         hasStatus: true,  statusListKey: "vacancy_tracking_status", hasValue: false },
  { type: "shift_assignments",    tab: "Shift Assignments",     title: "Shift assignments",          labelText: "Guard name",        hasStatus: true,  statusListKey: "shift_assignments_status", hasValue: true, valueLabel: "Shift", valueListKey: "shift_assignments_shift" },
  { type: "manpower_requirements",tab: "Manpower Requirements", title: "Site manpower requirements", labelText: "Post / role",       hasStatus: false, hasValue: true,  valueLabel: "Guards required" },
];

// Config lookup by record type.
export const DEPLOYMENT_CONFIG = Object.fromEntries(DEPLOYMENT_TABS.map((t) => [t.type, t]));

// The dropdown lists this module needs (deduped from the tab configs).
export const DEPLOYMENT_LIST_KEYS = [
  ...new Set(
    DEPLOYMENT_TABS.flatMap((t) => [t.statusListKey, t.valueListKey].filter(Boolean))
  ),
];

// Resolve the option list for a config's status / value column: prefer the
// live dropdown list, fall back to any static array, else null.
export function statusOptionsFor(cfg, dropdowns) {
  return (cfg.statusListKey && dropdowns[cfg.statusListKey]) || cfg.statusOptions || [];
}
export function valueOptionsFor(cfg, dropdowns) {
  return (cfg.valueListKey && dropdowns[cfg.valueListKey]) || cfg.valueOptions || null;
}
