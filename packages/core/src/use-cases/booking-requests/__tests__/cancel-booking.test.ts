import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import type { TxRepos } from "@th/ports/repos";

import { cancelBooking, type CancelBookingDeps } from "../cancel-booking";
import { closeBookingRequest } from "../close-booking-request";
import { withdrawBookingRequest } from "../withdraw-booking-request";
import { placeBookingHold } from "../../booking-holds/place-booking-hold";
import { bookNightWithoutTerms } from "../../booking-holds/book-night-without-terms";
import { respondToBookingAgreement } from "../../booking-agreements/respond-to-booking-agreement";
import {
  ACT_A_ID,
  ACT_B_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  VIEWER_ID,
} from "../../booking-holds/__tests__/hold-test-context";
import {
  A_TERMS,
  EVENT_ID,
  NIGHT_AT,
  buildNightHarness,
  terms,
} from "../../booking-agreements/__tests__/night-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Cancel booking (booking-the-night N13 / FR-009): the one undo for a booked
// night. The event's cancellation (refunds and all) is the existing
// cancelEvent body, entered through `cancelEventForBooking`; its own suite
// (events/__tests__/cancel-event-for-booking.test.ts) pins that our writes
// run inside its transaction. Here it is a boundary that behaves like it:
// a booking-scoped idempotency envelope, then ONE transaction that cancels
// the event row and runs the booking's writes in it.
// ─────────────────────────────────────────────────────────────────────────────

const cancelEventForBookingMock = vi.fn();
vi.mock("../../events/cancel-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../events/cancel-event")>()),
  cancelEventForBooking: (...args: unknown[]) => cancelEventForBookingMock(...args),
}));
// The post-commit mints are boundaries (book-without-terms is only ever
// refused here, before reaching them).
const holdMint = vi.fn();
vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../booking-agreements/create-event-from-agreement")
  >()),
  createEventFromAgreementForHold: (...args: unknown[]) => holdMint(...args),
}));

const REASON = "The room flooded; we can't host the show.";
/**
 * The venue org's ADMIN: the event the harness books is VENUE-owned, so the
 * venue side cancels it on cancelEvent's own bar (OWNER / ADMIN; review
 * round 1). STAFF_ID is an EDITOR — refused, pinned below.
 */
const VENUE_ADMIN = ASSIGNEE_ID;
const PAYOUT_TERMS_ID = "66666666-6666-4666-8666-666666666666";
const CONFIRMED_AT = new Date("2026-06-05T12:00:00.000Z");
const JOINED_ACT_HOOK = vi.fn(async (_args: Record<string, unknown>) => {});
const CANCELLED_HOOK = vi.fn(async (_args: Record<string, unknown>) => {});

type EventRow = {
  id: string;
  startsAt: Date;
  status: string;
  orgId?: string | null;
  humanId?: string | null;
  placeId?: string | null;
  calendarId?: string | null;
};

/**
 * Request A ACCEPTED with ACCEPTED terms for DATE, its night BOOKED on the
 * main calendar (a CONFIRMED hold), and a live DRAFT event (minted, anchored
 * on the terms) owned by the venue org.
 */
function booked(over: { agreement?: Partial<AgreementRecord>; event?: Partial<EventRow> | null } = {}) {
  const ctx = buildNightHarness();
  ctx.agreements.set(
    A_TERMS,
    terms(A_TERMS, ACT_A_ID, {
      status: "ACCEPTED",
      acceptedAt: NOW,
      draftEventId: over.event === null ? null : EVENT_ID,
      payoutTermsId: PAYOUT_TERMS_ID,
      ...over.agreement,
    }),
  );
  if (over.event !== null) {
    ctx.events.set(EVENT_ID, {
      id: EVENT_ID,
      startsAt: NIGHT_AT,
      status: "DRAFT",
      orgId: ORG_ID,
      humanId: null,
      placeId: ctx.place.id,
      calendarId: CALENDAR_ID,
      ...over.event,
    } as never);
  }
  const hold = ctx.seedHold(REQUEST_A, {
    status: "CONFIRMED",
    confirmedAt: CONFIRMED_AT,
  });

  // The agreement's own payout terms (status tracked for the archive CAS).
  const payoutTermsStatus = new Map<string, string>([[PAYOUT_TERMS_ID, "ACTIVE"]]);
  Object.assign(ctx.repos.payoutTerms, {
    archive: vi.fn(async (input: { payoutTermsId: string; expectedFrom: readonly string[] }) => {
      const status = payoutTermsStatus.get(input.payoutTermsId);
      if (!status || !input.expectedFrom.includes(status)) return null;
      payoutTermsStatus.set(input.payoutTermsId, "ARCHIVED");
      return { id: input.payoutTermsId, status: "ARCHIVED" };
    }),
  });

  const deps = {
    ...ctx.deps,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: {} as never,
    notifyBookingLineupRequestClosed: JOINED_ACT_HOOK,
    notifyBookingCancelled: CANCELLED_HOOK,
  } as unknown as CancelBookingDeps;

  return { ...ctx, hold, deps, payoutTermsStatus };
}

type Booked = ReturnType<typeof booked>;

/** Idempotency claims the fake cancelEvent envelope keeps, per key. */
let envelope: Map<string, { committed: unknown | null }>;

beforeEach(() => {
  JOINED_ACT_HOOK.mockClear();
  CANCELLED_HOOK.mockReset();
  holdMint.mockReset();
  envelope = new Map();
  cancelEventForBookingMock.mockReset();
  cancelEventForBookingMock.mockImplementation(
    async (
      deps: CancelBookingDeps,
      args: {
        eventId: string;
        idempotencyKey: string;
        withinTx: (tx: TxRepos, event: unknown) => Promise<void>;
      },
    ) => {
      const claim = envelope.get(args.idempotencyKey);
      if (claim) {
        if (claim.committed) return claim.committed;
        throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
      }
      envelope.set(args.idempotencyKey, { committed: null });
      const events = (deps.repos as unknown as { events: { getById: (id: string) => Promise<EventRow | null> } }).events;
      const event = await events.getById(args.eventId);
      if (!event) throw fail("EVENT_NOT_FOUND");
      if (event.status === "CANCELLED") {
        envelope.delete(args.idempotencyKey);
        throw fail("EVENT_ALREADY_CANCELLED");
      }
      try {
        const out = await deps.repos.tx(async (tx) => {
          // tx.events.cancel, then the booking's writes in the same tx.
          event.status = "CANCELLED";
          await args.withinTx(tx, event);
          return {
            eventId: event.id,
            status: "CANCELLED" as const,
            refundedOrderCount: 2,
            failedRefundCount: 1,
          };
        });
        envelope.set(args.idempotencyKey, { committed: out });
        return out;
      } catch (error) {
        envelope.delete(args.idempotencyKey);
        // The fake tx cannot roll back: restore the row by hand.
        event.status = "DRAFT";
        throw error;
      }
    },
  );
});

const cancel = (ctx: Booked, actorHumanId = VENUE_ADMIN, reason = REASON) =>
  cancelBooking(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_A, reason });

const holdOf = (ctx: Booked, id: string) => ctx.bookingHolds.rows.get(id) as BookingHoldRecord;

describe("cancelBooking — the booked night ends: terms, hold and event together", () => {
  it("venue side: event cancelled through cancelEvent (booking-scoped key), terms CANCELLED + payout terms ARCHIVED, the hold RELEASED (BOOKING_CANCELLED), the ledger entry; the request stays ACCEPTED", async () => {
    const ctx = booked();

    const result = await cancel(ctx);

    expect(result).toEqual({
      bookingRequestId: REQUEST_A,
      holdId: ctx.hold.id,
      cancelledBy: "place",
      agreementId: A_TERMS,
      eventId: EVENT_ID,
      refundedOrderCount: 2,
      failedRefundCount: 1,
      holdNotificationIntents: [],
      staffRecipientHint: null,
    });
    expect(cancelEventForBookingMock).toHaveBeenCalledTimes(1);
    expect(cancelEventForBookingMock.mock.calls[0]![1]).toMatchObject({
      actorHumanId: VENUE_ADMIN,
      eventId: EVENT_ID,
      idempotencyKey: `bookingRequest:cancelBooking:${REQUEST_A}:${ctx.hold.id}`,
    });
    expect(ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(ctx.payoutTermsStatus.get(PAYOUT_TERMS_ID)).toBe("ARCHIVED");
    const released = holdOf(ctx, ctx.hold.id);
    expect(released).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect(vi.mocked(ctx.bookingHolds.updateStatus)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ctx.hold.id,
        status: "RELEASED",
        expectedFrom: ["CONFIRMED"],
        releasedReason: "BOOKING_CANCELLED",
        // When the night was booked stays on the row.
        confirmedAt: CONFIRMED_AT,
      }),
    );
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([
      {
        kind: "booking_request.booking_cancelled",
        data: { by: "place", reason: REASON },
        actor: VENUE_ADMIN,
      },
    ]);
    // The booking lock comes BEFORE the line lock (the global order).
    const bookingLockAt = vi.mocked(ctx.bookingHolds.lockRequestBooking).mock.invocationCallOrder[0]!;
    const lineLockAt = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder[0]!;
    expect(bookingLockAt).toBeLessThan(lineLockAt);
    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: DATE });
  });

  it("the sender (the act) can cancel too — `by: sender`", async () => {
    const ctx = booked();

    const result = await cancel(ctx, ACT_A_ID);

    expect(result.cancelledBy).toBe("sender");
    expect(ctx.entries(REQUEST_A)).toEqual([
      expect.objectContaining({ kind: "booking_request.booking_cancelled", data: { by: "sender", reason: REASON } }),
    ]);
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
  });

  it("FINALIZED terms are cancelled too (the one path that may), and their payout terms leave force", async () => {
    const ctx = booked({ agreement: { eventId: EVENT_ID, draftEventId: null } });

    await cancel(ctx);

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(ctx.payoutTermsStatus.get(PAYOUT_TERMS_ID)).toBe("ARCHIVED");
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.cancelled",
        data: expect.objectContaining({ finalizedEventId: EVENT_ID, via: "cancel_booking" }),
      }),
    );
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "payoutTerms", action: "archived" }),
    );
  });

  it("booked WITHOUT terms (DRAFT terms): the draft is cancelled, the night freed", async () => {
    const ctx = booked({ agreement: { status: "DRAFT", acceptedAt: null } });

    await cancel(ctx);

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("no event (the mint never landed): cancelEvent is not entered; the booking's own transaction frees the night", async () => {
    const ctx = booked({ event: null });

    const result = await cancel(ctx);

    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ eventId: null, refundedOrderCount: 0, failedRefundCount: 0 });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
  });

  it("the event was already cancelled directly: nothing to refund, the night is still freed (the repair path)", async () => {
    const ctx = booked({ event: { status: "CANCELLED" } });

    await cancel(ctx);

    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("cancelled DIRECTLY between our read and cancelEvent's (EVENT_ALREADY_CANCELLED) → the night is freed alone", async () => {
    const ctx = booked();
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      ctx.events.set(EVENT_ID, { ...(ctx.events.get(EVENT_ID) as object), status: "CANCELLED" } as never);
      return real(deps, args);
    });

    const result = await cancel(ctx);

    expect(result.eventId).toBeNull();
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("a live hold the request still had on another night is released too (BOOKING_CANCELLED), its line renumbered", async () => {
    const ctx = booked();
    const other = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    const behind = ctx.seedHold(REQUEST_B, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    const result = await cancel(ctx);

    expect(holdOf(ctx, other.id)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect(holdOf(ctx, behind.id)).toMatchObject({ status: "ACTIVE", position: 1 });
    expect(result.holdNotificationIntents).toEqual([
      expect.objectContaining({ kind: "hold.position_changed", holdId: behind.id, position: 1 }),
    ]);
    expect(result.staffRecipientHint).not.toBeNull();
  });

  it("after commit: both sides told through `booking.booking-cancelled` (review W4) with the reason; joined acts told it isn't going ahead", async () => {
    const ctx = booked();

    await cancel(ctx);

    expect(CANCELLED_HOOK).toHaveBeenCalledTimes(1);
    expect(CANCELLED_HOOK).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_A }),
      holdId: ctx.hold.id,
      night: DATE,
      cancelledBy: "venue",
      reason: REASON,
      eventCancelled: true,
      actorHumanId: VENUE_ADMIN,
    });
    expect(JOINED_ACT_HOOK).toHaveBeenCalledWith(
      expect.objectContaining({ closedBy: "booking_cancelled", actorHumanId: VENUE_ADMIN }),
    );
  });

  it("a throwing cancelled-notice hook is swallowed: logged at error AND reported (guarded); the cancel stands", async () => {
    const ctx = booked();
    CANCELLED_HOOK.mockRejectedValueOnce(new Error("mailer down"));
    vi.mocked(ctx.deps.reportError!).mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(cancel(ctx)).resolves.toMatchObject({ holdId: ctx.hold.id });
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "mailer down" }),
      expect.objectContaining({ tags: { useCase: "cancelBooking", step: "booking_cancelled" } }),
    );
  });

  it("a throwing joined-acts notice is swallowed: logged at error AND reported, guarded", async () => {
    const ctx = booked();
    JOINED_ACT_HOOK.mockRejectedValueOnce(new Error("mailer down"));
    vi.mocked(ctx.deps.reportError!).mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(cancel(ctx)).resolves.toMatchObject({ holdId: ctx.hold.id });
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "mailer down" }),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "cancelBooking" }) }),
    );
  });
});

describe("cancelBooking — refusals (nothing written)", () => {
  const nothingWritten = (ctx: Booked) => {
    expect(holdOf(ctx, ctx.hold.id).status).not.toBe("RELEASED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
  };

  it("an outsider → NOT_RESOURCE_OWNER, before anything about the booking is said", async () => {
    const ctx = booked();
    await expect(cancel(ctx, OUTSIDER_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    nothingWritten(ctx);
  });

  it("a VIEWER on the venue org → INSUFFICIENT_ROLE", async () => {
    const ctx = booked();
    await expect(cancel(ctx, VIEWER_ID)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    nothingWritten(ctx);
  });

  it("another act → NOT_RESOURCE_OWNER (only this request's sender pair)", async () => {
    const ctx = booked();
    await expect(cancel(ctx, ACT_B_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    nothingWritten(ctx);
  });

  it("no booked night (no CONFIRMED hold) → BOOKING_NOT_CANCELLABLE", async () => {
    const ctx = booked();
    ctx.bookingHolds.rows.set(ctx.hold.id, { ...ctx.hold, status: "ACTIVE", confirmedAt: null });
    await expect(cancel(ctx)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("the event has started → BOOKING_NOT_CANCELLABLE", async () => {
    // Booked for TODAY (NOW is 07:00 CDT on 2026-06-10); the show began a
    // minute ago, on the booked night.
    const ctx = booked({ event: { startsAt: new Date(NOW.getTime() - 60_000) } });
    ctx.bookingHolds.rows.set(ctx.hold.id, { ...ctx.hold, date: "2026-06-10" });
    await expect(cancel(ctx)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    nothingWritten(ctx);
  });

  it("no event and the booked night has passed → BOOKING_NOT_CANCELLABLE", async () => {
    const ctx = booked({ event: null, agreement: { proposedDate: null } });
    ctx.bookingHolds.rows.set(ctx.hold.id, { ...ctx.hold, date: "2026-06-01" });
    await expect(cancel(ctx)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
  });

  it("a COMPLETED event → BOOKING_NOT_CANCELLABLE", async () => {
    const ctx = booked({ event: { status: "COMPLETED" } });
    await expect(cancel(ctx)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    nothingWritten(ctx);
  });

  it("the reason is required, and a markup-only reason is no reason (sanitized first)", async () => {
    const ctx = booked();
    await expect(
      cancelBooking(ctx.deps, { actorHumanId: VENUE_ADMIN, bookingRequestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(cancel(ctx, VENUE_ADMIN, "<b></b>")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(cancel(ctx, VENUE_ADMIN, "x".repeat(1001))).rejects.toMatchObject({ code: "invalid_input" });
    nothingWritten(ctx);
  });

  it("the reason reaches the ledger SANITIZED", async () => {
    const ctx = booked();
    await cancel(ctx, VENUE_ADMIN, "<script>alert(1)</script>Flooded basement.");
    expect(ctx.entries(REQUEST_A)[0]!.data).toEqual({ by: "place", reason: "Flooded basement." });
  });

  // Orchestrator ruling kept; the mechanism moved (holds-without-a-request
  // FR-002): the staff gate has no grant arm, so a grantee is refused as the
  // venue side (was: passed it, then refused grant_cannot_cancel_booking).
  it("a booking GRANT holder cannot cancel a booking at all: the staff gate's NOT_RESOURCE_OWNER, nothing written", async () => {
    for (const event of [undefined, null] as const) {
      const ctx = booked(event === null ? { event: null } : {});
      ctx.placeBookingGrants.seed({
        placeId: ctx.place.id,
        humanId: OUTSIDER_ID,
        calendarId: null,
      });
      await expect(cancel(ctx, OUTSIDER_ID)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
      nothingWritten(ctx);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1, BLOCKING 2 (orchestrator ruling): the side that OWNS the
// live event cancels it — and refunds its sales — only on cancelEvent's own
// bar (OWNER / ADMIN). The other side keeps its booking gate.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelBooking — the event-owning side needs OWNER / ADMIN", () => {
  const nothingWritten = (ctx: Booked) => {
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
  };

  it("an EDITOR of the venue org (the owning side) is refused INSUFFICIENT_ROLE, nothing written", async () => {
    const ctx = booked();
    await expect(cancel(ctx, STAFF_ID)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    nothingWritten(ctx);
  });

  it("an ADMIN of the venue org cancels (and refunds) its own event", async () => {
    const ctx = booked();
    await expect(cancel(ctx, VENUE_ADMIN)).resolves.toMatchObject({ cancelledBy: "place", eventId: EVENT_ID });
  });

  it("with no live event (nothing to refund) the venue's EDITOR may still cancel: the booking gate alone", async () => {
    const ctx = booked({ event: null });
    await expect(cancel(ctx, STAFF_ID)).resolves.toMatchObject({ cancelledBy: "place", eventId: null });
  });

  it("the OTHER party (the sender, on a venue-owned event) cancels on its booking gate", async () => {
    const ctx = booked();
    const result = await cancel(ctx, ACT_A_ID);
    expect(result).toMatchObject({ cancelledBy: "sender" });
    // The venue's event id is the venue's: the sender's output omits it.
    expect(result).not.toHaveProperty("eventId");
    expect(ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
  });

  describe("a REQUESTER-owned event (RENT / USE): the sender is the owning side", () => {
    const requesterOwned = { event: { orgId: null, humanId: ACT_A_ID } };

    it("the act owns it and cancels it", async () => {
      const ctx = booked(requesterOwned);
      const result = await cancel(ctx, ACT_A_ID);
      expect(result).toMatchObject({ cancelledBy: "sender" });
      expect(result).not.toHaveProperty("eventId");
      expect(ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
    });

    it("the venue's EDITOR is the non-owning side: its booking gate is enough", async () => {
      const ctx = booked(requesterOwned);
      await expect(cancel(ctx, STAFF_ID)).resolves.toMatchObject({ cancelledBy: "place", eventId: EVENT_ID });
    });

    // Round 3, W1b (defence in depth): finalize refuses to link a third
    // party's event, but a row that carries one anyway is a stranger's
    // sales — then EVERY canceller must hold that owner's OWNER / ADMIN role,
    // whichever side of the booking they are on.
    it("a THIRD PARTY's org event: the venue's ADMIN and the act are both refused INSUFFICIENT_ROLE; only that org's ADMIN (who is also a booking party) cancels", async () => {
      const THIRD_ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
      const run = (actor: string, thirdOrgRole: "ADMIN" | "EDITOR" | null) => {
        const ctx = booked({ event: { orgId: THIRD_ORG, humanId: null } });
        const authz = ctx.repos.authz as unknown as { getOrgMembership: ReturnType<typeof vi.fn> };
        const prior = authz.getOrgMembership.getMockImplementation()!;
        authz.getOrgMembership.mockImplementation(async (input: { orgId: string; humanId: string }) =>
          input.orgId === THIRD_ORG
            ? thirdOrgRole && input.humanId === actor
              ? { orgId: THIRD_ORG, humanId: actor, role: thirdOrgRole }
              : null
            : prior(input),
        );
        return { ctx, outcome: cancel(ctx, actor) };
      };

      // The venue org's ADMIN: a booking party, but not the event's owner.
      const venue = run(VENUE_ADMIN, null);
      await expect(venue.outcome).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(cancelEventForBookingMock).not.toHaveBeenCalled();
      expect(holdOf(venue.ctx, venue.ctx.hold.id).status).toBe("CONFIRMED");
      // The act (sender pair): the same.
      const act = run(ACT_A_ID, null);
      await expect(act.outcome).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      // An EDITOR of the owning org, even as a booking party: still refused.
      await expect(run(VENUE_ADMIN, "EDITOR").outcome).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      // A booking party who is ALSO the owning org's ADMIN cancels (and refunds).
      const owner = run(VENUE_ADMIN, "ADMIN");
      await expect(owner.outcome).resolves.toMatchObject({ cancelledBy: "place", eventId: EVENT_ID });
      expect(owner.ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
    });

    it("an org-owned requester event: an EDITOR of the act org (sender pair) is refused, its ADMIN cancels", async () => {
      const ACT_ORG = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
      const EDITOR = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
      const ADMIN = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e0";
      for (const [actor, ok] of [[EDITOR, false], [ADMIN, true]] as const) {
        const ctx = booked({ event: { orgId: ACT_ORG, humanId: null } });
        ctx.requests.set(REQUEST_A, {
          ...ctx.requests.get(REQUEST_A)!,
          performerOwnerType: "organization",
          performerOwnerId: ACT_ORG,
        } as never);
        const memberships = [
          { orgId: ACT_ORG, humanId: EDITOR, role: "EDITOR" },
          { orgId: ACT_ORG, humanId: ADMIN, role: "ADMIN" },
        ];
        const authz = ctx.repos.authz as unknown as {
          getOrgMembership: ReturnType<typeof vi.fn>;
        };
        const prior = authz.getOrgMembership.getMockImplementation()!;
        authz.getOrgMembership.mockImplementation(async (input: { orgId: string; humanId: string }) =>
          memberships.find((m) => m.orgId === input.orgId && m.humanId === input.humanId) ?? prior(input),
        );
        const outcome = cancel(ctx, actor);
        if (ok) await expect(outcome).resolves.toMatchObject({ cancelledBy: "sender" });
        else await expect(outcome).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1, BLOCKING 1: the event a cancel acts on must sit on the
// booked night's line. Finalize can link the terms to another show.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelBooking — only the booked night's event is cancelled", () => {
  /** 20:00 CDT on 2026-06-27 — a week after the booked night (DATE). */
  const NEXT_WEEK = new Date("2026-06-28T01:00:00.000Z");
  const OTHER_SHOW = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";

  /** The terms finalized against the venue's OTHER show, the minted draft's anchor dropped. */
  function finalizedOffNight(over: Partial<EventRow> = {}) {
    const ctx = booked({ agreement: { eventId: OTHER_SHOW, draftEventId: null } });
    ctx.events.set(OTHER_SHOW, {
      id: OTHER_SHOW,
      startsAt: NEXT_WEEK,
      status: "PUBLISHED",
      orgId: ORG_ID,
      humanId: null,
      placeId: ctx.place.id,
      calendarId: CALENDAR_ID,
      ...over,
    } as never);
    return ctx;
  }

  it("venue side: the finalized link is another night's show → HOLD_DATE_MISMATCHES_EVENT (with meta); nothing cancelled, refunded or released", async () => {
    const ctx = finalizedOffNight();
    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: expect.objectContaining({ eventId: OTHER_SHOW, holdDate: DATE }),
    });
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
    expect(ctx.events.get(OTHER_SHOW)).toMatchObject({ status: "PUBLISHED" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("sender side: the same → EVENT_ON_ANOTHER_NIGHT with NO meta", async () => {
    const ctx = finalizedOffNight();
    const error = await cancel(ctx, ACT_A_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "EVENT_ON_ANOTHER_NIGHT" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
  });

  it("the right day on ANOTHER calendar → EVENT_ON_ANOTHER_CALENDAR (venue); nothing cancelled", async () => {
    const ctx = finalizedOffNight({ startsAt: NIGHT_AT, calendarId: OTHER_CALENDAR_ID });
    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({ code: "EVENT_ON_ANOTHER_CALENDAR" });
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
  });

  it("re-checked UNDER THE LOCKS: an event moved off the night after the pre-flight is refused inside the transaction (nothing of the booking written)", async () => {
    const ctx = booked();
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      // Moved to next week between the pre-flight and cancelEvent's tx.
      ctx.events.set(EVENT_ID, { ...(ctx.events.get(EVENT_ID) as object), startsAt: NEXT_WEEK } as never);
      return real(deps, args);
    });

    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({ code: "HOLD_DATE_MISMATCHES_EVENT" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("re-checked UNDER THE LOCKS: the terms re-linked to another event after the pre-flight → HOLD_LINE_CHANGED (sender: no meta)", async () => {
    const ctx = booked();
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, draftEventId: null, eventId: OTHER_SHOW });
      return real(deps, args);
    });

    const error = await cancel(ctx, ACT_A_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "HOLD_LINE_CHANGED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
  });
});

// Review round 1, W5: the venue's sales are not the sender's to see.
describe("cancelBooking — the sender's output carries nothing venue-internal", () => {
  it("the sender gets no refund counts and no event id; the venue gets both", async () => {
    const sender = await cancel(booked(), ACT_A_ID);
    expect(sender).not.toHaveProperty("refundedOrderCount");
    expect(sender).not.toHaveProperty("failedRefundCount");
    expect(sender).not.toHaveProperty("eventId");
    const venue = await cancel(booked(), VENUE_ADMIN);
    expect(venue).toMatchObject({ eventId: EVENT_ID, refundedOrderCount: 2, failedRefundCount: 1 });
  });
});

describe("cancelBooking — after the cancel, the request is closed for holds and never booked again", () => {
  it("placing a hold on it → BOOKING_CANCELLED", async () => {
    const ctx = booked();
    await cancel(ctx);

    await expect(
      placeBookingHold(ctx.deps, {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        date: "2026-06-26",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_CANCELLED" });
    expect([...ctx.bookingHolds.rows.values()].filter((h) => h.bookingRequestId === REQUEST_A && h.status === "ACTIVE")).toEqual([]);
  });

  it("withdraw and close request refuse it (BOOKING_CANCELLED) — it stays ACCEPTED as history", async () => {
    const ctx = booked();
    await cancel(ctx);

    await expect(
      withdrawBookingRequest(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: "BOOKING_CANCELLED" });
    await expect(
      closeBookingRequest(ctx.deps, {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        reason: "We are closing this request.",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_CANCELLED" });
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");
  });

  it("cancelling it AGAIN → BOOKING_NOT_CANCELLABLE (cancel twice, in sequence)", async () => {
    const ctx = booked();
    await cancel(ctx);

    await expect(cancel(ctx, ACT_A_ID)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(
      ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_request.booking_cancelled"),
    ).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency, staged on the fakes: the request's booking lock is the one
// point every competitor serializes on, so each race is staged by running the
// competitor to completion AT that lock (it "held it first") and checking the
// later transaction decides on the committed result. The real lock is pinned
// on Postgres in packages/adapters …/booking-cancel.integration.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Run `competitor` to completion the first time `ctx`'s booking lock is taken. */
function onFirstBookingLock(ctx: Booked, competitor: () => Promise<unknown>) {
  const lock = vi.mocked(ctx.bookingHolds.lockRequestBooking);
  const original = lock.getMockImplementation();
  let fired = false;
  lock.mockImplementation(async (id: string) => {
    if (!fired) {
      fired = true;
      await competitor();
    }
    return original?.(id);
  });
}

describe("cancelBooking — concurrency", () => {
  it("cancel twice, concurrently, no event: the second reaches the lock after the first committed → BOOKING_NOT_CANCELLABLE; one cancellation", async () => {
    const ctx = booked({ event: null });
    let first: unknown;
    onFirstBookingLock(ctx, async () => {
      first = await cancel(ctx, VENUE_ADMIN);
    });

    await expect(cancel(ctx, ACT_A_ID)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(first).toMatchObject({ cancelledBy: "place" });
    expect(
      ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_request.booking_cancelled"),
    ).toHaveLength(1);
  });

  it("cancel twice, concurrently, with an event: both enter cancelEvent under ONE booking-scoped key — the second is IDEMPOTENCY_LOCK_IN_PROGRESS, nothing doubled", async () => {
    const ctx = booked();
    let second: unknown;
    // The first call holds the booking-scoped cancelEvent claim (its
    // transaction not yet committed — the fake tx has no isolation, so the
    // other side is run at the claim, before the first writes anything).
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      envelope.set(args.idempotencyKey, { committed: null });
      second = await cancel(ctx, ACT_A_ID).catch((e: unknown) => e);
      envelope.delete(args.idempotencyKey);
      return real(deps, args);
    });

    await cancel(ctx, VENUE_ADMIN);

    expect(second).toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
    const keys = cancelEventForBookingMock.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(
      ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_request.booking_cancelled"),
    ).toHaveLength(1);
  });

  it("cancel twice, the second replaying the first's committed cancelEvent record → BOOKING_NOT_CANCELLABLE (this call cancelled nothing)", async () => {
    const ctx = booked();
    await cancel(ctx, VENUE_ADMIN);
    // A second call whose pre-flight read predates the commit: emulate by
    // replaying the stored envelope directly with the booked state restored
    // for the pre-flight reads only.
    const releasedHold = holdOf(ctx, ctx.hold.id);
    ctx.bookingHolds.rows.set(ctx.hold.id, { ...releasedHold, status: "CONFIRMED", releasedReason: null });
    ctx.events.set(EVENT_ID, { ...(ctx.events.get(EVENT_ID) as object), status: "DRAFT" } as never);
    const real = cancelEventForBookingMock.getMockImplementation()!;
    cancelEventForBookingMock.mockImplementationOnce(async (deps, args) => {
      ctx.bookingHolds.rows.set(ctx.hold.id, releasedHold);
      return real(deps, args);
    });

    await expect(cancel(ctx, ACT_A_ID)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(
      ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_request.booking_cancelled"),
    ).toHaveLength(1);
  });

  it("cancel racing AGREE (terms re-sent for the booked night): the cancel commits first → the agree is refused, nothing re-booked", async () => {
    // Booked without terms; the venue then sent terms for the same night.
    const ctx = booked({ agreement: { status: "PROPOSED", acceptedAt: null } });
    onFirstBookingLock(ctx, () => cancel(ctx, VENUE_ADMIN));

    const error = await respondToBookingAgreement(ctx.deps as never, {
      actorHumanId: ACT_A_ID,
      agreementId: A_TERMS,
      action: "accept",
    }).catch((e: unknown) => e);

    // Under the lock the agree reads the cancelled terms (and the cancelled
    // booking): refused, and nothing on the line moved.
    expect(error).toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    expect([...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED")).toEqual([]);
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
  });

  it("cancel racing AGREE: the agree commits first → the cancel undoes that booking (ACCEPTED terms cancelled, night freed)", async () => {
    const ctx = booked({ agreement: { status: "PROPOSED", acceptedAt: null } });
    onFirstBookingLock(ctx, () =>
      respondToBookingAgreement(ctx.deps as never, {
        actorHumanId: ACT_A_ID,
        agreementId: A_TERMS,
        action: "accept",
      }),
    );

    await cancel(ctx, VENUE_ADMIN);

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(holdOf(ctx, ctx.hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
  });

  it("cancel racing BOOK WITHOUT TERMS on another hold of the request: the cancel commits first → refused, the hold released, nothing booked", async () => {
    // Booked without (dated) terms and no event yet, so book-without-terms
    // passes its pre-flight and reaches its transaction's lock.
    const ctx = booked({ event: null, agreement: { status: "DRAFT", acceptedAt: null, proposedDate: null } });
    const other = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    ctx.requests.set(REQUEST_A, {
      ...ctx.requests.get(REQUEST_A)!,
      preferredDates: [DATE, "2026-06-27"],
    });
    onFirstBookingLock(ctx, () => cancel(ctx, ACT_A_ID));

    const error = await bookNightWithoutTerms(ctx.deps as never, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      holdId: other.id,
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "BOOKING_CANCELLED" });
    expect(holdOf(ctx, other.id)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect([...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED")).toEqual([]);
    expect(holdMint).not.toHaveBeenCalled();
  });

  it("book without terms RETRIED (replay) after the cancel → the hold is not live; no mint", async () => {
    const ctx = booked();
    await cancel(ctx);

    await expect(
      bookNightWithoutTerms(ctx.deps as never, {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        holdId: ctx.hold.id,
      }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_LIVE" });
    expect(holdMint).not.toHaveBeenCalled();
  });

  it("a mint that LANDED between the pre-flight and the lock (no event when read) → HOLD_LINE_CHANGED, nothing written; a retry cancels it", async () => {
    const ctx = booked({ event: null });
    onFirstBookingLock(ctx, async () => {
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: NIGHT_AT, status: "DRAFT", orgId: ORG_ID, placeId: ctx.place.id, calendarId: CALENDAR_ID } as never);
      ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, draftEventId: EVENT_ID });
    });

    await expect(cancel(ctx)).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);

    // The retry sees the event and cancels it with the booking.
    await cancel(ctx);
    expect(ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 3, W3: the booking may point at SEVERAL events — the event-first
// origin, the finalized link, a leftover draft anchor. Cancelling one would
// leave another live and on sale on the freed night, and a resolver's pick
// could differ between the pre-flight and the transaction (every retry then
// HOLD_LINE_CHANGED, stuck). So: every linked event is checked for liveness
// SEPARATELY; more than one live → refused by name before money moves, in the
// pre-flight (and the same read-only check re-runs under the locks).
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelBooking — a booking with MORE than one live event is refused by name (round 3 W3)", () => {
  const ORIGIN_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  const SHOW_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
  const DRAFT_D = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";

  const row = (id: string, status: string): EventRow => ({ id, startsAt: NIGHT_AT, status, orgId: ORG_ID, humanId: null, placeId: "", calendarId: CALENDAR_ID });
  const setEvent = (ctx: Booked, id: string, status: string) =>
    ctx.events.set(id, { ...row(id, status), placeId: ctx.place.id } as never);

  /** Event-first request A (origin A, live on the night) with its night booked. */
  function eventFirst(over: { agreement?: Partial<AgreementRecord> } = {}) {
    const ctx = booked({ event: null, agreement: { draftEventId: null, ...over.agreement } });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_A });
    setEvent(ctx, ORIGIN_A, "PUBLISHED");
    return ctx;
  }

  const nothingWritten = (ctx: Booked, ...liveIds: string[]) => {
    expect(cancelEventForBookingMock).not.toHaveBeenCalled();
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    for (const id of liveIds) expect(ctx.events.get(id)).not.toMatchObject({ status: "CANCELLED" });
  };

  it("(i) a live origin A and terms FINALIZED to a second show B on the same night → BOOKING_HAS_MULTIPLE_EVENTS (venue: both ids); nothing cancelled or refunded", async () => {
    const ctx = eventFirst({ agreement: { eventId: SHOW_B } });
    setEvent(ctx, SHOW_B, "PUBLISHED");

    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({
      code: "BOOKING_HAS_MULTIPLE_EVENTS",
      meta: { bookingRequestId: REQUEST_A, eventIds: [ORIGIN_A, SHOW_B] },
    });
    nothingWritten(ctx, ORIGIN_A, SHOW_B);
  });

  it("(i) the sender gets the same code with NO meta (never the venue's event ids)", async () => {
    const ctx = eventFirst({ agreement: { eventId: SHOW_B } });
    setEvent(ctx, SHOW_B, "PUBLISHED");

    const error = await cancel(ctx, ACT_A_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BOOKING_HAS_MULTIPLE_EVENTS" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    nothingWritten(ctx, ORIGIN_A, SHOW_B);
  });

  it("(ii) a live origin A beside a leftover live DRAFT anchor D → refused the same way, and a RETRY says the same (never a HOLD_LINE_CHANGED loop)", async () => {
    const ctx = eventFirst({ agreement: { draftEventId: DRAFT_D } });
    setEvent(ctx, DRAFT_D, "DRAFT");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({
        code: "BOOKING_HAS_MULTIPLE_EVENTS",
        meta: { bookingRequestId: REQUEST_A, eventIds: [ORIGIN_A, DRAFT_D] },
      });
    }
    nothingWritten(ctx, ORIGIN_A, DRAFT_D);
  });

  it("a dead extra does not count: origin A live, the draft D already CANCELLED → A is the booking's one event and is cancelled", async () => {
    const ctx = eventFirst({ agreement: { draftEventId: DRAFT_D } });
    setEvent(ctx, DRAFT_D, "CANCELLED");

    await expect(cancel(ctx, VENUE_ADMIN)).resolves.toMatchObject({ cancelledBy: "place", eventId: ORIGIN_A });
    expect(cancelEventForBookingMock).toHaveBeenCalledTimes(1);
    expect(cancelEventForBookingMock.mock.calls[0]![1]).toMatchObject({ eventId: ORIGIN_A });
    expect(ctx.events.get(ORIGIN_A)).toMatchObject({ status: "CANCELLED" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("event-first with its origin alone: the pre-flight and the transaction resolve the SAME event (A), and A is cancelled with the booking", async () => {
    const ctx = eventFirst();

    await expect(cancel(ctx, VENUE_ADMIN)).resolves.toMatchObject({ eventId: ORIGIN_A, agreementId: A_TERMS });
    expect(cancelEventForBookingMock.mock.calls[0]![1]).toMatchObject({ eventId: ORIGIN_A });
    expect(ctx.events.get(ORIGIN_A)).toMatchObject({ status: "CANCELLED" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("CANCELLED");
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("a second live event that APPEARS between the pre-flight and the locks (a finalize to B lands) → HOLD_LINE_CHANGED under the lock, nothing written; the retry then refuses by name", async () => {
    const ctx = eventFirst();
    setEvent(ctx, SHOW_B, "PUBLISHED");
    onFirstBookingLock(ctx, async () => {
      ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, eventId: SHOW_B });
    });

    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({
      code: "HOLD_LINE_CHANGED",
      meta: expect.objectContaining({ eventIds: [SHOW_B] }),
    });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    // (The fake cancelEvent restores a rolled-back row to DRAFT; what
    // matters is that it was not cancelled.)
    expect(ctx.events.get(ORIGIN_A)).not.toMatchObject({ status: "CANCELLED" });

    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({ code: "BOOKING_HAS_MULTIPLE_EVENTS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 3, W5 (orchestrator ruling): a night can be booked while the request
// is still PENDING / VIEWED (an event-first request whose hold a venue confirm
// made CONFIRMED before anyone answered). Withdraw and Decline refuse that
// state with BOOKING_NIGHT_BOOKED and point here, so Cancel booking must take
// it: the request stays as it was.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelBooking — a night booked before the request was answered (round 3 W5)", () => {
  /** Event-first request A still `status`, no terms yet, its origin booked on the night. */
  function unanswered(status: "PENDING" | "VIEWED" | "DECLINED" | "WITHDRAWN" | "EXPIRED") {
    const ctx = booked({ event: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status, agreementId: null, originEventId: EVENT_ID });
    ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: NIGHT_AT, status: "PUBLISHED", orgId: ORG_ID, humanId: null, placeId: ctx.place.id, calendarId: CALENDAR_ID } as never);
    return ctx;
  }

  for (const status of ["PENDING", "VIEWED"] as const) {
    it(`${status}: the venue cancels — the origin event is cancelled, the night freed, the ledger written; the request stays ${status}`, async () => {
      const ctx = unanswered(status);

      await expect(cancel(ctx, VENUE_ADMIN)).resolves.toMatchObject({ cancelledBy: "place", eventId: EVENT_ID, agreementId: null });
      expect(ctx.events.get(EVENT_ID)).toMatchObject({ status: "CANCELLED" });
      expect(holdOf(ctx, ctx.hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
      expect(ctx.entries(REQUEST_A)).toEqual([
        { kind: "booking_request.booking_cancelled", data: { by: "place", reason: REASON }, actor: VENUE_ADMIN },
      ]);
      expect(ctx.requests.get(REQUEST_A)?.status).toBe(status);
    });

    it(`${status}: the sender (the act) can cancel it too`, async () => {
      const ctx = unanswered(status);
      await expect(cancel(ctx, ACT_A_ID)).resolves.toMatchObject({ cancelledBy: "sender" });
      expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
    });
  }

  // EXPIRED is deliberately NOT in this list (round 3, B1): the expiry sweep
  // skips any open request with a CONFIRMED hold (`expireIfDue`, pinned
  // on real Postgres in booking-request-expiry.integration.test.ts), so an
  // unanswered booked night stays PENDING / VIEWED — cancellable here — and
  // "EXPIRED with a booked night" is not a state the product produces.
  for (const status of ["DECLINED", "WITHDRAWN"] as const) {
    it(`${status} with a CONFIRMED hold (a state the exits now refuse to create) → BOOKING_NOT_CANCELLABLE, nothing written`, async () => {
      const ctx = unanswered(status);
      await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
      expect(cancelEventForBookingMock).not.toHaveBeenCalled();
      expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    });
  }

  it("a request past its TTL but booked is still cancellable (the sweep never expired it)", async () => {
    const ctx = unanswered("PENDING");
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, expiresAt: new Date("2026-01-01T00:00:00.000Z") });
    await expect(cancel(ctx, VENUE_ADMIN)).resolves.toMatchObject({ cancelledBy: "place", eventId: EVENT_ID });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("RELEASED");
  });

  it("a request answered between the pre-flight and the lock (DECLINED under us) → BOOKING_NOT_CANCELLABLE under the lock, nothing written", async () => {
    const ctx = unanswered("PENDING");
    onFirstBookingLock(ctx, async () => {
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "DECLINED" });
    });

    await expect(cancel(ctx, VENUE_ADMIN)).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(holdOf(ctx, ctx.hold.id).status).toBe("CONFIRMED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(ctx.events.get(EVENT_ID)).not.toMatchObject({ status: "CANCELLED" });
  });
});
