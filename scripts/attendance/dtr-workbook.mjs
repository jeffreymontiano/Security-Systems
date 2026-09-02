/**
 * The DTR's EXCEL half.
 *
 * What this proves, and why it cannot be checked by eye:
 *
 *   - A worked cell holds the NUMBER 12, not the string "12". A grid whose
 *     duties are text does not sum, so the client's own check of the Hours
 *     column against the grid silently returns zero.
 *   - A zero-duty code (DO / A / RTU / a leave code) holds TEXT, and appears
 *     exactly ONCE per day — in the upper band only. Rendered in both bands it
 *     would double-count when someone tallies the sheet by hand.
 *   - ONE SHEET PER DETACHMENT, named for the post, because the DTR is signed
 *     and filed per post.
 *
 * ESM because frontend/ is type:module. Run from the repo root:
 *   node scripts/attendance/dtr-workbook.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const XLSX = require(path.join(ROOT, "frontend", "node_modules", "xlsx"));
const { buildDtr } = require(path.join(ROOT, "src", "lib", "dtrReport"));
const { buildDtrWorkbook } = await import(
  pathToFileURL(path.join(ROOT, "frontend", "src", "pages", "dtrWorkbook.js")).href);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
};

const FROM = "2026-08-16", TO = "2026-08-31";
const row = (o) => ({ status: "Present", guardName: "G One", ...o });

const dtr = buildDtr({
  from: FROM, to: TO,
  siteMeta: [
    { site: "AAA", detachmentName: "AAA Farms", clientName: "A Client" },
    { site: "BBB", detachmentName: "BBB Farms", clientName: "A Client" },
  ],
  rows: [
    row({ site: "AAA", dutyDate: "2026-08-16", shiftKind: "Day", startTime: "06:00", endTime: "18:00" }),
    row({ site: "AAA", dutyDate: "2026-08-17", shiftKind: "Straight", startTime: "06:00", endTime: "06:00", crossesMidnight: true }),
    row({ site: "AAA", dutyDate: "2026-08-18", status: "Rest Day" }),
    row({ site: "AAA", dutyDate: "2026-08-19", status: "RTU" }),
    row({ site: "AAA", dutyDate: "2026-08-20", status: "On Leave", leaveType: "Sick Leave" }),
    row({ site: "BBB", guardName: "G Two", dutyDate: "2026-08-16", shiftKind: "Night", startTime: "18:00", endTime: "06:00", crossesMidnight: true }),
  ],
});

const wb = buildDtrWorkbook(XLSX, dtr, {
  companyName: "TEST AGENCY", preparedName: "SO Someone", preparedTitle: "Operation Officer",
});

console.log("1. ONE SHEET PER DETACHMENT\n");
check("two sheets", wb.SheetNames.length === 2, wb.SheetNames.join(" | "));
check("named for the post", wb.SheetNames.join("|") === "AAA Farms|BBB Farms", wb.SheetNames.join("|"));

console.log("\n2. CELL TYPES\n");
const ws = wb.Sheets["AAA Farms"];
const cells = Object.entries(ws).filter(([k]) => !k.startsWith("!"));
const twelves = cells.filter(([, c]) => c.v === 12);
check("worked cells exist", twelves.length > 0, `${twelves.length} cells hold 12`);
check("...and every one is a NUMBER, not text",
  twelves.every(([, c]) => c.t === "n"),
  JSON.stringify(twelves.filter(([, c]) => c.t !== "n").map(([k, c]) => `${k}:${c.t}`)));

for (const code of ["DO", "RTU", "SL"]) {
  const found = cells.filter(([, c]) => c.v === code);
  check(`"${code}" appears exactly once`, found.length === 1,
    `${found.length} occurrence(s): ${found.map(([k]) => k).join(",")}`);
  check(`..."${code}" is TEXT`, found.every(([, c]) => c.t === "s"),
    JSON.stringify(found.map(([, c]) => c.t)));
}

console.log("\n3. THE STRAIGHT DUTY IS TWO SEPARATE 12s ON ONE DATE\n");
{
  // Read the grid back: the DS row and the NS row for the same column.
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true });
  const dsRow = rows.find((r) => r[2] === "DS" && r[1] === "G One");
  const nsRow = rows[rows.indexOf(dsRow) + 1];
  check("the DS band row was found", Boolean(dsRow), JSON.stringify(rows.slice(0, 8)));
  check("the NS band follows it", Boolean(nsRow) && nsRow[2] === "NS", JSON.stringify(nsRow));
  // Column layout: No, Name, Shift, then the 16 days. 2026-08-17 is index 3+1.
  const col = 3 + 1;
  check("the tour's start date carries 12 in BOTH bands",
    dsRow[col] === 12 && nsRow[col] === 12, `DS=${dsRow[col]} NS=${nsRow[col]}`);
  // The following date holds a rest day in this fixture, so the point is not
  // that it is EMPTY -- it is that no 12 leaked onto it from the tour.
  check("no tour 12 leaks onto the FOLLOWING date",
    dsRow[col + 1] !== 12 && nsRow[col + 1] !== 12, `DS=${dsRow[col + 1]} NS=${nsRow[col + 1]}`);
  check("...and that date shows its own code once, in the upper band only",
    dsRow[col + 1] === "DO" && !nsRow[col + 1], `DS=${dsRow[col + 1]} NS=${nsRow[col + 1]}`);
  check("the guard's summary reads 3 days / 36 hours (1 day shift + a 2-day tour)",
    dsRow[dsRow.length - 2] === 3 && dsRow[dsRow.length - 1] === 36,
    JSON.stringify(dsRow.slice(-4)));
}

console.log("\n4. THE SHEET IS BRANDED AND CARRIES BOTH SIGNATORIES\n");
{
  const text = XLSX.utils.sheet_to_csv(ws);
  check("agency name", text.includes("TEST AGENCY"));
  check("detachment", text.includes("AAA Farms"));
  check("client", text.includes("A Client"));
  check("Checked by + the agency signatory", text.includes("Checked by:") && text.includes("SO Someone"));
  check("Certified correct by (blank rep is fine — the form is wet-signed)",
    text.includes("Certified correct by:"));
  check("the legend rides along", text.includes("12 = 12-hour shift"));
}

if (pass + fail < 18) {
  console.log(`\nFAIL: only ${pass + fail} assertions ran.`);
  process.exit(1);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
