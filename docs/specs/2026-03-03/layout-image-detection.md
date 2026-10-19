# Layout Image Detection — Server-Side Architecture

> Not built yet (2026-10-08 docs consolidation): Port only; no adapter implements it and no use case calls it

**Status:** In Progress (Phase 1)
**Date:** 2026-02-19
**Updated:** 2026-02-19

## Problem

The original layout auto-detection pipeline ran entirely in the browser:

1. Lazy-loads OpenCV.js (~8 MB WASM) from the official CDN
2. Runs Canny edge detection + contour extraction (sections) and HoughCircles
   (seats) on the raw-resolution image
3. Maps pixel coordinates → designer world-space

This is **painfully slow** on real stadium images (e.g. Vaught-Hemingway
off SeatGeek).  The bottleneck is a combination of:

- **WASM cold start** — downloading + compiling 8 MB on every page load
- **No downscaling** — processing the full-resolution image when detection
  only needs ~800 px on the long side
- **Main-thread blocking** — OpenCV.js is synchronous once loaded; the UI
  freezes during processing

## Solution

Move detection to a **server-side endpoint** running OpenCV via
[`sharp`](https://sharp.pixelplumbing.com/) (for fast image decode /
downscale) + [`opencv4nodejs-prebuilt`](https://github.com/nicktaylordev/opencv4nodejs-prebuilt)
or a purpose-built Cloud Run container with native OpenCV.

### Architecture layers

```
Client (detect.ts)
  │  POST /api/detect-layout  (multipart: image file + params JSON)
  │
  ▼
Transport (Fastify route or tRPC mutation)
  │  validate input, stream image to adapter
  │
  ▼
Port: LayoutImageDetectorPort
  │  detect(image: Buffer, params): DetectionResult
  │
  ▼
Adapter: SharpOpenCVLayoutDetector
  │  1. sharp: decode + downscale to ≤ 1200 px
  │  2. OpenCV (native): grayscale → blur → Canny → contours → sections
  │  3. OpenCV (native): HoughCircles → seats
  │  4. Map pixel coords → world-space
  │  5. Return { sections, seats }
```

### Why not a Web Worker?

A Web Worker would solve the main-thread blocking but not the download size
or raw performance issues.  Native OpenCV on the server is ~10–50x faster
than the WASM build for large images, and `sharp` gives us free downscaling
via libvips (no extra memory copies).

### Phase plan

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **0** | ~~Downscale on the client before sending to current WASM pipeline~~ | ~~Quick win: cuts processing time ~4x for large images~~ **DONE** — client-side OpenCV removed entirely |
| **1** | Port + adapter + Fastify endpoint | Server-side detection, client sends image over HTTP — **IN PROGRESS** (port defined, client rewritten as HTTP client) |
| **2** | Cloud Run job (optional) | For very large / batch detection; decoupled from API cold-start |

## Phase 0 — Client-side downscale (immediate)

Before touching the server, we can get a quick win by downscaling the image
to a reasonable detection resolution on the client before feeding it to
OpenCV.  Stadium seating maps don't need pixel-perfect resolution for contour
/ circle detection — 800–1200 px on the long side is plenty.

Changes:
- `detect.ts`: add `downscaleForDetection(img, maxDim)` that draws the image
  onto a smaller offscreen canvas before passing to `cv.imread`.
- Coordinate mapper adjusts for the downscale ratio.

## Phase 1 — Server-side port + adapter

### Port: `LayoutImageDetectorPort`

```ts
// packages/ports/src/place-layouts/layout-image-detector.port.ts

export type LayoutDetectionParams = {
  minSectionArea?: number;
  maxSectionAreaFraction?: number;
  cannyLow?: number;
  cannyHigh?: number;
  approxEpsilon?: number;
  minSeatRadius?: number;
  maxSeatRadius?: number;
  houghThreshold?: number;
  minSeatDistance?: number;
};

export type DetectedSection = {
  label: string;
  color: string;
  polygon: Array<{ x: number; y: number }>;
};

export type DetectedSeat = {
  position: { x: number; y: number };
  radius: number;
};

export type LayoutDetectionResult = {
  sections: DetectedSection[];
  seats: DetectedSeat[];
  /** Processing time in ms (for observability). */
  durationMs: number;
};

export interface LayoutImageDetectorPort {
  detect(
    imageBuffer: Buffer,
    params?: LayoutDetectionParams,
  ): Promise<LayoutDetectionResult>;
}
```

### Transport

Fastify multipart route (not tRPC — binary upload doesn't fit well in the
tRPC JSON-RPC model):

```
POST /api/places/:placeId/detect-layout
Content-Type: multipart/form-data
  - file: image/png | image/jpeg
  - params: JSON string (LayoutDetectionParams)

Response 200:
  { sections: [...], seats: [...], durationMs: number }
```

Auth: requires org admin/staff role on the place's org.

### Client changes

`detect.ts` becomes a thin HTTP client:

```ts
export async function detectShapesAndSeats(
  imageDataUrl: string,
  params: DetectionParams,
): Promise<DetectionResult> {
  const blob = dataUrlToBlob(imageDataUrl);
  const form = new FormData();
  form.append("file", blob, "layout.png");
  form.append("params", JSON.stringify(params));

  const res = await fetch(`/api/places/${placeId}/detect-layout`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) throw new Error(`Detection failed: ${res.status}`);
  return res.json();
}
```

No more OpenCV.js CDN load.  No more client-side WASM.

## File locations

| Layer | Path |
|-------|------|
| Port | `packages/ports/src/place-layouts/layout-image-detector.port.ts` |
| Adapter | `packages/adapters/src/place-layouts/sharp-opencv-layout-detector.ts` |
| Transport | `apps/api/src/routes/detect-layout.ts` |
| Client | `apps/web/.../designer/detect.ts` (rewritten to HTTP client) |
| Tests | `packages/adapters/src/place-layouts/__tests__/sharp-opencv-layout-detector.test.ts` |
| Test fixtures | `apps/web/.../designer/__tests__/fixtures/` |
