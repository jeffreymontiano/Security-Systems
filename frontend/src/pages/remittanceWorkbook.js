/**
 * The statutory remittance workbook (Known Gap 30, Phase 2).
 *
 * Extracted from the component so it can be TESTED. The rule it has to keep is
 * not visual and cannot be checked by eye:
 *
 *   A PENDING agency's total cell must hold TEXT, never a number.
 *
 * Every configured agency is expected every month, so a 0 there would be
 * indistinguishable from a genuine nil return -- and unlike the PDF, a
 * spreadsheet is summable: a SUM() down the totals would silently fold that
 * zero into a filing. Keeping the builder pure means a fixture can open the
 * produced sheet and assert the cell's TYPE, which is the only way to prove it.
 *
 * ONE SHEET PER AGENCY, so a pending agency is a visibly empty tab rather than
 * a missing one -- an absent tab reads as "not applicable", a present-but-empty
 * one reads as "owed, not yet available".
 */

// The .js extension is explicit, unlike most imports in this tree: Vite resolves
// an extensionless specifier but Node's ESM loader does not, and this module is
// loaded directly by scripts/payroll/remittance-workbook.mjs so the workbook it
// builds can be opened and asserted. Vite is unaffected by the extension.
import { brandedSheet } from "../lib/xlsxBranding.js";

// Mirrors PENDING_TOTAL_TEXT in src/lib/remittanceReport.js. The frontend
// cannot import from src/, and the server sends the report, not this label --
// so this copy exists. It is asserted equal to the server's by the fixture.
export const PENDING_TOTAL_TEXT = "PENDING - NOT YET COMPUTED";

export function buildRemittanceWorkbook(XLSX, report, companyName) {
  const wb = XLSX.utils.book_new();
  for (const ag of report.agencies) {
    const ws = brandedSheet(XLSX, {
      companyName,
      title: `${ag.label} - Statutory Remittance`,
      subtitle: `For the month of ${report.month}  ·  cutoff schedule: ${ag.cutoffMode}`,
    });

    if (ag.status === "pending") {
      // TEXT, never 0 -- see the header note. Nothing numeric goes on this sheet.
      XLSX.utils.sheet_add_aoa(ws, [
        ["STATUS", PENDING_TOTAL_TEXT],
        ["Reason", String(ag.pendingReason || "")],
        ["Total to remit", PENDING_TOTAL_TEXT],
        [],
        ["This agency has no figures for this month."],
        ["That is NOT a nil return - the payroll cutoff it draws from has not been computed yet."],
      ], { origin: -1 });
    } else {
      const header = ag.columns.map((c) => c.label);
      const body = ag.rows.map((r) => ag.columns.map((c) => (c.money ? (r[c.k] ?? "") : String(r[c.k] ?? ""))));
      XLSX.utils.sheet_add_aoa(ws, [header, ...body], { origin: -1 });
      XLSX.utils.sheet_add_aoa(ws, [
        [],
        [`${ag.label} TOTAL TO REMIT${ag.incomplete ? " (INCOMPLETE)" : ""}`, ag.total],
        ["Employee share", ag.totalEe],
        ["Employer share", ag.totalEr],
        ...(ag.hasEc ? [["EC (employer only)", ag.totalEc]] : []),
      ], { origin: -1 });
      if (ag.excluded.length) {
        XLSX.utils.sheet_add_aoa(ws, [
          [],
          [`EXCLUDED - no ${ag.idLabel} on file (NOT in the total above)`],
          ["Emp No", "Name", "Would have been"],
          ...ag.excluded.map((r) => [r.employeeNo, r.employeeName, r.total]),
        ], { origin: -1 });
      }
    }

    if (ag.warnings.length) {
      XLSX.utils.sheet_add_aoa(ws, [[], ["WARNINGS"], ...ag.warnings.map((w) => [w.text])], { origin: -1 });
    }
    XLSX.utils.book_append_sheet(wb, ws, ag.label.slice(0, 31));
  }
  return wb;
}
