/**
 * The resale SELLER is credited at finalize.
 *
 * Bug (fixed 2026-09-30): finalize split the WHOLE ask over the event's RESALE
 * payout-terms lines, so the organiser was credited the seller's proceeds and
 * the seller got $0 — with their original order item already `transferred`,
 * so they could not refund it either.
 *
 * These tests drive the REAL chain against an in-memory world:
 *   computeResaleShare + computeResaleSchedule (the checkout snapshot: the
 *     organiser's resale share, organiser-resale-share FR-005; a SELLER
 *     PERCENT clause here, the BUYER and FLAT cases are in
 *     finalize-resale-share.test.ts)
 *     → finalizePaymentIntent (splits)
 *     → createCreditsFromOrder (SETTLEMENT_CREDIT rows, fake ledger with real
 *       key-replay semantics)
 *     → writeRefundDebitsForOrder / writeExternalAmountRefundDebitsForOrder
 *       (the two debit writers EVERY refund path calls).
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { solveResaleCharge } from "../../../lib/pricing/resale-charge";
import {
  computeResaleSchedule,
  computeResaleShare,
} from "../../../lib/pricing/resale-pricing";
import {
  writeExternalAmountRefundDebitsForOrder,
  writeRefundDebitsForOrder,
} from "../_shared/write-refund-debits";
import { createCreditsFromOrder } from "../../settlements/create-credits-from-order";
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
// endsAt + RESALE_CLAIM_WINDOW_DAYS (3).
const CLAIM_CLOSE = "2026-06-04T23:00:00.000Z";

type Line = {
  payeeId: string;
  percent: number;
  rounding: "FLOOR" | "NEAREST";
  priority: number;
};

const ORG_100: Line[] = [
  { payeeId: ORG_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
];

function makeWorld(opts: {
  askPriceCents: number;
  faceValueCents: number;
  /** The ticket's SELLER PERCENT clause, in basis points (default 10%). */
  shareBps?: number;
  lines?: Line[];
  resalePayoutReleaseDays?: number;
  /** Seller has a HUMAN payee (default true). */
  sellerHasPayee?: boolean;
  /** The listing's pinned RESALE terms (default "terms-listing"). */
  listingTermsId?: string | null;
  /** The event's RESALE terms (default "terms-event"). */
  eventTermsId?: string | null;
  /** Rows `payoutTerms.getById` cannot find. */
  missingTermsIds?: string[];
  /** What `resaleListings.commit` returns (default ok + ticket). */
  commitResult?: { ok: boolean; ticketId?: string };
  /** The listing's buyerOrderId as read before commit. */
  listingBuyerOrderId?: string | null;
  /** Stripe metadata `source` (default "resale"). */
  metadataSource?: "resale" | "primary";
  /** Tamper with the stamped snapshot (corrupt-row test). */
  snapshotOverride?: Partial<{
    resaleFaceValueCents: number | null;
    eventShareCents: number | null;
    sharePayer: "SELLER" | "BUYER" | null;
  }>;
}) {
  const lines = opts.lines ?? ORG_100;
  const listingTermsId =
    opts.listingTermsId === undefined ? "terms-listing" : opts.listingTermsId;
  const eventTermsId =
    opts.eventTermsId === undefined ? "terms-event" : opts.eventTermsId;
  // Three DIFFERENT line sets so a test can tell which terms finalize used:
  // the listing's pinned terms (what checkout priced against), the event's
  // current resale terms (checkout's fallback), and a decoy — the "first
  // ACTIVE RESALE terms on the event" finalize used to pick.
  const linesByTerms: Record<string, Line[]> = {
    "terms-listing": lines,
    "terms-event": [
      { payeeId: CREATOR_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
    ],
    "terms-active-decoy": [
      { payeeId: DECOY_PAYEE_ID, percent: 100, rounding: "FLOOR", priority: 0 },
    ],
  };

  // ── The checkout snapshot, computed by the real pricing function ────────
  const share = computeResaleShare({
    askCents: opts.askPriceCents,
    clause: { type: "PERCENT", bps: opts.shareBps ?? 1000, payer: "SELLER" },
  });
  const schedule = computeResaleSchedule({
    event: {
      startsAt: EVENT_STARTS_AT,
      endsAt: EVENT_ENDS_AT,
      resalePayoutReleaseDaysOverride: null,
    },
    payoutTerms: { resalePayoutReleaseDays: opts.resalePayoutReleaseDays ?? 7 },
  });
  const pricing = {
    sellerProceedsCents: share.sellerReceivesCents,
    shareCents: share.shareCents,
    payoutReleaseAt: schedule.payoutReleaseAt,
    processingPassThroughCents: solveResaleCharge({
      basisCents: share.basisCents,
      taxLines: [],
      processorPct: 0.029,
      processorFixedCents: 30,
    }).processingPassThroughCents,
  };
  const buyerUnitTotalCents =
    opts.askPriceCents + pricing.processingPassThroughCents;

  // Mirrors `createResaleCheckout`'s order + item exactly.
  const order: OrderRecord = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_HUMAN_ID,
    amountGrossCents: opts.askPriceCents,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
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
        unitPriceCents: opts.askPriceCents,
        amountCents: opts.askPriceCents,
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
        resaleFaceValueCents: opts.faceValueCents,
        resaleProcessingPassThroughCents: pricing.processingPassThroughCents,
        resalePayoutReleaseAt: pricing.payoutReleaseAt,
        eventShareCents: share.shareCents,
        sharePayer: share.payer,
        ...opts.snapshotOverride,
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
    pricing,
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

describe("finalize credits the resale SELLER", () => {
  it.each([
    {
      label: "below what the seller paid — a 10% share is still paid (R7)",
      ask: 3000,
      face: 4000,
      bps: 1000,
      seller: 2700,
      org: 300,
    },
    {
      label: "at face",
      ask: 4000,
      face: 4000,
      bps: 1000,
      seller: 3600,
      org: 400,
    },
    {
      label: "above face — bought $40, listed $60, 10% share",
      ask: 6000,
      face: 4000,
      bps: 1000,
      seller: 5400,
      org: 600,
    },
    {
      label: "a 0% clause — the seller keeps the whole ask",
      ask: 6000,
      face: 4000,
      bps: 0,
      seller: 6000,
      org: 0,
    },
  ])("$label", async ({ ask, face, bps, seller, org }) => {
    const w = makeWorld({
      askPriceCents: ask,
      faceValueCents: face,
      shareBps: bps,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.pricing.sellerProceedsCents).toBe(seller);
    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(seller);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(org);
    // Invariant: seller + split payees === ask (the agreement basis).
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(ask);
    expect(sum(w.splitRows())).toBe(ask);
    // The seller rides the SAME credit key as every other payee.
    expect(
      w.ledger
        .entriesOfType("SETTLEMENT_CREDIT")
        .find((e) => e.payeeId === SELLER_PAYEE_ID)?.idempotencyKey,
    ).toBe(`settlement-credit:${ORDER_ID}:${SELLER_PAYEE_ID}`);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("rounding: the seller amount is exact and the organiser lines absorb the remainder", async () => {
    // ask 6001 under a 9.99% clause → share floor(6001 × 999 / 10000) =
    // floor(599.49) = 599 → seller 5402; the share 599 split 70/30 over two
    // lines (FLOOR / NEAREST).
    const w = makeWorld({
      askPriceCents: 6001,
      faceValueCents: 4000,
      shareBps: 999,
      lines: [
        { payeeId: ORG_PAYEE_ID, percent: 70, rounding: "FLOOR", priority: 1 },
        {
          payeeId: CREATOR_PAYEE_ID,
          percent: 30,
          rounding: "NEAREST",
          priority: 0,
        },
      ],
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(5402);
    expect(w.creditOf(ORG_PAYEE_ID) + w.creditOf(CREATOR_PAYEE_ID)).toBe(599);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(419);
    expect(w.creditOf(CREATOR_PAYEE_ID)).toBe(180);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(6001);
  });

  it("a seller who is also on the RESALE lines gets ONE split row (OrderSplit is unique per payee)", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      lines: [
        { payeeId: ORG_PAYEE_ID, percent: 50, rounding: "FLOOR", priority: 0 },
        {
          payeeId: SELLER_PAYEE_ID,
          percent: 50,
          rounding: "FLOOR",
          priority: 0,
        },
      ],
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    // seller 5400 + their 50% of the share (300); org 300.
    expect(w.splitRows()).toHaveLength(2);
    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(5700);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(300);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(6000);
  });

  it("holds the seller's credit (and the organiser's) until the claim window closes, even under a 0-day policy", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      resalePayoutReleaseDays: 0,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.pricing.payoutReleaseAt.toISOString()).toBe(CLAIM_CLOSE);
    expect(w.credits().map((c) => c.availableAt)).toEqual([
      CLAIM_CLOSE,
      CLAIM_CLOSE,
    ]);
  });

  it("is idempotent: a webhook redelivery and an operator re-drive never double-credit the seller", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent("evt_resale_1"));
    const first = w.credits();

    // Same Stripe event replayed (idempotency cache) …
    await finalizePaymentIntent(w.deps, w.stripeEvent("evt_resale_1"));
    // … a DIFFERENT event id for the same PI (order already SUCCEEDED) …
    await finalizePaymentIntent(w.deps, w.stripeEvent("evt_resale_2"));
    // … and the operator re-drive (`settlements.createFromOrder`).
    await createCreditsFromOrder(
      { repos: w.deps.repos, clock: w.deps.clock },
      { orderId: ORDER_ID },
    );

    expect(w.credits()).toEqual(first);
    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(5400);
    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(2);
    expect(w.resaleListings.commit).toHaveBeenCalledTimes(1);
  });

  it("seller with no payee at finalize: credits a PENDING placeholder payee (never the organiser) and reports", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      sellerHasPayee: false,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.payees.upsertForSubject).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: SELLER_HUMAN_ID,
    });
    const placeholderId = "dddddddd-0000-4000-8000-00000000000d";
    expect(w.creditOf(placeholderId)).toBe(5400);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(600);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(6000);

    expect(w.reportError).toHaveBeenCalledTimes(1);
    expect(w.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_seller_payee_missing_at_finalize",
      }),
      expect.objectContaining({
        tags: {
          useCase: "finalizePaymentIntent",
          reason: "resale_seller_payee_missing",
        },
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          sellerHumanId: SELLER_HUMAN_ID,
          placeholderPayeeId: placeholderId,
          sellerCents: 5400,
        }),
      }),
    );
  });

  it("a throwing reporter on the missing-payee path never changes the outcome", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      sellerHasPayee: false,
    });
    w.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).resolves.toEqual({ ok: true, orderId: ORDER_ID });
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(6000);
  });

  it("fails closed on a share the checkout cannot have written (above 10% of the ask) — nothing is split, credited or committed", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      snapshotOverride: { eventShareCents: 2000 },
    });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).rejects.toMatchObject({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" });

    expect(w.splits.upsertForOrder).not.toHaveBeenCalled();
    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
    expect(w.resaleListings.commit).not.toHaveBeenCalled();
  });

  it("fails closed on an order priced under the removed markup split (no share): a late payment is never paid out on a guessed split", async () => {
    // organiser-resale-share FR-014/FR-015: the markup columns are gone, so
    // an item without a share has nothing to split by. Only an order that was
    // CANCELLED before the removal can carry one (the migration refuses while
    // one is unfinished), and finalize refuses that earlier; this pins the
    // seller split's own refusal for any that slips through.
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      snapshotOverride: { eventShareCents: null, sharePayer: null },
    });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).rejects.toMatchObject({
      code: "RESALE_PURCHASE_PRICE_UNKNOWN",
      meta: expect.objectContaining({ reason: "resale_share_snapshot_missing" }),
    });
    expect(w.splits.upsertForOrder).not.toHaveBeenCalled();
    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
    expect(w.resaleListings.commit).not.toHaveBeenCalled();
  });

  it("records the seller's share on the order's succeeded audit row", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        action: "succeeded",
        data: expect.objectContaining({
          basisCents: 6000,
          splitsTotalCents: 6000,
          resaleSeller: expect.objectContaining({
            sellerPayeeId: SELLER_PAYEE_ID,
            sellerCents: 5400,
            organiserShareCents: 600,
            placeholderPayeeCreated: false,
          }),
        }),
      }),
    );
  });
});

describe("finalize splits over the SAME RESALE terms checkout priced against", () => {
  const base = { askPriceCents: 6000, faceValueCents: 4000 };

  it("a listing with its own terms id uses THOSE lines — not the event's, not the first ACTIVE on the event", async () => {
    const w = makeWorld(base); // listing → terms-listing (ORG 100%)

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(5400);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(600);
    expect(w.creditOf(CREATOR_PAYEE_ID)).toBe(0); // event terms
    expect(w.creditOf(DECOY_PAYEE_ID)).toBe(0); // first ACTIVE on the event
    expect(w.txRepos.payoutTerms.listByEvent).not.toHaveBeenCalled();
  });

  it("falls back to the event's resale terms when the listing has none (checkout's fallback)", async () => {
    const w = makeWorld({ ...base, listingTermsId: null });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.creditOf(CREATOR_PAYEE_ID)).toBe(600);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(0);
    expect(w.creditOf(DECOY_PAYEE_ID)).toBe(0);
    expect(sum(w.ledger.entriesOfType("SETTLEMENT_CREDIT"))).toBe(6000);
  });

  it.each([
    {
      label: "no terms id on listing or event",
      world: { listingTermsId: null, eventTermsId: null },
      code: "AGREEMENT_MISSING",
      reason: "resale_terms_id_missing",
    },
    {
      label: "the listing's terms row is gone",
      world: { missingTermsIds: ["terms-listing"] },
      code: "AGREEMENT_MISSING",
      reason: "resale_terms_row_missing",
    },
    {
      // A 0% clause: nothing is split over the lines, yet finalize still
      // refuses. Checkout refuses the same listing before charging
      // (create-resale-checkout.test.ts); the two are pinned together.
      label: "a share of 0 on RESALE terms with no lines",
      world: { shareBps: 0, lines: [] },
      code: "AGREEMENT_MISSING_LINES",
      reason: "resale_terms_lines_missing",
    },
  ])("$label → $code (fail closed) AND reported", async ({ world, code, reason }) => {
    const w = makeWorld({ ...base, ...world });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).rejects.toMatchObject({ code });

    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
    expect(w.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `finalize_resale_terms_unresolvable:${reason}`,
      }),
      expect.objectContaining({
        tags: { useCase: "finalizePaymentIntent", reason },
      }),
    );
  });
});

describe("finalize never credits the seller for a sale that did not transfer the ticket", () => {
  const base = { askPriceCents: 6000, faceValueCents: 4000 };

  it("commit → { ok: false } with the listing sold to a DIFFERENT order: rolls back, no split, no credit", async () => {
    const w = makeWorld({
      ...base,
      commitResult: { ok: false },
      listingBuyerOrderId: "abababab-abab-4bab-8bab-abababababab",
    });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });

    expect(w.splits.upsertForOrder).not.toHaveBeenCalled();
    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
  });

  it("commit → { ok: true } with no ticket id: rolls back, no credit", async () => {
    const w = makeWorld({ ...base, commitResult: { ok: true } });

    await expect(
      finalizePaymentIntent(w.deps, w.stripeEvent()),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
    expect(w.ledger.entriesOfType("SETTLEMENT_CREDIT")).toHaveLength(0);
  });

  it("a placeholder payee created in a transaction that then rolls back is NOT reported", async () => {
    const w = makeWorld({
      ...base,
      sellerHasPayee: false,
      commitResult: { ok: false },
      listingBuyerOrderId: "abababab-abab-4bab-8bab-abababababab",
    });

    await expect(finalizePaymentIntent(w.deps, w.stripeEvent())).rejects.toThrow();

    expect(w.reportError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_seller_payee_missing_at_finalize",
      }),
      expect.anything(),
    );
  });
});

describe("one source of truth for 'is this a resale order'", () => {
  it("a RESALE order whose Stripe metadata says 'primary' is still split as resale, and the mismatch is reported", async () => {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
      metadataSource: "primary",
    });

    await finalizePaymentIntent(w.deps, w.stripeEvent());

    expect(w.creditOf(SELLER_PAYEE_ID)).toBe(5400);
    expect(w.creditOf(ORG_PAYEE_ID)).toBe(600);
    expect(w.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "finalize_source_hint_mismatch" }),
      expect.objectContaining({
        tags: { useCase: "finalizePaymentIntent", reason: "source_hint_mismatch" },
        extra: expect.objectContaining({
          sourceHint: "PRIMARY",
          orderSource: "RESALE",
        }),
      }),
    );
  });
});

describe("refunds unwind the seller's credit (the shared debit writers every refund path calls)", () => {
  async function finalized() {
    const w = makeWorld({
      askPriceCents: 6000,
      faceValueCents: 4000,
    });
    await finalizePaymentIntent(w.deps, w.stripeEvent());
    return w;
  }

  it("full refund (refund-full-order, cancel-event, review-claim, reconcile full arm): seller and organiser each debited their whole credit", async () => {
    const w = await finalized();

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
    ).toEqual({ [SELLER_PAYEE_ID]: 5400, [ORG_PAYEE_ID]: 600 });
    expect(sum(debits.map((d) => ({ amountCents: d.debitCents })))).toBe(6000);
    // No "missing credit for payee" drift: every split payee was credited.
    expect(w.reportError).not.toHaveBeenCalled();

    // Replay under the same refund key writes nothing new.
    await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "claim-1",
      attemptedFullRefund: true,
      useCase: "reviewClaim",
    });
    expect(w.ledger.entriesOfType("REFUND_DEBIT")).toHaveLength(2);

    // A later webhook reconcile under the Stripe refund id nets to zero.
    const reconcile = await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "re_stripe_1",
      attemptedFullRefund: true,
      useCase: "reconcileStripeFullRefund",
    });
    expect(reconcile).toEqual([]);
  });

  it("item-attributed refund of the single resale item debits both payees in full", async () => {
    const w = await finalized();

    const debits = await writeRefundDebitsForOrder(w.txRepos as never, {
      order: { id: ORDER_ID, currency: "usd" },
      refundedItemIds: [RESALE_ITEM_ID],
      refundKey: "refund-1",
      attemptedFullRefund: false,
      useCase: "refundFullOrder",
    });

    expect(
      Object.fromEntries(debits.map((d) => [d.payeeId, d.debitCents])),
    ).toEqual({ [SELLER_PAYEE_ID]: 5400, [ORG_PAYEE_ID]: 600 });
  });

  it("external partial refund (reconcile partial arm): seller and organiser debited proportionally to their credits", async () => {
    const w = await finalized();
    const buyerTotal = 6000 + w.pricing.processingPassThroughCents;

    const debits = await writeExternalAmountRefundDebitsForOrder(
      w.txRepos as never,
      {
        order: { id: ORDER_ID, currency: "usd" },
        refundKey: "re_partial_1:3000",
        cumulativeRefundedCents: Math.floor(buyerTotal / 2),
        expectedBuyerTotalCents: buyerTotal,
        useCase: "reconcileStripeFullRefund",
      },
    );

    const bySeller = debits.find((d) => d.payeeId === SELLER_PAYEE_ID)!;
    const byOrg = debits.find((d) => d.payeeId === ORG_PAYEE_ID)!;
    // 9:1 credit ratio is preserved (±1¢ largest-remainder).
    expect(Math.abs(bySeller.debitCents - 9 * byOrg.debitCents)).toBeLessThanOrEqual(9);
    expect(bySeller.debitCents).toBeGreaterThan(2600);
    expect(bySeller.debitCents).toBeLessThanOrEqual(2700);
    expect(byOrg.debitCents).toBeLessThanOrEqual(300);
  });
});
