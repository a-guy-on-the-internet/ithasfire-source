"use client";

/**
 * Fallback QR decoding for browsers without the native `BarcodeDetector`
 * API — in practice every iOS browser (all of them are WebKit) plus
 * Firefox. Before FR-012 those browsers silently degraded to name/code
 * lookup only, which is the single reason an iPhone could not scan at the
 * door.
 *
 * ## Why jsQR and not zxing-wasm
 *
 * Measured on 2026-08-07 (`pnpm view`, then esbuild --minify on the
 * installed dist):
 *
 * | candidate    | npm unpacked | ships a separate binary?           |
 * | ------------ | ------------ | ---------------------------------- |
 * | `jsqr@1.4.0` | 280 KB       | no — one UMD JS file               |
 * | `zxing-wasm` | 3.77 MB      | yes — `dist/**\/zxing_*.wasm`      |
 *
 * jsQR minifies to ~130 KB raw / ~47 KB gzip and is a single JS chunk that
 * the bundler fingerprints and the CDN caches like any other chunk. It has
 * **no separate asset to resolve**, which is the deciding factor: zxing-wasm
 * resolves its `.wasm` at runtime (by default from a jsDelivr URL keyed to
 * the exact package version, overridable via `setZXingModuleOverrides`).
 * Both variants are failure modes we refuse to ship to a door operator:
 * a CDN fetch is a network dependency on venue wifi that the rest of this
 * spec works hard to avoid, and a self-hosted copy in `public/` is a
 * hand-maintained file that silently 404s the moment the package version
 * moves — a dead camera with no error, which is exactly the class of bug
 * FR-012 exists to kill.
 *
 * The trade is decode robustness: ZXing is better on damaged, skewed, and
 * low-contrast codes. That is not our input. Ithas Fire ticket QRs are
 * rendered dark-on-forced-white (see the "literal white is REQUIRED"
 * comment in `OrderDetail.tsx`) on a backlit phone screen held ~20 cm from
 * the lens — the best-case input for any decoder.
 *
 * jsQR is unmaintained (last release 2021) but is a pure-JS, dependency-free,
 * ~1k-LOC decoder with no network or platform surface, so "unmaintained"
 * here means "frozen", not "rotting".
 */

/** Analysis cadence ceiling — at most 10 analyses/second, per NFR-003. */
export const QR_ANALYSIS_INTERVAL_MS = 100;

/**
 * Second, independent NFR-003 bound: the fraction of wall-clock time the
 * decode loop is allowed to spend inside the decoder.
 *
 * The fps ceiling alone is not a CPU budget. Measured on this machine
 * (node 26 / V8, `jsQR(..., { inversionAttempts: "dontInvert" })` over
 * synthetic camera frames, 2026-08-07):
 *
 * | analysis frame | QR in frame | no QR in frame |
 * | -------------- | ----------- | -------------- |
 * | 640x360        | 205 ms      | 64 ms          |
 * | 480x270        | 78 ms       | 56 ms          |
 * | 400x225        | 36 ms       | 53 ms          |
 * | 1280x720       | 235 ms      | 151 ms         |
 *
 * A flat 10 fps at those costs is 60-200% of one core — on a laptop, and a
 * phone is slower again. So the loop measures every decode and waits
 * proportionally: cost/0.25 means a 90 ms decode is followed by a 360 ms
 * cooldown (≈2.8 fps at 25% CPU), while a cheap 10 ms decode just hits the
 * 100 ms fps floor (10 fps at 10% CPU). Slow devices degrade in cadence
 * rather than in thermals, which is the trade a door operator wants.
 */
export const QR_ANALYSIS_MAX_DUTY_CYCLE = 0.25;

/**
 * Longest edge (px) of the frame we hand the decoder. The camera is
 * requested at 1280x720; the table above shows decoding that natively costs
 * 150-235 ms/frame, so we downscale.
 *
 * 640 rather than something smaller because decode *reliability* is the
 * entire point of FR-012 — an iPhone that fails to lock onto a code is no
 * better off than one with no decoder. At 640 a version-1..4 ticket QR
 * covering half the frame still lands 5-8 px per module, comfortably above
 * jsQR's floor. The duty-cycle governor above, not a smaller frame, is what
 * bounds the CPU.
 */
export const QR_ANALYSIS_MAX_EDGE = 640;

export type QrFallbackDecoder = {
  /** Returns the decoded payload, or `null` when no QR is in the frame. */
  decode(
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): string | null;
};

/**
 * Fit `width`x`height` inside a `maxEdge` box, preserving aspect ratio.
 * Never upscales — a camera that already reports a small frame is passed
 * through untouched.
 */
export function computeAnalysisSize(
  width: number,
  height: number,
  maxEdge: number = QR_ANALYSIS_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 0, height: 0 };
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Dynamically import jsQR and wrap it in the narrow {@link QrFallbackDecoder}
 * shape.
 *
 * **This must stay the only reference to `jsqr` in the app.** The `import()`
 * is what keeps ~47 KB gzip out of the bundle for every browser that has
 * `BarcodeDetector` (Chrome/Edge/Android), and the hook only calls this
 * function after it has established the native API is missing. Do not add a
 * static `import ... from "jsqr"` anywhere — that would hoist the cost back
 * onto everyone.
 *
 * Not memoised on purpose: the ES module registry already caches a resolved
 * dynamic import, and skipping our own cache means a failed load (offline
 * during the chunk fetch) is genuinely retried the next time the operator
 * re-enables the camera instead of being memoised as permanently broken.
 */
export async function loadQrFallbackDecoder(): Promise<QrFallbackDecoder> {
  const mod = await import("jsqr");
  const jsQR = mod.default;
  if (typeof jsQR !== "function") {
    throw new Error("jsqr module did not export a decoder function");
  }
  return {
    decode(data, width, height) {
      // `dontInvert` halves the work. Safe here because every Ithas Fire QR
      // surface is contractually dark-on-white (ticket detail, wallet pass,
      // /tickets/qr/[code]); we never render an inverted code.
      const result = jsQR(data, width, height, {
        inversionAttempts: "dontInvert",
      });
      return result?.data ?? null;
    },
  };
}
