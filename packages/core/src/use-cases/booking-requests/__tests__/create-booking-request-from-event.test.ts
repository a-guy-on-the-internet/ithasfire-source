import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import {
  createFakePlaceBookingGrantsRepo,
} from "../../booking-holds/__tests__/fakes";
import { createBookingRequestFromEvent } from "../create-booking-request-from-event";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  OTHER_HUMAN_ID,
  PLACE_ID,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildPlaceRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Event-first (venue-confirmation spec "Two entry paths, one request"): a
// third-party event saved at a place + calendar creates the booking request
// the venue confirms. Runs through the pitch's own gate walk over a tx bag.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RENTAL_CALENDAR_ID = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const SPACE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222299";
/** 2026-10-03T01:30Z = the evening of Oct 2 in America/Chicago. */
const STARTS_AT = new Date("2026-10-03T01:30:00.000Z");
const ENDS_AT = new Date("2026-10-03T04:00:00.000Z");

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    title: "Basement Show",
    status: "DRAFT",
    placeId: PLACE_ID,
    calendarId: CALENDAR_ID,
    spaceId: null,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    timezone: "America/Chicago",
    ...overrides,
  } as EventRecord;
}

type BuildOptions = {
  place?: PlaceRecord | null;
  event?: Partial<EventRecord>;
  existingOrigin?: BookingRequestRecord | null;
  openRequest?: BookingRequestRecord | null;
  profile?: ReturnType<typeof buildPerformerProfile> | null;
  /** Rows for the claimed-venue hours gate; default = configured, no policy. */
  availabilityRows?: Array<Record<string, unknown>>;
  membership?: { role: string } | null;
};

function build(options: BuildOptions = {}) {
  // A CLAIMED, VERIFIED, opted-in venue owned by another org — the event's
  // owner (ACTOR_ID, a human) is a third party at it.
  const place =
    options.place === undefined
      ? buildPlaceRecord({
          orgIdsWithAccess: [VENUE_ORG_ID],
          humanIdsWithAccess: [],
          timezone: "America/Chicago",
        })
      : options.place;

  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  spaces.seed({ id: SPACE_ID, placeId: PLACE_ID, name: "Main Room" });
  calendars.seedCalendar({ id: CALENDAR_ID, placeId: PLACE_ID, isDefault: true });
  calendars.joins.set(CALENDAR_ID, [SPACE_ID]);
  calendars.seedCalendar({
    id: RENTAL_CALENDAR_ID,
    placeId: PLACE_ID,
    name: "Room rental",
    acceptsPerform: false,
    acceptsRent: true,
    acceptsUse: true,
  });
  calendars.joins.set(RENTAL_CALENDAR_ID, [SPACE_ID]);
  const rows = options.availabilityRows ?? [];
  const calendarsWithHours = {
    ...calendars,
    countAvailabilityForPlace: vi.fn(async () => rows.length || 1),
    listAvailabilityForPlace: vi.fn(async () => rows),
  };

  const bookingRequests = {
    findByOriginEventId: vi.fn(async () => options.existingOrigin ?? null),
    findOpenByPerformerAndPlace: vi.fn(async () => options.openRequest ?? null),
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildBookingRequestRecord(input as Partial<BookingRequestRecord>),
    ),
  };
  const grants = createFakePlaceBookingGrantsRepo();
  const mocks = {
    bookingRequests,
    places: { getById: vi.fn(async () => place) },
    calendars: calendarsWithHours,
    performerProfiles: {
      getByOwner: vi.fn(async () =>
        options.profile === undefined ? buildPerformerProfile() : options.profile,
      ),
    },
    events: {
      listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        options.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" }
          : options.membership,
      ),
    },
    audit: { log: vi.fn(async () => {}) },
    placeBookingGrants: grants,
  };
  const tx = withTx(mocks);
  return { tx, mocks, grants, event: buildEvent(options.event) };
}

describe("createBookingRequestFromEvent", () => {
  it("accepting calendar → ONE request with originEventId, the event's place-local day, message = title, and the venue's received-notice intent", async () => {
    const { tx, mocks, event } = build();

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.parked).toBe(false);
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        calendarId: CALENDAR_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        intent: "PERFORM",
        originEventId: EVENT_ID,
        message: "Basement Show",
        preferredDates: ["2026-10-02"],
        spaceId: null,
        requestedStartsAt: null,
        requestedEndsAt: null,
        purpose: null,
      }),
    );
    // Nothing is ever parked (amendment 2026-09-25): the stamp is not written.
    expect(mocks.bookingRequests.create.mock.calls[0]![0]).not.toHaveProperty(
      "parkedUnclaimedAt",
    );
    // The claimed venue's FR-008 notice rides as an intent (in-tx create).
    expect(result.notificationIntents).toEqual([
      {
        kind: "request.received",
        bookingRequestId: result.bookingRequestId,
        placeId: PLACE_ID,
        at: NOW,
      },
    ]);
    // Ledger opened, not parked.
    expect(systemEntriesFor(tx, result.bookingRequestId).map((e) => e.systemKind)).toEqual([
      "booking_request.opened",
    ]);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.created",
        data: expect.objectContaining({ originEventId: EVENT_ID, intent: "PERFORM" }),
      }),
    );
  });

  it("calendar does NOT accept the intent → no request, no error (address-only), reason recorded", async () => {
    const { tx, mocks, event } = build({
      event: { calendarId: RENTAL_CALENDAR_ID },
    });

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      intent: "PERFORM",
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    // The absorbed skip names the venue and the ask so the save can tell
    // the builder who refused (`bookingRequest.outcome === "skipped"`).
    expect(result).toEqual({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
      placeId: PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
      notificationIntents: [],
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("the claimed venue's opt-out / unverified / unconfigured-hours refusals are absorbed the same way (no request, no error)", async () => {
    for (const place of [
      buildPlaceRecord({ orgIdsWithAccess: [VENUE_ORG_ID], humanIdsWithAccess: [], acceptsBookingRequests: false }),
      buildPlaceRecord({ orgIdsWithAccess: [VENUE_ORG_ID], humanIdsWithAccess: [], verificationStatus: "PENDING" }),
    ]) {
      const { tx, mocks, event } = build({ place });
      const result = await createBookingRequestFromEvent(tx as never, {
        event,
        actorHumanId: ACTOR_ID,
        now: NOW,
      });
      expect(result.outcome).toBe("skipped");
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    }
    // Hours never configured (availability-onboarding FR-005 gate).
    const unconfigured = build();
    unconfigured.mocks.calendars.countAvailabilityForPlace.mockResolvedValue(0);
    const result = await createBookingRequestFromEvent(unconfigured.tx as never, {
      event: unconfigured.event,
      actorHumanId: ACTOR_ID,
      now: NOW,
    });
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
    });
  });

  it("second save of the same event → the SAME request, nothing created, no intents (idempotent on originEventId — a moved event keeps its first request)", async () => {
    const first = buildBookingRequestRecord({
      id: "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b",
      originEventId: EVENT_ID,
      placeId: "39393939-3939-4393-8393-393939393939",
    });
    const { tx, mocks, event } = build({ existingOrigin: first });

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result).toEqual({
      outcome: "existing",
      bookingRequestId: first.id,
      // The ROW's venue + intent + parking, not this save's ask: what the
      // builder is told it was sent to.
      placeId: first.placeId,
      placeName: first.placeName,
      intent: first.intent,
      parked: false,
      notificationIntents: [],
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });

  it("venue-owned event → none (confirmed by construction)", async () => {
    const { tx, mocks, event } = build({
      place: buildPlaceRecord({ orgIdsWithAccess: [], humanIdsWithAccess: [ACTOR_ID] }),
    });

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result).toEqual({ outcome: "skipped", reason: "venue_owned", notificationIntents: [] });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  // holds-without-a-request FR-002: one grant means all of it (H3, no
  // capability flags), it may go to an org (H2), and it is matched on the
  // event's OWNER as grantee — the grantee's own event. (Was: person owners
  // only, `canCreateEvents` required; a holds-only grant created a request.)
  it("the owner (person) is the grantee of an active grant on the calendar → skipped grant_holder (the save path stamps it)", async () => {
    const stamped = build();
    stamped.grants.seed({ placeId: PLACE_ID, humanId: ACTOR_ID, calendarId: CALENDAR_ID });
    await expect(
      createBookingRequestFromEvent(stamped.tx as never, { event: stamped.event, actorHumanId: ACTOR_ID, now: NOW }),
    ).resolves.toEqual({ outcome: "skipped", reason: "grant_holder", notificationIntents: [] });
  });

  it("an ORG owner that is the grantee → skipped grant_holder (the 'an org has no grant' rule ended)", async () => {
    const ctx = build({ event: { orgId: ORG_ID, humanId: null } });
    ctx.grants.seed({ placeId: PLACE_ID, grantee: { kind: "org", orgId: ORG_ID } });
    await expect(
      createBookingRequestFromEvent(ctx.tx as never, { event: ctx.event, actorHumanId: ACTOR_ID, now: NOW }),
    ).resolves.toEqual({ outcome: "skipped", reason: "grant_holder", notificationIntents: [] });
  });

  it.each([
    ["pending", { acceptedAt: null }],
    ["revoked", { revokedAt: new Date(NOW.getTime() - 1) }],
    ["expired", { expiresAt: new Date(NOW.getTime() - 1) }],
    ["on another calendar", { calendarId: "c0ffee00-0000-4000-8000-0000000000ff" }],
  ] as const)("a %s grant does not count: the request is created", async (_label, over) => {
    const ctx = build();
    ctx.grants.seed({ placeId: PLACE_ID, humanId: ACTOR_ID, ...over });
    const result = await createBookingRequestFromEvent(ctx.tx as never, {
      event: ctx.event,
      actorHumanId: ACTOR_ID,
      now: NOW,
    });
    expect(result.outcome).toBe("created");
  });

  it("the ACTOR's grant does not cover an event owned by someone else", async () => {
    // The org owns the event; the actor personally holds a grant. Not the
    // grantee's own event → asked like any third party.
    const ctx = build({ event: { orgId: ORG_ID, humanId: null } });
    ctx.mocks.performerProfiles.getByOwner.mockImplementation(
      async (args: { ownerType: string; ownerId: string }) =>
        args.ownerType === "organization" && args.ownerId === ORG_ID
          ? buildPerformerProfile({ ownerType: "organization", ownerId: ORG_ID })
          : null,
    );
    ctx.grants.seed({ placeId: PLACE_ID, humanId: ACTOR_ID });
    const result = await createBookingRequestFromEvent(ctx.tx as never, {
      event: ctx.event,
      intent: "PERFORM",
      actorHumanId: ACTOR_ID,
      now: NOW,
    });
    expect(result.outcome).toBe("created");
  });

  // Regression (2026-09-08): `ownerOf` returned the WIRE owner type ("org")
  // where the stored party convention ("organization") is expected, so an
  // org-owned event's PERFORM request read performer mode under a type no
  // profile row carries, missed, and was silently skipped as
  // PERFORMER_MODE_REQUIRED — and a RENT request wrote the bogus type. The
  // profile fake here answers ONLY the stored convention, as the real repo
  // would, so the old code skips and this fails.
  it("ORG-owned PERFORM event → performer mode is read and stored under the party convention ('organization'), and the request is created, not skipped", async () => {
    const { tx, mocks, event } = build({
      event: { orgId: ORG_ID, humanId: null },
    });
    mocks.performerProfiles.getByOwner.mockImplementation(
      async (args: { ownerType: string; ownerId: string }) =>
        args.ownerType === "organization" && args.ownerId === ORG_ID
          ? buildPerformerProfile({ ownerType: "organization", ownerId: ORG_ID })
          : null,
    );

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      intent: "PERFORM",
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result.outcome).toBe("created");
    expect(mocks.performerProfiles.getByOwner).toHaveBeenCalledWith({
      ownerType: "organization",
      ownerId: ORG_ID,
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
        originEventId: EVENT_ID,
      }),
    );
  });

  it("RENT on an accepting calendar → the event's start/end as the window, purpose = title, the event's space", async () => {
    const { tx, mocks, event } = build({
      event: { calendarId: RENTAL_CALENDAR_ID, spaceId: SPACE_ID, orgId: ORG_ID, humanId: null },
      profile: null, // RENT never consults performer mode
    });

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      intent: "RENT",
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result.outcome).toBe("created");
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
        spaceId: SPACE_ID,
        requestedStartsAt: STARTS_AT,
        requestedEndsAt: ENDS_AT,
        purpose: "Basement Show",
        preferredDates: ["2026-10-02"],
        originEventId: EVENT_ID,
      }),
    );
    expect(mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();
  });

  it("RENT/USE without a space on the event → the request is still CREATED, spaceless (ruling 2026-09-22)", async () => {
    // An event saved at a calendar with no room picked still asks. The room
    // is chosen at accept/confirm, on the draft event; nothing downstream
    // reads one off the request. The WINDOW — the event's own start/end —
    // still carries, and is still required.
    const { tx, mocks, event } = build({
      event: { calendarId: RENTAL_CALENDAR_ID, spaceId: null },
      profile: null, // USE never consults performer mode
    });

    const result = await createBookingRequestFromEvent(tx as never, {
      event,
      intent: "USE",
      actorHumanId: ACTOR_ID,
      now: NOW,
    });

    expect(result.outcome).toBe("created");
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "USE",
        spaceId: null,
        requestedStartsAt: STARTS_AT,
        requestedEndsAt: ENDS_AT,
        purpose: "Basement Show",
        originEventId: EVENT_ID,
      }),
    );
  });

  it("RENT/USE on an event with no END is still INVALID_INPUT window_required_for_intent (fails the save)", async () => {
    // The sibling of the case above: the room requirement went, the window
    // requirement did not.
    const { tx, event } = build({
      event: { calendarId: RENTAL_CALENDAR_ID, spaceId: SPACE_ID, endsAt: null },
    });

    await expect(
      createBookingRequestFromEvent(tx as never, { event, intent: "USE", actorHumanId: ACTOR_ID, now: NOW }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "window_required_for_intent" });
  });

  it("unclaimed place → NO request: PLACE_NOT_TAKING_REQUESTS is absorbed into a skip, so the event still saves address-only (amendment 2026-09-25)", async () => {
    for (const place of [
      buildPlaceRecord({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        verificationStatus: "UNVERIFIED",
        acceptsBookingRequests: false,
      }),
      // Claimed is not VERIFIED: a staff-waived place nobody holds is unclaimed.
      buildPlaceRecord({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: true,
      }),
    ]) {
      const { tx, mocks, event } = build({ place });

      const result = await createBookingRequestFromEvent(tx as never, {
        event,
        actorHumanId: ACTOR_ID,
        now: NOW,
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "venue_not_accepting",
        code: "PLACE_NOT_TAKING_REQUESTS",
        message: "PLACE_NOT_TAKING_REQUESTS",
        placeId: PLACE_ID,
        placeName: "Test Venue",
        intent: "PERFORM",
        notificationIntents: [],
      });
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
    }
  });

  it("actor is not the event's owner → NOT_RESOURCE_OWNER (human) / INSUFFICIENT_ROLE (org), nothing written", async () => {
    const human = build();
    await expect(
      createBookingRequestFromEvent(human.tx as never, { event: human.event, actorHumanId: OTHER_HUMAN_ID, now: NOW }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    const org = build({ event: { orgId: ORG_ID, humanId: null }, membership: { role: "VIEWER" } });
    await expect(
      createBookingRequestFromEvent(org.tx as never, { event: org.event, actorHumanId: OTHER_HUMAN_ID, now: NOW }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(human.mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(org.mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("PERFORM without performer mode → the gate applies as NO request (sender_not_eligible), never a failed save; the migration's bypass + system actor skips it and the access check", async () => {
    const enforced = build({ profile: null });
    await expect(
      createBookingRequestFromEvent(enforced.tx as never, { event: enforced.event, actorHumanId: ACTOR_ID, now: NOW }),
    ).resolves.toEqual({
      outcome: "skipped",
      reason: "sender_not_eligible",
      code: "PERFORMER_MODE_REQUIRED",
      message: "PERFORMER_MODE_REQUIRED",
      placeId: PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
      notificationIntents: [],
    });
    expect(enforced.mocks.bookingRequests.create).not.toHaveBeenCalled();

    const migration = build({ profile: null });
    const result = await createBookingRequestFromEvent(migration.tx as never, {
      event: migration.event,
      actorHumanId: null,
      performerGate: "bypass",
      now: NOW,
    });
    expect(result.outcome).toBe("created");
    expect(migration.mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(migration.mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();
    // Ledger records no author for a system actor.
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(systemEntriesFor(migration.tx, result.bookingRequestId)[0]?.authorHumanId).toBeNull();
  });

  it("a second OPEN request by the same sender at the place → DUPLICATE_OPEN_REQUEST (the DB partial unique refuses it too)", async () => {
    const { tx, event } = build({ openRequest: buildBookingRequestRecord({ status: "VIEWED" }) });

    await expect(
      createBookingRequestFromEvent(tx as never, { event, actorHumanId: ACTOR_ID, now: NOW }),
    ).rejects.toMatchObject({ code: "DUPLICATE_OPEN_REQUEST" });
  });

  it("no place / no calendar / ownerless listing → none", async () => {
    for (const [event, reason] of [
      [buildEvent({ placeId: null }), "no_place"],
      [buildEvent({ calendarId: null }), "no_calendar"],
      [buildEvent({ orgId: null, humanId: null }), "no_owner"],
    ] as const) {
      const { tx, mocks } = build();
      await expect(
        createBookingRequestFromEvent(tx as never, { event, actorHumanId: ACTOR_ID, now: NOW }),
      ).resolves.toEqual({ outcome: "skipped", reason, notificationIntents: [] });
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    }
  });

  it("venue booking standards are NOT enforced here (not a pitch — FR-006 covers the pitch entrances only), for the event-first and the migration path alike", async () => {
    for (const performerGate of ["enforce", "bypass"] as const) {
      const { tx, mocks, event } = build();
      const { bookingStandards } = tx as unknown as {
        bookingStandards: {
          replaceItems: (input: Record<string, unknown>) => Promise<unknown>;
          listForOwners: (...args: unknown[]) => Promise<unknown>;
        };
      };
      // Every PERFORM item this event-built request cannot meet, REQUIRED.
      for (const [ownerType, ownerId] of [
        ["PLACE", PLACE_ID],
        ["CALENDAR", CALENDAR_ID],
      ] as const) {
        await bookingStandards.replaceItems({
          ownerType,
          ownerId,
          intent: "PERFORM",
          items: [
            { field: "LINK_MUSIC", label: "Music link", requirement: "REQUIRED" },
            { field: "BILL", label: "The bill", requirement: "REQUIRED" },
          ],
        });
      }
      const listSpy = vi.spyOn(bookingStandards, "listForOwners");

      const result = await createBookingRequestFromEvent(tx as never, {
        event,
        actorHumanId: ACTOR_ID,
        now: NOW,
        performerGate,
      });

      expect(result.outcome, performerGate).toBe("created");
      expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
      // Not even read: the gate is not on this path.
      expect(listSpy).not.toHaveBeenCalled();
    }
  });
});
