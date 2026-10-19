/**
 * The organiser's resale share at finalize, refund, claim and dispute
 * (organiser-resale-share spec FR-005, FR-006, FR-010, NFR-001).
 *
 * Drives the REAL chain against an in-memory world, as
 * `finalize-resale-seller-credit.test.ts` does for the markup split (which
 * now covers only orders priced before the share, still in flight at deploy):
 *   computeResaleShare (the price the listing and checkout froze)
 *     → finalizePaymentIntent (splits: seller + the share over the RESALE lines)
 *     → createCreditsFromOrder (SETTLEMENT_CREDIT rows)
 *     → writeRefundDebitsForOrder / writeExternalAmountRefundDebitsForOrder
 *       (the debit writers every refund, claim and dispute path calls).
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { solveResaleCharge } from "../../../lib/pricing/resale-charge";
import {
  computeResaleShare,
  type ResaleShareClause,
} from "../../../lib/pricing/resale-pricing";
import {
  writeExternalAmountRefundDebitsForOrder,
  writeRefundDebitsForOrder,
} from "../_shared/write-refund-debits";
import {
  finalizePaymentIntent,
  type FinalizePaymentIntentDeps,
} from "../finalize-from-payment-intent";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const RESALE_ITEM_ID = "44444444-4444-4444-8444-444444444444";
const ORIGINAL_ITEM_ID = "55555555-5555-4555-8555-555555555555";
const TICKET_ID = "66666666-6666-4666-8666-666666666666";
const SELLER_HUMAN_ID = "77777777-7777-4777-8777-777777777777";
const BUYER_HUMAN_ID = "88888888-8888-4888-8888-888888888888";

const SELLER_PAYEE_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_PAYEE_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const CREATOR_PAYEE_ID = "cccccccc-0000-4000-8000-00000000000c";
const DECOY_PAYEE_ID = "eeeeeeee-0000-4000-8000-00000000000e";

const NOW = new Date("2026-05-20T12:00:00.000Z");
const EVENT_STARTS_AT = new Date("2026-06-01T19:00:00.000Z");
const EVENT_ENDS_AT = new Date("2026-06-01T23:00:00.000Z");
const PAYOUT_RELEASE_AT = new Date("2026-06-08T23:00:00.000Z");

type Line = {
  payeeId: string;
  percent: number;
  rounding: "FLOOR" | "NEAREST";
  priority: number;
};

const ORG_100: Line[] = [
  { payeeId: ORG_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
];
/** The night's two payees: the organiser 70%, the place 30%. */
const ORG_70_PLACE_30: Line[] = [
  { payeeId: ORG_PAYEE_ID, percent: 70, rounding: "FLOOR", priority: 1 },
  { payeeId: CREATOR_PAYEE_ID, percent: 30, rounding: "NEAREST", priority: 0 },
];

const TEN_PERCENT_SELLER: ResaleShareClause = {
  type: "PERCENT",
  bps: 1000,
  payer: "SELLER",
};
const TEN_PERCENT_BUYER: ResaleShareClause = {
  type: "PERCENT",
  bps: 1000,
  payer: "BUYER",
};

function makeWorld(opts: {
  askPriceCents: number;
  clause: ResaleShareClause;
  lines?: Line[];
  sellerHasPayee?: boolean;
  listingTermsId?: string | null;
  eventTermsId?: string | null;
  missingTermsIds?: string[];
  commitResult?: { ok: boolean; ticketId?: string };
  listingBuyerOrderId?: string | null;
  metadataSource?: "resale" | "primary";
  /** Tamper with the stamped share (corrupt-row tests). */
  itemOverride?: Record<string, unknown>;
}) {
  const lines = opts.lines ?? ORG_100;
  const listingTermsId =
    opts.listingTermsId === undefined ? "terms-listing" : opts.listingTermsId;
  const eventTermsId =
    opts.eventTermsId === undefined ? "terms-event" : opts.eventTermsId;
  const linesByTerms: Record<string, Line[]> = {
    "terms-listing": lines,
    "terms-event": [
      { payeeId: CREATOR_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
    ],
    "terms-active-decoy": [
      { payeeId: DECOY_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
    ],
  };

  // ── The price, by the real function the listing and checkout use ───────
  const share = computeResaleShare({
    askCents: opts.askPriceCents,
    clause: opts.clause,
  });
  const processingCents = solveResaleCharge({
    basisCents: share.basisCents,
    taxLines: [],
    processorPct: 0.029,
    processorFixedCents: 30,
  }).processingPassThroughCents;
  const buyerUnitTotalCents = share.basisCents + processingCents;

  // Mirrors `createResaleCheckout`'s order + item for a share listing.
  const order: OrderRecord = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_HUMAN_ID,
    amountGrossCents: share.basisCents,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: { organiserCredit: "FULL_PRICE" },
    status: "PENDING",
    stripePaymentIntentId: null,
    source: "RESALE",
    occurredAt: NOW,
    parentOrderId: "99999999-9999-4999-8999-999999999999",
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    items: [
      {
        id: RESALE_ITEM_ID,
        orderId: ORDER_ID,
        kind: "ticket",
        status: "active",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: share.basisCents,
        amountCents: share.basisCents,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        resaleListingId: LISTING_ID,
        meta: {
          resaleListingId: LISTING_ID,
          resaleOriginalOrderItemId: ORIGINAL_ITEM_ID,
          resaleAskPriceCents: opts.askPriceCents,
          buyerUnitTotalCents,
          buyerTotalCents: buyerUnitTotalCents,
        },
        resaleFaceValueCents: 4000,
        resaleProcessingPassThroughCents: processingCents,
        resalePayoutReleaseAt: PAYOUT_RELEASE_AT,
        eventShareCents: share.shareCents,
        sharePayer: share.payer,
        ...opts.itemOverride,
      },
    ],
  } as unknown as OrderRecord;

  // ── Stateful fakes ──────────────────────────────────────────────────────
  let splitRows: Array<{ payeeId: string; amountCents: number }> = [];
  const splits = {
    upsertForOrder: vi.fn(
      async (_orderId: string, rows: typeof splitRows) => {
        // The adapter is deleteMany + createMany under @@unique(orderId,
        // payeeId): a duplicate payee row would be a P2002 in production.
        const ids = rows.map((r) => r.payeeId);
        if (new Set(ids).size !== ids.length) {
          throw new Error("order_split_unique_violation");
        }
        splitRows = rows.map((r) => ({ ...r }));
      },
    ),
    getForOrder: vi.fn(async () =>
      splitRows.map((r, i) => ({
        id: `split-${i}`,
        orderId: ORDER_ID,
        orderSplitId: `split-${i}`,
        payeeId: r.payeeId,
        amountCents: r.amountCents,
      })),
    ),
  };

  const payeesBySubject = new Map<string, string>();
  if (opts.sellerHasPayee !== false) {
    payeesBySubject.set(`HUMAN:${SELLER_HUMAN_ID}`, SELLER_PAYEE_ID);
  }
  const payees = {
    getBySubject: vi.fn(async (s: { type: string; id: string }) => {
      const id = payeesBySubject.get(`${s.type}:${s.id}`);
      return id ? { id } : null;
    }),
    upsertForSubject: vi.fn(
      async (input: { subjectType: string; subjectId: string }) => {
        const id = "dddddddd-0000-4000-8000-00000000000d";
        payeesBySubject.set(`${input.subjectType}:${input.subjectId}`, id);
        return {
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          stripeAccountId: null,
          status: "PENDING",
          payoutsEnabled: false,
        };
      },
    ),
  };

  const ledger = createFakePayeeLedgerRepo();
  const audit = { log: vi.fn(async () => {}) };

  const resaleListings = {
    getById: vi.fn(async (id: string) =>
      id === LISTING_ID
        ? {
            id: LISTING_ID,
            ticketId: TICKET_ID,
            sellerHumanId: SELLER_HUMAN_ID,
            status: "HELD",
            buyerOrderId: opts.listingBuyerOrderId ?? null,
            resalePayoutTermsId: listingTermsId,
          }
        : null,
    ),
    commit: vi.fn(async () => opts.commitResult ?? { ok: true, ticketId: TICKET_ID }),
  };

  const txRepos = {
    orders: {
      getById: vi.fn(async (id: string) =>
        id === ORDER_ID
          ? ({ ...order, items: order.items.map((i) => ({ ...i })) } as OrderRecord)
          : null,
      ),
      findByPaymentIntent: vi.fn(async () => null),
      linkPaymentIntent: vi.fn(async (_id: string, pi: string) => {
        order.stripePaymentIntentId = pi;
      }),
      markSucceeded: vi.fn(async () => {
        order.status = "SUCCEEDED";
      }),
      linkPaymentIntentIfPending: vi.fn(async (_id: string, pi: string) => {
        order.stripePaymentIntentId = pi;
        return true;
      }),
      markSucceededIfOpen: vi.fn(async () => {
        order.status = "SUCCEEDED";
        return true;
      }),
      listOtherPending: vi.fn(async () => []),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        title: "Resale Night",
        startsAt: EVENT_STARTS_AT,
        endsAt: EVENT_ENDS_AT,
        payoutTermsId: "terms-primary",
        agreementPrimaryId: null,
        resalePayoutTermsId: eventTermsId,
        waiverTemplateId: null,
      })),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        { id: "terms-active-decoy", kind: "RESALE", status: "ACTIVE" },
      ]),
      listLines: vi.fn(async (agreementId: string) =>
        (linesByTerms[agreementId] ?? []).map((l, i) => ({
          id: `line-${i}`,
          agreementId,
          payeeId: l.payeeId,
          percent: l.percent,
          floorCents: 0,
          capPercent: null,
          priority: l.priority,
          rounding: l.rounding,
        })),
      ),
      getById: vi.fn(async (id: string) => {
        if (opts.missingTermsIds?.includes(id)) return null;
        // createCreditsFromOrder reads the event's terms for the schedule.
        if (id === "terms-primary") {
          return { id: "terms-primary", payoutSchedule: "ASAP" };
        }
        return id in linesByTerms
          ? { id, kind: "RESALE", status: "ACTIVE" }
          : null;
      }),
    },
    splits,
    payees,
    payeeLedger: ledger.repo,
    resaleListings,
    tickets: {
      getById: vi.fn(async () => ({
        id: TICKET_ID,
        orderItemId: ORIGINAL_ITEM_ID,
        ownerHumanId: BUYER_HUMAN_ID,
      })),
      reassignForResale: vi.fn(async () => {}),
    },
    orderItems: {
      getById: vi.fn(async () => ({ id: ORIGINAL_ITEM_ID, status: "active" })),
      updateStatus: vi.fn(async () => {}),
      setResaleListingId: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => order.items),
    },
    audit,
    promos: { confirmHoldsForOrder: vi.fn(async () => []) },
    feeWaivers: { settle: vi.fn(async () => ({ settledTickets: 0 })) },
    // Attribution already recorded → skip (not under test here).
    ticketAttributions: {
      findByIdempotencyKey: vi.fn(async () => ({ id: "attr-1" })),
    },
  };

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const reportError = vi.fn();
  const deps: FinalizePaymentIntentDeps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => NOW },
    reportError,
  };

  const amountReceived = buyerUnitTotalCents; // tax 0

  function stripeEvent(id = "evt_resale_1") {
    return {
      stripeEvent: {
        id,
        type: "payment_intent.succeeded" as const,
        data: {
          object: {
            id: "pi_resale_1",
            status: "succeeded" as const,
            amount_received: amountReceived,
            currency: "usd",
            metadata: {
              orderId: ORDER_ID,
              eventId: EVENT_ID,
              source: opts.metadataSource ?? ("resale" as const),
            },
          },
        },
      },
    };
  }

  const credits = () =>
    ledger.entriesOfType("SETTLEMENT_CREDIT").map((e) => ({
      payeeId: e.payeeId,
      amountCents: e.amountCents,
      idempotencyKey: e.idempotencyKey,
      availableAt: e.availableAt?.toISOString() ?? null,
    }));
  const creditOf = (payeeId: string) =>
    ledger
      .entriesOfType("SETTLEMENT_CREDIT")
      .filter((e) => e.payeeId === payeeId)
      .reduce((sum, e) => sum + e.amountCents, 0);

  return {
    deps,
    order,
    share,
    processingCents,
    ledger,
    reportError,
    audit,
    splits,
    payees,
    resaleListings,
    stripeEvent,
    credits,
    creditOf,
    splitRows: () => splitRows,
    txRepos,
  };
}

const sum = (xs: Array<{ amountCents: number }>) =>
  xs.reduce((acc, x) => acc + x.amountCents, 0);
const creditsByPayee = (w: ReturnType<typeof makeWorld>) =>
  Object.fromEntries(
    w.ledger
      .entriesOfType("SETTLEMENT_CREDIT")
      .map((e) => [e.payeeId, e.amountCents]),
  );

describe("finalize pays the event side its resale share", () => {
  it("a $40 ticket under a 10% SELLER clause resold at $50: seller credited $45, the event's payees $5 split by the resale lines, the platform nothing", async () => {
    const w = makeWorld({
      askPriceCents: 5000,
      clause: TEN_PERCENT_SELLER,
      lines: ORG_70_PLACE_30,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(creditsByPayee(w)).toEqual({
      [SELLER_PAYEE_ID]: 4500,
      [ORG_PAYEE_ID]: 350,
      [CREATOR_PAYEE_ID]: 150,
    });
    // seller + share = basis, to the cent; every cent of it to a payee.
    expect(sum(w.splitRows())).toBe(5000);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(5000);
    // Platform revenue on a resale order is 0 (R11): no platform fee is
    // recorded, and the credits above are the whole basis.
    expect(w.order.feesPlatformCents).toBe(0);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("a BUYER clause: the seller is credited the whole $50 ask and the event its $5 share of the $55 basis", async () => {
    const w = makeWorld({
      askPriceCents: 5000,
      clause: TEN_PERCENT_BUYER,
      lines: ORG_70_PLACE_30,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(creditsByPayee(w)).toEqual({
      [SELLER_PAYEE_ID]: 5000,
      [ORG_PAYEE_ID]: 350,
      [CREATOR_PAYEE_ID]: 150,
    });
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(5500);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("a FLAT $8 clause on a $50 resale pays $5 (held to the 10% limit)", async () => {
    const w = makeWorld({
      askPriceCents: 5000,
      clause: { type: "FLAT", cents: 800, payer: "SELLER" },
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.share.shareHeld).toBe(true);
    expect(creditsByPayee(w)).toEqual({
      [SELLER_PAYEE_ID]: 4500,
      [ORG_PAYEE_ID]: 500,
    });
  });

  it("a 0% clause: the seller is credited the whole ask and no event payee gets a row", async () => {
    const w = makeWorld({
      askPriceCents: 5000,
      clause: { type: "PERCENT", bps: 0, payer: "SELLER" },
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(creditsByPayee(w)).toEqual({ [SELLER_PAYEE_ID]: 5000 });
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("rounding: a share split 70/30 over odd cents still sums to the share, and seller + share = basis", async () => {
    // 10% of $50.07 = 500 (floor); seller 4507.
    const w = makeWorld({
      askPriceCents: 5007,
      clause: TEN_PERCENT_SELLER,
      lines: ORG_70_PLACE_30,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.share.shareCents).toBe(500);
    expect(creditsByPayee(w)[SELLER_PAYEE_ID]).toBe(4507);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(5007);
  });

  describe("the to-the-cent guard refuses a share snapshot the checkout cannot have written", () => {
    it.each([
      {
        label: "a share above 10% of the ask",
        itemOverride: { eventShareCents: 600 },
      },
      {
        label: "a payer that is not SELLER or BUYER",
        itemOverride: { sharePayer: null },
      },
      {
        label: "a share with no payer and a payer with no share",
        itemOverride: { eventShareCents: null, sharePayer: "SELLER" },
      },
      {
        label: "an ask that disagrees with the basis and payer",
        itemOverride: {
          meta: {
            resaleListingId: LISTING_ID,
            resaleOriginalOrderItemId: ORIGINAL_ITEM_ID,
            resaleAskPriceCents: 4900,
            buyerUnitTotalCents: 5181,
            buyerTotalCents: 5181,
          },
        },
      },
      {
        label: "a negative share",
        itemOverride: { eventShareCents: -1 },
      },
    ])("$label: RESALE_PURCHASE_PRICE_UNKNOWN, nothing credited", async ({ itemOverride }) => {
      const w = makeWorld({
        askPriceCents: 5000,
        clause: TEN_PERCENT_SELLER,
        itemOverride,
      });

      await expect(
        finalizePaymentIntent(w.deps, w.stripeEvent()),
      ).rejects.toMatchObject({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" });
      expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
      expect(w.splitRows()).toHaveLength(0);
    });
  });
});

describe("a claim, a refund and a dispute return the share with the rest of the order (FR-010)", () => {
  async function finalized(clause: ResaleShareClause) {
    const w = makeWorld({
      askPriceCents: 5000,
      clause,
      lines: ORG_70_PLACE_30,
    });
    await finalizePaymentIntent(w.deps, w.stripeEvent());
    return w;
  }

  it("an approved claim (a full refund) debits the seller and every event payee their whole credit", async () => {
    const w = await finalized(TEN_PERCENT_SELLER);

    const debits = await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "claim-1",
      attemptedFullRefund: true,
      useCase: "reviewClaim",
      reportError: w.reportError,
    });

    expect(
      Object.fromEntries(debits.map((d) => [d.payeeId, d.debitCents])),
    ).toEqual({
      [SELLER_PAYEE_ID]: 4500,
      [ORG_PAYEE_ID]: 350,
      [CREATOR_PAYEE_ID]: 150,
    });
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("a BUYER-paid share is part of what the buyer gets back: the refunded item carries it, and every payee is debited", async () => {
    const w = await finalized(TEN_PERCENT_BUYER);

    // The refund paths refund the item's amount (plus its processing and
    // tax): the basis, share included.
    expect(w.order.items[0]!.amountCents).toBe(5500);

    const debits = await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "claim-1",
      attemptedFullRefund: true,
      useCase: "reviewClaim",
    });

    expect(
      Object.fromEntries(debits.map((d) => [d.payeeId, d.debitCents])),
    ).toEqual({
      [SELLER_PAYEE_ID]: 5000,
      [ORG_PAYEE_ID]: 350,
      [CREATOR_PAYEE_ID]: 150,
    });
    expect(sum(debits.map((d) => ({ amountCents: d.debitCents })))).toBe(5500);
  });

  it("an item-attributed refund (refund-full-order, cancel-event) debits every payee in full", async () => {
    const w = await finalized(TEN_PERCENT_SELLER);

    const debits = await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "refund-1",
      attemptedFullRefund: false,
      useCase: "refundFullOrder",
    });

    expect(sum(debits.map((d) => ({ amountCents: d.debitCents })))).toBe(5000);
  });

  it("an external-amount refund (Stripe reconcile, dispute loss) debits the seller and the event payees in proportion to their credits", async () => {
    const w = await finalized(TEN_PERCENT_SELLER);
    const buyerTotal = 5000 + w.processingCents;

    const debits = await writeExternalAmountRefundDebitsForOrder(
      w.txRepos as never,
      {
        order: { id: ORDER_ID, currency: "usd" },
        refundKey: "re_full_1",
        cumulativeRefundedCents: buyerTotal,
        expectedBuyerTotalCents: buyerTotal,
        useCase: "reconcileStripeFullRefund",
      },
    );

    expect(
      Object.fromEntries(debits.map((d) => [d.payeeId, d.debitCents])),
    ).toEqual({
      [SELLER_PAYEE_ID]: 4500,
      [ORG_PAYEE_ID]: 350,
      [CREATOR_PAYEE_ID]: 150,
    });
  });
});
