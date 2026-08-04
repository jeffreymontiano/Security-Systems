// Money formatting for generated PDFs. Shared so payslips, the payroll
// register, and client Statements of Account can never drift apart — and, more
// importantly, so the currency rule below is stated once.
//
// The ₱ glyph (U+20B1) CANNOT be used in a PDF here. PDFKit's built-in fonts
// are WinAnsi-encoded, so ₱ is written as its low byte 0xB1 — which renders as
// "±". That is why payslips once showed "±8550.00". Rendering a real ₱ would
// mean embedding a TrueType font containing the glyph, since the node:20-slim
// image Render builds on ships no system fonts. "PHP" is the ISO code,
// unambiguous, and standard on Philippine payslips and invoices.
//
// The web UI is unaffected and still shows ₱, because browsers have fonts that
// contain it.

// Grouped thousands, two decimals, with the currency spelled as "PHP".
const pesoPdf = (n) =>
  `PHP ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Same grouping without the currency word, for dense table cells.
const amountPdf = (n) =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { pesoPdf, amountPdf };
