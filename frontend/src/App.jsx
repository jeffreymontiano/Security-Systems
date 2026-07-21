import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Sidebar from "./components/Sidebar";
import LoginPage from "./pages/LoginPage";
import PlaceholderModule from "./pages/PlaceholderModule";

// Route table for every module. `icon`/`iconBg`/`title`/`subtitle` mirror the
// exact copy from the current production app so nothing reads as "new."
// `phase` just documents which migration phase will replace the placeholder;
// harmless to leave in once modules are real (it's simply unused then).
const MODULES = [
  { path: "/recruitment", title: "Recruitment, Hiring & Onboarding", subtitle: "Manage the entire guard recruitment process from application to first day", icon: "\u{1F464}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/dashboard", title: "Security Operations Dashboard", subtitle: "Central command center providing real-time visibility across security operations.", icon: "\u25C9", iconBg: "var(--blue)", phase: "Phase 4" },
  { path: "/incidents", title: "Incident Reporting & Investigation", subtitle: "Central Security Operations Management System", icon: "!", phase: "Phase 4" },
  { path: "/deployment", title: "Deployment & Post Management", subtitle: "Manage guard assignments and site coverage across all client locations.", icon: "\u{1F4CD}", iconBg: "var(--gold)", phase: "Phase 4" },
  { path: "/dsr", title: "Daily Security Report", subtitle: "Standardize daily reporting from all sites with structured digital workflows", icon: "\u{1F4CB}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/disciplinary", title: "Disciplinary Action & Infraction Management", subtitle: "Monitor employee discipline and enforce consistent compliance standards.", icon: "\u2696", iconBg: "var(--gold)", phase: "Phase 2" },
  { path: "/performance", title: "Performance Appraisal", subtitle: "Measure and continuously improve guard performance through structured evaluations.", icon: "\u{1F4C8}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/training", title: "Training & Certification Management", subtitle: "Ensure all personnel remain qualified, certified, and mission-ready.", icon: "\u{1F393}", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/compliance", title: "Compliance & Audit", subtitle: "Ensure adherence to company policies, client requirements, and labor regulations.", icon: "\u2705", iconBg: "var(--gold)", phase: "Phase 3" },
  { path: "/manage-users", title: "Manage Users", subtitle: "Create and manage system accounts", icon: "\u{1F465}", iconBg: "var(--blue)", phase: "Phase 5" },
  { path: "/manage-lists", title: "Manage Lists", subtitle: "Customize dropdown values used across the system", icon: "\u{1F4CB}", iconBg: "var(--blue)", phase: "Phase 5" },
  { path: "/live-feed", title: "Live Feed", subtitle: "Real-time visibility into activity across incidents and operational records.", icon: "\u2630", iconBg: "var(--navy)", phase: "Phase 4" },
];

function AppShell() {
  const { status } = useAuth();

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
      <Sidebar />
      <div className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/incidents" replace />} />
          {MODULES.map((m) => (
            <Route
              key={m.path}
              path={m.path}
              element={<PlaceholderModule {...m} />}
            />
          ))}
          <Route path="*" element={<Navigate to="/incidents" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/app">
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
