import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { assertTicketTypeOnSale } from "../../lib/orders/door-pricing";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";
import {
  aggregateItems,
  computeOrderAmounts,
  loadPayoutTermsContext,
  unseatedSeatPrices,
} from "../orders/checkout-helpers";
import {
  evaluatePromoApplications,
  preparePromoCodes,
} from "../orders/checkout-promos";
import {
  lookupFeeWaiverHeadroomForHold,
  waivedTicketsForHold,
} from "../orders/fee-waiver-checkout";
import { priceCart, type PricedCart } from "../orders/_shared/price-cart";
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "../orders/_shared/resolve-checkout-tax-rate";
import { assertCanSellBeforeTaxLookup } from "./_shared/assert-can-sell-before-tax-lookup";
import { assertDoorSellsEvent } from "./_shared/door-event-gate";
import { toDoorTicketTypeSummaries } from "./_shared/door-ticket-types";
import { withManualTaxRateHint } from "./_shared/manual-tax-rate-hint";

// ── Schema ───────────────────────────────────────────────────────────────────

export const quotePosCartInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    /** The same cart lines `startSale` / `recordCashSale` take. */
    items: z
      .array(
        z
          .object({
            ticketTypeId: z.string().uuid(),
            qty: z.number().int().positive().max(100),
            /**
             * Pay-what-you-can amount PER TICKET for an ADJUSTABLE type, as
             * the sale takes it. Validated against the minimum by the same
             * pricing code.
             */
            donationAmountCents: donationAmountCentsSchema.optional(),
          })
          .strict(),
      )
      .nonempty(),
    /** The same operator-entered codes the sale would redeem. */
    promoCodes: z.array(z.string().min(1).max(64)).max(4).optional(),
    /**
     * Quote a comp (`recordCashSale` with `comp: true`): $0, no fee, no tax,
     * no lookup — what the comp records.
     */
    comp: z.boolean().optional(),
  })
  .strict();

export type QuotePosCartInput = z.infer<typeof quotePosCartInputSchema>;

const quotedTaxLineSchema = z.object({
  /** Imposition code (`SALES`, a local imposition's code). */
  code: z.string(),
  /**
   * The line's label as the order's `OrderTaxLine` stores it ("Sales tax",
   * "Minneapolis entertainment tax"), the same imposition label online
   * checkout writes.
   */
  label: z.string(),
  rateBps: z.number().int().nonnegative(),
  amountCents: z.number().int().nonnegative(),
});

const channelQuoteSchema = z.object({
  /** Ticket face BEFORE promo discounts. */
  ticketSubtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  /** Ticket face AFTER promo discounts. */
  ticketTotalCents: z.number().int().nonnegative(),
  /**
   * Platform fee the buyer pays (online checkout's "Platform fee"). Always 0
   * for cash (owner ruling 2026-10-08: cash = no platform fee).
   */
  platformFeeCents: z.number().int().nonnegative(),
  /** Online checkout's "Processing fee". Always 0 for cash. */
  processingFeeCents: z.number().int().nonnegative(),
  /** Tax the buyer is charged, one line per imposition (PLATFORM-collected). */
  taxLines: z.array(quotedTaxLineSchema),
  taxAmountCents: z.number().int().nonnegative(),
  /** What the sale charges: the card amount, or the cash total due. */
  totalCents: z.number().int().nonnegative(),
});

export const quotePosCartOutputSchema = z.object({
  eventId: z.string().uuid(),
  currency: z.string().min(3).max(3),
  isComp: z.boolean(),
  /** One line per ticket type: the face price each ticket is sold at. */
  lines: z.array(
    z.object({
      ticketTypeId: z.string().uuid(),
      qty: z.number().int().positive(),
      unitPriceCents: z.number().int().nonnegative(),
      amountCents: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Platform fee an organiser fee waiver would cover on this cart if it is
   * paid by CARD. Cash charges no platform fee, so a cash sale reserves no
   * waiver; 0 when `card` is null.
   */
  feesWaivedCents: z.number().int().nonnegative(),
  /**
   * The card total. `null` when the card till would refuse the cart
   * (`AMOUNT_MUST_BE_POSITIVE`: a comp, or a cart whose discounts leave
   * nothing to charge). Such a cart goes through cash.
   */
  card: channelQuoteSchema.nullable(),
  cash: channelQuoteSchema,
});

export type QuotePosCartOutput = z.infer<typeof quotePosCartOutputSchema>;
export type PosChannelQuote = z.infer<typeof channelQuoteSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type QuotePosCartDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Forwarded to the tax resolver and the fee-waiver estimate's reports. */
  reportError?: ReporterPort;
  /**
   * The same tax provider the sales get. An unstamped event is looked up
   * exactly as the sale looks it up, so the quote shows the tax the sale
   * charges; a failed lookup refuses (never 0%).
   */
  taxRateLookup?: TaxRateLookupPort | null;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * The Sell screen's total for a cart, BEFORE the card tap or the cash entry
 * (spec 2026-10-07 door-sales-same-price-and-tax, FR-010; owner ruling R7).
 * Replaces the tills' own `unit × qty` totals.
 *
 * BOTH CHANNELS IN ONE CALL. The operator reads the total to the buyer before
 * the buyer says "card" or "cash", and the two differ (cash is the ticket
 * price + tax only: no platform fee and no processing fee, owner ruling
 * 2026-10-08; under a buyer-total base its tax is re-solved on that base). One call
 * returns both, so the screen never shows a total that changes when the
 * operator picks the payment method, and a cart edit costs one request.
 *
 * SAME PIPELINE AS THE CHARGE. Each channel is `priceCart` with the payout
 * terms, the fee-waiver count (card only), the promo evaluation and the tax
 * impositions the sale itself uses (`startPosSale` → DOOR_CARD, `recordCashSale` →
 * DOOR_CASH), so a quote equals the charge to the cent for the same cart at
 * the same instant. Nothing here computes a price, fee or tax of its own.
 *
 * NO SALE WRITES. No transaction, no order, no seat or promo hold, no
 * fee-waiver reservation, no audit row. The fee waiver is a preview: the
 * allowance HEADROOM (`lookupFeeWaiverHeadroomForHold`, the online hold's
 * estimate), capped at the cart's fee-bearing tickets — what
 * `reserveFeeWaiverForCheckout` reserves when no other sale takes the
 * allowance first. The ONE write is the tax self-heal after a fresh provider
 * lookup (the event's stamp and the location's rate cache, compare-and-set,
 * never throwing), exactly as the sale and the online hold keep it, so a
 * till tapping +/- on an unstamped event pays for one lookup, not one per
 * tap.
 *
 * TAX. The same `prepareCheckoutTax` (door channel) and `resolveCheckoutTax`
 * the sale runs. A failed lookup refuses with the sale's TAX_RATE_UNAVAILABLE,
 * `meta.canEnterManualTaxRate` included (R5); never 0%. Over a hand-entered
 * rate the quote charges that rate WITHOUT asking the provider again
 * (`manualStamp: "keep"`, as the online hold does): it runs on every cart
 * edit, and the sale does the one relookup.
 *
 * Gates, all before the paid lookup: scanner role on the event's org, the
 * published-events-only rule, the scanner-terms ack, then the per-type sales
 * window and ACTIVE status (the sale's own refusals, same codes). Capacity
 * is NOT checked (it takes a row lock); the sale refuses a sold-out cart.
 */
export async function quotePosCart(
  deps: QuotePosCartDeps,
  rawInput: unknown,
): Promise<QuotePosCartOutput> {
  const input = parseInput(quotePosCartInputSchema, rawInput);
  const promoCodes = preparePromoCodes(input.promoCodes);
  // Cheap and pure: two pay-what-you-can amounts for one type are refused
  // before anything is read.
  const aggregatedItems = aggregateItems(
    input.items.map((it) => ({
      ticketTypeId: it.ticketTypeId,
      qty: it.qty,
      ...(it.donationAmountCents !== undefined
        ? { donationAmountCents: it.donationAmountCents }
        : {}),
    })),
  );

  // RBAC + the published gate, on plain reads, BEFORE the lookup (it can be
  // a paid provider call).
  const sellerAccess = await assertCanSellBeforeTaxLookup(deps, input);
  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }
  assertDoorSellsEvent(event);

  const operator = await deps.repos.humans.getById(input.actorHumanId);
  if (
    !operator?.scannerTermsAckAt ||
    operator.scannerTermsAckVersion !== SCANNER_TERMS_VERSION
  ) {
    throw fail("SCANNER_TERMS_REQUIRED");
  }

  // ONE clock read: the window gate and every priced line agree, as in the
  // sale.
  const now = deps.clock.now();
  const ticketTypes = (await deps.repos.events.listTicketTypes(event.id)).filter(
    (tt) => tt.status === "ACTIVE",
  );
  const ttById = new Map(ticketTypes.map((tt) => [tt.id, tt]));
  for (const it of aggregatedItems) {
    const tt = ttById.get(it.ticketTypeId);
    if (!tt) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }
    // The sale's window gate. Its unparseable-bound report is left to the
    // sale: the quote runs on every cart edit and would report it each time.
    assertTicketTypeOnSale(tt, now, {
      meta: { ticketTypeId: it.ticketTypeId, eventId: event.id },
    });
  }

  const currency = (event.currency ?? "usd").toLowerCase();

  if (input.comp === true) {
    // What `recordCashSale` records for a comp: $0 items, no fee, no tax, no
    // pricing and no lookup. The card till cannot take a $0 charge.
    const zero = zeroChannelQuote();
    return quotePosCartOutputSchema.parse({
      eventId: event.id,
      currency,
      isComp: true,
      lines: aggregatedItems.map((it) => ({
        ticketTypeId: it.ticketTypeId,
        qty: it.qty,
        unitPriceCents: 0,
        amountCents: 0,
      })),
      feesWaivedCents: 0,
      card: null,
      cash: zero,
    });
  }

  // ── Fee waiver: the allowance a reservation would find, reserved by nobody ─
  const waiverHeadroom = await lookupFeeWaiverHeadroomForHold({
    repos: deps.repos,
    eventId: event.id,
    // The door's buyer is anonymous: ORGANIZER-side allowances only, as the
    // sale reserves them (`buyerHumanId: null`).
    buyerHumanId: null,
    now,
    logger: deps.logger,
    reportError: deps.reportError,
    useCase: "quotePosCart",
  });

  // ── Tax: the sale's prepare, minus the relookup over a manual stamp ─────
  const preparedTax = await withManualTaxRateHint(sellerAccess, () =>
    prepareCheckoutTax(
      {
        repos: deps.repos,
        taxRateLookup: deps.taxRateLookup,
        clock: deps.clock,
        reportError: deps.reportError,
      },
      event.id,
      deps.logger,
      { channel: "door", manualStamp: "keep" },
    ),
  );

  const ticketTypeMap = toDoorTicketTypeSummaries(ticketTypes);
  const payoutTerms = await loadPayoutTermsContext(deps.repos, event.id, now, {
    logger: deps.logger,
    reportError: deps.reportError,
  });

  // The sale's first, waiver-free pass: prices every line, for the promo
  // evaluation and (when no discount applies) the fee-waiver ladder.
  // The door names no seats; a cart that does is refused rather than priced
  // without its seat overrides (seat-price-overrides spec R-004).
  const seatPrices = unseatedSeatPrices(aggregatedItems);
  const faceComputation = computeOrderAmounts(
    aggregatedItems,
    ticketTypeMap,
    payoutTerms,
    { now, seatPrices },
  );

  // The sale's promo evaluation, read-only (holds are created by the sale).
  const promoEvaluation = await evaluatePromoApplications({
    codes: promoCodes,
    tx: deps.repos,
    event,
    buyerHumanId: null,
    now,
    orderSubtotalCents: faceComputation.amountGrossCents,
    ticketLines: faceComputation.ticketLines,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  // The sale's waiver ladder: the cart priced WITH the discounts, because a
  // ticket a discount brings down to $0 pays no platform fee (owner ruling
  // 2026-10-10) and so has none to waive.
  const waivedTickets = waivedTicketsForHold(
    promoEvaluation.ticketDiscounts.length > 0
      ? computeOrderAmounts(aggregatedItems, ticketTypeMap, payoutTerms, {
          now,
          seatPrices,
          discounts: promoEvaluation.ticketDiscounts,
        })
      : faceComputation,
    waiverHeadroom.headroomTickets,
  );

  // The sale's tax resolution, outside any transaction. A FRESH provider
  // answer is kept as the sale and the online hold keep it: the event's
  // self-heal stamp and the location's rate cache, both compare-and-set and
  // never throwing (failures are reported inside). The rate is a fact about
  // the venue, not about this cart, so the operator's next tap reads it
  // instead of paying for another lookup, and a till tapping +/- cannot
  // spend the provider's rate limit that real sales need. Nothing else is
  // written. A hand-entered stamp is never replaced here: `manualStamp:
  // "keep"` above means it resolves as a stamp, which records no
  // replacement.
  const taxAfterCommit = newCheckoutTaxAfterCommit();
  const taxResolution = await withManualTaxRateHint(sellerAccess, () =>
    resolveCheckoutTax(
      {
        taxRateLookup: deps.taxRateLookup,
        clock: deps.clock,
        reportError: deps.reportError,
      },
      deps.repos,
      event,
      deps.logger,
      taxAfterCommit,
      preparedTax,
    ),
  );
  await applyCheckoutTaxSelfHeal(
    { repos: deps.repos, reportError: deps.reportError },
    taxAfterCommit,
    deps.logger,
  );

  const priceFor = (channel: "DOOR_CARD" | "DOOR_CASH"): PricedCart =>
    priceCart({
      channel,
      items: aggregatedItems,
      ticketTypes: ticketTypeMap,
      seatPrices,
      payoutTerms,
      now,
      // Card only: cash charges no platform fee, so `recordCashSale`
      // reserves no waiver (and `priceCart` refuses a waived cash cart).
      ...(channel === "DOOR_CARD" && waivedTickets > 0
        ? { waivedTickets }
        : {}),
      promo: promoEvaluation,
      taxImpositions: taxResolution.impositions,
    });

  const cash = priceFor("DOOR_CASH");
  // `startPosSale` refuses a cart with nothing to charge (AMOUNT_MUST_BE_POSITIVE),
  // before and after the promo.
  const cardChargeable =
    faceComputation.amountGrossCents > 0 &&
    faceComputation.amountGrossCents - promoEvaluation.totalDiscountCents > 0;
  const card = cardChargeable ? priceFor("DOOR_CARD") : null;

  return quotePosCartOutputSchema.parse({
    eventId: event.id,
    currency,
    isComp: false,
    lines: cash.ticketLines.map((line) => ({
      ticketTypeId: line.ticketTypeId,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.lineGrossCents,
    })),
    feesWaivedCents: card?.feesWaivedCents ?? 0,
    card: card ? toChannelQuote(card) : null,
    cash: toChannelQuote(cash),
  });
}

function toChannelQuote(priced: PricedCart): PosChannelQuote {
  return {
    ticketSubtotalCents: priced.faceCents,
    discountCents: priced.discountCents,
    ticketTotalCents: Math.max(0, priced.amountGrossCents),
    platformFeeCents: priced.buyerFeesCents,
    processingFeeCents: priced.processorFeeCents,
    taxLines: priced.taxLines
      .filter((line) => line.collector === "PLATFORM")
      .map((line) => ({
        code: line.code,
        label: line.label,
        rateBps: line.rateBps,
        amountCents: line.amountCents,
      })),
    taxAmountCents: priced.taxAmountCents,
    totalCents: priced.chargeTotalCents,
  };
}

function zeroChannelQuote(): PosChannelQuote {
  return {
    ticketSubtotalCents: 0,
    discountCents: 0,
    ticketTotalCents: 0,
    platformFeeCents: 0,
    processingFeeCents: 0,
    taxLines: [],
    taxAmountCents: 0,
    totalCents: 0,
  };
}
