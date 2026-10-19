/**
 * claimFreeTickets settles the carried-over cart's PaymentIntent with NO
 * transaction open, then retires the cart inside its transaction through a
 * cancel CAS on the PaymentIntent it observed
 * (docs/decisions/create-checkout-payment-intent-outside-tx.md, "Free claims").
 *
 * The settle is up to two Stripe calls (cancel + retrieve), 240 s worst case,
 * against a 30 s transaction budget and a pool of 10 connections. These cases
 * pin where those calls happen, what the transaction does with the verdict,
 * and the re-settle when the cart gains a different PaymentIntent in between.
 *
 * Same sentinel shape as `claim-free-tickets-seat-release.test.ts`:
 * `orders.createPending` throws, so the claim stops at its first write, after
 * the retirement, the capacity gate and the seat release have all run.
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { claimFreeTickets } from "../claim-free-tickets";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const CART_ID = "77777777-7777-4777-8777-777777777777";
const STRANGER_ID = "88888888-8888-4888-8888-888888888888";
const LISTING_ID = "99999999-9999-4999-8999-999999999999";
const SEAT_ID = "seat-1";
const PI_ID = "pi_carried_over";

const NOW = new Date("2026-07-10T18:00:00.000Z");
const CART_OCCURRED_AT = new Date(NOW.getTime() - 5 * 60_000);
const HOLD_EXPIRES_AT = new Date(NOW.getTime() + 10 * 60_000);

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T22:00:00.000Z"),
    gateType: "NONE",
    currency: "usd",
    ...overrides,
  });
}

function makeHarness(
  opts: {
    /**
     * The PaymentIntent the cart carries on its n-th read (1-based). Reads
     * are counted across the pre-transaction settle and the transaction, so
     * a script can link a new PI "between" them. Default: always `PI_ID`.
     */
    piForRead?: (read: number) => string | null;
    buyerHumanId?: string;
    source?: "PRIMARY" | "RESALE";
    /** What `cancelPaymentIntent` answers. */
    piCanceled?: boolean;
    /** What `retrievePaymentIntent` answers after a no-op cancel. */
    piStatus?: string;
    event?: Partial<EventRecord>;
  } = {},
) {
  /** Every call that matters, in order, tagged with the open tx (0 = none). */
  const log: Array<{ step: string; tx: number }> = [];
  const state = {
    reads: 0,
    currentPi: (opts.piForRead ?? (() => PI_ID))(1) as string | null,
    status: "PENDING" as "PENDING" | "CANCELLED",
    openTx: 0,
    txCount: 0,
    /** Cart status as the claim's first write saw it. */
    statusAtCreatePending: null as string | null,
  };
  const piForRead = opts.piForRead ?? (() => PI_ID);

  const cartItems =
    opts.source === "RESALE"
      ? [
          {
            id: "item-1",
            kind: "ticket",
            resaleListingId: LISTING_ID,
            meta: { holdExpiresAt: HOLD_EXPIRES_AT.toISOString() },
          },
        ]
      : [{ id: "item-1", kind: "ticket", meta: { seatIds: [SEAT_ID] } }];

  const readCart = () => {
    state.reads += 1;
    state.currentPi = piForRead(state.reads);
    return {
      id: CART_ID,
      buyerHumanId: opts.buyerHumanId ?? ACTOR_ID,
      eventId: EVENT_ID,
      status: state.status,
      source: opts.source ?? "PRIMARY",
      stripePaymentIntentId: state.currentPi,
      occurredAt: CART_OCCURRED_AT,
      items: cartItems,
    };
  };

  const createPending = vi.fn(async () => {
    state.statusAtCreatePending = state.status;
    throw Object.assign(new Error("reached create pending"), {
      code: "REACHED_CREATE_PENDING",
    });
  });

  // CAS like the adapter: PENDING, and when given, the PI the caller settled.
  const cancelPendingOrder = vi.fn(
    async (id: string, cas?: { expectedPaymentIntentId: string | null }) => {
      log.push({ step: "cancel_cas", tx: state.openTx });
      if (id !== CART_ID || state.status !== "PENDING") return false;
      if (cas && cas.expectedPaymentIntentId !== state.currentPi) return false;
      state.status = "CANCELLED";
      return true;
    },
  );

  const releaseHold = vi.fn(async () => {
    log.push({ step: "listing_release", tx: state.openTx });
    return { released: true, listingStatus: "ACTIVE" };
  });

  const lockAndCount = vi.fn(
    async (_args: { excludeOrderId?: string | null } = {}) => ({
      issued: 0,
      held: 0,
    }),
  );

  const releaseSeats = vi.fn(async () => {});

  const r = {
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID ? makeEvent(opts.event) : null,
      ),
      listTicketTypes: vi.fn(async () => [
        {
          id: TICKET_TYPE_ID,
          name: "Free RSVP",
          description: null,
          priceCents: 0,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          salesOpenAt: null,
          salesCloseAt: null,
        },
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: TERMS_ID,
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "ABSORB",
          feePolicyId: FEE_POLICY_ID,
          payoutSchedule: "WEEK_OF_EVENT",
          isDefault: false,
          settlementCurrency: "usd",
          version: 1,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          payoutTermsId: TERMS_ID,
          payeeId: "66666666-6666-4666-8666-666666666666",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR" as const,
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async () => ({
        id: FEE_POLICY_ID,
        scopeType: "EVENT",
        scopeId: EVENT_ID,
        status: "ACTIVE",
        version: 1,
        buyerFeePct: 0,
        maxFeeCents: null,
        minFeeCents: 0,
        platformFixedCents: 0,
        feeMode: "ABSORB",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
        payoutPct: 0.9,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
      })),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => true) },
    memberships: {
      listForMember: vi.fn(async () => []),
      listActiveForHuman: vi.fn(async () => []),
      listActiveBenefitsForHuman: vi.fn(async () => []),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => []),
      findByCodeNormalized: vi.fn(async () => null),
      createHolds: vi.fn(async () => []),
      releaseHoldsForOrder: vi.fn(async () => {}),
    },
    feeWaivers: { release: vi.fn(async () => {}) },
    credits: { releaseForOrder: vi.fn(async () => {}) },
    resaleListings: { releaseHold },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats,
      findByIdsForUpdate: vi.fn(async () => []),
    },
    orders: {
      createPending,
      getById: vi.fn(async (id: string) => (id === CART_ID ? readCart() : null)),
      cancelPendingOrder,
    },
    tickets: {
      createMany: vi.fn(),
      lockAndCountCapacityForTicketType: lockAndCount,
    },
  };

  const txRepos = r as unknown as TxRepos;

  // A transaction that rolls back the cart's status on a throw, like Postgres.
  const tx = vi.fn(async <T>(fn: (t: TxRepos) => Promise<T>) => {
    state.txCount += 1;
    state.openTx = state.txCount;
    log.push({ step: "tx_begin", tx: state.openTx });
    const statusBefore = state.status;
    try {
      return await fn(txRepos);
    } catch (err) {
      state.status = statusBefore;
      throw err;
    } finally {
      log.push({ step: "tx_end", tx: state.openTx });
      state.openTx = 0;
    }
  });

  const repos = { ...r, tx } as unknown as Repos;

  const payments = {
    cancelPaymentIntent: vi.fn(async (_: { paymentIntentId: string }) => {
      log.push({ step: "stripe_cancel", tx: state.openTx });
      return { canceled: opts.piCanceled ?? true };
    }),
    retrievePaymentIntent: vi.fn(async () => {
      log.push({ step: "stripe_retrieve", tx: state.openTx });
      return {
        id: state.currentPi,
        status: opts.piStatus ?? "canceled",
        amountReceived: 0,
        currency: "usd",
        metadata: {},
      };
    }),
  };

  return {
    repos,
    tx,
    payments,
    log,
    state,
    createPending,
    cancelPendingOrder,
    releaseHold,
    releaseSeats,
    lockAndCount,
    credits: r.credits,
  };
}

const input = {
  actorHumanId: ACTOR_ID,
  buyerHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: "client-key-12345",
  pendingOrderId: CART_ID,
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  termsAccepted: true,
  refundPolicyAccepted: true,
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  applyPlatformCredit: true,
};

function run(
  h: ReturnType<typeof makeHarness>,
  reportError = vi.fn(),
  clock: { now: () => Date } = { now: () => NOW },
) {
  return claimFreeTickets(
    {
      repos: h.repos,
      clock,
      payments: h.payments as never,
      reportError,
    },
    input,
    [],
    undefined,
  );
}

const SENTINEL = { code: "REACHED_CREATE_PENDING" };

describe("claimFreeTickets — carried-over cart settled outside the transaction", () => {
  it("calls Stripe only while no transaction is open, before the first one begins", async () => {
    // Cancel answers "already terminal", so the settle needs the retrieve
    // too: both calls must happen with no transaction open.
    const h = makeHarness({ piCanceled: false, piStatus: "canceled" });

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    const stripe = h.log.filter((e) => e.step.startsWith("stripe_"));
    expect(stripe).toEqual([
      { step: "stripe_cancel", tx: 0 },
      { step: "stripe_retrieve", tx: 0 },
    ]);
    const firstTx = h.log.findIndex((e) => e.step === "tx_begin");
    const lastStripe = h.log.findLastIndex((e) => e.step.startsWith("stripe_"));
    expect(lastStripe).toBeLessThan(firstTx);
    expect(h.tx).toHaveBeenCalledTimes(1);
  });

  it("retires inside the transaction with a CAS on the PaymentIntent it observed", async () => {
    const h = makeHarness();

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    expect(h.payments.cancelPaymentIntent.mock.calls).toEqual([
      [{ paymentIntentId: PI_ID }],
    ]);
    expect(h.cancelPendingOrder.mock.calls).toEqual([
      [CART_ID, { expectedPaymentIntentId: PI_ID }],
    ]);
    expect(h.log.find((e) => e.step === "cancel_cas")?.tx).toBe(1);
    // The claim's clock reaches the credit release.
    expect(h.credits.releaseForOrder).toHaveBeenCalledWith(CART_ID, {
      now: NOW,
    });
    // Retired, so the cart's unit and seat are this claim's.
    expect(h.state.statusAtCreatePending).toBe("CANCELLED");
    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: CART_ID }),
    );
    expect(h.releaseSeats).toHaveBeenCalledTimes(1);
  });

  it("the in-transaction releases read the clock again instead of reusing the claim's bound now", async () => {
    // The settle before the transaction can take minutes. The credit
    // release's expiry and the resale listing's `expiresAt` outcome are
    // decided at the release, so they get a fresh instant.
    const h = makeHarness({ source: "RESALE" });
    const LATER = new Date(NOW.getTime() + 8 * 60_000);
    const now = vi.fn(() => NOW);
    now.mockReturnValueOnce(NOW).mockReturnValue(LATER);

    await expect(run(h, vi.fn(), { now })).rejects.toMatchObject(SENTINEL);

    expect(h.credits.releaseForOrder).toHaveBeenCalledWith(CART_ID, {
      now: LATER,
    });
    expect(h.releaseHold).toHaveBeenCalledWith(
      LISTING_ID,
      { buyerHumanId: ACTOR_ID, heldUntil: HOLD_EXPIRES_AT },
      { now: LATER },
    );
  });

  it("a rollback after the retire leaves the cart PENDING with its PI already cancelled", async () => {
    // The new rollback state: the cancel CAS rolls back with the claim, the
    // Stripe cancel does not. A cancelled PI cannot charge; the next attempt
    // re-settles it through retrieve → canceled.
    const h = makeHarness();

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    expect(h.state.statusAtCreatePending).toBe("CANCELLED");
    expect(h.state.status).toBe("PENDING");
    expect(h.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("re-settles and retries when the cart gains a different PaymentIntent between settle and transaction", async () => {
    // Read 1 (settle): no PI, nothing to cancel. Then the other tab links
    // pi_new. Read 2 (tx): pi_new, so the CAS on "no PI" loses and read 3
    // confirms the change: roll back. Read 4 (settle #2) cancels pi_new;
    // read 5 (tx #2) still pi_new, so the CAS wins.
    const h = makeHarness({
      piForRead: (read) => (read === 1 ? null : "pi_new"),
    });

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    expect(h.tx).toHaveBeenCalledTimes(2);
    expect(h.payments.cancelPaymentIntent.mock.calls).toEqual([
      [{ paymentIntentId: "pi_new" }],
    ]);
    // The re-settle ran between the two transactions, with none open.
    expect(h.log.filter((e) => e.step !== "cancel_cas")).toEqual([
      { step: "tx_begin", tx: 1 },
      { step: "tx_end", tx: 1 },
      { step: "stripe_cancel", tx: 0 },
      { step: "tx_begin", tx: 2 },
      { step: "tx_end", tx: 2 },
    ]);
    expect(h.cancelPendingOrder.mock.calls).toEqual([
      [CART_ID, { expectedPaymentIntentId: null }],
      [CART_ID, { expectedPaymentIntentId: "pi_new" }],
    ]);
    // The first attempt stopped at the retire: no capacity read, no order.
    expect(h.lockAndCount).toHaveBeenCalledTimes(1);
    expect(h.createPending).toHaveBeenCalledTimes(1);
    expect(h.state.statusAtCreatePending).toBe("CANCELLED");
  });

  it("on the last attempt, a cart that changed again is left live and reported", async () => {
    // pi_a settled, pi_b linked → retry; pi_b settled, pi_c linked → the
    // final attempt does not throw: it leaves the cart live and reports.
    const h = makeHarness({
      piForRead: (read) => (read <= 1 ? "pi_a" : read <= 4 ? "pi_b" : "pi_c"),
    });
    const reportError = vi.fn();

    await expect(run(h, reportError)).rejects.toMatchObject(SENTINEL);

    expect(h.tx).toHaveBeenCalledTimes(2);
    expect(h.payments.cancelPaymentIntent.mock.calls).toEqual([
      [{ paymentIntentId: "pi_a" }],
      [{ paymentIntentId: "pi_b" }],
    ]);
    expect(h.state.statusAtCreatePending).toBe("PENDING");
    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: null }),
    );
    expect(h.releaseSeats).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "carried_over_cart_changed_after_final_settle",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ caller: "claimFreeTickets" }),
        extra: expect.objectContaining({
          orderId: CART_ID,
          observedPaymentIntentId: "pi_b",
          currentPaymentIntentId: "pi_c",
        }),
      }),
    );
  });

  it("a settle refusal leaves the cart PENDING with its reservation, and the claim proceeds", async () => {
    // The buyer paid the old cart (PI succeeded): it is not ours to retire.
    const h = makeHarness({ piCanceled: false, piStatus: "succeeded" });
    const reportError = vi.fn();

    await expect(run(h, reportError)).rejects.toMatchObject(SENTINEL);

    expect(h.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.state.statusAtCreatePending).toBe("PENDING");
    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: null }),
    );
    expect(h.releaseSeats).not.toHaveBeenCalled();
    expect(h.tx).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "carried_over_cart_pi_terminal_not_canceled:succeeded",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ caller: "claimFreeTickets" }),
      }),
    );
  });

  it("never touches a stranger's cart named as pendingOrderId", async () => {
    const h = makeHarness({ buyerHumanId: STRANGER_ID });

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.payments.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: null }),
    );
  });

  it("refuses an RSVP event before settling, so the other tab's PI is not cancelled", async () => {
    const h = makeHarness({ event: { attendanceMode: "RSVP" } });

    await expect(run(h)).rejects.toMatchObject({ code: "EVENT_NOT_TICKETED" });

    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.tx).not.toHaveBeenCalled();
  });

  it("releases a resale cart's listing hold in the same transaction as the cancel CAS", async () => {
    const h = makeHarness({ source: "RESALE" });

    await expect(run(h)).rejects.toMatchObject(SENTINEL);

    const cas = h.log.find((e) => e.step === "cancel_cas");
    const release = h.log.find((e) => e.step === "listing_release");
    expect(cas?.tx).toBe(1);
    expect(release?.tx).toBe(1);
    expect(h.log.indexOf(release!)).toBeGreaterThan(h.log.indexOf(cas!));
    expect(h.releaseHold).toHaveBeenCalledWith(
      LISTING_ID,
      { buyerHumanId: ACTOR_ID, heldUntil: HOLD_EXPIRES_AT },
      { now: NOW },
    );
  });
});
