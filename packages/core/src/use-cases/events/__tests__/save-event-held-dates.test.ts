import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { TxRepos } from "@th/ports/repos";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { createFakeBookingHoldsRepo } from "../../booking-holds/__tests__/fakes";
import { saveEventForOrg } from "../save-event-for-org";

// ─────────────────────────────────────────────────────────────────────────────
// FR-018 on the SAVE path: a PUBLISHED event moved onto a calendar+date takes
// that date from the holds on it. The line mechanics are pinned by the
// helper's own suite (booking-holds/__tests__/settle-held-dates-…); here the
// helper is a boundary and what is pinned is WHEN the save calls it, what it
// hands over, and how the result rides the output.
// ─────────────────────────────────────────────────────────────────────────────

const settleHeldDatesForEvent = vi.fn();
vi.mock("../../booking-holds/settle-held-dates-for-published-event", () => ({
  settleHeldDatesForEvent: (...args: unknown[]) => settleHeldDatesForEvent(...args),
}));
/** The real helper, for the integration cases at the bottom (the mock above routes to it on demand). */
const actual = await vi.importActual<typeof import("../../booking-holds/settle-held-dates-for-published-event")>(
  "../../booking-holds/settle-held-dates-for-published-event",
);

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_CALENDAR_ID = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NONE = { confirmed: [], released: [], intents: [], staffRecipientHint: null };
const OWED = {
  confirmed: [],
  released: [{ id: HOLD_ID }],
  intents: [
    { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2024-02-02", reason: "EVENT_SCHEDULED" },
  ],
  staffRecipientHint: { assigneeHumanId: null, placedByHumanId: DEFAULT_ACTOR_ID, orgId: DEFAULT_ORG_ID, placeId: DEFAULT_PLACE_ID },
};

function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2024-02-01T18:00:00.000Z"),
    endsAt: new Date("2024-02-01T19:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    spaceId: null,
    calendarId: CALENDAR_ID,
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
    publishedAt: new Date("2024-01-01T00:00:00.000Z"),
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "CLOSED",
    ...overrides,
  } as EventRecord;
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    eventId: DEFAULT_EVENT_ID,
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Existing",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T19:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    timezone: "America/Chicago",
    calendarId: CALENDAR_ID,
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

function build(existing: EventRecord) {
  const ctx = makeCreateEventTestContext({ existingEvent: existing });
  ctx.mocks.calendars.seedCalendar({ id: CALENDAR_ID, placeId: DEFAULT_PLACE_ID });
  ctx.mocks.calendars.seedCalendar({ id: OTHER_CALENDAR_ID, placeId: DEFAULT_PLACE_ID });
  return ctx;
}

beforeEach(() => {
  settleHeldDatesForEvent.mockReset();
  settleHeldDatesForEvent.mockResolvedValue(NONE);
});

describe("finalizeSaveEvent — FR-018 held dates", () => {
  it("PUBLISHED event moved to another day on its calendar → the helper takes the new date, inside the tx, with the saved row", async () => {
    const ctx = build(makeExistingEvent());
    settleHeldDatesForEvent.mockResolvedValue(OWED);

    const result = await saveEventForOrg(
      ctx.deps,
      makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }),
    );

    expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
    const [tx, args] = settleHeldDatesForEvent.mock.calls[0]!;
    // Called with the tx bag (the same repos the save writes through).
    expect(tx).toMatchObject({ bookingRequestMessages: expect.anything(), events: expect.anything() });
    expect(args).toMatchObject({
      event: expect.objectContaining({ id: DEFAULT_EVENT_ID, calendarId: CALENDAR_ID, startsAt: new Date("2024-02-02T19:00:00.000Z") }),
      actorHumanId: DEFAULT_ACTOR_ID,
      now: expect.any(Date),
      // The owner rides along so the helper can re-check place access (the
      // same-place save skipped its own gate).
      owner: { kind: "org", orgId: DEFAULT_ORG_ID },
    });
    // The intents ride the LIVE output for transport to dispatch post-commit.
    expect(result).toMatchObject({
      eventId: DEFAULT_EVENT_ID,
      status: "PUBLISHED",
      notificationIntents: OWED.intents,
      staffRecipientHint: OWED.staffRecipientHint,
    });
  });

  it("PUBLISHED event moved onto ANOTHER calendar (same day) → the helper takes the line on the new calendar", async () => {
    const ctx = build(makeExistingEvent());

    await saveEventForOrg(ctx.deps, makeInput({ calendarId: OTHER_CALENDAR_ID }));

    expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
    expect(settleHeldDatesForEvent.mock.calls[0]![1]).toMatchObject({
      event: expect.objectContaining({ calendarId: OTHER_CALENDAR_ID }),
    });
  });

  it("DRAFT event moved → nothing (drafts are pencil-ins)", async () => {
    const ctx = build(makeExistingEvent({ status: "DRAFT", publishedAt: null }));

    await saveEventForOrg(ctx.deps, makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }));

    expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
  });

  it("PUBLISHED event saved with an unchanged start and calendar (retitle) → nothing", async () => {
    const ctx = build(makeExistingEvent());

    await saveEventForOrg(ctx.deps, makeInput({ title: "Renamed" }));

    expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
  });

  it("PUBLISHED event moved OFF its calendar (calendar cleared) → nothing; a released hold is terminal (FR-019)", async () => {
    const ctx = build(makeExistingEvent());

    await saveEventForOrg(ctx.deps, makeInput({ calendarId: null }));

    expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
  });

  it("nothing owed → the output carries no intents key at all", async () => {
    const ctx = build(makeExistingEvent());

    const result = await saveEventForOrg(
      ctx.deps,
      makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }),
    );

    expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
    expect("notificationIntents" in result).toBe(false);
    expect("staffRecipientHint" in result).toBe(false);
  });

  it("an idempotent replay returns the cached response WITHOUT the intents, and never re-runs the helper", async () => {
    const ctx = build(makeExistingEvent());
    settleHeldDatesForEvent.mockResolvedValue(OWED);
    const input = makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" });

    const first = await saveEventForOrg(ctx.deps, input);
    const replay = await saveEventForOrg(ctx.deps, input);

    expect(first.notificationIntents).toEqual(OWED.intents);
    expect(replay).toEqual({ eventId: DEFAULT_EVENT_ID, status: "PUBLISHED", bookingRequest: null });
    expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
  });

  it("the helper refusing (open challenge on the new line) rolls the save back: the error propagates and the idempotency claim is failed", async () => {
    const ctx = build(makeExistingEvent());
    settleHeldDatesForEvent.mockRejectedValue({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE", meta: {} });

    await expect(
      saveEventForOrg(ctx.deps, makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" })),
    ).rejects.toMatchObject({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE" });
    expect(ctx.deps.idempotency.fail).toHaveBeenCalled();
    expect(ctx.deps.idempotency.commit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: the REAL helper through the save's own tx, the way
// publish-event.test.ts pins publish. The hold fakes are the ones the hold
// use cases run against; what is asserted is the hold rows after the save.
// ─────────────────────────────────────────────────────────────────────────────

describe("finalizeSaveEvent — FR-018 held dates (real helper)", () => {
  const REQUEST_A = "44444444-4444-4444-8444-444444444444";
  const REQUEST_B = "45454545-4545-4545-8545-454545454545";
  /** 2024-02-02 19:00Z = 13:00 America/Chicago — the place-local day the move lands on. */
  const MOVED_TO = "2024-02-02";

  function withRealHolds(existing: EventRecord) {
    const ctx = build(existing);
    const bookingHolds = createFakeBookingHoldsRepo();
    const messages = createFakeBookingRequestMessagesRepo();
    const requests = new Map([
      [REQUEST_A, { id: REQUEST_A, assigneeHumanId: null, status: "PENDING", agreementId: null }],
      [REQUEST_B, { id: REQUEST_B, assigneeHumanId: null, status: "PENDING", agreementId: null }],
    ]);
    const extra = {
      bookingHolds,
      bookingRequestMessages: messages,
      bookingRequests: {
        getById: vi.fn(async (id: string) => requests.get(id) ?? null),
        findByAgreementId: vi.fn(async () => null),
        touchLastMessageAt: vi.fn(async () => undefined),
        // Event-first (venue-confirmation spec): a third-party save at a
        // place + calendar looks for its origin request first; none here,
        // and the fixture org has no performer mode, so the hook skips
        // (`sender_not_eligible`) and these tests stay about the holds.
        findByOriginEventId: vi.fn(async () => null),
      },
      eventDates: { listByEvent: vi.fn(async () => []) },
      authz: { ...ctx.mocks.authz, getOrgMemberships: vi.fn(async () => []) },
    };
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = vi.fn(
      async <T>(fn: (tx: TxRepos) => Promise<T>): Promise<T> =>
        originalTx(async (tx) => {
          Object.assign(tx, extra);
          return fn(tx);
        }),
    ) as typeof originalTx;
    settleHeldDatesForEvent.mockImplementation(actual.settleHeldDatesForEvent as never);
    return {
      ctx,
      bookingHolds,
      extra,
      seedHold: (bookingRequestId: string, overrides: Record<string, unknown> = {}) =>
        bookingHolds.seed({ bookingRequestId, calendarId: CALENDAR_ID, date: MOVED_TO, placedByHumanId: DEFAULT_ACTOR_ID, ...overrides }),
      entries: (requestId: string) =>
        [...messages.rows.values()].filter((r) => r.bookingRequestId === requestId && r.systemKind).map((r) => ({ kind: r.systemKind, data: r.systemData })),
    };
  }

  it("PUBLISHED event moved onto a held line releases the holds (EVENT_SCHEDULED) and the intents + hint ride the output", async () => {
    const h = withRealHolds(makeExistingEvent());
    const a = h.seedHold(REQUEST_A);
    const b = h.seedHold(REQUEST_B);
    const elsewhere = h.seedHold(REQUEST_B, { date: "2024-02-03" });

    const result = await saveEventForOrg(
      h.ctx.deps,
      makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }),
    );

    expect(result.status).toBe("PUBLISHED");
    expect(h.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(h.bookingHolds.rows.get(b.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(h.bookingHolds.rows.get(elsewhere.id)?.status).toBe("ACTIVE");
    expect(h.entries(REQUEST_A)).toEqual([{ kind: "booking_hold.released", data: { holdId: a.id, reason: "EVENT_SCHEDULED" } }]);
    expect(result.notificationIntents?.map((i) => [i.kind, i.audience, i.holdId])).toEqual([
      ["hold.released", "act", a.id],
      ["hold.released", "staff", a.id],
      ["hold.released", "act", b.id],
      ["hold.released", "staff", b.id],
    ]);
    expect(result.staffRecipientHint).toEqual({
      assigneeHumanId: null,
      placedByHumanId: DEFAULT_ACTOR_ID,
      orgId: DEFAULT_ORG_ID,
      placeId: DEFAULT_PLACE_ID,
    });
  });

  // Booking-holds spec (locked 2026-09-07): only a venue-owned or
  // venue-confirmed event takes a line. A third-party org's published event
  // moved onto a held date at a venue that has not confirmed it settles
  // nothing — and, unlike before the gate, does not throw at the owner.
  it("an UNCONFIRMED third-party event moved onto a held line settles nothing and does not throw: the holds stay live, the save commits", async () => {
    const h = withRealHolds(makeExistingEvent());
    const OTHER_VENUE_ORG = "99999999-9999-4999-8999-999999999999";
    // The place is owned by ANOTHER org; the event's org is a third party.
    Object.assign(h.extra, {
      places: {
        getById: vi.fn(async (id: string) =>
          id === DEFAULT_PLACE_ID
            ? { id, name: "Test Venue", timezone: "America/Chicago", status: "ACTIVE", orgIdsWithAccess: [OTHER_VENUE_ORG], humanIdsWithAccess: [] }
            : null,
        ),
        // P-1: `prepareEventTaxRate` reads the place through the ROOT fake
        // (cold cache → provider answers) BEFORE the tx opens. Inside the tx,
        // `commitPreparedEventTaxRate` re-reads the place through THIS
        // override, which carries no address columns, so the address differs
        // from the one prepared: the prepared rate is dropped, the stamp is
        // re-resolved from this row (no cached rate → NULL), and no cache
        // write is made. `updateTaxRate` is never called; it stays as an inert
        // stub. Do not "fix" this by moving the read back inside the tx — the
        // read is out there on purpose (HTTP out of the transaction).
        updateTaxRate: vi.fn(async () => undefined),
      },
    });
    const a = h.seedHold(REQUEST_A);

    const result = await saveEventForOrg(
      h.ctx.deps,
      makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }),
    );

    expect(result.status).toBe("PUBLISHED");
    expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
    expect(h.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(h.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(h.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    expect("notificationIntents" in result).toBe(false);
    // The event-first hook's refusal (no performer mode) now reaches the
    // wire instead of collapsing to null — which is why the place fake
    // needs a `name`: the builder is told which venue is not taking it.
    expect(result.bookingRequest).toMatchObject({
      outcome: "skipped",
      reason: "sender_not_eligible",
      code: "PERFORMER_MODE_REQUIRED",
      placeId: DEFAULT_PLACE_ID,
      placeName: "Test Venue",
    });
  });

  it("a VENUE-CONFIRMED third-party event (active stamp) moved onto a held line takes it", async () => {
    const h = withRealHolds(
      makeExistingEvent({
        venueConfirmedAt: new Date("2024-01-15T00:00:00.000Z"),
        venueConfirmedPlaceId: DEFAULT_PLACE_ID,
        venueConfirmationWithdrawnAt: null,
      } as Partial<EventRecord>),
    );
    Object.assign(h.extra, {
      places: {
        getById: vi.fn(async (id: string) =>
          id === DEFAULT_PLACE_ID
            ? { id, name: "Test Venue", timezone: "America/Chicago", status: "ACTIVE", orgIdsWithAccess: ["99999999-9999-4999-8999-999999999999"], humanIdsWithAccess: [] }
            : null,
        ),
        // P-1: `prepareEventTaxRate` reads the place through the ROOT fake
        // (cold cache → provider answers) BEFORE the tx opens. Inside the tx,
        // `commitPreparedEventTaxRate` re-reads the place through THIS
        // override, which carries no address columns, so the address differs
        // from the one prepared: the prepared rate is dropped, the stamp is
        // re-resolved from this row (no cached rate → NULL), and no cache
        // write is made. `updateTaxRate` is never called; it stays as an inert
        // stub. Do not "fix" this by moving the read back inside the tx — the
        // read is out there on purpose (HTTP out of the transaction).
        updateTaxRate: vi.fn(async () => undefined),
      },
    });
    const a = h.seedHold(REQUEST_A);

    const result = await saveEventForOrg(
      h.ctx.deps,
      makeInput({ startsAt: "2024-02-02T19:00:00.000Z", endsAt: "2024-02-02T22:00:00.000Z" }),
    );

    expect(result.status).toBe("PUBLISHED");
    expect(h.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
  });

  it("PUBLISHED event moved OFF the place clears the calendar and settles nothing — the holds stay live (FR-019: nothing to restore either)", async () => {
    const h = withRealHolds(makeExistingEvent());
    const a = h.seedHold(REQUEST_A, { date: "2024-02-01" });

    const result = await saveEventForOrg(
      h.ctx.deps,
      makeInput({
        location: { addressText: "1 Elsewhere St", lat: 36.16, lng: -86.78 },
        calendarId: undefined,
      }),
    );

    expect(result.status).toBe("PUBLISHED");
    const saved = h.ctx.mocks.events.upsertDraft.mock.calls.at(-1)![0] as { calendarId?: string | null };
    expect(saved.calendarId ?? null).toBeNull();
    expect(h.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(h.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(h.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    expect("notificationIntents" in result).toBe(false);
  });
});
