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
  // A confidentiality notice, not a developer credit. The agency name comes
  // from app_settings via the caller -- all nineteen call sites already read it
  // at generation time, so nothing new is plumbed through.
  //
  // Falls back to the bare word when the name is unavailable.
  //
  // That guard only means something because the ROUTES no longer substitute a
  // name of their own. Each of them used to read
  //   (settings.companyName || "Brookside Farms Corporation")
  // so an unset name arrived here already replaced by a FORMER CLIENT, and this
  // footer would have printed it under the word CONFIDENTIAL -- the exact
  // failure the fallback was supposed to prevent. They now pass "" through and
  // the bare word is what prints. The same rule the on-screen
  // ConfidentialFooter already follows: no name is better than the wrong one.
  const client = String(companyName || "").trim();
  const text = client ? `CONFIDENTIAL — ${client}` : "CONFIDENTIAL";

  const draw = () => {
    // Sits INSIDE the bottom margin, below the content area, so it can never
    // collide with a table that ran to the last usable row.
    const y = doc.page.height - doc.page.margins.bottom + 10;

    // Writing below the content area is what PDFKit calls overflow, and it
    // responds by APPENDING A PAGE. Stamping N pages therefore appended N
    // footer-only pages: measured on a 3-page incident report, 6 pages came
    // out, the last three identical 458-byte streams carrying nothing but this
    // footer. Every PDF in the system was affected, since every doc.end() is
    // preceded by this call.
    //
    // The comment on lineBreak:false below claimed it prevented that. It does
    // not -- lineBreak governs WRAPPING, not pagination, which is why the bug
    // survived: the code read as though it were already handled.
    //
    // Dropping the bottom margin for the duration of the write puts the y back
    // inside the content area, so nothing overflows and no page is added. The
    // margin is restored immediately, before the loop moves to the next page,
    // so the content area every OTHER caller sees is unchanged.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(6.5).fillColor(MUTE)
      // lineBreak:false keeps a long line on one row instead of wrapping into
      // the page edge — and stops PDFKit adding a page while we are stamping.
      .text(text, left, y, { width, align: "center", lineBreak: false });
    doc.restore();
    doc.page.margins.bottom = savedBottom;
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
