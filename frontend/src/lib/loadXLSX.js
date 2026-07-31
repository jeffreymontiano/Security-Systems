// Loads SheetJS (XLSX) from CDN on first use, the same way the legacy
// public/index.html did via a <script> tag. Kept out of the npm bundle on
// purpose: the published `xlsx` package on npm carries unpatched advisories,
// while the CDN build is the maintained one. Loading it lazily also keeps it
// off the critical path — the library is only fetched when a user actually
// clicks "Export to Excel".
//
// Resolves with the global XLSX object, or rejects if the script fails to
// load (e.g. offline), which the caller surfaces as a friendly message.

const CDN_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

let loadPromise = null;

export function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CDN_URL;
    script.async = true;
    script.onload = () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error("XLSX failed to initialize."));
    };
    script.onerror = () => {
      loadPromise = null; // allow a retry on the next click
      reject(new Error("Could not load the Excel export library."));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}
