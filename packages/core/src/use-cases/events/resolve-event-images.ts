import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";
import { fail } from "../../lib/errors";
import { fail as appFail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

export const resolveEventImagesInputSchema = z
  .object({
    eventId: z.string().min(1),
    /** Image IDs to resolve (max 50) */
    imageIds: z.array(z.string().min(1)).min(1).max(50),
    /**
     * Strict mode: reject if any ID is missing (for editor).
     * Lenient mode: ignore missing IDs (for public rendering).
     */
    strict: z.boolean().default(false),
  })
  .strict();

export type ResolveEventImagesInput = z.infer<
  typeof resolveEventImagesInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

const resolvedImageSchema = z.object({
  id: z.string().min(1),
  publicUrl: z.string().min(1),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().positive().nullable(),
});

export const resolveEventImagesOutputSchema = z.object({
  images: z.array(resolvedImageSchema),
});

export type ResolveEventImagesOutput = z.infer<
  typeof resolveEventImagesOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveEventImagesDeps = {
  repos: Pick<Repos, "images">;
  logger: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves event image IDs to their public URLs.
 *
 * Used by the editor and public rendering to get image URLs for ProseMirror
 * imageBlock nodes that reference images by imageId.
 *
 * No authorization required - event images are public once uploaded.
 * The eventId is used to verify images belong to the expected event.
 */
export const resolveEventImages = async (
  deps: ResolveEventImagesDeps,
  rawInput: unknown,
): Promise<ResolveEventImagesOutput> => {
  const { repos, logger } = deps;

  // ─── Parse input ───────────────────────────────────────────────────────────
  const parsed = resolveEventImagesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }
  const input = parsed.data;

  // ─── Fetch images ──────────────────────────────────────────────────────────
  const images = await repos.images.resolveByIds(input.imageIds);

  // ─── Validate in strict mode ───────────────────────────────────────────────
  if (input.strict) {
    const foundIds = new Set(images.map((img: { id: string }) => img.id));
    const missingIds = input.imageIds.filter((id: string) => !foundIds.has(id));
    if (missingIds.length > 0) {
      logger.warn("Missing images in strict mode", {
        eventId: input.eventId,
        missingIds,
      });
      return appFail("IMAGE_NOT_FOUND", { meta: { missingIds } });
    }

    // Verify all images belong to the correct event
    const wrongEventImages = images.filter(
      (img: { ownerId: string }) => img.ownerId !== input.eventId,
    );
    if (wrongEventImages.length > 0) {
      logger.warn("Images belong to wrong event", {
        eventId: input.eventId,
        wrongImageIds: wrongEventImages.map((img: { id: string }) => img.id),
      });
      return appFail("IMAGES_WRONG_EVENT");
    }
  }

  // ─── Filter and map results ────────────────────────────────────────────────
  const validImages = images
    // Only include uploaded images from the correct event
    .filter(
      (img: {
        ownerId: string;
        uploadedAt: Date | null;
        deletedAt: Date | null;
      }) => img.ownerId === input.eventId && img.uploadedAt && !img.deletedAt,
    )
    .map(
      (img: {
        id: string;
        publicUrl: string;
        contentType: string | null;
        sizeBytes: bigint | null;
      }) => ({
        id: img.id,
        publicUrl: img.publicUrl,
        contentType: img.contentType,
        sizeBytes: img.sizeBytes ? Number(img.sizeBytes) : null,
      }),
    );

  return { images: validImages };
};
