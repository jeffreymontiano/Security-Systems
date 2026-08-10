import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import DialogBehavior from "./components/DialogBehavior";
import ConfirmHost from "./components/ConfirmHost";
import ToastHost from "./components/ToastHost";
import PromptHost from "./components/PromptHost";
import ChangePasswordModal from "./components/ChangePasswordModal";
import ModuleHeader from "./components/ModuleHeader";
import { moduleKeyForPath } from "./lib/modulePerms";
import useStickyOffsets from "./lib/stickyOffsets";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { SettingsProvider } from "./context/SettingsContext";
import Sidebar from "./components/Sidebar";
import LoginPage from "./pages/LoginPage";
import PlaceholderModule from "./pages/PlaceholderModule";
import IncidentsPage from "./pages/IncidentsPage";
import DsrPage from "./pages/DsrPage";
import DeploymentPage from "./pages/DeploymentPage";
import SchedulingPage from "./pages/SchedulingPage";
import DashboardPage from "./pages/DashboardPage";
import DisciplinaryPage from "./pages/DisciplinaryPage";
import PerformancePage from "./pages/PerformancePage";
import TrainingPage from "./pages/TrainingPage";
import CompliancePage from "./pages/CompliancePage";
import RecruitmentPage from "./pages/RecruitmentPage";
import ManageUsersPage from "./pages/ManageUsersPage";
import ManageListsPage from "./pages/ManageListsPage";
import LiveFeedPage from "./pages/LiveFeedPage";
import AttendancePage from "./pages/AttendancePage";
import LeaveManagementPage from "./pages/LeaveManagementPage";
import PayrollPage from "./pages/PayrollPage";
import BillingPage from "./pages/BillingPage";
import AssetsPage from "./pages/AssetsPage";
import SecurityReportsPage from "./pages/SecurityReportsPage";
import SystemSettingsPage from "./pages/SystemSettingsPage";
import HrModulePage from "./pages/HrModulePage";
import ExecutiveSummary from "./pages/ExecutiveSummary";

// Route table for every module. `icon`/`iconBg`/`title`/`subtitle` mirror the
// exact copy from the current production app so nothing reads as "new."
// `phase` just documents which migration phase will replace the placeholder;
// harmless to leave in once modules are real (it's simply unused then).
//
// Once a module has a real page component, add it to REAL_COMPONENTS below —
// the route will use that instead of PlaceholderModule automatically.
const MODULES = [
  { path: "/attendance", title: "Attendance & Timekeeping Module", subtitle: "Monitor guard attendance and deployment in real time across all sites", icon: "\u23F1", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/leave", title: "Leave Management", subtitle: "Manage employee leave requests and approvals", icon: "\u{1F4C5}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/payroll", title: "Payroll & Benefits", subtitle: "Compute pay, statutory deductions, and benefits from attendance, overtime, and leave", icon: "\u{1F4B0}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/billing", title: "Billing & Statement of Account", subtitle: "Bill clients per detachment from the hours guards actually worked, and issue the Statement of Account", icon: "\u{1F9FE}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/assets", title: "Asset & Equipment Management", subtitle: "Track every issued asset — security and non-security — from issuance to return", icon: "\u{1F6E0}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/201-file", title: "Employee Master File (201 File) / HR Module", subtitle: "Central repository of all personnel records and government-required documents", icon: "\u{1F4C7}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/recruitment", title: "Recruitment, Hiring & Onboarding", subtitle: "Manage the entire guard recruitment process from application to first day", icon: "\u{1F464}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/dashboard", title: "Security Operations Dashboard", subtitle: "Central command center providing real-time visibility across security operations.", icon: "\u25C9", iconBg: "var(--blue)", phase: "Phase 4" },
  { path: "/incidents", title: "Incident Reporting & Investigation", subtitle: "Central Security Operations Management System", icon: "!", phase: "Phase 2" },
  { path: "/scheduling", title: "Shift Scheduling", subtitle: "Plan guard shift rotations across all sites", icon: "\u{1F4C5}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/deployment", title: "Deployment & Post Management", subtitle: "Manage guard assignments and site coverage across all client locations.", icon: "\u{1F4CD}", iconBg: "var(--gold)", phase: "Phase 2" },
  { path: "/dsr", title: "Daily Security Report", subtitle: "Standardize daily reporting from all sites with structured digital workflows", icon: "\u{1F4CB}", iconBg: "var(--gold)", phase: "Phase 2" },
  { path: "/security-reports", title: "Security Reports", subtitle: "File the agency's statutory returns — starting with the Monthly Disposition Report to RCSU", icon: "\u{1F5C2}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/disciplinary", title: "Disciplinary Action & Infraction Management", subtitle: "Monitor employee discipline and enforce consistent compliance standards.", icon: "\u2696", iconBg: "var(--gold)", phase: "Phase 2" },
  { path: "/performance", title: "Performance Appraisal", subtitle: "Measure and continuously improve guard performance through structured evaluations.", icon: "\u{1F4C8}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/training", title: "Training & Certification Management", subtitle: "Ensure all personnel remain qualified, certified, and mission-ready.", icon: "\u{1F393}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/compliance", title: "Compliance & Audit", subtitle: "Ensure adherence to company policies, client requirements, and labor regulations.", icon: "\u2705", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/manage-users", title: "Manage Users", subtitle: "Create and manage system accounts", icon: "\u{1F465}", iconBg: "var(--blue)", phase: "Phase 5" },
  { path: "/manage-lists", title: "Manage Lists", subtitle: "Customize dropdown values used across the system", icon: "\u{1F4CB}", iconBg: "var(--blue)", phase: "Phase 5" },
  { path: "/system-settings", title: "System Settings", subtitle: "Company branding \u2014 logo and name applied across all modules and reports", icon: "\u2699", iconBg: "var(--blue)", phase: "Phase 5", adminOnly: true },
  { path: "/executive-summary", title: "Executive Summary", subtitle: "Live operational position across every module, for leadership", icon: "◆", iconBg: "var(--gold)", phase: "Phase 6" },
  { path: "/live-feed", title: "Live Feed", subtitle: "Real-time visibility into activity across incidents and operational records.", icon: "\u2630", iconBg: "var(--navy)", phase: "Phase 4" },
];

// Modules with a finished, verified React page. Everything else still
// renders PlaceholderModule and keeps running on the legacy app at "/".
const REAL_COMPONENTS = {
  "/attendance": AttendancePage,
  "/leave": LeaveManagementPage,
  "/payroll": PayrollPage,
  "/billing": BillingPage,
  "/assets": AssetsPage,
  "/201-file": HrModulePage,
  "/incidents": IncidentsPage,
  "/dsr": DsrPage,
  "/security-reports": SecurityReportsPage,
  "/deployment": DeploymentPage,
  "/scheduling": SchedulingPage,
  "/dashboard": DashboardPage,
  "/disciplinary": DisciplinaryPage,
  "/performance": PerformancePage,
  "/training": TrainingPage,
  "/compliance": CompliancePage,
  "/recruitment": RecruitmentPage,
  "/manage-users": ManageUsersPage,
  "/manage-lists": ManageListsPage,
  "/system-settings": SystemSettingsPage,
  "/executive-summary": ExecutiveSummary,
  "/live-feed": LiveFeedPage,
};

/**
 * Blocks a module the current user has no `view` on, per the agency's access
 * matrix. Hiding the sidebar entry is a convenience; this is what answers
 * someone who types or bookmarks the URL. The API refuses independently — this
 * exists so they get a clear answer instead of a screen of failed requests.
 *
 * A route with no module key (`/dashboard`, `/live-feed`) is not governed by
 * the matrix and passes straight through to the page, which guards itself.
 */
function RequireModuleView({ module, children }) {
  const { can, permissions } = useAuth();
  const key = moduleKeyForPath(module.path);
  // Permissions are fetched, not derived in the browser. Render nothing until
  // they arrive rather than flashing an access-denied screen at a user who
  // turns out to have access.
  if (key && !permissions) return null;
  if (key && !can(key, "view")) {
    return (
      <div className="module-view">
        <ModuleHeader title={module.title} subtitle={module.subtitle} />
        <div className="section-card">
          <div className="section-head">Access restricted</div>
          <div style={{ padding: 18, fontSize: 13.5, lineHeight: 1.7 }}>
            Your role does not have access to this module. An administrator can grant it
            from Manage Users.
          </div>
        </div>
      </div>
    );
  }
  return children;
}

function AppShell() {
  const { status, mustChangePassword, clearMustChangePassword,
          changePasswordOpen, closeChangePassword } = useAuth();
  // Keyed on the route so navigating away from a crashed module clears the
  // error and the app recovers without a manual reload.
  const location = useLocation();
  // Measures the sticky title bars so frozen table headers park beneath them.
  useStickyOffsets();

  if (status === "checking") {
    // Same "don't flash the login screen" guard the vanilla app had while
    // it waits to hear back from /auth/me on a page refresh.
    return null;
  }
  if (status === "guest") {
    return <LoginPage />;
  }

  return (
    <div className="app-shell" id="appShell">
      {/* Focus trap, Escape, focus restore and scroll lock for all 68 dialogs.
          Renders nothing; mounted once here rather than repeated per modal. */}
      <DialogBehavior />
      {/* Serves confirm() from anywhere; renders nothing until asked. */}
      <ConfirmHost />
      {/* Transient confirmations; the stack is empty until something succeeds. */}
      <ToastHost />
      <PromptHost />
      {/* Opened from the sidebar footer, hosted here so it is not trapped in
          the sidebar's z-index:50 stacking context. A forced change (after an
          admin reset) outranks the button and cannot be dismissed. */}
      {(changePasswordOpen || mustChangePassword) && (
        <ChangePasswordModal
          forced={mustChangePassword}
          onClose={closeChangePassword}
          onChanged={() => { clearMustChangePassword?.(); closeChangePassword(); }}
        />
      )}
      <Sidebar />
      <div className="app-main">
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="/" element={<Navigate to="/incidents" replace />} />
            {MODULES.map((m) => {
              const RealComponent = REAL_COMPONENTS[m.path];
              const page = RealComponent ? <RealComponent /> : <PlaceholderModule {...m} />;
              return (
                <Route
                  key={m.path}
                  path={m.path}
                  // Typing the URL is blocked, not just hidden from the nav.
                  element={<RequireModuleView module={m}>{page}</RequireModuleView>}
                />
              );
            })}
            <Route path="*" element={<Navigate to="/incidents" replace />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/app">
      <AuthProvider>
        <SettingsProvider>
          <AppShell />
        </SettingsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
