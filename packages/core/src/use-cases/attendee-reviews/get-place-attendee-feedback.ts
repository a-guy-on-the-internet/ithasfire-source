import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  AttendeeReviewRecord,
  AttendeeReviewSource,
} from "@th/ports/repos/attendee-reviews";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  computeExactEventAggregate,
  type AttendeeReviewAggInput,
} from "./aggregation-policy";

// ─────────────────────────────────────────────────────────────────────────────
// getPlaceAttendeeFeedback (venue-rating-block-and-owner-optin FR-006)
//
// OWNER-ONLY private attendee feedback for a Place. Regardless of the publish
// toggle (attendeeReviewsPublic), the venue owner sees ALL attendee feedback:
//   - the EXACT aggregate (no k-suppression delay — organizers see their own
//     numbers, FR-006), split VERIFIED vs COMMUNITY (never merged, FR-010), and
//   - the raw free-text of every review, source-labelled.
//
// Privacy (NFR-003): entries carry NO reviewer identity — no humanId, no
// anonymousName/anonymousEmail. Only source + rating + text + createdAt survive.
// Ownership: direct human owner, or ANY org membership. Deliberately BROADER
// than setPlaceAttendeeReviewsPublic, which is ORG_ADMIN_ROLES — this is a
// read, that is the write. Levelling the read-path bar is a tracked follow-up,
// so do not "restore the mirror" by copying a role filter in here.
// ─────────────────────────────────────────────────────────────────────────────

export const getPlaceAttendeeFeedbackInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export type GetPlaceAttendeeFeedbackInput = z.infer<
  typeof getPlaceAttendeeFeedbackInputSchema
>;

const exactAggregateSchema = z
  .object({
    reviewCount: z.number().int(),
    overallMean: z.number().nullable(),
    soundQualityMean: z.number().nullable(),
    venueComfortMean: z.number().nullable(),
    organizationMean: z.number().nullable(),
    valueForMoneyMean: z.number().nullable(),
    recommendPct: z.number().nullable(),
  })
  .strict();

const sourceSchema = z.enum(["VERIFIED_TICKET", "COMMUNITY"]);

export const getPlaceAttendeeFeedbackOutputSchema = z
  .object({
    /** Exact aggregate over VERIFIED_TICKET rows only (FR-010). */
    verified: exactAggregateSchema,
    /** Exact aggregate over COMMUNITY rows only (FR-010). */
    community: exactAggregateSchema,
    /** Unattributed entries, newest first — NO reviewer identity (NFR-003). */
    entries: z.array(
      z
        .object({
          /**
           * The review row id — NOT reviewer identity (a random uuid). Needed so
           * the owner can flag a specific review via flagPlaceFeedback (FR-014);
           * the flag use case re-checks place ownership + same-place anchoring.
           */
          reviewId: z.string().uuid(),
          source: sourceSchema,
          rating: z.number().int(),
          /** Present only when the reviewer left free text. */
          text: z.string().optional(),
          createdAt: z.date(),
        })
        .strict(),
    ),
  })
  .strict();

export type GetPlaceAttendeeFeedbackOutput = z.infer<
  typeof getPlaceAttendeeFeedbackOutputSchema
>;

export type GetPlaceAttendeeFeedbackDeps = {
  repos: Pick<Repos, "places" | "authz" | "attendeeReviews">;
  logger?: LoggerPort;
};

function toAggInput(r: AttendeeReviewRecord): AttendeeReviewAggInput {
  return {
    reviewerKey: r.humanId ?? r.id,
    source: r.source,
    overallRating: r.overallRating,
    soundQuality: r.soundQuality,
    venueComfort: r.venueComfort,
    organization: r.organization,
    valueForMoney: r.valueForMoney,
  };
}

export async function getPlaceAttendeeFeedback(
  deps: GetPlaceAttendeeFeedbackDeps,
  rawInput: unknown,
): Promise<GetPlaceAttendeeFeedbackOutput> {
  const input = parseInput(getPlaceAttendeeFeedbackInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership: direct human owner, or ANY org membership — no role filter.
  // Deliberately broader than `setPlaceAttendeeReviewsPublic`, which now
  // requires ORG_ADMIN_ROLES; levelling this read-path bar is a tracked
  // follow-up, not an oversight.
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

  const reviews =
    await deps.repos.attendeeReviews.listForPlaceFeedback(input.placeId);

  const bySource = (source: AttendeeReviewSource) =>
    reviews.filter((r) => r.source === source);

  const verified = computeExactEventAggregate(
    bySource("VERIFIED_TICKET").map(toAggInput),
  );
  const community = computeExactEventAggregate(
    bySource("COMMUNITY").map(toAggInput),
  );

  // Rows already newest-first from the repo. Strip every identity field — only
  // source + rating + text + createdAt survive to the owner (FR-006/NFR-003).
  const entries = reviews.map((r) => ({
    reviewId: r.id,
    source: r.source,
    rating: r.overallRating,
    ...(r.text !== null && r.text.length > 0 ? { text: r.text } : {}),
    createdAt: r.createdAt,
  }));

  return { verified, community, entries };
}
