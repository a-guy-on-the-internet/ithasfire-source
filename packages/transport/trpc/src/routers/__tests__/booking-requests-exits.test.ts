import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  NOW,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";
import {
  A_TERMS,
  buildNightHarness,
  terms,
} from "@th/core/use-cases/booking-agreements/__tests__/night-harness";
import { makeFakeIdempotency } from "@th/core/use-cases/booking-requests/__tests__/helpers";

import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";

// The exits' legacy-DRAFT cancel (review NIT 1) goes through cancelEvent's
// booking entry; here it only proves the router hands it cancelEvent's
// ports from the context, then runs the exit body in a plain tx.
vi.mock("@th/core/use-cases/events/cancel-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/events/cancel-event")>()),
  cancelEventForBooking: vi.fn(
    async (deps: { repos: { tx: (fn: unknown) => Promise<unknown> } }, args: { withinTx: unknown }) => {
      await deps.repos.tx(args.withinTx);
      return {};
    },
  ),
}));
import { cancelEventForBooking } from "@th/core/use-cases/events/cancel-event";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night P2c at the transport: `close` (FR-010) and
// `cancelBooking` (FR-009) — strict input derived from core, the intents
// stripped from the wire and dispatched post-commit, the deps wired — and
// `respond` telling the sender through the generalised notice (FR-008).
// ─────────────────────────────────────────────────────────────────────────────

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);
const REASON = "We had to rethink the season and can't host this.";

beforeEach(() => {
  vi.mocked(cancelEventForBooking).mockClear();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
});

function harness() {
  const ctx = buildNightHarness();
  ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT" }));
  return ctx;
}

describe("bookingRequestsRouter.close (FR-010)", () => {
  it("closes an ACCEPTED request: the wire carries no intents; the move-ups are dispatched post-commit", async () => {
    const ctx = harness();
    ctx.seedHold(REQUEST_A);
    const other = ctx.seedHold(REQUEST_B);
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.close({ bookingRequestId: REQUEST_A, reason: REASON });

    expect(result).toEqual({
      bookingRequestId: REQUEST_A,
      status: "DECLINED",
      cancelledAgreementId: A_TERMS,
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1].intents).toEqual([
      expect.objectContaining({ kind: "hold.position_changed", holdId: other.id, position: 1 }),
    ]);
  });

  it("an ACCEPTED request's live legacy DRAFT is cancelled with the close, through the context's payments/idempotency/authz", async () => {
    const DRAFT_ID = "dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf";
    const ctx = harness();
    ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, draftEventId: DRAFT_ID, eventId: null });
    ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NOW, status: "DRAFT" } as never);
    ctx.seedHold(REQUEST_A);
    // cancelEvent writes the CANCELLED status before it runs the exit body.
    vi.mocked(cancelEventForBooking).mockImplementationOnce(async (deps, args) => {
      ctx.events.set(DRAFT_ID, { ...ctx.events.get(DRAFT_ID)!, status: "CANCELLED" } as never);
      await deps.repos.tx(args.withinTx as never);
      return {} as never;
    });
    const payments = { refund: vi.fn() };
    const idempotency = makeFakeIdempotency();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      payments: payments as never,
      idempotency,
    });

    const result = await caller.close({ bookingRequestId: REQUEST_A, reason: REASON });

    expect(result).toMatchObject({ bookingRequestId: REQUEST_A, status: "DECLINED" });
    const mocked = vi.mocked(cancelEventForBooking);
    expect(mocked).toHaveBeenCalledTimes(1);
    const [deps, args] = mocked.mock.calls[0]!;
    expect(deps).toMatchObject({ payments, idempotency });
    expect(deps.authz).toBeDefined();
    expect(args).toMatchObject({
      eventId: DRAFT_ID,
      actorHumanId: STAFF_ID,
      auditVia: "booking_exit",
      idempotencyKey: `bookingRequest:exit:${REQUEST_A}:${DRAFT_ID}`,
    });
  });

  it("is strict and requires the reason", async () => {
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: harness().repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
    });
    await expect(caller.close({ bookingRequestId: REQUEST_A })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.close({ bookingRequestId: REQUEST_A, reason: REASON, actorHumanId: ACT_A_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a booked night → CONFLICT with appCode BOOKING_NIGHT_BOOKED and no meta", async () => {
    const ctx = harness();
    ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
    });

    const error = await caller.close({ bookingRequestId: REQUEST_A, reason: REASON }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT", meta: { appCode: "BOOKING_NIGHT_BOOKED" } });
  });
});

describe("bookingRequestsRouter.cancelBooking (FR-009)", () => {
  it("cancels a booked night with no live event: the use case's output on the wire, minus the intents", async () => {
    const ctx = harness();
    const booked = ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });
    Object.assign(ctx.repos.payoutTerms, { archive: vi.fn(async () => null) });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
    });

    const result = await caller.cancelBooking({ bookingRequestId: REQUEST_A, reason: REASON });

    expect(result).toEqual({
      bookingRequestId: REQUEST_A,
      holdId: booked.id,
      cancelledBy: "sender",
      agreementId: A_TERMS,
    });
    // Review W5 / round 3: the sender side never sees the venue's refund
    // counts, nor the venue's event id.
    expect(result).not.toHaveProperty("refundedOrderCount");
    expect(result).not.toHaveProperty("failedRefundCount");
    expect(result).not.toHaveProperty("eventId");
    expect(ctx.bookingHolds.rows.get(booked.id)).toMatchObject({
      status: "RELEASED",
      releasedReason: "BOOKING_CANCELLED",
    });
  });

  it("the venue cancels: refund counts on its wire; BOTH sides told through notifyWithEmail (`booking.booking-cancelled`) with the reason", async () => {
    const ctx = harness();
    ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });
    Object.assign(ctx.repos.payoutTerms, { archive: vi.fn(async () => null) });
    Object.assign(ctx.repos.organizations, {
      getById: vi.fn(async (id: string) => ({ id, name: "Venue Org", slug: "venue-org" })),
    });
    const notifyWithEmail = vi.fn(async (_input: unknown) => ({ notificationId: null }));
    const notify = vi.fn(async (_input: unknown) => ({ notificationId: null }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      publicAppUrl: "https://ithasfire.test",
      notifyWithEmail: notifyWithEmail as never,
      notify: notify as never,
      idempotency: makeFakeIdempotency(),
    });

    const result = await caller.cancelBooking({ bookingRequestId: REQUEST_A, reason: REASON });

    expect(result).toMatchObject({ cancelledBy: "place", refundedOrderCount: 0, failedRefundCount: 0 });
    const cancelled = notifyWithEmail.mock.calls
      .map((c) => c[0] as { humanId: string; variant: string; payload: Record<string, unknown> })
      .filter((n) => n.variant === "booking.booking-cancelled");
    // The act (sender) and the venue org's other admin; never the canceller.
    expect(cancelled.map((n) => n.humanId).sort()).toEqual([ACT_A_ID, ASSIGNEE_ID].sort());
    for (const n of cancelled) {
      expect(n.payload).toMatchObject({ cancelledBy: "place", reason: REASON, eventCancelled: false });
    }
    expect(notify.mock.calls.map((c) => (c[0] as { variant: string }).variant)).not.toContain(
      "booking.booking-cancelled",
    );
  });

  it("is strict and requires the reason", async () => {
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: harness().repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
    });
    await expect(caller.cancelBooking({ bookingRequestId: REQUEST_A })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.cancelBooking({ bookingRequestId: REQUEST_A, reason: REASON, holdId: CALENDAR_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("nothing booked → CONFLICT with appCode BOOKING_NOT_CANCELLABLE", async () => {
    const ctx = harness();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
    });
    await expect(
      caller.cancelBooking({ bookingRequestId: REQUEST_A, reason: REASON }),
    ).rejects.toMatchObject({ code: "CONFLICT", meta: expect.objectContaining({ appCode: "BOOKING_NOT_CANCELLABLE" }) });
  });
});

describe("bookingRequestsRouter.respond — the sender hears the answer (FR-008)", () => {
  it("a TO_VENUE decline sends `booking.request-responded` to the human sender, with the reason", async () => {
    const ctx = harness();
    ctx.requests.set(REQUEST_B, {
      ...ctx.requests.get(REQUEST_B)!,
      status: "PENDING",
      placeName: "Test Venue",
    } as never);
    const notifyWithEmail = vi.fn(async (_input: unknown) => ({ notificationId: null }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: ctx.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      publicAppUrl: "https://ithasfire.test",
      notifyWithEmail: notifyWithEmail as never,
      idempotency: makeFakeIdempotency(),
    });

    await caller.respond({ bookingRequestId: REQUEST_B, action: "decline", declineReason: REASON });

    const sent = notifyWithEmail.mock.calls.map((c) => c[0] as { variant: string; payload: Record<string, unknown> });
    expect(sent.filter((n) => n.variant === "booking.request-responded")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ action: "declined", reason: REASON, responderName: "Test Venue" }),
      }),
    ]);
  });
});
