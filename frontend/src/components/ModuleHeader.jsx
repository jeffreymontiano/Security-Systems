import { useAuth } from "../context/AuthContext";

/**
 * The navy header bar every module page uses: icon, title, purpose sub-line,
 * plus whoever's logged in and a logout button on the right. `actions` slots
 * in module-specific buttons (Refresh, + New X, Share link, etc.).
 */
export default function ModuleHeader({ icon, iconBg, title, subtitle, actions }) {
  const { user, logout } = useAuth();

  return (
    <div className="header">
      <div className="header-left">
        <div className="header-icon" style={iconBg ? { background: iconBg } : undefined}>{icon}</div>
        <div className="header-title-block">
          <div className="eyebrow">CSOMS</div>
          <h1>{title}</h1>
          <div className="header-sub">Brookside Farms Corporation &middot; {subtitle}</div>
        </div>
      </div>
      <div className="header-actions">
        {actions}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 6, paddingLeft: 14, borderLeft: "1px solid rgba(255,255,255,0.25)" }}>
          <div style={{ textAlign: "right", lineHeight: 1.25 }}>
            <div style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>{user?.name}</div>
            <div style={{ color: "var(--gold)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{user?.role}</div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={logout}>Log out</button>
        </div>
      </div>
    </div>
  );
}
