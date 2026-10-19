import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicPlaceLayoutInputSchema = z
  .object({
    placeLayoutId: z.string().uuid(),
    /** When true, include the signed URL for the glyph blob (individual seat positions). */
    includeGlyphs: z.boolean().optional(),
  })
  .strict();

const seatSectionSchema = z.object({
  sectionId: z.string(),
  label: z.string(),
  color: z.string().nullable().optional(),
  capacity: z.number(),
  geometry: z
    .object({
      polygons: z
        .array(z.array(z.object({ x: z.number(), y: z.number() })))
        .optional(),
      origin: z.object({ x: z.number(), y: z.number() }).optional(),
      rotation: z.number().optional(),
      scale: z.number().optional(),
    })
    .nullable()
    .optional(),
  stageAnchor: z
    .object({
      point: z.object({ x: z.number(), y: z.number() }),
      facingAngle: z.number().optional(),
    })
    .nullable()
    .optional(),
});

const stageLayoutSchema = z.object({
  kind: z.enum(["rectangle", "circle", "polygon", "custom"]),
  label: z.string().nullable().optional(),
  bounds: z.object({
    minX: z.number(),
    minY: z.number(),
    maxX: z.number(),
    maxY: z.number(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const getPublicPlaceLayoutOutputSchema = z.object({
  layout: z.object({
    id: z.string(),
    name: z.string(),
    seatCount: z.number().nonnegative(),
    sectionCount: z.number().nonnegative(),
    seatIndexBounds: z.object({
      minX: z.number(),
      minY: z.number(),
      maxX: z.number(),
      maxY: z.number(),
    }),
    sections: z.array(seatSectionSchema),
    stage: stageLayoutSchema.nullable(),
    /** Signed URL for glyph blob (individual seat positions). Present only when includeGlyphs=true. */
    glyphBlobUrl: z.string().nullable().optional(),
  }),
});

export type GetPublicPlaceLayoutInput = z.infer<
  typeof getPublicPlaceLayoutInputSchema
>;
export type GetPublicPlaceLayoutOutput = z.infer<
  typeof getPublicPlaceLayoutOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPublicPlaceLayoutDeps = {
  repos: Pick<Repos, "placeLayouts" | "placeLayoutBlobs">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public use case to fetch a place layout by its ID.
 *
 * Unlike the admin `getPlaceLayout`, this skips ownership checks and omits
 * sensitive fields (createdByHumanId, checksum, placeId, glyphBlobUrl).
 * Suitable for the public checkout / ticket picker views.
 */
export async function getPublicPlaceLayout(
  deps: GetPublicPlaceLayoutDeps,
  rawInput: unknown,
): Promise<GetPublicPlaceLayoutOutput> {
  const input = parseInput(getPublicPlaceLayoutInputSchema, rawInput);

  const layout = await deps.repos.placeLayouts.getById(input.placeLayoutId);
  if (!layout) {
    throw fail("PLACE_LAYOUT_NOT_FOUND");
  }

  deps.logger?.info("place_layouts.get_public", {
    layoutId: layout.id,
    seatCount: layout.seatCount,
  });

  // Optionally resolve a signed glyph blob URL so the client can render
  // individual seat positions (for assigned-seating sections).
  let glyphBlobUrl: string | null = null;
  if (input.includeGlyphs) {
    try {
      const urlResult = await deps.repos.placeLayoutBlobs.getGlyphUrl({
        placeId: layout.placeId,
        checksum: layout.checksum,
      });
      glyphBlobUrl = urlResult?.url ?? null;
    } catch {
      // Non-fatal: the seat map can still render section polygons without glyphs.
    }
  }

  return {
    layout: {
      id: layout.id,
      name: layout.name,
      seatCount: layout.seatCount,
      sectionCount: layout.sectionCount,
      seatIndexBounds: layout.seatIndexBounds,
      sections: layout.sections.map((section) => ({
        sectionId: section.sectionId,
        label: section.label,
        color: section.color ?? null,
        capacity: section.capacity,
        geometry: section.geometry ?? null,
        stageAnchor: section.stageAnchor ?? null,
      })),
      stage: layout.stage ?? null,
      glyphBlobUrl,
    },
  } satisfies GetPublicPlaceLayoutOutput;
}
