import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

import {
  buildDateStubElement,
  OG_HEIGHT,
  OG_MONO,
  OG_SANS,
  OG_WIDTH,
  type DateStubProps,
} from "./date-stub";

/**
 * Font loading + rasterisation for the OG Date Stub.
 *
 * Split out of the route handler so the expensive, failure-prone half is
 * directly unit-testable and the route stays a thin shell.
 *
 * ── WHY `process.cwd()/public` IS THE RIGHT PATH IN PRODUCTION ──────────────
 * `apps/web/next.config.ts` sets `output: "standalone"`. Next's generated
 * `server.js` calls `process.chdir(__dirname)` before booting, so the process
 * cwd is the standalone copy of the `apps/web` directory. `apps/web/Dockerfile`
 * then does `cp -a apps/web/public .../standalone/apps/web/public`, which puts
 * `public/` directly beside that server. So `process.cwd()/public/fonts/og` is
 * the same path in the container as it is in `pnpm dev` and in vitest run from
 * `apps/web`.
 *
 * ── WHY THESE FOUR TTFs ─────────────────────────────────────────────────────
 * Satori parses TTF/OTF/WOFF; it CANNOT read WOFF2, and it will not instance a
 * variable font's weight axis — so `public/fonts/*.woff2` (including
 * `Montserrat-roman.var.woff2`) is unusable here. `public/fonts/og/` holds
 * static, single-weight TTFs vendored for exactly this purpose, and each weight
 * is registered as its own face so Satori selects rather than synthesises.
 */

type FontSpec = {
  name: string;
  file: string;
  weight: 500 | 600 | 700 | 900;
  style: "normal";
};

/**
 * The exact faces registered with `ImageResponse`.
 *
 * The 900 matters most: the Date Stub's day numeral is display type at weight
 * 900 on the SANS, and a silent fallback to 500 would quietly cost the molecule
 * its entire identity.
 */
export const OG_FONT_SPECS: readonly FontSpec[] = [
  { name: OG_SANS, file: "Montserrat-900.ttf", weight: 900, style: "normal" },
  { name: OG_SANS, file: "Montserrat-700.ttf", weight: 700, style: "normal" },
  { name: OG_SANS, file: "Montserrat-500.ttf", weight: 500, style: "normal" },
  { name: OG_MONO, file: "IBMPlexMono-600.ttf", weight: 600, style: "normal" },
] as const;

export const OG_FONT_DIR = "public/fonts/og";

export type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: FontSpec["weight"];
  style: FontSpec["style"];
};

/**
 * Module-scope memo: the four TTFs are ~1.5MB and never change within a
 * process, so they are read once rather than per request.
 *
 * The memo holds the in-flight PROMISE (so concurrent first requests share one
 * read) and is CLEARED on rejection. Caching a rejected promise would poison
 * the process permanently — one transient EMFILE at boot and every OG image
 * for the life of that container would fall through to the static poster.
 */
let fontsPromise: Promise<LoadedFont[]> | null = null;

const readFonts = async (): Promise<LoadedFont[]> => {
  const dir = path.join(process.cwd(), OG_FONT_DIR);
  return Promise.all(
    OG_FONT_SPECS.map(async (spec) => {
      const buffer = await readFile(path.join(dir, spec.file));
      return {
        name: spec.name,
        // Slice to a standalone ArrayBuffer — a Node Buffer's `.buffer` is a
        // shared pool and would hand Satori unrelated bytes.
        data: buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer,
        weight: spec.weight,
        style: spec.style,
      };
    }),
  );
};

export const loadOgFonts = (): Promise<LoadedFont[]> => {
  if (!fontsPromise) {
    fontsPromise = readFonts().catch((err) => {
      fontsPromise = null;
      throw err;
    });
  }
  return fontsPromise;
};

/**
 * Rasterises the Date Stub to a 1200x630 PNG response.
 *
 * ── WHY THE BYTES ARE BUFFERED BEFORE THE RESPONSE IS RETURNED ──────────────
 * `new ImageResponse(...)` is SYNCHRONOUS and does its work inside the body
 * stream's `start()`. Returning it directly hands the caller a finished 200
 * `image/png` before a single glyph has been laid out, so a throw from satori
 * or resvg — a corrupt TTF, an unsupported style, an OOM — errors the BODY of
 * an already-sent response. The route's `try/catch` never sees it and the
 * static-poster fallback never runs; the client just gets a truncated image.
 * Measured, not theorised: with a junk font buffer the constructor returns a
 * clean 200 and `arrayBuffer()` rejects with "Unsupported OpenType signature".
 *
 * Awaiting `arrayBuffer()` here pulls the rasterisation INSIDE the caller's
 * try/catch, and the plain `Response` it returns also means the cache header is
 * whatever we set — no merging with the built-in one to reason about.
 */
export const renderDateStubResponse = async (
  props: DateStubProps,
  headers?: Record<string, string>,
): Promise<Response> => {
  const fonts = await loadOgFonts();
  const image = new ImageResponse(buildDateStubElement(props), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts,
  });
  const bytes = await image.arrayBuffer();

  const responseHeaders = new Headers();
  responseHeaders.set("Content-Type", "image/png");
  responseHeaders.set("Content-Length", String(bytes.byteLength));
  for (const [name, value] of Object.entries(headers ?? {})) {
    responseHeaders.set(name, value);
  }
  return new Response(bytes, { status: 200, headers: responseHeaders });
};
