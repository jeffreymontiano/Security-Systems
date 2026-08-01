import { useSettings } from "../context/SettingsContext";

// Shared confidential footer shown at the bottom of every module page. Reads the
// live company name from settings, so changing the name in System Settings
// updates the footer everywhere at once. Replaces the previously-hardcoded
// "CONFIDENTIAL — BROOKSIDE FARMS CORPORATION — FOR INTERNAL USE ONLY" line.
export default function ConfidentialFooter() {
  const { companyName } = useSettings();
  return (
    <footer className="confidential">
      CONFIDENTIAL &mdash; {(companyName || "Brookside Farms Corporation").toUpperCase()} &mdash; FOR INTERNAL USE ONLY
    </footer>
  );
}
