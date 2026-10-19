import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_ID,
  EVENT_ID,
  NOW,
  OTHER_REQUEST_ID,
  PLACE_ID,
  REQUEST_ID,
  REQUESTER_ID,
  STRANGER_ID,
  VENUE_ORG_ID,
  VIEWER_ID,
  buildVenueConfirmationContext,
} from "@th/core/use-cases/events/__tests__/venue-confirmation-test-context";

import { venueConfirmationRouter } from "../venue-confirmation";
import { createCaller } from "./test-helpers";

// The post-commit dispatchers are the TWO seams the router touches for
// notifications (the owner's "confirmed" notice; the booking-hold intents a
// confirmation owes when it took the line). Mocked at the module boundary so
// every test can assert "called after the use case with its intents" and "a
// throw is swallowed" without a mailer.
/**
 * R3-1: every confirm carries the start the venue SAW. The shared fixture
 * event starts at the stage builder's default.
 */
const SEEN_STARTS_AT = "2026-09-19T00:00:00.000Z";

vi.mock("@th/core/use-cases/events/notify-venue-confirmation-intents", () => ({
  dispatchVenueConfirmationIntents: vi.fn(async () => undefined),
  buildVenueConfirmationIdempotencyKey: vi.fn(),
  VENUE_CONFIRMATION_VARIANTS: {},
}));
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
// The shared mint, DELEGATING to the real one by default (every existing
// test is unaffected) so one test can capture the deps the router's
// composition hands it (lineup v2 FR-006: `publicAppUrl`).
vi.mock(
  "@th/core/use-cases/booking-agreements/create-event-from-agreement",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@th/core/use-cases/booking-agreements/create-event-from-agreement")
    >();
    return {
      ...actual,
      createEventFromAgreement: vi.fn(
        (...args: Parameters<typeof actual.createEventFromAgreement>) =>
          actual.createEventFromAgreement(...args),
      ),
    };
  },
);
import { dispatchVenueConfirmationIntents } from "@th/core/use-cases/events";
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";
import { createEventFromAgreement } from "@th/core/use-cases/booking-agreements/create-event-from-agreement";

/**
 * Transport contract for `venueConfirmation.*` (venue-confirmation-and-
 * booking-intents spec, docs/specs/2026-08-27, Step 3).
 *
 * The router is thin, so what is pinned HERE is transport-only:
 *   - every procedure needs an authed actor (UNAUTHORIZED without one);
 *   - `actorHumanId` comes from ctx — a client-supplied one is rejected by
 *     the `.strict()`-derived input (BAD_REQUEST), never honoured;
 *   - typed use-case errors map through `toTrpcError` to the right code;
 *   - `notificationIntents` NEVER cross the wire;
 *   - the intents dispatcher fires AFTER the use case returns, with the
 *     intents the use case computed, and its failure is swallowed + reported
 *     — a notify outage never fails a committed confirmation.
 *
 * The domain itself (authority, stamp/withdraw semantics, ledger) is covered
 * in core.
 */

const dispatchMock = vi.mocked(dispatchVenueConfirmationIntents);
const dispatchHoldMock = vi.mocked(dispatchBookingHoldIntents);
const MISSING_EVENT_ID = "00000000-0000-4000-8000-00000000dead";

function build(
  actorHumanId: string | null = EDITOR_ID,
  options: Parameters<typeof buildVenueConfirmationContext>[0] = {},
) {
  const harness = buildVenueConfirmationContext(options);
  const reportError = vi.fn();
  const { caller, ctx } = createCaller(venueConfirmationRouter, {
    repos: harness.repos,
    clock: { now: () => NOW },
    idempotency: harness.idempotency,
    actorHumanId,
    reportError,
    publicAppUrl: "https://ithasfire.test",
  });
  return { ...harness, caller, ctx, reportError };
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
  dispatchHoldMock.mockReset();
  dispatchHoldMock.mockResolvedValue(undefined);
});

describe("venueConfirmationRouter — auth + actor injection", () => {
  it("rejects an anonymous caller with UNAUTHORIZED on both procedures", async () => {
    const { caller, eventsRepo } = build(null);
    await expect(caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.withdraw({ eventId: EVENT_ID, reason: "Double booked" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    expect(eventsRepo.withdrawVenueConfirmation).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one (.strict omit)", async () => {
    const { caller, events } = build();
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID, actorHumanId: STRANGER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID, actorHumanId: STRANGER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.withdraw({
        eventId: EVENT_ID,
        reason: "Not ours",
        actorHumanId: STRANGER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { event } = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    expect(event.venueConfirmedByHumanId).toBe(EDITOR_ID);
    expect(events.get(EVENT_ID)?.venueConfirmedByHumanId).toBe(EDITOR_ID);
  });
});

describe("venueConfirmationRouter — R3-1: the start the venue saw", () => {
  it("a missing expectedStartsAt is a BAD_REQUEST on both variants, before any write", async () => {
    const { caller, eventsRepo } = build();
    await expect(caller.confirm({ eventId: EVENT_ID } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.confirm({ bookingRequestId: REQUEST_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("a stale date maps EVENT_MOVED to 409 CONFLICT with the current start, and writes nothing", async () => {
    const { caller, eventsRepo, events } = build();
    const error = await caller
      .confirm({ expectedStartsAt: "2026-12-10T01:00:00.000Z", eventId: EVENT_ID })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "CONFLICT",
      message: "EVENT_MOVED",
    });
    expect(eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    expect(events.get(EVENT_ID)?.venueConfirmedAt ?? null).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("venueConfirmationRouter — error mapping", () => {
  it("maps a stranger (NOT_RESOURCE_OWNER) to FORBIDDEN — the gate lives in core", async () => {
    const { caller, eventsRepo } = build(STRANGER_ID);
    await expect(caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("maps a VIEWER (INSUFFICIENT_ROLE) to FORBIDDEN", async () => {
    const { caller } = build(VIEWER_ID);
    await expect(
      caller.withdraw({ eventId: EVENT_ID, reason: "Not ours" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps an unknown event (EVENT_NOT_FOUND) to NOT_FOUND", async () => {
    const { caller } = build();
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: MISSING_EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.withdraw({ eventId: MISSING_EVENT_ID, reason: "Not ours" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps a request at another place (INVALID_INPUT) to BAD_REQUEST", async () => {
    const OTHER_PLACE_ID = "34343434-3434-4343-8343-343434343434";
    const { caller } = build(EDITOR_ID, {
      requests: [{ id: REQUEST_ID, placeId: OTHER_PLACE_ID }],
    });
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps withdrawing a venue-owned event (INVALID_STATUS) to CONFLICT", async () => {
    const { caller } = build(EDITOR_ID, {
      event: { orgId: VENUE_ORG_ID, humanId: null },
    });
    await expect(
      caller.withdraw({ eventId: EVENT_ID, reason: "Not ours" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("venueConfirmationRouter — wire output strips intents", () => {
  it("confirm: returns { event, alreadyConfirmed, minted } only; no intent nor the routing hint crosses the wire", async () => {
    const { caller } = build();
    const result = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });

    expect(Object.keys(result).sort()).toEqual(["alreadyConfirmed", "event", "minted"]);
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("holdNotificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(result).toMatchObject({
      alreadyConfirmed: false,
      minted: false,
      event: {
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        venueConfirmed: true,
        venueOwned: false,
        stamped: true,
        venueConfirmedAt: NOW,
        venueConfirmedByHumanId: EDITOR_ID,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(REQUESTER_ID);
  });

  it("withdraw: returns { event, alreadyWithdrawn } only", async () => {
    const { caller } = build();
    await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    const result = await caller.withdraw({
      eventId: EVENT_ID,
      reason: "Double booked that night",
    });

    expect(Object.keys(result).sort()).toEqual(["alreadyWithdrawn", "event"]);
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).toMatchObject({
      alreadyWithdrawn: false,
      event: {
        venueConfirmed: false,
        // `stamped` = an ACTIVE stamp; the withdrawal clears it for readers.
        stamped: false,
        venueConfirmationWithdrawnAt: NOW,
        venueConfirmationWithdrawnReason: "Double booked that night",
      },
    });
  });
});

describe("venueConfirmationRouter — post-commit intents dispatch", () => {
  it("confirm fires the dispatcher after the use case with the owed intent", async () => {
    const { caller, ctx, eventsRepo } = build();
    await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID, bookingRequestId: undefined });

    expect(eventsRepo.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [deps, args] = dispatchMock.mock.calls[0]!;
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.notify).toBe(ctx.notify);
    expect(deps.publicAppUrl).toBe("https://ithasfire.test");
    expect(args.intents).toEqual([
      expect.objectContaining({
        kind: "event.place_confirmed",
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        recipient: { type: "human", humanId: REQUESTER_ID },
        at: NOW,
      }),
    ]);
  });

  it("withdraw fires the dispatcher with the reason on the intent", async () => {
    const { caller } = build();
    await caller.withdraw({ eventId: EVENT_ID, reason: "Not ours" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect(args.intents).toEqual([
      expect.objectContaining({
        kind: "event.place_confirmation_withdrawn",
        eventId: EVENT_ID,
        reason: "Not ours",
        recipient: { type: "human", humanId: REQUESTER_ID },
      }),
    ]);
  });

  it("prefers notifyWithEmail when the composition root bound it", async () => {
    const harness = buildVenueConfirmationContext();
    const notifyWithEmail = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(venueConfirmationRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: EDITOR_ID,
      notifyWithEmail: notifyWithEmail as never,
    });
    await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    expect(dispatchMock.mock.calls[0]![0].notify).toBe(notifyWithEmail);
  });

  it("swallows + reports a dispatcher failure; the committed mutation still returns", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("mailer down"));
    const { caller, reportError, events } = build();

    const result = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });

    expect(result.event.venueConfirmed).toBe(true);
    expect(events.get(EVENT_ID)?.venueConfirmedAt).toEqual(NOW);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "venue_confirmation", step: "notify_intents" },
        extra: expect.objectContaining({
          eventId: EVENT_ID,
          kinds: ["event.place_confirmed"],
        }),
      }),
    );
  });

  it("survives a THROWING reporter on top of a failing dispatcher", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("mailer down"));
    const harness = buildVenueConfirmationContext();
    const { caller } = createCaller(venueConfirmationRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: EDITOR_ID,
      reportError: vi.fn(() => {
        throw new Error("sentry down too");
      }),
    });
    await expect(
      caller.withdraw({ eventId: EVENT_ID, reason: "Not ours" }),
    ).resolves.toMatchObject({ event: { venueConfirmed: false } });
  });

  it("does not dispatch when the use case throws (nothing committed)", async () => {
    const { caller } = build(STRANGER_ID);
    await expect(caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID })).rejects.toBeTruthy();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips the dispatcher when a replay owes no intents (already confirmed)", async () => {
    const { caller } = build();
    await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    dispatchMock.mockClear();

    const replay = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    expect(replay.alreadyConfirmed).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips the dispatcher for a venue-owned confirm (the venue telling itself)", async () => {
    const { caller } = build(EDITOR_ID, {
      event: { orgId: VENUE_ORG_ID, humanId: null },
    });
    const result = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID });
    expect(result.event.venueOwned).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request variant + confirmation takes the line (booking-holds spec,
// 2026-09-07): the hold intents ride the LIVE output and are dispatched
// post-commit through the same hook `events.publishEvent` uses.
// ─────────────────────────────────────────────────────────────────────────────

describe("venueConfirmationRouter — by booking request", () => {
  it("accepts { bookingRequestId, ownerOverride? } and confirms the request's origin event", async () => {
    const { caller, events } = build(EDITOR_ID, {
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, intent: "RENT" }],
    });

    const result = await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID, ownerOverride: "requester" });

    expect(Object.keys(result).sort()).toEqual(["alreadyConfirmed", "event", "minted"]);
    expect(result).toMatchObject({
      alreadyConfirmed: false,
      minted: false,
      event: { eventId: EVENT_ID, venueConfirmed: true, venueConfirmationRequestId: REQUEST_ID },
    });
    expect(events.get(EVENT_ID)?.venueConfirmationRequestId).toBe(REQUEST_ID);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1].intents).toEqual([
      expect.objectContaining({ kind: "event.place_confirmed", eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
    ]);
  });

  // booking-the-night N15 / FR-011 (P2c): a request NOT built from an event
  // is refused before anything is read, minted or stamped — the night is
  // booked by agreeing terms, never by a venue confirmation.
  it("a request with no origin event → BAD_REQUEST, appCode VENUE_CONFIRMATION_NOT_FOR_REQUESTS; never mints, dispatches nothing", async () => {
    const AGREEMENT = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
    const harness = build(EDITOR_ID, {
      requests: [{ id: REQUEST_ID, agreementId: AGREEMENT, status: "ACCEPTED" }],
      agreements: [{ id: AGREEMENT }],
    });

    await expect(
      harness.caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      meta: expect.objectContaining({ appCode: "VENUE_CONFIRMATION_NOT_FOR_REQUESTS" }),
    });
    expect(vi.mocked(createEventFromAgreement)).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(dispatchHoldMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown ownerOverride value (BAD_REQUEST) and an open request with no origin event (FR-011)", async () => {
    const { caller } = build(EDITOR_ID, { requests: [{ id: REQUEST_ID, status: "PENDING" }] });
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID, ownerOverride: "act" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ meta: expect.objectContaining({ appCode: "VENUE_CONFIRMATION_NOT_FOR_REQUESTS" }) });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("venueConfirmationRouter — confirmation takes the line", () => {
  it("fires the booking-hold dispatcher post-commit with the intents + hint the confirmation owes, then the owner notice; neither crosses the wire", async () => {
    const harness = build(EDITOR_ID, {
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }, { id: OTHER_REQUEST_ID, performerOwnerId: STRANGER_ID }],
    });
    const own = harness.seedHold(REQUEST_ID);
    const competitor = harness.seedHold(OTHER_REQUEST_ID);

    const result = await harness.caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID });

    expect(harness.bookingHolds.rows.get(own.id)?.status).toBe("CONFIRMED");
    expect(harness.bookingHolds.rows.get(competitor.id)?.status).toBe("RELEASED");
    expect(JSON.stringify(result)).not.toContain(competitor.id);
    expect(dispatchHoldMock).toHaveBeenCalledTimes(1);
    const [holdDeps, holdArgs] = dispatchHoldMock.mock.calls[0]!;
    expect(holdDeps.repos).toBe(harness.ctx.repos);
    expect(holdArgs.bookingRequestId).toBe(REQUEST_ID);
    expect(holdArgs.intents.map((i) => [i.kind, i.bookingRequestId])).toEqual([
      ["hold.confirmed", REQUEST_ID],
      ["hold.lost_date", OTHER_REQUEST_ID],
    ]);
    expect(holdArgs.hint).toEqual({ assigneeHumanId: null, placedByHumanId: EDITOR_ID, orgId: VENUE_ORG_ID, placeId: PLACE_ID });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the hold dispatcher when nothing was owed (no hold on the line)", async () => {
    const { caller } = build(EDITOR_ID, { requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }] });
    await caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID });
    expect(dispatchHoldMock).not.toHaveBeenCalled();
  });

  it("swallows + reports a hold-dispatcher failure; the committed confirmation still returns", async () => {
    dispatchHoldMock.mockRejectedValueOnce(new Error("mailer down"));
    const harness = build(EDITOR_ID, { requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }] });
    harness.seedHold(OTHER_REQUEST_ID);

    const result = await harness.caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID });

    expect(result.event.venueConfirmed).toBe(true);
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: "booking_holds", step: "notify_intents" } }),
    );
  });

  it("an OPEN challenge on the line maps HOLD_LINE_HAS_OPEN_CHALLENGE to CONFLICT; nothing dispatched", async () => {
    const harness = build(EDITOR_ID, {
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }, { id: OTHER_REQUEST_ID, performerOwnerId: STRANGER_ID }],
    });
    harness.seedHold(OTHER_REQUEST_ID, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date("2026-09-04T12:00:00.000Z"),
    });

    await expect(harness.caller.confirm({ expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(harness.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(dispatchHoldMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
