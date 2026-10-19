import { describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";

import { listMyRsvps, listMyRsvpsOutputSchema } from "../list-my-rsvps";

// The my-RSVPs page used to return `event.addressText` with no mode, reveal
// or NEVER check. An RSVP is attendance, so the attendee gets exactly what a
// ticket holder gets (`resolveHolderAddress`).

const ACTOR = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const RSVP_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const HOUR = 60 * 60 * 1000;

/** EXPLICITLY EXACT with no venue — the historical, public shape. */
const exactEvent = (overrides: Record<string, unknown> = {}) =>
  ({
    id: EVENT_ID,
    title: "Community Potluck",
    slug: "community-potluck",
    status: "PUBLISHED",
    attendanceMode: "RSVP",
    startsAt: new Date(Date.now() + 72 * HOUR),
    endsAt: null,
    timezone: "America/Chicago",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    placeId: null,
    addressText: "1114 Fatherland St",
    locality: "Nashville",
    region: "TN",
    heroImageUrl: null,
    heroImageKey: null,
    ...overrides,
  }) as unknown as EventRecord;

const VENUE_ORG = "55555555-5555-4555-8555-555555555555";

/** Owned by VENUE_ORG; accepts community listings venue-wide. */
const withheldPlace = {
  id: PLACE_ID,
  orgIdsWithAccess: [VENUE_ORG],
  humanIdsWithAccess: [],
  acceptsCommunityListings: true,
  name: "The Blue Door House",
  formattedAddress: "901 Porter Rd",
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  lat: 36.1862,
  lng: -86.7291,
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  locationLabel: "East Nashville",
};

function run(event: EventRecord, place: unknown = null) {
  const gate = makeImageModerationGateFake({});
  const getPlace = vi.fn(async () => place);
  const repos = {
    eventRsvps: {
      listForUser: vi.fn(async () => ({
        items: [
          {
            id: RSVP_ID,
            eventId: EVENT_ID,
            humanId: ACTOR,
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
        nextCursor: null,
      })),
    },
    events: { findManyByIds: vi.fn(async () => [event]) },
    places: { getById: getPlace },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;
  return {
    getPlace,
    result: listMyRsvps(
      { repos, logger: createTestLogger() },
      { actorHumanId: ACTOR },
    ),
  };
}

describe("listMyRsvps — address gate", () => {
  it("EXACT: unchanged — the stored street, not locked, no venue read", async () => {
    const { result, getPlace } = run(exactEvent());
    const out = await result;
    const e = out.items[0]!.event;
    expect(e.addressText).toBe("1114 Fatherland St");
    expect(e.addressLocked).toBe(false);
    expect(e.addressRevealAt).toBeNull();
    expect(e.addressNeverShared).toBe(false);
    expect(getPlace).not.toHaveBeenCalled();
    expect(listMyRsvpsOutputSchema.safeParse(out).success).toBe(true);
  });

  it("NEVER: no street, flagged never-shared; the coarse fields remain", async () => {
    const { result } = run(
      exactEvent({
        locationMode: "OBSCURED",
        addressRevealPreset: "NEVER",
        addressRevealAt: null,
      }),
    );
    const e = (await result).items[0]!.event;
    expect(e.addressText).toBeNull();
    expect(e.addressLocked).toBe(true);
    expect(e.addressNeverShared).toBe(true);
    expect(e.addressRevealAt).toBeNull();
    expect([e.locality, e.region]).toEqual(["Nashville", "TN"]);
  });

  it("before the reveal: no street, with the reveal date", async () => {
    const revealAt = new Date(Date.now() + 24 * HOUR);
    const { result } = run(
      exactEvent({
        locationMode: "OBSCURED",
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: revealAt,
      }),
    );
    const e = (await result).items[0]!.event;
    expect(e.addressText).toBeNull();
    expect(e.addressLocked).toBe(true);
    expect(e.addressRevealAt).toEqual(revealAt);
  });

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const { result, getPlace } = run(
      exactEvent({
        // The venue's own show.
        orgId: VENUE_ORG,
        stewardship: "OWNED",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(Date.now() - HOUR),
        // Part 1's storage: the Event row is the venue's public projection.
        addressText: "East Nashville",
      }),
      withheldPlace,
    );
    const e = (await result).items[0]!.event;
    expect(getPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(e.addressText).toBe("901 Porter Rd");
    expect(e.addressLocked).toBe(false);
  });

  it("an EXACT event row at a withheld venue is floored and locked", async () => {
    const { result } = run(exactEvent({ placeId: PLACE_ID }), withheldPlace);
    const e = (await result).items[0]!.event;
    expect(e.addressLocked).toBe(true);
    expect(e.addressText).toBeNull();
  });

  const revealedAtHouse = {
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(Date.now() - HOUR),
    addressText: "East Nashville",
  };

  it("C1: an ownerless community listing at a house that accepts listings: no street, venueUnconfirmed", async () => {
    const { result } = run(
      exactEvent({ ...revealedAtHouse, orgId: null, stewardship: "COMMUNITY" }),
      withheldPlace,
    );
    const out = await result;
    const e = out.items[0]!.event;
    expect(e.addressText).toBeNull();
    expect(e.addressLocked).toBe(true);
    expect(e.addressLockReason).toBe("venueUnconfirmed");
    expect(e.addressRevealAt).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Porter");
    expect(listMyRsvpsOutputSchema.safeParse(out).success).toBe(true);
  });

  it("C1: a stranger's unconfirmed RSVP event at the house: no street", async () => {
    const { result } = run(
      exactEvent({
        ...revealedAtHouse,
        orgId: "66666666-6666-4666-8666-666666666666",
        stewardship: "OWNED",
      }),
      withheldPlace,
    );
    const e = (await result).items[0]!.event;
    expect(e.addressText).toBeNull();
    expect(e.addressLockReason).toBe("venueUnconfirmed");
  });

  it("stamp arm: a confirmed stranger's event waits for startsAt − 24h", async () => {
    const startsAt = new Date(Date.now() + 72 * HOUR);
    const { result } = run(
      exactEvent({
        ...revealedAtHouse,
        orgId: "66666666-6666-4666-8666-666666666666",
        stewardship: "OWNED",
        startsAt,
        venueConfirmedAt: new Date(Date.now() - HOUR),
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: PLACE_ID,
      }),
      withheldPlace,
    );
    const e = (await result).items[0]!.event;
    expect(e.addressText).toBeNull();
    expect(e.addressLockReason).toBe("notYetRevealed");
    expect(e.addressRevealAt).toEqual(new Date(startsAt.getTime() - 24 * HOUR));
  });

  // "Like holders" (owner ruling Q16, 2026-10-17): cancelling an event keeps
  // its RSVP rows, but its ticket holders lose the street, so its RSVP-ers do
  // too. Same rule as the event page (`viewerHoldsLiveRsvp`).
  const obscuredRevealed = {
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE",
    addressRevealAt: new Date(Date.now() - HOUR),
  };

  it("a live OBSCURED event after the reveal: the street", async () => {
    const { result } = run(exactEvent(obscuredRevealed));
    const e = (await result).items[0]!.event;
    expect(e.addressText).toBe("1114 Fatherland St");
    expect(e.addressLocked).toBe(false);
  });

  it("a CANCELLED OBSCURED event after the reveal: no street, notHolder", async () => {
    const { result } = run(
      exactEvent({ ...obscuredRevealed, status: "CANCELLED" }),
    );
    const out = await result;
    const e = out.items[0]!.event;
    expect(e.status).toBe("CANCELLED");
    expect(e.addressText).toBeNull();
    expect(e.addressLocked).toBe(true);
    expect(e.addressLockReason).toBe("notHolder");
    expect(JSON.stringify(out)).not.toContain("Fatherland");
    expect(listMyRsvpsOutputSchema.safeParse(out).success).toBe(true);
  });

  // Archiving keeps the RSVP rows: a cancelled event archived later, or a
  // PUBLISHED listing archived directly (which counts as cancelling it,
  // owner ruling 2026-10-16), must not hand the street back.
  it("an ARCHIVED OBSCURED event after the reveal: no street, notHolder", async () => {
    const { result } = run(
      exactEvent({ ...obscuredRevealed, status: "ARCHIVED" }),
    );
    const out = await result;
    const e = out.items[0]!.event;
    expect(e.status).toBe("ARCHIVED");
    expect(e.addressText).toBeNull();
    expect(e.addressLocked).toBe(true);
    expect(e.addressLockReason).toBe("notHolder");
    expect(JSON.stringify(out)).not.toContain("Fatherland");
    expect(listMyRsvpsOutputSchema.safeParse(out).success).toBe(true);
  });

  it("a CANCELLED event at a withheld venue after the reveal: no Place street", async () => {
    const { result } = run(
      exactEvent({
        orgId: VENUE_ORG,
        stewardship: "OWNED",
        placeId: PLACE_ID,
        ...obscuredRevealed,
        addressText: "East Nashville",
        status: "CANCELLED",
      }),
      withheldPlace,
    );
    const out = await result;
    expect(out.items[0]!.event.addressText).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Porter");
  });
});
