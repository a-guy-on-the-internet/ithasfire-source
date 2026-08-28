import type { PrismaClient } from "@prisma/client";

/**
 * Validate that place-layout metadata is renderable by the SeatMapPicker component.
 *
 * Unlike `validatePlaceLayouts` (which checks DB consistency — sections exist,
 * seats exist, ticket types are linked), this validator checks that the *data shape*
 * stored in the PlaceLayout.metadata JSON will actually produce visible output
 * in the checkout seat map.
 *
 * SeatMapPicker rendering paths:
 * 1. **Geometry path** — sections have `geometry.polygons` → SVG polygons rendered
 * 2. **Glyph path** — `glyphBlobUrl` present → individual seat circles rendered
 * 3. **Fallback path** — neither geometry nor glyphs → simple section dots in a row
 *
 * This validator ensures that regardless of path, the data is well-formed enough
 * to produce meaningful visual output.
 */

export type RenderabilityIssue = {
  placeId: string;
  layoutName: string;
  level: "error" | "warning";
  code: string;
  message: string;
};

type MetadataSection = {
  sectionId?: string;
  label?: string;
  color?: string | null;
  capacity?: number;
  geometry?: {
    polygons?: Array<Array<{ x: number; y: number }>> | null;
    origin?: { x: number; y: number } | null;
  } | null;
};

type MetadataEnvelope = {
  version?: number;
  seatIds?: string[];
  seatCount?: number;
  sectionCount?: number;
  seatIndexBounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  sections?: MetadataSection[];
};

type StageData = {
  kind?: string;
  label?: string | null;
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
};

/**
 * Run renderability checks on every PlaceLayout in the database.
 *
 * Returns an empty array when everything is valid.
 */
export async function validateLayoutRenderability(
  prisma: PrismaClient,
): Promise<RenderabilityIssue[]> {
  const issues: RenderabilityIssue[] = [];

  const layouts = await prisma.placeLayout.findMany({
    select: {
      id: true,
      placeId: true,
      name: true,
      metadata: true,
      stage: true,
      glyphSnapshotKey: true,
    },
  });

  for (const layout of layouts) {
    const ctx = { placeId: layout.placeId, layoutName: layout.name };

    // ── 1. Metadata must exist and be an object ────────────────────────
    if (
      !layout.metadata ||
      typeof layout.metadata !== "object" ||
      Array.isArray(layout.metadata)
    ) {
      issues.push({
        ...ctx,
        level: "error",
        code: "missing_metadata",
        message: "PlaceLayout.metadata is missing or not an object",
      });
      continue;
    }

    const metadata = layout.metadata as MetadataEnvelope;

    // ── 2. seatIndexBounds must exist with finite numbers ──────────────
    if (!metadata.seatIndexBounds) {
      issues.push({
        ...ctx,
        level: "error",
        code: "missing_seat_index_bounds",
        message: "metadata.seatIndexBounds is required for the SVG viewBox",
      });
    } else {
      const b = metadata.seatIndexBounds;
      const vals = [b.minX, b.minY, b.maxX, b.maxY];
      if (vals.some((v) => typeof v !== "number" || !isFinite(v))) {
        issues.push({
          ...ctx,
          level: "error",
          code: "invalid_seat_index_bounds",
          message: `seatIndexBounds contains non-finite values: ${JSON.stringify(b)}`,
        });
      }

      const w = (b.maxX ?? 0) - (b.minX ?? 0);
      const h = (b.maxY ?? 0) - (b.minY ?? 0);
      if (w <= 0 || h <= 0) {
        issues.push({
          ...ctx,
          level: "error",
          code: "degenerate_bounds",
          message: `seatIndexBounds has zero or negative dimensions (${w}×${h}). This produces an invalid SVG viewBox.`,
        });
      }
    }

    // ── 3. sections must be a non-empty array ──────────────────────────
    if (!Array.isArray(metadata.sections) || metadata.sections.length === 0) {
      issues.push({
        ...ctx,
        level: "error",
        code: "no_sections",
        message:
          "metadata.sections is empty or missing — SeatMapPicker needs at least one section to render cards",
      });
      continue;
    }

    // ── 4. Each section must have required fields ──────────────────────
    for (const [idx, section] of metadata.sections.entries()) {
      const sId = section.sectionId ?? `index:${idx}`;

      if (!section.sectionId || typeof section.sectionId !== "string") {
        issues.push({
          ...ctx,
          level: "error",
          code: "section_missing_id",
          message: `sections[${idx}] is missing sectionId — cannot link to ticket types`,
        });
      }

      if (!section.label || typeof section.label !== "string") {
        issues.push({
          ...ctx,
          level: "error",
          code: "section_missing_label",
          message: `sections[${idx}] (${sId}) is missing label — card will render blank`,
        });
      }

      if (typeof section.capacity !== "number" || section.capacity < 0) {
        issues.push({
          ...ctx,
          level: "warning",
          code: "section_bad_capacity",
          message: `sections[${idx}] (${sId}) has invalid capacity: ${section.capacity}`,
        });
      }
    }

    // ── 5. seatIds must be present and match seatCount ─────────────────
    if (!Array.isArray(metadata.seatIds)) {
      issues.push({
        ...ctx,
        level: "error",
        code: "missing_seat_ids",
        message:
          "metadata.seatIds is missing — seat-sections.ts needs this to create Seat records",
      });
    } else {
      if (metadata.seatIds.length === 0) {
        issues.push({
          ...ctx,
          level: "warning",
          code: "empty_seat_ids",
          message:
            "metadata.seatIds is empty — no individual seats will be created",
        });
      }

      // Each seatId should be prefixed with a sectionId that exists
      const sectionIds = new Set(
        (metadata.sections ?? []).map((s) => s.sectionId),
      );
      const orphanedSeats = metadata.seatIds.filter((sid) => {
        const prefix = sid.split("-").slice(0, -2).join("-"); // "ga-floor-A-1" → "ga-floor"
        // Try progressively shorter prefixes
        return !Array.from(sectionIds).some(
          (secId) => secId && sid.startsWith(`${secId}-`),
        );
      });

      if (orphanedSeats.length > 0) {
        issues.push({
          ...ctx,
          level: "warning",
          code: "orphaned_seat_ids",
          message: `${orphanedSeats.length} seatId(s) don't match any section prefix (first 3: ${orphanedSeats.slice(0, 3).join(", ")})`,
        });
      }

      if (
        typeof metadata.seatCount === "number" &&
        metadata.seatCount !== metadata.seatIds.length
      ) {
        issues.push({
          ...ctx,
          level: "warning",
          code: "seat_count_mismatch",
          message: `metadata.seatCount (${metadata.seatCount}) does not match seatIds.length (${metadata.seatIds.length})`,
        });
      }
    }

    // ── 6. sectionCount should match sections array ────────────────────
    if (
      typeof metadata.sectionCount === "number" &&
      metadata.sectionCount !== metadata.sections.length
    ) {
      issues.push({
        ...ctx,
        level: "warning",
        code: "section_count_mismatch",
        message: `metadata.sectionCount (${metadata.sectionCount}) does not match sections.length (${metadata.sections.length})`,
      });
    }

    // ── 7. Stage validation (optional but must be well-formed if present) ──
    if (
      layout.stage &&
      typeof layout.stage === "object" &&
      !Array.isArray(layout.stage)
    ) {
      const stage = layout.stage as StageData;
      const keys = Object.keys(stage);

      // Empty {} is fine (means no stage) — but partial data is suspicious
      if (keys.length > 0 && !stage.bounds) {
        issues.push({
          ...ctx,
          level: "warning",
          code: "stage_missing_bounds",
          message:
            "Stage object exists but has no bounds — stage rectangle won't render",
        });
      }

      if (stage.bounds) {
        const b = stage.bounds;
        const sw = (b.maxX ?? 0) - (b.minX ?? 0);
        const sh = (b.maxY ?? 0) - (b.minY ?? 0);
        if (sw <= 0 || sh <= 0) {
          issues.push({
            ...ctx,
            level: "warning",
            code: "stage_degenerate_bounds",
            message: `Stage bounds have zero or negative dimensions (${sw}×${sh})`,
          });
        }
      }
    }

    // ── 8. Rendering path check ────────────────────────────────────────
    const hasGeometry = metadata.sections.some(
      (s) => s.geometry?.polygons && s.geometry.polygons.length > 0,
    );
    const hasGlyphKey = Boolean(layout.glyphSnapshotKey);
    const hasSeatIds =
      Array.isArray(metadata.seatIds) && metadata.seatIds.length > 0;

    if (!hasGeometry && !hasGlyphKey && hasSeatIds) {
      // This layout has seats but no visual way to show them on the map.
      // The fallback path (simple dots) will fire, which works — but the
      // user won't see individual seats or section shapes.
      issues.push({
        ...ctx,
        level: "warning",
        code: "fallback_render_only",
        message:
          "Layout has seat data but no geometry polygons and no glyph blob. " +
          "SeatMapPicker will render the simple fallback (section dots). " +
          "Section cards with QuantitySteppers will still work.",
      });
    }
  }

  return issues;
}
