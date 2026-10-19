import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import { toPlaceLocationSource } from "../../../lib/location/project-public-event-location";
import {
  resolveHolderAddress,
  STAMP_ARM_REVEAL_LEAD_MS,
} from "../../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../../lib/venue-confirmation";
import { buildPlaceRecord } from "../../booking-requests/__tests__/helpers";
import { OWN_WITHHELD_PLACE_RADIUS_M } from "../_shared/own-withheld-place-guard";
import { saveEventForHuman } from "../save-event-for-human";
import { saveEventForOrg } from "../save-event-for-org";

// ─────────────────────────────────────────────────────────────────────────────
// Place address withholding — the save-time rules (2026-09-25 final round).
//
// W1  Sarah owns her house PERSONALLY and runs its shows under her org. The
//     owner arm only matches the event's own org / human, so her org's shows
//     read as a stranger's and their holders stayed locked. A save by someone
//     who can MANAGE the place (`canManagePlace`) now stamps the venue
//     confirmation — the stamp arm, with its day-before floor.
// N1  The stamp records the start the venue vouched for; a grant-holder /
//     manager moving the show re-vouches, a third party moving it EARLIER
//     does not (and the move is recorded on the booking request the
//     confirmation came from).
// N2  A freeform / saved address that is the saver's OWN withheld place is
//     refused, so one house never draws two circles.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-25T12:00:00.000Z");
/** Sarah's own human id is the actor throughout. */
const SARAH = DEFAULT_ACTOR_ID;
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** The house: withheld, owned by Sarah personally (NOT by her org). */
function sarahsHouse(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return buildPlaceRecord({
    id: DEFAULT_PLACE_ID,
    name: "Sarah's House",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [SARAH],
    ...overrides,
  });
}

function orgInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: SARAH,
    orgId: DEFAULT_ORG_ID,
    title: "Basement Show",
    startsAt: "2026-10-10T01:00:00.000Z",
    endsAt: "2026-10-10T04:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
    addressRevealPreset: "IMMEDIATELY",
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

function existingStamped(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Basement Show",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
    locationLabel: null,
    addressRevealAt: NOW,
    addressRevealPreset: "IMMEDIATELY",
    timezone: "America/Chicago",
    startsAt: new Date("2026-12-10T01:00:00.000Z"),
    endsAt: new Date("2026-12-10T04:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    spaceId: null,
    calendarId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: "Nashville, TN",
    countryCode: "US",
    region: "TN",
    locality: "Nashville",
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "CLOSED",
    // Stamped by the venue for the December date, through a booking request.
    venueConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
    venueConfirmedByHumanId: "venue-staff",
    venueConfirmedPlaceId: DEFAULT_PLACE_ID,
    venueConfirmationRequestId: REQUEST_ID,
    venueConfirmationWithdrawnAt: null,
    venueConfirmationWithdrawnReason: null,
    venueConfirmedStartsAt: new Date("2026-12-10T01:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

describe("W1 — a save by someone who MANAGES the place stamps the venue confirmation", () => {
  it("Sarah's ORG show at her PERSONALLY owned house: stamped, arm = stamp, holders unlock at max(event reveal, confirmed start − 24h)", async () => {
    const place = sarahsHouse();
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place,
      canManagePlace: ({ actorHumanId, placeId }) =>
        actorHumanId === SARAH && placeId === DEFAULT_PLACE_ID,
    });
    const bookingRequests = ctx.deps.repos.bookingRequests as unknown as {
      create: ReturnType<typeof vi.fn>;
    };

    const result = await saveEventForOrg(ctx.deps, orgInput());

    expect(ctx.mocks.authzPort.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: SARAH,
      placeId: DEFAULT_PLACE_ID,
    });
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledWith({
      eventId: result.eventId,
      placeId: DEFAULT_PLACE_ID,
      confirmedByHumanId: SARAH,
      bookingRequestId: null,
      at: NOW,
    });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "event.place_confirmed_by_manager",
      }),
    );
    // A manager stamp rides no grant.
    const managerAudit = ctx.mocks.audit.log.mock.calls
      .map((c: unknown[]) => c[0] as { action: string; data: Record<string, unknown> })
      .find((e) => e.action === "event.place_confirmed_by_manager");
    expect(managerAudit?.data).not.toHaveProperty("grantId");
    // The venue does not ask itself.
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequest).toBeNull();

    // The stamped row: the stamp arm holds and the confirmed start is the
    // saved start (N1).
    const row = (await ctx.mocks.events.getById(result.eventId))!;
    expect(row.venueConfirmedStartsAt).toEqual(row.startsAt);
    const arm = venueConfirmationArm(row, place);
    expect(arm).toBe("stamp");

    // Holders: IMMEDIATELY reveal, but the stamp arm floors it at
    // `max(startsAt, venueConfirmedStartsAt) − 24h`.
    const floor = new Date(row.startsAt.getTime() - STAMP_ARM_REVEAL_LEAD_MS);
    const holder = (now: Date) =>
      resolveHolderAddress({
        event: row,
        place: toPlaceLocationSource(place),
        venueConfirmationArm: arm,
        activeHolder: true,
        now,
      });
    expect(holder(new Date(floor.getTime() - 1))).toMatchObject({
      locked: true,
      reason: "notYetRevealed",
      revealAt: floor,
    });
    expect(holder(floor)).toMatchObject({
      locked: false,
      source: "PLACE",
      addressText: "901 Porter Rd",
    });
  });

  it("the same org show saved by someone who does NOT manage the place: not stamped, third party as before", async () => {
    const place = sarahsHouse();
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place,
      // Default: manages nothing.
    });

    const result = await saveEventForOrg(ctx.deps, orgInput());

    expect(ctx.mocks.authzPort.canManagePlace).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    const row = (await ctx.mocks.events.getById(result.eventId))!;
    expect(venueConfirmationArm(row, place)).toBeNull();
    const holderAddress = resolveHolderAddress({
      event: row,
      place: toPlaceLocationSource(place),
      venueConfirmationArm: venueConfirmationArm(row, place),
      activeHolder: true,
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(holderAddress).toMatchObject({
      locked: true,
      reason: "venueUnconfirmed",
    });
  });

  it("a VENUE-OWNED event (owner arm) is never stamped, even by a manager", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse({ orgIdsWithAccess: [DEFAULT_ORG_ID] }),
      canManagePlace: () => true,
    });

    await saveEventForOrg(ctx.deps, orgInput());

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("the manager probe runs BEFORE the save's transaction opens (never on a second connection mid-tx)", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse(),
      canManagePlace: () => true,
    });
    const order: string[] = [];
    vi.mocked(ctx.mocks.authzPort.canManagePlace).mockImplementation(async () => {
      order.push("probe");
      return { allowed: true };
    });
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = (async (fn: never) => {
      order.push("tx:open");
      return (originalTx as (f: never) => Promise<unknown>)(fn);
    }) as typeof ctx.deps.repos.tx;

    await saveEventForOrg(ctx.deps, orgInput());

    expect(order.indexOf("probe")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("probe")).toBeLessThan(order.indexOf("tx:open"));
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a manager's unrelated edit does NOT undo a deliberate withdrawal (and asks the venue nothing)", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse(),
      existingEvent: existingStamped({
        venueConfirmationWithdrawnAt: new Date("2026-09-20T00:00:00.000Z"),
        venueConfirmationWithdrawnReason: "not ours",
        venueConfirmedStartsAt: null,
      }),
      canManagePlace: () => true,
    });
    const bookingRequests = ctx.deps.repos.bookingRequests as unknown as {
      create: ReturnType<typeof vi.fn>;
    };
    // An accepting calendar, so a THIRD-PARTY save here would ask the venue.
    const SPACE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
    ctx.mocks.spaces.seed({ id: SPACE_ID, placeId: DEFAULT_PLACE_ID, name: "Main Room" });
    ctx.mocks.calendars.seedCalendar({ id: CALENDAR_ID, placeId: DEFAULT_PLACE_ID, isDefault: true });
    ctx.mocks.calendars.joins.set(CALENDAR_ID, [SPACE_ID]);
    ctx.mocks.calendars.seedAvailability({
      placeId: DEFAULT_PLACE_ID,
      date: new Date("2030-01-01T00:00:00.000Z"),
      isOpen: false,
    });
    vi.mocked(ctx.deps.repos.performerProfiles.getByOwner).mockResolvedValue({
      enabledAt: new Date("2026-01-01T00:00:00.000Z"),
      disabledAt: null,
    } as never);

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        title: "Renamed",
        startsAt: "2026-12-10T01:00:00.000Z",
        endsAt: "2026-12-10T04:00:00.000Z",
        calendarId: CALENDAR_ID,
      }),
    );

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    expect(bookingRequests.create).not.toHaveBeenCalled();
  });

  it("a manager MOVING an already-stamped show re-vouches for the new date; an unchanged re-save writes nothing", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse(),
      existingEvent: existingStamped(),
      canManagePlace: () => true,
    });

    // Unchanged start: the stamp is current, nothing is written.
    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        startsAt: "2026-12-10T01:00:00.000Z",
        endsAt: "2026-12-10T04:00:00.000Z",
      }),
    );
    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();

    // Moved a week earlier by the venue itself: re-stamped, the booking
    // request provenance kept.
    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        startsAt: "2026-12-03T01:00:00.000Z",
        endsAt: "2026-12-03T04:00:00.000Z",
      }),
    );
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedByHumanId: SARAH,
        bookingRequestId: REQUEST_ID,
      }),
    );
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.venueConfirmedStartsAt).toEqual(
      new Date("2026-12-03T01:00:00.000Z"),
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event.place_confirmed_by_manager",
        data: expect.objectContaining({ restamp: true }),
      }),
    );
  });
});

describe("N1 — a THIRD PARTY moving a confirmed show earlier", () => {
  function thirdPartyCtx() {
    const place = sarahsHouse({ humanIdsWithAccess: ["venue-owner"] });
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place,
      existingEvent: existingStamped({ orgId: DEFAULT_ORG_ID }),
      // The saver manages nothing at this place.
    });
    const repos = ctx.deps.repos as unknown as Record<string, any>;
    // No agreement thread behind this event.
    repos.agreements.findByLinkedEventId = vi.fn(async () => null);
    repos.bookingRequests.getById = vi.fn(async (id: string) =>
      id === REQUEST_ID ? { id: REQUEST_ID, placeId: DEFAULT_PLACE_ID } : null,
    );
    const entries = () =>
      [...repos.bookingRequestMessages.rows.values()].filter(
        (row: { systemKind: string | null }) => row.systemKind,
      );
    return { ctx, place, entries, repos };
  }

  it("keeps the venue's confirmed start (no re-stamp), so the reveal floor does not move, and records the move on the confirming request's thread", async () => {
    const { ctx, place, entries } = thirdPartyCtx();

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        // Moved from Dec 10 to Oct 1 — two months earlier.
        startsAt: "2026-10-01T01:00:00.000Z",
        endsAt: "2026-10-01T04:00:00.000Z",
      }),
    );

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.startsAt).toEqual(new Date("2026-10-01T01:00:00.000Z"));
    expect(row.venueConfirmedStartsAt).toEqual(
      new Date("2026-12-10T01:00:00.000Z"),
    );

    // Holders: the day before the MOVED show is not the reveal — the day
    // before the CONFIRMED one is.
    const holder = resolveHolderAddress({
      event: row,
      place: toPlaceLocationSource(place),
      venueConfirmationArm: venueConfirmationArm(row, place),
      activeHolder: true,
      now: new Date("2026-09-30T12:00:00.000Z"),
    });
    expect(holder).toMatchObject({
      locked: true,
      reason: "notYetRevealed",
      revealAt: new Date(
        new Date("2026-12-10T01:00:00.000Z").getTime() - STAMP_ARM_REVEAL_LEAD_MS,
      ),
    });

    // The venue sees the move on the request it confirmed.
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      bookingRequestId: REQUEST_ID,
      systemKind: "booking_event.modified",
      systemData: {
        eventId: DEFAULT_EVENT_ID,
        previousStartsAt: "2026-12-10T01:00:00.000Z",
        nextStartsAt: "2026-10-01T01:00:00.000Z",
      },
    });
  });

  it("moving it LATER writes no fallback entry (the floor defers on its own)", async () => {
    const { ctx, entries } = thirdPartyCtx();

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        startsAt: "2026-12-20T01:00:00.000Z",
        endsAt: "2026-12-20T04:00:00.000Z",
      }),
    );

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(0);
  });

  it("never records on a request that is not about this place", async () => {
    const { ctx, entries, repos } = thirdPartyCtx();
    repos.bookingRequests.getById = vi.fn(async () => ({
      id: REQUEST_ID,
      placeId: "another-place",
    }));

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        startsAt: "2026-10-01T01:00:00.000Z",
        endsAt: "2026-10-01T04:00:00.000Z",
      }),
    );

    expect(entries()).toHaveLength(0);
  });
});

describe("N1 — a grant-holder moving their own show re-vouches", () => {
  it("re-stamps when the start moved, not when it did not", async () => {
    const place = sarahsHouse({ humanIdsWithAccess: ["venue-owner"] });
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place,
      existingEvent: existingStamped({
        orgId: null,
        humanId: SARAH,
        venueConfirmationRequestId: null,
      }),
    });
    const grants = ctx.deps.repos.placeBookingGrants as unknown as {
      findActiveForActor: ReturnType<typeof vi.fn>;
    };
    grants.findActiveForActor.mockResolvedValue({
      id: "g1",
      placeId: DEFAULT_PLACE_ID,
    });
    const humanInput = (overrides: Record<string, unknown>) => {
      const { orgId: _orgId, ...rest } = orgInput({
        eventId: DEFAULT_EVENT_ID,
        ...overrides,
      });
      return rest;
    };

    await saveEventForHuman(
      ctx.deps,
      humanInput({
        startsAt: "2026-12-10T01:00:00.000Z",
        endsAt: "2026-12-10T04:00:00.000Z",
      }),
    );
    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();

    await saveEventForHuman(
      ctx.deps,
      humanInput({
        startsAt: "2026-11-10T01:00:00.000Z",
        endsAt: "2026-11-10T04:00:00.000Z",
      }),
    );
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    // The audit names the grant the stamp rides (FR-003 revoke reads it).
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event.place_confirmed_by_grant",
        data: expect.objectContaining({ grantId: "g1" }),
      }),
    );
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.venueConfirmedStartsAt).toEqual(
      new Date("2026-11-10T01:00:00.000Z"),
    );
  });
});

describe("N2 — a freeform address that is the saver's OWN withheld place", () => {
  /** ~20 m north of the house. */
  const NEAR = { lat: 36.1862 + 20 / 111_320, lng: -86.7291 };
  /** ~200 m north of the house. */
  const FAR = { lat: 36.1862 + 200 / 111_320, lng: -86.7291 };

  function freeformInput(point: { lat: number; lng: number }) {
    return orgInput({
      location: {
        addressText: "905 Porter Rd, Nashville, TN 37206",
        lat: point.lat,
        lng: point.lng,
        locality: "Nashville",
        region: "TN",
        countryCode: "US",
        postalCode: "37206",
      },
    });
  }

  function build(options: {
    manages: boolean;
    candidates?: PlaceRecord[];
  }) {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      canManagePlace: () => options.manages,
    });
    const places = ctx.deps.repos.places as unknown as {
      listWithheldOwnedNearPoint: ReturnType<typeof vi.fn>;
    };
    places.listWithheldOwnedNearPoint.mockResolvedValue(
      options.candidates ?? [sarahsHouse()],
    );
    return { ctx, places };
  }

  it("refuses with EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE naming the place, and writes nothing", async () => {
    const { ctx, places } = build({ manages: true });

    await expect(
      saveEventForOrg(ctx.deps, freeformInput(NEAR)),
    ).rejects.toMatchObject({
      code: "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE",
      meta: { placeId: DEFAULT_PLACE_ID, placeName: "Sarah's House" },
    });
    // The lookup is scoped to the SAVER's own places (human + edit orgs).
    expect(places.listWithheldOwnedNearPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SARAH,
        orgIds: [DEFAULT_ORG_ID],
        withinMeters: OWN_WITHHELD_PLACE_RADIUS_M,
      }),
    );
    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("a candidate further than 50 m (a neighbour's pin) is not refused", async () => {
    const { ctx } = build({ manages: true });

    await expect(
      saveEventForOrg(ctx.deps, freeformInput(FAR)),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
  });

  it("canManagePlace has the final word: a candidate the saver cannot manage is not refused", async () => {
    const { ctx } = build({ manages: false });

    await expect(
      saveEventForOrg(ctx.deps, freeformInput(NEAR)),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
  });

  it("no candidates at all (anyone else's house) → saves as typed", async () => {
    const { ctx } = build({ manages: true, candidates: [] });

    await expect(
      saveEventForOrg(ctx.deps, freeformInput(NEAR)),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
    expect(ctx.mocks.authzPort.canManagePlace).not.toHaveBeenCalled();
  });

  it("applies to a SAVED address too (the builder's saved-address picker)", async () => {
    const saved: SavedLocationRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Home",
      address: "905 Porter Rd, Nashville, TN 37206",
      countryCode: "US",
      region: "TN",
      locality: "Nashville",
      postalCode: "37206",
      lat: NEAR.lat,
      lng: NEAR.lng,
      ownerType: "ORGANIZATION",
      ownerId: DEFAULT_ORG_ID,
      usageCount: 1,
      admissionTaxRateBps: null,
      taxRateFetchedAt: null,
      taxRateSource: null,
    } as SavedLocationRecord;
    const ctx = makeCreateEventTestContext({
      now: NOW,
      savedLocation: saved,
      canManagePlace: () => true,
    });
    const places = ctx.deps.repos.places as unknown as {
      listWithheldOwnedNearPoint: ReturnType<typeof vi.fn>;
    };
    places.listWithheldOwnedNearPoint.mockResolvedValue([sarahsHouse()]);

    await expect(
      saveEventForOrg(
        ctx.deps,
        orgInput({ location: { savedLocationId: saved.id } }),
      ),
    ).rejects.toMatchObject({ code: "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE" });
  });

  it("a place-linked save is not checked (it already draws the place's circle)", async () => {
    const { ctx, places } = build({ manages: true });

    await saveEventForOrg(ctx.deps, orgInput());

    expect(places.listWithheldOwnedNearPoint).not.toHaveBeenCalled();
  });
});

describe("R3-2 — a manager's UNRELATED save does not re-confirm an organizer's move", () => {
  it("the organizer moved the confirmed show earlier; a manager then fixes a typo: no re-stamp, the floor stays on the confirmed date", async () => {
    const place = sarahsHouse();
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place,
      // Confirmed for Dec 10; the ORGANIZER has since moved it to Oct 1.
      existingEvent: existingStamped({
        startsAt: new Date("2026-10-01T01:00:00.000Z"),
        endsAt: new Date("2026-10-01T04:00:00.000Z"),
        venueConfirmedStartsAt: new Date("2026-12-10T01:00:00.000Z"),
      }),
      canManagePlace: () => true,
    });

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        title: "Basement Show (fixed typo)",
        startsAt: "2026-10-01T01:00:00.000Z",
        endsAt: "2026-10-01T04:00:00.000Z",
      }),
    );

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.venueConfirmedStartsAt).toEqual(
      new Date("2026-12-10T01:00:00.000Z"),
    );
    const holder = resolveHolderAddress({
      event: row,
      place: toPlaceLocationSource(place),
      venueConfirmationArm: "stamp",
      activeHolder: true,
      now: new Date("2026-09-30T12:00:00.000Z"),
    });
    expect(holder).toMatchObject({
      locked: true,
      revealAt: new Date(
        new Date("2026-12-10T01:00:00.000Z").getTime() - STAMP_ARM_REVEAL_LEAD_MS,
      ),
    });
  });

  it("the same manager MOVING the show in this save does re-vouch for the new date", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse(),
      existingEvent: existingStamped({
        startsAt: new Date("2026-10-01T01:00:00.000Z"),
        endsAt: new Date("2026-10-01T04:00:00.000Z"),
        venueConfirmedStartsAt: new Date("2026-12-10T01:00:00.000Z"),
      }),
      canManagePlace: () => true,
    });

    await saveEventForOrg(
      ctx.deps,
      orgInput({
        eventId: DEFAULT_EVENT_ID,
        startsAt: "2026-10-08T01:00:00.000Z",
        endsAt: "2026-10-08T04:00:00.000Z",
      }),
    );

    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.venueConfirmedStartsAt).toEqual(
      new Date("2026-10-08T01:00:00.000Z"),
    );
  });
});

describe("R3-3 — a grant-holder's save does not override a WITHDRAWAL", () => {
  it("withdrawn stamp + grant-holder save (even one that moves the show): nothing re-stamped", async () => {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: sarahsHouse({ humanIdsWithAccess: ["venue-owner"] }),
      existingEvent: existingStamped({
        orgId: null,
        humanId: SARAH,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: new Date("2026-09-20T00:00:00.000Z"),
        venueConfirmationWithdrawnReason: "not ours",
        venueConfirmedStartsAt: null,
      }),
    });
    const grants = ctx.deps.repos.placeBookingGrants as unknown as {
      findActiveForActor: ReturnType<typeof vi.fn>;
    };
    grants.findActiveForActor.mockResolvedValue({ id: "g1", placeId: DEFAULT_PLACE_ID });
    const { orgId: _orgId, ...humanInput } = orgInput({
      eventId: DEFAULT_EVENT_ID,
      startsAt: "2026-11-10T01:00:00.000Z",
      endsAt: "2026-11-10T04:00:00.000Z",
    });

    await saveEventForHuman(ctx.deps, humanInput);

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    const row = (await ctx.mocks.events.getById(DEFAULT_EVENT_ID))!;
    expect(row.venueConfirmationWithdrawnAt).toEqual(
      new Date("2026-09-20T00:00:00.000Z"),
    );
  });
});
