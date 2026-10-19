"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * The docked price bar's breakdown line ("incl. $2.45 fees + $4.13 tax").
 *
 * The bar is a FIXED 84px (`--event-price-bar-height` is a published contract:
 * the page spacer and the audio player both offset by it), so the bar cannot
 * grow to fit a long caption. Where the price column would spill out of the
 * bar (a long locale in a narrow column, e.g. Spanish at 320px, where the CTA
 * label already holds 214px), the caption steps aside VISUALLY
 * (`data-overflow="true"`, styled by the `.sr-only` rule in
 * event-content.css) and stays in the accessibility tree, so a screen reader
 * still hears the breakdown. The all-in figure above it is complete on its
 * own, and a clipped amount would be a wrong amount.
 *
 * Measured against the bar, not by counting lines, so a font swap or a
 * locale's currency format cannot fool it. Re-checked when the bar or the
 * price column resizes (rotation, text zoom, font scale) and once the web
 * fonts have loaded.
 */
export function DockedBarPriceCaption({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const caption = ref.current;
    const column = caption?.parentElement;
    const bar = caption?.closest(".event-sticky-bar");
    if (!caption || !column || !bar) return;

    const check = () => {
      // Measure the SHOWN layout, never the stepped-aside one: a hidden
      // caption always "fits", which would flip it back and forth.
      caption.removeAttribute("data-overflow");
      const col = column.getBoundingClientRect();
      const box = bar.getBoundingClientRect();
      if (col.top < box.top - 0.5 || col.bottom > box.bottom + 0.5) {
        caption.setAttribute("data-overflow", "true");
      }
    };
    check();

    // Loop-safe: every callback ends in the state it measured, so the size
    // the observer last reported is the size it finds on the next frame.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(bar);
    observer?.observe(column);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) check();
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [text]);

  return (
    <span
      ref={ref}
      className="event-sticky-bar__caption"
      data-testid="event-sticky-bar-breakdown"
    >
      {text}
    </span>
  );
}
