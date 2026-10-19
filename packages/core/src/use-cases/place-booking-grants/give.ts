import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type {
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
} from "@th/ports/repos/place-booking-grants";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  isGrantLive,
  placeBookingGrantOutputSchema,
  requireGrantManager,
  requirePublicPartyPage,
  sameGrantee,
  toPlaceBookingGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";
import {
  placeBookingGrantNotificationIntentSchema,
  type PlaceBookingGrantNotificationIntent,
} from "./_shared/grant-intents";

// ─────────────────────────────────────────────────────────────────────────────
// givePlaceBookingGrant (holds-without-a-request FR-003, H2 / H4, NFR-002).
//
// The place's direct owner, or an OWNER / ADMIN of an owning org, gives an
// org or a person the right to make events at the place: the whole place or
// one of its calendars, with an optional expiry. The grant is PENDING and
// does nothing until the grantee accepts it (respond.ts).
//
// PICKED BY PUBLIC PAGE (NFR-002): the grantee is named by the id of its
// entity page (an org page or a person page), never by email. A missing,
// PRIVATE or UNLISTED page, or a banned owner's, reads PAGE_NOT_FOUND
// (`requirePublicPartyPage`); a place's page is not an org or a
// person (PLACE_BOOKING_GRANT_GRANTEE_INVALID).
//
// REFUSED GRANTEES (PLACE_BOOKING_GRANT_GRANTEE_INVALID, `meta.reason`):
//   - `place_owner`: an owning org or a direct owner already holds every
//     right a grant gives, and more;
//   - `self`: a grantee the giver would act under (H2). The giver as a
//     person; an org where the giver holds an edit role (OWNER / ADMIN /
//     EDITOR: an OWNER / ADMIN could also accept it alone); a person whose
//     edit-role delegate the giver is. A manager who gives themself booker
//     authority, by any of these routes, keeps it after losing their role,
//     which no other manager asked for. Another manager may give it.
//
// IDEMPOTENT (spec `idempotent: true`): the same grantee already holding a
// pending or active grant with the SAME scope and expiry → that grant is
// returned (`alreadyGiven: true`), nothing is written, no notice goes out and
// the invite cap is not charged. A live grant whose scope OVERLAPS (either is
// the whole place, or both name the same calendar) but differs otherwise →
// PLACE_BOOKING_GRANT_EXISTS with `meta.grantId`: edit that grant instead.
// Two different calendars are two grants.
//
// CONCURRENT GIVES (a double submit): the checks above and the cap read the
// place's grants INSIDE the transaction, after the place's grant-set lock
// (`placeBookingGrants.lockPlace`, an advisory xact lock). The second of two
// racing gives waits on the lock, then reads the first one's row: identical
// → that grant (`alreadyGiven`), overlapping → EXISTS. Never two live grants.
//
// INVITE CAP (NFR-002): 20 grants given per place per rolling 24 hours,
// counted from the place's own grant rows (ended ones included, so give →
// revoke → give spends the budget). RATE_LIMITED past it. A count read under
// the same lock, not the rate-limit port: no Redis dependency and nothing to
// fail open.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_BOOKING_GRANT_INVITES_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export const givePlaceBookingGrantInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
    /** The grantee's public page (an org's or a person's entity page). */
    granteePageId: z.uuid(),
    /** Null / omitted = the whole place. */
    calendarId: z.uuid().nullable().optional(),
    /** Null / omitted = no expiry. Must be in the future. */
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const givePlaceBookingGrantOutputSchema = z
  .object({
    grant: placeBookingGrantOutputSchema,
    /** True = the same grant already stood; nothing was written or sent. */
    alreadyGiven: z.boolean(),
    notificationIntents: z.array(placeBookingGrantNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: the intents stay server-side. */
export const givePlaceBookingGrantWireOutputSchema = z.object(
  givePlaceBookingGrantOutputSchema.omit({ notificationIntents: true }).shape,
);

export type GivePlaceBookingGrantInput = z.infer<
  typeof givePlaceBookingGrantInputSchema
>;
export type GivePlaceBookingGrantOutput = z.infer<
  typeof givePlaceBookingGrantOutputSchema
>;
export type GivePlaceBookingGrantDeps = PlaceBookingGrantDeps;

export async function givePlaceBookingGrant(
  deps: GivePlaceBookingGrantDeps,
  rawInput: unknown,
): Promise<GivePlaceBookingGrantOutput> {
  const input = parseInput(givePlaceBookingGrantInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  // 1. The manager gate FIRST: nothing below is read for a stranger.
  const { place } = await requireGrantManager(
    repos,
    input.placeId,
    input.actorHumanId,
  );

  const calendarId = input.calendarId ?? null;
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    throw fail("EXPIRES_AT_IN_PAST", { meta: { field: "expiresAt" } });
  }
  if (calendarId !== null) {
    const calendar = await repos.calendars.findById(calendarId);
    if (!calendar || calendar.placeId !== place.id) {
      throw fail("CALENDAR_NOT_FOUND", {
        meta: { reason: "grant_calendar_place_mismatch", calendarId },
      });
    }
  }

  // 2. The grantee, by public page.
  const page = await requirePublicPartyPage(repos, input.granteePageId);
  let grantee: PlaceBookingGrantee;
  if (page.ownerType === "ORGANIZATION") {
    grantee = { kind: "org", orgId: page.ownerId };
  } else if (page.ownerType === "HUMAN") {
    grantee = { kind: "person", humanId: page.ownerId };
  } else {
    throw fail("PLACE_BOOKING_GRANT_GRANTEE_INVALID", {
      meta: { reason: "not_org_or_person", pageId: page.id },
    });
  }
  if (
    (grantee.kind === "org" && place.orgIdsWithAccess.includes(grantee.orgId)) ||
    (grantee.kind === "person" &&
      place.humanIdsWithAccess.includes(grantee.humanId))
  ) {
    throw fail("PLACE_BOOKING_GRANT_GRANTEE_INVALID", {
      meta: { reason: "place_owner" },
    });
  }
  if (await givesToSelf(repos, grantee, input.actorHumanId)) {
    throw fail("PLACE_BOOKING_GRANT_GRANTEE_INVALID", {
      meta: { reason: "self" },
    });
  }

  // 3. Under the place's grant-set lock: idempotency, overlap, the cap (one
  //    read of the place's grants), then the write and its audit row.
  const outcome = await repos.tx(
    async (tx): Promise<{ grant: PlaceBookingGrantRecord; already: boolean }> => {
      await tx.placeBookingGrants.lockPlace(place.id);
      const placeGrants = await tx.placeBookingGrants.listForPlace({
        placeId: place.id,
        includeEnded: true,
      });
      const liveForGrantee = placeGrants.filter(
        (g) => sameGrantee(g.grantee, grantee) && isGrantLive(g, now),
      );
      const identical = liveForGrantee.find(
        (g) =>
          g.calendarId === calendarId &&
          (g.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null),
      );
      if (identical) return { grant: identical, already: true };
      const overlapping = liveForGrantee.find(
        (g) =>
          g.calendarId === null ||
          calendarId === null ||
          g.calendarId === calendarId,
      );
      if (overlapping) {
        throw fail("PLACE_BOOKING_GRANT_EXISTS", {
          meta: { grantId: overlapping.id },
        });
      }
      const givenToday = placeGrants.filter(
        (g) => g.createdAt.getTime() > now.getTime() - DAY_MS,
      ).length;
      if (givenToday >= PLACE_BOOKING_GRANT_INVITES_PER_DAY) {
        throw fail("RATE_LIMITED", {
          meta: {
            scope: "place_booking_grant_invites_daily",
            limit: PLACE_BOOKING_GRANT_INVITES_PER_DAY,
          },
        });
      }

      let created;
      try {
        created = await tx.placeBookingGrants.create({
          placeId: place.id,
          calendarId,
          grantee,
          grantedByHumanId: input.actorHumanId,
          expiresAt,
        });
      } catch (error) {
        // The adapter re-checks the calendar against the place.
        if (
          (error as { code?: unknown })?.code === "grant_calendar_place_mismatch"
        ) {
          throw fail("CALENDAR_NOT_FOUND", {
            meta: { reason: "grant_calendar_place_mismatch", calendarId },
          });
        }
        throw error;
      }
      await tx.audit.log({
        entity: "place_booking_grant",
        entityId: created.id,
        action: "place_booking_grant.given",
        data: {
          actorHumanId: input.actorHumanId,
          placeId: place.id,
          calendarId,
          grantee,
          granteePageId: page.id,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        at: now,
      });
      return { grant: created, already: false };
    },
  );

  if (outcome.already) {
    return givePlaceBookingGrantOutputSchema.parse({
      grant: toPlaceBookingGrantOutput(outcome.grant, now),
      alreadyGiven: true,
      notificationIntents: [],
    });
  }
  const grant = outcome.grant;

  const intents: PlaceBookingGrantNotificationIntent[] = [
    {
      kind: "grant.given",
      grantId: grant.id,
      placeId: place.id,
      calendarId: grant.calendarId,
      audience: "grantee",
      grantee: grant.grantee,
    },
  ];

  deps.logger?.info("place_booking_grants.given", {
    grantId: grant.id,
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    granteeKind: grantee.kind,
  });

  return givePlaceBookingGrantOutputSchema.parse({
    grant: toPlaceBookingGrantOutput(grant, now),
    alreadyGiven: false,
    notificationIntents: intents,
  });
}

/**
 * The giver would act under this grant (H2): the giver as the person; an
 * edit-role member of the grantee org; an edit-role delegate of the grantee
 * person. One membership read or one delegation read.
 */
async function givesToSelf(
  repos: Pick<Repos, "authz" | "humanDelegates">,
  grantee: PlaceBookingGrantee,
  actorHumanId: string,
): Promise<boolean> {
  if (grantee.kind === "person") {
    if (grantee.humanId === actorHumanId) return true;
    const principals = await repos.humanDelegates.listPrincipalsForDelegate({
      delegateId: actorHumanId,
      roles: ORG_EDIT_ROLES,
      principalIds: [grantee.humanId],
    });
    return principals.includes(grantee.humanId);
  }
  const memberships = await repos.authz.getOrgMemberships({
    orgIds: [grantee.orgId],
    humanId: actorHumanId,
  });
  return memberships.some(
    (m) => m.orgId === grantee.orgId && ORG_EDIT_ROLES.includes(m.role),
  );
}
