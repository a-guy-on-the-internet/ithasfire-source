"use client";

import { useEffect, useState } from "react";

/**
 * True once the element matching `selector` has left the viewport.
 *
 * Exists so a page can hand its primary action to the bottom nav ONLY while
 * its own in-page button is out of sight. Before this, an event page on a
 * phone showed both at once — the hero's "Get tickets" and the nav's raised
 * "Get tickets" square, roughly 60px apart, doing the identical thing.
 *
 * Starts `false`, so the nav stays empty until the observer has actually
 * reported. That is the safe direction: a moment with no centre action is
 * invisible, whereas starting `true` flashes a duplicate square on every load
 * before the first callback lands.
 *
 * The element is looked up by selector rather than a ref because the publisher
 * (`EventDetail`) and the button (`EventContent`, several layers down) have no
 * ref channel between them, and threading one through the whole content
 * component to answer "is it on screen" would be a worse trade.
 */
export function useScrolledPast(selector: string): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    let observer: IntersectionObserver | null = null;
    let raf = 0;

    // The target mounts with the page, but not necessarily before this effect
    // runs (suspense boundaries, the CTA's own gates). Retry on animation
    // frames for a short window rather than assuming it is there.
    let attempts = 0;
    const attach = () => {
      const el = document.querySelector(selector);
      if (!el) {
        if (attempts++ > 60) return;
        raf = requestAnimationFrame(attach);
        return;
      }
      observer = new IntersectionObserver(
        ([entry]) => setPast(!entry.isIntersecting),
        // A sliver counts as visible: the intent is "can they still reach the
        // real button", not "is it fully framed".
        { threshold: 0 },
      );
      observer.observe(el);
    };
    attach();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [selector]);

  return past;
}
