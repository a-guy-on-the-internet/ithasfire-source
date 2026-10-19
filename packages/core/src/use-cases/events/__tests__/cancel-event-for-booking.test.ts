import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  cancelEvent,
  cancelEventForBooking,
  type CancelEventDeps,
} from "../cancel-event";
import { reverseTransfersForItems } from "../../orders/reverse-transfers-for-items";

vi.mock("../../orders/reverse-transfers-for-items", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../orders/reverse-transfers-for-items")>()),
  reverseTransfersForItems: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Cancel booking's entry into cancelEvent (booking-the-night FR-009, N13):
// the SAME cancellation (refunds, outbox, …) with the booking's writes run
// INSIDE its transaction, the access decided on the booking by the caller,
// and a booking-scoped idempotency key that also prefixes the Stripe keys.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
/** The act cancelling: NOT a member of the event's (venue) org. */
const SENDER_ID = "30000000-0000-4000-8000-000000000003";
const BUYER_ID = "30000000-0000-4000-8000-000000000004";
const ORDER_ID = "30000000-0000-4000-8000-000000000005";
const KEY = "bookingRequest:cancelBooking:44444444-4444-4444-8444-444444444444:55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-05-10T18:00:00.000Z");

/** Calls of an idempotency mock on OUR key (the refund mutex uses its own). */
const onKey = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((c) => c[0] === KEY);

/** Reports carrying a given `stage` tag (other swallows share the reporter). */
const reportsAt = (reportError: { mock: { calls: unknown[][] } }, stage: string) =>
  reportError.mock.calls.filter(
    (c) => (c[1] as { tags?: { stage?: string } } | undefined)?.tags?.stage === stage,
  );

/** Make one idempotency method throw for OUR key only (the refund mutex shares the mock). */
function throwOnKey(mock: ReturnType<typeof vi.fn>, error: Error) {
  const original = mock.getMockImplementation()!;
  mock.mockImplementation(async (key: string, ...rest: unknown[]) => {
    if (key === KEY) throw error;
    return (original as (...a: unknown[]) => unknown)(key, ...rest);
  });
}

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Friday at the venue",
    slug: "friday-at-the-venue",
    startsAt: new Date("2026-06-01T20:00:00.000Z"),
    endsAt: new Date("2026-06-01T23:00:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makeOrder(itemIds: readonly string[] = [`${ORDER_ID}-item`], paidOut = false): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 2500,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: `pi_${ORDER_ID}`,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: itemIds.map((id) => ({
      id,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 2500 / itemIds.length,
      amountCents: 2500 / itemIds.length,
      meta: { buyerTotalCents: 2500 / itemIds.length },
      paidOutAt: paidOut ? new Date("2026-05-01T00:00:00.000Z") : null,
      refundedAt: null,
      transferredAt: null,
      resaleListingId: null,
      status: "active",
    })),
  } as unknown as OrderRecord;
}

function harness(options: { itemIds?: readonly string[]; paidOut?: boolean; status?: EventRecord["status"] } = {}) {
  const event = { ...makeEvent(), ...(options.status ? { status: options.status } : {}) } as EventRecord;
  const order = makeOrder(options.itemIds, options.paidOut);
  const calls: string[] = [];
  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        calls.push("events.cancel");
        return { ...event, status: "CANCELLED" };
      }),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    orders: {
      listTaxLinesByOrderIds: vi.fn(async () => new Map()),
      listAll: vi.fn(async () => ({
        items: [{ id: order.id, stripePaymentIntentId: order.stripePaymentIntentId }],
        total: 1,
      })),
      getById: vi.fn(async () => order),
      markRefunded: vi.fn(async () => undefined),
    },
    orderItems: { updateStatus: vi.fn(async () => undefined) },
    tickets: { listByOrderId: vi.fn(async () => []) },
    resaleListings: { cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })) },
    payeeLedger: createFakePayeeLedgerRepo().repo,
    images: { listByOwner: vi.fn(async () => []), softDelete: vi.fn(async () => undefined) },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: {
      create: vi.fn(async () => {
        calls.push("eventChangeNotices.create");
        return { id: "notice-1", createdAt: NOW };
      }),
    },
    audit: {
      log: vi.fn(async (entry: { action: string }) => {
        calls.push(`audit:${entry.action}`);
      }),
    },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
      calls.push("tx:open");
      const out = await fn(txRepos);
      calls.push("tx:commit");
      return out;
    }),
  } as unknown as Repos;
  const refundPaymentIntent = vi.fn(async () => ({ refundId: "re_1", status: "succeeded" }));
  const idempotency = createFakeIdempotencyPort();
  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const reportError = vi.fn();
  const deps: CancelEventDeps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency,
    clock: { now: vi.fn(() => NOW) },
    logger,
    reportError,
  };
  return { deps, txRepos, calls, refundPaymentIntent, idempotency, logger, reportError };
}

describe("cancelEventForBooking", () => {
  it("runs the booking's writes INSIDE the cancellation's transaction, right after the event row is cancelled", async () => {
    const { deps, txRepos, calls } = harness();
    const withinTx = vi.fn(async (tx: TxRepos, event: EventRecord) => {
      calls.push("withinTx");
      expect(tx).toBe(txRepos);
      expect(event.id).toBe(EVENT_ID);
    });

    const result = await cancelEventForBooking(deps, {
      actorHumanId: SENDER_ID,
      eventId: EVENT_ID,
      idempotencyKey: KEY,
      withinTx,
    });

    expect(result).toMatchObject({ eventId: EVENT_ID, status: "CANCELLED", refundedOrderCount: 1 });
    expect(withinTx).toHaveBeenCalledTimes(1);
    const at = (label: string) => calls.indexOf(label);
    expect(at("tx:open")).toBeLessThan(at("events.cancel"));
    expect(at("events.cancel")).toBeLessThan(at("withinTx"));
    expect(at("withinTx")).toBeLessThan(at("eventChangeNotices.create"));
    expect(at("eventChangeNotices.create")).toBeLessThan(at("tx:commit"));
  });

  it("does not run the event-owner check (the booking authorized the actor) and the audit row says so", async () => {
    const { deps, txRepos } = harness();

    await cancelEventForBooking(deps, {
      actorHumanId: SENDER_ID,
      eventId: EVENT_ID,
      idempotencyKey: KEY,
      withinTx: async () => {},
    });

    expect(vi.mocked(txRepos.authz.getOrgMembership)).not.toHaveBeenCalled();
    expect(vi.mocked(txRepos.audit.log)).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "cancelled",
        data: expect.objectContaining({ actorHumanId: SENDER_ID, via: "booking_cancel" }),
      }),
    );
  });

  it("refunds per the existing rules, under the BOOKING-scoped key (the Stripe key derives from it, never from the actor)", async () => {
    const { deps, refundPaymentIntent } = harness();

    await cancelEventForBooking(deps, {
      actorHumanId: SENDER_ID,
      eventId: EVENT_ID,
      idempotencyKey: KEY,
      withinTx: async () => {},
    });

    expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
    const [arg] = refundPaymentIntent.mock.calls[0] as unknown as [{ idempotencyKey: string }];
    expect(arg.idempotencyKey.startsWith(`${KEY}:order:${ORDER_ID}`)).toBe(true);
  });

  it("a throw from withinTx fails the cancellation: nothing after it runs, the claim is RELEASED (abandonClaim), the error propagates", async () => {
    const { deps, txRepos, idempotency } = harness();
    const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
    const refused = new Error("booking_not_cancellable");

    await expect(
      cancelEventForBooking(deps, {
        actorHumanId: SENDER_ID,
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    expect(vi.mocked(txRepos.eventChangeNotices.create)).not.toHaveBeenCalled();
    expect(onKey(fp.__mocks.release)).toHaveLength(1);
    expect(onKey(fp.__mocks.fail)).toHaveLength(0);
  });

  it("a replay under the same key (either side) returns the stored result and never runs withinTx again", async () => {
    const { deps } = harness();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    const a = await cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: first });
    const b = await cancelEventForBooking(deps, {
      actorHumanId: "30000000-0000-4000-8000-0000000000ff",
      eventId: EVENT_ID,
      idempotencyKey: KEY,
      withinTx: second,
    });

    expect(b).toEqual(a);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("the public cancelEvent is unchanged: still the owner check (a non-member is refused) and no `via` on an owner's audit row", async () => {
    const { deps } = harness();

    await expect(
      cancelEvent(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, clientKey: "client-key-1234" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  // ── Any failure before `after_commit` RELEASES the claim (owner-checked,
  //    lib/idempotency-claim.ts) instead of leaving a failed marker, so the
  //    immediate retry runs under the SAME key — the same Stripe refund keys.
  //    (This replaced review W2's narrower "provably nothing committed" rule.)
  describe("the idempotency claim after a failure", () => {
    it("a withinTx refusal → the claim is RELEASED (never failed); the immediate retry succeeds and reuses the Stripe keys", async () => {
      const { deps, refundPaymentIntent, idempotency } = harness();
      const fp = idempotency as unknown as {
        __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn>; begin: ReturnType<typeof vi.fn> };
      };
      let attempt = 0;
      const withinTx = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("hold_line_changed");
      });

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx }),
      ).rejects.toThrow("hold_line_changed");
      expect(onKey(fp.__mocks.release)).toEqual([[KEY, expect.any(String)]]);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
      // The claim was taken with an owner token (what `release` checks).
      expect(fp.__mocks.begin.mock.calls[0]![2]).toEqual(expect.any(String));

      // Either side retries at once, under the same booking-scoped key.
      const retried = await cancelEventForBooking(deps, {
        actorHumanId: "30000000-0000-4000-8000-0000000000ff",
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx,
      });
      expect(retried).toMatchObject({ status: "CANCELLED", refundedOrderCount: 1 });
      expect(withinTx).toHaveBeenCalledTimes(2);
      // Same Stripe idempotency keys both times: Stripe returns the refund it
      // already made instead of making a second one.
      const keys = refundPaymentIntent.mock.calls.map(
        (c) => (c as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("a rolled-back transaction (deadlock 40P01 / P2034) → released too", async () => {
      for (const error of [
        Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), { code: "P2034" }),
        new Error("Raw query failed. Code: `40P01`. Message: `deadlock detected`"),
      ]) {
        const { deps, txRepos, idempotency } = harness();
        vi.mocked(txRepos.eventChangeNotices.create).mockRejectedValueOnce(error);
        const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };

        await expect(
          cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} }),
        ).rejects.toBe(error);
        expect(onKey(fp.__mocks.release)).toHaveLength(1);
        expect(onKey(fp.__mocks.fail)).toHaveLength(0);
      }
    });

    it("a refusal before any refund (the event already cancelled) → released", async () => {
      const { deps, txRepos, idempotency } = harness();
      vi.mocked(txRepos.events.getById).mockResolvedValueOnce({ ...makeEvent(), status: "CANCELLED" } as EventRecord);
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} }),
      ).rejects.toMatchObject({ code: "EVENT_ALREADY_CANCELLED" });
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    // Unified on `abandonClaim` (lib/idempotency-claim.ts): every failure
    // before `after_commit` releases. The old failed marker only DELAYED the
    // same-key retry 15 minutes; it never changed what that retry does. A
    // retry re-sends the same Stripe refund keys (Stripe hands back the
    // refunds it made), and a transaction that did reach COMMIT leaves the
    // event CANCELLED, so the retry stops at EVENT_ALREADY_CANCELLED.
    it("an UNCLASSIFIED error in the transaction (may have reached COMMIT) is released too", async () => {
      const { deps, txRepos, idempotency } = harness();
      vi.mocked(txRepos.eventChangeNotices.create).mockRejectedValueOnce(new Error("connection reset"));
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} }),
      ).rejects.toThrow("connection reset");
      expect(onKey(fp.__mocks.release)).toEqual([[KEY, expect.any(String)]]);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    it("an error while collecting the refunds is released: the immediate retry runs under the same key", async () => {
      const { deps, txRepos, idempotency } = harness();
      vi.mocked(txRepos.orders.listAll).mockRejectedValueOnce(new Error("db down"));
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
      const args = { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} };

      await expect(cancelEventForBooking(deps, args)).rejects.toThrow("db down");
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);

      const out = await cancelEventForBooking(deps, args);
      expect(out.status).toBe("CANCELLED");
    });

    it("the public cancelEvent releases too: owner token on begin, owner-checked release on the actor-scoped key", async () => {
      const { deps, txRepos, idempotency } = harness();
      vi.mocked(txRepos.authz.getOrgMembership).mockResolvedValue({ orgId: ORG_ID, humanId: SENDER_ID, role: "OWNER" } as never);
      vi.mocked(txRepos.eventChangeNotices.create).mockRejectedValueOnce(
        Object.assign(new Error("deadlock"), { code: "P2034" }),
      );
      const fp = idempotency as unknown as {
        __mocks: { begin: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };
      };
      const input = { actorHumanId: SENDER_ID, eventId: EVENT_ID, clientKey: "client-key-1234" };

      await expect(cancelEvent(deps, input)).rejects.toThrow("deadlock");
      const publicKey = `event:cancel:${SENDER_ID}:client-key-1234`;
      const begin = fp.__mocks.begin.mock.calls.find((c) => c[0] === publicKey);
      expect(begin?.[2]).toEqual(expect.any(String));
      expect(fp.__mocks.release.mock.calls.filter((c) => c[0] === publicKey)).toEqual([[publicKey, begin?.[2]]]);
      expect(fp.__mocks.fail.mock.calls.filter((c) => c[0] === publicKey)).toHaveLength(0);

      // The operator's same-key retry is not locked out.
      const out = await cancelEvent(deps, input);
      expect(out.status).toBe("CANCELLED");
    });
  });
  // ── A retry racing a COMMIT that was still in flight. The first attempt's
  //    tx committed but its client saw an error, so the claim was released.
  //    The retry's load (outside the tx) still read PUBLISHED; only the
  //    re-read UNDER the event row lock sees the committed CANCELLED.
  describe("the in-tx row-lock pin (every entry)", () => {
    it("refuses EVENT_ALREADY_CANCELLED under the lock: no second cancel, no second notice, no second booking write", async () => {
      const { deps, txRepos } = harness();
      const tx = (deps.repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx;
      const original = tx.getMockImplementation()!;
      tx.mockImplementationOnce(async (fn: (t: TxRepos) => Promise<unknown>) => {
        await (original as (f: typeof fn) => Promise<unknown>)(fn);
        throw new Error("connection reset after COMMIT");
      });
      const withinTx = vi.fn(async () => {});
      const args = { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx };

      await expect(cancelEventForBooking(deps, args)).rejects.toThrow("connection reset after COMMIT");
      expect(vi.mocked(txRepos.eventChangeNotices.create)).toHaveBeenCalledTimes(1);
      expect(withinTx).toHaveBeenCalledTimes(1);

      const live = (await txRepos.events.getById(EVENT_ID))!;
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce(live) // the retry's load, outside the tx: stale
        .mockResolvedValueOnce({ ...live, status: "CANCELLED" } as EventRecord); // under the lock

      await expect(cancelEventForBooking(deps, args)).rejects.toMatchObject({
        code: "EVENT_ALREADY_CANCELLED",
      });
      expect(vi.mocked(txRepos.events.cancel)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(txRepos.eventChangeNotices.create)).toHaveBeenCalledTimes(1);
      expect(withinTx).toHaveBeenCalledTimes(1);
    });

    it("refunds re-sent into an already-committed cancel are reported as a REPLAY, never as a rollback on a live event", async () => {
      const { deps, txRepos, reportError, refundPaymentIntent } = harness();
      const live = (await txRepos.events.getById(EVENT_ID))!;
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce(live) // the load, outside the tx: stale
        .mockResolvedValueOnce({ ...live, status: "CANCELLED" } as EventRecord); // under the lock

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} }),
      ).rejects.toMatchObject({ code: "EVENT_ALREADY_CANCELLED" });

      expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
      expect(reportsAt(reportError, "refund_replayed_into_committed_cancel")).toEqual([
        [
          expect.objectContaining({ code: "EVENT_ALREADY_CANCELLED" }),
          {
            tags: { useCase: "cancelEvent", stage: "refund_replayed_into_committed_cancel" },
            extra: expect.objectContaining({ eventId: EVENT_ID, refundedOrderIds: [expect.any(String)] }),
          },
        ],
      ]);
    });

    it("everything after the lock uses the LOCKED row: the booking's withinTx and the buyers' notice see it, not the pre-tx load", async () => {
      const { deps, txRepos } = harness();
      const live = (await txRepos.events.getById(EVENT_ID))!;
      const lockedRow = { ...live, title: "Renamed under the lock" } as EventRecord;
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce(lockedRow);
      const withinTx = vi.fn(async () => {});

      await cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx });

      expect(withinTx).toHaveBeenCalledWith(txRepos, lockedRow);
      const notice = vi.mocked(txRepos.eventChangeNotices.create).mock.calls[0]![0];
      expect(JSON.stringify(notice)).toContain("Renamed under the lock");
    });

    it("the public cancelEvent takes the same pin", async () => {
      const { deps, txRepos } = harness();
      vi.mocked(txRepos.authz.getOrgMembership).mockResolvedValue({ orgId: ORG_ID, humanId: SENDER_ID, role: "OWNER" } as never);
      const live = (await txRepos.events.getById(EVENT_ID))!;
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce({ ...live, status: "CANCELLED" } as EventRecord);

      await expect(
        cancelEvent(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, clientKey: "client-key-1234" }),
      ).rejects.toMatchObject({ code: "EVENT_ALREADY_CANCELLED" });
      expect(vi.mocked(txRepos.events.lockRows)).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.eventChangeNotices.create)).not.toHaveBeenCalled();
    });
  });

  // ── Review round 2, BLOCKING: a release that itself fails is NOT silent.
  // Now `abandonClaim`'s contract: logged at error + reported, and NO `fail`
  // fallback — the claim's own TTL (5 min) is the backstop, and an
  // unconditional `fail` could overwrite a newer holder's live claim.
  describe("a failed idempotency release (round 2 BLOCKING)", () => {
    const releaseDown = new Error("redis: connection refused");
    type FakeIdem = { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
    const STAGE = "idempotency_claim_release_failed";

    it("logs at error and reports with the stage tag, never falls back to `fail`; the cancel's own error still propagates", async () => {
      const { deps, idempotency, logger, reportError } = harness();
      const fp = idempotency as unknown as FakeIdem;
      throwOnKey(fp.__mocks.release, releaseDown);
      const refused = new Error("booking_not_cancellable");

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw refused;
          },
        }),
      ).rejects.toBe(refused);

      expect(logger.error).toHaveBeenCalledWith(STAGE, expect.objectContaining({ key: KEY }));
      expect(reportError).toHaveBeenCalledWith(releaseDown, {
        tags: { useCase: "cancelEvent", stage: STAGE },
        extra: { key: KEY },
      });
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    it("a THROWING reporter changes nothing: the original error still propagates", async () => {
      const { deps, idempotency, reportError } = harness();
      const fp = idempotency as unknown as FakeIdem;
      throwOnKey(fp.__mocks.release, releaseDown);
      reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      const refused = new Error("booking_not_cancellable");

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw refused;
          },
        }),
      ).rejects.toBe(refused);
      expect(reportsAt(reportError, STAGE)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    it("no reporter wired: still logged, still no crash", async () => {
      const { deps, idempotency, logger } = harness();
      const bare = { ...deps, reportError: undefined };
      throwOnKey((idempotency as unknown as FakeIdem).__mocks.release, releaseDown);

      await expect(
        cancelEventForBooking(bare, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw new Error("x");
          },
        }),
      ).rejects.toThrow("x");
      expect(logger.error).toHaveBeenCalledWith(STAGE, expect.objectContaining({ key: KEY }));
    });

    it("a release that returns false (claim lost) is reported as lost and leaves the record untouched (no `fail` over a newer holder)", async () => {
      const { deps, idempotency, reportError } = harness();
      const fp = idempotency as unknown as FakeIdem;
      const original = fp.__mocks.release.getMockImplementation()!;
      fp.__mocks.release.mockImplementation(async (key: string, token: string) =>
        key === KEY ? false : original(key, token),
      );

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw new Error("x");
          },
        }),
      ).rejects.toThrow("x");
      expect(reportsAt(reportError, "idempotency_claim_lost_on_abandon")).toEqual([
        [expect.any(Error), { tags: { useCase: "cancelEvent", stage: "idempotency_claim_lost_on_abandon" }, extra: { key: KEY } }],
      ]);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });
  });

  // ── Review round 2, W1(a): refunds out, then the cancellation rolls back.
  describe("refunded, then rolled back (round 2 W1)", () => {
    it("a booking refusal inside the tx AFTER refunds: logged at error + reported (stage, event, refunded orders, code) BEFORE the rethrow; the event stays live", async () => {
      const { deps, txRepos, logger, reportError } = harness();
      const refusal = Object.assign(new Error("hold_date_mismatches_event"), { code: "HOLD_DATE_MISMATCHES_EVENT" });

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw refusal;
          },
        }),
      ).rejects.toBe(refusal);

      expect(logger.error).toHaveBeenCalledWith(
        "cancel_event.refunded_then_rolled_back",
        expect.objectContaining({
          eventId: EVENT_ID,
          refundedOrderIds: [ORDER_ID],
          stage: "tx",
          errorCode: "HOLD_DATE_MISMATCHES_EVENT",
        }),
      );
      expect(reportError).toHaveBeenCalledWith(refusal, {
        tags: { useCase: "cancelEvent", stage: "refunded_then_rolled_back" },
        extra: { eventId: EVENT_ID, refundedOrderIds: [ORDER_ID], errorCode: "HOLD_DATE_MISMATCHES_EVENT" },
      });
      expect(vi.mocked(txRepos.eventChangeNotices.create)).not.toHaveBeenCalled();
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(1);
    });

    it("the PUBLIC cancelEvent reports the same way when its transaction fails after refunds", async () => {
      const { deps, txRepos, reportError } = harness();
      vi.mocked(txRepos.authz.getOrgMembership).mockResolvedValue({ orgId: ORG_ID, humanId: SENDER_ID, role: "OWNER" } as never);
      const down = new Error("connection reset");
      vi.mocked(txRepos.eventChangeNotices.create).mockRejectedValueOnce(down);

      await expect(
        cancelEvent(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, clientKey: "client-key-1234" }),
      ).rejects.toBe(down);
      expect(reportError).toHaveBeenCalledWith(
        down,
        expect.objectContaining({
          tags: { useCase: "cancelEvent", stage: "refunded_then_rolled_back" },
          extra: expect.objectContaining({ eventId: EVENT_ID, refundedOrderIds: [ORDER_ID] }),
        }),
      );
    });

    it("a THROWING reporter never replaces the cancel's error", async () => {
      const { deps, reportError } = harness();
      reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      const refusal = new Error("booking_not_cancellable");

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw refusal;
          },
        }),
      ).rejects.toBe(refusal);
    });

    it("no refund went out → nothing to report (a refusal before the money is just a refusal)", async () => {
      const { deps, txRepos, reportError } = harness();
      vi.mocked(txRepos.orders.listAll).mockResolvedValue({ items: [], total: 0 } as never);

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx: async () => {
            throw new Error("booking_not_cancellable");
          },
        }),
      ).rejects.toThrow("booking_not_cancellable");
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
    });

    it("a failure AFTER the commit is not a rollback: not reported as one", async () => {
      const { deps, idempotency, reportError } = harness();
      (idempotency as unknown as { __mocks: { commit: ReturnType<typeof vi.fn> } }).__mocks.commit.mockRejectedValueOnce(
        new Error("redis down"),
      );

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} }),
      ).rejects.toThrow("redis down");
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
    });

    it("a commit that throws after the cancellation committed keeps the claim: no release, no `fail`, the retry is refused with no second refund", async () => {
      const { deps, idempotency, refundPaymentIntent } = harness();
      const fp = idempotency as unknown as {
        __mocks: { commit: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };
      };
      fp.__mocks.commit.mockRejectedValueOnce(new Error("redis down"));
      const args = { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} };

      await expect(cancelEventForBooking(deps, args)).rejects.toThrow("redis down");
      expect(onKey(fp.__mocks.release)).toHaveLength(0);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
      const refundsBefore = refundPaymentIntent.mock.calls.length;
      expect(refundsBefore).toBe(1);

      await expect(cancelEventForBooking(deps, args)).rejects.toMatchObject({
        code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
      });
      expect(refundPaymentIntent.mock.calls.length).toBe(refundsBefore);
    });

    it("once that kept claim expires, the retry sees the committed CANCELLED and stops before any refund", async () => {
      const { deps, idempotency, refundPaymentIntent, txRepos } = harness();
      const fp = idempotency as unknown as {
        __mocks: { commit: ReturnType<typeof vi.fn> };
        __locks: Map<string, number>;
      };
      fp.__mocks.commit.mockRejectedValueOnce(new Error("redis down"));
      const args = { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} };

      await expect(cancelEventForBooking(deps, args)).rejects.toThrow("redis down");
      expect(refundPaymentIntent).toHaveBeenCalledTimes(1);

      // The claim's TTL passes; the event row now reads CANCELLED.
      fp.__locks.set(KEY, Date.now() - 1);
      vi.mocked(txRepos.events.getById).mockResolvedValue({
        ...(await txRepos.events.getById(EVENT_ID))!,
        status: "CANCELLED",
      } as EventRecord);

      await expect(cancelEventForBooking(deps, args)).rejects.toMatchObject({
        code: "EVENT_ALREADY_CANCELLED",
      });
      expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
    });
  });

  // ── Review round 2, W1(c): the common refusal happens BEFORE money moves.
  describe("preRefundCheck (round 2 W1c)", () => {
    it("a refusal there stops the cancellation before any refund, any write, any report; the claim is RELEASED", async () => {
      const { deps, refundPaymentIntent, txRepos, idempotency, reportError } = harness();
      const refusal = Object.assign(new Error("event_on_another_night"), { code: "HOLD_DATE_MISMATCHES_EVENT" });
      const withinTx = vi.fn(async () => {});

      await expect(
        cancelEventForBooking(deps, {
          actorHumanId: SENDER_ID,
          eventId: EVENT_ID,
          idempotencyKey: KEY,
          withinTx,
          preRefundCheck: async () => {
            throw refusal;
          },
        }),
      ).rejects.toBe(refusal);

      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(withinTx).not.toHaveBeenCalled();
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    it("it sees the loaded event, runs after the event is loaded and before the refunds, and a passing check changes nothing", async () => {
      const { deps, refundPaymentIntent } = harness();
      const seen: string[] = [];
      const preRefundCheck = vi.fn(async (event: EventRecord) => {
        seen.push(event.id, `refunds:${refundPaymentIntent.mock.calls.length}`);
      });

      const result = await cancelEventForBooking(deps, {
        actorHumanId: SENDER_ID,
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx: async () => {},
        preRefundCheck,
      });

      expect(seen).toEqual([EVENT_ID, "refunds:0"]);
      expect(result).toMatchObject({ status: "CANCELLED", refundedOrderCount: 1 });
    });
  });

  // ── Review round 2, W1(b): a retry's refund params are byte-stable.
  describe("refund params are independent of item order (round 2 W1b)", () => {
    const A = "30000000-0000-4000-8000-0000000000a1";
    const B = "30000000-0000-4000-8000-0000000000b2";

    async function runWith(itemIds: readonly string[]) {
      const h = harness({ itemIds, paidOut: true });
      vi.mocked(reverseTransfersForItems).mockClear();
      await cancelEventForBooking(h.deps, {
        actorHumanId: SENDER_ID,
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx: async () => {},
      });
      const reverse = vi.mocked(reverseTransfersForItems).mock.calls[0]![1];
      return {
        refund: h.refundPaymentIntent.mock.calls[0]![0] as unknown,
        reverseIds: reverse.orderItemIds,
        reverseAmounts: [...reverse.itemAmounts.entries()],
      };
    }

    it("paid-out items listed [A,B] or [B,A] give identical refund params and an identical, sorted reversal request", async () => {
      const forward = await runWith([A, B]);
      const backward = await runWith([B, A]);

      expect(backward.refund).toEqual(forward.refund);
      expect(JSON.stringify(backward.refund)).toBe(JSON.stringify(forward.refund));
      expect(forward.reverseIds).toEqual([A, B]);
      expect(backward.reverseIds).toEqual([A, B]);
      expect(backward.reverseAmounts).toEqual(forward.reverseAmounts);
      expect((forward.refund as { metadata: Record<string, string> }).metadata.orderItemIds).toBe(`${A},${B}`);
    });
  });

  // ── Review round 2, W2: an exit cancels a DRAFT, never a live event.
  describe("the exit's DRAFT pin (round 2 W2)", () => {
    const exit = { auditVia: "booking_exit" as const };

    it("a DRAFT is cancelled as before, audit via booking_exit", async () => {
      const { deps, txRepos, refundPaymentIntent } = harness({ status: "DRAFT" });
      vi.mocked(txRepos.orders.listAll).mockResolvedValue({ items: [], total: 0 } as never);

      await cancelEventForBooking(deps, {
        actorHumanId: SENDER_ID,
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx: async () => {},
        ...exit,
      });

      expect(vi.mocked(txRepos.events.lockRows)).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
      expect(vi.mocked(txRepos.events.cancel)).toHaveBeenCalledTimes(1);
      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.audit.log)).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ via: "booking_exit" }) }),
      );
    });

    it("PUBLISHED at load → EVENT_NOT_CANCELLABLE before anything: no refund, no cancel, no body, claim released", async () => {
      const { deps, txRepos, refundPaymentIntent, idempotency } = harness({ status: "PUBLISHED" });
      const withinTx = vi.fn(async () => {});

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx, ...exit }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_CANCELLABLE" });

      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(withinTx).not.toHaveBeenCalled();
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    it("a publish that commits between the load and the row lock: refused UNDER the lock — never cancelled, never reported as a rollback after refunds", async () => {
      const { deps, txRepos, refundPaymentIntent, reportError, idempotency } = harness({ status: "DRAFT" });
      vi.mocked(txRepos.orders.listAll).mockResolvedValue({ items: [], total: 0 } as never);
      // Load saw DRAFT; by the time the row lock is taken it is PUBLISHED.
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce({ ...makeEvent(), status: "DRAFT" } as EventRecord)
        .mockResolvedValueOnce({ ...makeEvent(), status: "PUBLISHED" } as EventRecord);
      const withinTx = vi.fn(async () => {});

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx, ...exit }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_CANCELLABLE" });

      expect(vi.mocked(txRepos.events.lockRows)).toHaveBeenCalled();
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(withinTx).not.toHaveBeenCalled();
      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
    });

    // Round 3, W2: an exit never moves money. The DRAFT it cancels sold
    // nothing by construction; a row that HAS sales when the exit reads it
    // (published since the exit's first read, with the row lock still ahead)
    // is refused before the first refund — the in-tx pin alone would come
    // after the refunds went out.
    it("a row with SALES under booking_exit → EVENT_NOT_CANCELLABLE BEFORE any refund: no refund, no cancel, no body, no rollback report, claim released", async () => {
      const { deps, txRepos, refundPaymentIntent, reportError, idempotency } = harness({ status: "DRAFT" });
      // `harness` seeds one SUCCEEDED order on the event.
      const withinTx = vi.fn(async () => {});

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx, ...exit }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_CANCELLABLE" });

      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.orders.markRefunded)).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(withinTx).not.toHaveBeenCalled();
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
      const fp = idempotency as unknown as { __mocks: { release: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } };
      expect(onKey(fp.__mocks.release)).toHaveLength(1);
      expect(onKey(fp.__mocks.fail)).toHaveLength(0);
    });

    // ── booking-the-night P2d-2 (carry c) ──
    // The exit's refund list IS the (empty) sales check — never a second
    // read. A sale landing between that check and a re-read must never be
    // refunded by an exit; the publish that made the sale possible is caught
    // by the in-tx DRAFT pin, with nothing refunded.
    it("a sale landing AFTER the exit's sales check is never refunded: the second read never happens, the pin refuses, no money moves", async () => {
      const { deps, txRepos, refundPaymentIntent, reportError } = harness({ status: "DRAFT" });
      // First read (the exit's check): nothing sold. Any later read: a sale.
      vi.mocked(txRepos.orders.listAll)
        .mockResolvedValueOnce({ items: [], total: 0 } as never)
        .mockResolvedValue({ items: [{ id: ORDER_ID, stripePaymentIntentId: `pi_${ORDER_ID}` }], total: 1 } as never);
      // The sale came with a publish: under the row lock the event is live.
      vi.mocked(txRepos.events.getById)
        .mockResolvedValueOnce({ ...makeEvent(), status: "DRAFT" } as EventRecord)
        .mockResolvedValue({ ...makeEvent(), status: "PUBLISHED" } as EventRecord);
      const withinTx = vi.fn(async () => {});

      await expect(
        cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx, ...exit }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_CANCELLABLE" });

      expect(vi.mocked(txRepos.orders.listAll)).toHaveBeenCalledTimes(1);
      expect(refundPaymentIntent).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.orders.markRefunded)).not.toHaveBeenCalled();
      expect(vi.mocked(txRepos.events.cancel)).not.toHaveBeenCalled();
      expect(reportsAt(reportError, "refunded_then_rolled_back")).toHaveLength(0);
    });

    it("an exit that does cancel its DRAFT reads sales exactly once and refunds nothing, whatever a later read would say", async () => {
      const { deps, txRepos, refundPaymentIntent } = harness({ status: "DRAFT" });
      vi.mocked(txRepos.orders.listAll)
        .mockResolvedValueOnce({ items: [], total: 0 } as never)
        .mockResolvedValue({ items: [{ id: ORDER_ID, stripePaymentIntentId: `pi_${ORDER_ID}` }], total: 1 } as never);

      const result = await cancelEventForBooking(deps, {
        actorHumanId: SENDER_ID,
        eventId: EVENT_ID,
        idempotencyKey: KEY,
        withinTx: async () => {},
        ...exit,
      });

      expect(result).toMatchObject({ status: "CANCELLED", refundedOrderCount: 0 });
      // The refund-list read (SUCCEEDED | PART_REFUNDED) happened once: the
      // exit's own sales check. (Post-commit resale settling reads its own.)
      const refundListReads = vi
        .mocked(txRepos.orders.listAll)
        .mock.calls.filter(([arg]) => JSON.stringify((arg as { statuses?: unknown }).statuses) === JSON.stringify(["SUCCEEDED", "PART_REFUNDED"]));
      expect(refundListReads).toHaveLength(1);
      expect(refundPaymentIntent).not.toHaveBeenCalled();
    });

    it("the sales guard is the EXIT's only: Cancel booking refunds a row with sales as before", async () => {
      const { deps, txRepos, refundPaymentIntent } = harness({ status: "PUBLISHED" });
      await cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} });
      expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(txRepos.events.cancel)).toHaveBeenCalledTimes(1);
    });

    it("the DRAFT pin is the EXIT's only: Cancel booking still cancels a PUBLISHED event (under the same row lock every entry takes)", async () => {
      const { deps, txRepos } = harness({ status: "PUBLISHED" });
      await cancelEventForBooking(deps, { actorHumanId: SENDER_ID, eventId: EVENT_ID, idempotencyKey: KEY, withinTx: async () => {} });
      expect(vi.mocked(txRepos.events.cancel)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(txRepos.events.lockRows)).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
    });
  });
});
