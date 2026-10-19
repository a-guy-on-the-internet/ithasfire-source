import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import { completeEvent } from "../complete-event";
import { findBookingThreadForEvent } from "../_shared/booking-event-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TIMELINE — the event's LIFECYCLE on its booking thread.
//
// "The booking request is the timeline of the event." After
// `booking_event.created` / `.modified` the thread used to go silent: nothing
// said the show went live, was called off, or happened — and
// `AgreementStatus.FULFILLED` had no writer at all. These tests pin the three
// lifecycle emitters that close that gap (`cancelEvent` and `completeEvent`
// here; `publishEvent` rides its own harness in publish-event.test.ts):
//
//   - an event that never came from a booking writes NOTHING and the
//     transition still succeeds (the common case must cost nothing but the
//     reverse lookup);
//   - a booked event writes its entry INSIDE the transition's own tx;
//   - completing a booked event is the ONE writer of FULFILLED, and the
//     event entry lands before the agreement entry.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const AGREEMENT_ID = "30000000-0000-4000-8000-000000000004";
const REQUEST_ID = "30000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-09-20T04:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    stewardship: "OWNED",
    title: "Riverside Jazz Night",
    slug: "riverside-jazz-night",
    startsAt: new Date("2026-09-19T01:00:00.000Z"),
    endsAt: new Date("2026-09-19T04:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

function makeAgreement(overrides: Partial<AgreementRecord> = {}): AgreementRecord {
  return {
    id: AGREEMENT_ID,
    status: "ACCEPTED",
    eventId: EVENT_ID,
    draftEventId: null,
    fulfilledAt: null,
    ...overrides,
  } as AgreementRecord;
}

/**
 * The booking-side repos every harness below shares. `linked: false` is the
 * common case — the reverse lookup misses and nothing else may be touched.
 */
function bookingRepos(options: { agreement: AgreementRecord | null }) {
  const messages = createFakeBookingRequestMessagesRepo();
  const agreements = {
    // Port contract: the finalized link (`eventId`) wins, the draft anchor
    // (`draftEventId`) is the fallback on a miss.
    findByLinkedEventId: vi.fn(async (eventId: string) =>
      options.agreement &&
      (options.agreement.eventId === eventId ||
        (options.agreement.eventId === null &&
          options.agreement.draftEventId === eventId))
        ? { ...options.agreement }
        : null,
    ),
    updateStatus: vi.fn(async (input: { id: string; status: string }) => ({
      ...(options.agreement ?? makeAgreement()),
      id: input.id,
      status: input.status,
    })),
  };
  const bookingRequests = {
    findByAgreementId: vi.fn(async (agreementId: string) =>
      options.agreement && agreementId === options.agreement.id
        ? { id: REQUEST_ID }
        : null,
    ),
    touchLastMessageAt: vi.fn(async () => undefined),
  };
  const entries = () =>
    [...messages.rows.values()]
      .filter((row) => row.systemKind)
      .map((row) => ({
        bookingRequestId: row.bookingRequestId,
        authorSide: row.authorSide,
        authorHumanId: row.authorHumanId,
        systemKind: row.systemKind,
        systemData: row.systemData,
      }));
  return { messages, agreements, bookingRequests, entries };
}

// ── cancelEvent ──────────────────────────────────────────────────────────────

function buildCancelHarness(options: { agreement: AgreementRecord | null }) {
  const event = makeEvent();
  const booking = bookingRepos(options);
  const audit = { log: vi.fn(async () => undefined) };
  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ ...event, status: "CANCELLED" })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    },
    orders: { listAll: vi.fn(async () => ({ items: [], total: 0 })) },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    payeeLedger: createFakePayeeLedgerRepo().repo,
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    audit,
    agreements: booking.agreements,
    bookingRequests: booking.bookingRequests,
    bookingRequestMessages: booking.messages,
  } as unknown as TxRepos;
  const tx = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos));
  const repos = { ...txRepos, tx } as unknown as Repos;
  const deps: CancelEventDeps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: {
      refundPaymentIntent: vi.fn(),
      getProcessingFeeForPaymentIntent: vi.fn(),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => NOW },
    logger: createTestLogger(),
  };
  return { deps, booking, tx };
}

describe("cancelEvent — booking_event.cancelled", () => {
  it("writes the entry on the booking thread, inside the cancel tx", async () => {
    const { deps, booking, tx } = buildCancelHarness({
      agreement: makeAgreement(),
    });

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: "cancel-booked-12345",
    });

    expect(result.status).toBe("CANCELLED");
    expect(booking.entries()).toEqual([
      {
        bookingRequestId: REQUEST_ID,
        authorSide: "SYSTEM",
        authorHumanId: ACTOR_ID,
        systemKind: "booking_event.cancelled",
        systemData: { eventId: EVENT_ID },
      },
    ]);
    // ONE transaction: the entry and the CANCELLED row commit or roll back
    // together. A second tx here would let the ledger outlive a rollback.
    expect(tx).toHaveBeenCalledTimes(1);
    // The recency stamp moves with the entry (port mandate on the append).
    expect(booking.bookingRequests.touchLastMessageAt).toHaveBeenCalledTimes(1);
    // The AGREEMENT is not touched: `Agreement.CANCELLED` is a negotiation
    // outcome with its own transition, not something an event cancel infers.
    expect(booking.agreements.updateStatus).not.toHaveBeenCalled();
  });

  it("writes nothing for an event that never came from a booking — and still cancels", async () => {
    const { deps, booking } = buildCancelHarness({ agreement: null });

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: "cancel-plain-12345",
    });

    expect(result.status).toBe("CANCELLED");
    expect(booking.entries()).toEqual([]);
    // The common case costs exactly one reverse lookup and nothing else.
    expect(booking.agreements.findByLinkedEventId).toHaveBeenCalledWith(EVENT_ID);
    expect(booking.bookingRequests.findByAgreementId).not.toHaveBeenCalled();
    expect(booking.bookingRequests.touchLastMessageAt).not.toHaveBeenCalled();
  });
});

// ── completeEvent ────────────────────────────────────────────────────────────

function buildCompleteHarness(options: { agreement: AgreementRecord | null }) {
  const event = makeEvent();
  const booking = bookingRepos(options);
  const audit = { log: vi.fn(async () => undefined) };
  const events = {
    lockRows: vi.fn(async () => undefined),
    getById: vi.fn(async () => event),
    complete: vi.fn(async () => ({ ...event, status: "COMPLETED" })),
  };
  const txRepos = {
    events,
    audit,
    agreements: booking.agreements,
    bookingRequests: booking.bookingRequests,
    bookingRequestMessages: booking.messages,
  } as unknown as TxRepos;
  const tx = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos));
  const repos = {
    ...txRepos,
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "ADMIN" as const,
      })),
    },
    tx,
  } as unknown as Repos;
  const deps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    clock: { now: () => NOW },
  };
  return { deps, booking, tx, audit, events };
}

describe("completeEvent — booking_event.completed + booking_agreement.fulfilled", () => {
  it("logs the completion, then moves the ACCEPTED agreement to FULFILLED and logs that", async () => {
    const { deps, booking, tx, audit } = buildCompleteHarness({
      agreement: makeAgreement({ status: "ACCEPTED" }),
    });

    const result = await completeEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, status: "COMPLETED" });
    // ORDER IS THE CLAIM: cause (the show happened) before effect (the
    // agreement is fulfilled). What this pins is WRITE order (the fake's Map
    // keeps insertion order). In Postgres both rows share the tx's
    // `createdAt`, so the thread's `[createdAt asc, id asc]` sort falls to a
    // uuid tiebreak and the on-screen order is best-effort — the same caveat
    // `booking_agreement.drafted` documents. Accepted rather than folding the
    // fulfilled fact into the completed entry: they are two different
    // aggregates' transitions, and the agreement one must link the agreement.
    expect(booking.entries()).toEqual([
      {
        bookingRequestId: REQUEST_ID,
        authorSide: "SYSTEM",
        authorHumanId: ACTOR_ID,
        systemKind: "booking_event.completed",
        systemData: { eventId: EVENT_ID },
      },
      {
        bookingRequestId: REQUEST_ID,
        authorSide: "SYSTEM",
        authorHumanId: ACTOR_ID,
        systemKind: "booking_agreement.fulfilled",
        systemData: { agreementId: AGREEMENT_ID },
      },
    ]);
    // The ONLY writer of FULFILLED — and a guarded CAS, never a blind write:
    // a concurrent cancel/dispute must surface as a conflict, not be clobbered.
    expect(booking.agreements.updateStatus).toHaveBeenCalledTimes(1);
    expect(booking.agreements.updateStatus).toHaveBeenCalledWith({
      id: AGREEMENT_ID,
      status: "FULFILLED",
      expectedFrom: ["ACCEPTED"],
      fulfilledAt: NOW,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_agreement",
        entityId: AGREEMENT_ID,
        action: "booking_agreement.fulfilled",
        data: { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
        at: NOW,
      }),
    );
    // Everything — complete, both entries, the CAS, the audit rows — in ONE tx.
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("rolls the whole completion back when the FULFILLED CAS conflicts", async () => {
    const { deps, booking } = buildCompleteHarness({
      agreement: makeAgreement({ status: "ACCEPTED" }),
    });
    // The agreement moved under us between the read and the write.
    booking.agreements.updateStatus.mockRejectedValueOnce({
      code: "conflict",
      message: "agreement_status_changed",
    });

    await expect(
      completeEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "conflict" });
    // No `booking_agreement.fulfilled` was appended after the failed CAS —
    // the ledger never claims a state the row does not have.
    expect(
      booking.entries().map((entry) => entry.systemKind),
    ).toEqual(["booking_event.completed"]);
  });

  it("never fulfils an agreement reached only through its DRAFT anchor (not finalized)", async () => {
    // The common pre-finalize state: createEventFromAgreement stamped
    // `draftEventId`, `eventId` is still NULL because finalize is blocked on
    // payout readiness. Publish does not need finalize, so the venue can
    // publish and complete that draft with the terms never applied. Writing
    // FULFILLED here would kill the agreement (AGREEMENT_NOT_ACCEPTED on
    // create, finalize's CAS 0-matches, reopen refuses) under a label that
    // says everything went fine.
    const { deps, booking } = buildCompleteHarness({
      agreement: makeAgreement({
        status: "ACCEPTED",
        eventId: null,
        draftEventId: EVENT_ID,
      }),
    });

    const result = await completeEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.status).toBe("COMPLETED");
    // The thread WAS found (through the anchor) and the show is recorded…
    expect(booking.entries().map((entry) => entry.systemKind)).toEqual([
      "booking_event.completed",
    ]);
    // …but the agreement is left ACCEPTED, finalize still possible.
    expect(booking.agreements.updateStatus).not.toHaveBeenCalled();
  });

  it.each(["FULFILLED", "DECLINED", "CANCELLED", "DISPUTED"])(
    "leaves a %s agreement alone and writes only the event entry",
    async (status) => {
      const { deps, booking } = buildCompleteHarness({
        agreement: makeAgreement({ status: status as AgreementRecord["status"] }),
      });

      await completeEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

      // A replay (already FULFILLED) or a dead agreement: the show still
      // happened, so that is recorded — but no status is invented.
      expect(booking.entries().map((entry) => entry.systemKind)).toEqual([
        "booking_event.completed",
      ]);
      expect(booking.agreements.updateStatus).not.toHaveBeenCalled();
    },
  );

  it("writes nothing and touches no agreement for an event that never came from a booking", async () => {
    const { deps, booking, events } = buildCompleteHarness({ agreement: null });

    const result = await completeEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.status).toBe("COMPLETED");
    expect(events.complete).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(booking.entries()).toEqual([]);
    expect(booking.agreements.updateStatus).not.toHaveBeenCalled();
    expect(booking.bookingRequests.touchLastMessageAt).not.toHaveBeenCalled();
  });
});

// ── findBookingThreadForEvent ────────────────────────────────────────────────

describe("findBookingThreadForEvent", () => {
  it("walks Agreement.eventId → BookingRequest.agreementId and returns both", async () => {
    const booking = bookingRepos({ agreement: makeAgreement() });
    const tx = {
      agreements: booking.agreements,
      bookingRequests: booking.bookingRequests,
    } as unknown as TxRepos;

    await expect(findBookingThreadForEvent(tx, EVENT_ID)).resolves.toEqual({
      agreement: expect.objectContaining({ id: AGREEMENT_ID }),
      bookingRequest: { id: REQUEST_ID },
    });
  });

  it("is null on an agreement miss WITHOUT probing for a request", async () => {
    const booking = bookingRepos({ agreement: null });
    const tx = {
      agreements: booking.agreements,
      bookingRequests: booking.bookingRequests,
    } as unknown as TxRepos;

    await expect(findBookingThreadForEvent(tx, EVENT_ID)).resolves.toBeNull();
    expect(booking.bookingRequests.findByAgreementId).not.toHaveBeenCalled();
  });

  it("is null for an agreement minted outside the inbox (no thread behind it)", async () => {
    const booking = bookingRepos({ agreement: makeAgreement() });
    booking.bookingRequests.findByAgreementId.mockResolvedValueOnce(null);
    const tx = {
      agreements: booking.agreements,
      bookingRequests: booking.bookingRequests,
    } as unknown as TxRepos;

    await expect(findBookingThreadForEvent(tx, EVENT_ID)).resolves.toBeNull();
  });
});
