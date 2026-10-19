import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";

import type { AgreementRecord } from "@th/ports/repos/agreements";

import { closeBookingRequest } from "../close-booking-request";
import { withdrawBookingRequest } from "../withdraw-booking-request";
import { respondToBookingAgreement } from "../../booking-agreements/respond-to-booking-agreement";
import {
  ACT_A_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
} from "../../booking-holds/__tests__/hold-test-context";
import {
  A_TERMS,
  buildNightHarness,
  terms,
} from "../../booking-agreements/__tests__/night-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Exits after accept (booking-the-night N14 / FR-010): an ACCEPTED request has
// exits until its night is booked — the sender's Withdraw and the venue's
// Close request (with a reason). Both release the request's holds and cancel
// its draft terms; once the night is booked the undo is Cancel booking.
// ─────────────────────────────────────────────────────────────────────────────

// The agree's post-commit mint is a boundary (its own suite).
const agreeMint = vi.fn(async () => ({ eventId: null }));
vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../booking-agreements/create-event-from-agreement")
  >()),
  createEventFromAgreementOnNight: (...args: unknown[]) => agreeMint(...(args as [])),
}));

// The draft's cancellation is the cancelEvent body (its own suite); here a
// boundary that behaves like it: one transaction, the event row first, then
// the exit's writes.
const cancelEventForBookingMock = vi.fn();
vi.mock("../../events/cancel-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../events/cancel-event")>()),
  cancelEventForBooking: (...args: unknown[]) => cancelEventForBookingMock(...args),
}));

const REASON = "We had to rethink the season and can't host this.";
const DRAFT_ID = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7";

/** Request A ACCEPTED, its terms `over` (DRAFT by default), two live holds. */
function accepted(over: Partial<AgreementRecord> = {}) {
  const ctx = buildNightHarness();
  ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT", ...over }));
  const mine = ctx.seedHold(REQUEST_A);
  const behind = ctx.seedHold(REQUEST_B);
  const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
  const responded = vi.fn(async (_args: Record<string, unknown>) => {});
  const joined = vi.fn(async (_args: Record<string, unknown>) => {});
  const deps = {
    ...ctx.deps,
    notifyBookingRequestResponded: responded,
    notifyBookingLineupRequestClosed: joined,
    eventCancellation: {
      payments: {} as never,
      idempotency: ctx.deps.idempotency,
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    },
  };
  cancelEventForBookingMock.mockReset();
  cancelEventForBookingMock.mockImplementation(
    async (
      _deps: unknown,
      args: { eventId: string; auditVia?: string; withinTx: (tx: unknown, event: unknown) => Promise<void> },
    ) => {
      const event = ctx.events.get(args.eventId) as { id: string; status: string } | undefined;
      if (!event) throw new Error("no event");
      return ctx.repos.tx(async (tx) => {
        event.status = "CANCELLED";
        await args.withinTx(tx, event);
        return { eventId: event.id, status: "CANCELLED", refundedOrderCount: 0, failedRefundCount: 0 };
      });
    },
  );
  return { ...ctx, deps, mine, behind, sibling, responded, joined };
}

type Accepted = ReturnType<typeof accepted>;

const withdraw = (ctx: Accepted, actorHumanId = ACT_A_ID) =>
  withdrawBookingRequest(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_A });
const close = (ctx: Accepted, actorHumanId = STAFF_ID, reason = REASON) =>
  closeBookingRequest(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_A, reason });

/** Run `competitor` to completion the first time the booking lock is taken. */
function onFirstBookingLock(ctx: Accepted, competitor: () => Promise<unknown>) {
  const lock = vi.mocked(ctx.bookingHolds.lockRequestBooking);
  let fired = false;
  lock.mockImplementation(async () => {
    if (!fired) {
      fired = true;
      await competitor();
    }
  });
}

describe("withdraw after accept (N14)", () => {
  it.each(["DRAFT", "PROPOSED", "ACCEPTED"] as const)(
    "%s terms, no night booked: WITHDRAWN, every hold released (REQUEST_CLOSED), the terms CANCELLED, the movers owed",
    async (status) => {
      const ctx = accepted({ status });

      const result = await withdraw(ctx);

      expect(result).toMatchObject({ status: "WITHDRAWN" });
      expect(ctx.requests.get(REQUEST_A)?.status).toBe("WITHDRAWN");
      expect(ctx.bookingHolds.rows.get(ctx.mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
      expect(ctx.bookingHolds.rows.get(ctx.sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
      expect(ctx.bookingHolds.rows.get(ctx.behind.id)).toMatchObject({ status: "ACTIVE", position: 1 });
      expect(result.holdNotificationIntents).toEqual([
        expect.objectContaining({ kind: "hold.position_changed", holdId: ctx.behind.id, position: 1 }),
      ]);
      expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_agreement.cancelled",
          data: expect.objectContaining({ via: "withdraw", fromStatus: status }),
        }),
      );
      expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toContain("booking_request.withdrawn");
      // Joined acts hear it isn't going ahead (L7).
      expect(ctx.joined).toHaveBeenCalledWith(expect.objectContaining({ closedBy: "withdrawn" }));
    },
  );

  it("the booking lock is taken BEFORE any line lock", async () => {
    const ctx = accepted();
    await withdraw(ctx);
    const booking = vi.mocked(ctx.bookingHolds.lockRequestBooking).mock.invocationCallOrder[0]!;
    for (const at of vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder) {
      expect(booking).toBeLessThan(at);
    }
  });

  it("a BOOKED night → BOOKING_NIGHT_BOOKED (no meta; the undo is Cancel booking), nothing written", async () => {
    const ctx = accepted({ status: "ACCEPTED" });
    ctx.bookingHolds.rows.set(ctx.mine.id, { ...ctx.mine, status: "CONFIRMED", confirmedAt: NOW });

    const error = await withdraw(ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.bookingHolds.rows.get(ctx.sibling.id)?.status).toBe("ACTIVE");
  });

  it("FINALIZED terms → AGREEMENT_FINALIZED, nothing written", async () => {
    const ctx = accepted({ status: "ACCEPTED", eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1" });
    await expect(withdraw(ctx)).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });

  it("only the sender pair may withdraw — the venue gets NOT_RESOURCE_OWNER", async () => {
    const ctx = accepted();
    await expect(withdraw(ctx, STAFF_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("race — the AGREE holds the booking lock first and books the night → the withdraw then reads it: BOOKING_NIGHT_BOOKED", async () => {
    const ctx = accepted({ status: "PROPOSED" });
    onFirstBookingLock(ctx, () =>
      respondToBookingAgreement(ctx.deps as never, {
        actorHumanId: ACT_A_ID,
        agreementId: A_TERMS,
        action: "accept",
      }),
    );

    await expect(withdraw(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect(ctx.bookingHolds.rows.get(ctx.mine.id)?.status).toBe("CONFIRMED");
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });

  it("race — the WITHDRAW holds the booking lock first → the agree then finds the request closed and books nothing", async () => {
    const ctx = accepted({ status: "PROPOSED" });
    onFirstBookingLock(ctx, () => withdraw(ctx));

    const error = await respondToBookingAgreement(ctx.deps as never, {
      actorHumanId: ACT_A_ID,
      agreementId: A_TERMS,
      action: "accept",
    }).catch((e: unknown) => e);

    expect(error).toBeDefined();
    expect([...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED")).toEqual([]);
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("WITHDRAWN");
  });
});

describe("closeBookingRequest — the venue's exit after accept (N14)", () => {
  it("ACCEPTED, no night booked: DECLINED with the reason, the ledger entry, holds released, terms CANCELLED; the sender told WITH the reason, joined acts WITHOUT it", async () => {
    const ctx = accepted({ status: "PROPOSED" });

    const result = await close(ctx);

    expect(result).toEqual({
      bookingRequestId: REQUEST_A,
      status: "DECLINED",
      cancelledAgreementId: A_TERMS,
      holdNotificationIntents: [
        expect.objectContaining({ kind: "hold.position_changed", holdId: ctx.behind.id, position: 1 }),
      ],
    });
    expect(ctx.requests.get(REQUEST_A)).toMatchObject({ status: "DECLINED", declineReason: REASON });
    expect(ctx.entries(REQUEST_A)).toEqual(
      expect.arrayContaining([
        { kind: "booking_request.closed_by_place", data: { reason: REASON }, actor: STAFF_ID },
      ]),
    );
    expect(ctx.bookingHolds.rows.get(ctx.mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(ctx.responded).toHaveBeenCalledWith(
      expect.objectContaining({ action: "closed", reason: REASON, actorHumanId: STAFF_ID }),
    );
    expect(ctx.joined).toHaveBeenCalledWith(expect.objectContaining({ closedBy: "closed" }));
    // The hook carries no reason (the request record it gets is the closed
    // row; the notifier's payload never reads its declineReason — L7, pinned
    // in the notifier's own suite).
    expect(ctx.joined.mock.calls[0]![0]).not.toHaveProperty("reason");
  });

  it("a BOOKED night → BOOKING_NIGHT_BOOKED, nothing written", async () => {
    const ctx = accepted({ status: "ACCEPTED" });
    ctx.bookingHolds.rows.set(ctx.mine.id, { ...ctx.mine, status: "CONFIRMED", confirmedAt: NOW });

    await expect(close(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(ctx.responded).not.toHaveBeenCalled();
  });

  it("an OPEN request is declined, not closed → INVALID_STATUS", async () => {
    const ctx = accepted();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "VIEWED" });
    await expect(close(ctx)).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("the act cannot close (venue side, edit role) → NOT_RESOURCE_OWNER; a viewer → INSUFFICIENT_ROLE", async () => {
    const ctx = accepted();
    await expect(close(ctx, ACT_A_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(close(ctx, OUTSIDER_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });

  it("the reason is required, sanitized first, bounded at 1000", async () => {
    const ctx = accepted();
    await expect(
      closeBookingRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(close(ctx, STAFF_ID, "<i></i>")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(close(ctx, STAFF_ID, "x".repeat(1001))).rejects.toMatchObject({ code: "invalid_input" });

    await close(ctx, STAFF_ID, "<b>Room</b> closed.");
    expect(ctx.requests.get(REQUEST_A)?.declineReason).toBe("Room closed.");
  });

  it("a throwing sender notice is swallowed — logged at error AND reported, guarded; the close stands", async () => {
    const ctx = accepted();
    ctx.responded.mockRejectedValueOnce(new Error("notify down"));
    ctx.deps.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(close(ctx)).resolves.toMatchObject({ status: "DECLINED" });
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notify down" }),
      expect.objectContaining({ tags: { useCase: "closeBookingRequest", step: "request_responded" } }),
    );
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_responded_failed",
      expect.anything(),
    );
  });

  it("race — the agree books the night first (at the booking lock) → the close is refused BOOKING_NIGHT_BOOKED", async () => {
    const ctx = accepted({ status: "PROPOSED" });
    onFirstBookingLock(ctx, () =>
      respondToBookingAgreement(ctx.deps as never, {
        actorHumanId: ACT_A_ID,
        agreementId: A_TERMS,
        action: "accept",
      }),
    );

    await expect(close(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect(ctx.bookingHolds.rows.get(ctx.mine.id)).toMatchObject({ status: "CONFIRMED", calendarId: CALENDAR_ID, date: DATE });
  });

  it("the venue's admins are the sender's counterpart; the assignee is unaffected by the close", async () => {
    const ctx = accepted();
    await close(ctx, ASSIGNEE_ID);
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("DECLINED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: the request's still-DRAFT event ends with the exit, in the
// same commit (no orders on a DRAFT, so nothing refunded); and, W1, an exit
// never leaves a closed request holding a CONFIRMED hold.
// ─────────────────────────────────────────────────────────────────────────────

describe("exits after accept — the request's still-DRAFT event ends with it", () => {
  function withDraft(status = "DRAFT") {
    const ctx = accepted({ status: "ACCEPTED", draftEventId: DRAFT_ID });
    ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NOW, status } as never);
    return ctx;
  }

  it("withdraw: the DRAFT is cancelled in the SAME transaction as the withdraw (audit via booking_exit)", async () => {
    const ctx = withDraft();

    await expect(withdraw(ctx)).resolves.toMatchObject({ status: "WITHDRAWN" });

    expect(cancelEventForBookingMock).toHaveBeenCalledTimes(1);
    expect(cancelEventForBookingMock.mock.calls[0]![1]).toMatchObject({
      eventId: DRAFT_ID,
      auditVia: "booking_exit",
      idempotencyKey: `bookingRequest:exit:${REQUEST_A}:${DRAFT_ID}`,
    });
    expect(ctx.events.get(DRAFT_ID)).toMatchObject({ status: "CANCELLED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("WITHDRAWN");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
  });

  it("close: the same", async () => {
    const ctx = withDraft();
    await expect(close(ctx)).resolves.toMatchObject({ status: "DECLINED" });
    expect(ctx.events.get(DRAFT_ID)).toMatchObject({ status: "CANCELLED" });
  });

  it("a PUBLISHED anchor is not touched (nothing to do without refunds; listed as a follow-up)", async () => {
    const ctx = withDraft("PUBLISHED");
    await expect(withdraw(ctx)).resolves.toMatchObject({ status: "WITHDRAWN" });
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
    expect(ctx.events.get(DRAFT_ID)).toMatchObject({ status: "PUBLISHED" });
  });

  // Round 3, W2: when cancelEvent refuses the exit's draft (EVENT_NOT_CANCELLABLE
  // — it now has sales, or was published under the row lock), the exit still
  // runs in its own transaction and the live event is left exactly as it is.
  it("cancelEvent refuses the draft (sales / published meanwhile) → the exit runs alone; the event is untouched, nothing refunded", async () => {
    const ctx = withDraft();
    cancelEventForBookingMock.mockImplementationOnce(async () => {
      // What W2 does on the cancelEvent side: the row sold tickets since.
      ctx.events.set(DRAFT_ID, { ...(ctx.events.get(DRAFT_ID) as object), status: "PUBLISHED" } as never);
      throw fail("EVENT_NOT_CANCELLABLE");
    });

    await expect(withdraw(ctx)).resolves.toMatchObject({ status: "WITHDRAWN" });
    expect(cancelEventForBookingMock).toHaveBeenCalledTimes(1);
    expect(ctx.events.get(DRAFT_ID)).toMatchObject({ status: "PUBLISHED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("WITHDRAWN");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
  });

  it("an event-first ORIGIN is the requester's own event: never cancelled by an exit", async () => {
    const ctx = withDraft();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: DRAFT_ID });
    await expect(withdraw(ctx)).resolves.toMatchObject({ status: "WITHDRAWN" });
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
  });

  it("the exit body's refusal rolls the draft's cancellation back with it (one transaction)", async () => {
    const ctx = withDraft();
    // Booked meanwhile: the exit refuses inside cancelEvent's transaction.
    vi.mocked(ctx.bookingHolds.lockRequestBooking).mockImplementationOnce(async () => {
      ctx.bookingHolds.rows.set(ctx.mine.id, { ...ctx.mine, status: "CONFIRMED", confirmedAt: NOW });
    });
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      try {
        return await real(deps, args);
      } catch (error) {
        // The fake tx cannot roll back: restore the row by hand, as a rollback would.
        ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NOW, status: "DRAFT" } as never);
        throw error;
      }
    });

    await expect(withdraw(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
    expect(ctx.events.get(DRAFT_ID)).toMatchObject({ status: "DRAFT" });
  });

  it("a draft that appeared after the pre-flight (a racing mint) → HOLD_LINE_CHANGED, nothing written", async () => {
    const ctx = accepted({ status: "ACCEPTED" });
    vi.mocked(ctx.bookingHolds.lockRequestBooking).mockImplementationOnce(async () => {
      ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, draftEventId: DRAFT_ID });
      ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NOW, status: "DRAFT" } as never);
    });

    await expect(withdraw(ctx)).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });

  it("no cancelEvent wiring and a draft to cancel → NOT_CONFIGURED, nothing written (never strand the draft)", async () => {
    const ctx = withDraft();
    const { eventCancellation: _unwired, ...deps } = ctx.deps;

    await expect(
      withdrawBookingRequest(deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });
});

describe("exits — W1 defence: a night booked between the first read and the line locks refuses the exit", () => {
  it("withdraw: a settle CONFIRMS the request's hold while the withdraw waits on its line → BOOKING_NIGHT_BOOKED, rolled back", async () => {
    const ctx = accepted({ status: "PROPOSED" });
    // The first read sees no booked night; by the time the release holds the
    // line lock, a publish-time settle (an older build that skipped the
    // booking lock) has confirmed the hold.
    let fired = false;
    vi.mocked(ctx.bookingHolds.lockLine).mockImplementation(async () => {
      if (fired) return;
      fired = true;
      ctx.bookingHolds.rows.set(ctx.mine.id, { ...ctx.mine, status: "CONFIRMED", confirmedAt: NOW });
    });

    await expect(withdraw(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect(ctx.bookingHolds.rows.get(ctx.mine.id)?.status).toBe("CONFIRMED");
  });

  it("close: the same", async () => {
    const ctx = accepted({ status: "PROPOSED" });
    let fired = false;
    vi.mocked(ctx.bookingHolds.lockLine).mockImplementation(async () => {
      if (fired) return;
      fired = true;
      ctx.bookingHolds.rows.set(ctx.mine.id, { ...ctx.mine, status: "CONFIRMED", confirmedAt: NOW });
    });

    await expect(close(ctx)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
  });
});

