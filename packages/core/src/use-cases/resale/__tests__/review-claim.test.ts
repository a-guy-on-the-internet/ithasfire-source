import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ClaimRecord } from "@th/types/repos/claims";
import type { OrderRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { reviewClaim, type ReviewClaimDeps } from "../review-claim";
import { CLAIM_DESK_ROLES } from "../claim-desk-staff";

// ── Constants ──────────────────────────────────────────────────────────────

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "oooooooo-oooo-4ooo-8ooo-oooooooooooo";
const CLAIMANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESPONDENT_ID = "ssssssss-ssss-4sss-8sss-ssssssssssss";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ORIGINAL_ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TICKET_ID = "tttttttt-tttt-4ttt-8ttt-tttttttttttt";
const RESALE_ITEM_ID = "item-uuid";
const SELLER_PAYEE_ID = "payee-seller";
const SELLER_TRANSFER_ID = "tr_seller_1";
const PAYMENT_INTENT_ID = "pi_test_abc123";
const NOW = new Date("2026-03-10T12:00:00Z");
const APPROVAL_KEY = `claim:review:${CLAIM_ID}:approved:full_refund`;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: CLAIM_ID,
    orderId: ORDER_ID,
    orderItemId: RESALE_ITEM_ID,
    eventId: EVENT_ID,
    claimantId: CLAIMANT_ID,
    respondentId: RESPONDENT_ID,
    kind: "ticket_invalid",
    status: "open",
    evidence: {},
    deadline: new Date("2026-03-15T12:00:00Z"),
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    resolution: null,
    sellerEvidence: null,
    sellerRespondedAt: null,
    createdAt: new Date("2026-03-09T12:00:00Z"),
    updatedAt: new Date("2026-03-09T12:00:00Z"),
    ...overrides,
  };
}

/**
 * Production shape of a RESALE order (finalize-resale-purchase): the gross is
 * the ask, `feesPlatformCents` is 0, the buyer's fees ride the item's
 * `buyerTotalCents`, and tax is order-level on top. The buyer paid
 * 10_250 + 700 = 10_950.
 */
function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: CLAIMANT_ID,
    amountGrossCents: 9_500,
    feesPlatformCents: 0,
    currency: "usd",
    status: "SUCCEEDED",
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    occurredAt: new Date("2026-03-08T12:00:00Z"),
    source: "RESALE",
    feePolicySnapshot: {},
    parentOrderId: ORIGINAL_ORDER_ID,
    paidOutAt: null,
    taxAmountCents: 700,
    items: [
      {
        id: RESALE_ITEM_ID,
        orderId: ORDER_ID,
        kind: "ticket",
        status: "active",
        ticketTypeId: "tt-1",
        resaleListingId: LISTING_ID,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        amountCents: 9_500,
        meta: {
          buyerTotalCents: 10_250,
          resaleOriginalOrderId: ORIGINAL_ORDER_ID,
          resaleOriginalOrderItemId: ORIGINAL_ITEM_ID,
        },
      },
    ],
    ...overrides,
  } as OrderRecord;
}

type FakeTicket = {
  id: string;
  ownerHumanId: string;
  orderId: string | null;
  orderItemId: string | null;
  code: string;
  status: string;
};

function makeTicket(overrides: Partial<FakeTicket> = {}): FakeTicket {
  // The resale buyer (claimant) holds the seller's ticket, re-pointed at the
  // resale order item at purchase time.
  return {
    id: TICKET_ID,
    ownerHumanId: CLAIMANT_ID,
    orderId: ORDER_ID,
    orderItemId: RESALE_ITEM_ID,
    code: "CODE-CLAIMANT",
    status: "VALID",
    ...overrides,
  };
}

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    ticketId: TICKET_ID,
    sellerHumanId: RESPONDENT_ID,
    status: "SOLD",
    buyerOrderId: ORDER_ID,
    expiresAt: null,
    saleCutoffAt: null,
    ...overrides,
  };
}

function makeDeps(opts?: {
  claim?: ClaimRecord | null;
  order?: OrderRecord | null;
  /** `null` = no ticket row for the resale item (unwind pre-flight refuses). */
  ticket?: FakeTicket | null;
  listing?: ReturnType<typeof makeListing>;
  /**
   * Ledger-era payout covering the resale item. When set, the seller was
   * already paid out via this transfer and the approval must reverse it
   * BEFORE refunding the buyer.
   */
  payoutItem?: {
    payoutItemId: string;
    stripeTransferId: string;
    payeeId: string;
    plannedOrderItemIds: string[];
    amountCents: number;
    netAmountCents: number;
  };
  /** Stripe-side transfer capacity for `payoutItem.stripeTransferId`. */
  transferCapacityCents?: number;
  /**
   * Claim-desk staff probe answer. Defaults to STAFF so the money-path pins
   * below stay focused on the refund mechanics; the authz test flips it.
   */
  staff?: boolean;
}): {
  deps: ReviewClaimDeps;
  mocks: {
    hasStaffRole: Mock<any[], any>;
    getById: Mock<any[], any>;
    updateStatus: Mock<any[], any>;
    auditLog: Mock<any[], any>;
    payeeLedger: ReturnType<typeof createFakePayeeLedgerRepo>;
    markRefunded: Mock<any[], any>;
    getOrderById: Mock<any[], any>;
    refundPaymentIntent: Mock<any[], any>;
    reverseTransfer: Mock<any[], any>;
    idempotency: ReturnType<typeof createFakeIdempotencyPort>;
    tx: Mock<any[], any>;
    txRepos: Record<string, any>;
    tickets: Record<string, Mock<any[], any>>;
    resaleListings: Record<string, Mock<any[], any>>;
    orderItems: Record<string, Mock<any[], any>>;
    /** Ordered log of every external/DB side effect, for BEFORE/AFTER pins. */
    calls: string[];
    /** Live ticket state (mutated by the tickets fakes). */
    ticketState: () => FakeTicket | null;
  };
} {
  let claim = opts?.claim !== undefined ? opts.claim : makeClaim();
  let order = opts?.order !== undefined ? opts.order : makeOrder();
  let ticket: FakeTicket | null =
    opts?.ticket !== undefined ? opts.ticket : makeTicket();
  const listing = opts?.listing ?? makeListing();
  const calls: string[] = [];

  const getById = vi.fn(async () => claim);
  // Mirrors the adapter's conditional write: nothing is written (null) when
  // the row's status is no longer `fromStatus`.
  const updateStatus = vi.fn(async (_id: string, input: any) => {
    if (!claim || claim.status !== input.fromStatus) return null;
    const { fromStatus: _from, ...data } = input;
    claim = { ...claim, ...data, id: claim.id };
    return claim;
  });
  const auditLog = vi.fn(async () => {});
  // In-memory payee ledger (real key-replay semantics) — the approval path
  // writes REFUND_DEBITs where it used to cancel settlements.
  const payeeLedger = createFakePayeeLedgerRepo();
  const markRefunded = vi.fn(async () => {
    calls.push("orders.markRefunded");
    order = order ? ({ ...order, status: "REFUNDED" } as OrderRecord) : null;
  });
  // The seller's original order is its own row, and a PRIMARY one: the
  // unwind reads its `source` to decide whether the restored item's listing
  // pointer may be written (never on a RESALE item).
  const getOrderById = vi.fn(async (id?: string) =>
    id === ORIGINAL_ORDER_ID
      ? ({ id: ORIGINAL_ORDER_ID, source: "PRIMARY", items: [] } as never)
      : order,
  );
  const refundPaymentIntent = vi.fn(async () => {
    calls.push("refundPaymentIntent");
    return {
      refundId: "re_test_123",
      status: "succeeded",
    };
  });
  const idempotency = createFakeIdempotencyPort();

  // Approval takes the claim lock before its holder check (owner ruling
  // 2026-10-05); logged so tests can pin it ahead of every write.
  const lockOrderItem = vi.fn(async () => {
    calls.push("claims.lockOrderItem");
  });
  const claimsRepo = { getById, updateStatus, lockOrderItem } as any;
  const ordersRepo = { getById: getOrderById, markRefunded } as any;
  const auditRepo = { log: auditLog } as any;

  // ── Tickets / listings / items: what the resale unwind touches ─────────
  const tickets = {
    getByOrderItemId: vi.fn(async (orderItemId: string) =>
      ticket && ticket.orderItemId === orderItemId ? { ...ticket } : null,
    ),
    getById: vi.fn(async (id: string) =>
      ticket && ticket.id === id ? { ...ticket } : null,
    ),
    // The row lock the unwind takes before deciding.
    getByIdForUpdate: vi.fn(async (id: string) =>
      ticket && ticket.id === id ? { ...ticket } : null,
    ),
    // Mirrors the adapter's compare-and-swap: the owner predicate is part of
    // the WHERE, so a ticket that already moved on yields a 0-row update and
    // `false` — it does NOT throw (money audit 2026-09-08 #19). The replay
    // path reads that `false`, not an error message.
    transfer: vi.fn(
      async (input: {
        ticketId: string;
        fromHumanId: string;
        toHumanId: string;
        expectedStatus?: string;
      }) => {
        calls.push("tickets.transfer");
        if (!ticket || ticket.ownerHumanId !== input.fromHumanId) {
          return false;
        }
        if (input.expectedStatus && ticket.status !== input.expectedStatus) {
          return false;
        }
        ticket = { ...ticket, ownerHumanId: input.toHumanId };
        return true;
      },
    ),
    restoreAfterResale: vi.fn(
      async (input: {
        ticketId: string;
        restoredOrderId: string | null;
        restoredOrderItemId: string | null;
        newCode: string;
      }) => {
        calls.push("tickets.restoreAfterResale");
        if (!ticket) return;
        ticket = {
          ...ticket,
          orderId: input.restoredOrderId,
          orderItemId: input.restoredOrderItemId,
          code: input.newCode,
          status: "VALID",
        };
      },
    ),
    setStatus: vi.fn(async (_id: string, status: string) => {
      calls.push(`tickets.setStatus:${status}`);
      if (ticket) ticket = { ...ticket, status };
    }),
    listByOrderId: vi.fn(async () => (ticket ? [{ ...ticket }] : [])),
  };
  const resaleListings = {
    getById: vi.fn(async (id: string) => {
      calls.push("resaleListings.getById");
      return id === LISTING_ID ? { ...listing } : null;
    }),
    // No live listing of the refunded buyer's own.
    getByTicketId: vi.fn(async () => null),
    unwindSale: vi.fn(async () => {
      calls.push("resaleListings.unwindSale");
    }),
  };
  const orderItems = {
    // Ledger-era reversal amounts resolve item → order → credit attribution.
    getById: vi.fn(
      async (id: string) => order?.items.find((i) => i.id === id) ?? null,
    ),
    updateStatus: vi.fn(async (id: string, status: string) => {
      calls.push(`orderItems.updateStatus:${id}:${status}`);
    }),
    setResaleListingId: vi.fn(async () => {}),
  };

  // ONE tx-repo object, spread into the root repos below: a fake missing
  // from EITHER surface throws, instead of `{ tx } as Repos` hiding dead
  // post-commit reads behind an `undefined` property.
  // NO `settlements` mutation surface anywhere: cancelForOrder is DELETED — a
  // resurrected settlement mutation should crash, not pass a spy.
  const txRepos = {
    claims: claimsRepo,
    payeeLedger: payeeLedger.repo,
    orders: ordersRepo,
    audit: auditRepo,
    tickets,
    resaleListings,
    orderItems,
    // The refund-debit writer's partial-miss detector reads splits; empty =
    // nothing to compare = detection stays silent.
    splits: { getForOrder: vi.fn(async () => []) },
  };

  const tx = vi.fn(async (fn: any) => fn(txRepos));

  const repos = {
    ...txRepos,
    // Transfer resolution for paid-out items (reverseTransfersForItems):
    // ledger era first, then the frozen pre-cutover junction (empty here).
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () =>
        opts?.payoutItem ? [opts.payoutItem] : [],
      ),
    },
    orderItemSettlementLines: {
      listByOrderItemIds: vi.fn(async () => []),
    },
    settlementLines: { getByIds: vi.fn(async () => []) },
    settlements: { getByIds: vi.fn(async () => []) },
    tx,
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  // ── Stripe-mirroring transfer fake ─────────────────────────────────────
  // Same-key replay returns the prior reversal (no new state); a request
  // beyond the registered capacity rejects like live Stripe.
  const reversalsByKey = new Map<string, { reversalId: string }>();
  const reversalRecords: Array<{
    reversalId: string;
    amountCents: number;
    metadata: Record<string, string>;
  }> = [];
  let reversedCents = 0;
  let reversalSeq = 0;
  const reverseTransfer = vi.fn(
    async (input: {
      transferId: string;
      amountCents?: number;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }) => {
      calls.push("reverseTransfer");
      if (input.idempotencyKey) {
        const prior = reversalsByKey.get(input.idempotencyKey);
        if (prior) return prior;
      }
      const capacity = opts?.transferCapacityCents;
      const requested = input.amountCents ?? 0;
      if (capacity !== undefined && reversedCents + requested > capacity) {
        throw new Error(
          `stripe_transfer_reversal_exceeds_amount:${input.transferId}`,
        );
      }
      reversedCents += requested;
      const created = { reversalId: `trr_test_${++reversalSeq}` };
      reversalRecords.push({
        reversalId: created.reversalId,
        amountCents: requested,
        metadata: input.metadata ?? {},
      });
      if (input.idempotencyKey) reversalsByKey.set(input.idempotencyKey, created);
      return created;
    },
  );

  const payments: PaymentProcessorPort = {
    refundPaymentIntent,
    reverseTransfer,
    getTransfer: vi.fn(async () => ({
      amountCents: opts?.transferCapacityCents ?? Number.MAX_SAFE_INTEGER,
      amountReversedCents: reversedCents,
    })),
    listTransferReversals: vi.fn(async () => reversalRecords),
  } as unknown as PaymentProcessorPort;

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  const hasStaffRole = vi.fn(async () => ({ allowed: opts?.staff ?? true }));
  const authz = { hasStaffRole } as unknown as Pick<AuthZPort, "hasStaffRole">;

  return {
    deps: { repos, authz, idempotency, clock, payments, logger },
    mocks: {
      hasStaffRole,
      getById,
      updateStatus,
      auditLog,
      payeeLedger,
      markRefunded,
      getOrderById,
      refundPaymentIntent,
      reverseTransfer,
      idempotency,
      tx,
      txRepos,
      tickets,
      resaleListings,
      orderItems,
      calls,
      ticketState: () => ticket,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("reviewClaim", () => {
  // ── Transition: open → under_review ──────────────────────────────────

  it("transitions open → under_review", async () => {
    const { deps, mocks } = makeDeps({ claim: makeClaim({ status: "open" }) });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "under_review",
    });

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.status).toBe("under_review");
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({
        status: "under_review",
      }),
    );
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
  });

  // ── Transition: under_review → approved (full refund) ────────────────

  it("approves claim, debits the seller AND the organiser side, and issues refund", async () => {
    // Production shape (finalize → resolveResaleSellerSplit →
    // createCreditsFromOrder; proven in
    // orders/__tests__/finalize-resale-seller-credit.test.ts): a RESALE order
    // has feesPlatformCents 0, and its ask is credited as the seller's
    // snapshot share PLUS the organiser-side markup split over the RESALE
    // lines. Bought at 7000, listed at 9500, seller keeps 20% of the 2500
    // markup → seller 7000 + 500 = 7500, organiser 2000. Σ = 9500 = the ask.
    const ORG_PAYEE_ID = "payee-org";
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ amountGrossCents: 9_500, feesPlatformCents: 0 }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: SELLER_PAYEE_ID,
      amountCents: 7_500,
      items: { [RESALE_ITEM_ID]: 7_500 },
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: ORG_PAYEE_ID,
      amountCents: 2_000,
      items: { [RESALE_ITEM_ID]: 2_000 },
    });
    // The split rows finalize wrote — the debit writer's missing-credit
    // detector compares against these.
    mocks.txRepos.splits.getForOrder.mockResolvedValue([
      { id: "s1", orderId: ORDER_ID, orderSplitId: "s1", payeeId: SELLER_PAYEE_ID, amountCents: 7_500 },
      { id: "s2", orderId: ORDER_ID, orderSplitId: "s2", payeeId: ORG_PAYEE_ID, amountCents: 2_000 },
    ]);

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
      resolutionNote: "Verified ticket was invalid",
    });

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.status).toBe("approved");
    expect(result.resolution).toBe("full_refund");

    // Every credited payee gets a full-credit REFUND_DEBIT, keyed on the
    // (stable) claim id — the ledger replacement for settlement cancellation.
    // The seller's proceeds come back from the seller, not the organiser.
    const debits = mocks.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(2);
    expect(debits.find((d) => d.payeeId === SELLER_PAYEE_ID)).toMatchObject({
      amountCents: 7_500,
      orderId: ORDER_ID,
      idempotencyKey: `refund-debit:${ORDER_ID}:${SELLER_PAYEE_ID}:${CLAIM_ID}`,
    });
    expect(debits.find((d) => d.payeeId === ORG_PAYEE_ID)).toMatchObject({
      amountCents: 2_000,
      orderId: ORDER_ID,
      idempotencyKey: `refund-debit:${ORDER_ID}:${ORG_PAYEE_ID}:${CLAIM_ID}`,
    });
    expect(debits.reduce((sum, d) => sum + d.amountCents, 0)).toBe(9_500);
    // No ledger drift reported (no missing credit, no clamp).
    expect(deps.logger?.error).not.toHaveBeenCalled();

    // Should mark order as refunded
    expect(mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);

    // Should issue Stripe refund
    expect(mocks.getOrderById).toHaveBeenCalledWith(ORDER_ID);
    expect(mocks.refundPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: PAYMENT_INTENT_ID,
      // Stripe rejects any reason outside its own three ("other" failed
      // every claim refund in Stripe test mode).
      reason: "requested_by_customer",
      idempotencyKey: `claim:review:${CLAIM_ID}:approved:full_refund:refund-payment-intent`,
      // Money audit 2026-09-08 #10: the refund names its items so the
      // charge.refunded reconciler can flip them if the local tx dies.
      metadata: {
        useCase: "reviewClaim",
        orderId: ORDER_ID,
        orderItemIds: RESALE_ITEM_ID,
        orderItemCount: "1",
      },
    });
    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledWith(
      `claim:review:${CLAIM_ID}:approved:full_refund`,
      expect.objectContaining({
        response: expect.objectContaining({
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        }),
      }),
    );

    // Audit log should be written
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "claim",
        entityId: CLAIM_ID,
        action: "reviewed_approved",
      }),
    );
  });

  it("resumes an approved-claim refund after a crash before local refund confirmation commits", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    const providerRefundRequestsSent: string[] = [];
    const refundResponses = new Map<
      string,
      { refundId: string; status: "succeeded" }
    >();

    mocks.refundPaymentIntent.mockImplementation(
      async (input: { idempotencyKey?: string }) => {
        if (!input.idempotencyKey) {
          throw new Error("missing_refund_idempotency_key");
        }

        const cached = refundResponses.get(input.idempotencyKey);
        if (cached) {
          return cached;
        }

        providerRefundRequestsSent.push(input.idempotencyKey);
        const created = {
          refundId: "re_retry_123",
          status: "succeeded" as const,
        };
        refundResponses.set(input.idempotencyKey, created);
        return created;
      },
    );

    mocks.tx.mockImplementation(async (fn: any) => {
      if (mocks.tx.mock.calls.length === 2) {
        throw new Error("crash_after_stripe_before_local_commit");
      }

      return fn(mocks.txRepos);
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "crash_after_stripe_before_local_commit",
        ),
      }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });

    expect(result.status).toBe("approved");
    expect(providerRefundRequestsSent).toEqual([
      `claim:review:${CLAIM_ID}:approved:full_refund:refund-payment-intent`,
    ]);
    expect(mocks.updateStatus).toHaveBeenCalledTimes(1);
    // The retry recomputes the SAME claim-keyed debit and the ledger's key
    // replay dedupes it: exactly one debit, ever.
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(mocks.markRefunded).toHaveBeenCalledTimes(1);
  });

  it("resumes with ZERO Stripe calls when the first attempt's success tx committed but its client saw an error", async () => {
    // The connection drops after COMMIT: the order is REFUNDED, yet the
    // catch released the claim. Re-sending `:refund-payment-intent` with the
    // now-empty refundable set would change its metadata under the same key
    // (Stripe: idempotency_error) and strand the retry.
    //
    // Listing and ticket start in the post-unwind shape: the harness's
    // `unwindSale` does not mutate its listing, so this is how the retry's
    // pre-flight sees what a committed unwind leaves behind.
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      listing: makeListing({ status: "CANCELLED", buyerOrderId: null }),
      ticket: makeTicket({
        ownerHumanId: RESPONDENT_ID,
        orderId: ORIGINAL_ORDER_ID,
        orderItemId: ORIGINAL_ITEM_ID,
        code: "CODE-RESTORED",
      }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    mocks.tx.mockImplementation(async (fn: any) => {
      const out = await fn(mocks.txRepos);
      if (mocks.tx.mock.calls.length === 2) {
        throw new Error("connection_dropped_after_commit");
      }
      return out;
    });
    // Attempt 1 is a fresh approval: its holder check runs before the unwind,
    // when the buyer still held the ticket on the resale item. The fixture
    // above is the post-unwind shape the RETRY reads, so only this first read
    // sees the pre-unwind ticket.
    mocks.tickets.getByOrderItemId.mockImplementationOnce(async () =>
      makeTicket(),
    );
    const input = {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved" as const,
      resolution: "full_refund" as const,
    };

    await expect(reviewClaim(deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.markRefunded).toHaveBeenCalledTimes(1);

    const reportError = vi.fn();
    const result = await reviewClaim({ ...deps, reportError }, input);

    expect(result.status).toBe("approved");
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.reverseTransfer).not.toHaveBeenCalled();
    expect(mocks.markRefunded).toHaveBeenCalledTimes(1);
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledTimes(1);
    // Told apart from "refunded by another path" by the claim-keyed debit
    // the first attempt's committed tx wrote.
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_confirmed_on_resume",
        data: expect.objectContaining({
          refundedBy: "claim_tx",
          reversalCreditUnverified: false,
        }),
      }),
    );
    // Nothing was paid out, so there is no reversal credit to miss.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a commit that throws after the approval refund committed keeps the claim: the retry is refused, no second Stripe refund", async () => {
    // Outside the abandon path (lib/idempotency-claim.ts): releasing here
    // would let the retry redo committed work.
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    mocks.idempotency.__mocks.commit.mockRejectedValueOnce(
      new Error("idempotency_store_down"),
    );
    const input = {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved" as const,
      resolution: "full_refund" as const,
    };

    await expect(reviewClaim(deps, input)).rejects.toThrow(
      "idempotency_store_down",
    );
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.markRefunded).toHaveBeenCalledTimes(1);
    const approvalKey = `claim:review:${CLAIM_ID}:approved:full_refund`;
    expect(
      mocks.idempotency.__mocks.release.mock.calls.filter(
        ([k]) => k === approvalKey,
      ),
    ).toHaveLength(0);
    expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();

    await expect(reviewClaim(deps, input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
  });

  // ── Transition: under_review → denied ────────────────────────────────

  it("denies claim without refunding or debiting the ledger", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "denied",
      resolutionNote: "No evidence of invalid ticket",
    });

    expect(result.status).toBe("denied");
    expect(result.resolution).toBe("denied");
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
    expect(mocks.markRefunded).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
  });

  // ── Edge: already resolved ───────────────────────────────────────────

  it("throws if claim is already approved", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "approved" }),
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "denied",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
  });

  it("throws if claim is already denied", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "denied" }),
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_RESOLVED" }),
    );
  });

  // ── Concurrent transitions: lock first, decide on the re-read ─────────
  // Since Q8 every transition can start from `open`. Each takes the order
  // item's claim lock before any write and re-reads the claim under it; the
  // write is conditional on the status it decided on.

  function decidedWhileWaitingForLock(
    mocks: ReturnType<typeof makeDeps>["mocks"],
    before: ClaimRecord,
    after: ClaimRecord,
  ) {
    let locked = false;
    mocks.txRepos.claims.lockOrderItem.mockImplementation(async () => {
      mocks.calls.push("claims.lockOrderItem");
      locked = true;
    });
    mocks.getById.mockImplementation(async () => (locked ? after : before));
  }

  for (const status of ["under_review", "approved", "denied"] as const) {
    it(`takes the claim lock before the ${status} write`, async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "open" }),
      });

      await reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status,
      });

      const lock = mocks.txRepos.claims.lockOrderItem;
      expect(lock).toHaveBeenCalledWith(RESALE_ITEM_ID);
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateStatus.mock.invocationCallOrder[0]!,
      );
      expect(mocks.updateStatus).toHaveBeenCalledWith(
        CLAIM_ID,
        expect.objectContaining({ fromStatus: "open", status }),
      );
    });
  }

  it("start review racing an approval: the re-read sees approved, nothing is written", async () => {
    const { deps, mocks } = makeDeps();
    decidedWhileWaitingForLock(
      mocks,
      makeClaim({ status: "open" }),
      makeClaim({ status: "approved", resolution: "full_refund" }),
    );

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "under_review",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_RESOLVED" });
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("approve racing a denial: the re-read sees denied, no refund and no write", async () => {
    const { deps, mocks } = makeDeps();
    decidedWhileWaitingForLock(
      mocks,
      makeClaim({ status: "open" }),
      makeClaim({ status: "denied", resolution: "denied" }),
    );

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_RESOLVED" });
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.markRefunded).not.toHaveBeenCalled();
    expect(mocks.reverseTransfer).not.toHaveBeenCalled();
    // A refusal is not an attempt: the approval key is released, not failed.
    expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  for (const status of ["under_review", "approved", "denied"] as const) {
    it(`a conditional ${status} write that matches 0 rows is refused: no audit, no refund`, async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "open" }),
      });
      mocks.updateStatus.mockResolvedValueOnce(null);

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status,
        }),
      ).rejects.toMatchObject({ code: "CLAIM_ALREADY_RESOLVED" });
      expect(mocks.updateStatus).toHaveBeenCalledTimes(1);
      expect(mocks.auditLog).not.toHaveBeenCalled();
      expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.markRefunded).not.toHaveBeenCalled();
    });
  }

  // ── Legacy partial_refund rows (approved before Q5) ───────────────────

  it("resumes a legacy approved partial_refund claim as a full refund under its ORIGINAL key", async () => {
    // The old code keyed approval on the requested resolution and always
    // refunded the whole PI. A row it approved as partial_refund whose
    // refund never landed must resume under `...:approved:partial_refund`.
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "approved", resolution: "partial_refund" }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(result).toEqual({
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "partial_refund",
    });
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: PAYMENT_INTENT_ID,
        idempotencyKey: `claim:review:${CLAIM_ID}:approved:partial_refund:refund-payment-intent`,
      }),
    );
    expect(mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledWith(
      `claim:review:${CLAIM_ID}:approved:partial_refund`,
      expect.anything(),
    );
  });

  it("a new approval never uses the legacy key", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });

    await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledWith(
      `claim:review:${CLAIM_ID}:approved:full_refund`,
      expect.anything(),
    );
  });

  // ── Transition: open → approved / denied (no wait for the seller) ────
  // Owner ruling Q8 (2026-10-06): staff decide at any time.

  it("approves directly from open: full refund under the same idempotency keys", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "open" }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(result).toEqual({
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({
        status: "approved",
        resolution: "full_refund",
        resolvedById: ACTOR_ID,
      }),
    );
    expect(mocks.txRepos.claims.lockOrderItem).toHaveBeenCalledWith(
      RESALE_ITEM_ID,
    );
    expect(mocks.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: PAYMENT_INTENT_ID,
        idempotencyKey: `claim:review:${CLAIM_ID}:approved:full_refund:refund-payment-intent`,
      }),
    );
    expect(mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledWith(
      `claim:review:${CLAIM_ID}:approved:full_refund`,
      expect.anything(),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "claim",
        action: "reviewed_approved",
        data: expect.objectContaining({
          previousStatus: "open",
          newStatus: "approved",
        }),
      }),
    );
  });

  it("denies directly from open without refunding", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "open" }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "denied",
    });

    expect(result.status).toBe("denied");
    expect(result.resolution).toBe("denied");
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({
        status: "denied",
        resolution: "denied",
        resolvedById: ACTOR_ID,
      }),
    );
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.markRefunded).not.toHaveBeenCalled();
  });

  // ── Edge: invalid transition / input ─────────────────────────────────

  it("sanitizes the resolution note both parties (and emails) see", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });

    await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "denied",
      resolutionNote: "  <b>Ticket</b> scanned\u202E fine\n\n\n\nat 20:14  ",
    });

    expect(mocks.updateStatus).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({
        resolutionNote: "Ticket scanned fine\n\nat 20:14",
      }),
    );
  });

  it("rejects a resolution note over 2000 characters", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "denied",
        resolutionNote: "x".repeat(2001),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    expect(mocks.updateStatus).not.toHaveBeenCalled();
  });

  it("throws if moving to under_review from anything but open", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "under_review",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    expect(mocks.updateStatus).not.toHaveBeenCalled();
  });

  // Owner ruling Q5 (2026-10-06): no partial refunds. The status decides the
  // resolution; `resolution` only accepts "full_refund" for compatibility.
  for (const resolution of ["partial_refund", "denied"]) {
    it(`rejects resolution "${resolution}" before any read or Stripe call`, async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
      });

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
      expect(mocks.updateStatus).not.toHaveBeenCalled();
      expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
    });
  }

  // ── Edge: not found ──────────────────────────────────────────────────

  it("throws if claim not found", async () => {
    const { deps } = makeDeps({ claim: null });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "under_review",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "CLAIM_NOT_FOUND" }));
  });

  // ── Edge: refund failure is non-fatal ────────────────────────────────

  it("throws dependency_failed/refund_failed when the Stripe refund call errors", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    // Seeded so the zero-debit assertion below is non-vacuous — THIS is the
    // original BLOCKING scenario: refund fails, seller must NOT be docked.
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { "item-uuid": 5_000 },
    });
    const stripeErr = new Error("Stripe error");
    mocks.refundPaymentIntent.mockRejectedValueOnce(stripeErr);

    // Surfacing the failure (instead of swallowing) lets the admin retry
    // — `allowApprovedResume: true` makes a subsequent call re-attempt
    // the refund against the same Stripe idempotency key.
    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({ code: "REFUND_FAILED" });

    expect(mocks.markRefunded).not.toHaveBeenCalled();
    // The headline regression pin: a failed refund writes NO debit. The old
    // placement committed one at approval — seller docked 5 000¢, buyer
    // unrefunded, recouped from unrelated revenue next cycle.
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("throws dependency_failed/refund_rejected when Stripe reports the refund failed", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { "item-uuid": 5_000 },
    });
    mocks.refundPaymentIntent.mockResolvedValueOnce({
      refundId: "re_rejected_123",
      status: "failed",
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({ code: "REFUND_REJECTED" });

    expect(mocks.markRefunded).not.toHaveBeenCalled();
    // Stripe `failed` — the other arm of the original BLOCKING: no debit.
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("does not mark the order refunded when Stripe reports a pending refund", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    mocks.refundPaymentIntent.mockResolvedValueOnce({
      refundId: "re_pending_123",
      status: "pending",
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });

    expect(result.status).toBe("approved");
    // NO debit yet (Step C review, BLOCKING): the debit is written
    // atomically with markRefunded, gated on a SUCCEEDED refund status. A
    // pending refund is finalized by the charge.refund.updated webhook,
    // whose reconcile pass writes the debit under the Stripe refund id.
    // The old ordering (debit at approval) permanently docked the seller
    // whenever the refund subsequently failed.
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
    expect(mocks.markRefunded).not.toHaveBeenCalled();
  });

  // ── Edge: no payment intent on order ─────────────────────────────────

  it("skips refund gracefully if order has no payment intent", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ stripePaymentIntentId: null }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(result.status).toBe("approved");
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    // NO debit (Step C review, BLOCKING): the buyer got no refund here —
    // debiting the seller anyway is exactly the failure the old placement
    // shipped (seller permanently docked, buyer unrefunded). The debit is
    // written only atomically with a SUCCEEDED refund's markRefunded.
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("reports an approval it cannot refund (no payment intent) — logger.error + reportError, guarded", async () => {
    // The credits stay frozen by the approved claim until someone refunds by
    // hand; a `logger.warn` here never reached Sentry.
    const { deps } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ stripePaymentIntentId: null }),
    });
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(result.status).toBe("approved");
    expect(deps.logger?.error).toHaveBeenCalledWith(
      "reviewClaim.no_payment_intent",
      expect.objectContaining({ claimId: CLAIM_ID, orderId: ORDER_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "review_claim_approved_without_payment_intent",
      }),
      {
        tags: { useCase: "reviewClaim", reason: "no_payment_intent" },
        extra: { claimId: CLAIM_ID, orderId: ORDER_ID },
      },
    );

    // A throwing reporter never changes the outcome.
    const second = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ stripePaymentIntentId: null }),
    });
    second.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      reviewClaim(second.deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
      }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  // ── Per-order refund mutex (concurrent-refund double-pay fix) ────────

  it("conflicts with a concurrent refund on the resale order via the SHARED refund-op namespace", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    // A concurrent buyer full-order refund on the RESALE order holds the
    // per-order mutex — same `refund-op:${orderId}` key every refund path
    // uses, which is exactly what makes the paths mutually exclusive.
    mocks.idempotency.__locks.set(
      `refund-op:${ORDER_ID}`,
      Date.now() + 600_000,
    );

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
      message: "order_refund_in_progress",
    });

    // The conflict came from the shared refund-op namespace (proves a buyer
    // refund and this claim refund contend on the SAME key), acquired with a
    // per-acquire owner token…
    expect(mocks.idempotency.__mocks.begin).toHaveBeenCalledWith(
      `refund-op:${ORDER_ID}`,
      600,
      expect.any(String),
    );
    // …no money moved, no refund state written, seller not debited…
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.markRefunded).not.toHaveBeenCalled();
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
    // …and the claim's OWN idempotency record is released (abandonClaim), so
    // the admin can retry as soon as the competing refund settles.
    expect(mocks.idempotency.__mocks.release).toHaveBeenCalledWith(
      `claim:review:${CLAIM_ID}:approved:full_refund`,
      expect.any(String),
    );
  });

  // ── Default resolution: approved without explicit resolution ─────────

  it("defaults to full_refund when approved without explicit resolution", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
    });

    expect(result.resolution).toBe("full_refund");
  });
});

describe("reviewClaim — dispute guard on the resale order", () => {
  it.each(["OPEN", "UNDER_REVIEW", "LOST"] as const)(
    "refuses approval with ORDER_DISPUTED_REFUND_BLOCKED for a %s dispute before transitioning the claim or touching Stripe",
    async (disputeStatus) => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makeOrder({ disputeStatus }),
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: "payee-seller",
        amountCents: 5_000,
        items: { "item-uuid": 5_000 },
      });

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        }),
      ).rejects.toMatchObject({ code: "ORDER_DISPUTED_REFUND_BLOCKED" });

      expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
      // The claim is untouched (still under_review, resumable once the
      // dispute closes) and the seller is not docked.
      expect(mocks.updateStatus).not.toHaveBeenCalled();
      expect(mocks.markRefunded).not.toHaveBeenCalled();
      expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
      // A refusal is not an attempt: the approval record is neither claimed
      // nor failed, so the retry after the dispute closes is not locked out.
      expect(mocks.idempotency.__mocks.begin).not.toHaveBeenCalled();
      expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
    },
  );

  it("approves and refunds as before when the dispute was WON", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ disputeStatus: "WON" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { "item-uuid": 5_000 },
    });

    const out = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });

    expect(out.status).toBe("approved");
    expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("does not consult the order when denying (no refund would be issued)", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ disputeStatus: "OPEN" }),
    });

    const out = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "denied",
    });

    expect(out.status).toBe("denied");
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
  });
});

// ── Approved claim UNWINDS the resale order (money audit 2026-09-08 #3) ─────
//
// Before this: the approval refunded the buyer's whole PaymentIntent and
// marked the order REFUNDED — and nothing else. The claimant kept a VALID,
// scannable ticket while holding the money, the item stayed `active`, and a
// seller already paid out (ASAP at endsAt+1d) was never reversed, leaving
// the platform fronting the refund. The approval must do what
// refund-full-order's RESALE branch does.

describe("reviewClaim — approved claim unwinds the resale order", () => {
  it("takes the ticket off the claimant, cancels the listing, marks the item refunded, and debits the seller", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: SELLER_PAYEE_ID,
      amountCents: 9_500,
      items: { [RESALE_ITEM_ID]: 9_500 },
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });
    expect(result.status).toBe("approved");

    // The claimant no longer holds a scannable ticket: ownership went back
    // to the seller, the code was rotated (the claimant's QR is dead) and
    // the ticket is re-pointed at the seller's ORIGINAL order item.
    const ticket = mocks.ticketState();
    expect(ticket?.ownerHumanId).toBe(RESPONDENT_ID);
    expect(ticket?.code).not.toBe("CODE-CLAIMANT");
    expect(ticket?.orderItemId).toBe(ORIGINAL_ITEM_ID);
    expect(mocks.tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        fromHumanId: CLAIMANT_ID,
        toHumanId: RESPONDENT_ID,
        orderId: ORDER_ID,
      }),
    );

    // The resale item is refunded (3-arg form — no tax attribution on this
    // path); the seller's original item is active again and unlinked.
    expect(mocks.orderItems.updateStatus).toHaveBeenCalledWith(
      RESALE_ITEM_ID,
      "refunded",
      NOW,
    );
    expect(mocks.orderItems.updateStatus).toHaveBeenCalledWith(
      ORIGINAL_ITEM_ID,
      "active",
      NOW,
    );
    expect(mocks.orderItems.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ITEM_ID,
      null,
    );

    // A CLAIMED listing is cancelled, never relisted: the buyer just proved
    // the ticket was no good, so it must not be offered to a third party.
    expect(mocks.resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
    expect(mocks.tickets.setStatus).not.toHaveBeenCalledWith(
      TICKET_ID,
      "LISTED",
    );

    // Unwind pre-flight ran BEFORE Stripe was touched.
    expect(mocks.calls.indexOf("resaleListings.getById")).toBeLessThan(
      mocks.calls.indexOf("refundPaymentIntent"),
    );

    // Existing effects intact: debit, markRefunded, audit — with the new
    // unwind effects recorded on the order audit row.
    const debits = mocks.payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      payeeId: SELLER_PAYEE_ID,
      amountCents: 9_500,
    });
    expect(mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: ORDER_ID,
        action: "refund_confirmed",
        data: expect.objectContaining({
          claimId: CLAIM_ID,
          refundedItemIds: [RESALE_ITEM_ID],
          listingDisposition: "cancel",
          ledgerRefundDebits: debits.map((d) => ({
            payeeId: d.payeeId,
            debitCents: d.amountCents,
            entryId: d.id,
          })),
        }),
      }),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "resale_listing",
        entityId: LISTING_ID,
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({ listingStatusAfterRefund: "CANCELLED" }),
      }),
    );
  });

  it("refuses to touch Stripe when the unwind pre-flight fails (resale item has no ticket)", async () => {
    // Listing still SOLD to this order + no ticket on the item = a corrupt
    // resale order, NOT an already-unwound one → the strict arm throws.
    // A FRESH approval now stops earlier at the holder check
    // (CLAIM_APPROVAL_TICKET_NOT_HELD, pinned below), so this drives the
    // resume of an already-approved claim, the path the pre-flight still guards.
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "approved", resolution: "full_refund" }),
      ticket: null,
    });
    await mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: SELLER_PAYEE_ID,
      amountCents: 9_500,
      items: { [RESALE_ITEM_ID]: 9_500 },
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });

    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.reverseTransfer).not.toHaveBeenCalled();
    expect(mocks.markRefunded).not.toHaveBeenCalled();
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
    // Retryable once the data is repaired: the approval record is released,
    // not committed.
    expect(mocks.idempotency.__mocks.release).toHaveBeenCalledWith(
      APPROVAL_KEY,
      expect.any(String),
    );
    expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
  });

  describe("seller already paid out", () => {
    const paidOutItem = { paidOutAt: new Date("2026-03-09T00:00:00Z") };
    const payoutItem = {
      payoutItemId: "pitem-seller",
      stripeTransferId: SELLER_TRANSFER_ID,
      payeeId: SELLER_PAYEE_ID,
      plannedOrderItemIds: [RESALE_ITEM_ID],
      amountCents: 9_500,
      netAmountCents: 9_500,
    };

    function makePaidOutOrder(overrides: Partial<OrderRecord> = {}) {
      const base = makeOrder();
      return makeOrder({
        items: base.items.map((i) => ({ ...i, ...paidOutItem })),
        ...overrides,
      });
    }

    it("reverses the seller's transfer BEFORE the buyer refund and nets the debit with a TRANSFER_REVERSAL_CREDIT", async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makePaidOutOrder(),
        payoutItem,
        transferCapacityCents: 9_500,
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });

      const result = await reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      });
      expect(result.status).toBe("approved");

      // ONE reversal for the payee-side attribution, retry-stable key, and
      // it ran BEFORE the buyer refund (refund-full-order's rule: the money
      // must be back before the platform pays the buyer).
      expect(mocks.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(mocks.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: SELLER_TRANSFER_ID,
          amountCents: 9_500,
          idempotencyKey: `${APPROVAL_KEY}:reverse-transfer:${SELLER_TRANSFER_ID}`,
          metadata: expect.objectContaining({ payoutItemId: "pitem-seller" }),
        }),
      );
      expect(mocks.calls.indexOf("reverseTransfer")).toBeGreaterThanOrEqual(0);
      expect(mocks.calls.indexOf("reverseTransfer")).toBeLessThan(
        mocks.calls.indexOf("refundPaymentIntent"),
      );
      expect(mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);

      // Debit for the full credit, reversal credit equal and linked → the
      // seller nets to zero: no negative balance, no platform float.
      const debits = mocks.payeeLedger.entriesOfType("REFUND_DEBIT");
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        idempotencyKey: `refund-debit:${ORDER_ID}:${SELLER_PAYEE_ID}:${CLAIM_ID}`,
      });
      const credits = mocks.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(credits).toHaveLength(1);
      expect(credits[0]).toMatchObject({
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        relatedEntryId: debits[0]!.id,
        idempotencyKey: `transfer-reversal:${ORDER_ID}:${SELLER_PAYEE_ID}:${CLAIM_ID}`,
      });
      expect(credits[0]!.amountCents - debits[0]!.amountCents).toBe(0);

      // The unwind still happened.
      expect(mocks.ticketState()?.ownerHumanId).toBe(RESPONDENT_ID);
      expect(mocks.resaleListings.unwindSale).toHaveBeenCalledWith(
        LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "order",
          action: "refund_confirmed",
          data: expect.objectContaining({
            transferReversals: [
              expect.objectContaining({
                orderItemId: RESALE_ITEM_ID,
                stripeTransferId: SELLER_TRANSFER_ID,
                reversedCents: 9_500,
              }),
            ],
            ledgerReversalCredits: [
              expect.objectContaining({
                payeeId: SELLER_PAYEE_ID,
                creditCents: 9_500,
              }),
            ],
          }),
        }),
      );
    });

    it("issues NO buyer refund when the reversal fails — approval record released, retryable", async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makePaidOutOrder(),
        payoutItem,
        transferCapacityCents: 9_500,
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });
      mocks.reverseTransfer.mockRejectedValueOnce(
        new Error("stripe_transfer_reversal_failed"),
      );

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        }),
      ).rejects.toMatchObject({ code: "dependency_failed" });

      // The platform did not front a refund it could not pull back.
      expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.markRefunded).not.toHaveBeenCalled();
      expect(mocks.tickets.transfer).not.toHaveBeenCalled();
      expect(mocks.resaleListings.unwindSale).not.toHaveBeenCalled();
      expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
      expect(
        mocks.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT"),
      ).toHaveLength(0);
      // Retryable: the approval's idempotency record is released, not
      // committed, and the claimant still holds their ticket.
      expect(mocks.idempotency.__mocks.release).toHaveBeenCalledWith(
        APPROVAL_KEY,
        expect.any(String),
      );
      expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
      expect(mocks.ticketState()?.ownerHumanId).toBe(CLAIMANT_ID);
    });

    it("replays after a crash between Stripe and the local commit: one reversal, one refund, one debit, one credit", async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makePaidOutOrder(),
        payoutItem,
        transferCapacityCents: 9_500,
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });
      const refundRequests: string[] = [];
      mocks.refundPaymentIntent.mockImplementation(
        async (input: { idempotencyKey: string }) => {
          mocks.calls.push("refundPaymentIntent");
          refundRequests.push(input.idempotencyKey);
          return { refundId: "re_retry_123", status: "succeeded" as const };
        },
      );
      mocks.tx.mockImplementation(async (fn: any) => {
        if (mocks.tx.mock.calls.length === 2) {
          throw new Error("crash_after_stripe_before_local_commit");
        }
        return fn(mocks.txRepos);
      });

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        }),
      ).rejects.toMatchObject({ code: "dependency_failed" });

      const result = await reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      });
      expect(result.status).toBe("approved");

      // ONE Stripe reversal, ever: the retry's capacity pre-flight sees the
      // transfer fully reversed, lists its reversals, recognises OUR earlier
      // attempt by `opKey` and reconstructs the result without a second
      // request (reverse-transfers-for-items recovery arm). The refund was
      // requested under one stable key both times.
      expect(mocks.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(mocks.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            opKey: `${APPROVAL_KEY}:reverse-transfer`,
          }),
        }),
      );
      expect(deps.payments!.listTransferReversals).toHaveBeenCalledWith({
        transferId: SELLER_TRANSFER_ID,
      });
      expect(new Set(refundRequests).size).toBe(1);
      expect(refundRequests).toHaveLength(2);
      // Ledger: exactly one debit and one credit, ever.
      expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
      expect(
        mocks.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT"),
      ).toHaveLength(1);
      expect(mocks.markRefunded).toHaveBeenCalledTimes(1);
      expect(mocks.resaleListings.unwindSale).toHaveBeenCalledTimes(1);
    });

    it("fails TRANSIENT (retryable) when the buyer refund is pending after a reversal — never leaves the seller's money uncredited", async () => {
      // The pending arm defers finalisation to the charge.refunded webhook,
      // whose reconcile pass writes the debit but knows nothing about the
      // reversal we just executed — the seller would be docked twice. So
      // when a reversal happened, pending is not "done": fail the approval
      // record so the admin retries, and the retry's Stripe replay picks up
      // the (by then) succeeded refund and writes debit + credit together.
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makePaidOutOrder(),
        payoutItem,
        transferCapacityCents: 9_500,
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });
      mocks.refundPaymentIntent.mockResolvedValueOnce({
        refundId: "re_pending_123",
        status: "pending",
      });

      await expect(
        reviewClaim(deps, {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        }),
      ).rejects.toMatchObject({ code: "TRANSIENT" });

      expect(mocks.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(mocks.markRefunded).not.toHaveBeenCalled();
      expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
      expect(mocks.idempotency.__mocks.release).toHaveBeenCalledWith(
        APPROVAL_KEY,
        expect.any(String),
      );
    });

    it("credits an executed reversal when the webhook reconcile lands DURING the attempt (in-tx REFUNDED branch)", async () => {
      // Within one attempt: our reversal executed, then charge.refunded
      // reconciled the order (REFUNDED, unwound, debit under the Stripe
      // refund id) while our Stripe call was in flight. The success tx finds
      // it REFUNDED and must still credit the reversal we executed —
      // cross-key pairing against the webhook's debit.
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        order: makePaidOutOrder(),
        payoutItem,
        transferCapacityCents: 9_500,
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });
      mocks.refundPaymentIntent.mockImplementationOnce(async () => {
        const live = (await mocks.getOrderById())!;
        mocks.getOrderById.mockResolvedValue({ ...live, status: "REFUNDED" });
        await mocks.payeeLedger.repo.refundDebit({
          idempotencyKey: `refund-debit:${ORDER_ID}:${SELLER_PAYEE_ID}:re_webhook_1`,
          payeeId: SELLER_PAYEE_ID,
          amountCents: 9_500,
          currency: "usd",
          orderId: ORDER_ID,
          sourceKind: "refund",
          sourceId: "re_webhook_1",
          description: "webhook debit",
        } as any);
        return { refundId: "re_webhook_1", status: "succeeded" };
      });

      const result = await reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      });
      expect(result.status).toBe("approved");

      expect(mocks.reverseTransfer).toHaveBeenCalledTimes(1);
      // No second unwind, no second markRefunded, no second debit…
      expect(mocks.markRefunded).not.toHaveBeenCalled();
      expect(mocks.resaleListings.unwindSale).not.toHaveBeenCalled();
      expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
      // …but the money the seller physically returned IS credited.
      const credits = mocks.payeeLedger.entriesOfType(
        "TRANSFER_REVERSAL_CREDIT",
      );
      expect(credits).toHaveLength(1);
      expect(credits[0]).toMatchObject({
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
      });
    });

    it("on a LATER attempt after the reconciler (items refunded, no reversal credit): no Stripe call, completes, REPORTS the unverified reversal credit", async () => {
      // The real reconciler shape (reconcile-stripe-full-refund): the
      // paid-out item is flipped to `refunded`, the order REFUNDED, a
      // REFUND_DEBIT written under the Stripe refund id — and NO reversal
      // credit. An earlier attempt reversed the seller's transfer, then the
      // claim was released. This attempt's `requiresReversal` is empty, so
      // no replay can credit it: the seller may be docked twice. Recovery is
      // a follow-up; today it must be LOUD.
      const unwoundListing = makeListing({ status: "CANCELLED", buyerOrderId: null });
      const base = makePaidOutOrder({ status: "REFUNDED" });
      const reconciled = {
        ...base,
        items: base.items.map((i) => ({
          ...i,
          status: "refunded",
          refundedAt: new Date("2026-03-10T11:00:00Z"),
        })),
      } as OrderRecord;
      // The earlier attempt's first tx committed the claim as approved, so
      // this LATER attempt is a resume (and skips the fresh-approval holder
      // check, which would see the ticket already restored to the seller).
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "approved", resolution: "full_refund" }),
        order: reconciled,
        payoutItem,
        transferCapacityCents: 9_500,
        listing: unwoundListing,
        ticket: makeTicket({
          ownerHumanId: RESPONDENT_ID,
          orderId: ORIGINAL_ORDER_ID,
          orderItemId: ORIGINAL_ITEM_ID,
          code: "CODE-RESTORED",
        }),
      });
      await mocks.payeeLedger.seedCredit({
        orderId: ORDER_ID,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        items: { [RESALE_ITEM_ID]: 9_500 },
      });
      await mocks.payeeLedger.repo.refundDebit({
        idempotencyKey: `refund-debit:${ORDER_ID}:${SELLER_PAYEE_ID}:re_webhook_1`,
        payeeId: SELLER_PAYEE_ID,
        amountCents: 9_500,
        currency: "usd",
        orderId: ORDER_ID,
        sourceKind: "refund",
        sourceId: "re_webhook_1",
        description: "webhook debit",
      } as any);
      const reportError = vi.fn();

      const result = await reviewClaim(
        { ...deps, reportError },
        {
          actorHumanId: ACTOR_ID,
          claimId: CLAIM_ID,
          status: "approved",
          resolution: "full_refund",
        },
      );

      expect(result.status).toBe("approved");
      expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.reverseTransfer).not.toHaveBeenCalled();
      expect(mocks.markRefunded).not.toHaveBeenCalled();
      expect(mocks.payeeLedger.entriesOfType("TRANSFER_REVERSAL_CREDIT")).toHaveLength(0);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: {
          useCase: "reviewClaim",
          stage: "reversal_credit_unverified_on_resume",
        },
        extra: {
          claimId: CLAIM_ID,
          orderId: ORDER_ID,
          paidOutItemIds: [RESALE_ITEM_ID],
        },
      });
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "refund_confirmed_on_resume",
          data: expect.objectContaining({
            claimId: CLAIM_ID,
            refundedBy: "elsewhere",
            reversalCreditUnverified: true,
          }),
        }),
      );
    });
  });
});

// ── Authorization ──────────────────────────────────────────────────────────
//
// `claims.review` is mounted as a bare `authedProcedure` (NOT under
// `platform.*`), so the ONLY thing standing between any signed-in user and a
// Stripe refund is the gate inside this use case. Pin that it fires before any
// repo, idempotency, or payment call.

describe("reviewClaim — claim-desk staff gate", () => {
  it("a non-staff actor gets STAFF_ONLY before any repo/idempotency/payment call", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      staff: false,
    });

    await expect(
      reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(mocks.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: [...CLAIM_DESK_ROLES],
    });
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.tx).not.toHaveBeenCalled();
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.reverseTransfer).not.toHaveBeenCalled();
    expect(mocks.payeeLedger.entriesOfType("REFUND_DEBIT")).toEqual([]);
    expect(mocks.calls).toEqual([]);
  });

  it("a staff actor passes the gate and the transition proceeds", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "open" }),
      staff: true,
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "under_review",
    });

    expect(result.status).toBe("under_review");
    expect(mocks.hasStaffRole).toHaveBeenCalledTimes(1);
  });
});

// ── Approval refused when the buyer no longer holds the ticket ────────
// Owner ruling 2026-10-05: a claim filed before createClaim checked the
// holder can sit on a ticket the buyer has since given away. Approving it
// would refund the buyer and the unwind would take the ticket from whoever
// holds it, so approval is refused before any write or Stripe call.
describe("approval when the buyer no longer holds the ticket", () => {
  type Case = {
    name: string;
    ticket?: FakeTicket | null;
    itemStatus?: "active" | "transferred" | "refunded";
  };
  const NOT_HELD: Case[] = [
    {
      name: "the ticket was gifted (item transferred, new owner)",
      ticket: makeTicket({ ownerHumanId: "99999999-9999-4999-8999-999999999999" }),
      itemStatus: "transferred",
    },
    {
      name: "the ticket's owner is someone else",
      ticket: makeTicket({ ownerHumanId: "99999999-9999-4999-8999-999999999999" }),
    },
    { name: "the ticket is relisted (LISTED)", ticket: makeTicket({ status: "LISTED" }) },
    { name: "the ticket is REFUNDED", ticket: makeTicket({ status: "REFUNDED" }) },
    { name: "the item has no ticket (resold on)", ticket: null },
    { name: "the item is refunded", itemStatus: "refunded" },
  ];

  for (const resolution of ["full_refund", undefined] as const) {
    for (const c of NOT_HELD) {
      it(`refuses approval (resolution ${resolution ?? "omitted"}) when ${c.name}`, async () => {
        const { deps, mocks } = makeDeps({
          claim: makeClaim({ status: "under_review" }),
          ticket: c.ticket,
          order: c.itemStatus
            ? makeOrder({
                items: makeOrder().items.map((i) => ({
                  ...i,
                  status: c.itemStatus!,
                })),
              })
            : undefined,
        });

        await expect(
          reviewClaim(deps, {
            actorHumanId: ACTOR_ID,
            claimId: CLAIM_ID,
            status: "approved",
            resolution,
          }),
        ).rejects.toMatchObject({ code: "CLAIM_APPROVAL_TICKET_NOT_HELD" });

        expect(mocks.txRepos.claims.lockOrderItem).toHaveBeenCalledWith(
          RESALE_ITEM_ID,
        );
        expect(mocks.updateStatus).not.toHaveBeenCalled();
        expect(mocks.auditLog).not.toHaveBeenCalled();
        expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
        expect(mocks.reverseTransfer).not.toHaveBeenCalled();
        expect(mocks.tickets.transfer).not.toHaveBeenCalled();
        expect(mocks.markRefunded).not.toHaveBeenCalled();
        expect(mocks.calls).toEqual(["claims.lockOrderItem"]);
        // The refusal is not an attempt: the key is released for a retry
        // (once a relist is cancelled) instead of locked out for 15 minutes.
        expect(mocks.idempotency.__mocks.release).toHaveBeenCalledWith(
          `claim:review:${CLAIM_ID}:approved:full_refund`,
          expect.any(String),
        );
        expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
        expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
      });
    }
  }

  for (const status of ["VALID", "SCANNED", "INVALID"]) {
    it(`approves when the claimant holds a ${status} ticket, lock first`, async () => {
      const { deps, mocks } = makeDeps({
        claim: makeClaim({ status: "under_review" }),
        ticket: makeTicket({ status }),
      });

      const result = await reviewClaim(deps, {
        actorHumanId: ACTOR_ID,
        claimId: CLAIM_ID,
        status: "approved",
        resolution: "full_refund",
      });

      expect(result.status).toBe("approved");
      const lockAt =
        mocks.txRepos.claims.lockOrderItem.mock.invocationCallOrder[0];
      expect(lockAt).toBeLessThan(
        mocks.orderItems.getById.mock.invocationCallOrder[0],
      );
      expect(lockAt).toBeLessThan(
        mocks.tickets.getByOrderItemId.mock.invocationCallOrder[0],
      );
      expect(lockAt).toBeLessThan(mocks.updateStatus.mock.invocationCallOrder[0]);
    });
  }

  it("approves a claim whose order another path already refunded (no unwind)", async () => {
    // Staff refund or the Stripe reconciler refunded the resale order while
    // the claim sat under_review: the item is refunded and the ticket is
    // back with the seller. Approval takes the "refunded elsewhere" branch,
    // which never unwinds, so the holder check does not apply.
    const base = makeOrder({ status: "REFUNDED" });
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: {
        ...base,
        items: base.items.map((i) => ({ ...i, status: "refunded" })),
      } as OrderRecord,
      listing: makeListing({ status: "CANCELLED", buyerOrderId: null }),
      ticket: makeTicket({
        ownerHumanId: RESPONDENT_ID,
        orderId: ORIGINAL_ORDER_ID,
        orderItemId: ORIGINAL_ITEM_ID,
        code: "CODE-RESTORED",
      }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });

    expect(result.status).toBe("approved");
    // The holder check was skipped (the item is refunded, which it would
    // refuse), the claim moved once, and the order was not re-refunded.
    expect(mocks.updateStatus).toHaveBeenCalledTimes(1);
    expect(mocks.markRefunded).not.toHaveBeenCalled();
    expect(mocks.refundPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.tickets.transfer).not.toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_confirmed_on_resume",
        data: expect.objectContaining({ refundedBy: "elsewhere" }),
      }),
    );
  });

  it("still lets support deny a claim on a given-away ticket", async () => {
    const { deps, mocks } = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      ticket: makeTicket({ ownerHumanId: "99999999-9999-4999-8999-999999999999" }),
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "denied",
    });

    expect(result.status).toBe("denied");
    // Every transition takes the claim lock now (concurrent decisions), but
    // only approval runs the holder check.
    expect(mocks.txRepos.claims.lockOrderItem).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.getByOrderItemId).not.toHaveBeenCalled();
  });

  it("still lets support move a claim on a given-away ticket to under_review", async () => {
    const { deps } = makeDeps({
      claim: makeClaim({ status: "open" }),
      ticket: null,
    });

    const result = await reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "under_review",
    });

    expect(result.status).toBe("under_review");
  });
});

// ── "Your refund has gone through" (owner ruling 2026-10-07) ─────────────────

describe("reviewClaim — tells the buyer they have been refunded", () => {
  const REFUNDED_VARIANT = "resale.claim-refunded";

  function withNotices(
    built: ReturnType<typeof makeDeps>,
    opts: { createThrows?: boolean; reporterThrows?: boolean } = {},
  ) {
    let rowSeq = 0;
    const create = vi.fn(
      async (
        _input: { metadata?: { variant?: string } },
      ): Promise<{ id: string; createdAt: Date }> => {
        if (opts.createThrows) throw new Error("notifications down");
        return { id: `n-${++rowSeq}`, createdAt: NOW };
      },
    );
    const send = vi.fn(async (_m: { idempotencyKey?: string }) => ({
      result: { id: "m", status: "sent" },
    }));
    const reportError = vi.fn(() => {
      if (opts.reporterThrows) throw new Error("reporter down");
    });
    Object.assign(built.deps.repos as object, {
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id, name: "Someone", locale: null },
          identity: { email: `${id}@example.com` },
        })),
      },
      events: {
        getById: vi.fn(async () => ({ id: EVENT_ID, title: "Sunset Sessions" })),
      },
      notifications: { create },
    });
    built.deps.mailer = { send } as unknown as ReviewClaimDeps["mailer"];
    built.deps.publicAppUrl = "https://ithas.fire";
    built.deps.reportError = reportError;
    // Stripe's view of the claim's refund: the whole charge unless a test
    // says otherwise. Stamped like buildRefundMetadata stamps it.
    const claimRefund = {
      refundId: "re_test_123",
      status: "succeeded" as const,
      amountCents: 10_950,
      paymentIntentId: PAYMENT_INTENT_ID,
      metadata: { useCase: "reviewClaim", orderId: ORDER_ID },
    };
    const getRefund = vi.fn(async (_i: { refundId: string }) => claimRefund);
    const listRefundsForPaymentIntent = vi.fn(async () => [claimRefund]);
    Object.assign(built.deps.payments as object, {
      getRefund,
      listRefundsForPaymentIntent,
    });
    const rowsOf = (variant: string) =>
      create.mock.calls
        .map(([input]) => input as Record<string, any>)
        .filter((input) => input.metadata?.variant === variant);
    return {
      create,
      send,
      reportError,
      rowsOf,
      claimRefund,
      getRefund,
      listRefundsForPaymentIntent,
    };
  }

  /** Lets the fire-and-forget notice chain run to the end. */
  async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  const approve = (deps: ReviewClaimDeps) =>
    reviewClaim(deps, {
      actorHumanId: ACTOR_ID,
      claimId: CLAIM_ID,
      status: "approved",
      resolution: "full_refund",
    });

  /** Simulates the approval record lapsing before a staff retry. */
  function lapseApprovalRecord(built: ReturnType<typeof makeDeps>) {
    built.mocks.idempotency.__store.delete(APPROVAL_KEY);
    built.mocks.idempotency.__locks.delete(APPROVAL_KEY);
  }

  it("sends one notice, after the approval notice, when Stripe says succeeded", async () => {
    const built = makeDeps({ claim: makeClaim({ status: "under_review" }) });
    const { create, send, rowsOf, getRefund } = withNotices(built);

    await approve(built.deps);
    await settle();

    const rows = rowsOf(REFUNDED_VARIANT);
    expect(rows).toHaveLength(1);
    // The amount is the claim refund's own, read from Stripe by its id.
    expect(getRefund).toHaveBeenCalledWith({ refundId: "re_test_123" });
    expect(rows[0]).toMatchObject({
      humanId: CLAIMANT_ID,
      title: "We've refunded you",
      body: "We refunded $109.50 for the Sunset Sessions resale ticket to the payment method you used. Your bank can take 5 to 10 business days to show it.",
      action: {
        label: "View order",
        href: `https://ithas.fire/my-tickets/${ORDER_ID}`,
      },
    });
    // Approval rows (buyer + seller) come first.
    const variants = create.mock.calls.map(
      ([input]) => (input as Record<string, any>).metadata?.variant,
    );
    expect(variants.indexOf(REFUNDED_VARIANT)).toBeGreaterThan(
      variants.lastIndexOf("resale.claim-resolved"),
    );
    expect(
      send.mock.calls.filter(
        ([m]) => m.idempotencyKey === `resale-claim-refunded:${CLAIM_ID}`,
      ),
    ).toHaveLength(1);
  });

  it("sends nothing when the refund is still pending (the webhook tells them)", async () => {
    const built = makeDeps({ claim: makeClaim({ status: "under_review" }) });
    const { rowsOf } = withNotices(built);
    built.mocks.refundPaymentIntent.mockResolvedValueOnce({
      refundId: "re_pending_123",
      status: "pending",
    });

    await approve(built.deps);
    await settle();

    expect(rowsOf("resale.claim-resolved")).toHaveLength(2);
    expect(rowsOf(REFUNDED_VARIANT)).toHaveLength(0);
  });

  /**
   * Attempt 1 commits the refund but its client sees an error (the
   * connection drops after the success tx commits), so no notice goes out;
   * staff retry. Same fixture as the "refund_confirmed_on_resume" pin above:
   * the listing and ticket start in the post-unwind shape the RETRY reads.
   */
  async function committedButErrored() {
    const built = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      listing: makeListing({ status: "CANCELLED", buyerOrderId: null }),
      ticket: makeTicket({
        ownerHumanId: RESPONDENT_ID,
        orderId: ORIGINAL_ORDER_ID,
        orderItemId: ORIGINAL_ITEM_ID,
        code: "CODE-RESTORED",
      }),
    });
    built.mocks.tx.mockImplementation(async (fn: any) => {
      const out = await fn(built.mocks.txRepos);
      if (built.mocks.tx.mock.calls.length === 2) {
        throw new Error("connection_dropped_after_commit");
      }
      return out;
    });
    built.mocks.tickets.getByOrderItemId!.mockImplementationOnce(async () =>
      makeTicket(),
    );
    // The claim-keyed debit attempt 1 writes is how the retry knows the
    // refund was its own (refundedBy "claim_tx").
    await built.mocks.payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 9_500,
      items: { "item-uuid": 9_500 },
    });
    return built;
  }

  it("a staff retry that resumes the committed refund tells the buyer, once", async () => {
    const built = await committedButErrored();
    const { rowsOf, send } = withNotices(built);

    await expect(approve(built.deps)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    await settle();
    expect(rowsOf(REFUNDED_VARIANT)).toHaveLength(0);

    // Retry: resumes the order this claim's own tx refunded.
    await expect(approve(built.deps)).resolves.toMatchObject({
      status: "approved",
    });
    await settle();
    expect(built.mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_confirmed_on_resume",
        data: expect.objectContaining({ refundedBy: "claim_tx" }),
      }),
    );
    expect(built.mocks.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(rowsOf(REFUNDED_VARIANT)).toHaveLength(1);

    // Another retry once the approval record has lapsed: resumes again, and
    // the notice's own record keeps it from going out twice.
    lapseApprovalRecord(built);
    await approve(built.deps);
    await settle();

    expect(rowsOf(REFUNDED_VARIANT)).toHaveLength(1);
    expect(
      send.mock.calls.filter(
        ([m]) => m.idempotencyKey === `resale-claim-refunded:${CLAIM_ID}`,
      ),
    ).toHaveLength(1);
  });

  it("sends nothing when the webhook already told the buyer (the race)", async () => {
    const built = makeDeps({ claim: makeClaim({ status: "under_review" }) });
    const { rowsOf } = withNotices(built);
    await built.mocks.idempotency.commit(
      `resale-claim-refunded-notice:${CLAIM_ID}`,
      { sentAt: NOW.toISOString() },
      3600,
    );

    await approve(built.deps);
    await settle();

    expect(rowsOf("resale.claim-resolved")).toHaveLength(2);
    expect(rowsOf(REFUNDED_VARIANT)).toHaveLength(0);
  });

  it("a throwing notifier and reporter never fail the refund", async () => {
    const built = makeDeps({ claim: makeClaim({ status: "under_review" }) });
    const { reportError } = withNotices(built, {
      createThrows: true,
      reporterThrows: true,
    });

    const result = await approve(built.deps);
    await settle();

    expect(result.status).toBe("approved");
    expect(built.mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "failed" },
      }),
    );
  });

  it("a part-refunded order shows what this refund returned, not the whole charge", async () => {
    // An earlier refund already returned $50.00 of the $109.50 charge, so the
    // claim's full-PaymentIntent refund returns the remaining $59.50.
    const built = makeDeps({
      claim: makeClaim({ status: "under_review" }),
      order: makeOrder({ status: "PART_REFUNDED" }),
    });
    const { rowsOf, claimRefund } = withNotices(built);
    claimRefund.amountCents = 5_950;

    await approve(built.deps);
    await settle();

    const rows = rowsOf(REFUNDED_VARIANT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain("We refunded $59.50 for");
    expect(rows[0]!.body).not.toContain("$109.50");
  });

  it("a throwing logger.error still reaches reportError, and the refund stands", async () => {
    const built = makeDeps({ claim: makeClaim({ status: "under_review" }) });
    const { reportError } = withNotices(built, { createThrows: true });

    const result = await approve(built.deps);
    // From here on only the fire-and-forget notices run: the logger breaks
    // under them, not under the refund itself.
    vi.mocked(built.deps.logger!.error).mockImplementation(() => {
      throw new Error("logger down");
    });
    await settle();

    expect(result.status).toBe("approved");
    expect(built.mocks.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "failed" },
      }),
    );
  });
});
