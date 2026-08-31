/**
 * Gap 30 Phase 2 -- the EXCEL half.
 *
 * The rule being proved cannot be checked by eye and cannot be checked in the
 * PDF: a PENDING agency's total cell must hold TEXT, not a number. A
 * spreadsheet is summable, so a 0 there would be swept into a filing by a
 * SUM() down the totals column and would be indistinguishable from a genuine
 * nil return.
 *
 * This opens the workbook the app actually produces and asserts the CELL TYPE
 * ('s' string vs 'n' number) rather than its rendered text.
 *
 * ESM because frontend/ is type:module. Run from the repo root:
 *   node scripts/payroll/remittance-workbook.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const XLSX = require(path.join(ROOT, "frontend", "node_modules", "xlsx"));
const { buildRemittance, PENDING_TOTAL_TEXT: SERVER_PENDING_TEXT } =
  require(path.join(ROOT, "src", "lib", "remittanceReport"));
const { buildRemittanceWorkbook, PENDING_TOTAL_TEXT: UI_PENDING_TEXT } =
  await import(pathToFileURL(path.join(ROOT, "frontend", "src", "pages", "remittanceWorkbook.js")).href);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "\n          " + detail}`);
  ok ? pass++ : fail++;
};

const STATUTORY = {
  sss: { brackets: [{ minMsc: 0, maxMsc: 20000, msc: 18500, ee: 925, er: 1850, ec: 30 }] },
  pay_rules: { monthlyDivisor: 30, sssCutoff: "first", philhealthCutoff: "second", pagibigCutoff: "second" },
};
const EMPLOYEES = [
  { id: 1, sssNo: "34-1", philhealthNo: "PH-1", pagibigNo: "PI-1" },
  { id: 2, sssNo: "34-2", philhealthNo: "", pagibigNo: "PI-2" },
];
const L = (id) => ({
  employeeId: id, employeeNo: `E${id}`, employeeName: `Guard ${id}`, payType: "Daily", rateUsed: 570,
  sssEe: 925, sssEr: 1850, sssEc: 30, philhealthEe: 427.5, philhealthEr: 427.5, pagibigEe: 200, pagibigEr: 200,
});

// SSS is configured 'first' and only a SECOND-cutoff period exists -> SSS
// PENDING, the other two READY. Exactly the production shape.
const report = buildRemittance({
  month: "2026-08",
  periods: [{ id: 102, periodStart: "2026-08-16", periodEnd: "2026-08-31", status: "Approved" }],
  linesByPeriod: { 102: [L(1), L(2)] },
  employees: EMPLOYEES, statutory: STATUTORY,
});

const wb = buildRemittanceWorkbook(XLSX, report, "TEKM SECURITY AGENCY");

// Every cell of a sheet, as { addr, type, value }.
const cellsOf = (ws) => Object.keys(ws)
  .filter((k) => !k.startsWith("!"))
  .map((k) => ({ addr: k, type: ws[k].t, value: ws[k].v }));

console.log("1. ONE SHEET PER AGENCY -- A PENDING AGENCY IS A VISIBLE EMPTY TAB\n");
check("three sheets", wb.SheetNames.length === 3, JSON.stringify(wb.SheetNames));
check("named for the agencies",
  JSON.stringify(wb.SheetNames) === JSON.stringify(["SSS", "PhilHealth", "Pag-IBIG"]),
  JSON.stringify(wb.SheetNames));

console.log("\n2. THE LOAD-BEARING ONE -- A PENDING SHEET HOLDS NO NUMBER AT ALL\n");
const sssCells = cellsOf(wb.Sheets.SSS);
check("SSS resolved as pending in the report", report.agencies.find((a) => a.key === "sss").status === "pending");
const numerics = sssCells.filter((c) => c.type === "n");
check("the pending sheet contains ZERO numeric cells",
  numerics.length === 0, JSON.stringify(numerics));
const totalLabel = sssCells.find((c) => String(c.value) === "Total to remit");
check("it has a 'Total to remit' row", !!totalLabel);
const totalCell = totalLabel && wb.Sheets.SSS[totalLabel.addr.replace(/^A/, "B")];
check("...whose value cell is TYPE STRING ('s'), not number ('n')",
  totalCell && totalCell.t === "s", totalCell ? `type ${totalCell.t} value ${totalCell.v}` : "cell missing");
check("...and reads PENDING, not 0",
  totalCell && totalCell.v === PENDING_TOTAL_TEXT_UI(), totalCell && String(totalCell.v));
check("no cell anywhere on the pending sheet is the number 0",
  !sssCells.some((c) => c.type === "n" && c.v === 0));
check("the sheet says explicitly that this is NOT a nil return",
  sssCells.some((c) => /NOT a nil return/i.test(String(c.value))));
check("it names the cause",
  sssCells.some((c) => /1st-cutoff period not found/.test(String(c.value))),
  JSON.stringify(sssCells.map((c) => c.value).filter((v) => /cutoff/i.test(String(v)))));

function PENDING_TOTAL_TEXT_UI() { return UI_PENDING_TEXT; }

console.log("\n3. THE UI'S PENDING LABEL MATCHES THE SERVER'S\n");
check("frontend PENDING_TOTAL_TEXT === server PENDING_TOTAL_TEXT",
  UI_PENDING_TEXT === SERVER_PENDING_TEXT, `ui "${UI_PENDING_TEXT}" vs server "${SERVER_PENDING_TEXT}"`);

console.log("\n4. A READY SHEET DOES CARRY REAL NUMBERS\n");
const piCells = cellsOf(wb.Sheets["Pag-IBIG"]);
check("Pag-IBIG is ready", report.agencies.find((a) => a.key === "pagibig").status === "ready");
check("...and its sheet has numeric cells", piCells.some((c) => c.type === "n"));
const piTotalLabel = piCells.find((c) => /TOTAL TO REMIT/.test(String(c.value)));
check("...with a numeric TOTAL TO REMIT", !!piTotalLabel
  && wb.Sheets["Pag-IBIG"][piTotalLabel.addr.replace(/^A/, "B")]?.t === "n",
  piTotalLabel ? `type ${wb.Sheets["Pag-IBIG"][piTotalLabel.addr.replace(/^A/, "B")]?.t}` : "no total row");
check("...equal to the report's total (800 = 2 guards x (200+200))",
  wb.Sheets["Pag-IBIG"][piTotalLabel.addr.replace(/^A/, "B")]?.v === report.agencies.find((a) => a.key === "pagibig").total,
  String(wb.Sheets["Pag-IBIG"][piTotalLabel.addr.replace(/^A/, "B")]?.v));

console.log("\n5. MEMBER-ID EXCLUSION SURVIVES INTO THE WORKBOOK\n");
const phCells = cellsOf(wb.Sheets.PhilHealth);
check("PhilHealth lists an EXCLUDED block (guard 2 has no PhilHealth number)",
  phCells.some((c) => /EXCLUDED - no PhilHealth No/.test(String(c.value))),
  JSON.stringify(phCells.map((c) => c.value).filter((v) => /EXCLUD/i.test(String(v)))));
check("...and a WARNINGS block", phCells.some((c) => String(c.value) === "WARNINGS"));
check("...and its total counts ONE guard, not two",
  report.agencies.find((a) => a.key === "philhealth").total === 855,
  String(report.agencies.find((a) => a.key === "philhealth").total));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
