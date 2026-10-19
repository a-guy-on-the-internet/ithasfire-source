import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { PERFORMER_ROLES } from "../../lib/event-human-roles";
import { eventPublicUrl } from "../../lib/public-urls";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

const ITHASFIRE_BASE_URL = "https://ithasfire.com";

export const getPerformerShareLinksInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const getPerformerShareLinksOutputSchema = z.object({
  performers: z.array(
    z.object({
      eventHumanId: z.string().uuid(),
      humanId: z.string().uuid().nullable(),
      name: z.string(),
      role: z.string(),
      /** Null when the event has no slug (no resolvable public page). */
      shareUrl: z.string().nullable(),
    }),
  ),
  /** Null when the event has no slug (no resolvable public page). */
  venueUrl: z.string().nullable(),
});

export type GetPerformerShareLinksInput = z.infer<
  typeof getPerformerShareLinksInputSchema
>;
export type GetPerformerShareLinksOutput = z.infer<
  typeof getPerformerShareLinksOutputSchema
>;

export type GetPerformerShareLinksDeps = {
  repos: Pick<Repos, "events" | "eventHumans" | "humans" | "authz">;
  logger?: LoggerPort;
};

export async function getPerformerShareLinks(
  deps: GetPerformerShareLinksDeps,
  rawInput: unknown,
): Promise<GetPerformerShareLinksOutput> {
  const input = parseInput(getPerformerShareLinksInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  await ensureEventAccessible(deps.repos, event, input.actorHumanId);

  const records = await deps.repos.eventHumans.listByEvent(input.eventId);

  const performers = records.filter((r) =>
    (PERFORMER_ROLES as readonly string[]).includes(r.role),
  );

  // Resolve display names for linked humans in a single bulk query
  const linkedHumanIds = performers
    .map((r) => r.humanId)
    .filter((id): id is string => id !== null);

  const humanNames = new Map<string, string>();
  if (linkedHumanIds.length > 0) {
    const humans = await deps.repos.humans.getByIds(linkedHumanIds);
    for (const human of humans) {
      if (human.name) {
        humanNames.set(human.id, human.name);
      }
    }
  }

  // HAS EVER BEEN LIVE + has a slug.
  //
  // Slug-based only: the public event route resolves by slug / slug history,
  // so the old `?? event.id` fallback produced share links that 404'd for every
  // performer on a slugless (unpublished) event. Null → no share links rather
  // than a set of dead ones.
  //
  // The `publishedAt` check is what KEEPS that behaviour now that events are
  // slugged at CREATE. "Has a slug" used to be a reliable proxy for "has been
  // announced"; it no longer is, and leaving the check on slug-presence alone
  // would have silently started handing every performer a live `?ref=` URL for
  // an unannounced draft — a leak dressed up as a feature, and not a decision
  // anyone made.
  //
  // `publishedAt !== null` rather than `status === "PUBLISHED"`, deliberately.
  // The status form also strips links from CANCELLED, COMPLETED and ARCHIVED
  // events, which have slugs and always had links — a performer chasing their
  // `?ref=` attribution the week after the gig would get nothing. It would
  // also quietly override `lib/public-urls.ts`'s "STATUS IS DELIBERATELY NOT A
  // CONDITION" rule for this one caller. `publishedAt` is the field that
  // actually answers the question being asked ("was this ever public?"), it is
  // never cleared once set (`unpublish` preserves it on purpose), and it is
  // the same signal the publish-time slug re-derive keys off.
  const venueUrl =
    event.publishedAt !== null
      ? eventPublicUrl({
          baseUrl: ITHASFIRE_BASE_URL,
          slug: event.slug,
        })
      : null;

  const result = {
    performers: performers.map((r) => {
      const resolvedName =
        (r.humanId && humanNames.get(r.humanId)) || r.externalName || "Unknown";

      return {
        eventHumanId: r.id,
        humanId: r.humanId,
        name: resolvedName,
        role: r.role,
        shareUrl: venueUrl ? `${venueUrl}?ref=${r.id}` : null,
      };
    }),
    venueUrl,
  };

  return getPerformerShareLinksOutputSchema.parse(result);
}

/**
 * DELIBERATELY NOT OPENED TO COMMUNITY MODERATORS, unlike every other
 * event-humans use case (list / attach / detach / reorder all grew a
 * `COMMUNITY` + `COMMUNITY_MODERATION_ROLES` arm via
 * `ensureOwnerOrCommunityModerator`). This one stays a flat
 * `NOT_RESOURCE_OWNER` for an ownerless row, and the asymmetry is the point.
 *
 * Performer share links are a TICKET-SALES attribution affordance, not a
 * lineup-editing one: the `?ref=<eventHumanId>` they mint is read back by
 * `ArtistAttributionPicker` in the CHECKOUT flow, so an organizer can credit
 * (and split money with) the performer who drove a sale. A COMMUNITY listing
 * is ownerless and `attendanceMode = "RSVP"` — no ticket types, no checkout,
 * no order to attribute, no payee to split to. Opening this for symmetry
 * would hand moderators a panel of URLs that credit nobody for nothing, which
 * is worse than not having it: it advertises revenue attribution on a listing
 * that can never earn any.
 *
 * The frontend hides the share-links panel in community mode rather than
 * rendering an error. If community listings ever gain checkout, revisit this
 * together with `events.inviteLineupHumanToRegister` (the Stripe-Connect
 * payout-line invite in the same editor), which is refused for the same
 * reason and was likewise left alone.
 */
async function ensureEventAccessible(
  repos: Pick<Repos, "authz">,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(
      repos.authz,
      event.humanId,
      actorHumanId,
    );
  }
}
