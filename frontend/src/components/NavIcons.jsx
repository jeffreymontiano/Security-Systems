// Inline SVG icons for the sidebar, keyed by nav path. Fully self-contained —
// nothing loads from a CDN, so this works even if the corporate network blocks
// external font/icon hosts. Icons are stroke-based (currentColor) so they
// inherit the sidebar link's text color and the active/gold state for free.
//
// To add a module: add a case here keyed by its nav.config path, then the
// sidebar picks it up automatically. Unknown paths fall back to a neutral dot.

const P = {
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  fill: "none",
  stroke: "currentColor",
};

// Each entry is the inner content of a 24x24 viewBox.
const PATHS = {
  "/scheduling": (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" {...P} />
      <path d="M3 10h18M8 2v4M16 2v4" {...P} />
      <path d="M8 14h3M14 14h2M8 18h3" {...P} />
    </>
  ),
  "/attendance": (
    <>
      <circle cx="12" cy="12" r="9" {...P} />
      <path d="M12 7v5l3 2" {...P} />
    </>
  ),
  "/leave": (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" {...P} />
      <path d="M3 10h18M8 2v4M16 2v4" {...P} />
      <path d="M9 15l2 2 4-4" {...P} />
    </>
  ),
  "/system-settings": (
    <>
      <circle cx="12" cy="12" r="3" {...P} />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" {...P} />
    </>
  ),
  "/201-file": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" {...P} />
      <circle cx="9" cy="10" r="2" {...P} />
      <path d="M6 16c0-1.7 1.3-3 3-3s3 1.3 3 3" {...P} />
      <path d="M15 9h4M15 12h4M15 15h2" {...P} />
    </>
  ),
  // Banknote — pay, not a generic currency mark, so it doesn't read as
  // "billing" beside it in the same section.
  "/payroll": (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" {...P} />
      <circle cx="12" cy="12" r="2.5" {...P} />
      <path d="M6 12h.01M18 12h.01" {...P} />
    </>
  ),
  // Receipt with a torn edge — deliberately unlike the "/dsr" folded page, as
  // both are documents and the two sit in different layers of the same nav.
  "/billing": (
    <>
      <path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-3 2-3-2-3 2V3a1 1 0 0 1 1-1Z" {...P} />
      <path d="M9 7h6M9 11h6M9 15h3" {...P} />
    </>
  ),
  // Box — the register holds physical things, security and non-security
  // alike. Distinct from the "/training" mortarboard, which is the other
  // angular shape in the set.
  "/assets": (
    <>
      <path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z" {...P} />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" {...P} />
    </>
  ),
  "/recruitment": (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" {...P} />
      <circle cx="9" cy="7" r="4" {...P} />
      <path d="M19 8v6M22 11h-6" {...P} />
    </>
  ),
  "/dashboard": (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" {...P} />
      <rect x="14" y="3" width="7" height="5" rx="1" {...P} />
      <rect x="14" y="12" width="7" height="9" rx="1" {...P} />
      <rect x="3" y="16" width="7" height="5" rx="1" {...P} />
    </>
  ),
  "/incidents": (
    <>
      <path d="M12 9v4M12 17h.01" {...P} />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" {...P} />
    </>
  ),
  "/deployment": (
    <>
      <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0Z" {...P} />
      <circle cx="12" cy="10" r="3" {...P} />
    </>
  ),
  "/dsr": (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" {...P} />
      <path d="M14 2v6h6M9 13h6M9 17h6" {...P} />
    </>
  ),
  // Stack of filed returns with a check — a periodic statutory filing, not the
  // single folded page "/dsr" uses for one day's report.
  "/security-reports": (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" {...P} />
      <path d="M8 13l2.5 2.5L16 10" {...P} />
    </>
  ),
  "/disciplinary": (
    <>
      <path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7Z" {...P} />
      <path d="M9 12l2 2 4-4" {...P} />
    </>
  ),
  "/performance": (
    <>
      <path d="M3 3v18h18" {...P} />
      <path d="M7 14l3-4 3 3 5-6" {...P} />
    </>
  ),
  "/training": (
    <>
      <path d="M22 10 12 5 2 10l10 5 10-5Z" {...P} />
      <path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5" {...P} />
    </>
  ),
  "/compliance": (
    <>
      <path d="M9 11l3 3L22 4" {...P} />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" {...P} />
    </>
  ),
  "/manage-users": (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...P} />
      <circle cx="9" cy="7" r="4" {...P} />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...P} />
    </>
  ),
  "/manage-lists": (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" {...P} />
      <path d="M3 6h.01M3 12h.01M3 18h.01" {...P} />
    </>
  ),
  "/live-feed": (
    <>
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" {...P} />
      <circle cx="5" cy="19" r="1.5" {...P} />
    </>
  ),
};

const FALLBACK = <circle cx="12" cy="12" r="4" {...P} />;

// True when `path` has a dedicated icon (not the neutral fallback). Lets
// callers like ModuleHeader decide whether to show the SVG or fall back to a
// passed-in character.
export function hasIcon(path) {
  return Object.prototype.hasOwnProperty.call(PATHS, path);
}

export default function NavIcon({ path, size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[path] || FALLBACK}
    </svg>
  );
}
