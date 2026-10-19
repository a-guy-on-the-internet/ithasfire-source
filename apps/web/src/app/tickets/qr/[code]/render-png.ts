import QRCode from "qrcode";
import { PNG } from "pngjs";

import { FLAME_MARK_PNG_BASE64 } from "./flame-mark";

/**
 * Raster (PNG) ticket QR with the Ithas Fire flame composited into the centre.
 *
 * WHY RASTER AT ALL — this is the whole point of the module. The SVG variant
 * renders beautifully in a browser and in Apple Mail, and **not at all in the
 * two clients that matter most**: Outlook desktop draws mail with Word's
 * engine, which cannot render SVG under any circumstances, and Gmail does not
 * accept `image/svg+xml` either. The ticket email leads with this image and
 * tells the buyer it is their ticket, so an image format a large share of
 * inboxes silently drops is not a cosmetic problem.
 *
 * Pure JS on purpose: `qrcode` and `pngjs` have no native binary. `sharp`
 * could rasterise the existing SVG in one call, but nothing else in this repo
 * declares it (it is only present transitively via Next's image optimiser),
 * and a native module in a scale-to-zero request path costs cold-start time
 * for one endpoint's benefit.
 *
 * Level "H" (~30% recovery) carries the centre occlusion. The excavated pad is
 * ~5.5% of the symbol's area, comfortably inside that budget — and the output
 * is decode-verified in `__tests__/render-png.test.ts` rather than assumed.
 */
export async function renderTicketQrPng(code: string): Promise<Buffer> {
  const qrBuffer = await QRCode.toBuffer(code, {
    errorCorrectionLevel: "H",
    type: "png",
    // `margin` is in MODULES here (the SVG path's margin is in pixels — they
    // are different units, so don't "align" the two numbers).
    margin: 2,
    scale: 10,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });

  const qr = PNG.sync.read(qrBuffer);
  const flame = PNG.sync.read(Buffer.from(FLAME_MARK_PNG_BASE64, "base64"));

  // Mirror the SVG variant's proportions so the two renderings stay identical.
  const logoH = Math.round(qr.height * 0.2);
  const logoW = Math.round(logoH * (flame.width / flame.height));
  const padW = Math.round(logoW * 1.6);
  const padH = Math.round(logoH * 1.35);

  // Excavate an opaque white pad. Scanners need the quiet contrast around the
  // mark; blending the flame straight onto modules would smear the boundary.
  const padX = Math.round((qr.width - padW) / 2);
  const padY = Math.round((qr.height - padH) / 2);
  for (let y = padY; y < padY + padH; y += 1) {
    for (let x = padX; x < padX + padW; x += 1) {
      const i = ((qr.width * y) + x) << 2;
      qr.data[i] = 255;
      qr.data[i + 1] = 255;
      qr.data[i + 2] = 255;
      qr.data[i + 3] = 255;
    }
  }

  // Nearest-neighbour downscale, alpha-blended onto the pad. The flame ships
  // small and only ever shrinks, so a box filter would buy nothing visible.
  const logoX = Math.round((qr.width - logoW) / 2);
  const logoY = Math.round((qr.height - logoH) / 2);
  for (let y = 0; y < logoH; y += 1) {
    for (let x = 0; x < logoW; x += 1) {
      const sx = Math.min(flame.width - 1, Math.floor((x * flame.width) / logoW));
      const sy = Math.min(flame.height - 1, Math.floor((y * flame.height) / logoH));
      const s = ((flame.width * sy) + sx) << 2;
      const d = ((qr.width * (logoY + y)) + (logoX + x)) << 2;
      const alpha = (flame.data[s + 3] ?? 0) / 255;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c += 1) {
        qr.data[d + c] = Math.round(
          (flame.data[s + c] ?? 0) * alpha + (qr.data[d + c] ?? 0) * (1 - alpha),
        );
      }
      qr.data[d + 3] = 255;
    }
  }

  return PNG.sync.write(qr);
}
