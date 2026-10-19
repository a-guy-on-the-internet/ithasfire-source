import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import { buildBookingRequestRecord, buildPlaceRecord } from "../../booking-requests/__tests__/helpers";
import { saveEventWireOutputSchema } from "../_shared/save-event-shared";
import { saveEventForHuman } from "../save-event-for-human";
import { saveEventForOrg } from "../save-event-for-org";

// ─────────────────────────────────────────────────────────────────────────────
// Event-first on the SAVE path (venue-confirmation spec "Two entry paths, one
// request"): a THIRD-PARTY save at a place + calendar creates the booking
// request in the save's own transaction, and its notifications ride the
// LIVE output as `bookingRequestNotificationIntents`. The primitive's own
// rules are pinned in booking-requests/__tests__/create-booking-request-
// from-event.test.ts; here it is WHEN the save calls it, what the save hands
// it, and how the result rides (or does not ride) the output.
//
// Also the grant-holder stamp: an owner (person or org) that is the grantee
// of an active booking grant at the place is confirmed by construction —
// the save stamps the row and asks the venue nothing (holds-without-a-
// request FR-002: one grant means all of it, and it may go to an org).
//
// And the WIRE: the request the save created or found rides the output as
// `bookingRequest` (spec "UI / Flow › Event builder": "Sent to The Blue Room
// for confirmation" / "This venue hasn't claimed its page yet") — kept by the
// wire schema and by the idempotency cache, `null` whenever no request was
// involved.
// ─────────────────────────────────────────────────────────────────────────────

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RENTAL_CALENDAR_ID = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const SPACE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
/** An ACTIVE room at the place that no calendar owns — `space_not_on_calendar`. */
const UNJOINED_SPACE_ID = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
const OTHER_PLACE_ID = "34343434-3434-4343-8343-343434343434";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222299";
const VENUE_HUMAN_ID = "23232323-2323-4232-8232-232323232323";
const NOW = new Date("2026-09-07T12:00:00.000Z");
/** The id the test-utils `bookingRequests.create` fake stamps on every row. */
const CREATED_REQUEST_ID = "b0000000-0000-4000-8000-00000000000b";
const EXISTING_REQUEST_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

/** A CLAIMED, VERIFIED, opted-in venue owned by someone else. */
function foreignPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return buildPlaceRecord({
    id: DEFAULT_PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG_ID],
    humanIdsWithAccess: [VENUE_HUMAN_ID],
    timezone: "America/Chicago",
    ...overrides,
  });
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Basement Show",
    startsAt: "2026-10-03T01:30:00.000Z",
    endsAt: "2026-10-03T04:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    calendarId: CALENDAR_ID,
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

function build(options: { place?: PlaceRecord | null; existingEvent?: EventRecord | null } = {}) {
  const ctx = makeCreateEventTestContext({
    now: NOW,
    place: options.place === undefined ? foreignPlace() : options.place,
    ...(options.existingEvent !== undefined ? { existingEvent: options.existingEvent } : {}),
  });
  ctx.mocks.spaces.seed({ id: SPACE_ID, placeId: DEFAULT_PLACE_ID, name: "Main Room" });
  ctx.mocks.calendars.seedCalendar({ id: CALENDAR_ID, placeId: DEFAULT_PLACE_ID, isDefault: true });
  ctx.mocks.calendars.joins.set(CALENDAR_ID, [SPACE_ID]);
  ctx.mocks.calendars.seedCalendar({
    id: RENTAL_CALENDAR_ID,
    placeId: DEFAULT_PLACE_ID,
    name: "Room rental",
    acceptsPerform: false,
    acceptsRent: true,
  });
  ctx.mocks.calendars.joins.set(RENTAL_CALENDAR_ID, [SPACE_ID]);
  // Hours "configured, no window policy" (a dated exception outside the
  // probe) so the claimed-venue hours gate passes for PERFORM.
  ctx.mocks.calendars.seedAvailability({
    placeId: DEFAULT_PLACE_ID,
    date: new Date("2030-01-01T00:00:00.000Z"),
    isOpen: false,
  });
  // The org is a performer (PERFORM's gate).
  vi.mocked(ctx.deps.repos.performerProfiles.getByOwner).mockResolvedValue({
    enabledAt: new Date("2026-01-01T00:00:00.000Z"),
    disabledAt: null,
  } as never);
  const bookingRequests = ctx.deps.repos.bookingRequests as unknown as {
    create: ReturnType<typeof vi.fn>;
    findByOriginEventId: ReturnType<typeof vi.fn>;
  };
  return { ctx, bookingRequests };
}

describe("finalizeSaveEvent — event-first booking request", () => {
  it("a third-party org save at a place + accepting calendar creates ONE request (originEventId = the saved event) and the venue's received-notice intent rides the output; a second save finds it and creates nothing", async () => {
    const { ctx, bookingRequests } = build();

    const first = await saveEventForOrg(ctx.deps, makeInput());

    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: DEFAULT_PLACE_ID,
        calendarId: CALENDAR_ID,
        // The STORED party convention (`toPerformerOwnerType`), not the wire "org".
        performerOwnerType: "organization",
        performerOwnerId: DEFAULT_ORG_ID,
        intent: "PERFORM",
        originEventId: first.eventId,
        message: "Basement Show",
        preferredDates: ["2026-10-02"],
      }),
    );
    expect(first.bookingRequestNotificationIntents).toEqual([
      expect.objectContaining({ kind: "request.received", placeId: DEFAULT_PLACE_ID, at: NOW }),
    ]);
    // The builder is told who it was sent to.
    expect(first.bookingRequest).toEqual({
      id: CREATED_REQUEST_ID,
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
      parked: false,
      outcome: "created",
    });

    // Second save (new clientKey): the origin lookup finds the first row.
    bookingRequests.findByOriginEventId.mockResolvedValue(
      buildBookingRequestRecord({
        id: EXISTING_REQUEST_ID,
        placeId: DEFAULT_PLACE_ID,
        placeName: "Test Venue",
        originEventId: first.eventId,
      }),
    );
    const second = await saveEventForOrg(
      ctx.deps,
      makeInput({ eventId: first.eventId, title: "Basement Show (renamed)" }),
    );
    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
    expect("bookingRequestNotificationIntents" in second).toBe(false);
    expect(second.bookingRequest).toEqual({
      id: EXISTING_REQUEST_ID,
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
      parked: false,
      outcome: "existing",
    });
  });

  it("a re-save asking for a DIFFERENT intent still reports the first request's own intent (idempotent on originEventId, not on the ask)", async () => {
    const { ctx, bookingRequests } = build();
    const first = await saveEventForOrg(ctx.deps, makeInput());
    bookingRequests.findByOriginEventId.mockResolvedValue(
      buildBookingRequestRecord({
        id: EXISTING_REQUEST_ID,
        placeId: DEFAULT_PLACE_ID,
        intent: "PERFORM",
        originEventId: first.eventId,
      }),
    );

    const second = await saveEventForOrg(
      ctx.deps,
      makeInput({ eventId: first.eventId, calendarId: RENTAL_CALENDAR_ID, spaceId: SPACE_ID, bookingIntent: "RENT" }),
    );

    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(second.bookingRequest).toMatchObject({ id: EXISTING_REQUEST_ID, intent: "PERFORM", outcome: "existing" });
  });

  it("the wire schema KEEPS `bookingRequest` while still stripping the three intent fields", () => {
    const server = {
      eventId: DEFAULT_EVENT_ID,
      status: "DRAFT" as const,
      notificationIntents: [],
      staffRecipientHint: null,
      bookingRequestNotificationIntents: [
        { kind: "request.received" as const, bookingRequestId: CREATED_REQUEST_ID, placeId: DEFAULT_PLACE_ID, at: NOW },
      ],
      bookingRequest: {
        id: CREATED_REQUEST_ID,
        placeId: DEFAULT_PLACE_ID,
        placeName: "Test Venue",
        intent: "PERFORM" as const,
        parked: false,
        outcome: "created" as const,
      },
    };

    const wire = saveEventWireOutputSchema.parse(server);

    expect(wire).toEqual({
      eventId: DEFAULT_EVENT_ID,
      status: "DRAFT",
      bookingRequest: server.bookingRequest,
    });
    expect("notificationIntents" in wire).toBe(false);
    expect("staffRecipientHint" in wire).toBe(false);
    expect("bookingRequestNotificationIntents" in wire).toBe(false);
    // `null` survives too — "no request" is an answer, not an omission.
    expect(saveEventWireOutputSchema.parse({ ...server, bookingRequest: null })).toEqual({
      eventId: DEFAULT_EVENT_ID,
      status: "DRAFT",
      bookingRequest: null,
    });
    // …and so does the refusal (discriminated on `outcome`): the venue and
    // the refusal ride, nothing request-shaped is required of it.
    const skipped = {
      outcome: "skipped" as const,
      reason: "venue_not_accepting" as const,
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM" as const,
    };
    expect(saveEventWireOutputSchema.parse({ ...server, bookingRequest: skipped })).toEqual({
      eventId: DEFAULT_EVENT_ID,
      status: "DRAFT",
      bookingRequest: skipped,
    });
    // The internal reasons never cross the wire — the schema refuses them.
    expect(() =>
      saveEventWireOutputSchema.parse({ ...server, bookingRequest: { ...skipped, reason: "venue_owned" } }),
    ).toThrow();
  });

  it("an idempotent replay returns the cached wire response WITHOUT the intents but WITH `bookingRequest`, and never re-runs the create", async () => {
    const { ctx, bookingRequests } = build();
    const input = makeInput();

    const first = await saveEventForOrg(ctx.deps, input);
    const replay = await saveEventForOrg(ctx.deps, input);

    expect(first.bookingRequestNotificationIntents).toHaveLength(1);
    // The request is a fact about the saved event, so the cache keeps it;
    // the intents are a side effect, so the cache drops them.
    expect(replay).toEqual({
      eventId: first.eventId,
      status: "DRAFT",
      bookingRequest: first.bookingRequest,
    });
    expect(replay.bookingRequest).toMatchObject({ outcome: "created", placeId: DEFAULT_PLACE_ID });
    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(bookingRequests.findByOriginEventId).toHaveBeenCalledTimes(1);
  });

  it("an idempotency envelope written BEFORE `bookingRequest` existed replays as `bookingRequest: null` (deploy-window normalisation), never as a missing key", async () => {
    const { ctx } = build();
    const input = makeInput();
    const first = await saveEventForOrg(ctx.deps, input);

    // Rewrite the cached envelope as pre-deploy code would have stored it.
    const store = ctx.deps.idempotency.__store;
    const [key, record] = [...store.entries()][0]!;
    const { bookingRequest: _dropped, ...legacyResponse } = record.response as Record<string, unknown>;
    store.set(key, { payloadHash: record.payloadHash, response: legacyResponse });

    const replay = await saveEventForOrg(ctx.deps, input);

    expect(replay).toEqual({ eventId: first.eventId, status: "DRAFT", bookingRequest: null });
    // …and it still satisfies the router's required output parse.
    expect(() => saveEventWireOutputSchema.parse(replay)).not.toThrow();
  });

  it("replaying a clientKey with a DIFFERENT bookingIntent is an idempotency conflict, not the old request", async () => {
    const { ctx } = build();
    const input = makeInput();
    await saveEventForOrg(ctx.deps, input);

    await expect(
      saveEventForOrg(ctx.deps, { ...input, bookingIntent: "USE", spaceId: SPACE_ID }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("calendar does not accept the intent → the event saves address-only (no request, no intents, no error) and the wire SAYS the venue refused", async () => {
    const { ctx, bookingRequests } = build();

    const result = await saveEventForOrg(
      ctx.deps,
      makeInput({ calendarId: RENTAL_CALENDAR_ID, bookingIntent: "PERFORM" }),
    );

    expect(result.status).toBe("DRAFT");
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect("bookingRequestNotificationIntents" in result).toBe(false);
    expect(result.bookingRequest).toEqual({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
    });
  });

  it("a place with no calendar named → no request (address-only)", async () => {
    const { ctx, bookingRequests } = build();

    const result = await saveEventForOrg(ctx.deps, makeInput({ calendarId: undefined }));

    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequest).toBeNull();
  });

  it("a VENUE-OWNED save (the org owns the place) asks the venue nothing", async () => {
    const { ctx, bookingRequests } = build({
      place: foreignPlace({ orgIdsWithAccess: [DEFAULT_ORG_ID], humanIdsWithAccess: [] }),
    });

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(result.status).toBe("DRAFT");
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    // An internal skip (nothing to ask) is `null`, never the `skipped` shape:
    // the venue did not refuse anything — it IS the venue.
    expect(result.bookingRequest).toBeNull();
  });

  // ── The absorbed gate refusals reach the builder (owner ruling 2026-09-08) ──
  // Before this the save succeeded and the wire said `null` for a venue with
  // no hours, a closed night, a paused venue or a sender without performer
  // mode — indistinguishable from "nothing to ask", so the builder rendered
  // nothing. Now `outcome: "skipped"` names the venue and the refusal.

  it("a venue with ZERO CalendarAvailability rows (hours never set) → no request, and the wire carries PLACE_NOT_ACCEPTING_REQUESTS / booking_requests_unconfigured", async () => {
    const { ctx, bookingRequests } = build();
    // `build()` seeds one dated closure so the hours gate passes; a venue
    // that has never opened the hours modal has no rows at all.
    ctx.mocks.calendars.availability.clear();

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(result.status).toBe("DRAFT");
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect("bookingRequestNotificationIntents" in result).toBe(false);
    expect(result.bookingRequest).toEqual({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
    });
  });

  it("a closed night (the venue posts hours, none on the event's place-local day) → BOOKING_DATE_UNAVAILABLE rides the wire", async () => {
    const { ctx, bookingRequests } = build();
    // The event starts 2026-10-03T01:30Z = Friday 2026-10-02 20:30 in the
    // venue's America/Chicago. Posting Monday hours only makes Friday `closed`.
    ctx.mocks.calendars.seedAvailability({
      placeId: DEFAULT_PLACE_ID,
      dayOfWeek: 1,
      startTime: "18:00",
      endTime: "23:00",
      isOpen: true,
    });

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequest).toEqual({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "BOOKING_DATE_UNAVAILABLE",
      message: "BOOKING_DATE_UNAVAILABLE",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
    });
  });

  it("a paused venue (opted out of booking requests) → PLACE_NOT_ACCEPTING_REQUESTS with the bare code as its message", async () => {
    const { ctx, bookingRequests } = build({
      place: foreignPlace({ acceptsBookingRequests: false }),
    });

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequest).toMatchObject({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "PLACE_NOT_ACCEPTING_REQUESTS",
      placeId: DEFAULT_PLACE_ID,
    });
  });

  it("sender without performer mode → the save still lands and the wire says sender_not_eligible / PERFORMER_MODE_REQUIRED", async () => {
    const { ctx, bookingRequests } = build();
    vi.mocked(ctx.deps.repos.performerProfiles.getByOwner).mockResolvedValue(null as never);

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(result.status).toBe("DRAFT");
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequest).toEqual({
      outcome: "skipped",
      reason: "sender_not_eligible",
      code: "PERFORMER_MODE_REQUIRED",
      message: "PERFORMER_MODE_REQUIRED",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      intent: "PERFORM",
    });
  });

  it("an idempotent replay of a REFUSED save returns the same `skipped` answer from the cache without re-walking the gates", async () => {
    const { ctx, bookingRequests } = build();
    ctx.mocks.calendars.availability.clear();
    const input = makeInput();

    const first = await saveEventForOrg(ctx.deps, input);
    expect(first.bookingRequest).toMatchObject({ outcome: "skipped", code: "PLACE_NOT_ACCEPTING_REQUESTS" });
    // Were the gates re-run, hours-now-configured would flip the answer.
    ctx.mocks.calendars.seedAvailability({ placeId: DEFAULT_PLACE_ID, dayOfWeek: 5, startTime: "18:00", endTime: "23:00" });

    const replay = await saveEventForOrg(ctx.deps, input);

    expect(replay).toEqual({ eventId: first.eventId, status: "DRAFT", bookingRequest: first.bookingRequest });
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(() => saveEventWireOutputSchema.parse(replay)).not.toThrow();
  });

  it("bookingIntent RENT with a space → the request carries the event's window + purpose", async () => {
    const { ctx, bookingRequests } = build();

    const result = await saveEventForOrg(
      ctx.deps,
      makeInput({ calendarId: RENTAL_CALENDAR_ID, spaceId: SPACE_ID, bookingIntent: "RENT" }),
    );

    expect(bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        spaceId: SPACE_ID,
        requestedStartsAt: new Date("2026-10-03T01:30:00.000Z"),
        requestedEndsAt: new Date("2026-10-03T04:00:00.000Z"),
        purpose: "Basement Show",
        originEventId: result.eventId,
      }),
    );
  });

  it("bookingIntent RENT WITHOUT a space still creates the request, spaceless (ruling 2026-09-22)", async () => {
    // The room came off the request: the save asks with the event's calendar
    // and window, and the room is chosen at accept/confirm on the draft
    // event. A RENT save that names no room must NOT fail.
    const { ctx, bookingRequests } = build();

    const result = await saveEventForOrg(
      ctx.deps,
      makeInput({ calendarId: RENTAL_CALENDAR_ID, bookingIntent: "RENT" }),
    );

    expect(bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        spaceId: null,
        requestedStartsAt: new Date("2026-10-03T01:30:00.000Z"),
        requestedEndsAt: new Date("2026-10-03T04:00:00.000Z"),
        originEventId: result.eventId,
      }),
    );
    expect(ctx.deps.idempotency.commit).toHaveBeenCalled();
  });

  it("the primitive's hard refusals fail the save and the idempotency claim (a room that is not on the routed calendar)", async () => {
    // A room the SENDER named that the calendar does not own is still a hard
    // refusal — dropping the "a room is required" rule did not drop the "a
    // room you DO name must be on the calendar" rule. This case also keeps
    // the idempotency behaviour of a primitive throw pinned: the claim is
    // FAILED, never committed.
    const { ctx, bookingRequests } = build();
    // Active, at the place (so `resolveVenuePlacement` accepts it) but joined
    // to NO calendar.
    ctx.mocks.spaces.seed({ id: UNJOINED_SPACE_ID, placeId: DEFAULT_PLACE_ID, name: "Green Room" });

    await expect(
      saveEventForOrg(
        ctx.deps,
        makeInput({
          calendarId: RENTAL_CALENDAR_ID,
          spaceId: UNJOINED_SPACE_ID,
          bookingIntent: "RENT",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "space_not_on_calendar" });
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(ctx.deps.idempotency.fail).toHaveBeenCalled();
    expect(ctx.deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("an unclaimed place → NO request; the event still saves address-only and the wire says PLACE_NOT_TAKING_REQUESTS (amendment 2026-09-25)", async () => {
    const { ctx, bookingRequests } = build({
      place: foreignPlace({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        verificationStatus: "UNVERIFIED",
        acceptsBookingRequests: false,
      }),
    });

    const result = await saveEventForOrg(ctx.deps, makeInput());

    expect(result.status).toBe("DRAFT");
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect(result.bookingRequestNotificationIntents ?? []).toEqual([]);
    expect(result.bookingRequest).toMatchObject({
      outcome: "skipped",
      reason: "venue_not_accepting",
      code: "PLACE_NOT_TAKING_REQUESTS",
      message: "PLACE_NOT_TAKING_REQUESTS",
      placeId: DEFAULT_PLACE_ID,
    });
  });

  // Old rows only: nothing parks any more (amendment 2026-09-25), but a row
  // parked before it reads back as parked until the cleanup expires it.
  it("a re-save of an event whose OLD parked request is STILL parked reports parked:true; one the venue has claimed since reports false", async () => {
    const { ctx, bookingRequests } = build();
    const first = await saveEventForOrg(ctx.deps, makeInput());

    bookingRequests.findByOriginEventId.mockResolvedValue(
      buildBookingRequestRecord({ id: EXISTING_REQUEST_ID, placeId: DEFAULT_PLACE_ID, parkedUnclaimedAt: NOW }),
    );
    const stillParked = await saveEventForOrg(ctx.deps, makeInput({ eventId: first.eventId }));
    expect(stillParked.bookingRequest).toMatchObject({ outcome: "existing", parked: true });

    bookingRequests.findByOriginEventId.mockResolvedValue(
      buildBookingRequestRecord({ id: EXISTING_REQUEST_ID, placeId: DEFAULT_PLACE_ID, parkedUnclaimedAt: null }),
    );
    const claimed = await saveEventForOrg(ctx.deps, makeInput({ eventId: first.eventId }));
    expect(claimed.bookingRequest).toMatchObject({ outcome: "existing", parked: false });
  });

  it("a save that MOVES the event to another place keeps the first request (unique originEventId): nothing new is created", async () => {
    const existing = {
      id: DEFAULT_EVENT_ID,
      orgId: DEFAULT_ORG_ID,
      humanId: null,
      title: "Basement Show",
      status: "DRAFT",
      placeId: OTHER_PLACE_ID,
      calendarId: null,
      spaceId: null,
      startsAt: new Date("2026-10-03T01:30:00.000Z"),
      endsAt: new Date("2026-10-03T04:00:00.000Z"),
      timezone: "America/Chicago",
      locationMode: "EXACT",
      savedLocationId: null,
    } as unknown as EventRecord;
    const { ctx, bookingRequests } = build({ existingEvent: existing });
    bookingRequests.findByOriginEventId.mockResolvedValue(
      buildBookingRequestRecord({
        id: EXISTING_REQUEST_ID,
        placeId: OTHER_PLACE_ID,
        placeName: "The Old Room",
        originEventId: DEFAULT_EVENT_ID,
      }),
    );

    const result = await saveEventForOrg(ctx.deps, makeInput({ eventId: DEFAULT_EVENT_ID }));

    expect(result.eventId).toBe(DEFAULT_EVENT_ID);
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect("bookingRequestNotificationIntents" in result).toBe(false);
    // The builder is told about the request that EXISTS — at the old place —
    // not a phantom one at the new place.
    expect(result.bookingRequest).toEqual({
      id: EXISTING_REQUEST_ID,
      placeId: OTHER_PLACE_ID,
      placeName: "The Old Room",
      intent: "PERFORM",
      parked: false,
      outcome: "existing",
    });
  });
});

describe("finalizeSaveEvent — grant-holder stamp", () => {
  function buildWithGrants() {
    const { ctx, bookingRequests } = build({
      // A foreign place the acting human / org does not own.
      place: foreignPlace({ orgIdsWithAccess: [VENUE_ORG_ID], humanIdsWithAccess: [VENUE_HUMAN_ID] }),
    });
    const grants = ctx.deps.repos.placeBookingGrants as unknown as {
      findActiveForActor: ReturnType<typeof vi.fn>;
    };
    return { ctx, bookingRequests, grants };
  }

  const humanInput = (overrides: Record<string, unknown> = {}) => {
    const { orgId: _orgId, ...rest } = makeInput(overrides);
    return rest;
  };

  it("owner human who is the grantee of an active grant on the calendar → the row is stamped (actor, no request) and NO request is created", async () => {
    const { ctx, bookingRequests, grants } = buildWithGrants();
    grants.findActiveForActor.mockResolvedValue({ id: "g1", placeId: DEFAULT_PLACE_ID });

    const result = await saveEventForHuman(ctx.deps, humanInput());

    expect(grants.findActiveForActor).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      calendarId: CALENDAR_ID,
      humanIds: [DEFAULT_ACTOR_ID],
      orgIds: [],
      now: NOW,
    });
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledWith({
      eventId: result.eventId,
      placeId: DEFAULT_PLACE_ID,
      confirmedByHumanId: DEFAULT_ACTOR_ID,
      bookingRequestId: null,
      at: NOW,
    });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "event", action: "event.place_confirmed_by_grant" }),
    );
    expect(bookingRequests.create).not.toHaveBeenCalled();
    expect("bookingRequestNotificationIntents" in result).toBe(false);
    expect(result.bookingRequest).toBeNull();
  });

  it("no grant → the human is a third party: the request is created, nothing is stamped, and the wire names the venue", async () => {
    const { ctx, bookingRequests, grants } = buildWithGrants();
    grants.findActiveForActor.mockResolvedValue(null);

    const result = await saveEventForHuman(ctx.deps, humanInput());

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ performerOwnerType: "human", performerOwnerId: DEFAULT_ACTOR_ID }),
    );
    expect(result.bookingRequest).toMatchObject({
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
      outcome: "created",
      parked: false,
    });
  });

  // Was: "an org owner never consults grants (the model is per human)".
  // FR-002 / H2: a grant may go to an org; its own event is confirmed by
  // construction, matched on the ORG as grantee.
  it("an org owner that is the grantee → the row is stamped; the lookup asks for the org", async () => {
    const { ctx, bookingRequests, grants } = buildWithGrants();
    grants.findActiveForActor.mockImplementation(
      async (input: { orgIds: readonly string[] }) =>
        input.orgIds.includes(DEFAULT_ORG_ID) ? { id: "g-org", placeId: DEFAULT_PLACE_ID } : null,
    );

    await saveEventForOrg(ctx.deps, makeInput());

    expect(grants.findActiveForActor).toHaveBeenCalledWith(
      expect.objectContaining({ humanIds: [], orgIds: [DEFAULT_ORG_ID], calendarId: CALENDAR_ID }),
    );
    expect(ctx.mocks.events.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(bookingRequests.create).not.toHaveBeenCalled();
  });

  it("an org owner with no grant → third party: asked, never stamped", async () => {
    const { ctx, bookingRequests, grants } = buildWithGrants();
    grants.findActiveForActor.mockResolvedValue(null);

    await saveEventForOrg(ctx.deps, makeInput());

    expect(ctx.mocks.events.setVenueConfirmation).not.toHaveBeenCalled();
    expect(bookingRequests.create).toHaveBeenCalledTimes(1);
  });
});
