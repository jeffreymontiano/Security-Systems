import { useEffect } from "react";

/**
 * Keeps the sticky-table offsets accurate.
 *
 * Three things pin to the top of a long report, stacked:
 *   1. .header          — the navy module bar (sticky at top:0, z-index 40)
 *   2. .section-head    — the card's navy title bar
 *   3. thead th         — the column header row
 *
 * Each must park below the one above it, so every layer needs the measured
 * height of its predecessor. ModuleHeader publishes --module-header-h; this
 * hook publishes --section-head-h onto each sticky card, which the table
 * header adds to its own offset.
 *
 * Heights are measured rather than hardcoded because a title bar wraps to two
 * lines on narrow screens and some contain action buttons, so a fixed value
 * would leave the column row overlapping the bar or floating below it.
 *
 * A MutationObserver is required as well as a ResizeObserver: cards mount and
 * unmount when switching tabs *within* a page (Daily / Late & Undertime /
 * Overtime), which a route-keyed effect alone would miss.
 */
// Cards whose title-bar height something below them needs.
//
// .sticky-card pins its column row to the PAGE and adds this to the module
// bar's height. .wide-card instead gives its table an inner scrollport and
// uses the same measurement to size that box (viewport less the bars above it)
// — a table too wide for .sticky-card has to scroll inside its own box, or its
// right-hand columns become unreachable. Both need the measured height, so both
// are listed here.
const MEASURED_CARDS = ".section-card.sticky-card, .section-card.wide-card";

export default function useStickyOffsets() {
  useEffect(() => {
    const root = document.querySelector(".app-main") || document.body;
    let ro = null;

    const apply = () => {
      const cards = root.querySelectorAll(MEASURED_CARDS);
      if (ro) ro.disconnect();
      cards.forEach((card) => {
        const head = card.querySelector(":scope > .section-head");
        const h = head ? Math.round(head.getBoundingClientRect().height) : 0;
        card.style.setProperty("--section-head-h", `${h}px`);
        if (ro && head) ro.observe(head);
      });
    };

    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        // Re-read heights only; re-observing inside the callback would loop.
        root.querySelectorAll(MEASURED_CARDS).forEach((card) => {
          const head = card.querySelector(":scope > .section-head");
          if (head) card.style.setProperty("--section-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
        });
      });
    }

    apply();
    const mo = new MutationObserver(apply);
    mo.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", apply);

    return () => {
      mo.disconnect();
      if (ro) ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);
}
