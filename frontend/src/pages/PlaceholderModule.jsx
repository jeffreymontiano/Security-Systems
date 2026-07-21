import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";

/**
 * Temporary stand-in for every module during Phase 0. Once a module's real
 * implementation is built (Phase 2 onward), its route in App.jsx swaps this
 * out for the real component — nothing else about the routing changes.
 */
export default function PlaceholderModule({ icon, iconBg, title, subtitle, phase }) {
  return (
    <div className="module-view">
      <ModuleHeader icon={icon} iconBg={iconBg} title={title} subtitle={subtitle} />
      <PurposeBar>{subtitle}</PurposeBar>
      <div className="section-card">
        <div className="section-head">Not yet migrated</div>
        <div style={{ padding: "24px 18px" }} className="empty-hint">
          This module is still running on the current (vanilla JS) system.
          It's scheduled for {phase} of the React migration.
        </div>
      </div>
      <footer className="confidential">CONFIDENTIAL &mdash; BROOKSIDE FARMS CORPORATION &mdash; FOR INTERNAL USE ONLY</footer>
    </div>
  );
}
