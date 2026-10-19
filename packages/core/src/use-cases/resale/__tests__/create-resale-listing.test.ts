import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { RESALE_LISTING_MAX_ASK_CENTS } from "../../../lib/pricing/resale-pricing";
import {
  createResaleListing,
  type CreateResaleListingDeps,
} from "../create-resale-listing";

// ── Constants ──────────────────────────────────────────────────────────────

const SELLER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LISTING_ID = "aa222222-aa22-4a22-8a22-aa2222222222";
const CLIENT_KEY = "ck_test_12345678";
const ORIGINAL_ORDER_ITEM_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
/** The order behind the ticket's purchase item (`makeOrderItem().orderId`). */
const PURCHASE_ORDER_ID = "aa444444-aa44-4a44-8a44-aa4444444444";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    eventId: EVENT_ID,
    ownerHumanId: SELLER_ID,
    status: "VALID",
    ticketTypeId: null,
    // Every ticket minted through `mintTicketsForOrder` carries the OrderItem
    // it was bought with — that snapshot is the face value (FR-001).
    orderItemId: ORIGINAL_ORDER_ITEM_ID,
    ...overrides,
  };
}

/** The buyer's purchase snapshot: `OrderItem.unitPriceCents`. */
function makeOrderItem(unitPriceCents: number) {
  return {
    id: ORIGINAL_ORDER_ITEM_ID,
    orderId: PURCHASE_ORDER_ID,
    kind: "ticket",
    ticketTypeId: null,
    qty: 1,
    unitPriceCents,
    amountCents: unitPriceCents,
    meta: {},
    status: "active",
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    startsAt: new Date("2026-04-01T19:00:00Z"),
    endsAt: new Date("2026-04-01T23:00:00Z"),
    currency: "usd",
    resalePayoutTermsId: "terms-uuid",
    resalePayoutReleaseDaysOverride: null,
    ...overrides,
  };
}

function makeDeps(opts?: {
  ticket?: any;
  event?: any;
  existingListing?: any;
  ticketType?: any;
  payoutTerms?: any;
  /** The RESALE terms' payout lines (`payoutTerms.listLines`). Default: one. */
  resaleLines?: unknown[];
  feePolicy?: any;
  payee?: any;
  idempotencyReplay?: any;
  idempotencyBeginResult?: boolean;
  /** `OrderItem.unitPriceCents` — what the seller actually paid. */
  purchasedUnitPriceCents?: number;
  /** Force `orderItems.getById` to miss (legacy / fixture ticket). */
  orderItemMissing?: boolean;
  /** The claim row on the ticket's order item (`claims.getByOrderItemId`). */
  claim?: any;
  /** A refund holds the ticket's order refund mutex (`refund-op:<orderId>`). */
  refundLockHeld?: boolean;
  /**
   * `Order.source` of the order behind the ticket's purchase item: how the
   * ticket reached its holder. Default PRIMARY (bought from the organizer).
   */
  purchaseOrderSource?: "PRIMARY" | "RESALE" | "COMP";
  /** Who bought that order. Default: the seller. */
  purchaseOrderBuyerHumanId?: string;
  /** Force `orders.getById` to miss for the purchase order (corrupt data). */
  purchaseOrderMissing?: boolean;
  /** `Order.status` of that order. Default SUCCEEDED. */
  purchaseOrderStatus?: string;
  /** Overrides on the ticket's purchase item (refund state, resale record). */
  purchaseItem?: Record<string, unknown>;
}) {
  const ticket = opts?.ticket !== undefined ? opts.ticket : makeTicket();
  const event = opts?.event !== undefined ? opts.event : makeEvent();
  const existingListing = opts?.existingListing ?? null;
  const ticketType = opts?.ticketType ?? null;
  // The event's RESALE terms carry a 10% seller-paid clause by default
  // (organiser-resale-share FR-001): a resale needs one. Their own fee
  // policy is not read: processing comes from the primary terms' (FR-013).
  const payoutTerms = opts?.payoutTerms ?? {
    id: "terms-uuid",
    version: 1,
    feePolicyId: null,
    resaleProcessingFeeConfigRef: "stripe-standard",
    resalePayoutReleaseDays: 7,
    resaleShareType: "PERCENT",
    resaleShareBps: 1000,
    resaleShareCents: null,
    resaleSharePayer: "SELLER",
  };
  const feePolicy = opts?.feePolicy ?? {
    id: "fee-policy-uuid",
    processsorFeePct: 0.029,
    processorFixedCents: 30,
  };
  // Default seller is payable: the payout batch's test (Stripe account AND
  // payouts enabled) is what a listing requires.
  const payee =
    opts?.payee !== undefined
      ? opts.payee
      : {
          id: "payee-uuid",
          stripeAccountId: "acct_seller",
          payoutsEnabled: true,
        };

  const getTicketById = vi.fn(async () => ticket);
  const getEventById = vi.fn(async () => event);
  const getByTicketId = vi.fn(async () => existingListing);
  const getTicketTypeById = vi.fn(async () => ticketType);
  const getPayoutTermsById = vi.fn(async () => payoutTerms);
  const listPayoutTermsLines = vi.fn(
    async (..._args: unknown[]) => opts?.resaleLines ?? [{ id: "line-1" }],
  );
  // The event's PRIMARY terms pin the fee policy a primary sale uses.
  const listPayoutTermsByEvent = vi.fn(async () => [
    {
      id: "primary-terms-uuid",
      kind: "PRIMARY",
      status: "ACTIVE",
      feePolicyId: "fee-policy-uuid",
    },
  ]);
  const getFeePolicyById = vi.fn(async () => feePolicy);
  const getBySubject = vi.fn(async () => (payee ? { id: payee.id } : null));
  const getPayeeById = vi.fn(async () => payee);
  const createListing = vi.fn(async (input: any) => ({
    id: LISTING_ID,
    ticketId: input.ticketId,
    eventId: input.eventId,
    sellerHumanId: input.sellerHumanId,
    askPriceCents: input.askPriceCents,
    currency: input.currency ?? "usd",
    status: "ACTIVE" as const,
    expiresAt: input.expiresAt ?? null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: input.resalePayoutTermsId ?? null,
    buyerOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const setStatus = vi.fn(async (..._args: unknown[]) => true);
  const setResaleListingId = vi.fn(async () => {});
  const auditLog = vi.fn(async () => {});
  // A ticket bought on resale holds it by an item that carries the record
  // of its first sale (copied down the chain, FR-003): 10% SELLER, original
  // $40. A first-sale item records nothing unless a test says so, like a
  // ticket sold before the record existed (FR-004 fills it at listing).
  const resaleBoughtRecord =
    opts?.purchaseOrderSource === "RESALE"
      ? {
          resaleClauseType: "PERCENT",
          resaleClauseBps: 1000,
          resaleClauseCents: null,
          resaleClausePayer: "SELLER",
          resaleClauseTermsId: "terms-uuid",
          resaleClauseTermsVersion: 1,
          originalUnitPriceCents: 4000,
        }
      : {};
  const orderItem = opts?.orderItemMissing
    ? null
    : {
        ...makeOrderItem(opts?.purchasedUnitPriceCents ?? 5000),
        ...resaleBoughtRecord,
        ...opts?.purchaseItem,
      };
  const getOrderItemById = vi.fn(async () => orderItem);
  const fillResaleClauseIfUnset = vi.fn(async () => true);
  const claimsLockOrderItem = vi.fn(async () => {});
  const claimsGetByOrderItemId = vi.fn(async () => opts?.claim ?? null);
  // The resale order behind an approved claim: the freeze holds until it
  // is REFUNDED (owner ruling 2026-10-05).
  // Also the order behind the ticket's purchase item, whose `source` decides
  // whether the listing is written onto that item (never for a ticket bought
  // on resale: its pointer stays the listing it was bought through). Any
  // other id misses unless a test scripts it.
  const ordersGetById = vi.fn(async (id?: string): Promise<unknown> =>
    id === PURCHASE_ORDER_ID && !opts?.purchaseOrderMissing
      ? {
          id: PURCHASE_ORDER_ID,
          source: opts?.purchaseOrderSource ?? "PRIMARY",
          status: opts?.purchaseOrderStatus ?? "SUCCEEDED",
          buyerHumanId: opts?.purchaseOrderBuyerHumanId ?? SELLER_ID,
        }
      : null,
  );

  const ticketsRepo = {
    getById: getTicketById,
    getTicketTypeById,
    setStatus,
  } as any;
  const orderItemsRepo = {
    setResaleListingId,
    getById: getOrderItemById,
    fillResaleClauseIfUnset,
  } as any;
  const eventsRepo = { getById: getEventById } as any;
  const listingsRepo = { getByTicketId, create: createListing } as any;
  const payoutTermsRepo = {
    getById: getPayoutTermsById,
    listByEvent: listPayoutTermsByEvent,
    listLines: listPayoutTermsLines,
  } as any;
  const resolveEffectiveFeePolicy = vi.fn(async () => feePolicy);
  const feePoliciesRepo = {
    getById: getFeePolicyById,
    resolveEffective: resolveEffectiveFeePolicy,
  } as any;
  const payeesRepo = { getBySubject, getById: getPayeeById } as any;
  const auditRepo = { log: auditLog } as any;
  const claimsRepo = {
    lockOrderItem: claimsLockOrderItem,
    getByOrderItemId: claimsGetByOrderItemId,
  } as any;

  const repos = {
    tickets: ticketsRepo,
    orderItems: orderItemsRepo,
    events: eventsRepo,
    resaleListings: listingsRepo,
    payoutTerms: payoutTermsRepo,
    feePolicies: feePoliciesRepo,
    payees: payeesRepo,
    audit: auditRepo,
    tx: vi.fn(async (fn: any) =>
      fn({
        tickets: ticketsRepo,
        orderItems: orderItemsRepo,
        events: eventsRepo,
        resaleListings: listingsRepo,
        payoutTerms: payoutTermsRepo,
        feePolicies: feePoliciesRepo,
        payees: payeesRepo,
        claims: claimsRepo,
        orders: { getById: ordersGetById },
        audit: auditRepo,
      }),
    ),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  const idempotency: IdempotencyPort = {
    get: vi.fn(async () => opts?.idempotencyReplay ?? null),
    begin: vi.fn(async (key: string) =>
      key.startsWith("refund-op:")
        ? !opts?.refundLockHeld
        : (opts?.idempotencyBeginResult ?? true),
    ),
    commit: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    release: vi.fn(async () => true),
  } as unknown as IdempotencyPort;

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    deps: {
      repos,
      idempotency,
      clock,
      logger,
    } satisfies CreateResaleListingDeps,
    mocks: {
      getTicketById,
      getEventById,
      getByTicketId,
      createListing,
      setStatus,
      setResaleListingId,
      getOrderItemById,
      fillResaleClauseIfUnset,
      listPayoutTermsByEvent,
      resolveEffectiveFeePolicy,
      auditLog,
      getPayoutTermsById,
      listPayoutTermsLines,
      getFeePolicyById,
      getBySubject,
      getPayeeById,
      idempotency,
      claimsLockOrderItem,
      claimsGetByOrderItemId,
      ordersGetById,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createResaleListing", () => {
  // Refunds restock (spec 2026-10-09): the VALID → LISTED write is a
  // compare-and-swap. A ticket revoked between the read and the write (a comp
  // revoke takes no refund mutex) is terminal and must not be listed back
  // into a place-holding status; the throw rolls the listing create back.
  it("refuses when the ticket left VALID before the LISTED write", async () => {
    const { deps, mocks } = makeDeps();
    mocks.setStatus.mockResolvedValueOnce(false);

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_ELIGIBLE_FOR_RESALE" });
    expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
      expectedStatus: "VALID",
    });
  });

  it("creates a listing and sets ticket to LISTED", async () => {
    const { deps, mocks } = makeDeps();

    const result = await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    });

    expect(result.listingId).toBe(LISTING_ID);
    expect(result.ticketId).toBe(TICKET_ID);
    expect(result.askPriceCents).toBe(5000);
    expect(result.currency).toBe("usd");

    // Ticket should be set to LISTED
    expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
      expectedStatus: "VALID",
    });
    expect(mocks.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        faceValueCents: 5000,
        // Pre-tax processing, grossed up as a primary sale's (owner
        // 2026-10-14): the charge 5181 nets 5000 after 2.9% + 30¢.
        processingPassThroughCents: 181,
        // The fee policy a primary sale uses (FR-013), not the RESALE terms'.
        processingFeeConfigRef: "fee-policy-uuid",
        eventShareCents: 500,
        sharePayer: "SELLER",
      }),
    );

    // Audit log
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "resale_listing",
        action: "created",
      }),
    );

    // Idempotency commit
    expect(mocks.idempotency.commit).toHaveBeenCalled();
  });

  it("links the originating order item when the ticket already belongs to one", async () => {
    const { deps, mocks } = makeDeps({
      ticket: makeTicket({ orderItemId: ORIGINAL_ORDER_ITEM_ID }),
    });

    await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      LISTING_ID,
    );
  });

  it("returns cached response on idempotent replay", async () => {
    const storedResponse = {
      payloadHash: JSON.stringify({
        ticketId: TICKET_ID,
        askPriceCents: 5000,
      }),
      response: {
        listingId: LISTING_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        currency: "usd",
        expiresAt: "2026-04-01T19:00:00.000Z",
      },
    };
    const { deps, mocks } = makeDeps({ idempotencyReplay: storedResponse });

    const result = await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    });

    expect(result.listingId).toBe(LISTING_ID);
    // Should NOT have gone through the full flow
    expect(mocks.createListing).not.toHaveBeenCalled();
  });

  it("throws conflict on idempotency key reuse with different payload", async () => {
    const storedResponse = {
      payloadHash: JSON.stringify({
        ticketId: TICKET_ID,
        askPriceCents: 9999, // different price
      }),
      response: {
        listingId: LISTING_ID,
        ticketId: TICKET_ID,
        askPriceCents: 9999,
        currency: "usd",
        expiresAt: "2026-04-01T19:00:00.000Z",
      },
    };
    const { deps } = makeDeps({ idempotencyReplay: storedResponse });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("throws ticket_not_found when ticket does not exist", async () => {
    const { deps } = makeDeps({ ticket: null });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "TICKET_NOT_FOUND" }));
  });

  it("throws not_ticket_owner when actor does not own the ticket", async () => {
    const { deps } = makeDeps({
      ticket: makeTicket({ ownerHumanId: "someone-else" }),
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });

  it("throws ticket_not_eligible_for_resale when ticket is not VALID", async () => {
    const { deps } = makeDeps({
      ticket: makeTicket({ status: "SCANNED" }),
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "TICKET_NOT_ELIGIBLE_FOR_RESALE" }),
    );
  });

  it("throws resale_not_enabled when event has no resalePayoutTermsId", async () => {
    const { deps } = makeDeps({
      event: makeEvent({ resalePayoutTermsId: null }),
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "RESALE_NOT_ENABLED" }));
  });

  it("throws sale_cutoff_passed when the event sale cutoff has passed", async () => {
    const { deps } = makeDeps({
      event: makeEvent({
        startsAt: new Date("2026-03-01T19:00:00Z"),
        endsAt: new Date("2026-03-01T23:00:00Z"),
      }),
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "SALE_CUTOFF_PASSED" }));
  });

  it("throws resale_price_exceeds_cap when price exceeds ticket type cap", async () => {
    const { deps } = makeDeps({
      ticket: makeTicket({ ticketTypeId: "type-uuid" }),
      ticketType: {
        id: "type-uuid",
        priceCents: 5000,
        resaleAllowed: true,
        resaleCapCents: 3000,
      },
      // Bought under the cap, so the cap is the type's own 3000. (The default
      // 5000 purchase would lift this ticket's cap to 5000.)
      purchasedUnitPriceCents: 2000,
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000, // exceeds 3000 cap
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "RESALE_PRICE_EXCEEDS_CAP" }),
    );
  });

  it("throws resale_not_allowed_for_type when ticket type disallows resale", async () => {
    const { deps } = makeDeps({
      ticket: makeTicket({ ticketTypeId: "type-uuid" }),
      ticketType: {
        id: "type-uuid",
        priceCents: 5000,
        resaleAllowed: false,
        resaleCapCents: null,
      },
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "RESALE_NOT_ALLOWED_FOR_TYPE" }),
    );
  });

  it("throws ticket_not_eligible_for_resale when ticket already has an active listing", async () => {
    const { deps } = makeDeps({
      existingListing: {
        id: "other-listing",
        status: "ACTIVE",
      },
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "TICKET_NOT_ELIGIBLE_FOR_RESALE" }),
    );
  });

  // ── Relisting: only a LIVE listing blocks a new one ────────────────────
  //
  // A ticket keeps one row per listing it ever had. `getByTicketId` returns
  // the live one if any, else the latest past one, so a past listing reaching
  // the use case must not refuse the relist (it used to pass this check and
  // then 500 on the DB's old one-row-per-ticket index).
  describe("relisting a ticket that was listed before", () => {
    const input = {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    };
    const PAST_LISTING_ID = "aa555555-aa55-4a55-8a55-aa5555555555";
    const FIRST_SELLER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const pastListings: Array<[string, Record<string, unknown>]> = [
      [
        "the seller cancelled their listing",
        { status: "CANCELLED", sellerHumanId: SELLER_ID },
      ],
      [
        "their listing expired unsold",
        { status: "EXPIRED", sellerHumanId: SELLER_ID },
      ],
    ];

    for (const [label, past] of pastListings) {
      it(`lists again after ${label}, as a NEW listing`, async () => {
        const { deps, mocks } = makeDeps({
          existingListing: { id: PAST_LISTING_ID, ticketId: TICKET_ID, ...past },
        });

        const result = await createResaleListing(deps, input);

        expect(mocks.getByTicketId).toHaveBeenCalledWith(TICKET_ID);
        // A fresh row for the actor: the past listing is neither reused nor
        // written to.
        expect(result.listingId).toBe(LISTING_ID);
        expect(result.listingId).not.toBe(PAST_LISTING_ID);
        expect(mocks.createListing).toHaveBeenCalledTimes(1);
        expect(mocks.createListing).toHaveBeenCalledWith(
          expect.objectContaining({
            ticketId: TICKET_ID,
            sellerHumanId: SELLER_ID,
            askPriceCents: 5000,
          }),
        );
        // The ticket's order item now points at the NEW listing.
        expect(mocks.setResaleListingId).toHaveBeenCalledWith(
          ORIGINAL_ORDER_ITEM_ID,
          LISTING_ID,
        );
        expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
          expectedStatus: "VALID",
        });
        expect(mocks.auditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            entity: "resale_listing",
            entityId: LISTING_ID,
            action: "created",
          }),
        );
        expect(mocks.idempotency.commit).toHaveBeenCalled();
      });
    }

    for (const status of ["ACTIVE", "HELD"]) {
      it(`still refuses while a listing is ${status}, writing nothing`, async () => {
        const { deps, mocks } = makeDeps({
          existingListing: {
            id: PAST_LISTING_ID,
            ticketId: TICKET_ID,
            status,
            sellerHumanId: SELLER_ID,
          },
        });

        await expect(createResaleListing(deps, input)).rejects.toMatchObject({
          code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
        });
        expect(mocks.createListing).not.toHaveBeenCalled();
        expect(mocks.setResaleListingId).not.toHaveBeenCalled();
        expect(mocks.setStatus).not.toHaveBeenCalled();
        expect(mocks.auditLog).not.toHaveBeenCalled();
      });
    }

    // ── A ticket bought on resale can be listed again ────────────────────
    //
    // Owner ruling 2026-10-11: reselling is infinite. Its purchase item
    // carries the SOLD listing it was bought through, and the refund unwind
    // of that sale reads the pointer, so the new listing is NOT written onto
    // the item (`setResaleListingId`): overwriting it made a refund of the
    // resale order unwind the wrong listing and fail after Stripe had paid
    // the buyer back. The rule is keyed on the purchase item's ORDER
    // (`source: "RESALE"`), so it holds for whoever holds the ticket now.
    describe("a ticket bought on resale", () => {
      const soldListing = {
        id: PAST_LISTING_ID,
        ticketId: TICKET_ID,
        status: "SOLD",
        sellerHumanId: FIRST_SELLER_ID,
        buyerOrderId: PURCHASE_ORDER_ID,
      };

      async function expectListedLeavingThePointer(
        made: ReturnType<typeof makeDeps>,
      ) {
        const { deps, mocks } = made;

        const result = await createResaleListing(deps, input);

        expect(mocks.ordersGetById).toHaveBeenCalledWith(PURCHASE_ORDER_ID);
        // A new listing of the actor's own, beside the SOLD one.
        expect(result.listingId).toBe(LISTING_ID);
        expect(mocks.createListing).toHaveBeenCalledTimes(1);
        expect(mocks.createListing).toHaveBeenCalledWith(
          expect.objectContaining({
            ticketId: TICKET_ID,
            sellerHumanId: SELLER_ID,
            askPriceCents: 5000,
          }),
        );
        // The purchased-listing pointer is left exactly as it was.
        expect(mocks.setResaleListingId).not.toHaveBeenCalled();
        // "Listed now" lives on the ticket.
        expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
          expectedStatus: "VALID",
        });
        expect(mocks.auditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            entity: "resale_listing",
            entityId: LISTING_ID,
            action: "created",
            data: expect.objectContaining({
              ticketId: TICKET_ID,
              sellerHumanId: SELLER_ID,
            }),
          }),
        );
        expect(mocks.idempotency.commit).toHaveBeenCalled();
      }

      it("lists for the resale buyer, leaving the bought-through pointer alone", async () => {
        await expectListedLeavingThePointer(
          makeDeps({
            existingListing: soldListing,
            purchaseOrderSource: "RESALE",
            // The actor (SELLER_ID) is the resale order's buyer.
            purchaseOrderBuyerHumanId: SELLER_ID,
          }),
        );
      });

      it("lists for someone the resale buyer gave the ticket to (keyed on the order, not the actor)", async () => {
        // The actor holds the ticket but did not buy the resale order.
        await expectListedLeavingThePointer(
          makeDeps({
            existingListing: soldListing,
            purchaseOrderSource: "RESALE",
            purchaseOrderBuyerHumanId: FIRST_SELLER_ID,
          }),
        );
      });

      it("leaves the pointer alone with no listing row in sight (the order decides, not the listing history)", async () => {
        await expectListedLeavingThePointer(
          makeDeps({ existingListing: null, purchaseOrderSource: "RESALE" }),
        );
      });

      for (const status of ["ACTIVE", "HELD"]) {
        it(`still refuses a resale buyer whose ticket already has a ${status} listing`, async () => {
          const { deps, mocks } = makeDeps({
            existingListing: {
              id: PAST_LISTING_ID,
              ticketId: TICKET_ID,
              status,
              sellerHumanId: SELLER_ID,
            },
            purchaseOrderSource: "RESALE",
          });

          await expect(createResaleListing(deps, input)).rejects.toMatchObject({
            code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
          });
          expect(mocks.createListing).not.toHaveBeenCalled();
          expect(mocks.setStatus).not.toHaveBeenCalled();
        });
      }

      for (const source of ["PRIMARY", "COMP"] as const) {
        it(`writes the listed-now pointer for a ticket from a ${source} order`, async () => {
          const { deps, mocks } = makeDeps({ purchaseOrderSource: source });

          const result = await createResaleListing(deps, input);

          expect(result.listingId).toBe(LISTING_ID);
          expect(mocks.createListing).toHaveBeenCalledTimes(1);
          expect(mocks.setResaleListingId).toHaveBeenCalledWith(
            ORIGINAL_ORDER_ITEM_ID,
            LISTING_ID,
          );
        });
      }

      it("refuses (ORDER_NOT_FOUND) when the purchase item's order cannot be read, writing nothing", async () => {
        const { deps, mocks } = makeDeps({ purchaseOrderMissing: true });

        await expect(createResaleListing(deps, input)).rejects.toMatchObject({
          code: "ORDER_NOT_FOUND",
        });
        expect(mocks.createListing).not.toHaveBeenCalled();
        expect(mocks.setResaleListingId).not.toHaveBeenCalled();
        expect(mocks.setStatus).not.toHaveBeenCalled();
      });
    });

    // Two relists race past the read above; the DB's one-live-listing index
    // refuses the second insert and the adapter throws this conflict.
    it("refuses the loser of a relist race with TICKET_NOT_ELIGIBLE_FOR_RESALE, not a 500", async () => {
      const { deps, mocks } = makeDeps({
        existingListing: {
          id: PAST_LISTING_ID,
          ticketId: TICKET_ID,
          status: "CANCELLED",
          sellerHumanId: SELLER_ID,
        },
      });
      mocks.createListing.mockRejectedValueOnce({
        code: "conflict",
        message: "resale_listing_live_exists",
        ticketId: TICKET_ID,
      });

      await expect(createResaleListing(deps, input)).rejects.toMatchObject({
        code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
      });
      // Nothing after the insert ran, and the key is freed for a retry.
      expect(mocks.setResaleListingId).not.toHaveBeenCalled();
      expect(mocks.setStatus).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
      expect(mocks.idempotency.commit).not.toHaveBeenCalled();
      expect(mocks.idempotency.fail).toHaveBeenCalledWith(
        `resale-listing:${SELLER_ID}:${CLIENT_KEY}`,
        expect.any(String),
      );
    });

    it("does not relabel any other create failure as a refusal", async () => {
      const { deps, mocks } = makeDeps();
      // Another adapter conflict, and a plain infrastructure error.
      mocks.createListing.mockRejectedValueOnce({
        code: "conflict",
        message: "something_else",
      });
      await expect(createResaleListing(deps, input)).rejects.not.toMatchObject({
        code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
      });

      mocks.createListing.mockRejectedValueOnce(new Error("db down"));
      await expect(createResaleListing(deps, input)).rejects.not.toMatchObject({
        code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
      });
    });
  });

  describe("seller payout eligibility", () => {
    const blocked: Array<[string, unknown]> = [
      ["has no payee record", null],
      [
        "has only the PENDING placeholder payee (no Stripe account)",
        {
          id: "payee-uuid",
          status: "PENDING",
          stripeAccountId: null,
          payoutsEnabled: false,
        },
      ],
      [
        "has a Stripe account but payouts are not enabled",
        {
          id: "payee-uuid",
          status: "ACTIVE",
          stripeAccountId: "acct_seller",
          payoutsEnabled: false,
        },
      ],
    ];

    for (const [label, payee] of blocked) {
      it(`throws SELLER_PAYOUT_NOT_SETUP when the seller ${label}, writing nothing`, async () => {
        const { deps, mocks } = makeDeps({ payee });

        await expect(
          createResaleListing(deps, {
            actorHumanId: SELLER_ID,
            ticketId: TICKET_ID,
            askPriceCents: 5000,
            clientKey: CLIENT_KEY,
          }),
        ).rejects.toEqual(
          expect.objectContaining({ code: "SELLER_PAYOUT_NOT_SETUP" }),
        );
        expect(mocks.createListing).not.toHaveBeenCalled();
        expect(mocks.setStatus).not.toHaveBeenCalled();
      });
    }

    it("lists when the seller has a Stripe account with payouts enabled", async () => {
      const { deps, mocks } = makeDeps({
        payee: {
          id: "payee-uuid",
          status: "ACTIVE",
          stripeAccountId: "acct_seller",
          payoutsEnabled: true,
        },
      });

      const result = await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      });

      expect(result.listingId).toBe(LISTING_ID);
      expect(mocks.createListing).toHaveBeenCalledTimes(1);
      // The payee checked is the ACTOR's own HUMAN payee, not any payee.
      expect(mocks.getBySubject).toHaveBeenCalledWith({
        type: "HUMAN",
        id: SELLER_ID,
      });
      expect(mocks.getPayeeById).toHaveBeenCalledWith("payee-uuid");
    });
  });

  it("defaults currency to event currency", async () => {
    const { deps, mocks } = makeDeps({
      event: makeEvent({ currency: "eur" }),
    });

    const result = await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    });

    expect(result.currency).toBe("eur");
  });

  it("persists no positive markup split on below-face listings", async () => {
    const { deps, mocks } = makeDeps({
      ticket: makeTicket({ ticketTypeId: "type-uuid" }),
      ticketType: {
        id: "type-uuid",
        priceCents: 5000,
        resaleAllowed: true,
        resaleCapCents: null,
      },
    });

    await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 4000,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        faceValueCents: 5000,
      }),
    );
  });

  it("prices the share from the ticket's clause and keeps the event payout override in the snapshot", async () => {
    const { deps, mocks } = makeDeps({
      event: makeEvent({ resalePayoutReleaseDaysOverride: 3 }),
      ticket: makeTicket({ ticketTypeId: "type-uuid" }),
      ticketType: {
        id: "type-uuid",
        priceCents: 5000,
        resaleAllowed: true,
        resaleCapCents: 9000,
      },
    });

    await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 8000,
      clientKey: CLIENT_KEY,
    });

    // 10% of the $80 ask, whatever the markup override says (the markup
    // split is replaced, FR-005); processing on the basis ($80, the seller
    // pays the share), grossed up at 2.9% + 30¢ with no tax: 270.
    expect(mocks.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        eventShareCents: 800,
        sharePayer: "SELLER",
        processingPassThroughCents: 270,
        processingFeeConfigRef: "fee-policy-uuid",
        payoutReleaseAt: new Date("2026-04-04T23:00:00Z"),
      }),
    );
  });

  it("blocks listing creation once the sale cutoff has passed", async () => {
    const { deps } = makeDeps({
      event: makeEvent({ startsAt: new Date("2026-03-01T19:00:00Z") }),
    });

    await expect(
      createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 5000,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "SALE_CUTOFF_PASSED" }));
  });

  // ── FR-001: face value is HISTORICAL, cap is POLICY ────────────────────
  //
  // Face value (what the seller paid) stays historical: it is kept on the
  // listing for display and recorded as the original price when this listing
  // fills the ticket's record (FR-004). It no longer prices anything: the
  // share is the clause's cut of the ask (organiser-resale-share FR-005).

  describe("FR-001 historical face value", () => {
    it("splits markup against the price PAID, not the raised live price", async () => {
      // Bought at $12 early-bird; organizer later raised the type to $20.
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 2000,
          resaleAllowed: true,
          resaleCapCents: null,
        },
        purchasedUnitPriceCents: 1200,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 2000,
        clientKey: CLIENT_KEY,
      });

      // Face value and the original price are what was PAID ($12), never
      // the live $20. The share is 10% of the ask either way.
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({
          faceValueCents: 1200,
          eventShareCents: 200,
          sharePayer: "SELLER",
        }),
      );
      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
        expect.objectContaining({ originalUnitPriceCents: 1200 }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            faceValueCents: 1200,
            originalUnitPriceCents: 1200,
            eventShareCents: 200,
            sellerReceivesCents: 1800,
          }),
        }),
      );
    });

    it("does not invent markup when the organizer LOWERS the live price", async () => {
      // Bought at $20; organizer has since dropped the type to $12. Reading
      // the live type would fabricate $8 of markup and take half of it from
      // a seller who is merely recovering what they paid.
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 1200,
          resaleAllowed: true,
          resaleCapCents: null,
        },
        purchasedUnitPriceCents: 2000,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 2000,
        clientKey: CLIENT_KEY,
      });

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({
          faceValueCents: 2000,
        }),
      );
    });

    it("clamps markup at zero when the ask is strictly BELOW historical face", async () => {
      // Bought at $20, listing at $15 — a loss for the seller. Markup must
      // floor at 0 (never negative), and recovery is the ask, not the face.
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 1200,
          resaleAllowed: true,
          resaleCapCents: null,
        },
        purchasedUnitPriceCents: 2000,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 1500,
        clientKey: CLIENT_KEY,
      });

      // Every resale pays the share, at or below face too (R7).
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({
          faceValueCents: 2000,
          eventShareCents: 150,
        }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sellerReceivesCents: 1350 }),
        }),
      );
    });

    it("reads face value from the OrderItem even with no ticket type", async () => {
      const { deps, mocks } = makeDeps({ purchasedUnitPriceCents: 1200 });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 2000,
        clientKey: CLIENT_KEY,
      });

      expect(mocks.getOrderItemById).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
      );
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ faceValueCents: 1200, eventShareCents: 200 }),
      );
    });

    it("treats a comp ticket as $0 face and $0 original price; the share is still 10% of the ask", async () => {
      // `issue-comp-tickets` writes unitPriceCents 0. The share does not look
      // at face: it is the clause's cut of the ask. Resale itself is still
      // gated by the type's resaleAllowed policy.
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 2000,
          resaleAllowed: true,
          resaleCapCents: null,
        },
        purchasedUnitPriceCents: 0,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 2000,
        clientKey: CLIENT_KEY,
      });

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ faceValueCents: 0, eventShareCents: 200 }),
      );
      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
        expect.objectContaining({ originalUnitPriceCents: 0 }),
      );
    });

    it("still refuses a comp ticket whose type disallows resale", async () => {
      const { deps } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 2000,
          resaleAllowed: false,
          resaleCapCents: null,
        },
        purchasedUnitPriceCents: 0,
      });

      await expect(
        createResaleListing(deps, {
          actorHumanId: SELLER_ID,
          ticketId: TICKET_ID,
          askPriceCents: 2000,
          clientKey: CLIENT_KEY,
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "RESALE_NOT_ALLOWED_FOR_TYPE" }),
      );
    });

    it("reads the type's cap as CURRENT policy; an ask under it lists whatever the face", async () => {
      // Cap 1500 is below the historical face of 2000. A 1400 ask is under
      // both, so it lists. (What happens between the two is the per-ticket
      // cap rule: "resale cap is per ticket" below.)
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 2000,
          resaleAllowed: true,
          resaleCapCents: 1500,
        },
        purchasedUnitPriceCents: 2000,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 1400,
        clientKey: CLIENT_KEY,
      });

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ faceValueCents: 2000 }),
      );
    });

    // Was "rejects an ask above the CURRENT cap even when it is under
    // historical face" (RESALE_PRICE_EXCEEDS_CAP). The owner ruled the other
    // way on 2026-10-10: a ticket's cap never falls below its own price.
    it("accepts an ask above the type's CURRENT cap when it is under historical face", async () => {
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 5000,
          resaleAllowed: true,
          resaleCapCents: 1500,
        },
        purchasedUnitPriceCents: 5000,
      });

      await createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents: 1600,
        clientKey: CLIENT_KEY,
      });

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ askPriceCents: 1600, faceValueCents: 5000 }),
      );
    });

    it("refuses to list a ticket whose OrderItem row is missing", async () => {
      const { deps, mocks } = makeDeps({ orderItemMissing: true });

      await expect(
        createResaleListing(deps, {
          actorHumanId: SELLER_ID,
          ticketId: TICKET_ID,
          askPriceCents: 5000,
          clientKey: CLIENT_KEY,
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" }),
      );
      expect(mocks.createListing).not.toHaveBeenCalled();
    });

    it("refuses to list a ticket with no orderItemId at all", async () => {
      const { deps, mocks } = makeDeps({
        ticket: makeTicket({ orderItemId: null }),
      });

      await expect(
        createResaleListing(deps, {
          actorHumanId: SELLER_ID,
          ticketId: TICKET_ID,
          askPriceCents: 5000,
          clientKey: CLIENT_KEY,
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" }),
      );
      // Never fell through to the live price.
      expect(mocks.getOrderItemById).not.toHaveBeenCalled();
      expect(mocks.createListing).not.toHaveBeenCalled();
    });
  });

  // ── Q-001 (seat-price-overrides spec): the resale cap is per ticket ────
  //
  // Owner ruling 2026-10-10: the cap is set on the ticket type, and a
  // ticket's cap never falls below what that ticket itself was priced at
  // (its OrderItem.unitPriceCents). The rule lives in
  // `effectiveResaleCapCents`; these pin that the listing gate uses it.
  describe("resale cap is per ticket (owner ruling 2026-10-10)", () => {
    /** A $30 ticket type; `resaleCapCents` is the organizer's cap on it. */
    function depsFor(opts: {
      resaleCapCents: number | null;
      purchasedUnitPriceCents?: number;
      orderItemMissing?: boolean;
    }) {
      return makeDeps({
        ticket: makeTicket({ ticketTypeId: "type-uuid" }),
        ticketType: {
          id: "type-uuid",
          priceCents: 3000,
          resaleAllowed: true,
          resaleCapCents: opts.resaleCapCents,
        },
        purchasedUnitPriceCents: opts.purchasedUnitPriceCents,
        orderItemMissing: opts.orderItemMissing,
      });
    }

    function list(
      deps: ReturnType<typeof makeDeps>["deps"],
      askPriceCents: number,
    ) {
      return createResaleListing(deps, {
        actorHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        askPriceCents,
        clientKey: CLIENT_KEY,
      });
    }

    async function expectListed(
      opts: Parameters<typeof depsFor>[0],
      askPriceCents: number,
    ) {
      const { deps, mocks } = depsFor(opts);
      await list(deps, askPriceCents);
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ askPriceCents }),
      );
      expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
        expectedStatus: "VALID",
      });
    }

    async function expectRefusedOverCap(
      opts: Parameters<typeof depsFor>[0],
      askPriceCents: number,
    ) {
      const { deps, mocks } = depsFor(opts);
      await expect(list(deps, askPriceCents)).rejects.toEqual(
        expect.objectContaining({ code: "RESALE_PRICE_EXCEEDS_CAP" }),
      );
      expect(mocks.createListing).not.toHaveBeenCalled();
      expect(mocks.setStatus).not.toHaveBeenCalled();
    }

    // A seat with a $50 seat price override, sold through the $30 type whose
    // cap is $35.
    const overriddenSeat = { resaleCapCents: 3500, purchasedUnitPriceCents: 5000 };
    // A ticket bought at the type's own $30.
    const plainTicket = { resaleCapCents: 3500, purchasedUnitPriceCents: 3000 };

    it("lists a $50 seat on a $30 type capped at $35 for its own $50", async () => {
      await expectListed(overriddenSeat, 5000);
    });

    it("refuses that seat one cent above its own price", async () => {
      await expectRefusedOverCap(overriddenSeat, 5001);
    });

    it("still caps a plain $30 ticket at the type's $35", async () => {
      await expectListed(plainTicket, 3500);
      await expectRefusedOverCap(plainTicket, 3501);
    });

    it("has no ceiling when the type has no cap", async () => {
      await expectListed(
        { resaleCapCents: null, purchasedUnitPriceCents: 3000 },
        50000,
      );
    });

    it("uses the type's cap when it is above the ticket's own price", async () => {
      const opts = { resaleCapCents: 6000, purchasedUnitPriceCents: 5000 };
      await expectListed(opts, 6000);
      await expectRefusedOverCap(opts, 6001);
    });

    it("leaves a comp ticket ($0 own price) on the type's cap", async () => {
      const comp = { resaleCapCents: 3500, purchasedUnitPriceCents: 0 };
      await expectListed(comp, 3500);
      await expectRefusedOverCap(comp, 3501);
    });

    it("takes a ticket's own price from the item it points at now, not from an earlier sale", async () => {
      // The cap rule for a $50 seat resold once for $45: `reassignForResale`
      // points the ticket at the resale buyer's item, whose unitPriceCents
      // is that $45 ask, so its ceiling is $45: not the first sale's $50,
      // not the type's $35. (The type's cap itself cannot move once the
      // event has a sale: TICKET_TYPE_LOCKED_BY_SALES.)
      //
      // The RULE is what this pins, on the fixture's default PRIMARY order.
      // The flow it describes is refused today before the cap is weighed: a
      // ticket bought on resale cannot be listed ("a ticket bought on
      // resale", above). It applies again once that refusal is lifted.
      const secondHand = { resaleCapCents: 3500, purchasedUnitPriceCents: 4500 };
      await expectListed(secondHand, 4500);
      await expectRefusedOverCap(secondHand, 4501);
    });

    it("refuses a ticket whose own price is unknown before the cap is weighed", async () => {
      // No OrderItem: there is no own price to lift the cap with. The listing
      // is refused outright, for an ask over the type's cap and under it.
      for (const askPriceCents of [3000, 9000]) {
        const { deps, mocks } = depsFor({
          resaleCapCents: 3500,
          orderItemMissing: true,
        });
        await expect(list(deps, askPriceCents)).rejects.toEqual(
          expect.objectContaining({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" }),
        );
        expect(mocks.createListing).not.toHaveBeenCalled();
      }
    });
  });

  it("calls idempotency.fail on error", async () => {
    const { deps, mocks } = makeDeps({ ticket: null });

    await createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents: 5000,
      clientKey: CLIENT_KEY,
    }).catch(() => {});

    expect(mocks.idempotency.fail).toHaveBeenCalled();
  });
});

// ── Owner ruling 2026-10-04: "transfers should be frozen" ─────────────────
// No relisting a ticket whose order item carries an unresolved resale claim:
// the claimant would sell on a ticket a full_refund approval later takes back.
describe("createResaleListing — frozen while a resale claim is unresolved", () => {
  const input = {
    actorHumanId: SELLER_ID,
    ticketId: TICKET_ID,
    askPriceCents: 5000,
    clientKey: CLIENT_KEY,
  };

  // A resale claim only ever sits on a RESALE order's item (`createClaim`
  // accepts no other order), so the claimed item is the ticket's purchase
  // item and the claim's order is its purchase order.
  function claimWithStatus(status: string) {
    return {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      orderItemId: ORIGINAL_ORDER_ITEM_ID,
      orderId: PURCHASE_ORDER_ID,
      status,
    };
  }

  for (const status of ["open", "under_review"]) {
    it(`refuses while the claim is ${status}, writing nothing`, async () => {
      const { deps, mocks } = makeDeps({
        claim: claimWithStatus(status),
        purchaseOrderSource: "RESALE",
      });

      await expect(createResaleListing(deps, input)).rejects.toMatchObject({
        code: "TICKET_UNDER_CLAIM",
      });

      expect(mocks.claimsLockOrderItem).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
      );
      expect(mocks.createListing).not.toHaveBeenCalled();
      expect(mocks.setResaleListingId).not.toHaveBeenCalled();
      expect(mocks.setStatus).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
      // The refusal frees the idempotency key so a retry after the claim
      // closes is not locked out.
      expect(mocks.idempotency.fail).toHaveBeenCalledWith(
        `resale-listing:${SELLER_ID}:${CLIENT_KEY}`,
        expect.any(String),
      );
    });
  }

  // With the claim settled the resale buyer can list the ticket again
  // (owner ruling 2026-10-11), and the claimed item keeps the pointer to the
  // listing it was bought through.
  for (const status of ["denied", "expired"]) {
    it(`lists once the claim is ${status}, leaving the bought-through pointer alone`, async () => {
      const { deps, mocks } = makeDeps({
        claim: claimWithStatus(status),
        purchaseOrderSource: "RESALE",
      });

      const result = await createResaleListing(deps, input);

      expect(result.listingId).toBe(LISTING_ID);
      expect(mocks.createListing).toHaveBeenCalledTimes(1);
      expect(mocks.setResaleListingId).not.toHaveBeenCalled();
      expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
        expectedStatus: "VALID",
      });
    });
  }

  // Owner ruling 2026-10-05: approval commits before its refund lands, and a
  // pending refund or a retry still unwinds the ticket, so an approved claim
  // keeps the freeze until the resale order is REFUNDED.
  it("refuses while the claim is approved and its refund has not landed", async () => {
    const { deps, mocks } = makeDeps({
      claim: claimWithStatus("approved"),
      purchaseOrderSource: "RESALE",
      purchaseOrderStatus: "SUCCEEDED",
    });

    await expect(createResaleListing(deps, input)).rejects.toMatchObject({
      code: "TICKET_UNDER_CLAIM",
    });
    expect(mocks.createListing).not.toHaveBeenCalled();
    expect(mocks.setResaleListingId).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.ordersGetById).toHaveBeenCalledWith(PURCHASE_ORDER_ID);
  });

  // The freeze ends when the order is REFUNDED, and the refund normally
  // sends the ticket back to the seller. A ticket STILL on the refunded item
  // is not listed either: its holder has their money back (the
  // refunded-purchase guard below, not the claim freeze, refuses it).
  it("does not list once the approved claim's order is REFUNDED: the claim freeze is over, the refunded purchase refuses", async () => {
    const { deps, mocks } = makeDeps({
      claim: claimWithStatus("approved"),
      purchaseOrderSource: "RESALE",
      purchaseOrderStatus: "REFUNDED",
    });

    await expect(createResaleListing(deps, input)).rejects.toMatchObject({
      code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
      meta: expect.objectContaining({ reason: "purchase_refunded" }),
    });
    expect(mocks.createListing).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  // ── A ticket whose purchase was refunded is not listed ─────────────────
  //
  // Reached when a refund hands a ticket BACK to a resale buyer who was
  // already refunded (A → B → C: B refunded after C bought, then C refunded;
  // the ticket returns to B as VALID on an `active` item), once B's order has
  // been marked REFUNDED. The webhook sends B's refund to manual review and
  // writes nothing, so until a person marks the order this guard cannot see
  // it. B has the money back; a listing would pay them a second time.
  describe("a ticket whose purchase was refunded", () => {
    const expectRefused = async (made: ReturnType<typeof makeDeps>) => {
      const { deps, mocks } = made;
      await expect(createResaleListing(deps, input)).rejects.toMatchObject({
        code: "TICKET_NOT_ELIGIBLE_FOR_RESALE",
        meta: expect.objectContaining({
          reason: "purchase_refunded",
          ticketId: TICKET_ID,
        }),
      });
      expect(mocks.createListing).not.toHaveBeenCalled();
      expect(mocks.setResaleListingId).not.toHaveBeenCalled();
      expect(mocks.setStatus).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
    };

    // A RESALE order has one ticket item, so its status speaks for the item.
    it("refuses when the RESALE purchase order is REFUNDED, even with the item back to active", async () => {
      await expectRefused(
        makeDeps({
          purchaseOrderSource: "RESALE",
          purchaseOrderStatus: "REFUNDED",
          purchaseItem: { status: "active", refundedAt: null },
        }),
      );
    });

    // A REFUNDED order of any other source says nothing about ONE of its
    // tickets: `refundFullOrder` marks the order REFUNDED when every ticket
    // item is refunded OR transferred, and a transferred item is not paid
    // back.
    const expectListed = async (made: ReturnType<typeof makeDeps>) => {
      const { deps, mocks } = made;
      const result = await createResaleListing(deps, input);
      expect(result.listingId).toBe(LISTING_ID);
      expect(mocks.createListing).toHaveBeenCalledTimes(1);
      expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
        expectedStatus: "VALID",
      });
    };

    for (const source of ["PRIMARY", "COMP"] as const) {
      // A buys two tickets and gifts one to F (item `transferred`, the
      // ticket stays on A's item). A refunds the order: the other item is
      // refunded and the order goes REFUNDED. Nobody was refunded for F's.
      it(`lists a gifted ticket (item transferred) on a REFUNDED ${source} order`, async () => {
        await expectListed(
          makeDeps({
            purchaseOrderSource: source,
            purchaseOrderStatus: "REFUNDED",
            // Bought by someone else: the actor was given the ticket.
            purchaseOrderBuyerHumanId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
            purchaseItem: { status: "transferred", refundedAt: null },
          }),
        );
      });

      // A sold one of two tickets to B and refunded the other (order
      // REFUNDED). B's purchase is refunded and the unwind hands the ticket
      // back to A with the item set to `active`. A was never refunded for it.
      it(`lists a ticket returned to its seller (item active) on a REFUNDED ${source} order`, async () => {
        await expectListed(
          makeDeps({
            purchaseOrderSource: source,
            purchaseOrderStatus: "REFUNDED",
            purchaseItem: { status: "active", refundedAt: null },
          }),
        );
      });

      it(`still refuses a refunded item on a REFUNDED ${source} order`, async () => {
        await expectRefused(
          makeDeps({
            purchaseOrderSource: source,
            purchaseOrderStatus: "REFUNDED",
            purchaseItem: { status: "refunded", refundedAt: new Date() },
          }),
        );
      });
    }

    it("refuses when the purchase item is refunded on an order that is not (a part refund)", async () => {
      await expectRefused(
        makeDeps({
          purchaseOrderSource: "RESALE",
          purchaseOrderStatus: "PART_REFUNDED",
          purchaseItem: { status: "refunded", refundedAt: new Date() },
        }),
      );
    });

    it("refuses on the item's refund stamp alone", async () => {
      await expectRefused(
        makeDeps({ purchaseItem: { refundedAt: new Date() } }),
      );
    });

    // The seller whose ticket came BACK from an unwind of their sale: their
    // own order was never refunded and the unwind set their item `active`.
    for (const status of ["SUCCEEDED", "PART_REFUNDED"]) {
      it(`still lists for a holder whose purchase order is ${status} with the item active`, async () => {
        const { deps, mocks } = makeDeps({
          purchaseOrderSource: "RESALE",
          purchaseOrderStatus: status,
          purchaseItem: { status: "active", refundedAt: null },
        });

        const result = await createResaleListing(deps, input);

        expect(result.listingId).toBe(LISTING_ID);
        expect(mocks.createListing).toHaveBeenCalledTimes(1);
      });
    }
  });

  it("takes the claim lock before reading the claim and before any write", async () => {
    const { deps, mocks } = makeDeps();

    await createResaleListing(deps, input);

    const lockAt = mocks.claimsLockOrderItem.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      mocks.claimsGetByOrderItemId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(mocks.createListing.mock.invocationCallOrder[0]!);
    expect(lockAt).toBeLessThan(
      mocks.setResaleListingId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(mocks.setStatus.mock.invocationCallOrder[0]!);
  });
});

// Owner ruling 2026-10-05: "when the refund is in process nothing can happen
// to the ticket". Relisting holds the refund paths' own per-order mutex.
describe("createResaleListing — locked out while a refund is in flight", () => {
  const ORDER_ID = makeOrderItem(5000).orderId;
  const REFUND_KEY = `refund-op:${ORDER_ID}`;
  const SITE_KEY = `resale-listing:${SELLER_ID}:${CLIENT_KEY}`;
  const input = {
    actorHumanId: SELLER_ID,
    ticketId: TICKET_ID,
    askPriceCents: 5000,
    clientKey: CLIENT_KEY,
  };

  it("holds refund-op:<the ticket's order> after the site claim and frees it after the tx commits", async () => {
    const { deps, mocks } = makeDeps();

    await createResaleListing(deps, input);

    const begin = vi.mocked(mocks.idempotency.begin);
    expect(mocks.getOrderItemById).toHaveBeenCalledWith(ORIGINAL_ORDER_ITEM_ID);
    expect(begin).toHaveBeenCalledWith(REFUND_KEY, 60, expect.any(String));
    const siteIdx = begin.mock.calls.findIndex(([k]) => k === SITE_KEY);
    const refundIdx = begin.mock.calls.findIndex(([k]) => k === REFUND_KEY);
    expect(begin.mock.invocationCallOrder[siteIdx]!).toBeLessThan(
      begin.mock.invocationCallOrder[refundIdx]!,
    );
    const release = vi.mocked(mocks.idempotency.release);
    expect(release).toHaveBeenCalledWith(
      REFUND_KEY,
      begin.mock.calls[refundIdx]![2],
    );
    expect(release.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.createListing.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses with TICKET_REFUND_IN_PROGRESS while a refund holds the order, writes nothing", async () => {
    const { deps, mocks } = makeDeps({ refundLockHeld: true });

    await expect(createResaleListing(deps, input)).rejects.toMatchObject({
      code: "TICKET_REFUND_IN_PROGRESS",
    });

    expect(mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(mocks.createListing).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.setResaleListingId).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
    // Same site-key handling as TICKET_UNDER_CLAIM.
    expect(mocks.idempotency.fail).toHaveBeenCalledWith(
      SITE_KEY,
      expect.any(String),
    );
    // Never frees the refund's lock.
    expect(mocks.idempotency.release).not.toHaveBeenCalled();
  });

  it("tells a caller who does not own the ticket NOT_RESOURCE_OWNER, not that a refund is running", async () => {
    const { deps, mocks } = makeDeps({ refundLockHeld: true });

    await expect(
      createResaleListing(deps, {
        ...input,
        actorHumanId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // Review round 1: a non-holder never touches the order's mutex.
    expect(
      vi
        .mocked(mocks.idempotency.begin)
        .mock.calls.filter(([k]) => String(k).startsWith("refund-op:")),
    ).toHaveLength(0);
  });

  it("frees the lock when the move fails", async () => {
    const { deps, mocks } = makeDeps();
    mocks.createListing.mockRejectedValueOnce(new Error("db down"));

    await expect(createResaleListing(deps, input)).rejects.toThrow();

    expect(mocks.idempotency.release).toHaveBeenCalledWith(
      REFUND_KEY,
      expect.any(String),
    );
  });

  it("refuses when the ticket moved to another order item after the lock was picked", async () => {
    const { deps, mocks } = makeDeps();
    mocks.getTicketById.mockResolvedValueOnce(
      makeTicket({ orderItemId: "bb999999-bb99-4b99-8b99-bb9999999999" }),
    );

    await expect(createResaleListing(deps, input)).rejects.toMatchObject({
      code: "TICKET_REFUND_IN_PROGRESS",
    });
    expect(mocks.createListing).not.toHaveBeenCalled();
  });

  it("takes no refund lock for a ticket with no order item", async () => {
    const { deps, mocks } = makeDeps({
      ticket: makeTicket({ orderItemId: null }),
    });

    await createResaleListing(deps, input).catch(() => undefined);

    expect(
      vi
        .mocked(mocks.idempotency.begin)
        .mock.calls.filter(([k]) => String(k).startsWith("refund-op:")),
    ).toHaveLength(0);
  });
});

// ── The organiser's resale share (organiser-resale-share spec) ─────────────

describe("createResaleListing — the organiser's resale share", () => {
  const list = (deps: CreateResaleListingDeps, askPriceCents: number) =>
    createResaleListing(deps, {
      actorHumanId: SELLER_ID,
      ticketId: TICKET_ID,
      askPriceCents,
      clientKey: CLIENT_KEY,
    });

  /** The FR-003 record a first sale under `clause` writes. */
  const recorded = (
    clause: Record<string, unknown>,
    originalUnitPriceCents: number,
  ) => ({
    resaleClauseTermsId: "first-sale-terms",
    resaleClauseTermsVersion: 1,
    resaleClauseBps: null,
    resaleClauseCents: null,
    ...clause,
    originalUnitPriceCents,
  });

  const typeCapped = (resaleCapCents: number | null) => ({
    ticket: makeTicket({ ticketTypeId: "type-uuid" }),
    ticketType: {
      id: "type-uuid",
      priceCents: 4000,
      resaleAllowed: true,
      resaleCapCents,
    },
  });

  describe("FR-004: a ticket sold before the record existed", () => {
    it("writes the event's clause at this moment onto its purchase item, once, and prices under it", async () => {
      const { deps, mocks } = makeDeps({ purchasedUnitPriceCents: 4000 });

      await list(deps, 5000);

      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledTimes(1);
      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
        {
          resaleClauseType: "PERCENT",
          resaleClauseBps: 1000,
          resaleClauseCents: null,
          resaleClausePayer: "SELLER",
          resaleClauseTermsId: "terms-uuid",
          resaleClauseTermsVersion: 1,
          // A first-sale item: its own price is the original (R15).
          originalUnitPriceCents: 4000,
        },
      );
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ eventShareCents: 500, sharePayer: "SELLER" }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resaleClauseFilled: true,
            sellerReceivesCents: 4500,
            basisCents: 5000,
          }),
        }),
      );
    });

    it("a concurrent listing filled it first: the record that won is used, not the event's clause", async () => {
      const { deps, mocks } = makeDeps({ purchasedUnitPriceCents: 4000 });
      mocks.fillResaleClauseIfUnset.mockResolvedValueOnce(false);
      // Reads before the write see no record; the re-read after the lost
      // write sees the winner's: a FLAT $3 the buyer pays.
      mocks.getOrderItemById.mockImplementation(async () =>
        mocks.fillResaleClauseIfUnset.mock.calls.length === 0
          ? ({ ...makeOrderItem(4000) } as never)
          : ({
              ...makeOrderItem(4000),
              ...recorded(
                {
                  resaleClauseType: "FLAT",
                  resaleClauseCents: 300,
                  resaleClausePayer: "BUYER",
                },
                4000,
              ),
            } as never),
      );

      await list(deps, 5000);

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ eventShareCents: 300, sharePayer: "BUYER" }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resaleClauseFilled: false,
            basisCents: 5300,
            sellerReceivesCents: 5000,
          }),
        }),
      );
    });

    it("refuses when the event's clause is not set (resale needs a clause, FR-001), writing nothing", async () => {
      const { deps, mocks } = makeDeps({
        payoutTerms: {
          id: "terms-uuid",
          version: 1,
          feePolicyId: null,
          resalePayoutReleaseDays: 7,
          resaleShareType: null,
          resaleShareBps: null,
          resaleShareCents: null,
          resaleSharePayer: "SELLER",
        },
      });

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "RESALE_TERMS_MISSING",
      });
      expect(mocks.fillResaleClauseIfUnset).not.toHaveBeenCalled();
      expect(mocks.createListing).not.toHaveBeenCalled();
    });

    it("a ticket bought on resale before the record existed walks back to its first sale for the original price", async () => {
      const FIRST_ITEM_ID = "aa555555-aa55-4a55-8a55-aa5555555555";
      const FIRST_ORDER_ID = "aa666666-aa66-4a66-8a66-aa6666666666";
      const { deps, mocks } = makeDeps({
        purchaseOrderSource: "RESALE",
        // Bought on resale for $60; no record (sold before it existed).
        purchasedUnitPriceCents: 6000,
        purchaseItem: {
          resaleClauseType: null,
          resaleClausePayer: null,
          resaleClauseBps: null,
          resaleClauseTermsId: null,
          resaleClauseTermsVersion: null,
          originalUnitPriceCents: null,
          meta: { resaleOriginalOrderItemId: FIRST_ITEM_ID },
        },
      });
      const purchaseItem = await mocks.getOrderItemById();
      mocks.getOrderItemById.mockImplementation(async (id?: string) =>
        id === FIRST_ITEM_ID
          ? ({ ...makeOrderItem(4000), id: FIRST_ITEM_ID, orderId: FIRST_ORDER_ID } as never)
          : (purchaseItem as never),
      );
      const purchaseOrder = await mocks.ordersGetById(PURCHASE_ORDER_ID);
      mocks.ordersGetById.mockImplementation(async (id?: string) =>
        id === FIRST_ORDER_ID
          ? { id: FIRST_ORDER_ID, source: "PRIMARY", status: "SUCCEEDED" }
          : id === PURCHASE_ORDER_ID
            ? purchaseOrder
            : null,
      );

      await list(deps, 7000);

      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
        expect.objectContaining({ originalUnitPriceCents: 4000 }),
      );
    });

    it("refuses when a resale-bought ticket's chain to its first sale is broken: the original price is unknown", async () => {
      const { deps, mocks } = makeDeps({
        purchaseOrderSource: "RESALE",
        purchasedUnitPriceCents: 6000,
        purchaseItem: {
          resaleClauseType: null,
          resaleClausePayer: null,
          resaleClauseBps: null,
          resaleClauseTermsId: null,
          resaleClauseTermsVersion: null,
          originalUnitPriceCents: null,
          meta: {},
        },
      });

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "RESALE_PURCHASE_PRICE_UNKNOWN",
        meta: expect.objectContaining({ reason: "original_price_unknown" }),
      });
      expect(mocks.fillResaleClauseIfUnset).not.toHaveBeenCalled();
    });
  });

  it("a recorded clause wins over the event's changed clause (R10): 10% at first sale, 5% now, resold at $70 → $7", async () => {
    const { deps, mocks } = makeDeps({
      purchaseOrderSource: "RESALE",
      purchasedUnitPriceCents: 5000,
      payoutTerms: {
        id: "terms-uuid",
        version: 2,
        feePolicyId: null,
        resalePayoutReleaseDays: 7,
        resaleShareType: "PERCENT",
        resaleShareBps: 500,
        resaleShareCents: null,
        resaleSharePayer: "SELLER",
      },
    });

    await list(deps, 7000);

    expect(mocks.fillResaleClauseIfUnset).not.toHaveBeenCalled();
    expect(mocks.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ eventShareCents: 700, sharePayer: "SELLER" }),
    );
  });

  it("a FLAT $8 clause on a $50 ask is held to $5 (the 10% limit), and the held amount is recorded", async () => {
    const { deps, mocks } = makeDeps({
      purchaseItem: recorded(
        { resaleClauseType: "FLAT", resaleClauseCents: 800, resaleClausePayer: "SELLER" },
        4000,
      ),
    });

    await list(deps, 5000);

    expect(mocks.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ eventShareCents: 500 }),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareHeld: true,
          heldFromCents: 800,
          sellerReceivesCents: 4500,
        }),
      }),
    );
  });

  describe("the cap (FR-002, FR-007)", () => {
    const buyerTenPercent = recorded(
      { resaleClauseType: "PERCENT", resaleClauseBps: 1000, resaleClausePayer: "BUYER" },
      4000,
    );

    it("a BUYER clause at a $40 cap refuses a $40 ask ($44 with the share) and offers $36.37", async () => {
      const { deps, mocks } = makeDeps({
        ...typeCapped(4000),
        purchaseItem: buyerTenPercent,
      });

      await expect(list(deps, 4000)).rejects.toMatchObject({
        code: "RESALE_PRICE_EXCEEDS_CAP",
        meta: expect.objectContaining({
          basisCents: 4400,
          capCents: 4000,
          sharePayer: "BUYER",
          highestFittingAskCents: 3637,
        }),
      });
      expect(mocks.createListing).not.toHaveBeenCalled();
    });

    it("the offered $36.37 lists: $36.37 + $3.63 = $40.00, processing on the $40.00 basis", async () => {
      const { deps, mocks } = makeDeps({
        ...typeCapped(4000),
        purchaseItem: buyerTenPercent,
      });

      await list(deps, 3637);

      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({
          askPriceCents: 3637,
          eventShareCents: 363,
          sharePayer: "BUYER",
          // 4000 grossed up at 2.9% + 30¢, no tax
          processingPassThroughCents: 151,
        }),
      );
    });

    it("the cap's floor is the ORIGINAL price, never the previous resale price", async () => {
      // Bought on resale at $60; first sold at $40; the type's cap is $30.
      // The floor is $40 (R15), not $60.
      const { deps, mocks } = makeDeps({
        ...typeCapped(3000),
        purchaseOrderSource: "RESALE",
        purchasedUnitPriceCents: 6000,
      });

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "RESALE_PRICE_EXCEEDS_CAP",
        meta: expect.objectContaining({
          capCents: 4000,
          highestFittingAskCents: 4000,
        }),
      });
      await list(deps, 4000);
      expect(mocks.createListing).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses an ask above the listing bound, leaving room for processing and tax in one charge", async () => {
    const { deps, mocks } = makeDeps();

    await expect(
      list(deps, RESALE_LISTING_MAX_ASK_CENTS + 1),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createListing).not.toHaveBeenCalled();
  });

  describe("the RESALE terms must carry payout lines", () => {
    it("refuses AGREEMENT_MISSING_LINES with no lines, before the ticket is listed", async () => {
      const { deps, mocks } = makeDeps({ resaleLines: [] });

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "AGREEMENT_MISSING_LINES",
      });

      expect(mocks.listPayoutTermsLines).toHaveBeenCalledWith("terms-uuid");
      expect(mocks.createListing).not.toHaveBeenCalled();
      expect(mocks.setStatus).not.toHaveBeenCalled();
      expect(mocks.idempotency.fail).toHaveBeenCalled();
    });

    it("runs the FR-004 fill inside the same tx callback that then throws AGREEMENT_MISSING_LINES", async () => {
      const { deps, mocks } = makeDeps({ resaleLines: [] });

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "AGREEMENT_MISSING_LINES",
      });

      // The fill ran inside the same tx callback that then threw.
      expect(mocks.fillResaleClauseIfUnset).toHaveBeenCalledTimes(1);
      expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    });

    it("lists when the terms carry lines", async () => {
      const { deps, mocks } = makeDeps({ resaleLines: [{ id: "line-1" }] });

      await list(deps, 5000);

      expect(mocks.createListing).toHaveBeenCalledTimes(1);
      expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "LISTED", {
        expectedStatus: "VALID",
      });
    });
  });

  describe("a dangling fee-policy pin", () => {
    const dangling = () => {
      const made = makeDeps();
      made.mocks.getFeePolicyById.mockResolvedValue(null as never);
      return made;
    };

    it("refuses FEE_POLICY_NOT_FOUND when the pin names a missing policy, with no re-resolve", async () => {
      const { deps, mocks } = dangling();

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "FEE_POLICY_NOT_FOUND",
      });
      expect(mocks.resolveEffectiveFeePolicy).not.toHaveBeenCalled();
      expect(mocks.createListing).not.toHaveBeenCalled();
    });

    it("reports the pin as a data-integrity fault", async () => {
      const { deps } = dangling();
      const reportError = vi.fn();

      await expect(
        list({ ...deps, reportError }, 5000),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            useCase: "resolveResaleFeePolicy",
            fault: "dangling_pin",
          }),
          extra: expect.objectContaining({
            eventId: EVENT_ID,
            payoutTermsId: "primary-terms-uuid",
            feePolicyId: "fee-policy-uuid",
          }),
        }),
      );
      expect(deps.logger?.error).toHaveBeenCalled();
    });

    it("a throwing reporter does not change the thrown code", async () => {
      const { deps } = dangling();
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });

      await expect(
        list({ ...deps, reportError }, 5000),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
      expect(reportError).toHaveBeenCalled();
    });
  });

  describe("processing comes from the fee policy a primary sale uses (FR-013)", () => {
    it("RESALE terms without their own fee policy no longer refuse (AGREEMENT_MISSING_FEE_POLICY is gone)", async () => {
      const { deps, mocks } = makeDeps();

      await list(deps, 5000);

      expect(mocks.getFeePolicyById).toHaveBeenCalledWith("fee-policy-uuid");
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ processingFeeConfigRef: "fee-policy-uuid" }),
      );
    });

    it("with no pin on the primary terms, walks EVENT → ORG → GLOBAL", async () => {
      const { deps, mocks } = makeDeps();
      mocks.listPayoutTermsByEvent.mockResolvedValueOnce([
        { id: "p", kind: "PRIMARY", status: "ACTIVE", feePolicyId: null },
      ]);

      await list(deps, 5000);

      expect(mocks.resolveEffectiveFeePolicy).toHaveBeenCalledWith(
        expect.objectContaining({ scopeType: "EVENT", scopeId: EVENT_ID }),
      );
      expect(mocks.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ processingPassThroughCents: 181 }),
      );
    });

    it("refuses FEE_POLICY_NOT_FOUND when no policy is in force anywhere", async () => {
      const { deps, mocks } = makeDeps();
      mocks.listPayoutTermsByEvent.mockResolvedValueOnce([]);
      mocks.resolveEffectiveFeePolicy.mockResolvedValue(null as never);

      await expect(list(deps, 5000)).rejects.toMatchObject({
        code: "FEE_POLICY_NOT_FOUND",
      });
    });
  });
});
