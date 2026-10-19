import type { Prisma, PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { clonePayoutTermsRow } from "@th/adapters/db/prisma/payout-terms";
import { createSystemClock } from "@th/adapters/infra/clock";
import { computeExpectedPaymentAmount } from "@th/core/lib/orders/compute-expected-payment-amount";
import { feeRemainderItemIndex } from "@th/core/lib/orders/fee-remainder-item";
import { allocateRefundItemBases } from "@th/core/lib/orders/refund-item-base";
import {
  allocateRefundFeeShares,
  allocateRefundTaxSharesByLine,
  type RefundTaxLineLike,
} from "@th/core/lib/orders/refund-tax-share";
import { resolveScopedFeePolicy } from "@th/core/lib/payments/resolve-scoped-fee-policy";
import { solveTaxLinesAndProcessorFee } from "@th/core/lib/pricing/solve-tax-and-processor-fee";
import {
  buildFeePolicySnapshot,
  computeOrderAmounts,
  loadPayoutTermsContext,
  unseatedSeatPrices,
  zeroFeesForFreeOrder,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "@th/core/use-cases/orders/checkout-helpers";
import { ORDER_HOLD_TTL_SECONDS } from "@th/core/use-cases/orders/_shared/cart-seat-release";
import { buildRefundMetadata } from "@th/core/use-cases/orders/_shared/dispute-refund-guard";
import { toOrderTaxLineInputs } from "@th/core/use-cases/orders/_shared/order-tax-lines";
import { allocateRefundPlatformFeeShares } from "@th/core/use-cases/orders/_shared/refund-platform-fee-share";
import {
  resolveCheckoutTax,
  type CheckoutTaxResolution,
} from "@th/core/use-cases/orders/_shared/resolve-checkout-tax-rate";
import { allocateFullRefundShares } from "@th/core/use-cases/orders/refund-full-order";
import { allocateRefundTaxSharesForOrder } from "@th/core/use-cases/orders/_shared/refund-tax-shares-for-order";
import type { Repos } from "@th/ports/repos";

// ── Stripe test-mode helpers ─────────────────────────────────────────────

/** Stripe's minimum charge for USD ($0.50). */
export const STRIPE_MIN_AMOUNT_CENTS = 50;

/**
 * A Stripe client from an explicit key or, failing that, the env the seed
 * entrypoint loaded (`apps/api/.env.local`). Null when neither has one.
 */
export const seedStripeFromEnv = (explicitKey?: string): Stripe | null => {
  const key = explicitKey || process.env.STRIPE_SECRET_KEY || undefined;
  return key
    ? new Stripe(key, { apiVersion: "2025-08-27.basil" as any })
    : null;
};

/**
 * Creates a real Stripe PaymentIntent and immediately confirms it with a test
 * card. Returns the `pi_xxx` ID that Stripe actually knows about so downstream
 * flows (refund quotes, balance-transaction lookups, etc.) work against real
 * objects.
 *
 * Only used during dev seeding when `STRIPE_SECRET_KEY` is available.
 */
export async function createConfirmedPaymentIntent(
  stripe: Stripe,
  opts: {
    amountCents: number;
    currency: string;
    metadata: Record<string, string>;
  },
): Promise<string> {
  const pi = await stripe.paymentIntents.create({
    amount: opts.amountCents,
    currency: opts.currency,
    metadata: opts.metadata,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    confirm: true,
    // Use the "bypass pending" test card so funds land in the available
    // balance immediately, allowing settlement transfers to succeed locally.
    payment_method: "pm_card_bypassPending",
  });
  return pi.id;
}

/**
 * Refunds a seeded order on Stripe the way the product's refund paths do, and
 * reports whether it happened — callers write refund state ONLY on `true`, so
 * Stripe and the database never disagree.
 *
 *   - `refundOrderItems` (`kind: "items"`): per refunded item, its share of
 *     the ex-tax charge + tax share − share of Stripe's fee (`quoteItemRefund`).
 *   - `refundFullOrder` (`kind: "full"`): every item, via the same
 *     `allocateFullRefundShares` that use case pays from.
 *
 * Stripe's fee is read off the charge's balance transaction, as the Stripe
 * adapter's `getProcessingFeeForPaymentIntent` does, and the refund carries
 * the product's `buildRefundMetadata` so a forwarded `charge.refunded`
 * reconciles as ours. A Stripe API error is thrown, before any row exists.
 */
export async function refundSeedOrderOnStripe(
  stripe: Stripe,
  input: {
    kind: "items" | "full";
    paymentIntentId: string;
    orderId: string;
    ticketItems: SeedTicketItem[];
    order: {
      amountGrossCents: number;
      feesPlatformCents: number;
      taxAmountCents: number;
      /** The order's tax lines when the seed has them; absent → single weight. */
      taxLines?: ReadonlyArray<RefundTaxLineLike>;
    };
    refundedItemIds: ReadonlySet<string>;
  },
): Promise<boolean> {
  const pi = await stripe.paymentIntents.retrieve(input.paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const charge = pi.latest_charge as Stripe.Charge | null;
  const balanceTx = charge?.balance_transaction as
    | Stripe.BalanceTransaction
    | null
    | undefined;
  if (!balanceTx || typeof balanceTx !== "object") {
    // No fee to withhold against yet — refunding in full would overpay.
    console.warn(
      `    [warn] Order ${input.orderId.slice(-6)}: no balance transaction on ${input.paymentIntentId}; not refunded`,
    );
    return false;
  }
  const amount =
    input.kind === "full"
      ? seedFullRefundCents(input.ticketItems, input.order, balanceTx.fee)
      : seedItemRefundCents(
          input.ticketItems,
          input.order,
          balanceTx.fee,
          input.refundedItemIds,
        );
  if (amount <= 0) {
    console.warn(
      `    [warn] Order ${input.orderId.slice(-6)}: nothing refundable after Stripe's fee; not refunded`,
    );
    return false;
  }
  await stripe.refunds.create({
    payment_intent: input.paymentIntentId,
    amount,
    metadata: buildRefundMetadata({
      useCase: input.kind === "full" ? "refundFullOrder" : "refundOrderItems",
      orderId: input.orderId,
      orderItemIds: [...input.refundedItemIds],
    }),
  });
  return true;
}

/**
 * When a seeded refund happened: a day after the purchase, but never in the
 * future and never before the purchase itself.
 */
export const seedRefundedAt = (occurredAt: Date, afterMs: number): Date =>
  new Date(
    Math.max(
      occurredAt.getTime(),
      Math.min(occurredAt.getTime() + afterMs, Date.now()),
    ),
  );

// ── Checkout-faithful pricing for seeded orders ──────────────────────────
//
// Seeded web orders are priced by the SAME functions create-checkout and
// claimFreeTickets run, so the fee, the fee mode, the tax and the card charge
// are numbers checkout could actually have produced. Refund stamps and refund
// amounts come from the same allocators the refund paths use. Nothing here
// re-derives a formula; where a use case does something inline (the
// processor-fee distribution below) it is copied step for step and says so.

/** What one event's checkout resolves to. Loaded once per event. */
export type SeedEventPricing = {
  /** PRIMARY payout terms + the fee policy they pin — `loadPayoutTermsContext`. */
  context: PayoutTermsContext;
  /** The event's admission tax — `resolveCheckoutTax`. */
  tax: CheckoutTaxResolution;
  /** Sellable (ACTIVE) ticket types only, as create-checkout filters them. */
  ticketTypes: Map<string, TicketTypeSummary>;
  /**
   * The amount a pay-what-you-want (ADJUSTABLE) buyer names — the tier's
   * suggested amount, else its floor. Checkout requires one on every
   * ADJUSTABLE line (`donation_amount_required`).
   */
  donationCents: Map<string, number>;
};

export const loadSeedEventPricing = async (
  prisma: PrismaClient,
  repos: Repos,
  eventId: string,
): Promise<SeedEventPricing> => {
  const now = new Date();
  const context = await loadPayoutTermsContext(repos, eventId, now, {});

  const event = await repos.events.getById(eventId);
  if (!event) throw new Error(`seed pricing: event ${eventId} not found`);
  // Seeded events carry a publish-time tax stamp. An unstamped one is priced
  // at 0 — what a checkout with no tax-rate provider resolves to — instead of
  // letting resolveCheckoutTax run its self-healing lookup, which writes back
  // onto the event row.
  const tax = await resolveCheckoutTax(
    { clock: createSystemClock(), taxRateLookup: null },
    repos,
    { ...event, admissionTaxRateBps: event.admissionTaxRateBps ?? 0 },
    undefined,
  );

  const rows = await prisma.ticketType.findMany({
    where: { eventId, status: "ACTIVE" },
    select: {
      id: true,
      priceCents: true,
      pricingMode: true,
      minimumCents: true,
      seatSectionId: true,
      scheduledPriceCents: true,
      scheduledPriceAt: true,
      salesOpenAt: true,
      salesCloseAt: true,
      suggestedCents: true,
    },
  });
  const ticketTypes = new Map<string, TicketTypeSummary>(
    rows.map(({ suggestedCents: _suggested, ...tt }) => [tt.id, tt]),
  );
  const donationCents = new Map(
    rows
      .filter((tt) => tt.pricingMode === "ADJUSTABLE")
      .map((tt) => [tt.id, tt.suggestedCents ?? tt.minimumCents ?? 0]),
  );

  return { context, tax, ticketTypes, donationCents };
};

/**
 * The refusals `loadPayoutTermsContext` (checkout-helpers.ts) throws for an
 * event whose terms cannot price a sale. Such an event could not have sold
 * anything, so it is skipped; any OTHER error is a real fault and is rethrown.
 */
const CHECKOUT_TERMS_REFUSALS: ReadonlySet<string> = new Set([
  "PRIMARY_AGREEMENT_MISSING",
  "FEE_POLICY_NOT_FOUND",
  "AGREEMENT_MISSING_FEE_POLICY",
  "AGREEMENT_MISSING_LINES",
]);

/**
 * {@link loadSeedEventPricing}, but an event checkout would refuse on its
 * terms is warned about and skipped instead of aborting the whole seed.
 */
export const tryLoadSeedEventPricing = async (
  prisma: PrismaClient,
  repos: Repos,
  eventId: string,
): Promise<SeedEventPricing | null> => {
  try {
    return await loadSeedEventPricing(prisma, repos, eventId);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : null;
    if (code === null || !CHECKOUT_TERMS_REFUSALS.has(code)) throw err;
    console.warn(
      `  [warn] Event ${eventId.slice(-6)}: checkout refuses its terms (${code}) — no orders seeded for it`,
    );
    return null;
  }
};

/**
 * Give a directly-written event the PRIMARY terms event creation and publish
 * would have left it: an event-owned clone of the place's default PRIMARY
 * terms, else the org's (the events adapter's create cascade, via the same
 * `clonePayoutTermsRow`), with the resolved fee policy pinned onto it
 * (`publishEvent`). Idempotent — an event that already has terms keeps them,
 * and a pinned policy stays pinned.
 */
export const ensureSeedEventPrimaryTerms = async (
  prisma: PrismaClient,
  repos: Repos,
  event: { id: string; orgId: string },
): Promise<void> => {
  const row = await prisma.event.findUnique({
    where: { id: event.id },
    select: {
      payoutTermsId: true,
      place: { select: { defaultPrimaryPayoutTermsId: true } },
    },
  });
  let payoutTermsId = row?.payoutTermsId ?? null;
  if (!payoutTermsId) {
    const org = await prisma.organization.findUnique({
      where: { id: event.orgId },
      select: { defaultPrimaryPayoutTermsId: true },
    });
    const sourceId =
      row?.place?.defaultPrimaryPayoutTermsId ??
      org?.defaultPrimaryPayoutTermsId ??
      null;
    const clone = sourceId
      ? await clonePayoutTermsRow(prisma, {
          sourcePayoutTermsId: sourceId,
          isDefault: false,
          // Mirrors the events adapter's create snapshot.
          resetFeeMode: true,
        })
      : null;
    if (!clone) {
      throw new Error(
        `seed pricing: no place/org default PRIMARY payout terms to snapshot for event ${event.id}`,
      );
    }
    payoutTermsId = clone.id;
    await prisma.event.update({
      where: { id: event.id },
      data: { payoutTermsId },
    });
  }

  const terms = await prisma.payoutTerms.findUnique({
    where: { id: payoutTermsId },
    select: { feePolicyId: true, isDefault: true },
  });
  if (terms?.feePolicyId) return;
  // Never pin onto a shared DEFAULT row: that would change the economics of
  // every event later snapshotted from it. Event-owned clones only.
  if (!terms || terms.isDefault) {
    throw new Error(
      `seed pricing: event ${event.id} points at DEFAULT terms ${payoutTermsId}; refusing to pin a policy onto a shared default`,
    );
  }
  // Resolved at seed time, not the show's back-dated publish instant: the
  // seeded GLOBAL policy is only effective from the moment it was written.
  const feePolicy = await resolveScopedFeePolicy(
    repos,
    { eventId: event.id, orgId: event.orgId },
    new Date(),
  );
  if (feePolicy) {
    await repos.payoutTerms.pinFeePolicy({
      payoutTermsId,
      feePolicyId: feePolicy.id,
    });
  }
};

/** Cart lines as checkout receives them: no seats, a named amount on PWYW. */
const toCartItems = (
  pricing: SeedEventPricing,
  lines: Array<{ ticketTypeId: string; qty: number }>,
) =>
  lines.map((line) => ({
    ...line,
    seatIds: [],
    donationAmountCents: pricing.donationCents.get(line.ticketTypeId),
  }));

/** The Order columns + per-ticket item meta checkout writes for one cart. */
export type SeedOrderPricing = {
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  /** What the buyer's card is charged — the PaymentIntent amount. */
  chargeCents: number;
  /** Always PASS_THROUGH: checkout prices every sale so (SALE_FEE_MODE). */
  effectiveFeeMode: "ABSORB" | "PASS_THROUGH";
  /** An all-pay-what-you-want cart; checkout persists it, a held cart doesn't. */
  nonRefundable: boolean;
  feePolicySnapshot: ReturnType<typeof buildFeePolicySnapshot>;
  /** One per TICKET, in cart-line order, exactly as checkout splits them. */
  items: Array<{
    ticketTypeId: string;
    unitPriceCents: number;
    meta: Prisma.InputJsonObject;
  }>;
  taxLines: ReturnType<typeof toOrderTaxLineInputs>;
  taxSitusCountry: string | null;
  taxSitusState: string | null;
  taxSitusPostal: string | null;
  taxRateSource: string | null;
};

/**
 * Price one cart the way checkout does: `computeOrderAmounts` for the face,
 * the per-ticket platform fee and the effective fee mode, then the joint tax +
 * processor gross-up (`solveTaxLinesAndProcessorFee`).
 *
 *   charge = face + platform fee + tax + grossed-up processor fee
 *
 * Every sale is priced fees-on-top (SALE_FEE_MODE; ABSORB is removed,
 * docs/decisions/absorb-removed.md), so the seed creates no ABSORB order.
 *
 * A free cart takes claimFreeTickets' shape instead: `zeroFeesForFreeOrder`,
 * no tax, no situs.
 */
export const priceSeedOrder = (
  pricing: SeedEventPricing,
  lines: Array<{ ticketTypeId: string; qty: number }>,
  occurredAt: Date,
): SeedOrderPricing => {
  const cartItems = toCartItems(pricing, lines);
  const computation = computeOrderAmounts(
    cartItems,
    pricing.ticketTypes,
    pricing.context,
    // Seed carts name no seats (`toCartItems` sends `seatIds: []`).
    { now: occurredAt, seatPrices: unseatedSeatPrices(cartItems) },
  );
  const isFree = computation.amountGrossCents === 0;
  if (isFree) zeroFeesForFreeOrder(computation);

  const taxSolve = solveTaxLinesAndProcessorFee({
    taxableGrossCents: computation.amountGrossCents,
    buyerPlatformFeeCents: computation.buyerFeesCents,
    taxLines: isFree ? [] : pricing.tax.impositions,
    passThrough: computation.effectiveFeeMode === "PASS_THROUGH",
    processorPct: computation.processorPct,
    processorFixedCents: computation.processorFixedCents,
  });
  const chargeCents =
    computation.amountGrossCents +
    computation.buyerFeesCents +
    taxSolve.taxCents +
    taxSolve.processorFeeCents;

  const items = computation.items.map((item) => ({
    ticketTypeId: item.ticketTypeId!,
    unitPriceCents: item.unitPriceCents,
    meta: { ...(item.meta as Record<string, unknown>) },
  }));

  // Copied from `spreadProcessorFee` (core `orders/_shared/price-cart.ts`):
  // fold the charged fee into each ticket's buyerTotalCents, floored by
  // buyerTotalCents, and the last PAID ticket takes the remainder (a $0
  // ticket carries no fee, so it never does: `feeRemainderItemIndex`). Only
  // when there is a charge to fold it into.
  const processorFeeCents = taxSolve.processorFeeCents;
  if (chargeCents > 0 && processorFeeCents > 0 && items.length > 0) {
    const totalBuyerCents = items.reduce(
      (sum, item) => sum + ((item.meta.buyerTotalCents as number) ?? 0),
      0,
    );
    const remainderIndex = feeRemainderItemIndex(
      items.map((item) => item.unitPriceCents),
    );
    const shares = items.map((item, i) => {
      if (i === remainderIndex || totalBuyerCents <= 0) return 0;
      const itemBuyerCents = (item.meta.buyerTotalCents as number) ?? 0;
      return Math.floor((itemBuyerCents / totalBuyerCents) * processorFeeCents);
    });
    shares[remainderIndex] =
      processorFeeCents - shares.reduce((sum, share) => sum + share, 0);
    let distributed = 0;
    items.forEach((item, i) => {
      const share = shares[i]!;
      item.meta.buyerTotalCents = (item.meta.buyerTotalCents as number) + share;
      item.meta.buyerUnitTotalCents =
        (item.meta.buyerUnitTotalCents as number) + share;
      item.meta.processorFeeShareCents = share;
      distributed += share;
    });
    if (distributed !== processorFeeCents) {
      throw new Error(
        `rounding_invariant: processor fee shares ${distributed} !== grossedUpProcessorFeeCents ${processorFeeCents}`,
      );
    }
  }

  const taxSitus = isFree ? null : pricing.tax.situs;
  return {
    amountGrossCents: computation.amountGrossCents,
    feesPlatformCents: computation.feesPlatformCents,
    taxAmountCents: taxSolve.taxCents,
    chargeCents,
    effectiveFeeMode: computation.effectiveFeeMode,
    nonRefundable: computation.nonRefundable,
    feePolicySnapshot: buildFeePolicySnapshot(pricing.context, occurredAt),
    items: items.map((item) => ({
      ...item,
      meta: item.meta as Prisma.InputJsonObject,
    })),
    taxLines: isFree ? [] : toOrderTaxLineInputs(taxSolve, taxSolve.taxCents),
    taxSitusCountry: taxSitus?.countryCode ?? null,
    taxSitusState: taxSitus?.region ?? null,
    taxSitusPostal: taxSitus?.postalCode ?? null,
    taxRateSource: isFree ? null : pricing.tax.rateSource,
  };
};

/**
 * Price one cart the way `updateOrderItems` HOLDS it — a PENDING order with
 * no PaymentIntent (and the same row once the cart reaper or a superseding
 * checkout cancels it: every cancel path only flips `status`).
 *
 * That use case writes `computeOrderAmounts` straight through: gross, the
 * platform fee and the snapshot, item meta WITHOUT the processor-fee fold
 * (the held fee is an estimate it returns, never stores), plus
 * `meta.holdExpiresAt`. It does NOT persist tax, a situs, a rate source or
 * OrderTaxLine rows — the charge re-resolves those.
 */
export const priceSeedCart = (
  pricing: SeedEventPricing,
  lines: Array<{ ticketTypeId: string; qty: number }>,
  occurredAt: Date,
): SeedOrderPricing => {
  const cartItems = toCartItems(pricing, lines);
  const computation = computeOrderAmounts(
    cartItems,
    pricing.ticketTypes,
    pricing.context,
    // Seed carts name no seats (`toCartItems` sends `seatIds: []`).
    { now: occurredAt, seatPrices: unseatedSeatPrices(cartItems) },
  );
  const holdExpiresAt = new Date(
    occurredAt.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
  ).toISOString();
  return {
    amountGrossCents: computation.amountGrossCents,
    feesPlatformCents: computation.feesPlatformCents,
    taxAmountCents: 0,
    // Nothing is charged while the cart is held.
    chargeCents: 0,
    effectiveFeeMode: computation.effectiveFeeMode,
    // updateOrderItems never writes it; the column default stands.
    nonRefundable: false,
    feePolicySnapshot: buildFeePolicySnapshot(pricing.context, occurredAt),
    items: computation.items.map((item) => ({
      ticketTypeId: item.ticketTypeId!,
      unitPriceCents: item.unitPriceCents,
      meta: {
        ...(item.meta as Record<string, unknown>),
        holdExpiresAt,
      } as Prisma.InputJsonObject,
    })),
    taxLines: [],
    taxSitusCountry: null,
    taxSitusState: null,
    taxSitusPostal: null,
    taxRateSource: null,
  };
};

/** Order columns for a {@link SeedOrderPricing}, as checkout writes them. */
export const pricedOrderColumns = (priced: SeedOrderPricing) => ({
  amountGrossCents: priced.amountGrossCents,
  feesPlatformCents: priced.feesPlatformCents,
  taxAmountCents: priced.taxAmountCents,
  nonRefundable: priced.nonRefundable,
  feePolicySnapshot: priced.feePolicySnapshot,
  taxSitusCountry: priced.taxSitusCountry,
  taxSitusState: priced.taxSitusState,
  taxSitusPostal: priced.taxSitusPostal,
  taxRateSource: priced.taxRateSource,
});

/**
 * The per-imposition OrderTaxLine rows create-checkout writes beside the
 * order.
 *
 *   - `"keep"`: skipped when the order already has lines. For callers whose
 *     order upsert leaves an existing order's money untouched, so its lines
 *     still match it.
 *   - `"replace"`: the order's lines are deleted first. For callers whose
 *     upsert RE-PRICES an existing order, so the lines follow the new tax.
 */
export const writeSeedTaxLines = async (
  prisma: PrismaClient,
  repos: Repos,
  orderId: string,
  priced: SeedOrderPricing,
  mode: "keep" | "replace" = "keep",
) => {
  if (mode === "replace") {
    // Delete + rewrite atomically, so a crash in between can never leave a
    // taxed order with no breakdown. The adapter's own writer is handed the
    // transaction client rather than re-implementing its column mapping.
    await prisma.$transaction(async (tx) => {
      await tx.orderTaxLine.deleteMany({ where: { orderId } });
      if (priced.taxLines.length === 0) return;
      await createPrismaRepos(tx as unknown as PrismaClient).orders.createTaxLines(
        { orderId, lines: priced.taxLines },
      );
    });
    return;
  }
  if ((await prisma.orderTaxLine.count({ where: { orderId } })) > 0) return;
  if (priced.taxLines.length === 0) return;
  await repos.orders.createTaxLines({ orderId, lines: priced.taxLines });
};

/** A ticket item as the refund allocators read it. */
export type SeedTicketItem = { id: string; amountCents: number; meta: unknown };

/**
 * What a refund path stamps on each refunded ticket item beside `refundedAt`
 * (refund-full-order.ts / refund-order-items.ts → orderItems.updateStatus):
 * the item's share of the order's tax and of its platform fee. Allocated over
 * ALL the order's ticket items, as those paths do, so stamps across partial
 * refunds add up to the order totals exactly once.
 */
export const refundStampsFor = (
  ticketItems: SeedTicketItem[],
  order: {
    feesPlatformCents: number;
    taxAmountCents: number;
    /** The order's tax lines when the seed has them; absent → single weight. */
    taxLines?: ReadonlyArray<RefundTaxLineLike>;
  },
) => {
  const tax = allocateRefundTaxSharesByLine(
    ticketItems,
    order.taxAmountCents,
    order.taxLines ?? [],
  ).shares;
  const fee = allocateRefundPlatformFeeShares(
    ticketItems,
    order.feesPlatformCents,
  );
  return (itemId: string) => ({
    refundedTaxCents: tax.get(itemId) ?? 0,
    // `?? null`, as the refund paths do: an unknown item stays unattributed.
    refundedPlatformFeeCents: fee.get(itemId) ?? null,
  });
};

/**
 * The amount `refundOrderItems` sends to Stripe for `refundedItemIds`, per
 * `quoteItemRefund`: for each item, its share of the post-discount ex-tax
 * charge + its tax share − its share of Stripe's actual fee (the one
 * non-refundable component). All three are allocated over EVERY ticket item.
 */
export const seedItemRefundCents = (
  ticketItems: SeedTicketItem[],
  order: {
    amountGrossCents: number;
    feesPlatformCents: number;
    taxAmountCents: number;
    /** The order's tax lines when the seed has them; absent → single weight. */
    taxLines?: ReadonlyArray<RefundTaxLineLike>;
  },
  stripeFeeCents: number,
  refundedItemIds: ReadonlySet<string>,
): number => {
  const bases = allocateRefundItemBases(ticketItems, {
    ...order,
    items: ticketItems,
  });
  const taxes = allocateRefundTaxSharesByLine(
    ticketItems,
    order.taxAmountCents,
    order.taxLines ?? [],
  ).shares;
  const fees = allocateRefundFeeShares(ticketItems, stripeFeeCents);
  let total = 0;
  for (const item of ticketItems) {
    if (!refundedItemIds.has(item.id)) continue;
    total += Math.max(
      0,
      (bases.get(item.id) ?? 0) +
        (taxes.get(item.id) ?? 0) -
        (fees.get(item.id) ?? 0),
    );
  }
  return total;
};

/**
 * The amount `refundFullOrder` sends to Stripe: the order's total paid
 * (`computeExpectedPaymentAmount`, tax included) split over every ticket item
 * by `allocateFullRefundShares`, less each item's share of Stripe's fee. On
 * an order whose tax is split per PLATFORM line the per-item paid amount is
 * `base + per-line tax`, exactly as `refundFullOrder` pays it.
 */
export const seedFullRefundCents = (
  ticketItems: SeedTicketItem[],
  order: {
    amountGrossCents: number;
    feesPlatformCents: number;
    taxAmountCents: number;
    /** The order's tax lines when the seed has them; absent → single weight. */
    taxLines?: ReadonlyArray<RefundTaxLineLike>;
  },
  stripeFeeCents: number,
): number => {
  const items = ticketItems.map((item) => ({ ...item, kind: "ticket" }));
  const totalPaidCents = computeExpectedPaymentAmount({ ...order, items });
  const { perLinePaidByItem } = allocateRefundTaxSharesForOrder({
    useCase: "seed",
    order: { id: "seed", ...order, items },
    ticketItems,
    taxLines: order.taxLines ?? [],
  });
  const shares = allocateFullRefundShares(
    ticketItems as unknown as Parameters<typeof allocateFullRefundShares>[0],
    totalPaidCents,
    stripeFeeCents,
    perLinePaidByItem,
  );
  return ticketItems.reduce(
    (sum, item) => sum + shares.netRefundCentsForItem(item.id),
    0,
  );
};
