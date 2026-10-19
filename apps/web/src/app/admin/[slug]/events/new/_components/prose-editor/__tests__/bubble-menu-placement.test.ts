import { describe, it, expect } from "vitest";
import {
  BUBBLE_MENU_OFFSET,
  bubbleMenuOptions,
  stickyTopInset,
  viewportBandBelow,
  type ViewportRect,
} from "../bubble-menu-placement";

/**
 * Where the menu actually lands needs real layout, which jsdom does not do
 * (every rect is zero), so these tests pin the boundary the options hand to
 * Floating UI rather than a computed position.
 */
const headerWithBottom = (bottom: number) => ({
  getBoundingClientRect: () => ({ bottom }) as DOMRect,
});

// The derivable options ignore the middleware state; they read the header.
const state = {} as never;

type Derived = { boundary: ViewportRect; padding?: unknown };

const derive = (option: unknown) => {
  expect(typeof option).toBe("function");
  return (option as (s: never) => Derived)(state);
};

const VIEWPORT = { width: 390, height: 844 };
const viewport = () => VIEWPORT;

describe("stickyTopInset", () => {
  it("is the toolbar's bottom edge when it sits below the page's sticky stack", () => {
    expect(stickyTopInset(headerWithBottom(212), 120)).toBe(212);
  });

  it("is the page's sticky stack once the toolbar has scrolled out with the editor's end", () => {
    expect(stickyTopInset(headerWithBottom(-40), 120)).toBe(120);
  });

  it("never goes above the viewport", () => {
    expect(stickyTopInset(headerWithBottom(-40), 0)).toBe(0);
    expect(stickyTopInset(null, 0)).toBe(0);
  });
});

describe("viewportBandBelow", () => {
  it("runs from the given top to the viewport's bottom edge, full width", () => {
    expect(viewportBandBelow(212, VIEWPORT)).toEqual({
      x: 0,
      y: 212,
      width: 390,
      height: 844 - 212,
    });
  });

  it("clamps a negative top to the viewport and never goes negative in height", () => {
    expect(viewportBandBelow(-10, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    });
    expect(viewportBandBelow(900, VIEWPORT).height).toBe(0);
  });
});

describe("bubbleMenuOptions", () => {
  it("keeps the menu above the selection by default", () => {
    const options = bubbleMenuOptions(() => null, 0, viewport);
    expect(options.placement).toBe("top");
    expect(options.offset).toBe(BUBBLE_MENU_OFFSET);
  });

  it("makes flip treat the toolbar as the top edge, plus the gap offset adds later", () => {
    const options = bubbleMenuOptions(() => headerWithBottom(212), 120, viewport);
    expect(derive(options.flip).boundary.y).toBe(212 + BUBBLE_MENU_OFFSET);
  });

  it("hides the menu only once the selection is under the toolbar", () => {
    const options = bubbleMenuOptions(() => headerWithBottom(212), 120, viewport);
    expect(derive(options.hide).boundary.y).toBe(212);
  });

  // The review finding on 7cb2829ba: `padding` is relative to the clipping
  // ancestor. In ComposeAnnouncementDialog that is Modal.Body (overflow:auto),
  // whose top is already above the toolbar, so a viewport-measured padding
  // was counted twice. A Rect boundary is viewport-relative by definition, so
  // neither middleware may fall back to padding.
  it("hands flip and hide a viewport-coordinate boundary, never clipping-ancestor padding", () => {
    const options = bubbleMenuOptions(() => headerWithBottom(212), 0, viewport);
    for (const derived of [derive(options.flip), derive(options.hide)]) {
      expect(derived.padding).toBeUndefined();
      expect(derived.boundary.x).toBe(0);
      expect(derived.boundary.width).toBe(VIEWPORT.width);
      expect(derived.boundary.y + derived.boundary.height).toBe(VIEWPORT.height);
    }
  });

  it("reads the window's size by default", () => {
    const options = bubbleMenuOptions(() => headerWithBottom(100), 0);
    const { boundary } = derive(options.hide);
    expect(boundary.width).toBe(window.innerWidth);
    expect(boundary.y + boundary.height).toBe(window.innerHeight);
  });

  it("re-measures the header on every position update, so a toolbar that wraps taller moves the edge", () => {
    let bottom = 96; // toolbar on two rows
    const options = bubbleMenuOptions(() => headerWithBottom(bottom), 0, viewport);
    expect(derive(options.flip).boundary.y).toBe(96 + BUBBLE_MENU_OFFSET);
    bottom = 180; // four rows at 320px
    expect(derive(options.flip).boundary.y).toBe(180 + BUBBLE_MENU_OFFSET);
  });
});
