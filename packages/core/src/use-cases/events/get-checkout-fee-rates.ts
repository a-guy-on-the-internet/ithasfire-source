import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { FeePolicyRecord, FeePolicyScopeType } from "@th/types";

import { parseInput } from "../../lib/io";
import { FeeMode } from "../../lib/pricing/compute-ticket-price-for-agreement";
import {
  PROCESSING_COST_SCHEDULE,
  formatProcessingCostLabel,
} from "../../lib/pricing/processing-cost-schedule";
import { formatRateLabel } from "../../lib/pricing/format-rate-label";
import { resolveTaxableBase } from "../../lib/pricing/taxable-base";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import {
  taxImpositionSchema,
  uniformPlatformTaxBase,
} from "./_shared/tax-imposition-schema";
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

export const getCheckoutFeeRatesInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

const ticketFeeEstimateSchema = z.object({
  ticketTypeId: z.uuid(),
  unitPriceCents: z.number().int().nonnegative(),
  platformFeeCents: z.number().int().nonnegative(),
  processorFeeCents: z.number().int().nonnegative(),
  taxEstimateCents: z.number().int().nonnegative(),
  buyerUnitTotalCents: z.number().int().nonnegative(),
});

const processingMethodRateSchema = z.object({
  /** Stripe PaymentElement `value.type` identifier */
  methodType: z.string(),
  /** Human-readable method name */
  label: z.string(),
  /** Human-readable rate string, e.g. "2.9% + $0.30" or "0.8% (capped at $5.00)" */
  rateLabel: z.string(),
});

export const getCheckoutFeeRatesOutputSchema = z.object({
  eventId: z.uuid(),
  feeMode: z.enum(["ABSORB", "PASS_THROUGH"]).nullable(),
  /**
   * Admission tax rate in basis points (e.g. 975 = 9.75%) that this quote
   * taxed at: the event's stamp, or for an unstamped event the rate checkout
   * resolves (`resolveQuoteTaxRate` — a cached venue rate, the Canada table,
   * 0 for an event with no location, else a provider lookup by address that
   * is cached on the venue). A FAILED lookup refuses the quote with
   * `TAX_RATE_UNAVAILABLE` instead (owner ruling 2026-10-06, superseding the
   * 2026-10-04 one that let it tax at 0), so clients show "Calculating
   * total…", never a 0% figure. Null only where checkout charges 0 too (an
   * unsupported province, a provider that answered "no rate here", no
   * provider configured); the per-ticket rows are then taxed at 0.
   */
  admissionTaxRateBps: z.number().int().nonnegative().nullable(),
  /**
   * WHAT the venue's jurisdiction applies that rate to:
   *  - `TICKET_FACE` — the admission price only (every jurisdiction but one).
   *  - `BUYER_TOTAL` — face + platform fee + processing fee (Tennessee).
   *
   * Clients MUST pass this straight into `estimateOrderTotal`; computing a cart
   * total without it under-quotes a Tennessee buyer by `rate × fees` against
   * what checkout charges.
   */
  taxableBase: z.enum(["TICKET_FACE", "BUYER_TOTAL"]),
  /**
   * EVERY tax the admission owes, one line each (SALES first, then any local
   * imposition for the venue's situs) — see `lib/pricing/tax-impositions.ts`.
   * Only `collector: "PLATFORM"` lines are charged to the buyer; ORGANISER
   * lines are the venue's to remit and are listed for disclosure.
   *
   * Clients MUST pass this straight into `estimateOrderTotal` as
   * `taxImpositions`. It supersedes `admissionTaxRateBps` + `taxableBase` for
   * money math (those two describe the SALES line only and stay for display
   * and older clients); a total computed from them alone drops any local tax
   * the charge includes.
   */
  taxImpositions: z.array(taxImpositionSchema),
  /**
   * The ONE base every PLATFORM (buyer-charged) imposition shares, derived
   * from `taxImpositions`: `TICKET_FACE` or `BUYER_TOTAL` when they all agree,
   * null when they differ (e.g. SALES on the buyer total + a local tax on the
   * face) or when there are none. Clients use it to decide whether a single
   * "(x.xx%)" rate label is honest: with null, one label would misstate the
   * base of at least one line, so show the lines individually.
   */
  uniformTaxBase: z.enum(["TICKET_FACE", "BUYER_TOTAL"]).nullable(),
  /**
   * Human-readable rate label for the platform (buyer) fee, e.g. "10% + $0.50".
   * Null when no fee policy is resolved.
   */
  platformFeeLabel: z.string().nullable(),
  /**
   * Human-readable rate label for the processor fee, e.g. "2.9% + $0.30".
   * Null when no fee policy is resolved.
   */
  processorFeeLabel: z.string().nullable(),
  /**
   * Per-payment-method processing rate labels.
   * Clients display these so buyers see the exact rate for each method.
   */
  processingMethodRates: z.array(processingMethodRateSchema),
  /**
   * Processor percentage rate as a decimal (e.g. 0.029 = 2.9%) — the numeric
   * twin of `processorFeeLabel`, needed by `estimateOrderTotal` to reproduce
   * the order-level gross-up. Null unless fee mode is PASS_THROUGH (the buyer
   * doesn't fund the processor fee otherwise).
   */
  processorPct: z.number().nonnegative().nullable(),
  /** Processor per-ORDER fixed fee in cents (e.g. 30 = $0.30). Null unless PASS_THROUGH. */
  processorFixedCents: z.number().int().nonnegative().nullable(),
  /**
   * Order-level platform fee cap across all tickets
   * (`FeePolicy.maxPlatformFeeCents`). Null when uncapped or not PASS_THROUGH.
   */
  maxPlatformFeeCents: z.number().int().nonnegative().nullable(),
  /**
   * The per-ticket platform-fee RATES (the inputs to
   * `computePlatformFeePerTicketCents`), so a client can quote the fee on a
   * pay-what-you-want amount the buyer is still typing: an ADJUSTABLE tier's
   * row below is priced at its FLOOR (`minimumCents`) and says nothing about
   * the fee on the $15 they typed. The numeric twin of `platformFeeLabel`,
   * exposing nothing that label does not already print. Null unless
   * PASS_THROUGH.
   */
  platformFeeRates: z
    .object({
      buyerFeePct: z.number().nonnegative(),
      maxFeeCents: z.number().int().nonnegative().nullable(),
      minFeeCents: z.number().int().nonnegative(),
      platformFixedCents: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * Per-ticket-type fee estimates (qty=1). `buyerUnitTotalCents` is exact ONLY
   * at qty=1 — the per-order fixed processor fee and single tax rounding mean
   * a cart total is NOT unitTotal × qty. Clients must compute cart totals with
   * `estimateOrderTotal` (packages/core/src/lib/pricing/estimate-order-total.ts)
   * from these rows plus the top-level rates.
   */
  perTicketEstimates: z.array(ticketFeeEstimateSchema),
});

export type GetCheckoutFeeRatesInput = z.infer<
  typeof getCheckoutFeeRatesInputSchema
>;
export type GetCheckoutFeeRatesOutput = z.infer<
  typeof getCheckoutFeeRatesOutputSchema
>;

export type GetCheckoutFeeRatesDeps = {
  repos: Pick<
    Repos,
    // `places` / `savedLocations`: the venue SITUS decides the taxable base,
    // and the base decides the quote. Two point reads at worst, none for an
    // inline address — see `resolveEventTaxSitus`.
    "events" | "payoutTerms" | "feePolicies" | "places" | "savedLocations"
  >;
  /**
   * Required (FR-003) — forwarded to the shared buyer-pricing estimator, which
   * this endpoint uses to quote the buyer a total BEFORE they click Continue.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The tax-provider lookup for a venue with no cached rate: looked up ONCE
   * per venue and cached there (owner ruling 2026-10-06). Absent = no lookup
   * (older tests); a cache miss then quotes as `not_looked_up`.
   */
  taxLookup?: QuoteTaxRateLookupDeps | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public endpoint — returns per-ticket fee estimates so the checkout UI can
 * show a real-time fee/total preview *before* the buyer clicks "Continue".
 *
 * This does NOT require auth. It is read-only and exposes only the fee data
 * the buyer is already shown at checkout: aggregate amounts plus the numeric
 * processor rate / tax rate that the UI renders as labels anyway (e.g.
 * "Processing fee (2.9% + $0.30)") — needed so clients can run the exact
 * order-level total estimate (`estimateOrderTotal`). Internal policy economics
 * (payout terms, splits, margins) are never exposed.
 */
export async function getCheckoutFeeRates(
  deps: GetCheckoutFeeRatesDeps,
  rawInput: unknown,
): Promise<GetCheckoutFeeRatesOutput> {
  const logger = deps.logger?.child({ useCase: "getCheckoutFeeRates" });

  const execute = async () => {
    const input = parseInput(getCheckoutFeeRatesInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_ON_SALE");
    }

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    // The SAME venue-precedence situs the charge freezes onto the order
    // (Place → SavedLocation → inline), so the quote and the charge agree on
    // the taxable base as well as the rate.
    const situs = await resolveEventTaxSitus(deps.repos, event);
    // A NULL stamp is "unresolved", not 0%: checkout resolves it live, and so
    // does this quote — the cached venue rate, the Canada table, else ONE
    // provider lookup by address, cached on the venue for every later quote,
    // checkout and listing (`resolveQuoteTaxRate`).
    //
    // A FAILED lookup refuses the quote (owner ruling 2026-10-06): this
    // payload cannot say "tax unknown" (`buyerUnitTotalCents` and
    // `taxEstimateCents` are non-nullable, and clients total carts from
    // `taxImpositions`), so the alternative is a 0% figure below the charge.
    // Clients treat a failed fee-rates read as "no rates": "Calculating
    // total…" in checkout, the face price alone on the event page. The
    // failure was reported where the lookup ran.
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
    const estimate = await estimateBuyerTicketPricingForEvent(
      deps,
      event,
      ticketTypes,
      { taxImpositions },
    );
    const effectiveFeeMode = estimate.feeMode;

    // Rate labels (e.g. "10% + $0.50") plus the NUMERIC processor rates the
    // client-side order estimator needs to reproduce the server's gross-up.
    // Only resolved for PASS_THROUGH — in ABSORB the buyer never funds these
    // fees, so neither the labels nor the numbers are needed.
    const passThroughPolicy =
      effectiveFeeMode === FeeMode.PASS_THROUGH
        ? ((await resolveFeeContext(deps, event, logger))?.feePolicy ?? null)
        : null;
    const platformFeeLabel = passThroughPolicy
      ? formatRateLabel(
          passThroughPolicy.buyerFeePct,
          passThroughPolicy.platformFixedCents,
        )
      : null;
    const processorFeeLabel = passThroughPolicy
      ? formatRateLabel(
          passThroughPolicy.processsorFeePct,
          passThroughPolicy.processorFixedCents,
        )
      : null;

    // Build per-method processing rate labels for transparent fee display
    const processingMethodRates = PROCESSING_COST_SCHEDULE.map((entry) => ({
      methodType: entry.methodType,
      label: entry.label,
      rateLabel: formatProcessingCostLabel(entry),
    }));

    return getCheckoutFeeRatesOutputSchema.parse({
      eventId: event.id,
      feeMode: effectiveFeeMode,
      // The rate the quote taxed at — the stamp, or what the quote resolved
      // for an unstamped event. Null only when it is genuinely unknown.
      admissionTaxRateBps: salesTaxRateBps,
      // The SALES base, as before (independent of the rate, so a 0-rate TN
      // event still reports BUYER_TOTAL — byte-identical payload).
      taxableBase: resolveTaxableBase(situs),
      taxImpositions: estimate.taxImpositions,
      uniformTaxBase: uniformPlatformTaxBase(estimate.taxImpositions),
      platformFeeLabel,
      processorFeeLabel,
      processingMethodRates,
      processorPct: passThroughPolicy?.processsorFeePct ?? null,
      processorFixedCents: passThroughPolicy?.processorFixedCents ?? null,
      maxPlatformFeeCents: passThroughPolicy?.maxPlatformFeeCents ?? null,
      // From the estimator, not `passThroughPolicy`: the policy that priced
      // the per-ticket rows is the one a buyer-chosen amount must be priced by.
      platformFeeRates: estimate.platformFeeRates,
      perTicketEstimates: estimate.perTicketEstimates,
    });
  };

  if (logger) {
    return logger.withTime("getCheckoutFeeRates", execute);
  }

  return execute();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FeeContext {
  feePolicy: FeePolicyRecord;
  agreement: { id: string; feeMode: string | null };
  lines: Array<{
    id: string;
    payeeId: string;
    percent: number;
    floorCents: number;
    capPercent: number | null;
    priority: number;
    rounding: "FLOOR" | "NEAREST";
  }>;
}

/**
 * Resolves fee context for a published event. Same cascade as create-checkout:
 * 1. Primary active agreement with pinned fee policy.
 * 2. Scoped cascade: EVENT → ORG → GLOBAL.
 */
async function resolveFeeContext(
  deps: GetCheckoutFeeRatesDeps,
  event: { id: string; orgId: string | null },
  logger: LoggerPort | undefined,
): Promise<FeeContext | null> {
  const terms = await deps.repos.payoutTerms.listByEvent(event.id);
  const primary =
    terms.find((t) => t.kind === "PRIMARY" && t.status === "ACTIVE") ??
    terms.find(
      (t) => (t.kind as string) === "PRIMARY_SPLIT" && t.status === "ACTIVE",
    );

  if (primary?.feePolicyId) {
    const [lines, feePolicy] = await Promise.all([
      deps.repos.payoutTerms.listLines(primary.id),
      deps.repos.feePolicies.getById(primary.feePolicyId),
    ]);

    if (feePolicy && lines.length > 0) {
      return {
        feePolicy,
        agreement: { id: primary.id, feeMode: primary.feeMode },
        lines: lines.map((l) => ({
          id: l.id,
          payeeId: l.payeeId,
          percent: l.percent,
          floorCents: l.floorCents ?? 0,
          capPercent: l.capPercent ?? null,
          priority: l.priority ?? 0,
          rounding: (l.rounding ?? "FLOOR") as "FLOOR" | "NEAREST",
        })),
      };
    }
  }

  // Fallback: scoped fee policy cascade
  const now = new Date();
  const scopes: Array<{
    scopeType: FeePolicyScopeType;
    scopeId: string | null;
  }> = [{ scopeType: "EVENT", scopeId: event.id }];
  if (event.orgId) {
    scopes.push({ scopeType: "ORG", scopeId: event.orgId });
  }
  scopes.push({ scopeType: "GLOBAL", scopeId: null });

  let feePolicy: FeePolicyRecord | null = null;
  for (const scope of scopes) {
    feePolicy = await deps.repos.feePolicies.resolveEffective({
      ...scope,
      at: now,
    });
    if (feePolicy) break;
  }

  if (!feePolicy) {
    logger?.warn("no_fee_policy_resolved", { eventId: event.id });
    return null;
  }

  // Build synthetic context from existing primary or defaults
  const agreementId = primary?.id ?? "estimate";
  const agreementFeeMode = primary?.feeMode ?? null;

  let lines: FeeContext["lines"];
  if (primary) {
    const realLines = await deps.repos.payoutTerms.listLines(primary.id);
    lines =
      realLines.length > 0
        ? realLines.map((l) => ({
            id: l.id,
            payeeId: l.payeeId,
            percent: l.percent,
            floorCents: l.floorCents ?? 0,
            capPercent: l.capPercent ?? null,
            priority: l.priority ?? 0,
            rounding: (l.rounding ?? "FLOOR") as "FLOOR" | "NEAREST",
          }))
        : [
            {
              id: "estimate-line",
              payeeId: "estimate-payee",
              percent: 100,
              floorCents: 0,
              capPercent: null,
              priority: 0,
              rounding: "FLOOR" as const,
            },
          ];
  } else {
    lines = [
      {
        id: "estimate-line",
        payeeId: "estimate-payee",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR" as const,
      },
    ];
  }

  return {
    feePolicy,
    agreement: { id: agreementId, feeMode: agreementFeeMode },
    lines,
  };
}
