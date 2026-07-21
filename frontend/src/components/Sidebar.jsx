import { NavLink } from "react-router-dom";
import { NAV_SECTIONS } from "../nav.config";
import { useAuth } from "../context/AuthContext";

export default function Sidebar() {
  const { isAdmin, isViewer } = useAuth();

  return (
    <nav className="app-sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon">!</div>
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
                <span className="sidebar-badge">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
