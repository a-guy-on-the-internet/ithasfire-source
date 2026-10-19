import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";

import {
  QR_ANALYSIS_INTERVAL_MS,
  QR_ANALYSIS_MAX_EDGE,
  computeAnalysisSize,
  loadQrFallbackDecoder,
} from "../qr-decode-fallback";

function renderQrFrame(text: string, size: number): Uint8ClampedArray {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.floor(size / (modules + quiet * 2));
  const offset = Math.floor((size - (modules + quiet * 2) * scale) / 2);
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x0 = offset + (col + quiet) * scale;
      const y0 = offset + (row + quiet) * scale;
      for (let y = y0; y < y0 + scale; y += 1) {
        for (let x = x0; x < x0 + scale; x += 1) {
          const idx = (y * size + x) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        }
      }
    }
  }
  return data;
}

describe("QR_ANALYSIS_INTERVAL_MS", () => {
  it("caps analysis at 10 fps (NFR-003)", () => {
    expect(1000 / QR_ANALYSIS_INTERVAL_MS).toBeLessThanOrEqual(10);
  });
});

describe("computeAnalysisSize", () => {
  it("downscales a 1280x720 camera frame within the max edge", () => {
    expect(computeAnalysisSize(1280, 720)).toEqual({ width: 640, height: 360 });
  });

  it("preserves aspect ratio on portrait frames", () => {
    expect(computeAnalysisSize(720, 1280)).toEqual({ width: 360, height: 640 });
  });

  it("never upscales a frame that is already small", () => {
    expect(computeAnalysisSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(computeAnalysisSize(QR_ANALYSIS_MAX_EDGE, 100)).toEqual({
      width: QR_ANALYSIS_MAX_EDGE,
      height: 100,
    });
  });

  it("returns a zero box for a camera reporting no dimensions yet", () => {
    expect(computeAnalysisSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(computeAnalysisSize(Number.NaN, 720)).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe("loadQrFallbackDecoder", () => {
  it("decodes a dark-on-white QR", async () => {
    const decoder = await loadQrFallbackDecoder();
    const size = 320;
    expect(decoder.decode(renderQrFrame("HF7K2M9Q", size), size, size)).toBe(
      "HF7K2M9Q",
    );
  });

  it("returns null for a frame with no QR in it", async () => {
    const decoder = await loadQrFallbackDecoder();
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(decoder.decode(blank, 64, 64)).toBeNull();
  });
});
