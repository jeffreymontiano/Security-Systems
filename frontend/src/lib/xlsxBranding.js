/**
 * The agency's own branding on every Excel export, so a downloaded workbook
 * identifies who it belongs to the way the PDFs and the screen already do.
 *
 * Returns a worksheet containing ONLY the title block; the caller appends its
 * data with `origin: -1`. Building it this way round means the data keeps using
 * whichever helper suits it (`aoa_to_sheet` for a hand-built table,
 * `sheet_add_json` for rows of objects) instead of every call site having to
 * splice header rows into its own array.
 *
 * The company name comes from `useSettings()`, which reads System Settings — it
 * is never hardcoded, so an agency that renames itself gets the new name in its
 * exports with no code change.
 *
 * The LOGO is deliberately not here. Embedding an image needs SheetJS Pro; the
 * community build this project uses cannot write one, and a silently missing
 * picture would be worse than an honest text letterhead. PDFs carry the logo,
 * because PDFKit can draw it.
 */
export function brandedSheet(XLSX, { companyName, title, subtitle } = {}) {
  const rows = [];
  if (companyName) rows.push([companyName.toUpperCase()]);
  if (title) rows.push([title]);
  if (subtitle) rows.push([subtitle]);
  rows.push([`Generated ${new Date().toISOString().slice(0, 10)}`]);
  rows.push([]);                       // one blank line before the data
  return XLSX.utils.aoa_to_sheet(rows);
}
