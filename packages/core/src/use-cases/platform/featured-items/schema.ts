import { z } from "zod";

export const featuredItemTypeSchema = z.enum([
  "EVENT",
  "HUMAN",
  "ORGANIZATION",
  "PLACE",
]);
export const internalPathSchema = z
  .string()
  .max(2048)
  .refine((value) => /^\/(?!\/)/.test(value), {
    message: "Must be an internal path",
  });

export const featuredItemRecordSchema = z
  .object({
    id: z.string().uuid(),
    itemType: featuredItemTypeSchema,
    itemId: z.string().uuid(),
    title: z.string().nullable(),
    subtitle: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    ctaUrl: z.string().nullable(),
    ctaLabel: z.string().nullable(),
    sortOrder: z.number().int(),
    active: z.boolean(),
    curatedByHumanId: z.string().uuid().nullable(),
    curatedAt: z.date(),
    curatedUntil: z.date().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

export const publicFeaturedItemSchema = z
  .object({
    id: z.string().uuid(),
    itemType: featuredItemTypeSchema,
    /**
     * The featured TARGET's id — the event, human, organization or place —
     * as opposed to `id`, which is the curation row.
     *
     * Exposed so a surface can render the curated target with its own
     * component instead of the carousel's generic slide: the home grid needs
     * it to nominate which of its cards becomes the feature poster, and
     * matching on a CTA path would be guessing.
     *
     * It leaks nothing: `listFeaturedItems` already filters to targets that
     * are PUBLISHED/PUBLIC, and `ctaUrl` links straight to them.
     */
    itemId: z.string().uuid(),
    title: z.string().nullable(),
    subtitle: z.string().nullable(),
    heroImageUrl: internalPathSchema.nullable(),
    ctaUrl: internalPathSchema.nullable(),
    ctaLabel: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .strict();

export type PublicFeaturedItem = z.infer<typeof publicFeaturedItemSchema>;
