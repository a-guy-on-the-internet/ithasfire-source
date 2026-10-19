import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPlaceLayoutInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

const seatSectionSchema = z.object({
  sectionId: z.string(),
  label: z.string(),
  color: z.string().nullable().optional(),
  capacity: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

export const getPlaceLayoutOutputSchema = z.object({
  layout: z.object({
    id: z.string(),
    name: z.string(),
    placeId: z.string().uuid(),
    checksum: z.string(),
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
    updatedAt: z.date(),
    // Null when the creating account has been deleted (creator detached).
    createdByHumanId: z.string().uuid().nullable(),
    glyphBlobUrl: z.string().nullable(),
  }),
});

export type GetPlaceLayoutInput = z.infer<typeof getPlaceLayoutInputSchema>;
export type GetPlaceLayoutOutput = z.infer<typeof getPlaceLayoutOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPlaceLayoutDeps = {
  repos: Pick<Repos, "places" | "placeLayouts" | "placeLayoutBlobs" | "authz">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getPlaceLayout(
  deps: GetPlaceLayoutDeps,
  rawInput: unknown,
): Promise<GetPlaceLayoutOutput> {
  const input = parseInput(getPlaceLayoutInputSchema, rawInput);

  // 1. Verify the place exists
  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // 2. Ownership check: actor must be a direct human owner or a member of an
  //    owning org (mirrors getPlaceForEdit).
  const isDirectHumanOwner = place.humanIdsWithAccess.includes(
    input.actorHumanId,
  );

  let isOrgOwner = false;
  if (!isDirectHumanOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectHumanOwner && !isOrgOwner) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  // 3. Fetch the layout for this place
  const layout = await deps.repos.placeLayouts.getByPlace(input.placeId);
  if (!layout) {
    throw fail("PLACE_LAYOUT_NOT_FOUND");
  }

  // 4. Generate a signed URL for the glyph blob
  let glyphBlobUrl: string | null = null;
  try {
    const urlResult = await deps.repos.placeLayoutBlobs.getGlyphUrl({
      placeId: input.placeId,
      checksum: layout.checksum,
    });
    glyphBlobUrl = urlResult?.url ?? null;
  } catch (error) {
    deps.logger?.warn("place_layout.glyph_url_failed", {
      placeId: input.placeId,
      checksum: layout.checksum,
      error,
    });
    // Non-fatal: layout metadata is still useful without the blob URL
  }

  deps.logger?.info("place_layouts.get", {
    placeId: input.placeId,
    layoutId: layout.id,
    seatCount: layout.seatCount,
    actorHumanId: input.actorHumanId,
  });

  return {
    layout: {
      id: layout.id,
      name: layout.name,
      placeId: layout.placeId,
      checksum: layout.checksum,
      seatCount: layout.seatCount,
      sectionCount: layout.sectionCount,
      seatIndexBounds: layout.seatIndexBounds,
      sections: layout.sections,
      stage: layout.stage ?? null,
      updatedAt: layout.updatedAt,
      createdByHumanId: layout.createdByHumanId,
      glyphBlobUrl,
    },
  } satisfies GetPlaceLayoutOutput;
}
