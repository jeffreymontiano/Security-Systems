import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useSettings } from "../context/SettingsContext";
import NavIcon, { hasIcon } from "./NavIcons";

/**
 * The navy header bar every module page uses: icon, title, purpose sub-line,
 * plus whoever's logged in and a logout button on the right. `actions` slots
 * in module-specific buttons (Refresh, + New X, Share link, etc.).
 *
 * The header icon is derived automatically from the current route so it always
 * matches the module's sidebar icon — pages don't need to pass an icon. The
 * `icon` prop is still honored as a fallback for any route without a mapped
 * SVG (so nothing renders blank).
 *
 * TWO action groups, per the modernisation brief: `utilityActions` holds the
 * things done TO the current view (Export, Backup, Activity log, Share) and
 * sits left; `actions` holds the things that change data or session (+ New X)
 * and sits right beside the signed-in user. Both are optional and `actions`
 * behaves exactly as before, so every existing page keeps working untouched —
 * pages move their utility buttons across as their own phase comes up.
 */
export default function ModuleHeader({ icon, iconBg, title, subtitle, actions, utilityActions }) {
  const { companyName } = useSettings();
  const { pathname } = useLocation();
  const headerRef = useRef(null);

  // This bar is sticky at top:0 with z-index 40. Frozen table headers are also
  // sticky at the top, so without an offset they pin UNDERNEATH this bar and
  // look like they aren't frozen at all. Publish the bar's live height as a CSS
  // variable so those headers can park just below it. Measured rather than
  // hardcoded because the bar wraps to two rows on narrow screens.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty("--module-header-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    if (ro) ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", apply);
      // Pages without a module header fall back to 0 rather than inheriting a
      // stale offset from whichever module was open last.
      document.documentElement.style.setProperty("--module-header-h", "0px");
    };
  }, []);

  // Match the route to a nav icon by longest path prefix, so nested routes
  // like "/incidents/123" still resolve to the "/incidents" icon.
  const iconPath = resolveIconPath(pathname);
  const showSvg = iconPath && hasIcon(iconPath);

  return (
    <div className="header" ref={headerRef}>
      <div className="header-left">
        <div
          className="header-icon"
          style={iconBg ? { background: iconBg } : undefined}
        >
          {showSvg
            ? <NavIcon path={iconPath} size={28} />
            : icon}
        </div>
        <div className="header-title-block">
          <div className="eyebrow">CSOMS</div>
          <h1>{title}</h1>
          <div className="header-sub">{companyName} &middot; {subtitle}</div>
        </div>
      </div>
      <div className="header-actions">
        {utilityActions && (
          <div className="header-group" role="group" aria-label="View actions">
            {utilityActions}
          </div>
        )}
        {actions && (
          <div className="header-group" role="group" aria-label="Module actions">
            {actions}
          </div>
        )}
        {/* Who is signed in, Change password and Log out all moved to the
            bottom of the sidebar, where they appear once for the whole app
            instead of on all 21 module headers. Nothing is left here: an empty
            .header-user would still contribute its border-left and gap. */}
      </div>
    </div>
  );
}

// Reduce a full pathname to the base module path used as the icon key.
// "/incidents" -> "/incidents"; "/incidents/42" -> "/incidents".
function resolveIconPath(pathname) {
  if (!pathname) return null;
  const firstSegment = "/" + pathname.split("/").filter(Boolean)[0];
  return firstSegment === "/" ? null : firstSegment;
}
