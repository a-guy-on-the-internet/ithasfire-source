import { describe, expect, it, vi } from "vitest";

import { DEMO_IDS } from "../src/scripts/seed/ids";
import {
  UNCONFIRMED_DEMO_EVENT_TITLES,
  attachThirdPartyDemoEvents,
  stampSeedVenueConfirmations,
} from "../src/scripts/seed/venue-confirmation";

/**
 * Seed-side venue confirmation (docs/specs/2026-08-27, seed alignment).
 *
 * Pins the three things the demo depends on:
 *   - a third-party event (owner not among the place's verified owners)
 *     gets stamped; a venue-owned one is left alone;
 *   - the two UNCONFIRMED_DEMO_EVENT_TITLES are never stamped, and are
 *     RESET if a QA confirm left a stamp behind;
 *   - the stamp is idempotent (an active stamp is not re-written) and
 *     `venueConfirmedBy` is the place's direct human owner or null.
 */

const PLACE_ORG = "00000000-0000-4000-8000-0000000000a1";
const PLACE_HUMAN = "00000000-0000-4000-8000-0000000000a2";
const ORG_A = "00000000-0000-4000-8000-0000000000b1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const HUMAN_OWNER = "00000000-0000-4000-8000-0000000000c1";
const NOW = new Date("2026-09-02T12:00:00.000Z");

type EventRow = {
  id: string;
  title: string;
  orgId: string | null;
  humanId: string | null;
  placeId: string | null;
  venueConfirmedAt: Date | null;
  venueConfirmedPlaceId: string | null;
  venueConfirmationWithdrawnAt: Date | null;
};

const row = (overrides: Partial<EventRow> & { id: string }): EventRow => ({
  title: `Event ${overrides.id}`,
  orgId: ORG_B,
  humanId: null,
  placeId: PLACE_ORG,
  venueConfirmedAt: null,
  venueConfirmedPlaceId: null,
  venueConfirmationWithdrawnAt: null,
  ...overrides,
});

const makePrisma = (events: EventRow[]) => {
  const update = vi.fn(async () => ({}));
  const prisma = {
    event: {
      findMany: vi.fn(async () => events),
      update,
    },
    placeOwnership: {
      findMany: vi.fn(async () => [
        { placeId: PLACE_ORG, ownerType: "ORGANIZATION", ownerId: ORG_A },
        { placeId: PLACE_HUMAN, ownerType: "HUMAN", ownerId: HUMAN_OWNER },
      ]),
    },
  };
  return { prisma: prisma as any, update };
};

describe("stampSeedVenueConfirmations", () => {
  it("stamps third-party events and leaves venue-owned ones alone", async () => {
    const { prisma, update } = makePrisma([
      row({ id: "third-party", orgId: ORG_B }),
      row({ id: "venue-owned", orgId: ORG_A }),
      row({ id: "human-owned", orgId: null, humanId: HUMAN_OWNER, placeId: PLACE_HUMAN }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result).toEqual({ thirdParty: 1, stamped: 1, reset: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "third-party" },
      data: {
        venueConfirmedAt: NOW,
        venueConfirmedByHumanId: null,
        // The derivation requires the stamp to name THIS place.
        venueConfirmedPlaceId: PLACE_ORG,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      },
    });
    expect(prisma.placeOwnership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ verified: true, revokedAt: null }),
      }),
    );
  });

  it("attributes the stamp to the place's direct human owner when it has one", async () => {
    const { prisma, update } = makePrisma([
      row({ id: "at-human-venue", orgId: ORG_B, placeId: PLACE_HUMAN }),
    ]);

    await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueConfirmedByHumanId: HUMAN_OWNER }),
      }),
    );
  });

  it("never stamps the unconfirmed demo events, and resets a stray stamp on them", async () => {
    const [comedy, lecture] = UNCONFIRMED_DEMO_EVENT_TITLES;
    const { prisma, update } = makePrisma([
      row({ id: "demo-clean", title: comedy }),
      row({
        id: "demo-stamped",
        title: lecture,
        venueConfirmedAt: NOW,
        venueConfirmedPlaceId: PLACE_ORG,
      }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result).toEqual({ thirdParty: 2, stamped: 0, reset: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "demo-stamped" },
      data: {
        venueConfirmedAt: null,
        venueConfirmedByHumanId: null,
        venueConfirmedPlaceId: null,
        // Cleared with the stamp: the confirmed date only means anything
        // while a stamp is active (venue-track-record / N1).
        venueConfirmedStartsAt: null,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      },
    });
  });

  it("is idempotent: an active stamp for THIS place is not re-written, a withdrawn one is re-stamped", async () => {
    const { prisma, update } = makePrisma([
      row({
        id: "already",
        venueConfirmedAt: new Date("2026-08-01T00:00:00Z"),
        venueConfirmedPlaceId: PLACE_ORG,
      }),
      row({
        id: "withdrawn",
        venueConfirmedAt: new Date("2026-08-01T00:00:00Z"),
        venueConfirmedPlaceId: PLACE_ORG,
        venueConfirmationWithdrawnAt: new Date("2026-08-02T00:00:00Z"),
      }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result).toEqual({ thirdParty: 2, stamped: 1, reset: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ where: { id: "withdrawn" } });
  });

  it("re-stamps an event whose stamp names ANOTHER place (the derivation reads it as unconfirmed)", async () => {
    const { prisma, update } = makePrisma([
      row({
        id: "moved",
        placeId: PLACE_ORG,
        venueConfirmedAt: new Date("2026-08-01T00:00:00Z"),
        venueConfirmedPlaceId: PLACE_HUMAN,
      }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result).toEqual({ thirdParty: 1, stamped: 1, reset: 0 });
    expect(update).toHaveBeenCalledWith({
      where: { id: "moved" },
      data: {
        venueConfirmedAt: NOW,
        venueConfirmedByHumanId: null,
        venueConfirmedPlaceId: PLACE_ORG,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      },
    });
  });

  it("resets a demo event whose only stray field is venueConfirmedPlaceId", async () => {
    const [comedy] = UNCONFIRMED_DEMO_EVENT_TITLES;
    const { prisma, update } = makePrisma([
      row({ id: "demo-place-only", title: comedy, venueConfirmedPlaceId: PLACE_ORG }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result).toEqual({ thirdParty: 1, stamped: 0, reset: 1 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("treats an event at an unclaimed place (no verified owner) as third-party", async () => {
    const { prisma, update } = makePrisma([
      row({ id: "unclaimed", placeId: "00000000-0000-4000-8000-0000000000ff" }),
    ]);

    const result = await stampSeedVenueConfirmations(prisma, { now: NOW });

    expect(result.stamped).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("attachThirdPartyDemoEvents", () => {
  it("re-points the two demo events at place1 by fixture slug with the place's address", async () => {
    const place = {
      id: DEMO_IDS.place1,
      address: "713 Congress Ave",
      city: "Austin",
      region: "TX",
      postcode: "78701",
      lat: 30.2687,
      lng: -97.7426,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      place: { findUnique: vi.fn(async () => place) },
      event: { updateMany },
    } as any;

    const attached = await attachThirdPartyDemoEvents(prisma);

    expect(attached).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The fixtures save these address-only (placeId NULL) and a reseed
    // recreates them NULL, so the guard must match NULL as well as "another
    // place" — a bare `NOT: { placeId }` is NULL-blind in Postgres.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        slug: "tx-aus-sixth-street-comedy-night",
        OR: [{ placeId: null }, { placeId: { not: DEMO_IDS.place1 } }],
      },
      data: {
        placeId: DEMO_IDS.place1,
        addressText: "713 Congress Ave, Austin, TX 78701",
        locality: "Austin",
        lat: 30.2687,
        lng: -97.7426,
      },
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: "tx-aus-austin-tech-lecture-series",
          OR: [{ placeId: null }, { placeId: { not: DEMO_IDS.place1 } }],
        },
      }),
    );
  });

  it("omits the region/postcode segment cleanly when the place has neither", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      place: {
        findUnique: vi.fn(async () => ({
          id: DEMO_IDS.place1,
          address: "713 Congress Ave",
          city: "Austin",
          region: null,
          postcode: null,
          lat: 30.2687,
          lng: -97.7426,
        })),
      },
      event: { updateMany },
    } as any;

    await attachThirdPartyDemoEvents(prisma);

    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      data: { addressText: "713 Congress Ave, Austin" },
    });
  });

  it("is a no-op when the place is missing", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      place: { findUnique: vi.fn(async () => null) },
      event: { updateMany },
    } as any;

    expect(await attachThirdPartyDemoEvents(prisma)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
