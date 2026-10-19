import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scrollTabIntoView } from "../scroll-tab-into-view";

// jsdom does no layout, so the bar and tab geometry is stubbed: a 238px bar
// at x=42 (the page column at 320) holding tabs laid end to end.
function setUp(opts: { tabLeft: number; tabWidth: number; scrollLeft?: number }) {
  const bar = document.createElement("div");
  const tab = document.createElement("button");
  bar.appendChild(tab);
  document.body.appendChild(bar);
  Object.defineProperty(bar, "clientWidth", { value: 238 });
  bar.scrollLeft = opts.scrollLeft ?? 0;
  bar.getBoundingClientRect = () => new DOMRect(42, 300, 238, 45);
  // Viewport position: where the tab sits once the bar has scrolled.
  tab.getBoundingClientRect = () =>
    new DOMRect(
      42 + opts.tabLeft - bar.scrollLeft,
      300,
      opts.tabWidth,
      44,
    );
  return { bar, tab };
}

describe("scrollTabIntoView", () => {
  const pageScroll = vi.fn();
  const elementScroll = vi.fn();

  beforeEach(() => {
    window.scrollTo = pageScroll as unknown as typeof window.scrollTo;
    window.scrollBy = pageScroll as unknown as typeof window.scrollBy;
    Element.prototype.scrollIntoView = elementScroll;
  });

  afterEach(() => {
    pageScroll.mockReset();
    elementScroll.mockReset();
    document.body.innerHTML = "";
  });

  it("scrolls the bar, not the page, to show a tab cut off on the right", () => {
    // Second tab of three: 164..306 in a bar showing 0..238.
    const { bar, tab } = setUp({ tabLeft: 164, tabWidth: 142 });
    const scrollYBefore = window.scrollY;

    scrollTabIntoView({ currentTarget: tab });

    expect(bar.scrollLeft).toBe(306 - 238);
    expect(window.scrollY).toBe(scrollYBefore);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(elementScroll).not.toHaveBeenCalled();
  });

  it("scrolls the bar back to show a tab cut off on the left", () => {
    const { bar, tab } = setUp({ tabLeft: 0, tabWidth: 164, scrollLeft: 120 });

    scrollTabIntoView({ currentTarget: tab });

    expect(bar.scrollLeft).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(elementScroll).not.toHaveBeenCalled();
  });

  it("leaves the bar alone when the tab is already in view", () => {
    // Focus coming back to a visible tab (the window regaining focus).
    const { bar, tab } = setUp({ tabLeft: 0, tabWidth: 164 });

    scrollTabIntoView({ currentTarget: tab });

    expect(bar.scrollLeft).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(elementScroll).not.toHaveBeenCalled();
  });

  it("ignores an event whose target is not an element", () => {
    expect(() => scrollTabIntoView({ currentTarget: 7 })).not.toThrow();
    expect(() => scrollTabIntoView({ currentTarget: null })).not.toThrow();
  });
});
