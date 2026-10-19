import { describe, it, expect, vi, beforeEach } from "vitest";

import { formatOrderCode } from "@th/types/order-identifier";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type {
  AcceptanceRecordRow,
  CreateAcceptanceRecordInput,
  FindCurrentAcceptanceInput,
} from "@th/ports/repos/acceptances";

import {
  CURRENT_BUYER_TERMS_TEXT,
  CURRENT_BUYER_TERMS_VERSION,
} from "../../../lib/legal/buyer-terms";
import {
  CURRENT_REFUND_POLICY_VERSION,
  getCurrentRefundPolicySnapshot,
} from "../../../lib/payments/refund-policy";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { createResaleCheckout } from "../create-resale-checkout";

// ── Constants ──────────────────────────────────────────────────────────────

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const LISTING_ID = "aa222222-aa22-4a22-8a22-aa2222222222";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TICKET_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
const TT_ID = "aa444444-aa44-4a44-8a44-aa4444444444";
const FEE_POLICY_ID = "aa555555-aa55-4a55-8a55-aa5555555555";
const TERMS_ID = "aa666666-aa66-4a66-8a66-aa6666666666";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Mock data factories ────────────────────────────────────────────────────

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    eventId: EVENT_ID,
    ticketId: TICKET_ID,
    resalePayoutTermsId: TERMS_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    faceValueCents: 5000,
    processingPassThroughCents: 175,
    processingFeeConfigRef: "stripe-standard",
    saleCutoffAt: new Date("2026-04-01T19:00:00Z"),
    payoutReleaseAt: new Date("2026-06-08T00:00:00Z"),
    // Priced under the organiser's share (FR-005): a 0% SELLER clause by
    // default (the seller item's record below), so the basis is the ask.
    eventShareCents: 0,
    sharePayer: "SELLER",
    status: "ACTIVE",
    source: "internal",
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * A listing made under the markup split, before the share existed: no
 * `eventShareCents` (organiser-resale-share FR-014 removed the split).
 */
function makeLegacyListing(overrides: Record<string, unknown> = {}) {
  return makeListing({
    eventShareCents: null,
    sharePayer: null,
    ...overrides,
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Launch Party",
    resalePayoutTermsId: TERMS_ID,
    currency: "usd",
    admissionTaxRateBps: 0,
    startsAt: new Date("2026-04-01T19:00:00Z"),
    endsAt: new Date("2026-06-01T00:00:00Z"),
    resalePayoutReleaseDaysOverride: null,
    ...overrides,
  };
}

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    ticketTypeId: TT_ID,
    seatId: null,
    ownerHumanId: SELLER_ID,
    orderId: "orig-order-1",
    orderItemId: "orig-item-1",
    status: "LISTED",
    ...overrides,
  };
}

function makeTicketType(overrides: Record<string, unknown> = {}) {
  return {
    id: TT_ID,
    priceCents: 5000,
    resaleCapCents: null,
    seatSectionId: null,
    resaleAllowed: true,
    ...overrides,
  };
}

function makeFeePolicy() {
  return {
    id: FEE_POLICY_ID,
    scopeType: "GLOBAL" as const,
    scopeId: null,
    status: "ACTIVE" as const,
    version: 1,
    effectiveFrom: new Date("2025-01-01T00:00:00Z"),
    effectiveTo: null,
    buyerFeePct: 4,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: 100,
    feeMode: "PASS_THROUGH" as const,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    payoutMinimumCents: 0,
    connectAccountFeeCents: 0,
  };
}

function makePayoutTerms() {
  return {
    id: TERMS_ID,
    kind: "RESALE" as const,
    status: "ACTIVE" as const,
    feeMode: "PASS_THROUGH" as const,
    feePolicyId: FEE_POLICY_ID,
    isDefault: false,
    settlementCurrency: "usd",
    payoutSchedule: "ASAP" as const,
    resaleProcessingFeeConfigRef: "stripe-standard",
    resalePayoutReleaseDays: 7,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makePayoutTermsLines() {
  return [
    {
      id: "aa000001-aa00-4a00-8a00-aa0000000001",
      payoutTermsId: TERMS_ID,
      payeeId: SELLER_ID,
      percent: 100,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR" as const,
    },
  ];
}

// ── Repo mock builder ──────────────────────────────────────────────────────

/**
 * The seller's purchase snapshot: `OrderItem.unitPriceCents`, and the FR-003
 * resale clause record of its first sale (a 0% SELLER clause by default,
 * matching `makeListing`'s share of 0).
 */
function makeOrderItem(unitPriceCents: number) {
  return {
    id: "orig-item-1",
    orderId: "orig-order-1",
    kind: "ticket",
    ticketTypeId: TT_ID,
    qty: 1,
    unitPriceCents,
    amountCents: unitPriceCents,
    meta: {},
    status: "active",
    resaleClauseType: "PERCENT",
    resaleClauseBps: 0,
    resaleClauseCents: null,
    resaleClausePayer: "SELLER",
    resaleClauseTermsId: TERMS_ID,
    resaleClauseTermsVersion: 1,
    originalUnitPriceCents: unitPriceCents,
  };
}

function makeDeps(opts?: {
  /** `OrderItem.unitPriceCents` — what the SELLER paid for the ticket. */
  purchasedUnitPriceCents?: number;
  /** Force `orderItems.getById` to miss (legacy / fixture ticket). */
  orderItemMissing?: boolean;
  /**
   * The listing's status follows the hold state (HELD while held, ACTIVE once
   * released) and a second hold is refused, like the adapter. Off by default
   * so single-shot tests keep their scripted listing.
   */
  statefulListing?: boolean;
}) {
  const getOrderItemById = vi.fn(async () =>
    opts?.orderItemMissing
      ? null
      : makeOrderItem(opts?.purchasedUnitPriceCents ?? 5000),
  );
  // Order + listing state the CAS fakes below act on, with the adapters'
  // fenced semantics (resale-listings.ts / orders.ts).
  const orders = new Map<
    string,
    { status: string; stripePaymentIntentId: string | null }
  >();
  const listingState: {
    status: string;
    hold: { buyerHumanId: string; heldUntil: Date } | null;
  } = { status: "ACTIVE", hold: null };
  const state = { txDepth: 0, paymentCalls: [] as Array<{ method: string; inTx: boolean }> };

  const getListingById = vi.fn(async () =>
    opts?.statefulListing
      ? makeListing({ status: listingState.status })
      : makeListing(),
  );
  const holdListing = vi.fn(
    async (_listingId: string, buyerHumanId: string, heldUntil: Date) => {
      if (opts?.statefulListing && listingState.hold) return { ok: false };
      listingState.hold = { buyerHumanId, heldUntil };
      listingState.status = "HELD";
      return { ok: true };
    },
  );
  const holdMatches = (h: { buyerHumanId: string; heldUntil: Date }) =>
    listingState.status === "HELD" &&
    listingState.hold != null &&
    listingState.hold.buyerHumanId === h.buyerHumanId &&
    listingState.hold.heldUntil.getTime() === h.heldUntil.getTime();
  const lockHold = vi.fn(
    async (_listingId: string, h: { buyerHumanId: string; heldUntil: Date }) =>
      holdMatches(h),
  );
  const releaseHold = vi.fn(
    async (_listingId: string, h: { buyerHumanId: string; heldUntil: Date }) => {
      if (!holdMatches(h)) return { released: false as const };
      listingState.hold = null;
      listingState.status = "ACTIVE";
      return { released: true as const, listingStatus: "ACTIVE" as const };
    },
  );
  const getEventById = vi.fn(async () => makeEvent());
  const getTicketById = vi.fn(async () => makeTicket());
  const getTicketTypeById = vi.fn(async () => makeTicketType());
  const getPayoutTermsById = vi.fn(async () => makePayoutTerms());
  const listPayoutTermsLines = vi.fn(async () => makePayoutTermsLines());
  const getFeePolicyById = vi.fn(async () => makeFeePolicy());
  const createPending = vi.fn(async (data: any) => {
    orders.set(data.id, { status: "PENDING", stripePaymentIntentId: null });
    return { id: data.id, ...data };
  });
  /** The unconditional link. Must never be called: the link is the CAS. */
  const linkPaymentIntent = vi.fn(async () => {
    throw new Error("unconditional linkPaymentIntent called");
  });
  const linkPaymentIntentIfPending = vi.fn(
    async (orderId: string, piId: string) => {
      const o = orders.get(orderId);
      if (!o || o.status !== "PENDING") return false;
      if (o.stripePaymentIntentId !== null && o.stripePaymentIntentId !== piId) {
        return false;
      }
      o.stripePaymentIntentId = piId;
      return true;
    },
  );
  const cancelPendingOrder = vi.fn(
    async (
      orderId: string,
      casOpts?: { expectedPaymentIntentId: string | null },
    ) => {
      const o = orders.get(orderId);
      if (!o || o.status !== "PENDING") return false;
      if (casOpts && o.stripePaymentIntentId !== casOpts.expectedPaymentIntentId) {
        return false;
      }
      o.status = "CANCELLED";
      return true;
    },
  );
  const createTaxLines = vi.fn(async () => {});
  const auditLog = vi.fn(async () => {});

  // Acceptance ledger fake — keyed like the adapter:
  // (human, documentType, version, scope).
  const acceptanceStore: AcceptanceRecordRow[] = [];
  const acceptancesFindCurrent = vi.fn(
    async (query: FindCurrentAcceptanceInput) =>
      acceptanceStore.find(
        (row) =>
          row.humanId === query.humanId &&
          row.documentType === query.documentType &&
          row.documentVersion === query.documentVersion &&
          row.scopeType === (query.scopeType ?? "GLOBAL") &&
          row.scopeId === (query.scopeId ?? null),
      ) ?? null,
  );
  const acceptancesCreate = vi.fn(
    async (record: CreateAcceptanceRecordInput) => {
      const row: AcceptanceRecordRow = {
        id: `acceptance-${acceptanceStore.length + 1}`,
        humanId: record.humanId,
        documentType: record.documentType,
        documentVersion: record.documentVersion,
        documentTextSnapshot: record.documentTextSnapshot,
        scopeType: record.scopeType,
        scopeId: record.scopeId ?? null,
        acceptedAt: record.acceptedAt ?? NOW,
        ipAddress: record.ipAddress ?? null,
        userAgent: record.userAgent ?? null,
        metadata: record.metadata ?? null,
      };
      acceptanceStore.push(row);
      return row;
    },
  );

  // The tax self-heal stamp is written after the transaction commits, on the
  // non-transaction repos (`fillTaxRateIfUnset`). On the transaction's handle
  // it is a test failure.
  const txEventsTaxWrite = vi.fn(async () => {
    throw new Error("tax self-heal written ON the resale transaction");
  });
  const nonTxFillTaxRateIfUnset = vi.fn(async () => true);

  const txRepos = {
    resaleListings: {
      getById: getListingById,
      hold: holdListing,
      lockHold,
      releaseHold,
    } as any,
    events: {
      getById: getEventById,
      updateTaxRate: txEventsTaxWrite,
      fillTaxRateIfUnset: txEventsTaxWrite,
    } as any,
    tickets: { getById: getTicketById, getTicketTypeById } as any,
    orderItems: { getById: getOrderItemById } as any,
    payoutTerms: {
      getById: getPayoutTermsById,
      listLines: listPayoutTermsLines,
    } as any,
    feePolicies: { getById: getFeePolicyById } as any,
    orders: {
      createPending,
      linkPaymentIntent,
      linkPaymentIntentIfPending,
      cancelPendingOrder,
      getById: vi.fn(async (orderId: string) => {
        const o = orders.get(orderId);
        return o ? { id: orderId, ...o } : null;
      }),
      createTaxLines,
    } as any,
    audit: { log: auditLog } as any,
    acceptances: {
      findCurrent: acceptancesFindCurrent,
      create: acceptancesCreate,
    } as any,
  };

  // The NON-transaction reads: the checkout reads the listing and event
  // BEFORE its transaction to do the tax-provider lookup there
  // (`prepareCheckoutTax`). Separate spies that follow the tx spies'
  // PERSISTENT implementation (`mockResolvedValue`) without consuming their
  // `mockResolvedValueOnce` queue — tests that stage a one-off in-transaction
  // state keep it for the transaction's read.
  const followPersistent =
    (spy: ReturnType<typeof vi.fn>) =>
    (...args: unknown[]) =>
      (spy.getMockImplementation() as (...a: unknown[]) => unknown)(...args);
  const nonTxGetListingById = vi.fn(followPersistent(getListingById));
  const nonTxGetEventById = vi.fn(followPersistent(getEventById));
  const repos = {
    resaleListings: { getById: nonTxGetListingById },
    events: {
      getById: nonTxGetEventById,
      fillTaxRateIfUnset: nonTxFillTaxRateIfUnset,
    },
    // Depth-tracked so a test can assert no processor call ran while a
    // transaction was open. A throw rolls the fake's order/listing state back,
    // like Postgres would.
    tx: vi.fn(async (fn: any) => {
      const orderSnapshot = new Map(
        [...orders].map(([id, o]) => [id, { ...o }]),
      );
      const listingSnapshot = { ...listingState };
      state.txDepth++;
      try {
        return await fn(txRepos);
      } catch (err) {
        orders.clear();
        for (const [id, o] of orderSnapshot) orders.set(id, o);
        Object.assign(listingState, listingSnapshot);
        throw err;
      } finally {
        state.txDepth--;
      }
    }),
  } as unknown as Repos;

  let piSeq = 0;
  const payments: PaymentProcessorPort = {
    createPaymentIntent: vi.fn(async () => {
      state.paymentCalls.push({
        method: "createPaymentIntent",
        inTx: state.txDepth > 0,
      });
      piSeq++;
      const id = piSeq === 1 ? "pi_test_123" : `pi_test_123_${piSeq}`;
      return { id, clientSecret: `${id}_secret_abc` };
    }),
    cancelPaymentIntent: vi.fn(async () => {
      state.paymentCalls.push({
        method: "cancelPaymentIntent",
        inTx: state.txDepth > 0,
      });
      return { canceled: true };
    }),
    retrievePaymentIntent: vi.fn(async (input: { paymentIntentId: string }) => ({
      id: input.paymentIntentId,
      status: "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
  } as unknown as PaymentProcessorPort;

  const idempotency: IdempotencyPort = {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    release: vi.fn(async () => true),
  } as unknown as IdempotencyPort;

  const clock: ClockPort = { now: () => NOW };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    deps: { repos, payments, idempotency, clock, logger },
    mocks: {
      getListingById,
      holdListing,
      getEventById,
      getTicketById,
      getTicketTypeById,
      getOrderItemById,
      getPayoutTermsById,
      listPayoutTermsLines,
      getFeePolicyById,
      createPending,
      linkPaymentIntent,
      linkPaymentIntentIfPending,
      cancelPendingOrder,
      lockHold,
      releaseHold,
      createTaxLines,
      auditLog,
      acceptancesFindCurrent,
      acceptancesCreate,
      payments,
      idempotency,
      repos,
      txEventsTaxWrite,
      nonTxFillTaxRateIfUnset,
      nonTxGetListingById,
      nonTxGetEventById,
    },
    state: { acceptanceStore, orders, listingState, tx: state },
  };
}

function validInput() {
  return {
    actorHumanId: ACTOR_ID,
    buyerHumanId: ACTOR_ID,
    listingId: LISTING_ID,
    clientKey: "ck_abcdefgh",
    termsAccepted: true as const,
    refundPolicyAccepted: true as const,
    requestIp: "203.0.113.9",
    requestUserAgent: "vitest-agent/1.0",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createResaleCheckout", () => {
  it("holds listing, creates order, and returns clientSecret on success", async () => {
    const { deps, mocks } = makeDeps();
    const refundPolicySnapshot = getCurrentRefundPolicySnapshot();

    const result = await createResaleCheckout(deps, validInput());

    // Hold was placed
    expect(mocks.holdListing).toHaveBeenCalledWith(
      LISTING_ID,
      ACTOR_ID,
      expect.any(Date),
    );

    // Order created
    expect(mocks.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        buyerHumanId: ACTOR_ID,
        source: "RESALE",
        parentOrderId: "orig-order-1",
        amountGrossCents: 5000,
        feesPlatformCents: 0,
        billingDescriptor: "LAUNCH PARTY",
        refundPolicyAckAt: NOW,
        refundPolicyAckIp: "203.0.113.9",
        checkoutIp: "203.0.113.9",
        refundPolicyVersion: refundPolicySnapshot.version,
        refundPolicyText: refundPolicySnapshot.text,
        items: [
          expect.objectContaining({
            resaleListingId: LISTING_ID,
            resaleFaceValueCents: 5000,
            // Processing grossed up over the whole charge (no tax here):
            // gross-up of 5000 at 2.9% + 30¢, owner 2026-10-14.
            resaleProcessingPassThroughCents: 181,
            resaleProcessingFeeConfigRef: "stripe-standard",
            meta: expect.objectContaining({
              resaleOriginalOrderId: "orig-order-1",
              resaleOriginalOrderItemId: "orig-item-1",
            }),
          }),
        ],
      }),
    );

    // Payment intent
    const createdOrderId = (mocks.createPending as any).mock.calls[0][0].id;
    expect((mocks.payments as any).createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 5181,
        currency: "usd",
        statementDescriptorSuffix: "LAUNCH PARTY",
        // Dashboard/exports summary — one listed ticket, singular, labelled
        // "resale", keyed by the canonical 8-hex order code.
        description: `Launch Party — 1 resale ticket · Order ${formatOrderCode(createdOrderId)}`,
      }),
    );

    // Link PI to order — through the CAS, never the unconditional link.
    expect(mocks.linkPaymentIntentIfPending).toHaveBeenCalledWith(
      createdOrderId,
      "pi_test_123",
    );
    expect(mocks.linkPaymentIntent).not.toHaveBeenCalled();

    // Audit
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        action: "resale_checkout_created",
      }),
    );

    // Output shape
    expect(result).toMatchObject({
      orderId: expect.any(String),
      clientSecret: "pi_test_123_secret_abc",
      amountGrossCents: 5000,
      buyerFeesCents: 181,
      taxAmountCents: 0,
      holdExpiresAt: expect.any(String),
    });

    // Idempotency committed
    expect(mocks.idempotency.commit).toHaveBeenCalled();
  });

  // ── Idempotency ────────────────────────────────────────────────────────

  it("returns cached result on idempotent replay", async () => {
    const { deps, mocks } = makeDeps();
    const cached = {
      payloadHash: JSON.stringify({
        listingId: LISTING_ID,
        buyerHumanId: ACTOR_ID,
      }),
      response: {
        orderId: "cached-order",
        clientSecret: "cached_secret",
        amountGrossCents: 5000,
        buyerFeesCents: 200,
        taxAmountCents: 0,
        holdExpiresAt: "2026-03-10T12:15:00.000Z",
      },
    };
    (mocks.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      cached,
    );

    const result = await createResaleCheckout(deps, validInput());
    expect(result.orderId).toBe("cached-order");
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  it("throws conflict when idempotency key reused with different payload", async () => {
    const { deps, mocks } = makeDeps();
    (mocks.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payloadHash: JSON.stringify({
        listingId: "different",
        buyerHumanId: ACTOR_ID,
      }),
      response: {},
    });

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("releases the claim (owner-checked) when the internal flow throws, never `fail`", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(null); // listing not found

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    // `fail` keeps a 15-minute `failed` record that refuses `begin`, locking
    // the buyer's retry out (idempotency-claim.ts).
    expect(mocks.idempotency.fail).not.toHaveBeenCalled();
    const ownerToken = (mocks.idempotency.begin as ReturnType<typeof vi.fn>)
      .mock.calls[0]![2];
    expect(ownerToken).toEqual(expect.any(String));
    expect(mocks.idempotency.release).toHaveBeenCalledWith(
      expect.stringContaining("resale-checkout:"),
      ownerToken,
    );
  });

  it("refuses an over-long clientKey as invalid input before any claim, transaction or Stripe call", async () => {
    const { deps, mocks } = makeDeps();
    // 129 chars: the Stripe key built from it would pass Stripe's 255 cap.
    await expect(
      createResaleCheckout(deps, { ...validInput(), clientKey: "k".repeat(129) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(mocks.repos.tx).not.toHaveBeenCalled();
    expect(mocks.payments.createPaymentIntent).not.toHaveBeenCalled();

    // The bound itself is accepted.
    await expect(
      createResaleCheckout(deps, { ...validInput(), clientKey: "k".repeat(128) }),
    ).resolves.toMatchObject({ orderId: expect.any(String) });
  });

  // ── Authorization ──────────────────────────────────────────────────────

  it("throws forbidden when buyer !== actor", async () => {
    const { deps } = makeDeps();
    const input = {
      ...validInput(),
      buyerHumanId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };

    await expect(createResaleCheckout(deps, input)).rejects.toMatchObject({ code: "BUYER_MUST_BE_ACTOR" });
  });

  it("throws terms_required when termsAccepted is omitted", async () => {
    const { deps } = makeDeps();
    const { termsAccepted: _, ...inputWithoutTerms } = validInput();

    await expect(
      createResaleCheckout(deps, inputWithoutTerms),
    ).rejects.toMatchObject({ code: "TERMS_REQUIRED" });
  });

  it("throws refund_policy_required when refundPolicyAccepted is omitted before side effects", async () => {
    const { deps, mocks } = makeDeps();
    const {
      refundPolicyAccepted: _refundPolicyAccepted,
      ...inputWithoutRefundPolicy
    } = validInput();

    await expect(
      createResaleCheckout(deps, inputWithoutRefundPolicy),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(mocks.idempotency.get).not.toHaveBeenCalled();
    expect(mocks.repos.tx).not.toHaveBeenCalled();
  });

  it("throws refund_policy_required when refundPolicyAccepted is false before side effects", async () => {
    const { deps, mocks } = makeDeps();

    await expect(
      createResaleCheckout(deps, {
        ...validInput(),
        refundPolicyAccepted: false,
      }),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(mocks.idempotency.get).not.toHaveBeenCalled();
    expect(mocks.repos.tx).not.toHaveBeenCalled();
  });

  it("throws cannot_buy_own_listing when seller is buyer", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(
      makeListing({ sellerHumanId: ACTOR_ID }),
    );

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "CANNOT_BUY_OWN_LISTING" });
  });

  // ── Listing state ─────────────────────────────────────────────────────

  it("throws listing_not_found when listing does not exist", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(null);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });

  it("throws listing_already_held when status is HELD", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(makeListing({ status: "HELD" }));

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_ALREADY_HELD" });
  });

  it("throws listing_not_active when status is SOLD", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(makeListing({ status: "SOLD" }));

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });
  });

  it("throws listing_already_held when hold() returns not ok", async () => {
    const { deps, mocks } = makeDeps();
    mocks.holdListing.mockResolvedValueOnce({ ok: false });

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_ALREADY_HELD" });
  });

  // ── Event / resale config ─────────────────────────────────────────────

  it("throws not_found when event does not exist", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValueOnce(null);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("keeps a fully snapshotted listing purchasable after the event resale terms id is removed: the listing's own terms id still resolves", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValueOnce(
      makeEvent({ resalePayoutTermsId: null }),
    );

    const result = await createResaleCheckout(deps, validInput());

    expect(result).toMatchObject({
      amountGrossCents: 5000,
      buyerFeesCents: 181,
    });
    // Finalize resolves the same id (listing's, else event's) to split.
    expect(mocks.listPayoutTermsLines).toHaveBeenCalledWith(TERMS_ID);
    // Only the fee policy the listing froze, read by its id for the rate.
    expect(mocks.getFeePolicyById).toHaveBeenCalledTimes(1);
    expect(mocks.getFeePolicyById).toHaveBeenCalledWith("stripe-standard");
  });

  it("refuses (FEE_POLICY_NOT_FOUND) when the fee policy the listing froze is gone: no rate to solve processing with, so no order or charge", async () => {
    // Checkout grosses processing up over the whole charge with the frozen
    // policy's rate (owner 2026-10-14). Without it the only figure left is
    // the listing's pre-tax one, and charging that absorbs the processing on
    // the tax. Fee policy rows are versioned and never deleted, so this is
    // a data defect, not a live path.
    const { deps, mocks } = makeDeps();
    mocks.getFeePolicyById.mockResolvedValueOnce(null);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
    expect(mocks.getFeePolicyById).toHaveBeenCalledWith("stripe-standard");
    expect(mocks.createPending).not.toHaveBeenCalled();
    expect(mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  // ── Price cap ─────────────────────────────────────────────────────────

  it("keeps a fully snapshotted listing purchasable after the current ticket type cap is tightened", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getTicketTypeById.mockResolvedValueOnce(
      makeTicketType({ resaleCapCents: 3000 }), // cap < 5000 ask
    );

    const result = await createResaleCheckout(deps, validInput());

    expect(result).toMatchObject({
      amountGrossCents: 5000,
      buyerFeesCents: 181,
    });
    // Only the fee policy the listing froze, read by its id for the rate.
    expect(mocks.getFeePolicyById).toHaveBeenCalledTimes(1);
    expect(mocks.getFeePolicyById).toHaveBeenCalledWith("stripe-standard");
  });

  // ── A listing priced under the removed markup split ───────────────────
  //
  // organiser-resale-share FR-014 removed the markup split, columns and
  // all. A listing without a share was priced under it and cannot be priced
  // on terms its seller saw: refused before any hold or charge.
  // `cancelLegacyResaleListings` cancels such listings with a notice to list
  // again (FR-015).

  it("refuses a listing priced under the removed markup split (no share), before the hold", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(makeLegacyListing());

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: expect.objectContaining({
        reason: "listing_predates_resale_share",
      }),
    });
    expect(mocks.holdListing).not.toHaveBeenCalled();
    expect(mocks.createPending).not.toHaveBeenCalled();
    expect(mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    // No fee policy is read: AGREEMENT_MISSING_FEE_POLICY no longer refuses
    // a resale (FR-013).
    expect(mocks.getFeePolicyById).not.toHaveBeenCalled();
  });

  describe("FR-001 historical face value", () => {

    it("pricing never reads the OrderItem when the listing snapshot is complete", async () => {
      const { deps, mocks } = makeDeps({ purchasedUnitPriceCents: 1200 });

      await createResaleCheckout(deps, validInput());

      // Complete snapshot → the frozen listing numbers are authoritative.
      // Pricing never read it. The two reads are the FR-003 record copy
      // (organiser-resale-share), which feeds no price, and the link's refund
      // re-check under `lockHold` after the order committed.
      expect(mocks.getOrderItemById).toHaveBeenCalledTimes(2);
      expect(mocks.getOrderItemById.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.createPending.mock.invocationCallOrder[0]!,
      );
      expect(mocks.getOrderItemById.mock.invocationCallOrder[1]!).toBeGreaterThan(
        mocks.lockHold.mock.invocationCallOrder[0]!,
      );
      expect(mocks.createPending).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ resaleFaceValueCents: 5000 })],
        }),
      );
    });
  });

  // ── Tax computation ───────────────────────────────────────────────────

  it("includes tax when event has admissionTaxRateBps > 0", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValueOnce(
      makeEvent({ admissionTaxRateBps: 1000 }), // 10%
    );

    const result = await createResaleCheckout(deps, validInput());

    // Tax should be 10% of amountGrossCents
    expect(result.taxAmountCents).toBeGreaterThan(0);
  });

  it("blocks checkout once the sale cutoff has passed", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValueOnce(
      makeListing({ saleCutoffAt: new Date("2026-03-01T19:00:00Z") }),
    );

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "SALE_CUTOFF_PASSED" });
  });

  // ── Point-of-sale defence (G1 fix round): an ACTIVE listing that can no
  // longer be sold is refused before the hold, so nobody is charged for a
  // ticket finalize would refuse to move.
  it.each(["REFUNDED", "VALID", "INVALID", "SCANNED"])(
    "refuses a listing whose ticket is %s (not LISTED), before the hold",
    async (status) => {
      const { deps, mocks } = makeDeps();
      mocks.getTicketById.mockResolvedValueOnce(makeTicket({ status }));

      await expect(
        createResaleCheckout(deps, validInput()),
      ).rejects.toMatchObject({
        code: "LISTING_NOT_ACTIVE",
        meta: expect.objectContaining({ reason: "ticket_not_listed" }),
      });
      expect(mocks.holdListing).not.toHaveBeenCalled();
    },
  );

  it("refuses a listing whose ticket row is missing", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getTicketById.mockResolvedValueOnce(null as never);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  it("refuses a listing on a CANCELLED event, before the hold", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(makeEvent({ status: "CANCELLED" }));

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({
      code: "LISTING_NOT_ACTIVE",
      meta: expect.objectContaining({ reason: "event_cancelled" }),
    });
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  it("refuses an ACTIVE listing past its expiresAt (the hourly expiry has not reached it yet)", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValue(
      makeListing({ expiresAt: new Date(NOW.getTime() - 1) }),
    );

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({
      code: "LISTING_NOT_ACTIVE",
      meta: expect.objectContaining({ reason: "listing_expired" }),
    });
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  it("an expiresAt still ahead does not refuse", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getListingById.mockResolvedValue(
      makeListing({ expiresAt: new Date(NOW.getTime() + 60_000) }),
    );

    await expect(createResaleCheckout(deps, validInput())).resolves.toMatchObject({
      clientSecret: expect.any(String),
    });
  });

  // Owner rule 2026-09-28: a past event's ticket is never sold on. The
  // listing's snapshotted cutoff (2026-04-01) is still ahead of NOW, but the
  // event was moved earlier and has already ended.
  it("blocks checkout once the event has ended, even with a later snapshotted cutoff", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValueOnce(
      makeEvent({
        startsAt: new Date("2026-03-09T19:00:00Z"),
        endsAt: new Date("2026-03-09T23:00:00Z"),
      }),
    );

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "SALE_CUTOFF_PASSED" });
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  // ── Buyer ToS + refund-policy persistence ─────────────────────────────

  it("stamps the server-side ToS version and strips any client-supplied termsVersion", async () => {
    const { deps, mocks } = makeDeps();

    await createResaleCheckout(deps, {
      ...validInput(),
      termsVersion: "client-forged-2031",
    });

    expect(mocks.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ termsVersion: CURRENT_BUYER_TERMS_VERSION }),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.terms_accepted",
        data: expect.objectContaining({
          termsVersion: CURRENT_BUYER_TERMS_VERSION,
        }),
      }),
    );
  });

  it("writes BUYER_TERMS and REFUND_POLICY GLOBAL ledger rows with ip + user agent in the checkout tx", async () => {
    const { deps, state } = makeDeps();

    await createResaleCheckout(deps, validInput());

    expect(state.acceptanceStore).toHaveLength(2);
    const byType = Object.fromEntries(
      state.acceptanceStore.map((row) => [row.documentType, row]),
    );
    expect(byType.BUYER_TERMS).toMatchObject({
      humanId: ACTOR_ID,
      documentVersion: CURRENT_BUYER_TERMS_VERSION,
      documentTextSnapshot: CURRENT_BUYER_TERMS_TEXT,
      scopeType: "GLOBAL",
      scopeId: null,
      acceptedAt: NOW,
      ipAddress: "203.0.113.9",
      userAgent: "vitest-agent/1.0",
    });
    expect(byType.REFUND_POLICY).toMatchObject({
      humanId: ACTOR_ID,
      documentVersion: CURRENT_REFUND_POLICY_VERSION,
      scopeType: "GLOBAL",
      scopeId: null,
      ipAddress: "203.0.113.9",
      userAgent: "vitest-agent/1.0",
    });
  });

  it("writes no ledger rows on idempotent replay (cache hit precedes the tx)", async () => {
    const { deps, mocks, state } = makeDeps();
    (mocks.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payloadHash: JSON.stringify({
        listingId: LISTING_ID,
        buyerHumanId: ACTOR_ID,
      }),
      response: {
        orderId: "cached-order",
        clientSecret: "cached_secret",
        amountGrossCents: 5000,
        buyerFeesCents: 200,
        taxAmountCents: 0,
        holdExpiresAt: "2026-03-10T12:15:00.000Z",
      },
    });

    await createResaleCheckout(deps, validInput());

    expect(mocks.acceptancesCreate).not.toHaveBeenCalled();
    expect(state.acceptanceStore).toHaveLength(0);
  });

  it("writes no new ledger rows on a repeat purchase by the same human at the same versions", async () => {
    const { deps, mocks, state } = makeDeps();

    await createResaleCheckout(deps, validInput());
    expect(state.acceptanceStore).toHaveLength(2);

    await createResaleCheckout(deps, {
      ...validInput(),
      clientKey: "ck_second99",
    });

    expect(mocks.createPending).toHaveBeenCalledTimes(2);
    expect(mocks.acceptancesCreate).toHaveBeenCalledTimes(2);
    expect(state.acceptanceStore).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jurisdictional taxable base (lib/pricing/taxable-base.ts)
//
// A resale buyer pays the ASK plus a processing pass-through (there is no
// platform fee on this path — `feesPlatformCents: 0`), so under Tennessee's
// `BUYER_TOTAL` base the taxable amount is ask + pass-through, not the ask
// alone. Unlike the primary checkout there is NO circularity to solve: the
// pass-through is a simple markup over the basis (set at listing), so it
// does not move when the tax does.
// ─────────────────────────────────────────────────────────────────────────────
describe("createResaleCheckout — jurisdictional taxable base", () => {
  /** Inline Nashville jurisdiction — no Place / SavedLocation read needed. */
  const nashville = {
    placeId: null,
    savedLocationId: null,
    postalCode: "37203",
    countryCode: "US",
    region: "TN",
  };
  const miami = { ...nashville, postalCode: "33139", region: "FL" };

  const runWith = async (eventOverrides: Record<string, unknown>) => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(makeEvent(eventOverrides));
    const result = await createResaleCheckout(deps, validInput());
    const pending = mocks.createPending.mock.calls.at(-1)![0] as {
      amountGrossCents: number;
      feesPlatformCents: number;
      taxAmountCents: number;
      items: Array<{ resaleProcessingPassThroughCents: number }>;
    };
    return { result, pending };
  };

  it("US/TN taxes ask + processing pass-through", async () => {
    const { result, pending } = await runWith({
      ...nashville,
      admissionTaxRateBps: 975,
    });

    const passThrough = pending.items[0]!.resaleProcessingPassThroughCents;
    expect(passThrough).toBeGreaterThan(0);

    const faceOnlyTax = Math.round((5000 * 975) / 10_000);
    const buyerTotalTax = Math.round(((5000 + passThrough) * 975) / 10_000);
    expect(buyerTotalTax).toBeGreaterThan(faceOnlyTax);

    expect(result.taxAmountCents).toBe(buyerTotalTax);
    expect(pending.taxAmountCents).toBe(buyerTotalTax);
    // The organiser/seller basis is untouched — tax is buyer money for the state.
    expect(pending.amountGrossCents).toBe(5000);
    expect(pending.feesPlatformCents).toBe(0);
  });

  it.each([
    ["US/FL", miami],
    ["no situs", {}],
  ])("%s taxes the ask alone — byte-identical to HEAD", async (_l, situs) => {
    const { result } = await runWith({ ...situs, admissionTaxRateBps: 975 });
    expect(result.taxAmountCents).toBe(Math.round((5000 * 975) / 10_000));
    expect(result.taxAmountCents).toBe(488);
  });

  it("a zero rate collects nothing in TN either", async () => {
    const { result } = await runWith({ ...nashville, admissionTaxRateBps: 0 });
    expect(result.taxAmountCents).toBe(0);
  });

  it("persists the SALES line for the resale order: Σ PLATFORM === taxAmountCents", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(
      makeEvent({ ...nashville, admissionTaxRateBps: 975 }),
    );
    const result = await createResaleCheckout(deps, validInput());
    const pending = mocks.createPending.mock.calls.at(-1)![0] as {
      id: string;
      taxAmountCents: number;
      items: Array<{ resaleProcessingPassThroughCents: number }>;
    };
    const passThrough = pending.items[0]!.resaleProcessingPassThroughCents;

    expect(mocks.createTaxLines).toHaveBeenCalledTimes(1);
    expect(mocks.createTaxLines).toHaveBeenCalledWith({
      orderId: pending.id,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: 975,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 5000 + passThrough,
          amountCents: result.taxAmountCents,
        },
      ],
    });
    expect(pending.taxAmountCents).toBe(result.taxAmountCents);
    // Written after the order row it hangs off.
    expect(
      mocks.createTaxLines.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(mocks.createPending.mock.invocationCallOrder[0]!);
  });

  it("a zero rate writes no tax lines", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(
      makeEvent({ ...nashville, admissionTaxRateBps: 0 }),
    );
    await createResaleCheckout(deps, validInput());
    expect(mocks.createTaxLines).not.toHaveBeenCalled();
  });
});

describe("createResaleCheckout — Minneapolis entertainment tax is NOT charged on resale", () => {
  // Owner ruling 2026-10-05: "Assume not. We will seek counsel later." The
  // SHIPPED MPLS_ENTERTAINMENT row carries `appliesToResale: false`, and this
  // path resolves tax with `sale: "RESALE"`. No tax-imposition seam here: the
  // real shipped table is in force.
  const minneapolis = {
    placeId: null,
    savedLocationId: null,
    postalCode: "55403",
    countryCode: "US",
    region: "MN",
    admissionTaxRateBps: 903,
  };

  it("at 55403: one SALES line (MN buyer-total base), no MPLS line, charge = ask + pass-through + SALES", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(makeEvent(minneapolis));
    const result = await createResaleCheckout(deps, validInput());
    const pending = mocks.createPending.mock.calls.at(-1)![0] as {
      id: string;
      taxAmountCents: number;
      items: Array<{ resaleProcessingPassThroughCents: number }>;
    };
    const passThrough = pending.items[0]!.resaleProcessingPassThroughCents;
    const salesCents = Math.round(((5000 + passThrough) * 903) / 10_000);

    expect(mocks.createTaxLines).toHaveBeenCalledTimes(1);
    expect(mocks.createTaxLines).toHaveBeenCalledWith({
      orderId: pending.id,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/MN",
          rateBps: 903,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 5000 + passThrough,
          amountCents: salesCents,
        },
      ],
    });
    expect(result.taxAmountCents).toBe(salesCents);
    expect(pending.taxAmountCents).toBe(salesCents);
    expect(mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 5000 + passThrough + salesCents,
      }),
    );
  });
});

describe("createResaleCheckout — the tax self-heal stamp is written after the commit", () => {
  // Never stamped, inline Edmonton address: the static CA map resolves 5%.
  const EVENT_VERSION = new Date("2026-03-09T08:00:00Z");
  const unstampedEvent = () =>
    makeEvent({
      admissionTaxRateBps: null,
      placeId: null,
      savedLocationId: null,
      postalCode: "T5J 3N9",
      countryCode: "CA",
      region: "AB",
      updatedAt: EVENT_VERSION,
    });

  it("regression: written on the NON-transaction repos after the commit — never on the transaction", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedEvent());
    await createResaleCheckout(deps, validInput());
    expect(mocks.txEventsTaxWrite).not.toHaveBeenCalled();
    expect(mocks.nonTxFillTaxRateIfUnset).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
      // Compare-and-set on the event row's version as the checkout read it.
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("a rolled-back checkout (the PaymentIntent refused, after tax resolved) writes no stamp", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedEvent());
    (mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("card_declined"),
    );
    await expect(createResaleCheckout(deps, validInput())).rejects.toBeTruthy();
    expect(mocks.txEventsTaxWrite).not.toHaveBeenCalled();
    expect(mocks.nonTxFillTaxRateIfUnset).not.toHaveBeenCalled();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The tax-provider lookup runs BEFORE the transaction (prepareCheckoutTax).
// It used to run inside it — a live ZipTax HTTP call (up to 5s) while the
// resale transaction held the listing lock.
// ─────────────────────────────────────────────────────────────────────────────
describe("createResaleCheckout — the tax-provider lookup is outside the transaction", () => {
  // Measured on the pre-change code (lookup inside the transaction) as
  // 5000 + 175 + 505 = 5680; re-pinned 2026-10-14 when processing moved to a
  // gross-up over the whole charge (owner: "WE DO NOT ABSORB THE 2.9%
  // PROCESSING FEE"): 5000 ask + 196 processing + 507 tax (9.75% on ask +
  // processing, TN BUYER_TOTAL base, solved jointly) = 5703.
  const PINNED_RESALE_CHARGE = {
    piAmountCents: 5703,
    taxAmountCents: 507,
    pendingTaxAmountCents: 507,
    amountGrossCents: 5000,
    buyerFeesCents: 196,
  };
  // Never stamped, inline Nashville: only the provider can price it.
  const unstampedNashville = () =>
    makeEvent({
      status: "PUBLISHED",
      admissionTaxRateBps: null,
      placeId: null,
      savedLocationId: null,
      postalCode: "37203",
      countryCode: "US",
      region: "TN",
      updatedAt: new Date("2026-03-09T08:00:00Z"),
    });

  /** Track whether the transaction callback is running. */
  const trackTx = (deps: ReturnType<typeof makeDeps>["deps"]) => {
    const state = { inTx: false };
    const original = deps.repos.tx;
    (deps.repos as unknown as { tx: unknown }).tx = async (
      fn: never,
      opts?: never,
    ) => {
      state.inTx = true;
      try {
        return await original(fn, opts);
      } finally {
        state.inTx = false;
      }
    };
    return state;
  };

  it("regression: the provider is called once, BEFORE the transaction opens — never inside it", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    const tx = trackTx(deps);
    const calledInsideTx: boolean[] = [];
    const lookupByPostalCode = vi.fn(async () => {
      calledInsideTx.push(tx.inTx);
      if (tx.inTx) throw new Error("tax provider called INSIDE the transaction");
      return { rateBps: 975, source: "ziptax" };
    });

    const result = await createResaleCheckout(
      { ...deps, taxRateLookup: { lookupByPostalCode } } as never,
      validInput(),
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(calledInsideTx).toEqual([false]);
    // And the prepared rate was the one charged (not a swallowed 0).
    expect(result.taxAmountCents).toBeGreaterThan(0);
  });

  it("parity: the charge from a provider-priced (unstamped) event is byte-identical to before the move", async () => {
    // Pinned against the pre-change code (lookup inside the transaction):
    // the same rate on the same cart must charge the same cents.
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    const result = await createResaleCheckout(
      { ...deps, taxRateLookup: { lookupByPostalCode } } as never,
      validInput(),
    );
    const pi = (
      mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { amountCents: number };
    const pending = mocks.createPending.mock.calls.at(-1)![0] as {
      amountGrossCents: number;
      taxAmountCents: number;
    };

    expect({
      piAmountCents: pi.amountCents,
      taxAmountCents: result.taxAmountCents,
      pendingTaxAmountCents: pending.taxAmountCents,
      amountGrossCents: pending.amountGrossCents,
      buyerFeesCents: result.buyerFeesCents,
    }).toEqual(PINNED_RESALE_CHARGE);
  });
});

// ── A refused resale does not pay for a tax-provider lookup ─────────────────
describe("createResaleCheckout — refused attempts make no tax-provider call", () => {
  const unstampedNashville = (extra: Record<string, unknown> = {}) =>
    makeEvent({
      status: "PUBLISHED",
      admissionTaxRateBps: null,
      placeId: null,
      savedLocationId: null,
      postalCode: "37203",
      countryCode: "US",
      region: "TN",
      updatedAt: new Date("2026-03-09T08:00:00Z"),
      ...extra,
    });
  const provider = () =>
    vi.fn(async () => ({ rateBps: 975, source: "ziptax" }));
  const run = (
    deps: ReturnType<typeof makeDeps>["deps"],
    lookupByPostalCode: ReturnType<typeof vi.fn>,
  ) =>
    createResaleCheckout(
      { ...deps, taxRateLookup: { lookupByPostalCode } } as never,
      validInput(),
    );

  it("control: an ACTIVE listing on an on-sale unstamped event calls the provider once", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    const lookup = provider();
    await run(deps, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a HELD listing is refused (LISTING_ALREADY_HELD) with NO provider call", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    mocks.getListingById.mockResolvedValue(makeListing({ status: "HELD" }));
    const lookup = provider();
    await expect(run(deps, lookup)).rejects.toMatchObject({
      code: "LISTING_ALREADY_HELD",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("the buyer's own listing is refused (CANNOT_BUY_OWN_LISTING) with NO provider call", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    const input = validInput() as { buyerHumanId: string };
    mocks.getListingById.mockResolvedValue(
      makeListing({ sellerHumanId: input.buyerHumanId }),
    );
    const lookup = provider();
    await expect(run(deps, lookup)).rejects.toMatchObject({
      code: "CANNOT_BUY_OWN_LISTING",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a listing past its sale cutoff is refused (SALE_CUTOFF_PASSED) with NO provider call", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(unstampedNashville());
    mocks.getListingById.mockResolvedValue(
      makeListing({ saleCutoffAt: new Date("2026-03-01T19:00:00Z") }),
    );
    const lookup = provider();
    await expect(run(deps, lookup)).rejects.toMatchObject({
      code: "SALE_CUTOFF_PASSED",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an ended event is refused (SALE_CUTOFF_PASSED) with NO provider call", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(
      unstampedNashville({
        startsAt: new Date("2026-03-09T19:00:00Z"),
        endsAt: new Date("2026-03-09T23:00:00Z"),
      }),
    );
    const lookup = provider();
    await expect(run(deps, lookup)).rejects.toMatchObject({
      code: "SALE_CUTOFF_PASSED",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resale does not refuse on event status, so a non-PUBLISHED event is still prepared before the transaction", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getEventById.mockResolvedValue(
      unstampedNashville({ status: "DRAFT" }),
    );
    let inTx = false;
    const original = deps.repos.tx;
    (deps.repos as unknown as { tx: unknown }).tx = async (
      fn: never,
      opts?: never,
    ) => {
      inTx = true;
      try {
        return await original(fn, opts);
      } finally {
        inTx = false;
      }
    };
    const calledInsideTx: boolean[] = [];
    const lookup = vi.fn(async () => {
      calledInsideTx.push(inTx);
      return { rateBps: 975, source: "ziptax" };
    });
    const result = await run(deps, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Prepared BEFORE the transaction, not by the in-transaction fallback.
    expect(calledInsideTx).toEqual([false]);
    expect(result.taxAmountCents).toBe(507);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The PaymentIntent is created and linked AFTER the checkout transaction
// commits. It used to be created inside it: a slow Stripe call (60 s timeout,
// one retry) held the listing row lock past the 30 s transaction budget, and a
// rolled-back transaction left a live PaymentIntent with no order.
// ─────────────────────────────────────────────────────────────────────────────
describe("createResaleCheckout — no payment-processor call while a transaction is open", () => {
  type Ctx = ReturnType<typeof makeDeps>;

  /** Records each audit row's action and whether a transaction was open. */
  const trackAuditTx = (ctx: Ctx) => {
    const rows: Array<{ action: string; inTx: boolean; data: any }> = [];
    ctx.mocks.auditLog.mockImplementation((async (entry: {
      action: string;
      data: unknown;
    }) => {
      rows.push({
        action: entry.action,
        inTx: ctx.state.tx.txDepth > 0,
        data: entry.data,
      });
    }) as never);
    return rows;
  };

  const createdOrderId = (ctx: Ctx, call = 0) =>
    (ctx.mocks.createPending.mock.calls[call]![0] as { id: string }).id;
  const writtenHold = (ctx: Ctx, call = 0) => {
    const [, buyerHumanId, heldUntil] = ctx.mocks.holdListing.mock.calls[call]!;
    return { buyerHumanId, heldUntil };
  };

  it("creates the PaymentIntent after the order commits, keyed per order, and links it by CAS in a separate transaction", async () => {
    const ctx = makeDeps();
    const audit = trackAuditTx(ctx);

    const result = await createResaleCheckout(ctx.deps, validInput());

    expect(result.clientSecret).toBe("pi_test_123_secret_abc");
    // THE invariant: no processor call ran inside any transaction.
    expect(ctx.state.tx.paymentCalls).toEqual([
      { method: "createPaymentIntent", inTx: false },
    ]);

    // Order committed → PI created → PI linked (CAS) → hold re-asserted.
    const createdAt = ctx.mocks.createPending.mock.invocationCallOrder[0]!;
    const piAt = (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    const linkedAt =
      ctx.mocks.linkPaymentIntentIfPending.mock.invocationCallOrder[0]!;
    const assertedAt = ctx.mocks.lockHold.mock.invocationCallOrder[0]!;
    expect(createdAt).toBeLessThan(piAt);
    expect(piAt).toBeLessThan(linkedAt);
    expect(linkedAt).toBeLessThan(assertedAt);
    expect(ctx.mocks.linkPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.state.orders.get(result.orderId)).toEqual({
      status: "PENDING",
      stripePaymentIntentId: "pi_test_123",
    });

    // The key carries the order id: a retry that writes a new order gets a
    // new Stripe key instead of `idempotency_error`.
    const orderId = createdOrderId(ctx);
    expect(
      (ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>).mock
        .calls[0]![0],
    ).toMatchObject({
      idempotencyKey: `pi:resale-checkout:${ACTOR_ID}:ck_abcdefgh:${orderId}`,
      metadata: expect.objectContaining({ orderId, resaleListingId: LISTING_ID }),
    });

    // The hold re-asserted is exactly the one the checkout wrote.
    expect(ctx.mocks.lockHold).toHaveBeenCalledWith(
      LISTING_ID,
      writtenHold(ctx),
    );

    // Both audit rows, inside the link transaction, with the PI id.
    expect(audit.map(({ action, inTx }) => ({ action, inTx }))).toEqual([
      { action: "resale_checkout_created", inTx: true },
      { action: "order.terms_accepted", inTx: true },
    ]);
    expect(audit[0]!.data).toMatchObject({
      paymentIntentId: "pi_test_123",
      listingId: LISTING_ID,
      paymentIntentAmountCents: 5181,
    });

    // The lock must outlive the worst case (see IDEMPOTENCY_TTL_SECONDS).
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledWith(
      `resale-checkout:${ACTOR_ID}:ck_abcdefgh`,
      900,
      expect.any(String),
    );
  });

  it("a PaymentIntent failure after the commit cancels the order, puts the listing back to ACTIVE, frees the claim, and a same-key retry succeeds", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const idempotency = createFakeIdempotencyPort();
    const deps = { ...ctx.deps, idempotency };
    const audit = trackAuditTx(ctx);
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe timeout"));

    await expect(createResaleCheckout(deps, validInput())).rejects.toMatchObject(
      { code: "dependency_failed" },
    );

    const firstOrderId = createdOrderId(ctx);
    expect(ctx.state.orders.get(firstOrderId)).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    // Decision (a): straight back to ACTIVE, hold row gone.
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(ctx.mocks.releaseHold).toHaveBeenCalledWith(
      LISTING_ID,
      writtenHold(ctx),
      { now: NOW },
    );
    // No PI came back, so there is nothing to cancel.
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(audit).toEqual([
      {
        action: "pending_abandoned",
        inTx: true,
        data: expect.objectContaining({
          reason: "payment_intent_not_linked",
          paymentIntentId: null,
          cancelledHere: true,
          listingReleased: true,
          listingId: LISTING_ID,
        }),
      },
    ]);
    // Released, not `fail`ed.
    expect(idempotency.__mocks.release).toHaveBeenCalledTimes(1);
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();

    // Same client key, immediately.
    const retry = await createResaleCheckout(deps, validInput());
    const secondOrderId = createdOrderId(ctx, 1);
    expect(retry.orderId).toBe(secondOrderId);
    expect(secondOrderId).not.toBe(firstOrderId);
    expect(retry.clientSecret).toEqual(expect.stringContaining("_secret_"));
    const keys = (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls.map(([req]) => (req as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([
      `pi:resale-checkout:${ACTOR_ID}:ck_abcdefgh:${firstOrderId}`,
      `pi:resale-checkout:${ACTOR_ID}:ck_abcdefgh:${secondOrderId}`,
    ]);
    expect(ctx.state.listingState.status).toBe("HELD");
  });

  it("an order cancelled between the commit and the link gets no client secret; its PaymentIntent is cancelled and the listing released", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const audit = trackAuditTx(ctx);
    // The reaper / releaseCartHold cancels the order while Stripe runs. (This
    // fake cancel does not release the hold, as a real canceller would, so
    // the unwind's own fenced release is what frees it here.)
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      ctx.state.orders.get(createdOrderId(ctx))!.status = "CANCELLED";
      return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
    });

    await expect(
      createResaleCheckout(ctx.deps, validInput()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_test_123",
    });
    // (The scripted create above bypasses the recorder; the cancel is
    // recorded.) The cancel runs with no transaction open either.
    expect(ctx.state.tx.paymentCalls).toEqual([
      { method: "cancelPaymentIntent", inTx: false },
    ]);
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(audit.map((a) => a.action)).toEqual(["pending_abandoned"]);
    expect(audit[0]!.data).toMatchObject({
      reason: "link_lost",
      lostTo: "order_not_pending",
      paymentIntentId: "pi_test_123",
      cancelledHere: false,
      listingReleased: true,
    });
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("regression (G3): a listing cancelled with its event between the commit and the link rolls the link back and unwinds", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const audit = trackAuditTx(ctx);
    // `cancelOpenForEvent` commits while Stripe runs: listing CANCELLED, hold
    // row deleted. The order itself is still PENDING, so the link CAS wins.
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      ctx.state.listingState.status = "CANCELLED";
      ctx.state.listingState.hold = null;
      return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
    });

    await expect(
      createResaleCheckout(ctx.deps, validInput()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(ctx.mocks.linkPaymentIntentIfPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.lockHold).toHaveBeenCalledTimes(1);
    // The link rolled back with the transaction, then the unwind cancelled
    // the order: no PI is left on it.
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_test_123",
    });
    // The cancelled listing is not revived.
    expect(ctx.state.listingState).toEqual({ status: "CANCELLED", hold: null });
    expect(audit.map((a) => a.action)).toEqual(["pending_abandoned"]);
    expect(audit[0]!.data).toMatchObject({
      reason: "link_lost",
      lostTo: "listing_hold_lost",
      cancelledHere: true,
      listingReleased: false,
    });
  });

  it("a hold that expires while Stripe runs gets no client secret: the link rolls back, the PI is cancelled and the listing released", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const audit = trackAuditTx(ctx);
    let current = NOW;
    ctx.deps.clock = { now: () => current };
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      // Past the 900 s hold (or the sale cutoff it was clamped to).
      current = new Date(NOW.getTime() + 901_000);
      return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
    });

    await expect(
      createResaleCheckout(ctx.deps, validInput()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(ctx.mocks.lockHold).toHaveBeenCalledTimes(1);
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_test_123",
    });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(audit.map((a) => a.action)).toEqual(["pending_abandoned"]);
    expect(audit[0]!.data).toMatchObject({
      reason: "link_lost",
      lostTo: "listing_hold_expired",
      cancelledHere: true,
      listingReleased: true,
    });
  });

  // The adapter's `releaseHold` closes the listing CANCELLED once the pass is
  // not LISTED or its seller's item is refunded (resale-listings.ts); the
  // stateful fake here only knows ACTIVE, so these cases stand in for it.
  function releaseClosesListing(
    ctx: ReturnType<typeof makeDeps>,
    reason: "ticket_not_listed" | "original_item_refunded",
  ) {
    ctx.mocks.releaseHold.mockImplementationOnce(async () => {
      ctx.state.listingState.hold = null;
      ctx.state.listingState.status = "CANCELLED";
      return {
        released: true as const,
        listingStatus: "CANCELLED" as const,
        reason,
      } as any;
    });
  }

  it.each([
    {
      name: "the pass is voided",
      lostTo: "ticket_not_listed" as const,
      land: (ctx: ReturnType<typeof makeDeps>) =>
        ctx.mocks.getTicketById.mockImplementation(async () =>
          makeTicket({ status: "REFUNDED" }),
        ),
    },
    {
      name: "the seller's original item is refunded",
      lostTo: "original_item_refunded" as const,
      land: (ctx: ReturnType<typeof makeDeps>) =>
        ctx.mocks.getOrderItemById.mockImplementation(async () => ({
          ...makeOrderItem(5000),
          status: "refunded",
          refundedAt: NOW,
        })),
    },
  ])(
    "a refund that lands between the checkout read and the link ($name) gets no client secret: the link rolls back, the PI is cancelled and the listing closed",
    async ({ lostTo, land }) => {
      const ctx = makeDeps({ statefulListing: true });
      const audit = trackAuditTx(ctx);
      // The checkout transaction read a LISTED pass over an active item; the
      // refund reconcile commits while Stripe runs.
      (
        ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async () => {
        land(ctx);
        return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
      });
      releaseClosesListing(ctx, lostTo);

      await expect(
        createResaleCheckout(ctx.deps, validInput()),
      ).rejects.toMatchObject({
        code: "ORDER_NOT_PENDING",
        meta: { reason: lostTo },
      });

      expect(ctx.mocks.lockHold).toHaveBeenCalledTimes(1);
      // Read under the lock `lockHold` took, never before it.
      const lockedAt = ctx.mocks.lockHold.mock.invocationCallOrder[0]!;
      const reads = ctx.mocks.getTicketById.mock.invocationCallOrder;
      expect(reads.at(-1)!).toBeGreaterThan(lockedAt);
      expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
        status: "CANCELLED",
        stripePaymentIntentId: null,
      });
      expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
        paymentIntentId: "pi_test_123",
      });
      expect(ctx.mocks.releaseHold).toHaveBeenCalledWith(
        LISTING_ID,
        writtenHold(ctx),
        { now: expect.any(Date) },
      );
      expect(ctx.state.listingState).toEqual({ status: "CANCELLED", hold: null });
      expect(audit.map((a) => a.action)).toEqual(["pending_abandoned"]);
      expect(audit[0]!.data).toMatchObject({
        reason: "link_lost",
        lostTo,
        cancelledHere: true,
        listingReleased: true,
        listingReleasedTo: "CANCELLED",
        listingCloseReason: lostTo,
      });
    },
  );

  it("a hold one millisecond from expiry still links", async () => {
    const ctx = makeDeps({ statefulListing: true });
    let current = NOW;
    ctx.deps.clock = { now: () => current };
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      current = new Date(NOW.getTime() + 899_999);
      return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
    });

    await expect(
      createResaleCheckout(ctx.deps, validInput()),
    ).resolves.toMatchObject({ clientSecret: "pi_test_123_secret_abc" });
  });

  it("reports a PaymentIntent cancel that fails during the unwind, guarded, and still surfaces the original error", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      ctx.state.orders.get(createdOrderId(ctx))!.status = "CANCELLED";
      return { id: "pi_test_123", clientSecret: "pi_test_123_secret_abc" };
    });
    (
      ctx.mocks.payments.cancelPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stripe down" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "createResaleCheckout",
          step: "unwind_pi_cancel_unconfirmed",
        }),
      }),
    );
    // Someone else cancelled the order and it carries no PI (the link CAS
    // lost), so the unwind's fenced release still frees the listing.
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
  });

  it("reports a failed release transaction during the unwind, and still surfaces the original error", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn();
    (
      ctx.mocks.payments.createPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe timeout"));
    ctx.mocks.cancelPendingOrder.mockRejectedValueOnce(new Error("db blip"));

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db blip" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "createResaleCheckout",
          step: "unwindReleaseListingHold",
        }),
      }),
    );
    expect(ctx.deps.logger.error).toHaveBeenCalledWith(
      "createResaleCheckout.unwind_release_failed",
      expect.objectContaining({ orderId: createdOrderId(ctx) }),
    );
  });

  it("keeps the claim when the result cannot be stored, so a retry cannot price a second order", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const idempotency = createFakeIdempotencyPort();
    idempotency.__mocks.commit.mockRejectedValueOnce(
      new Error("store unavailable"),
    );
    const deps = { ...ctx.deps, idempotency };

    await expect(createResaleCheckout(deps, validInput())).rejects.toThrow(
      "store unavailable",
    );

    // The order is committed and linked; freeing the key would let the
    // buyer's retry run a second checkout beside it.
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "PENDING",
      stripePaymentIntentId: "pi_test_123",
    });
    expect(ctx.state.listingState.status).toBe("HELD");
    expect(idempotency.__mocks.release).not.toHaveBeenCalled();
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();
    await expect(createResaleCheckout(deps, validInput())).rejects.toMatchObject(
      { code: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
    );
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The unwind releases the listing only once the order is CANCELLED and the
// PaymentIntent is proven dead or absent from the order. A link transaction
// that COMMITTED but whose answer was lost leaves a linked, live PI; if its
// cancel is not confirmed, the order and the hold are left for the reaper.
// ─────────────────────────────────────────────────────────────────────────────
describe("createResaleCheckout — unwind after a lost link-transaction response", () => {
  type Ctx = ReturnType<typeof makeDeps>;
  const createdOrderId = (ctx: Ctx) =>
    (ctx.mocks.createPending.mock.calls[0]![0] as { id: string }).id;

  /** The 2nd transaction (the link) commits, then its response is lost. */
  const loseLinkResponse = (ctx: Ctx) => {
    const original = ctx.deps.repos.tx;
    let calls = 0;
    (ctx.deps.repos as unknown as { tx: unknown }).tx = async (
      fn: never,
      opts?: never,
    ) => {
      calls++;
      const result = await original(fn, opts);
      if (calls === 2) throw new Error("connection reset after COMMIT");
      return result;
    };
  };

  it("PI cancel throws → the order stays PENDING with its PI, the listing stays HELD, and it is reported", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn();
    loseLinkResponse(ctx);
    (
      ctx.mocks.payments.cancelPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ message: "create_resale_checkout" });

    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "PENDING",
      stripePaymentIntentId: "pi_test_123",
    });
    expect(ctx.state.listingState.status).toBe("HELD");
    expect(ctx.state.listingState.hold).not.toBeNull();
    expect(ctx.mocks.releaseHold).not.toHaveBeenCalled();
    // Only the "no PI on it" cancel was attempted.
    expect(ctx.mocks.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.cancelPendingOrder).toHaveBeenCalledWith(
      createdOrderId(ctx),
      { expectedPaymentIntentId: null },
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stripe down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "unwind_pi_cancel_unconfirmed" }),
        extra: expect.objectContaining({
          leftForReaper: true,
          listingReleased: false,
        }),
      }),
    );
    expect(ctx.deps.logger.error).toHaveBeenCalledWith(
      "createResaleCheckout.unwind_pi_cancel_unconfirmed",
      expect.objectContaining({ leftForReaper: true }),
    );
  });

  it("PI already terminal and NOT canceled (succeeded) → treated as live: nothing released", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn();
    loseLinkResponse(ctx);
    (
      ctx.mocks.payments.cancelPaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ canceled: false });
    (
      ctx.mocks.payments.retrievePaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "pi_test_123",
      status: "succeeded",
      amountReceived: 5181,
      currency: "usd",
      metadata: {},
    });

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ message: "create_resale_checkout" });

    expect(ctx.state.orders.get(createdOrderId(ctx))!.status).toBe("PENDING");
    expect(ctx.state.listingState.status).toBe("HELD");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("unconfirmed:succeeded"),
      }),
      expect.anything(),
    );
  });

  it("PI cancel confirmed → the linked order is cancelled on that exact PI and the listing released", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn();
    loseLinkResponse(ctx);

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ message: "create_resale_checkout" });

    expect(ctx.mocks.cancelPendingOrder).toHaveBeenCalledWith(
      createdOrderId(ctx),
      { expectedPaymentIntentId: "pi_test_123" },
    );
    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: "pi_test_123",
    });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("PI already canceled (read back) → counts as dead: released", async () => {
    const ctx = makeDeps({ statefulListing: true });
    loseLinkResponse(ctx);
    (
      ctx.mocks.payments.cancelPaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ canceled: false });

    await expect(createResaleCheckout(ctx.deps, validInput())).rejects.toMatchObject({ message: "create_resale_checkout" });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
  });

  it("link never committed + PI cancel throws → the order carries no PI, so it is cancelled and the listing released (and reported)", async () => {
    const ctx = makeDeps({ statefulListing: true });
    const reportError = vi.fn();
    ctx.mocks.linkPaymentIntentIfPending.mockRejectedValueOnce(
      new Error("db blip"),
    );
    (
      ctx.mocks.payments.cancelPaymentIntent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      createResaleCheckout({ ...ctx.deps, reportError }, validInput()),
    ).rejects.toMatchObject({ message: "create_resale_checkout" });

    expect(ctx.state.orders.get(createdOrderId(ctx))).toEqual({
      status: "CANCELLED",
      stripePaymentIntentId: null,
    });
    expect(ctx.state.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "unwind_pi_cancel_unconfirmed" }),
        extra: expect.objectContaining({ leftForReaper: false }),
      }),
    );
  });
});

// ── organiser-resale-share FR-003: the record travels down the chain ────────
// The buyer's item copies the clause and original price from the item the
// seller holds the ticket by (`Ticket.orderItemId`), never from the event's
// live clause (R2, R10 "Fixed", R15). Pricing is unchanged until B4.
describe("createResaleCheckout — FR-003 resale clause record", () => {
  const FIRST_SALE_RECORD = {
    resaleClauseType: "PERCENT" as const,
    resaleClauseBps: 1000,
    resaleClauseCents: null,
    resaleClausePayer: "SELLER" as const,
    resaleClauseTermsId: TERMS_ID,
    resaleClauseTermsVersion: 1,
    originalUnitPriceCents: 4000,
  };

  /** The event's RESALE terms after the organiser moved the clause to 5%. */
  const termsNowFivePercent = () => ({
    ...makePayoutTerms(),
    version: 2,
    resaleShareType: "PERCENT" as const,
    resaleShareBps: 500,
    resaleShareCents: null,
    resaleSharePayer: "SELLER" as const,
  });

  const buyerItem = (mocks: ReturnType<typeof makeDeps>["mocks"]) =>
    (mocks.createPending as any).mock.calls[0][0].items[0] as Record<
      string,
      unknown
    >;

  it("copies the seller item's record (original price, not the resale price), ignoring the event's changed clause", async () => {
    const { deps, mocks } = makeDeps();
    // 10% of the $50 ask, as the listing froze it from the record.
    mocks.getListingById.mockResolvedValue(
      makeListing({ eventShareCents: 500 }) as never,
    );
    mocks.getOrderItemById.mockImplementation(async () => ({
      ...makeOrderItem(4000),
      ...FIRST_SALE_RECORD,
    }));
    mocks.getPayoutTermsById.mockImplementation(async () => termsNowFivePercent());

    await createResaleCheckout(deps, validInput());

    expect(mocks.getOrderItemById).toHaveBeenCalledWith("orig-item-1");
    const item = buyerItem(mocks);
    expect(item).toMatchObject({
      // The resale price is the item's price…
      unitPriceCents: 5000,
      // …and the record is the first sale's, untouched.
      ...FIRST_SALE_RECORD,
    });
  });

  it("a 2-hop chain keeps the FIRST sale's clause and original price", async () => {
    // Hop 1: the first-sale holder resells for $50.
    const hop1 = makeDeps();
    hop1.mocks.getListingById.mockResolvedValue(
      makeListing({ eventShareCents: 500 }) as never,
    );
    hop1.mocks.getOrderItemById.mockImplementation(async () => ({
      ...makeOrderItem(4000),
      ...FIRST_SALE_RECORD,
    }));
    await createResaleCheckout(hop1.deps, validInput());
    const hop1BuyerItem = buyerItem(hop1.mocks);
    expect(hop1BuyerItem).toMatchObject(FIRST_SALE_RECORD);

    // Finalize repoints `Ticket.orderItemId` at the hop-1 buyer's item. The
    // organiser has since changed the clause to 5%; hop 2 resells for $70.
    const hop2 = makeDeps();
    hop2.mocks.getTicketById.mockResolvedValue(
      makeTicket({ orderId: "hop1-order", orderItemId: "hop1-item" }) as never,
    );
    hop2.mocks.getListingById.mockResolvedValue(
      // The FIRST sale's 10% of the $70 ask, not the event's new 5%.
      makeListing({
        askPriceCents: 7000,
        faceValueCents: 5000,
        eventShareCents: 700,
      }) as never,
    );
    hop2.mocks.getOrderItemById.mockImplementation(async () => ({
      ...hop1BuyerItem,
      id: "hop1-item",
      orderId: "hop1-order",
    }) as never);
    hop2.mocks.getPayoutTermsById.mockImplementation(async () =>
      termsNowFivePercent(),
    );

    await createResaleCheckout(hop2.deps, validInput());

    expect(hop2.mocks.getOrderItemById).toHaveBeenCalledWith("hop1-item");
    expect(buyerItem(hop2.mocks)).toMatchObject({
      unitPriceCents: 7000,
      ...FIRST_SALE_RECORD,
    });
  });
  // A seller item with no record, or recorded with no clause, cannot reach
  // a copy any more: a listing is priced from the record (FR-001 refuses a
  // listing without a clause), and checkout refuses a share listing whose
  // seller item has none (INTERNAL, pinned in the share block below).
});

// ── The organiser's resale share (organiser-resale-share spec B4) ─────────
describe("createResaleCheckout — a listing priced under the organiser's resale share", () => {
  /** The seller's purchase item: first sold at $40 under `clause`. */
  const sellerItemRecording = (clause: Record<string, unknown>) => ({
    ...makeOrderItem(4000),
    resaleClauseTermsId: "first-sale-terms",
    resaleClauseTermsVersion: 1,
    resaleClauseBps: null,
    resaleClauseCents: null,
    originalUnitPriceCents: 4000,
    ...clause,
  });
  const tenPercent = (payer: "SELLER" | "BUYER") =>
    sellerItemRecording({
      resaleClauseType: "PERCENT",
      resaleClauseBps: 1000,
      resaleClausePayer: payer,
    });
  /** What `createResaleListing` froze for a $50 ask. */
  const shareListing = (overrides: Record<string, unknown> = {}) =>
    makeListing({
      askPriceCents: 5000,
      faceValueCents: 4000,
      eventShareCents: 500,
      sharePayer: "SELLER",
      processingPassThroughCents: 175,
      processingFeeConfigRef: FEE_POLICY_ID,
      ...overrides,
    });

  const setup = (opts: {
    listing: Record<string, unknown>;
    sellerItem: Record<string, unknown> | null;
  }) => {
    const made = makeDeps();
    made.mocks.getListingById.mockResolvedValue(opts.listing as never);
    made.mocks.getOrderItemById.mockResolvedValue(opts.sellerItem as never);
    return made;
  };
  const pendingOrder = (mocks: ReturnType<typeof makeDeps>["mocks"]) =>
    mocks.createPending.mock.calls.at(-1)![0] as {
      amountGrossCents: number;
      feesPlatformCents: number;
      taxAmountCents: number;
      feePolicySnapshot: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    };

  it("a $40 ticket under a 10% SELLER clause resold at $50: the buyer pays $50 + processing; the order's basis is $50 with a $5 share", async () => {
    const { deps, mocks } = setup({
      listing: shareListing(),
      sellerItem: tenPercent("SELLER"),
    });

    const result = await createResaleCheckout(deps, validInput());

    const pending = pendingOrder(mocks);
    expect(pending.amountGrossCents).toBe(5000);
    // The platform takes nothing on a resale order (R11).
    expect(pending.feesPlatformCents).toBe(0);
    expect(pending.items[0]).toMatchObject({
      unitPriceCents: 5000,
      amountCents: 5000,
      eventShareCents: 500,
      sharePayer: "SELLER",
      resaleProcessingPassThroughCents: 181,
      // The first sale's record travels down the chain (FR-003, R15).
      resaleClauseType: "PERCENT",
      resaleClauseBps: 1000,
      resaleClausePayer: "SELLER",
      originalUnitPriceCents: 4000,
      meta: expect.objectContaining({
        resaleAskPriceCents: 5000,
        buyerTotalCents: 5181,
      }),
    });
    expect(pending.feePolicySnapshot).toMatchObject({
      feePolicyId: FEE_POLICY_ID,
      feePolicyVersion: 1,
      organiserCredit: "FULL_PRICE",
      source: "resale_listing_share",
    });
    expect(result).toMatchObject({
      amountGrossCents: 5000,
      buyerFeesCents: 181,
      taxAmountCents: 0,
    });
    expect(mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5181 }),
    );
    // The RESALE terms' row is not read (FR-013); the only fee policy read
    // is the one the listing froze, for its processor rate.
    expect(mocks.getPayoutTermsById).not.toHaveBeenCalled();
    expect(mocks.getFeePolicyById).toHaveBeenCalledTimes(1);
    expect(mocks.getFeePolicyById).toHaveBeenCalledWith(FEE_POLICY_ID);
  });

  it("a BUYER clause adds the share to what the buyer pays: basis $55 + processing + tax on the basis", async () => {
    const { deps, mocks } = setup({
      listing: shareListing({
        sharePayer: "BUYER",
        processingPassThroughCents: 190,
      }),
      sellerItem: tenPercent("BUYER"),
    });
    // 9.75% on the buyer total (US/TN): the share is taxed as part of the
    // ticket price (spec risk 2).
    mocks.getEventById.mockResolvedValue(
      makeEvent({
        placeId: null,
        savedLocationId: null,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
        admissionTaxRateBps: 975,
      }) as never,
    );

    const result = await createResaleCheckout(deps, validInput());

    const pending = pendingOrder(mocks);
    // Processing grossed up over basis + tax, tax on basis + processing,
    // solved to the fixed point: 212 processing (not the listing's pre-tax
    // 190) and round(5712 × 9.75%) = 557 tax.
    const processing = 212;
    const tax = Math.round(((5500 + processing) * 975) / 10_000);
    expect(tax).toBe(557);
    expect(pending.amountGrossCents).toBe(5500);
    expect(pending.items[0]).toMatchObject({
      unitPriceCents: 5500,
      amountCents: 5500,
      eventShareCents: 500,
      sharePayer: "BUYER",
    });
    expect(result.taxAmountCents).toBe(tax);
    expect(result.buyerFeesCents).toBe(processing);
    expect(pending.items[0]).toMatchObject({
      resaleProcessingPassThroughCents: processing,
    });
    expect(mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5500 + processing + tax }),
    );
  });

  it("refuses (INTERNAL) when the listing's share disagrees with the ticket's record: no hold, no order", async () => {
    const { deps, mocks } = setup({
      listing: shareListing({ eventShareCents: 400 }),
      sellerItem: tenPercent("SELLER"),
    });

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(mocks.holdListing).not.toHaveBeenCalled();
    expect(mocks.createPending).not.toHaveBeenCalled();
  });

  it("refuses (INTERNAL) when the seller's item carries no record although the listing priced a share", async () => {
    const { deps, mocks } = setup({
      listing: shareListing(),
      sellerItem: { ...makeOrderItem(4000) },
    });

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(mocks.createPending).not.toHaveBeenCalled();
  });

  it("refuses before charging when the RESALE terms carry no payout lines to split the share over", async () => {
    const { deps, mocks } = setup({
      listing: shareListing(),
      sellerItem: tenPercent("SELLER"),
    });
    mocks.listPayoutTermsLines.mockResolvedValue([]);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });
    expect(mocks.holdListing).not.toHaveBeenCalled();
  });

  it("refuses RESALE_NOT_ENABLED when neither the listing nor the event names RESALE terms", async () => {
    const { deps, mocks } = setup({
      listing: shareListing({ resalePayoutTermsId: null }),
      sellerItem: tenPercent("SELLER"),
    });
    mocks.getEventById.mockResolvedValue(
      makeEvent({ resalePayoutTermsId: null }) as never,
    );

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({ code: "RESALE_NOT_ENABLED" });
  });
});

describe("createResaleCheckout — a share of 0 still needs RESALE terms with payout lines", () => {
  // Finalize loads the RESALE lines for every resale order, whatever the
  // share, and refuses one with none (finalize-resale-seller-credit.test.ts,
  // "a share of 0 on RESALE terms with no lines"). Checkout refuses the same
  // listing before any hold or charge, or the buyer pays and the order
  // strands. `makeListing` is a 0% SELLER share listing.
  it("refuses AGREEMENT_MISSING_LINES before any charge", async () => {
    const { deps, mocks } = makeDeps();
    mocks.listPayoutTermsLines.mockResolvedValue([]);

    await expect(
      createResaleCheckout(deps, validInput()),
    ).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
      meta: { scope: "resale" },
    });
    expect(mocks.listPayoutTermsLines).toHaveBeenCalledWith(TERMS_ID);
    expect(mocks.holdListing).not.toHaveBeenCalled();
    expect(mocks.createPending).not.toHaveBeenCalled();
  });
});
