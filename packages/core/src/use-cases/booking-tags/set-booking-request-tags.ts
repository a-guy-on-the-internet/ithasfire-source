import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { SetBookingRequestTagsInput as SetForRequestRepoInput } from "@th/ports/repos/booking-tags";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  bookingTagOutputSchema,
  resolveRequestTagOrg,
  toBookingTagOutput,
} from "./_shared/booking-tag-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// setBookingRequestTags (FR-017): replace-all attach on a TO_VENUE request.
//
// Two org checks, deliberately redundant: this use case verifies the
// request → place → owning org relation and that every tag id is one of that
// org's tags (BOOKING_TAG_NOT_FOUND otherwise); the adapter re-verifies the
// tag ↔ org relation against the `orgId` it is handed and refuses with
// `booking_tag_foreign_org`. The join table has no org column, so the second
// check is what keeps a bug here from ever attaching org A's label to org
// B's request.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_BOOKING_REQUEST_TAGS = 20;

export const setBookingRequestTagsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    tagIds: z.array(z.uuid()).max(MAX_BOOKING_REQUEST_TAGS),
  })
  .strict();

export const setBookingRequestTagsOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    tags: z.array(bookingTagOutputSchema),
  })
  .strict();

export type SetBookingRequestTagsInput = z.infer<typeof setBookingRequestTagsInputSchema>;
export type SetBookingRequestTagsOutput = z.infer<typeof setBookingRequestTagsOutputSchema>;

export type SetBookingRequestTagsDeps = {
  repos: Pick<Repos, "tx" | "bookingTags" | "bookingRequests" | "places" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function setBookingRequestTags(
  deps: SetBookingRequestTagsDeps,
  rawInput: unknown,
): Promise<SetBookingRequestTagsOutput> {
  const input = parseInput(setBookingRequestTagsInputSchema, rawInput);
  const now = deps.clock.now();
  const tagIds = [...new Set(input.tagIds)];

  const request = await deps.repos.bookingRequests.getById(input.bookingRequestId);
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  if (request.direction !== "TO_VENUE") {
    throw fail("BOOKING_HOLDS_VENUE_ONLY", {
      meta: { bookingRequestId: request.id, direction: request.direction },
    });
  }
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Edit-role gate + the org whose tags apply (null for a human-owned venue).
  const orgId = await resolveRequestTagOrg(deps.repos, place, input.actorHumanId);
  if (!orgId) {
    if (tagIds.length === 0) {
      return setBookingRequestTagsOutputSchema.parse({
        bookingRequestId: request.id,
        tags: [],
      });
    }
    throw fail("BOOKING_TAG_NOT_FOUND", {
      meta: { bookingRequestId: request.id, reason: "venue_has_no_org" },
    });
  }

  // Every requested id must be one of the owning org's tags.
  const orgTags = await deps.repos.bookingTags.listForOrg(orgId);
  const known = new Set(orgTags.map((t) => t.id));
  const foreign = tagIds.filter((id) => !known.has(id));
  if (foreign.length > 0) {
    throw fail("BOOKING_TAG_NOT_FOUND", {
      meta: { bookingRequestId: request.id, orgId, tagIds: foreign },
    });
  }

  const tags = await deps.repos.tx(async (tx) => {
    const repoInput: SetForRequestRepoInput = {
      bookingRequestId: request.id,
      orgId,
      tagIds,
    };
    const attached = await tx.bookingTags.setForRequest(repoInput);
    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.tags_set",
      data: { actorHumanId: input.actorHumanId, orgId, tagIds },
      at: now,
    });
    return attached;
  });

  deps.logger?.info("booking_requests.tags_set", {
    bookingRequestId: request.id,
    orgId,
    tagCount: tagIds.length,
    actorHumanId: input.actorHumanId,
  });

  return setBookingRequestTagsOutputSchema.parse({
    bookingRequestId: request.id,
    tags: tags.map(toBookingTagOutput),
  });
}
