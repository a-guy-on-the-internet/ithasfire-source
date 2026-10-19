import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  centeredView,
  clampAxis,
  clampView,
  clampZoom,
  coverScale,
  croppedFileName,
  outputContentType,
  outputSize,
  shouldSkipCrop,
  sourceRect,
  zoomAnchored,
  type CropBox,
} from "../image-crop";

/** 1:1 crop box over a 4:3 landscape source. */
const square: CropBox = {
  boxW: 300,
  boxH: 300,
  naturalW: 4000,
  naturalH: 3000,
};

/** 3:1 crop box over a portrait source (the hard direction for a banner). */
const banner: CropBox = {
  boxW: 300,
  boxH: 100,
  naturalW: 1000,
  naturalH: 2000,
};

describe("coverScale", () => {
  it("scales by the constraining axis so the image always covers the box", () => {
    // 300/4000 = 0.075 vs 300/3000 = 0.1 → the taller ratio wins.
    expect(coverScale(300, 300, 4000, 3000)).toBeCloseTo(0.1);
    expect(coverScale(300, 100, 1000, 2000)).toBeCloseTo(0.3);
  });

  it("never returns 0 for a degenerate image", () => {
    expect(coverScale(300, 300, 0, 0)).toBe(1);
  });
});

describe("clampAxis", () => {
  it("keeps the offset inside [box - display, 0]", () => {
    expect(clampAxis(50, 300, 400)).toBe(0);
    expect(clampAxis(-500, 300, 400)).toBe(-100);
    expect(clampAxis(-40, 300, 400)).toBe(-40);
  });

  it("centres an image smaller than the box instead of leaving a gutter", () => {
    expect(clampAxis(999, 300, 200)).toBe(50);
  });
});

describe("clampZoom", () => {
  it("bounds the zoom and rejects NaN", () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });
});

describe("centeredView", () => {
  it("centres the overflowing axis and pins the covered one at 0", () => {
    const view = centeredView(square);
    expect(view.zoom).toBe(MIN_ZOOM);
    // Scale 0.1 → 400x300 displayed in a 300x300 box.
    expect(view.x).toBeCloseTo(-50);
    expect(view.y).toBeCloseTo(0);
  });

  it("works for a 3:1 banner over a portrait source", () => {
    const view = centeredView(banner);
    // Scale 0.3 → 300x600 in a 300x100 box.
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo(-250);
  });
});

describe("clampView", () => {
  it("never lets a pan expose a gap at any zoom", () => {
    for (const zoom of [1, 1.5, 2.7, 5]) {
      const view = clampView({ zoom, x: 9999, y: -9999 }, square);
      const scale = coverScale(square.boxW, square.boxH, square.naturalW, square.naturalH) * zoom;
      expect(view.x).toBeLessThanOrEqual(0);
      expect(view.y).toBeLessThanOrEqual(0);
      expect(view.x + square.naturalW * scale).toBeGreaterThanOrEqual(square.boxW - 1e-9);
      expect(view.y + square.naturalH * scale).toBeGreaterThanOrEqual(square.boxH - 1e-9);
    }
  });
});

describe("zoomAnchored", () => {
  it("keeps whatever is under the box centre under the box centre", () => {
    const start = centeredView(square);
    const base = coverScale(square.boxW, square.boxH, square.naturalW, square.naturalH);
    const naturalAtCentreBefore = (square.boxW / 2 - start.x) / (base * start.zoom);

    const zoomed = zoomAnchored(start, square, 3);
    const naturalAtCentreAfter =
      (square.boxW / 2 - zoomed.x) / (base * zoomed.zoom);

    expect(zoomed.zoom).toBe(3);
    expect(naturalAtCentreAfter).toBeCloseTo(naturalAtCentreBefore, 6);
  });

  it("clamps the zoom and re-clamps the offset with it", () => {
    const zoomedOut = zoomAnchored(centeredView(square, 4), square, 0.1);
    expect(zoomedOut.zoom).toBe(MIN_ZOOM);
    expect(zoomedOut.x).toBeCloseTo(-50);
  });
});

describe("sourceRect", () => {
  it("returns the natural-pixel window the crop box is showing", () => {
    const rect = sourceRect(centeredView(square), square);
    // Box 300x300 at scale 0.1 → a 3000x3000 window, x-centred in 4000px.
    expect(rect.sw).toBeCloseTo(3000);
    expect(rect.sh).toBeCloseTo(3000);
    expect(rect.sx).toBeCloseTo(500);
    expect(rect.sy).toBeCloseTo(0);
  });

  it("stays inside the image bounds when zoomed all the way out", () => {
    const rect = sourceRect(centeredView(banner), banner);
    expect(rect.sx).toBeGreaterThanOrEqual(0);
    expect(rect.sy).toBeGreaterThanOrEqual(0);
    expect(rect.sx + rect.sw).toBeLessThanOrEqual(banner.naturalW + 1e-9);
    expect(rect.sy + rect.sh).toBeLessThanOrEqual(banner.naturalH + 1e-9);
  });

  it("narrows as the user zooms in", () => {
    const wide = sourceRect(centeredView(square), square);
    const tight = sourceRect(zoomAnchored(centeredView(square), square, 3), square);
    expect(tight.sw).toBeLessThan(wide.sw);
  });
});

describe("outputSize", () => {
  it("matches the requested aspect exactly", () => {
    const size = outputSize({ sx: 0, sy: 0, sw: 3000, sh: 1000 }, 3, 2400);
    expect(size.width).toBe(2400);
    expect(size.height).toBe(800);
  });

  it("never upscales past the true cropped resolution", () => {
    const size = outputSize({ sx: 0, sy: 0, sw: 240, sh: 240 }, 1, 1024);
    expect(size).toEqual({ width: 240, height: 240 });
  });

  it("never produces a zero-pixel canvas", () => {
    const size = outputSize({ sx: 0, sy: 0, sw: 0.2, sh: 0.2 }, 1, 1024);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("outputContentType", () => {
  it("preserves formats that can carry transparency", () => {
    expect(outputContentType("image/png")).toBe("image/png");
    expect(outputContentType("image/webp")).toBe("image/webp");
  });

  it("encodes everything else as JPEG", () => {
    expect(outputContentType("image/jpeg")).toBe("image/jpeg");
    expect(outputContentType("image/JPEG")).toBe("image/jpeg");
    expect(outputContentType("application/octet-stream")).toBe("image/jpeg");
  });
});

describe("croppedFileName", () => {
  it("swaps the extension to match the encoded type", () => {
    expect(croppedFileName("IMG_0042.HEIC", "image/jpeg")).toBe(
      "IMG_0042-cropped.jpg",
    );
    expect(croppedFileName("logo.png", "image/png")).toBe("logo-cropped.png");
  });

  it("survives a name with no extension", () => {
    expect(croppedFileName("scan", "image/jpeg")).toBe("scan-cropped.jpg");
  });
});

describe("shouldSkipCrop", () => {
  it("passes animated GIFs through uncropped (a canvas round-trip flattens them)", () => {
    expect(shouldSkipCrop({ type: "image/gif" })).toBe(true);
    expect(shouldSkipCrop({ type: "image/GIF" })).toBe(true);
  });

  it("crops every other supported type", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic"]) {
      expect(shouldSkipCrop({ type })).toBe(false);
    }
  });
});
