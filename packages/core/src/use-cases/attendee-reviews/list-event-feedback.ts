import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { computeExactEventAggregate } from "./aggregation-policy";

// ---------------------------------------------------------------------------
// listEventFeedback (attendee-reviews FR-007, FR-002)
//
// The OWNER-scoped private feedback read behind the admin event "Attendee
// feedback" tab. Returns:
//   - the organizer's OWN EXACT aggregate (NO k-gate internally — organizers
//     may see their own precise numbers, FR-007), and
//   - the UNATTRIBUTED comment list, newest first.
//
// Privacy invariants (FR-002, BLOCKING): the text list carries NO humanId, NO
// name, NO per-review rating, and NO timestamp (batch-by-event only — a
// timestamp re-introduces the correlation this strips; risk section). Only a
// `reviewId` (opaque; needed for the report action) rides along. Hidden reviews
// are excluded from both the aggregate and the list.
//
// Authz: the event owner's EDIT roles (org-owned → ORG_EDIT_ROLES; human-owned
// → the owner themselves), mirroring other owner-scoped event reads.
// ---------------------------------------------------------------------------

export const listEventFeedbackInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export type ListEventFeedbackInput = z.infer<
  typeof listEventFeedbackInputSchema
>;

export const listEventFeedbackOutputSchema = z
  .object({
    /** Exact (unbucketed) aggregate for the owner's own event (FR-007). */
    aggregate: z
      .object({
        reviewCount: z.number().int(),
        overallMean: z.number().nullable(),
        soundQualityMean: z.number().nullable(),
        venueComfortMean: z.number().nullable(),
        organizationMean: z.number().nullable(),
        valueForMoneyMean: z.number().nullable(),
        recommendPct: z.number().nullable(),
      })
      .strict(),
    /** Unattributed comments, newest first. No identity, rating, or timestamp. */
    feedback: z.array(
      z
        .object({
          /** Opaque id for the report-abuse action only — leaks no identity. */
          reviewId: z.string().uuid(),
          text: z.string(),
          /** Whether this comment has already been reported to staff. */
          flagged: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListEventFeedbackOutput = z.infer<
  typeof listEventFeedbackOutputSchema
>;

export type ListEventFeedbackDeps = {
  repos: Pick<Repos, "events" | "attendeeReviews" | "authz">;
  logger?: LoggerPort;
};

export async function listEventFeedback(
  deps: ListEventFeedbackDeps,
  rawInput: unknown,
): Promise<ListEventFeedbackOutput> {
  const input = parseInput(listEventFeedbackInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Authorize the event owner (org EDIT roles, or the human owner themselves).
  // Org events win over a direct human owner (canonical owned shape).
  if (event.orgId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "ORGANIZATION",
      ownerId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else if (event.humanId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "HUMAN",
      ownerId: event.humanId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else {
    // No resolvable owner — nobody is authorized to read private feedback.
    throw fail("NOT_RESOURCE_OWNER");
  }

  const reviews = await deps.repos.attendeeReviews.listForEventFeedback(
    input.eventId,
  );

  const aggregate = computeExactEventAggregate(
    reviews.map((r) => ({
      reviewerKey: r.humanId ?? r.id,
      overallRating: r.overallRating,
      soundQuality: r.soundQuality,
      venueComfort: r.venueComfort,
      organization: r.organization,
      valueForMoney: r.valueForMoney,
    })),
  );

  // Rows already ordered newest-first by the repo; drop the timestamp and every
  // identity/rating field — only text + reportability survive to the organizer.
  const feedback = reviews
    .filter((r): r is typeof r & { text: string } => r.text !== null && r.text.length > 0)
    .map((r) => ({
      reviewId: r.id,
      text: r.text,
      flagged: r.flagged,
    }));

  return { aggregate, feedback };
}
