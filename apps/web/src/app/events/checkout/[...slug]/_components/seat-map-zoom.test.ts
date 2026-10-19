import { describe, expect, it } from "vitest";

import {
  anchorTranslateForScaleChange,
  boundsOfPoints,
  boundsOfPolygons,
  clampTranslateToContent,
  computeBaseUnitScale,
  computeMaxScale,
  computeMinUsableScale,
  computeSectionFocusTransform,
  findNearestSeatWithinSlop,
  findSectionAtPoint,
  median,
  pointInPolygon,
  type Bounds,
  type SlopSeat,
} from "./seat-map-zoom";

describe("median", () => {
  it("returns 0 for empty input", () => {
    expect(median([])).toBe(0);
  });

  it("returns the middle value for odd-length input", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it("averages the two middle values for even-length input", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("computeBaseUnitScale", () => {
  it("fits on the tighter axis (preserveAspectRatio meet)", () => {
    // viewBox 200x100 into 400x100 viewport: height is the limiting axis.
    expect(
      computeBaseUnitScale(
        { width: 200, height: 100 },
        { width: 400, height: 100 },
      ),
    ).toBe(1);
  });

  it("returns 0 when the viewport is unmeasured or degenerate", () => {
    expect(computeBaseUnitScale({ width: 200, height: 100 }, null)).toBe(0);
    expect(
      computeBaseUnitScale(
        { width: 200, height: 100 },
        { width: 0, height: 100 },
      ),
    ).toBe(0);
  });
});

describe("computeMinUsableScale", () => {
  it("computes the scale at which the median seat diameter reaches the target", () => {
    // Median radius 5 world units at 1px/unit → 10px diameter at scale 1.
    // To reach 22px the map must zoom to 2.2.
    expect(computeMinUsableScale(5, 1)).toBeCloseTo(2.2);
  });

  it("matches the live-measured SOMA failure mode (~9-10px seats)", () => {
    // ~4.7px on-screen radius at fit zoom → needs ~2.34x zoom.
    const scale = computeMinUsableScale(4.7, 1);
    expect(scale).toBeGreaterThan(2);
    expect(scale).toBeLessThan(2.5);
  });

  it("returns below 1 when seats are already large at fit zoom", () => {
    expect(computeMinUsableScale(22, 1)).toBeLessThan(1);
  });

  it("falls back to 1 for degenerate inputs", () => {
    expect(computeMinUsableScale(0, 1)).toBe(1);
    expect(computeMinUsableScale(5, 0)).toBe(1);
  });

  it("honours a custom target diameter", () => {
    expect(computeMinUsableScale(5, 1, 44)).toBeCloseTo(4.4);
  });
});

describe("computeMaxScale", () => {
  it("keeps the base ceiling when the floor is comfortably below it", () => {
    expect(computeMaxScale(1)).toBe(3);
  });

  it("raises the ceiling so the tap-target floor stays reachable", () => {
    expect(computeMaxScale(4)).toBeCloseTo(5);
  });
});

describe("clampTranslateToContent", () => {
  const content: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const viewCenter = { x: 50, y: 25 };

  it("passes through translates that keep the centre over content", () => {
    const t = clampTranslateToContent(0, 0, 1, content, viewCenter);
    expect(t).toEqual({ x: 0, y: 0 });
  });

  it("clamps so the world point at the view centre stays inside content", () => {
    const scale = 3;
    const t = clampTranslateToContent(-9999, 9999, scale, content, viewCenter);
    const worldAtCenter = {
      x: (viewCenter.x - t.x) / scale,
      y: (viewCenter.y - t.y) / scale,
    };
    expect(worldAtCenter.x).toBeGreaterThanOrEqual(content.minX);
    expect(worldAtCenter.x).toBeLessThanOrEqual(content.maxX);
    expect(worldAtCenter.y).toBeGreaterThanOrEqual(content.minY);
    expect(worldAtCenter.y).toBeLessThanOrEqual(content.maxY);
  });

  it("allows the large translate needed to centre a far section at high zoom", () => {
    // Centre world point (90, 40) at scale 3 → t = viewCenter - 3 * p.
    const t = clampTranslateToContent(
      50 - 3 * 90,
      25 - 3 * 40,
      3,
      content,
      viewCenter,
    );
    expect(t).toEqual({ x: 50 - 270, y: 25 - 120 });
  });
});

describe("anchorTranslateForScaleChange", () => {
  it("keeps the world point under the view centre fixed across zoom", () => {
    const viewCenter = { x: 50, y: 25 };
    const prev = { translate: { x: -20, y: 10 }, scale: 1.5 };
    const next = anchorTranslateForScaleChange(
      prev.translate,
      prev.scale,
      2.5,
      viewCenter,
    );
    const worldBefore = (viewCenter.x - prev.translate.x) / prev.scale;
    const worldAfter = (viewCenter.x - next.x) / 2.5;
    expect(worldAfter).toBeCloseTo(worldBefore);
  });

  it("is a no-op for a degenerate previous scale", () => {
    expect(
      anchorTranslateForScaleChange({ x: 1, y: 2 }, 0, 2, { x: 0, y: 0 }),
    ).toEqual({ x: 1, y: 2 });
  });
});

describe("boundsOfPoints / boundsOfPolygons", () => {
  it("returns null for empty input", () => {
    expect(boundsOfPoints([])).toBeNull();
    expect(boundsOfPolygons([])).toBeNull();
  });

  it("computes the bounding box across polygons", () => {
    expect(
      boundsOfPolygons([
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 5 },
        ],
        [
          { x: -2, y: 8 },
          { x: 3, y: 8 },
          { x: 3, y: 12 },
        ],
      ]),
    ).toEqual({ minX: -2, minY: 0, maxX: 10, maxY: 12 });
  });
});

describe("computeSectionFocusTransform", () => {
  const contentBounds: Bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const viewCenter = { x: 100, y: 50 };
  const viewSize = { width: 200, height: 100 };

  it("never lands below the tap-target floor for a wide section", () => {
    // Wide, short section: fitting it zooms OUT (the live SOMA bug, scale 0.6).
    const wideSection: Bounds = { minX: 0, minY: 0, maxX: 180, maxY: 20 };
    const { scale } = computeSectionFocusTransform({
      sectionBounds: wideSection,
      contentBounds,
      viewCenter,
      viewSize,
      minUsableScale: 2.3,
      minScale: 0.5,
      maxScale: computeMaxScale(2.3),
    });
    expect(scale).toBeGreaterThanOrEqual(2.3);
  });

  it("uses the section fit scale when it exceeds the floor", () => {
    const smallSection: Bounds = { minX: 90, minY: 40, maxX: 110, maxY: 60 };
    const { scale } = computeSectionFocusTransform({
      sectionBounds: smallSection,
      contentBounds,
      viewCenter,
      viewSize,
      minUsableScale: 1.2,
      minScale: 0.5,
      maxScale: 6,
      fillFraction: 0.8,
    });
    // fit = min(200*0.8/20, 100*0.8/20) = 4
    expect(scale).toBeCloseTo(4);
  });

  it("caps at maxScale", () => {
    const tiny: Bounds = { minX: 99, minY: 49, maxX: 101, maxY: 51 };
    const { scale } = computeSectionFocusTransform({
      sectionBounds: tiny,
      contentBounds,
      viewCenter,
      viewSize,
      minUsableScale: 1,
      minScale: 0.5,
      maxScale: 3,
    });
    expect(scale).toBe(3);
  });

  it("centres the section under the viewport centre", () => {
    const section: Bounds = { minX: 140, minY: 60, maxX: 180, maxY: 90 };
    const { scale, translate } = computeSectionFocusTransform({
      sectionBounds: section,
      contentBounds,
      viewCenter,
      viewSize,
      minUsableScale: 2,
      minScale: 0.5,
      maxScale: 6,
    });
    const sectionCenter = { x: 160, y: 75 };
    expect(scale * sectionCenter.x + translate.x).toBeCloseTo(viewCenter.x);
    expect(scale * sectionCenter.y + translate.y).toBeCloseTo(viewCenter.y);
  });
});

describe("pointInPolygon / findSectionAtPoint", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("detects containment", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it("finds the containing section or null", () => {
    const sections = [
      { sectionId: "ga", polygons: [square] },
      {
        sectionId: "vip",
        polygons: [
          [
            { x: 20, y: 0 },
            { x: 30, y: 0 },
            { x: 30, y: 10 },
            { x: 20, y: 10 },
          ],
        ],
      },
    ];
    expect(findSectionAtPoint({ x: 25, y: 5 }, sections)).toBe("vip");
    expect(findSectionAtPoint({ x: 5, y: 5 }, sections)).toBe("ga");
    expect(findSectionAtPoint({ x: 15, y: 5 }, sections)).toBeNull();
  });
});

describe("findNearestSeatWithinSlop", () => {
  const seat = (
    seatId: string,
    sectionId: string,
    x: number,
    y: number,
    selectable = true,
  ): SlopSeat => ({ seatId, sectionId, x, y, radius: 1, selectable });

  it("picks the nearest selectable seat within slop", () => {
    const seats = [
      seat("a", "ga", 0, 0),
      seat("b", "ga", 4, 0),
      seat("c", "ga", 10, 0),
    ];
    const hit = findNearestSeatWithinSlop({ x: 3, y: 0 }, seats, 5);
    expect(hit?.seatId).toBe("b");
  });

  it("returns null when nothing is within slop", () => {
    const seats = [seat("a", "ga", 100, 100)];
    expect(findNearestSeatWithinSlop({ x: 0, y: 0 }, seats, 5)).toBeNull();
  });

  it("never picks unavailable seats, even when nearest", () => {
    const seats = [seat("sold", "ga", 1, 0, false), seat("open", "ga", 4, 0)];
    const hit = findNearestSeatWithinSlop({ x: 0, y: 0 }, seats, 6);
    expect(hit?.seatId).toBe("open");
  });

  it("never slop-selects across sections when the tap is inside a section", () => {
    const seats = [seat("vip-1", "vip", 1, 0), seat("ga-1", "ga", 3, 0)];
    const hit = findNearestSeatWithinSlop({ x: 2, y: 0 }, seats, 5, "ga");
    expect(hit?.seatId).toBe("ga-1");
  });

  it("returns null when only other-section seats are within slop", () => {
    const seats = [seat("vip-1", "vip", 1, 0)];
    expect(
      findNearestSeatWithinSlop({ x: 0, y: 0 }, seats, 5, "ga"),
    ).toBeNull();
  });

  it("measures distance to the glyph edge, not the centre", () => {
    // Centre is 6 away, radius 2 → edge distance 4 ≤ slop 5.
    const seats: SlopSeat[] = [
      { seatId: "big", sectionId: "ga", x: 6, y: 0, radius: 2, selectable: true },
    ];
    expect(
      findNearestSeatWithinSlop({ x: 0, y: 0 }, seats, 5)?.seatId,
    ).toBe("big");
    expect(findNearestSeatWithinSlop({ x: 0, y: 0 }, seats, 3.5)).toBeNull();
  });
});
