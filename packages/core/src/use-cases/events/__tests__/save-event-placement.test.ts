import { describe, expect, it, vi } from "vitest";

import { saveEventForHuman } from "../save-event-for-human";
import { saveEventForOrg } from "../save-event-for-org";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  DEFAULT_SAVED_LOCATION_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { EventRecord } from "@th/ports/repos/events";

/**
 * Venue-hierarchy placement on the save path (Step 9,
 * docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml FR-005/FR-011).
 *
 * Acceptance: "Clicking an empty calendar cell lands on quick-create with
 * date, time, calendar, space and category prefilled; the created event carries
 * that spaceId and calendarId." These tests pin the second half — plus every
 * way a caller can get the placement WRONG, because the schema happily accepts
 * another place's Calendar/Space as an FK target and only this layer says no.
 */

const OTHER_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeOrgInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Warehouse Show",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T20:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    clientKey: "idem-key-1234",
    ...overrides,
  };
}

function makeHumanInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    title: "Living Space Set",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T20:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    clientKey: "idem-key-5678",
    ...overrides,
  };
}

/** Minimal existing-event row for the edit-path cases. */
function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PRIVATE",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2024-01-01T18:00:00.000Z"),
    endsAt: new Date("2024-01-01T20:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    defaultLocale: null,
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

const draftArgOf = (mocks: { events: { upsertDraft: unknown } }) =>
  vi.mocked(mocks.events.upsertDraft as never).mock.calls[0]![0] as {
    calendarId?: string | null;
    spaceId?: string | null;
  };

/** No row was written and no audit entry logged — the tx never got that far. */
function expectNoMutation(
  mocks: ReturnType<typeof makeCreateEventTestContext>["mocks"],
) {
  expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
  expect(mocks.audit.log).not.toHaveBeenCalled();
}

describe("saveEventForOrg — venue placement", () => {
  it("stamps calendarId + spaceId of the event's own place onto the created draft", async () => {
    const { deps, mocks, defaults } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
      name: "Live Music",
    });
    const space = mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID, name: "Main" });

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({ calendarId: calendar.id, spaceId: space.id }),
    );

    expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: calendar.id,
      spaceId: space.id,
    });
    // ONE write, inside ONE tx — never a second setVenuePlacement pass.
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("leaves spaceId null when only a calendar is given (never guesses a space)", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });
    // Two active spaces exist; the save path still must not pick one — the UI
    // only auto-picks when a calendar has EXACTLY one active space.
    mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID, name: "A" });
    mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID, name: "B" });

    await saveEventForOrg(deps, makeOrgInput({ calendarId: calendar.id }));

    const draft = draftArgOf(mocks);
    expect(draft.calendarId).toBe(calendar.id);
    expect(draft.spaceId ?? null).toBeNull();
  });

  it("rejects a calendar belonging to ANOTHER place and writes nothing", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const foreign = mocks.calendars.seedCalendar({ placeId: OTHER_PLACE_ID });

    await expect(
      saveEventForOrg(deps, makeOrgInput({ calendarId: foreign.id })),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expectNoMutation(mocks);
  });

  it("rejects a space belonging to ANOTHER place and writes nothing", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });
    const foreignSpace = mocks.spaces.seed({ placeId: OTHER_PLACE_ID });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ calendarId: calendar.id, spaceId: foreignSpace.id }),
      ),
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
    expectNoMutation(mocks);
  });

  it("reports an unknown calendar id exactly like a cross-place one", async () => {
    const { deps, mocks } = makeCreateEventTestContext();

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      ),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expectNoMutation(mocks);
  });

  it("rejects a RETIRED space — a retired space must not receive new events", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });
    const retired = mocks.spaces.seed({
      placeId: DEFAULT_PLACE_ID,
      name: "Old Back Space",
      status: "RETIRED",
    });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ calendarId: calendar.id, spaceId: retired.id }),
      ),
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
    expectNoMutation(mocks);
  });

  it("rejects placement on a FREEFORM-address event rather than dropping it", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({
          location: { addressText: "123 Main St", lat: 36.16, lng: -86.78 },
          calendarId: calendar.id,
        }),
      ),
      // The exact message pins that this is the PLACEMENT guard, not a stray
      // parse failure that happens to share the `invalid_input` code.
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "a calendar or space needs a linked place",
    });
    expectNoMutation(mocks);
  });

  it("rejects placement on an event with NO location at all", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const space = mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID });

    await expect(
      saveEventForOrg(deps, makeOrgInput({ location: {}, spaceId: space.id })),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "a calendar or space needs a linked place",
      issues: [{ path: ["spaceId"] }],
    });
    expectNoMutation(mocks);
  });

  it("rejects placement on a SAVED-LOCATION event (the third route to a null place)", async () => {
    // `location.savedLocationId` is the third way `resolveVenuePlacement` sees
    // `placeId === null` — alongside freeform and no-location, both pinned
    // above. It reaches the guard only because the saved location itself is
    // accessible to the org, so this really does exercise the placement
    // rejection rather than an earlier ownership failure.
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({
          location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
          calendarId: calendar.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "a calendar or space needs a linked place",
      issues: [{ path: ["calendarId"] }],
    });
    expectNoMutation(mocks);
  });

  it("accepts explicit nulls on a placeless event (clearing is not placing)", async () => {
    const { deps, mocks } = makeCreateEventTestContext();

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: {}, calendarId: null, spaceId: null }),
    );

    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: null,
      spaceId: null,
    });
  });

  it("leaves a stored placement UNTOUCHED when an edit omits it and keeps the place", async () => {
    const existingEvent = makeExistingEvent({
      calendarId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      spaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });

    await saveEventForOrg(
      deps,
      makeOrgInput({ eventId: DEFAULT_EVENT_ID, clientKey: "edit-key-1234" }),
    );

    const draft = draftArgOf(mocks);
    // Absent keys = Prisma patch semantics = the stored values survive.
    expect("calendarId" in draft).toBe(false);
    expect("spaceId" in draft).toBe(false);
  });

  it("leaves a stored placement UNTOUCHED when a RE-SENT same place rides along with other edits", async () => {
    // The sibling test above changes only the title. This one rewrites most of
    // the event — title, times, timezone, label, visibility — while RE-SENDING
    // the same `location.placeId`, which is exactly what the builder does on
    // every save. It pins that `placeChanged` is keyed on the resolved place
    // being DIFFERENT, not on "this save touched the event": a regression that
    // force-cleared on any edit would clear a live venue's calendar/space here
    // and nowhere else in this file.
    const existingEvent = makeExistingEvent({
      placeId: DEFAULT_PLACE_ID,
      calendarId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      spaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        clientKey: "edit-key-3456",
        location: { placeId: DEFAULT_PLACE_ID },
        title: "Renamed Warehouse Show",
        startsAt: "2024-03-09T01:00:00.000Z",
        endsAt: "2024-03-09T04:00:00.000Z",
        timezone: "America/New_York",
        locationLabel: "Back entrance, ring the bell",
      }),
    );

    const draft = draftArgOf(mocks);
    // Both columns ABSENT — Prisma patch semantics, so the stored placement
    // survives untouched.
    expect("calendarId" in draft).toBe(false);
    expect("spaceId" in draft).toBe(false);
    // Guard against a vacuous pass: the save really did rewrite the row.
    expect((draft as { title?: string }).title).toBe("Renamed Warehouse Show");
  });

  it("CLEARS a stale placement when an edit moves the event to another place", async () => {
    const existingEvent = makeExistingEvent({
      placeId: OTHER_PLACE_ID,
      calendarId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      spaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });

    await saveEventForOrg(
      deps,
      makeOrgInput({ eventId: DEFAULT_EVENT_ID, clientKey: "edit-key-5678" }),
    );

    // The old venue's Calendar/Space must not survive the move.
    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: null,
      spaceId: null,
    });
  });

  it("clears the unspecified side when a move supplies only the new calendar", async () => {
    const existingEvent = makeExistingEvent({
      placeId: OTHER_PLACE_ID,
      calendarId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      spaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        clientKey: "edit-key-9012",
        calendarId: calendar.id,
      }),
    );

    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: calendar.id,
      spaceId: null,
    });
  });

  // ── Calendar/space coherence on a calendar SWITCH (ruling 2026-09-22) ─────
  // The builder stopped sending `spaceId` when the room came off the booking
  // request. Omission is patch semantics ("leave the stored room alone"),
  // which protects a room the VENUE assigned at accept — but it let an
  // organizer switch calendars and strand the event in the OLD calendar's
  // room, which `resolveVenuePlacement` never checked (it validates a space
  // against the PLACE, never against the calendar).

  /** Stable ids so the stored event can name a calendar seeded afterwards. */
  const MAIN_CALENDAR_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
  const SIDE_CALENDAR_ID = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
  const ROOM_A_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  it("(a) CLEARS the room when the save switches to a calendar that does not own it", async () => {
    // Stored: Main + Room A. The builder sends the new calendar and says
    // NOTHING about the space, as it now always does.
    const existingEvent = makeExistingEvent({
      calendarId: MAIN_CALENDAR_ID,
      spaceId: ROOM_A_ID,
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    mocks.calendars.seedCalendar({ id: MAIN_CALENDAR_ID, placeId: DEFAULT_PLACE_ID, name: "Main" });
    mocks.calendars.seedCalendar({ id: SIDE_CALENDAR_ID, placeId: DEFAULT_PLACE_ID, name: "Side" });
    mocks.spaces.seed({ id: ROOM_A_ID, placeId: DEFAULT_PLACE_ID, name: "Room A" });
    mocks.calendars.joins.set(MAIN_CALENDAR_ID, [ROOM_A_ID]);
    mocks.calendars.joins.set(SIDE_CALENDAR_ID, []);

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        clientKey: "switch-clear-1234",
        calendarId: SIDE_CALENDAR_ID,
      }),
    );

    // Written explicitly as null — NOT left absent, which would strand the
    // event in Main's room while its calendar says Side.
    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: SIDE_CALENDAR_ID,
      spaceId: null,
    });
  });

  it("(b) PRESERVES the room when the new calendar DOES own it — the venue's choice survives", async () => {
    // The case that fails if the membership condition is inverted: the room
    // is joined to BOTH calendars, so switching streams must not touch it.
    const existingEvent = makeExistingEvent({
      calendarId: MAIN_CALENDAR_ID,
      spaceId: ROOM_A_ID,
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    mocks.calendars.seedCalendar({ id: MAIN_CALENDAR_ID, placeId: DEFAULT_PLACE_ID, name: "Main" });
    mocks.calendars.seedCalendar({ id: SIDE_CALENDAR_ID, placeId: DEFAULT_PLACE_ID, name: "Side" });
    mocks.spaces.seed({ id: ROOM_A_ID, placeId: DEFAULT_PLACE_ID, name: "Shared Room" });
    mocks.calendars.joins.set(MAIN_CALENDAR_ID, [ROOM_A_ID]);
    mocks.calendars.joins.set(SIDE_CALENDAR_ID, [ROOM_A_ID]);

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        clientKey: "switch-keep-1234",
        calendarId: SIDE_CALENDAR_ID,
      }),
    );

    const draft = draftArgOf(mocks);
    expect(draft.calendarId).toBe(SIDE_CALENDAR_ID);
    // Absent = patch semantics = the stored room survives untouched.
    expect("spaceId" in draft).toBe(false);
  });

  it("(c) leaves the room alone when the calendar is UNCHANGED and the space is omitted", async () => {
    // Re-saving an event without moving it must never re-open the question,
    // and must not cost a calendar read.
    const existingEvent = makeExistingEvent({
      calendarId: MAIN_CALENDAR_ID,
      spaceId: ROOM_A_ID,
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    mocks.calendars.seedCalendar({ id: MAIN_CALENDAR_ID, placeId: DEFAULT_PLACE_ID, name: "Main" });
    // The room is NOT joined to the calendar — if the guard fired on an
    // unchanged calendar it would clear here, which is exactly what must not
    // happen (that room may be a venue's deliberate off-calendar placement).
    mocks.spaces.seed({ id: ROOM_A_ID, placeId: DEFAULT_PLACE_ID, name: "Room A" });
    mocks.calendars.joins.set(MAIN_CALENDAR_ID, []);
    const listByPlace = vi.spyOn(mocks.calendars, "listByPlace");

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        clientKey: "switch-noop-1234",
        calendarId: MAIN_CALENDAR_ID,
      }),
    );

    expect("spaceId" in draftArgOf(mocks)).toBe(false);
    expect(listByPlace).not.toHaveBeenCalled();
  });

  it("treats a replay of the same clientKey with DIFFERENT placement as a conflict", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendarA = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
      name: "A",
    });
    const calendarB = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
      name: "B",
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ calendarId: calendarA.id, clientKey: "same-key-1234" }),
    );

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ calendarId: calendarB.id, clientKey: "same-key-1234" }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });
});

describe("saveEventForHuman — venue placement", () => {
  it("stamps calendarId + spaceId onto a human-owned draft", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const calendar = mocks.calendars.seedCalendar({
      placeId: DEFAULT_PLACE_ID,
    });
    const space = mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID });

    await saveEventForHuman(
      deps,
      makeHumanInput({ calendarId: calendar.id, spaceId: space.id }),
    );

    expect(draftArgOf(mocks)).toMatchObject({
      calendarId: calendar.id,
      spaceId: space.id,
    });
  });

  it("rejects another place's space and writes nothing", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const foreignSpace = mocks.spaces.seed({ placeId: OTHER_PLACE_ID });

    await expect(
      saveEventForHuman(deps, makeHumanInput({ spaceId: foreignSpace.id })),
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
    expectNoMutation(mocks);
  });

  it("rejects placement on a freeform-address human event", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const space = mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID });

    await expect(
      saveEventForHuman(
        deps,
        makeHumanInput({
          location: { addressText: "1 Test Rd", lat: 1, lng: 2 },
          spaceId: space.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "a calendar or space needs a linked place",
    });
    expectNoMutation(mocks);
  });

  it("rejects a non-uuid placement id at the parse boundary", async () => {
    const { deps, mocks } = makeCreateEventTestContext();

    await expect(
      saveEventForHuman(deps, makeHumanInput({ calendarId: "not-a-uuid" })),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "invalid_input",
    });
    expectNoMutation(mocks);
  });
});
