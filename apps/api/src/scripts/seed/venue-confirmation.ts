import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";
import { slugify } from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation for seeded events (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27 "Confirmation lives on the Event").
//
// Since that spec, a third-party event at a place (owner ≠ a verified place
// owner) blocks nothing and renders address-only until the venue confirms
// it. Left alone, every third-party seed event would make the demo calendar
// look empty and every event page venue-less. So, after every event-creating
// step has run:
//
//   1. `attachThirdPartyDemoEvents` re-points two org2-owned Austin events at
//      the demo org's primary venue (place1, The Paramount Theatre). The
//      save-event path refuses a place the owner has no access to
//      (`ensureLoadedPlaceAccessible`), so the ONLY way the seed can produce a
//      third-party event is this raw patch — the same mechanism
//      `linkEventsToPlaceLayouts` / `backfillEventVenueDefaults` use.
//   2. `stampSeedVenueConfirmations` stamps `venueConfirmedAt` on every
//      third-party event at a place EXCEPT the two named in
//      `UNCONFIRMED_DEMO_EVENT_TITLES`, which stay unconfirmed so QA can see
//      the "unconfirmed" venue-calendar treatment and the address-only public
//      page. Venue-owned events are confirmed by construction and untouched.
//
// Both are idempotent on reseed (`upsertEventWithTickets` recreates
// non-DRAFT events, and the guards below make a second run a no-op).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two seeded events that stay UNCONFIRMED at their venue on purpose
 * (docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md,
 * "Venue calendar" + "Public event page"). Both are tx-aus fixtures owned by
 * org2 (Austin Live Events), PUBLISHED, 20 and 30 days out, and attached to
 * place1 — owned by the demo org, where the dev-login admin is ADMIN — so
 * the admin sees them on the Paramount calendar as unconfirmed and can
 * Confirm / Not mine them.
 */
export const UNCONFIRMED_DEMO_EVENT_TITLES = [
  "Sixth Street Comedy Night",
  "Austin Tech Lecture Series",
] as const;

/** Title → the venue each demo third-party event is attached to. */
export const THIRD_PARTY_DEMO_EVENTS: ReadonlyArray<{
  title: (typeof UNCONFIRMED_DEMO_EVENT_TITLES)[number];
  regionCode: string;
  placeId: string;
}> = UNCONFIRMED_DEMO_EVENT_TITLES.map((title) => ({
  title,
  regionCode: "tx-aus",
  placeId: DEMO_IDS.place1,
}));

/**
 * Attach the demo third-party events to their venue (raw patch — see the
 * module header). Runs BEFORE `backfillEventVenueDefaults` so the events
 * pick up the place's default space + calendar like every other
 * place-linked event. Only touches events not yet pointed at the place.
 */
export const attachThirdPartyDemoEvents = async (prisma: PrismaClient) => {
  let attached = 0;
  for (const demo of THIRD_PARTY_DEMO_EVENTS) {
    const slug = `${demo.regionCode}-${slugify(demo.title)}`;
    const place = await prisma.place.findUnique({
      where: { id: demo.placeId },
      select: {
        id: true,
        address: true,
        city: true,
        region: true,
        postcode: true,
        lat: true,
        lng: true,
      },
    });
    if (!place) continue;
    // The fixtures save both events address-only (`placeId` NULL), and a
    // reseed deletes + recreates them, so NULL is the steady state this has
    // to match. A bare `NOT: { placeId }` compiles to `"placeId" <> $1`, and
    // in Postgres `NULL <> 'x'` is NULL — the row would never match.
    const result = await prisma.event.updateMany({
      where: {
        slug,
        OR: [{ placeId: null }, { placeId: { not: place.id } }],
      },
      data: {
        placeId: place.id,
        addressText: [
          place.address,
          place.city,
          [place.region, place.postcode].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", "),
        locality: place.city,
        lat: place.lat,
        lng: place.lng,
      },
    });
    attached += result.count;
  }
  return attached;
};

type SeedOwnership = {
  placeId: string;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
};

const isVenueOwned = (
  event: { orgId: string | null; humanId: string | null },
  owners: readonly SeedOwnership[],
): boolean =>
  owners.some(
    (o) =>
      (o.ownerType === "ORGANIZATION" && event.orgId !== null && o.ownerId === event.orgId) ||
      (o.ownerType === "HUMAN" && event.humanId !== null && o.ownerId === event.humanId),
  );

/**
 * Stamp every third-party seed event at a place as venue-confirmed, except
 * the `UNCONFIRMED_DEMO_EVENT_TITLES`, which are reset to unconfirmed (so a
 * QA confirm followed by a reseed lands back on the demo state).
 *
 * "Third-party" mirrors `isVenueOwnedEvent` in core: the event's org/human
 * is not among the place's VERIFIED, unrevoked owners. `venueConfirmedBy` is
 * the place's direct human owner when it has one, else null (an org-owned
 * venue has no single human to attribute a seed stamp to).
 */
export const stampSeedVenueConfirmations = async (
  prisma: PrismaClient,
  options: { now?: Date } = {},
) => {
  const now = options.now ?? new Date();
  const unconfirmed = new Set<string>(UNCONFIRMED_DEMO_EVENT_TITLES);

  const events = await prisma.event.findMany({
    where: { placeId: { not: null } },
    select: {
      id: true,
      title: true,
      orgId: true,
      humanId: true,
      placeId: true,
      startsAt: true,
      venueConfirmedAt: true,
      venueConfirmedPlaceId: true,
      venueConfirmationWithdrawnAt: true,
    },
  });
  const placeIds = [...new Set(events.map((e) => e.placeId).filter((p): p is string => !!p))];
  const ownerships = placeIds.length
    ? await prisma.placeOwnership.findMany({
        where: { placeId: { in: placeIds }, verified: true, revokedAt: null },
        select: { placeId: true, ownerType: true, ownerId: true },
      })
    : [];
  const ownersByPlace = new Map<string, SeedOwnership[]>();
  for (const o of ownerships) {
    const list = ownersByPlace.get(o.placeId) ?? [];
    list.push(o);
    ownersByPlace.set(o.placeId, list);
  }

  let thirdParty = 0;
  let stamped = 0;
  let reset = 0;
  for (const event of events) {
    if (!event.placeId) continue;
    const owners = ownersByPlace.get(event.placeId) ?? [];
    if (isVenueOwned(event, owners)) continue;
    thirdParty += 1;

    if (unconfirmed.has(event.title)) {
      if (
        event.venueConfirmedAt !== null ||
        event.venueConfirmedPlaceId !== null ||
        event.venueConfirmationWithdrawnAt !== null
      ) {
        await prisma.event.update({
          where: { id: event.id },
          data: {
            venueConfirmedAt: null,
            venueConfirmedByHumanId: null,
            venueConfirmedPlaceId: null,
            venueConfirmationRequestId: null,
            venueConfirmationWithdrawnAt: null,
            venueConfirmationWithdrawnReason: null,
            venueConfirmedStartsAt: null,
          },
        });
        reset += 1;
      }
      continue;
    }

    // Active stamp already — mirrors core's `hasActiveVenueConfirmationStamp`:
    // stamped, not withdrawn, AND stamped for THIS place. A stamp left over
    // from a different place derives as unconfirmed and must be re-stamped.
    if (
      event.venueConfirmedAt !== null &&
      event.venueConfirmationWithdrawnAt === null &&
      event.venueConfirmedPlaceId === event.placeId
    ) {
      continue;
    }
    const humanOwner =
      owners.find((o) => o.ownerType === "HUMAN")?.ownerId ?? null;
    await prisma.event.update({
      where: { id: event.id },
      data: {
        venueConfirmedAt: now,
        venueConfirmedByHumanId: humanOwner,
        venueConfirmedPlaceId: event.placeId,
        // The seed vouch replaces any earlier request-linked stamp, so the
        // request id is cleared too — mirrors the adapter's confirm write.
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
        // The date the venue vouched for — what the adapter's stamp write
        // records (place-address-withholding N1).
        venueConfirmedStartsAt: event.startsAt,
      },
    });
    stamped += 1;
  }

  return { thirdParty, stamped, reset };
};
