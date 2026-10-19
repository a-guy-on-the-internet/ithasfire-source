import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
  requireOrgMembership,
} from "../../lib/rbac";
import {
  bookingTagColorSchema,
  bookingTagNameSchema,
  bookingTagOutputSchema,
  isTagSlugTakenConflict,
  toBookingTagOutput,
  toBookingTagSlug,
} from "./_shared/booking-tag-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Org booking-tag CRUD (FR-017): org settings → Booking, plus the inline
// type-to-create on a request. Mutations are ORG_EDIT_ROLES on `orgId`;
// listing is membership-any (the inbox that shows the chips is
// membership-any too). Every write carries `orgId` into the adapter's WHERE
// clause — a foreign tag id matches zero rows and reads as NOT_FOUND.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingTagsDeps = {
  repos: Pick<Repos, "tx" | "bookingTags" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── list ─────────────────────────────────────────────────────────────────────

export const listBookingTagsInputSchema = z
  .object({ actorHumanId: z.uuid(), orgId: z.uuid() })
  .strict();

export const listBookingTagsOutputSchema = z
  .object({ tags: z.array(bookingTagOutputSchema) })
  .strict();

export type ListBookingTagsInput = z.infer<typeof listBookingTagsInputSchema>;
export type ListBookingTagsOutput = z.infer<typeof listBookingTagsOutputSchema>;

export async function listBookingTags(
  deps: BookingTagsDeps,
  rawInput: unknown,
): Promise<ListBookingTagsOutput> {
  const input = parseInput(listBookingTagsInputSchema, rawInput);
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ANY_ROLE,
  });
  const tags = await deps.repos.bookingTags.listForOrg(input.orgId);
  return listBookingTagsOutputSchema.parse({ tags: tags.map(toBookingTagOutput) });
}

// ── create ───────────────────────────────────────────────────────────────────

export const createBookingTagInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    name: bookingTagNameSchema,
    color: bookingTagColorSchema.default("neutral"),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const createBookingTagOutputSchema = z
  .object({ tag: bookingTagOutputSchema })
  .strict();

export type CreateBookingTagInput = z.infer<typeof createBookingTagInputSchema>;
export type CreateBookingTagOutput = z.infer<typeof createBookingTagOutputSchema>;

export async function createBookingTag(
  deps: BookingTagsDeps,
  rawInput: unknown,
): Promise<CreateBookingTagOutput> {
  const input = parseInput(createBookingTagInputSchema, rawInput);
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  const slug = toBookingTagSlug(input.name);
  const now = deps.clock.now();

  try {
    const tag = await deps.repos.tx(async (tx) => {
      const created = await tx.bookingTags.create({
        orgId: input.orgId,
        name: input.name,
        slug,
        color: input.color,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      });
      await tx.audit.log({
        entity: "booking_tag",
        entityId: created.id,
        action: "booking_tag.created",
        data: {
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
          name: created.name,
          slug: created.slug,
          color: created.color,
        },
        at: now,
      });
      return created;
    });
    deps.logger?.info("booking_tags.created", {
      tagId: tag.id,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
    });
    return createBookingTagOutputSchema.parse({ tag: toBookingTagOutput(tag) });
  } catch (error) {
    if (isTagSlugTakenConflict(error)) {
      throw fail("BOOKING_TAG_SLUG_TAKEN", { meta: { orgId: input.orgId, slug } });
    }
    throw error;
  }
}

// ── update ───────────────────────────────────────────────────────────────────

export const updateBookingTagInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    tagId: z.uuid(),
    name: bookingTagNameSchema.optional(),
    color: bookingTagColorSchema.optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const updateBookingTagOutputSchema = createBookingTagOutputSchema;

export type UpdateBookingTagInput = z.infer<typeof updateBookingTagInputSchema>;
export type UpdateBookingTagOutput = z.infer<typeof updateBookingTagOutputSchema>;

export async function updateBookingTag(
  deps: BookingTagsDeps,
  rawInput: unknown,
): Promise<UpdateBookingTagOutput> {
  const input = parseInput(updateBookingTagInputSchema, rawInput);
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  const now = deps.clock.now();

  try {
    const tag = await deps.repos.tx(async (tx) => {
      const updated = await tx.bookingTags.update({
        id: input.tagId,
        orgId: input.orgId,
        ...(input.name !== undefined
          ? { name: input.name, slug: toBookingTagSlug(input.name) }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      });
      if (!updated) {
        throw fail("BOOKING_TAG_NOT_FOUND", {
          meta: { tagId: input.tagId, orgId: input.orgId },
        });
      }
      await tx.audit.log({
        entity: "booking_tag",
        entityId: updated.id,
        action: "booking_tag.updated",
        data: {
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
          name: updated.name,
          slug: updated.slug,
          color: updated.color,
          sortOrder: updated.sortOrder,
        },
        at: now,
      });
      return updated;
    });
    return updateBookingTagOutputSchema.parse({ tag: toBookingTagOutput(tag) });
  } catch (error) {
    if (isTagSlugTakenConflict(error)) {
      throw fail("BOOKING_TAG_SLUG_TAKEN", { meta: { orgId: input.orgId, tagId: input.tagId } });
    }
    throw error;
  }
}

// ── delete ───────────────────────────────────────────────────────────────────

export const deleteBookingTagInputSchema = z
  .object({ actorHumanId: z.uuid(), orgId: z.uuid(), tagId: z.uuid() })
  .strict();

export const deleteBookingTagOutputSchema = z
  .object({ tagId: z.uuid(), deleted: z.boolean() })
  .strict();

export type DeleteBookingTagInput = z.infer<typeof deleteBookingTagInputSchema>;
export type DeleteBookingTagOutput = z.infer<typeof deleteBookingTagOutputSchema>;

/** Delete detaches (join rows cascade). Idempotent: a missing tag is `deleted: false`. */
export async function deleteBookingTag(
  deps: BookingTagsDeps,
  rawInput: unknown,
): Promise<DeleteBookingTagOutput> {
  const input = parseInput(deleteBookingTagInputSchema, rawInput);
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  const now = deps.clock.now();

  const deleted = await deps.repos.tx(async (tx) => {
    const removed = await tx.bookingTags.delete({ id: input.tagId, orgId: input.orgId });
    if (removed) {
      await tx.audit.log({
        entity: "booking_tag",
        entityId: input.tagId,
        action: "booking_tag.deleted",
        data: { actorHumanId: input.actorHumanId, orgId: input.orgId },
        at: now,
      });
    }
    return removed;
  });

  return deleteBookingTagOutputSchema.parse({ tagId: input.tagId, deleted });
}
