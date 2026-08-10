import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { NAV_SECTIONS } from "../nav.config";
import { useAuth } from "../context/AuthContext";
import { moduleKeyForPath } from "../lib/modulePerms";
import { useSettings } from "../context/SettingsContext";
import NavIcon from "./NavIcons";

export default function Sidebar() {
  const { isAdmin, isViewer, can, user, logout, openChangePassword } = useAuth();
  const { companyName, logoUrl } = useSettings();
  const { pathname } = useLocation();

  // Mobile only. Below 820px the sidebar collapses to its brand bar and the
  // module list opens over the content, rather than the horizontal scroll strip
  // it used to be — 21 modules in a 320px-wide scroller meant swiping blind
  // past most of them with the section headings hidden.
  //
  // State-driven React, not Bootstrap's collapse JS: no data-bs-toggle here.
  const [open, setOpen] = useState(false);

  // Navigating closes the panel. Without this it stays open over the page the
  // user just asked for.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Escape closes it too, for anyone driving this from a keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <nav className={`app-sidebar${open ? " is-open" : ""}`} aria-label="Modules">
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon" style={logoUrl ? { background: "#fff", padding: 3 } : undefined}>
          {logoUrl ? (
            <img src={logoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 5 }} />
          ) : (
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
          )}
        </div>
        <div className="sidebar-brand-text">
          <div className="sidebar-brand-title">CSOMS</div>
          <div className="sidebar-brand-sub">{companyName}</div>
        </div>

        {/* Only rendered as visible below 820px (see .sidebar-toggle). Icon-only,
            so it carries an explicit label rather than relying on the glyph. */}
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close module menu" : "Open module menu"}
        >
          <i className={`bi ${open ? "bi-x-lg" : "bi-list"}`} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-scroll">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) => {
            if (item.adminOnly && !isAdmin) return false;
            if (item.hideForViewer && isViewer) return false;
            // A view-restricted module (today only Executive Summary). Asks the
            // permissions the SERVER resolved, so what is hidden here and what
            // the API refuses can never drift apart.
            // The agency's access matrix, applied to navigation: a module the
            // role has no `view` on is not theirs to open, so it is not listed.
            // Derived from the route rather than repeated per item, so adding a
            // module to the matrix needs no change here.
            const moduleKey = moduleKeyForPath(item.path);
            if (moduleKey && !can(moduleKey, "view")) return false;
            if (item.requiresView && !can(item.requiresView, "view")) return false;
            // Shown to whoever may actually change something here, per the
            // privilege matrix. `adminOnly` on System Settings hid it from the
            // Owner and the Security Admin Officer, both of whom the server
            // has always accepted writes from.
            if (item.requiresEdit && !can(item.requiresEdit, "edit")) return false;
            // An explicit allow-list of stored role keys (Live Feed). Exact
            // match: Admin is listed where it applies rather than being implied,
            // so reading this line tells you exactly who sees the item.
            if (item.roles && !item.roles.includes(user?.role)) return false;
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
                  // The active class comes from React Router's own isActive, so
                  // it always reflects the real route rather than a class the
                  // app has to remember to toggle.
                  // NavLink also sets aria-current="page" on the active link by
                  // itself, so assistive tech is told which module is open
                  // without the gold bar being the only signal. Nothing to add
                  // here: only className, style and children take a render
                  // prop, and passing a function to aria-current would stringify
                  // it straight into the attribute.
                  className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}
                >
                  <span className="sidebar-badge"><NavIcon path={item.path} /></span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}

        {/* Pinned to the bottom of the sidebar, and the LAST CHILD of the
            scroller rather than a sibling of it. Below 820px .sidebar-scroll
            becomes the slide-out panel and .app-sidebar collapses to a 52px
            horizontal bar — a sibling would land in that bar beside the burger.
            As the last child it sits at the end of the opened panel instead.
            margin-top:auto pins it when the nav is short; position:sticky keeps
            it in view once the nav is long enough to scroll. */}
        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-name">{user?.name}</div>
            <div className="sidebar-user-role">{user?.role}</div>
          </div>
          <div className="sidebar-footer-actions">
            {/* Every role may change their OWN password, so this is not gated.
                The dialog itself is hosted in AppShell — see openChangePassword
                in AuthContext for why it cannot live in here. */}
            <button
              type="button"
              className="sidebar-action"
              onClick={openChangePassword}
              title="Change your password"
            >
              <i className="bi bi-key" aria-hidden="true" />
              <span>Change password</span>
            </button>
            <button type="button" className="sidebar-action" onClick={logout}>
              <i className="bi bi-box-arrow-right" aria-hidden="true" />
              <span>Log out</span>
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
