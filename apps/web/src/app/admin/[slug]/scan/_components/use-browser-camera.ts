"use client";

import { useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";

// Static import is safe and deliberate: `qr-decode-fallback` is a few
// constants and a pure size helper. The heavy part — jsQR itself — sits
// behind the `import("jsqr")` inside `loadQrFallbackDecoder`, which this
// hook only calls once it knows `BarcodeDetector` is missing.
import {
  QR_ANALYSIS_INTERVAL_MS,
  QR_ANALYSIS_MAX_DUTY_CYCLE,
  computeAnalysisSize,
  loadQrFallbackDecoder,
  type QrFallbackDecoder,
} from "./qr-decode-fallback";

/*
 * `parseQrPayload` used to live here — a client-side parser for
 * `hf://<eventId>/<ticketCode>` and bare codes. It was deleted, not deprecated:
 * the unified surface sends the decoded string to `scan.resolvePayload`
 * VERBATIM (the server dispatches ticket codes and volunteer JWTs alike), so
 * the helper had zero call sites while remaining a second, laxer parser sitting
 * next to the real one — the kind of thing someone eventually re-wires "because
 * it's right there" and re-opens the case-mangling bug the verbatim rule fixed.
 */

/**
 * Operator-facing copy for the degraded path. Deliberately a plain string,
 * matching the raw-English `cameraError` strings this hook already
 * produces — the scan surface has no i18n keys for camera diagnostics yet
 * and inventing one here would collide with the concurrent catalog work.
 */
export const CAMERA_DECODER_UNAVAILABLE_MESSAGE =
  "Camera scanning is unavailable in this browser. Use the code or name lookup instead.";

/**
 * Video frames are handled either by `requestVideoFrameCallback` (fires once
 * per decoded video frame — the right primitive, Safari 15.4+ / Chrome 83+)
 * or plain `requestAnimationFrame`. Both are display-driven, which is the
 * point: a backgrounded tab stops firing them, so a camera left enabled
 * behind another tab stops decoding on its own. `setTimeout` would keep
 * grinding.
 */
type FrameHandle =
  | { kind: "raf"; id: number }
  // The element is captured with the handle on purpose: React detaches host
  // refs during the mutation phase, BEFORE passive effect cleanups run, so
  // `videoRef.current` is already null by the time unmount cleanup fires and
  // cancelling through the ref would silently no-op.
  | { kind: "vfc"; id: number; target: VideoWithFrameCallback };

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — enough decoded data to draw. */
const READY_STATE_HAVE_CURRENT_DATA = 2;

/**
 * Consecutive per-frame decode failures tolerated before we give up and
 * degrade. One-off `drawImage` failures happen around track restarts and
 * shouldn't kill a working camera; a persistent failure is a real defect
 * and must surface rather than spin invisibly.
 */
const MAX_CONSECUTIVE_DECODE_FAILURES = 5;

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Browser camera + QR decoding.
 *
 * Two decode paths, one loop:
 *   - native `BarcodeDetector` where it exists (Chrome, Edge, Android);
 *   - a lazily-imported jsQR fallback everywhere else (FR-012) — every iOS
 *     browser and Firefox, which previously rendered a live viewfinder that
 *     could not decode anything.
 *
 * The fallback module is reached through a dynamic `import()` that only runs
 * once we've established `BarcodeDetector` is absent, so browsers with the
 * native API download zero fallback bytes.
 *
 * Both paths are throttled to {@link QR_ANALYSIS_INTERVAL_MS} (10 fps, NFR-003).
 * The scheduler still wakes per frame — that's how it inherits the "stops in
 * a backgrounded tab" property — but the actual analysis is time-gated, so
 * the expensive work (native detect, or a full-frame JS decode) happens at
 * most ten times a second instead of sixty.
 *
 * Cleanup tears down the media stream, the frame callback, and the decoder
 * reference on unmount or when `enabled` flips to false — important so the
 * camera release happens immediately when a result is shown.
 *
 * The public API ({@link videoRef}, `canvasRef`, `cameraError`) is unchanged
 * from the pre-FR-012 hook.
 */
export function useBrowserCamera(opts: {
  enabled: boolean;
  onScan: (data: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<FrameHandle | null>(null);
  // Detached scratch canvas for fallback frame grabs. Deliberately NOT the
  // returned `canvasRef`: that one belongs to the consumer, and assigning to
  // it would fight React if a caller ever binds it to a real <canvas>.
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Route `onScan` through a ref so the detection loop always reads the
  // latest callback. The effect deps deliberately exclude `onScan` (we don't
  // want to tear down the camera stream every render), so without this ref
  // the `tick` closure would call a stale callback that captured the old
  // `eventId` / state.
  const onScanRef = useRef(opts.onScan);
  useEffect(() => {
    onScanRef.current = opts.onScan;
  }, [opts.onScan]);

  useEffect(() => {
    const cancelFrame = () => {
      const handle = frameRef.current;
      frameRef.current = null;
      if (!handle) return;
      if (handle.kind === "vfc") {
        handle.target.cancelVideoFrameCallback?.(handle.id);
      } else {
        cancelAnimationFrame(handle.id);
      }
    };

    const stopStream = () => {
      if (!streamRef.current) return;
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    };

    if (!opts.enabled) {
      stopStream();
      cancelFrame();
      analysisCanvasRef.current = null;
      return;
    }

    /**
     * A NEW attempt starts clean.
     *
     * `cameraError` was set and never cleared, so a single transient failure —
     * one `getUserMedia` rejection while another tab held the device, one
     * decoder chunk that failed to load on a flaky venue connection — stuck a
     * red "camera unavailable" line under a camera that was, by then, working
     * fine. It stayed for the life of the page. The camera re-arms after every
     * verdict, so this branch is the natural place to retire the last failure.
     */
    setCameraError(null);

    let cancelled = false;
    // Held only for the life of this effect run so the decoder (and the
    // frame it closes over) is released on unmount / disable.
    let decoder: QrFallbackDecoder | null = null;
    // -Infinity, not 0: the throttle must gate the *cadence*, not delay the
    // very first analysis by up to 100 ms while an operator holds a ticket
    // under the lens.
    let nextAnalysisAt = Number.NEGATIVE_INFINITY;
    let consecutiveFailures = 0;

    const schedule = (fn: () => void) => {
      if (cancelled) return;
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (video && typeof video.requestVideoFrameCallback === "function") {
        frameRef.current = {
          kind: "vfc",
          target: video,
          id: video.requestVideoFrameCallback(() => {
            frameRef.current = null;
            fn();
          }),
        };
        return;
      }
      frameRef.current = {
        kind: "raf",
        id: requestAnimationFrame(() => {
          frameRef.current = null;
          fn();
        }),
      };
    };

    /**
     * Catch-and-degrade sink (NFR-006). Every branch that abandons decoding
     * reports to Sentry AND leaves the operator an explanation plus a working
     * lookup path — never a silent catch, never a live-but-dead viewfinder.
     */
    const degradeToLookup = (err: unknown, reason: string) => {
      try {
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
          {
            tags: { feature: "web-scan-camera", reason },
            extra: { hasBarcodeDetector: false },
          },
        );
      } catch {
        // A throwing reporter must never change scan behaviour.
      }
      cancelFrame();
      stopStream();
      if (!cancelled) setCameraError(CAMERA_DECODER_UNAVAILABLE_MESSAGE);
    };

    const startCamera = async () => {
      try {
        const hasBarcodeDetector =
          typeof window !== "undefined" && "BarcodeDetector" in window;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (cancelled) return;

        if (hasBarcodeDetector) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BarcodeDetector is a runtime-only API
          const detector = new (window as any).BarcodeDetector({
            formats: ["qr_code"],
          });
          const tick = () => {
            if (cancelled) return;
            if (!videoRef.current) {
              schedule(tick);
              return;
            }
            // The native detector runs off the main thread inside the
            // browser, so the fps ceiling alone is the right bound here — no
            // duty-cycle governor, there is no main-thread cost to govern.
            const at = now();
            if (at < nextAnalysisAt) {
              schedule(tick);
              return;
            }
            nextAnalysisAt = at + QR_ANALYSIS_INTERVAL_MS;
            detector
              .detect(videoRef.current)
              .then((barcodes: Array<{ rawValue: string }>) => {
                if (cancelled) return;
                if (barcodes.length > 0) {
                  onScanRef.current(barcodes[0].rawValue);
                  return; // caller pauses the camera via `enabled`
                }
                schedule(tick);
              })
              .catch(() => {
                if (cancelled) return;
                schedule(tick);
              });
          };
          schedule(tick);
          return;
        }

        // ── FR-012 fallback path ────────────────────────────────────────
        // First and only reach for jsQR. Everything above returned already
        // if the native detector exists, so the `import("jsqr")` inside this
        // call is unreachable on Chrome/Edge/Android.
        try {
          decoder = await loadQrFallbackDecoder();
        } catch (err) {
          degradeToLookup(err, "fallback-decoder-init");
          return;
        }
        if (cancelled) {
          decoder = null;
          return;
        }

        const fallbackTick = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const activeDecoder = decoder;
          if (!activeDecoder) return; // released by cleanup
          if (!video) {
            schedule(fallbackTick);
            return;
          }

          const at = now();
          if (at < nextAnalysisAt) {
            schedule(fallbackTick);
            return;
          }

          if (
            video.readyState < READY_STATE_HAVE_CURRENT_DATA ||
            !video.videoWidth ||
            !video.videoHeight
          ) {
            // Not a decode attempt — don't charge it against the throttle,
            // so the first real frame is analysed as soon as it arrives.
            schedule(fallbackTick);
            return;
          }
          // Provisional: overwritten below with the duty-cycle-aware value
          // once we know what this decode actually cost. Set up-front so an
          // early `return` (hit, or degrade) can never leave the gate open.
          nextAnalysisAt = at + QR_ANALYSIS_INTERVAL_MS;

          try {
            const size = computeAnalysisSize(video.videoWidth, video.videoHeight);
            const canvas =
              analysisCanvasRef.current ??
              (analysisCanvasRef.current = document.createElement("canvas"));
            if (canvas.width !== size.width) canvas.width = size.width;
            if (canvas.height !== size.height) canvas.height = size.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("2d canvas context unavailable");
            ctx.drawImage(video, 0, 0, size.width, size.height);
            const frame = ctx.getImageData(0, 0, size.width, size.height);
            const value = activeDecoder.decode(
              frame.data,
              frame.width,
              frame.height,
            );
            // Duty-cycle governor (NFR-003). jsQR is synchronous main-thread
            // work costing 35-200 ms per 640-edge frame, so the next analysis
            // is pushed out in proportion to what this one actually cost:
            // never sooner than the 10 fps floor, and never so soon that
            // decoding exceeds QR_ANALYSIS_MAX_DUTY_CYCLE of wall time. A
            // slow phone loses cadence instead of pinning a core.
            const cost = now() - at;
            nextAnalysisAt =
              at +
              Math.max(
                QR_ANALYSIS_INTERVAL_MS,
                cost / QR_ANALYSIS_MAX_DUTY_CYCLE,
              );
            consecutiveFailures = 0;
            if (cancelled) return;
            if (value) {
              onScanRef.current(value);
              return; // caller pauses the camera via `enabled`
            }
          } catch (err) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_DECODE_FAILURES) {
              degradeToLookup(err, "fallback-decoder-frame");
              return;
            }
          }
          schedule(fallbackTick);
        };
        schedule(fallbackTick);
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error ? err.message : "Could not access camera",
          );
        }
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      // Release the decoder and the scratch frame buffer so a disabled or
      // unmounted camera holds nothing — no loop, no stream, no bitmap.
      decoder = null;
      analysisCanvasRef.current = null;
      stopStream();
      cancelFrame();
    };
  }, [opts.enabled]);

  return { videoRef, canvasRef, cameraError };
}
