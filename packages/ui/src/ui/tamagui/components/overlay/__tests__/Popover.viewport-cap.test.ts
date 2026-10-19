import { describe, expect, it } from "vitest";

import { buildPopoverMiddleware, resolveMaxWidth } from "../Popover";

describe("resolveMaxWidth", () => {
  it("caps at the viewport room when the caller sets no limit", () => {
    expect(resolveMaxWidth(undefined, 304.7)).toBe("304px");
    expect(resolveMaxWidth(undefined, -12)).toBe("0px");
  });

  it("keeps a caller's numeric cap on a wide screen and loses to a narrower viewport", () => {
    expect(resolveMaxWidth(320, 1400)).toBe("320px");
    expect(resolveMaxWidth(320, 300)).toBe("300px");
  });

  it("wraps a CSS length caller cap in min()", () => {
    expect(resolveMaxWidth("calc(100vw - 16px)", 304)).toBe("min(calc(100vw - 16px), 304px)");
  });

  it("ignores a Tamagui token (unsupported) and uses the viewport room", () => {
    expect(resolveMaxWidth("$20", 304)).toBe("304px");
  });
});

// @floating-ui/react-dom wraps `options` as `[options, deps]`; the DOM package
// keeps the bare object. Read either.
type Mw = { name: string; options: unknown };
const optionsOf = <T,>(m: unknown): T => {
  const o = (m as Mw).options;
  return (Array.isArray(o) ? o[0] : o) as T;
};

describe("buildPopoverMiddleware", () => {
  it("orders offset, flip, shift, size with 8px padding on shift and size", () => {
    const mw = buildPopoverMiddleware({ offsetPx: 6, live: { current: { matchAnchorWidth: false } } });
    expect(mw.map((m) => m.name)).toEqual(["offset", "flip", "shift", "size"]);
    expect(optionsOf<{ padding?: number }>(mw[2]).padding).toBe(8);
    expect(optionsOf<{ padding?: number }>(mw[3]).padding).toBe(8);
  });

  it("size writes the min of caller cap and room onto the floating element", () => {
    const live = { current: { matchAnchorWidth: false, callerMaxWidth: 320 as unknown } };
    const mw = buildPopoverMiddleware({ offsetPx: 6, live });
    const size = optionsOf<{ apply: (a: unknown) => void }>(mw[3]);
    const floating = { style: { maxWidth: "" } };
    size.apply({ rects: { reference: { width: 40 } }, elements: { floating }, availableWidth: 1400 });
    expect(floating.style.maxWidth).toBe("320px");
    size.apply({ rects: { reference: { width: 40 } }, elements: { floating }, availableWidth: 300 });
    expect(floating.style.maxWidth).toBe("300px");
  });

  it("reads the LATEST caller cap on every run, not the one from the first render", () => {
    const live = { current: { matchAnchorWidth: false, callerMaxWidth: 320 as unknown } };
    const size = optionsOf<{ apply: (a: unknown) => void }>(
      buildPopoverMiddleware({ offsetPx: 6, live })[3],
    );
    const floating = { style: { maxWidth: "" } };
    const run = (availableWidth: number) =>
      size.apply({ rects: { reference: { width: 40 } }, elements: { floating }, availableWidth });
    run(1400);
    expect(floating.style.maxWidth).toBe("320px");
    live.current = { matchAnchorWidth: false, callerMaxWidth: 500 };
    run(1400);
    expect(floating.style.maxWidth).toBe("500px");
  });
});
