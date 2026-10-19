import { z } from "zod";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { computePlatformFeePerTicketCents } from "../../lib/pricing/compute-ticket-price-for-agreement";
import { estimateOrderTotal } from "../../lib/pricing/estimate-order-total";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import { taxImpositionSchema } from "./_shared/tax-imposition-schema";
import { estimateBuyerTicketPricingForEvent } from "./_shared/estimate-buyer-ticket-pricing";
import { resolveEventTaxSitus } from "./_shared/resolve-event-tax-rate";
import {
  resolveQuoteTaxRate,
  type QuoteTaxRateLookupDeps,
} from "./_shared/resolve-quote-tax-rate";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const estimateCheckoutTaxInputSchema = z
  .object({
    eventId: z.uuid(),
    items: z
      .array(
        z.object({
          ticketTypeId: z.uuid(),
          qty: z.number().int().positive(),
          /**
           * The buyer-chosen amount for a pay-what-you-want (ADJUSTABLE) tier —
           * the same field `createCheckout` / `updateOrderItems` take. It IS
           * the line's face: taxed (and, under a BUYER_TOTAL base, fee'd)
           * exactly like a fixed price of that amount, and capped at
           * MAX_DONATION_AMOUNT_CENTS. Ignored for FIXED tiers. Omitted on an
           * ADJUSTABLE tier ⇒ priced at the tier's FLOOR (`minimumCents`,
           * 0 when unset), never its meaningless stored $0.
           */
          donationAmountCents: donationAmountCentsSchema.optional(),
        }),
      )
      .min(1),
    /**
     * billingAddress is accepted but **ignored** — tax is calculated from the
     * event-venue rate (see the use case doc), never the buyer's address. The field is kept for backward
     * compatibility so existing clients don't break.
     */
    billingAddress: z
      .object({
        line1: z.string().min(1),
        city: z.string().min(1),
        state: z.string().min(1),
        postalCode: z.string().min(1),
        country: z.string().min(1).max(2),
      })
      .optional(),
  })
  .strict();

export const estimateCheckoutTaxOutputSchema = z.object({
  taxAmountCents: z.number().int().nonnegative(),
  /** Tax rate in basis points (e.g. 825 = 8.25%). Null when no rate is set. */
  taxRateBps: z.number().int().nonnegative().nullable(),
  /**
   * Every tax line the quote applied (SALES first, then any local imposition),
   * the same shape `getCheckoutFeeRates` returns. `taxAmountCents` is the sum
   * of the PLATFORM lines; `taxRateBps` stays the SALES rate for older clients.
   */
  taxImpositions: z.array(taxImpositionSchema),
});

export type EstimateCheckoutTaxInput = z.infer<
  typeof estimateCheckoutTaxInputSchema
>;
export type EstimateCheckoutTaxOutput = z.infer<
  typeof estimateCheckoutTaxOutputSchema
>;

export type EstimateCheckoutTaxDeps = {
  repos: Pick<
    Repos,
    // Beyond `events`: the venue situs (`places` / `savedLocations`) decides the
    // TAXABLE BASE, and in a `BUYER_TOTAL` jurisdiction the base includes the
    // buyer's platform + processing fees — which means this estimate needs the
    // fee policy (`payoutTerms` / `feePolicies`) too. A tax line computed on the
    // face alone would sit ~`rate × fees` below what checkout charges.
    "events" | "payoutTerms" | "feePolicies" | "places" | "savedLocations"
  >;
  /**
   * Required (FR-003). The tax basis must be the same subtotal create-checkout
   * computes; estimating tax off the pre-flip price would show the buyer an
   * "Est. tax" line that does not match the charge.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The tax-provider lookup for a venue with no cached rate, as in
   * `getCheckoutFeeRates` (looked up once per venue, cached there). Absent =
   * no lookup.
   */
  taxLookup?: QuoteTaxRateLookupDeps | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public endpoint — estimates tax for a set of ticket items at the
 * event-venue admission tax rate: the rate stamped on the Event row
 * (`admissionTaxRateBps`), or for an unstamped event the rate checkout would
 * resolve (`resolveQuoteTaxRate`): the venue's cached rate, else one provider
 * lookup that is cached on the venue. A FAILED lookup refuses with
 * `TAX_RATE_UNAVAILABLE` rather than estimate 0.
 *
 * Called from the checkout UI so the order summary can show an "Est." tax
 * line *before* the buyer clicks "Continue".
 */
export async function estimateCheckoutTax(
  deps: EstimateCheckoutTaxDeps,
  rawInput: unknown,
): Promise<EstimateCheckoutTaxOutput> {
  const logger = deps.logger?.child({ useCase: "estimateCheckoutTax" });

  const execute = async () => {
    const input = parseInput(estimateCheckoutTaxInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_ON_SALE");
    }

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    const ticketTypeMap = new Map(ticketTypes.map((tt) => [tt.id, tt]));

    // Build line items the same way create-checkout does — including resolving
    // each unit price through the ONE resolver at a single `now` (FR-004), so
    // the estimate and the charge agree across a scheduled flip.
    const now = deps.clock.now();
    const lines: Array<{
      ticketTypeId: string;
      faceCents: number;
      qty: number;
      /** True for a buyer-priced line: no pre-computed estimate row fits it. */
      buyerPriced: boolean;
    }> = [];
    for (const item of input.items) {
      const tt = ticketTypeMap.get(item.ticketTypeId);
      if (!tt) {
        throw fail("TICKET_TYPE_NOT_FOUND");
      }
      // ADJUSTABLE: the buyer's amount is the unit price, as in
      // `computeOrderAmounts` — no schedule applies to a buyer-named price.
      // Without an amount it is quoted at its floor (the least the charge
      // will accept), never at the meaningless stored $0.
      const buyerPriced = tt.pricingMode === "ADJUSTABLE";
      const unitPriceCents = buyerPriced
        ? (item.donationAmountCents ?? Math.max(0, tt.minimumCents ?? 0))
        : resolveUnitPriceCents(tt, { now });
      // A free FIXED tier has no tax and no row fee. A $0 PWYW line is KEPT:
      // the policy's minimum / fixed fee still applies to it in a paid order,
      // and under BUYER_TOTAL that fee is taxed.
      if (unitPriceCents === 0 && !buyerPriced) continue;

      lines.push({
        ticketTypeId: tt.id,
        faceCents: unitPriceCents,
        qty: item.qty,
        buyerPriced,
      });
    }

    // Every imposition the venue's situs owes: the SALES line (the stamped
    // rate on its jurisdictional base — `TICKET_FACE` everywhere but Tennessee,
    // which reduces to the historical `round(subtotal × rate)`) plus any local
    // line. A `BUYER_TOTAL` line puts the buyer's platform and processing fees
    // inside its base, so the estimate has to run the whole order-level solve
    // rather than multiply the subtotal.
    //
    // A NULL stamp is "unresolved", not 0%: checkout resolves it live, and so
    // does this estimate (`resolveQuoteTaxRate`: the cached venue rate, the
    // Canada table, else one provider lookup cached on the venue).
    //
    // A FAILED lookup refuses (owner ruling 2026-10-06): the output has no
    // "tax unknown" value (`taxAmountCents` is non-nullable), and a 0 would
    // be shown as the buyer's tax. The checkout page then falls back to the
    // hold's own server-stamped tax. Reported where the lookup ran.
    const situs = await resolveEventTaxSitus(deps.repos, event);
    const quote = await resolveQuoteTaxRate(
      { repos: deps.repos, clock: deps.clock, lookup: deps.taxLookup ?? null },
      event,
      situs,
      logger,
    );
    if (!quote.known && quote.reason === "lookup_failed") {
      throw fail("TAX_RATE_UNAVAILABLE");
    }
    const salesTaxRateBps = quote.known ? quote.rateBps : null;
    const taxImpositions = resolveTaxImpositions({
      situs,
      salesTaxRateBps: salesTaxRateBps ?? 0,
    });
    const platformLines = taxImpositions.filter(
      (line) => line.collector === "PLATFORM",
    );
    // What the buyer is charged at, summed across PLATFORM lines. With the
    // single SALES line every jurisdiction has today this IS the stamped rate.
    const taxRateBps = platformLines.reduce(
      (sum, line) => sum + line.rateBps,
      0,
    );

    let estimateRowByTicketType = new Map<
      string,
      { unitPriceCents: number; platformFeeCents: number }
    >();
    let feeMode: "ABSORB" | "PASS_THROUGH" | null = null;
    let processorPct = 0;
    let processorFixedCents = 0;
    let maxPlatformFeeCents: number | null = null;
    let platformFeeRates: Parameters<
      typeof computePlatformFeePerTicketCents
    >[1] | null = null;
    const needsBuyerFees =
      platformLines.some((line) => line.base === "BUYER_TOTAL") &&
      lines.length > 0;
    if (needsBuyerFees) {
      const estimate = await estimateBuyerTicketPricingForEvent(
        deps,
        event,
        ticketTypes,
        { taxImpositions },
      );
      feeMode = estimate.feeMode;
      estimateRowByTicketType = new Map(
        estimate.perTicketEstimates.map((row) => [
          row.ticketTypeId,
          {
            unitPriceCents: row.unitPriceCents,
            platformFeeCents: row.platformFeeCents,
          },
        ]),
      );
      // The estimator already resolved the fee policy to price the tickets —
      // take the numeric rates from it rather than cascading a second time.
      processorPct = estimate.processorPct ?? 0;
      processorFixedCents = estimate.processorFixedCents ?? 0;
      maxPlatformFeeCents = estimate.maxPlatformFeeCents;
      platformFeeRates = estimate.platformFeeRates;
    }

    const { taxCents } = estimateOrderTotal({
      items: lines.map((line) => {
        // The estimator only prices ACTIVE tiers, so a requested-but-inactive
        // type has no row. Under BUYER_TOTAL the fee is part of the taxable
        // base, and a tier checkout would refuse must not be quoted a tax at
        // all — refuse, for buyer-priced lines exactly as for fixed ones.
        const row = estimateRowByTicketType.get(line.ticketTypeId);
        if (needsBuyerFees && !row) {
          throw fail("TICKET_TYPE_NOT_FOUND");
        }
        if (line.buyerPriced) {
          // The ADJUSTABLE row is priced at the tier's floor, not at this
          // amount, so it is never read here. The fee is the policy's fee ON
          // the amount —
          // the same function `computeOrderAmounts` charges with. Only read
          // under a BUYER_TOTAL base; elsewhere the fee never reaches the tax.
          return {
            faceCents: line.faceCents,
            platformFeePerTicketCents:
              needsBuyerFees && platformFeeRates
                ? computePlatformFeePerTicketCents(
                    line.faceCents,
                    platformFeeRates,
                  )
                : 0,
            qty: line.qty,
          };
        }
        // Face AND fee from the same row when the estimator ran: it reads the
        // clock itself, so pairing its platform fee with a face resolved
        // against a different instant could straddle a scheduled flip and tax a
        // combination no order will ever be charged.
        return {
          faceCents: row?.unitPriceCents ?? line.faceCents,
          platformFeePerTicketCents: row?.platformFeeCents ?? 0,
          qty: line.qty,
        };
      }),
      taxImpositions,
      feeMode,
      processorPct,
      processorFixedCents,
      maxPlatformFeeCents,
    });

    return estimateCheckoutTaxOutputSchema.parse({
      taxAmountCents: taxCents,
      taxRateBps: taxRateBps > 0 ? taxRateBps : null,
      taxImpositions,
    });
  };

  if (logger) {
    return logger.withTime("estimateCheckoutTax", execute);
  }

  return execute();
}
