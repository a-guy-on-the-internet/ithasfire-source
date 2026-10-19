import { NextResponse } from "next/server";
import QRCode from "qrcode-generator";

import { FLAME_MARK_ASPECT, FLAME_MARK_PNG_BASE64 } from "./flame-mark";
import { renderTicketQrPng } from "./render-png";

// pngjs needs Buffer/zlib. Explicit so nobody flips this route to the edge
// runtime and discovers it at deploy time.
export const runtime = "nodejs";

/**
 * Public QR-image endpoint for ticket emails.
 *
 * The ticket-issued email embeds an `<img src="/tickets/qr/{code}">` for
 * every ticket. Email clients that strip data: URIs (Outlook, parts of
 * Gmail) need a real hosted URL, so this is a hosted image rather than an
 * inlined one.
 *
 * **It serves PNG by default, and that is deliberate.** This endpoint was
 * SVG-only, which renders in a browser and in Apple Mail but NOT in Outlook
 * desktop (Word's engine cannot draw SVG at all) or Gmail (which refuses
 * `image/svg+xml`). The ticket email leads with this image and tells the buyer
 * it IS their ticket, so shipping a format a large share of inboxes drops was
 * a real delivery bug, not a rendering nicety.
 *
 * `?format=svg` still returns the vector for browser/web surfaces that want
 * it. Do not make SVG the default again without a client-support argument.
 *
 * The code itself is the QR payload (matches the scanner's expectation).
 * No auth: the code is high-entropy and only useful at the door, and the
 * scanner enforces single-use semantics. We do gate on a basic shape
 * check to avoid arbitrary content being served as our SVG.
 */

const CACHE_HEADER =
  "private, no-store, max-age=0, must-revalidate, no-transform";

const VALID_CODE = /^[A-Za-z0-9_-]{4,128}$/;

const SHARED_HEADERS: Record<string, string> = {
  "Cache-Control": CACHE_HEADER,
  "Content-Security-Policy":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  if (!VALID_CODE.test(code)) {
    return new NextResponse("invalid code", { status: 400 });
  }

  const wantsSvg =
    new URL(_req.url).searchParams.get("format")?.toLowerCase() === "svg";

  if (!wantsSvg) {
    const png = await renderTicketQrPng(code);
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: { ...SHARED_HEADERS, "Content-Type": "image/png" },
    });
  }

  // Level "H" (~30% recovery) so the centered flame overlay never degrades
  // door-scanning reliability.
  const qr = QRCode(0, "H");
  qr.addData(code);
  qr.make();
  const margin = 2;
  const cellSize = 8;
  const svg = qr.createSvgTag({ cellSize, margin, scalable: true });

  // Composite the Ithas Fire flame mark into the center. The flame is inlined
  // as a data: URI because this SVG renders in email `<img>` "secure static"
  // mode under a strict CSP — an external/same-origin href would not load.
  // `createSvgTag` sizes the viewBox as moduleCount*cellSize + margin*2 (margin
  // is a pixel value added once per side), so mirror that exactly.
  const size = qr.getModuleCount() * cellSize + margin * 2;
  const logoH = size * 0.2;
  // The white excavation pad below is derived from these, so a stale ratio
  // leaves the flame floating in an over-wide hole rather than filling it.
  // FLAME_MARK_ASPECT ships alongside the inlined base64 so the two can't drift.
  const logoW = logoH * FLAME_MARK_ASPECT;
  const padW = logoW * 1.6;
  const padH = logoH * 1.35;
  const dataUri = `data:image/png;base64,${FLAME_MARK_PNG_BASE64}`;
  const overlay =
    `<rect x="${(size - padW) / 2}" y="${(size - padH) / 2}" width="${padW}" height="${padH}" rx="4" fill="#ffffff"/>` +
    `<image x="${(size - logoW) / 2}" y="${(size - logoH) / 2}" width="${logoW}" height="${logoH}" ` +
    `preserveAspectRatio="xMidYMid meet" href="${dataUri}" xlink:href="${dataUri}"/>`;
  // Some email "secure static" renderers honor only the legacy xlink:href, and
  // `createSvgTag` omits the xlink namespace — declare it so both attrs resolve.
  const svgWithLogo = svg
    .replace(
      'xmlns="http://www.w3.org/2000/svg"',
      'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
    )
    .replace("</svg>", `${overlay}</svg>`);

  return new NextResponse(svgWithLogo, {
    status: 200,
    headers: { ...SHARED_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8" },
  });
}
