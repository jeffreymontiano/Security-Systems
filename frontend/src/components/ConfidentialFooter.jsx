import { useSettings } from "../context/SettingsContext";
import { APP_FOOTER } from "../appBranding";

// Shared confidential footer shown at the bottom of every module page. Reads the
// live company name from settings, so changing the name in System Settings
// updates the footer everywhere at once. Replaces the previously-hardcoded
// "CONFIDENTIAL — BROOKSIDE FARMS CORPORATION — FOR INTERNAL USE ONLY" line.
export default function ConfidentialFooter() {
  const { companyName } = useSettings();
  return (
    <footer className="confidential">
      {/* The name is omitted entirely when settings have not loaded, rather than
          falling back to a hardcoded one. A former client's name stamped on
          another agency's confidential footer is worse than no name at all. */}
      <div>
        CONFIDENTIAL &mdash; {companyName ? `${companyName.toUpperCase()} — ` : ""}FOR INTERNAL USE ONLY
      </div>
      {/* Authorship of the SOFTWARE, beneath the client's own line. The two say
          different things — whose data this is, and whose software it is — so
          both are shown and neither replaces the other. */}
      <div style={{ marginTop: 4, opacity: 0.75, fontWeight: 400 }}>{APP_FOOTER}</div>
    </footer>
  );
}
