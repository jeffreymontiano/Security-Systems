// The footer stamped on every page of every generated PDF.
//
// Carries BOTH brandings: the client's company name (whose data this is) and
// the software's authorship (whose software produced it). The client name is
// added to, never replaced — an agency's report must still read as theirs.

const { PDF_FOOTER } = require("./appBranding");

const MUTE = "#8A94A6";
const RULE = "#D8DEE8";

// Stamp the footer on every page, then leave the document ready to end.
//
// Must be called AFTER all content and BEFORE doc.end(). Reaching every page
// of a multi-page report requires the document to have been created with
// `bufferPages: true`; without it only the current page can be addressed, so
// that case is handled rather than silently producing a one-page footer.
function stampAuthorFooter(doc, companyName) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // The client's name first, then the authorship line. Blank company name
  // simply omits that half rather than printing a stray separator.
  const client = String(companyName || "").trim();
  const text = client ? `${client}  ·  ${PDF_FOOTER}` : PDF_FOOTER;

  const draw = () => {
    // Sits INSIDE the bottom margin, below the content area, so it can never
    // collide with a table that ran to the last usable row.
    const y = doc.page.height - doc.page.margins.bottom + 10;
    doc.save();
    doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(6.5).fillColor(MUTE)
      // lineBreak:false keeps a long line on one row instead of wrapping into
      // the page edge — and stops PDFKit adding a page while we are stamping.
      .text(text, left, y, { width, align: "center", lineBreak: false });
    doc.restore();
  };

  const range = typeof doc.bufferedPageRange === "function" ? doc.bufferedPageRange() : null;
  if (!range || !range.count) { draw(); return; }

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    draw();
  }
  // Hand the buffered pages back so doc.end() writes them out.
  doc.flushPages();
}

module.exports = { stampAuthorFooter, PDF_FOOTER };
