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
