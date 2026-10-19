// ─────────────────────────────────────────────────────────────────────────────
// Place Layout Designer — server-side image detection client
// ─────────────────────────────────────────────────────────────────────────────
// Sends the reference image to the API's `/api/places/:placeId/detect-layout`
// endpoint and returns the detection result.
//
// All heavy lifting (OpenCV, sharp, etc.) happens server-side.
// See docs/specs/2026-03-03/layout-image-detection.md for the full architecture.
// ─────────────────────────────────────────────────────────────────────────────

import type { DesignerSection, Point } from "./types";

// ── Public types ─────────────────────────────────────────────────────────────

export type DetectionParams = {
  /** Minimum contour area (in px²) to treat as a section. Default 2000. */
  minSectionArea?: number;
  /** Max contour area fraction of total image (0-1). Default 0.85. */
  maxSectionAreaFraction?: number;
  /** Canny low threshold. Default 50. */
  cannyLow?: number;
  /** Canny high threshold. Default 150. */
  cannyHigh?: number;
  /** Polygon approximation epsilon factor (fraction of arc length). Default 0.02. */
  approxEpsilon?: number;
  /** Minimum circle radius for seat detection (px). Default 4. */
  minSeatRadius?: number;
  /** Maximum circle radius for seat detection (px). Default 30. */
  maxSeatRadius?: number;
  /** Hough accumulator threshold for circles. Lower = more detections. Default 20. */
  houghThreshold?: number;
  /** Minimum distance between detected circles (px). Default 10. */
  minSeatDistance?: number;
  /**
   * Coordinate transform: the designer image placement in world-space.
   * The server returns normalised (0-1) coordinates; the client maps them
   * to world-space using these values.
   */
  imageWorldX?: number;
  imageWorldY?: number;
  imageWorldW?: number;
  imageWorldH?: number;
};

export type DetectionResult = {
  sections: DesignerSection[];
  seats: Array<{ position: Point; radius: number }>;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a base64 data-URL to a Blob for FormData upload. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta!.match(/:(.*?);/)?.[1] ?? "image/png";
  const bytes = atob(b64!);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a reference image to the server for auto-detection of sections and
 * seats.  Returns designer-ready types in world-space coordinates.
 *
 * @param imageDataUrl  Base64 data URL of the reference image (stored in
 *                      `DesignerImage.dataUrl`).
 * @param placeId       Place ID — used to build the endpoint URL.
 * @param params        Detection tuning + world-space mapping params.
 */
export async function detectShapesAndSeats(
  imageDataUrl: string,
  placeId: string,
  params: DetectionParams = {},
): Promise<DetectionResult> {
  const {
    imageWorldX = 0,
    imageWorldY = 0,
    imageWorldW = 1,
    imageWorldH = 1,
    ...serverParams
  } = params;

  // ── Upload image to server ───────────────────────────────────────────
  const blob = dataUrlToBlob(imageDataUrl);
  const form = new FormData();
  form.append("file", blob, "layout.png");
  form.append("params", JSON.stringify(serverParams));

  const apiBase =
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__NEXT_DATA__
      ? "" // same-origin in Next.js (proxied)
      : (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001");

  const res = await fetch(`${apiBase}/api/places/${placeId}/detect-layout`, {
    method: "POST",
    body: form,
    credentials: "include",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Layout detection failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    sections: Array<{
      label: string;
      color: string;
      polygon: Array<{ x: number; y: number }>;
    }>;
    seats: Array<{
      position: { x: number; y: number };
      radius: number;
    }>;
    durationMs: number;
  };

  // ── Map normalised (0-1) coordinates → designer world-space ──────────
  const toWorldPoint = (p: { x: number; y: number }): Point => ({
    x: imageWorldX + p.x * imageWorldW,
    y: imageWorldY + p.y * imageWorldH,
  });

  const sections: DesignerSection[] = data.sections.map((s, i) => ({
    sectionId: `detected-${i + 1}`,
    label: s.label,
    color: s.color,
    polygon: s.polygon.map(toWorldPoint),
    kind: "seat" as const,
  }));

  const seats = data.seats.map((s) => ({
    position: toWorldPoint(s.position),
    radius: s.radius * Math.max(imageWorldW, imageWorldH),
  }));

  return { sections, seats };
}
