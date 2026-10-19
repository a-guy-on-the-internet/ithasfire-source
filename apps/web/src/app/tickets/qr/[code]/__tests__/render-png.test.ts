import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import { renderTicketQrPng } from "../render-png";

/**
 * The point of these tests is the DECODE. The centre of the symbol is
 * excavated and overpainted with the flame mark, which is exactly the sort of
 * change that still looks fine to a human and quietly stops scanning — so
 * "renders a PNG" is not the assertion that matters. Every case below runs the
 * output back through a real QR decoder.
 */
const decode = (png: Buffer): string | null => {
  const img = PNG.sync.read(png);
  const res = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return res?.data ?? null;
};

describe("renderTicketQrPng", () => {
  it("emits a real PNG (magic bytes), not an SVG string", async () => {
    const png = await renderTicketQrPng("tk_db4dec6aabd1418b91f2b35f");
    // \x89PNG\r\n\x1a\n — this is the whole reason the module exists: Outlook's
    // Word engine and Gmail both refuse image/svg+xml.
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("still decodes to the ticket code with the flame composited in", async () => {
    const code = "tk_db4dec6aabd1418b91f2b35f";
    expect(decode(await renderTicketQrPng(code))).toBe(code);
  });

  it("decodes across the code lengths the validator allows", async () => {
    // Short codes produce a smaller symbol, so the fixed 20%-of-height flame
    // covers proportionally the same area but far fewer modules — worth
    // pinning both ends rather than trusting one representative code.
    for (const code of ["DEV-00-0", "tk_db4dec6aabd1418b91f2b35f", "A".repeat(64)]) {
      expect(decode(await renderTicketQrPng(code)), `failed for ${code}`).toBe(code);
    }
  });

  it("paints the centre white where the flame pad sits", async () => {
    const img = PNG.sync.read(await renderTicketQrPng("tk_db4dec6aabd1418b91f2b35f"));
    // Sample just outside the flame glyph but inside the excavated pad.
    const x = Math.round(img.width / 2);
    const y = Math.round(img.height / 2 - img.height * 0.12);
    const i = ((img.width * y) + x) << 2;
    expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([255, 255, 255]);
  });

  it("is deterministic for a given code", async () => {
    const a = await renderTicketQrPng("tk_same");
    const b = await renderTicketQrPng("tk_same");
    expect(a.equals(b)).toBe(true);
  });
});
