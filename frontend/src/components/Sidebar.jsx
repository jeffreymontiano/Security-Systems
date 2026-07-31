import { NavLink } from "react-router-dom";
import { NAV_SECTIONS } from "../nav.config";
import { useAuth } from "../context/AuthContext";
import NavIcon from "./NavIcons";

export default function Sidebar() {
  const { isAdmin, isViewer } = useAuth();

  return (
    <nav className="app-sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7Z"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            />
            <path
              d="M9 12l2 2 4-4"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <div className="sidebar-brand-title">CSOMS</div>
          <div className="sidebar-brand-sub">Brookside Farms</div>
        </div>
      </div>

      {NAV_SECTIONS.map((section) => {
        const visibleItems = section.items.filter((item) => {
          if (item.adminOnly && !isAdmin) return false;
          if (item.hideForViewer && isViewer) return false;
          return true;
        });
        if (visibleItems.length === 0) return null;
        return (
          <div key={section.label}>
            <div className="sidebar-section-header">{section.label}</div>
            {visibleItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}
              >
                <span className="sidebar-badge"><NavIcon path={item.path} /></span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
