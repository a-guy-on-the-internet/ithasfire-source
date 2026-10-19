// ─────────────────────────────────────────────────────────────────────────────
// LayoutImageDetectorPort — auto-detect sections & seats from a reference image
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 of the server-migration plan (docs/specs/2026-03-03/layout-image-detection.md).
// The adapter will use sharp (image decode / downscale) + native OpenCV
// (contour + circle detection) on the server.
// ─────────────────────────────────────────────────────────────────────────────

export type LayoutDetectionParams = {
  /** Minimum contour area (original px²) to treat as a section. Default 2000. */
  minSectionArea?: number;
  /** Max contour area as a fraction of total image area (0-1). Default 0.85. */
  maxSectionAreaFraction?: number;
  /** Canny low threshold. Default 50. */
  cannyLow?: number;
  /** Canny high threshold. Default 150. */
  cannyHigh?: number;
  /** Polygon approximation epsilon (fraction of arc length). Default 0.02. */
  approxEpsilon?: number;
  /** Minimum circle radius for seat detection (px). Default 4. */
  minSeatRadius?: number;
  /** Maximum circle radius for seat detection (px). Default 30. */
  maxSeatRadius?: number;
  /** Hough accumulator threshold. Lower = more detections. Default 20. */
  houghThreshold?: number;
  /** Minimum distance between detected circles (px). Default 10. */
  minSeatDistance?: number;
};

export type DetectedSection = {
  /** Auto-generated label, e.g. "Section 1". */
  label: string;
  /** Hex colour from the default palette. */
  color: string;
  /** Polygon vertices in normalised coordinates (0-1 of image dimensions). */
  polygon: Array<{ x: number; y: number }>;
};

export type DetectedSeat = {
  /** Position in normalised coordinates (0-1 of image dimensions). */
  position: { x: number; y: number };
  /** Radius in normalised units. */
  radius: number;
};

export type LayoutDetectionResult = {
  sections: DetectedSection[];
  seats: DetectedSeat[];
  /** Processing wall-clock time in milliseconds. */
  durationMs: number;
};

/**
 * Port for image-based layout detection.
 *
 * Accepts a raw image buffer (PNG or JPEG) and returns detected sections
 * (as polygons) and seats (as circles) in normalised image coordinates.
 * The caller is responsible for mapping normalised coords to world-space.
 */
export interface LayoutImageDetectorPort {
  detect(
    imageBuffer: Buffer,
    params?: LayoutDetectionParams,
  ): Promise<LayoutDetectionResult>;
}
