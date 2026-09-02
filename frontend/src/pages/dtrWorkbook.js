/**
 * The DTR Excel export — ONE SHEET PER DETACHMENT.
 *
 * A separate sheet per post rather than one long sheet, because the DTR is a
 * per-detachment document: it is signed, countersigned and filed per post, and a
 * single sheet would have to repeat the letterhead and signature block inline
 * for each one.
 *
 * Extracted from the page component so a fixture can open the produced workbook
 * and assert its CELL TYPES — the same reason `remittanceWorkbook.js` is its own
 * file. A grid where a `12` is stored as text sorts and sums as text, which
 * cannot be checked by eye.
 */
import { brandedSheet } from "../lib/xlsxBranding.js";
import { periodTitle } from "../lib/payrollPeriods.js";

/** Excel tab names cannot exceed 31 chars or contain : \ / ? * [ ] */
function sheetName(name, used) {
  let base = String(name || "Sheet").replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet";
  let out = base, n = 2;
  while (used.has(out)) {
    const suffix = ` (${n++})`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(out);
  return out;
}

/**
 * @param XLSX    the SheetJS module (imported by the caller so this file stays
 *                free of the dependency, as remittanceWorkbook does)
 * @param dtr     the /dtr payload
 * @param opts    { companyName }
 */
export function buildDtrWorkbook(XLSX, dtr, opts = {}) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const period = periodTitle({ from: dtr.from, to: dtr.to });

  for (const site of dtr.sites) {
    const rows = [];
    rows.push([`DETACHMENT/POST: ${site.detachmentName}`]);
    rows.push([`COMPANY NAME: ${site.clientName || ""}`]);
    rows.push([]);

    rows.push(["No.", "Name", "Shift", ...dtr.days.map((d) => d.weekday),
      "DS", "NS", "Days", "Hours"]);
    rows.push(["", "", "", ...dtr.days.map((d) => d.day), "", "", "", ""]);

    let n = 0;
    for (const g of site.guards) {
      n++;
      // Two rows per guard, DS above NS — the same two bands the PDF and the
      // screen use, so the three renderings cannot disagree about a cell.
      const worked = (c) => Boolean(c.ds || c.ns);
      rows.push([n, g.guardName, "DS",
        ...g.cells.map((c) => (c.ds ? 12 : (!worked(c) && c.note ? c.note : ""))),
        g.ds, "", g.days, g.hours]);
      rows.push(["", "", "NS",
        ...g.cells.map((c) => (c.ns ? 12 : "")),
        "", g.ns, "", ""]);
    }
    for (let i = 0; i < site.blankSlots; i++) {
      n++;
      rows.push([n, "", "DS", ...dtr.days.map(() => ""), 0, "", 0, 0]);
      rows.push(["", "", "NS", ...dtr.days.map(() => ""), "", 0, "", ""]);
    }

    rows.push(["", "TOTAL man-hours", "", ...site.perDayHours,
      site.totals.ds, site.totals.ns, site.totals.days, site.totals.hours]);
    rows.push([]);
    rows.push(["LEGEND", ...dtr.legend.map(([code, meaning]) => `${code} = ${meaning}`)]);
    rows.push([]);
    rows.push(["Checked by:", opts.preparedName || "", opts.preparedTitle || "",
      "", "Certified correct by:", site.repName || "", site.repTitle || ""]);

    const ws = brandedSheet(XLSX, {
      companyName: opts.companyName || "",
      title: `Daily Time Record — ${site.detachmentName}`,
      subtitle: `Period covered: ${period}${site.clientName ? "  ·  " + site.clientName : ""}`,
    });
    XLSX.utils.sheet_add_aoa(ws, rows, { origin: -1 });
    XLSX.utils.book_append_sheet(wb, ws, sheetName(site.detachmentName, used));
  }

  if (!dtr.sites.length) {
    const ws = brandedSheet(XLSX, {
      companyName: opts.companyName || "",
      title: "Daily Time Record",
      subtitle: `Period covered: ${period}`,
    });
    XLSX.utils.sheet_add_aoa(ws, [["No attendance in this period."]], { origin: -1 });
    XLSX.utils.book_append_sheet(wb, ws, "DTR");
  }
  return wb;
}
