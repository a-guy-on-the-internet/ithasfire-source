import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { FeePoliciesRepo } from "@th/ports/repos/fee-policies";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
  PayoutTermsRepo,
} from "@th/ports/repos/payout-terms";
import type {
  EventRecord,
  EventTicketTypeSummary,
  FeePolicyRecord,
  FeePolicyScopeType,
} from "@th/types";

import {
  computeTicketPriceForAgreement,
  FeeMode,
  SALE_FEE_MODE,
} from "../../../lib/pricing/compute-ticket-price-for-agreement";
import { solveTaxLinesAndProcessorFee } from "../../../lib/pricing/solve-tax-and-processor-fee";
import type { TaxImposition } from "../../../lib/pricing/tax-impositions";
import { resolveListingPriceCents } from "../../../lib/pricing/pay-what-you-want";

export type BuyerTicketFeeEstimate = {
  ticketTypeId: string;
  /**
   * The EFFECTIVE online unit price at the estimate instant — resolved through
   * `resolveUnitPriceCents` (FR-003/FR-004), never the raw `priceCents`. After
   * a scheduled flip (FR-005) this is `scheduledPriceCents`, so the fee and tax
   * arithmetic below is computed on the number checkout will actually charge.
   */
  unitPriceCents: number;
  platformFeeCents: number;
  processorFeeCents: number;
  taxEstimateCents: number;
  buyerUnitTotalCents: number;
};

/** The policy fields `computePlatformFeePerTicketCents` reads. */
export type PlatformFeeRates = {
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
};

export type BuyerTicketPricingEstimateResult = {
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  admissionTaxRateBps: number | null;
  /** The impositions these estimates were computed under (echoed back). */
  taxImpositions: ReadonlyArray<TaxImposition>;
  /**
   * Numeric processor rates from the resolved fee policy — what the ORDER-level
   * solve (`estimateOrderTotal`) needs to reproduce the gross-up. Null unless
   * the effective fee mode is PASS_THROUGH (otherwise the buyer funds no
   * processor fee and there is nothing to reproduce).
   */
  processorPct: number | null;
  processorFixedCents: number | null;
  /** `FeePolicy.maxPlatformFeeCents` — the ORDER-level platform fee cap. */
  maxPlatformFeeCents: number | null;
  /**
   * The per-ticket platform-fee rates of the resolved policy — the inputs to
   * `computePlatformFeePerTicketCents`. A pay-what-you-want (ADJUSTABLE) tier
   * has no list price to pre-compute a row from: its face is whatever the
   * buyer types, and the fee is charged on THAT amount exactly as on a fixed
   * price. A client needs the rates to quote it. Null unless PASS_THROUGH (in
   * ABSORB the buyer funds no platform fee).
   */
  platformFeeRates: PlatformFeeRates | null;
  perTicketEstimates: BuyerTicketFeeEstimate[];
  minBuyerUnitTotalCents: number | null;
  maxBuyerUnitTotalCents: number | null;
};

export type BuyerTicketPricingOptions = {
  /**
   * EVERY tax the admission owes, from
   * `resolveTaxImpositions({ situs, salesTaxRateBps: event.admissionTaxRateBps ?? 0 })`
   * (`lib/pricing/tax-impositions.ts`) — the SALES line on its jurisdictional
   * base plus any local imposition. The rate and base the estimate taxes at
   * come ONLY from here; `event.admissionTaxRateBps` is just echoed back.
   *
   * REQUIRED, DELIBERATELY. This estimator is the hub for every buyer-facing
   * price preview — card badges, tier panels, the checkout fee preview, seat
   * pickers with per-seat overrides, embeds, JSON-LD, the search index — and
   * every one of them quotes a number a buyer expects to pay. A defaulted
   * `taxableBase` is what let four of those surfaces silently keep the
   * pre-Tennessee base while looking migrated (a $500 override seat quoted ~$4
   * under the charge); a defaulted imposition list would drop a city tax the
   * charge includes. Required turns a missed caller into a compile error.
   *
   * THREADED IN, NOT RE-RESOLVED: the situs lives behind a Place /
   * SavedLocation read (`resolveEventTaxSitus`, or
   * `resolveEventTaxSitusBatch` for a reindex), which the caller already has
   * the repos and the batching context for.
   */
  taxImpositions: ReadonlyArray<TaxImposition>;
};

export type BuyerTicketPricingDeps = {
  repos: Pick<Repos, "events" | "payoutTerms" | "feePolicies">;
  /**
   * REQUIRED (FR-003). This estimator is the hub every buyer-facing price
   * preview flows through — the card badge, the tier panel, the checkout fee
   * preview, the seat picker, the embeds and the search index all call it. A
   * defaulted clock here would let every one of them silently keep quoting the
   * pre-flip price while looking migrated, which is exactly the R-001 failure.
   * Making it required turns a missed caller into a compile error.
   */
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The fee terms one event's buyer prices are computed under: its resolved
 * policy, plus the agreement + lines `computeTicketPriceForAgreement` reads.
 * `null` (where a context is expected) = no policy resolved at any scope, so the
 * buyer pays face + tax.
 *
 * Exported so a caller pricing MANY events can resolve every context in a
 * bounded number of queries ({@link resolveBuyerFeeContexts}) and then run the
 * same pure arithmetic ({@link computeBuyerTicketPricing}) per event.
 */
export type BuyerFeeContext = {
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
};

export async function estimateBuyerTicketPricingForEvent(
  deps: BuyerTicketPricingDeps,
  event: Pick<EventRecord, "id" | "orgId" | "admissionTaxRateBps">,
  ticketTypes: EventTicketTypeSummary[],
  options: BuyerTicketPricingOptions,
): Promise<BuyerTicketPricingEstimateResult> {
  // ONE instant for the whole estimate — see the note on `perTicketEstimates`.
  // Also feeds the fee-policy `resolveEffective` lookup so the policy and the
  // ticket price are read against the same moment.
  const now = deps.clock.now();
  const ctx = await resolveFeeContext(deps, event, now, deps.logger);
  return computeBuyerTicketPricing(ctx, event, ticketTypes, options, now);
}

/**
 * The arithmetic half of {@link estimateBuyerTicketPricingForEvent}: no I/O,
 * given the event's already-resolved fee context and the evaluation instant.
 *
 * Split out so a listing page can resolve N contexts in a fixed number of
 * queries ({@link resolveBuyerFeeContexts}) and still price every event through
 * THIS code — never a second copy of the fee and tax math. The single-event
 * estimator is exactly "resolve one context, then this".
 */
export function computeBuyerTicketPricing(
  ctx: BuyerFeeContext | null,
  event: Pick<EventRecord, "admissionTaxRateBps">,
  ticketTypes: readonly EventTicketTypeSummary[],
  options: BuyerTicketPricingOptions,
  /** The caller's single evaluation instant (the same one the context was resolved at). */
  now: Date,
): BuyerTicketPricingEstimateResult {
  const taxLines = options.taxImpositions;
  const activeTicketTypes = ticketTypes.filter(
    (ticketType) => ticketType.status === "ACTIVE",
  );
  // Every new sale is priced fees-on-top (SALE_FEE_MODE); the terms' and
  // policy's stored modes are not read. `null` still means "no fee policy
  // resolved at any scope", where the buyer pays face + tax.
  const effectiveFeeMode: FeeMode | null = ctx ? SALE_FEE_MODE : null;

  // `now` is resolved ONCE above. Reading the clock per tier could straddle a
  // flip mid-loop and quote two tiers of the same event against different
  // prices — the same "no code path disagreeing" rule create-checkout follows
  // for a single order.
  const perTicketEstimates = activeTicketTypes.map((ticketType) => {
    // FR-004: the effective price at `now`, not the raw list price — the same
    // unit price checkout and the door charge.
    //
    // A pay-what-you-want tier is quoted at its FLOOR (`minimumCents`), the
    // least a buyer can pay — fees and tax computed on it like any price. Its
    // stored $0 made every listing (cards, search, JSON-LD, the event page's
    // "from" price) call a $5-minimum tier "Free". Floor 0 stays genuinely
    // free. The charge never reads these rows for an ADJUSTABLE line: it is
    // priced at the buyer's `donationAmountCents`.
    const unitPriceCents = resolveListingPriceCents(ticketType, now);
    return quoteUnitPrice(
      ctx,
      effectiveFeeMode,
      taxLines,
      ticketType.id,
      unitPriceCents,
    );
  });

  const buyerTotals = perTicketEstimates.map(
    (estimate) => estimate.buyerUnitTotalCents,
  );

  const passThroughPolicy =
    ctx && effectiveFeeMode === FeeMode.PASS_THROUGH ? ctx.feePolicy : null;

  return {
    feeMode: effectiveFeeMode,
    admissionTaxRateBps: event.admissionTaxRateBps ?? null,
    taxImpositions: taxLines,
    processorPct: passThroughPolicy?.processsorFeePct ?? null,
    processorFixedCents: passThroughPolicy?.processorFixedCents ?? null,
    maxPlatformFeeCents: passThroughPolicy?.maxPlatformFeeCents ?? null,
    platformFeeRates: passThroughPolicy
      ? {
          buyerFeePct: passThroughPolicy.buyerFeePct,
          maxFeeCents: passThroughPolicy.maxFeeCents ?? null,
          minFeeCents: passThroughPolicy.minFeeCents ?? 0,
          platformFixedCents: passThroughPolicy.platformFixedCents ?? 0,
        }
      : null,
    perTicketEstimates,
    minBuyerUnitTotalCents: buyerTotals.length
      ? Math.min(...buyerTotals)
      : null,
    maxBuyerUnitTotalCents: buyerTotals.length
      ? Math.max(...buyerTotals)
      : null,
  };
}

/**
 * The fee + tax arithmetic for ONE unit price, given a resolved fee context.
 * The single copy of it: the per-ticket-type estimates above and the per-seat
 * override quote ({@link estimateBuyerUnitPricesForEvent}) both run through it,
 * so a seat's quoted all-in total cannot drift from a tier's.
 */
function quoteUnitPrice(
  ctx: BuyerFeeContext | null,
  effectiveFeeMode: FeeMode | null,
  taxLines: ReadonlyArray<TaxImposition>,
  ticketTypeId: string,
  unitPriceCents: number,
): BuyerTicketFeeEstimate {
  if (unitPriceCents === 0) {
    return {
      ticketTypeId,
      unitPriceCents: 0,
      platformFeeCents: 0,
      processorFeeCents: 0,
      taxEstimateCents: 0,
      buyerUnitTotalCents: 0,
    } satisfies BuyerTicketFeeEstimate;
  }

  if (!ctx || effectiveFeeMode !== FeeMode.PASS_THROUGH) {
    // Nothing is passed through, so the buyer pays face + tax and the base is
    // the face in every jurisdiction — the solver enforces that rather than
    // trusting this branch to remember it.
    const { taxCents: taxEstimateCents } = solveTaxLinesAndProcessorFee({
      taxableGrossCents: unitPriceCents,
      buyerPlatformFeeCents: 0,
      taxLines,
      passThrough: false,
      processorPct: 0,
      processorFixedCents: 0,
    });

    return {
      ticketTypeId,
      unitPriceCents,
      platformFeeCents: 0,
      processorFeeCents: 0,
      taxEstimateCents,
      buyerUnitTotalCents: unitPriceCents + taxEstimateCents,
    } satisfies BuyerTicketFeeEstimate;
  }

  const result = computeTicketPriceForAgreement({
    qty: 1,
    unitPriceCents,
    agreement: {
      id: ctx.agreement.id,
      feeMode: ctx.agreement.feeMode as FeeMode | undefined,
      lines: ctx.lines.map((line) => ({
        id: line.id,
        payeeId: line.payeeId,
        percent: line.percent,
        floorCents: line.floorCents,
        capPercent: line.capPercent,
        priority: line.priority,
        rounding: line.rounding,
      })),
      policy: {
        id: ctx.feePolicy.id,
        version: ctx.feePolicy.version,
        feeMode: ctx.feePolicy.feeMode as FeeMode,
        processsorFeePct: ctx.feePolicy.processsorFeePct,
        processorFixedCents: ctx.feePolicy.processorFixedCents,
        payoutPct: ctx.feePolicy.payoutPct,
        payoutFixedCents: ctx.feePolicy.payoutFixedCents,
        monthlyPayoutCents: ctx.feePolicy.monthlyPayoutCents,
        buyerFeePct: ctx.feePolicy.buyerFeePct,
        maxFeeCents: ctx.feePolicy.maxFeeCents,
        minFeeCents: ctx.feePolicy.minFeeCents,
        platformFixedCents: ctx.feePolicy.platformFixedCents,
      },
    },
  });

  // PASS_THROUGH: the buyer funds the processor fee. Mirror create-checkout's
  // EXACT gross-up so this pre-charge preview lands on the same total Stripe
  // will actually collect — `ceil(base*pct+fixed)` (simple markup) sits a few
  // cents low because it doesn't fund Stripe's fee on the fee itself.
  //
  // The gross-up base is everything the charge must cover except the
  // processor fee: ticket face + platform fee + tax. Under a BUYER_TOTAL base
  // the tax in turn covers the processor fee, so the two are solved together.
  //
  // NOTE: this is exact only at qty=1. The per-order fixed fee ($0.30) cannot
  // be amortized across tickets in a per-ticket preview, so a multi-ticket
  // cart's true order-level processor fee is slightly LESS than N× this
  // per-ticket estimate (Stripe charges the fixed component once per order,
  // not once per ticket). Clients must therefore NEVER multiply
  // `buyerUnitTotalCents` by quantity for a cart total — use
  // `estimateOrderTotal` (lib/pricing/estimate-order-total.ts), which
  // mirrors the order-level math exactly. The authoritative order-level fee
  // is solved in create-checkout over the whole post-tax basis.
  const { taxCents: taxEstimateCents, processorFeeCents } =
    solveTaxLinesAndProcessorFee({
      taxableGrossCents: unitPriceCents,
      buyerPlatformFeeCents: result.platformFeePerTicketCents,
      taxLines,
      passThrough: true,
      processorPct: ctx.feePolicy.processsorFeePct,
      processorFixedCents: ctx.feePolicy.processorFixedCents,
    });

  return {
    ticketTypeId,
    unitPriceCents,
    platformFeeCents: result.platformFeePerTicketCents,
    processorFeeCents,
    taxEstimateCents,
    buyerUnitTotalCents:
      unitPriceCents +
      result.platformFeePerTicketCents +
      processorFeeCents +
      taxEstimateCents,
  } satisfies BuyerTicketFeeEstimate;
}

/**
 * Quote already-resolved unit prices (cents) for one event: the buyer-facing
 * fee and tax on each. For a price that did not come from a ticket type's own
 * schedule, e.g. a per-seat override resolved by `resolveSeatUnitPriceCents`.
 * Keyed by unit price; `ticketTypeId` on each estimate is the empty string.
 */
export async function estimateBuyerUnitPricesForEvent(
  deps: BuyerTicketPricingDeps,
  event: Pick<EventRecord, "id" | "orgId">,
  unitPricesCents: readonly number[],
  options: BuyerTicketPricingOptions,
): Promise<Map<number, BuyerTicketFeeEstimate>> {
  const now = deps.clock.now();
  const ctx = await resolveFeeContext(deps, event, now, deps.logger);
  const feeMode: FeeMode | null = ctx ? SALE_FEE_MODE : null;
  const out = new Map<number, BuyerTicketFeeEstimate>();
  for (const cents of new Set(unitPricesCents)) {
    out.set(
      cents,
      quoteUnitPrice(ctx, feeMode, options.taxImpositions, "", cents),
    );
  }
  return out;
}

/**
 * How many cents the buyer's platform fee falls by when some tickets of a cart
 * carry no fee: the tickets a promo code or a membership benefit brings down
 * to $0 (owner ruling 2026-10-10, `lib/orders/discounted-to-zero.ts`).
 *
 * Mirrors the charge (`computeOrderAmounts`): those tickets' fees come off
 * BEFORE the order-level cap, so the answer is
 * `min(Σ every fee, cap) − min(Σ the fees that remain, cap)`, not the sum of
 * the removed fees. Resolved through the same fee context and the same
 * per-unit quote as the estimate rows a client holds, so a client that
 * subtracts this from its own platform-fee estimate lands on the charge's.
 *
 * 0 when no fee policy resolves (the buyer pays no platform fee to reduce).
 * Fee waivers are not known here, as for every pre-hold estimate.
 */
export async function estimatePlatformFeeReductionForEvent(
  deps: BuyerTicketPricingDeps,
  event: Pick<EventRecord, "id" | "orgId">,
  tickets: ReadonlyArray<{ unitPriceCents: number; feeFree: boolean }>,
  /**
   * The caller's ONE evaluation instant: the same `now` its prices and its
   * discounts were resolved at, so the fee policy is not read at a second,
   * later instant.
   */
  now: Date,
): Promise<number> {
  if (!tickets.some((ticket) => ticket.feeFree)) {
    return 0;
  }
  const ctx = await resolveFeeContext(deps, event, now, deps.logger);
  if (!ctx) {
    return 0;
  }
  let everyFeeCents = 0;
  let remainingFeeCents = 0;
  for (const ticket of tickets) {
    // No tax lines: the platform fee does not depend on them.
    const fee = quoteUnitPrice(ctx, SALE_FEE_MODE, [], "", ticket.unitPriceCents)
      .platformFeeCents;
    everyFeeCents += fee;
    if (!ticket.feeFree) {
      remainingFeeCents += fee;
    }
  }
  const cap = ctx.feePolicy.maxPlatformFeeCents ?? null;
  const capped = (cents: number) => (cap != null ? Math.min(cents, cap) : cents);
  return Math.max(0, capped(everyFeeCents) - capped(remainingFeeCents));
}

async function resolveFeeContext(
  deps: BuyerTicketPricingDeps,
  event: Pick<EventRecord, "id" | "orgId">,
  /** The caller's single evaluation instant, from the injected ClockPort. */
  now: Date,
  logger: LoggerPort | undefined,
): Promise<BuyerFeeContext | null> {
  const terms = await deps.repos.payoutTerms.listByEvent(event.id);
  const primary = pickPrimaryTerms(terms);

  if (primary?.feePolicyId) {
    const [lines, feePolicy] = await Promise.all([
      deps.repos.payoutTerms.listLines(primary.id),
      deps.repos.feePolicies.getById(primary.feePolicyId),
    ]);

    if (feePolicy && lines.length > 0) {
      return agreementFeeContext(primary, feePolicy, lines);
    }
  }

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
    const found = await deps.repos.feePolicies.resolveEffective({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      at: now,
    });

    if (found) {
      feePolicy = found;
      logger?.info?.("events.buyer_pricing.fee_policy_resolved", {
        eventId: event.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        feePolicyId: found.id,
      });
      break;
    }
  }

  if (!feePolicy) {
    return null;
  }

  return scopedPolicyFeeContext(event, feePolicy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared context construction — the single and the batched resolver build every
// context through these, so the two cannot drift on precedence or shape.
// ─────────────────────────────────────────────────────────────────────────────

/** ACTIVE PRIMARY first, then ACTIVE PRIMARY_SPLIT; anything else is ignored. */
function pickPrimaryTerms(
  terms: readonly PayoutTermsRecord[],
): PayoutTermsRecord | undefined {
  return (
    terms.find((term) => term.kind === "PRIMARY" && term.status === "ACTIVE") ??
    terms.find(
      (term) =>
        (term.kind as string) === "PRIMARY_SPLIT" && term.status === "ACTIVE",
    )
  );
}

function agreementFeeContext(
  primary: PayoutTermsRecord,
  feePolicy: FeePolicyRecord,
  lines: readonly PayoutTermsLineRecord[],
): BuyerFeeContext {
  return {
    feePolicy,
    agreement: { id: primary.id, feeMode: primary.feeMode },
    lines: lines.map((line) => ({
      id: line.id,
      payeeId: line.payeeId,
      percent: line.percent,
      floorCents: line.floorCents ?? 0,
      capPercent: line.capPercent ?? null,
      priority: line.priority ?? 0,
      rounding: (line.rounding ?? "FLOOR") as "FLOOR" | "NEAREST",
    })),
  };
}

function scopedPolicyFeeContext(
  event: Pick<EventRecord, "id" | "orgId">,
  feePolicy: FeePolicyRecord,
): BuyerFeeContext {
  return {
    feePolicy,
    agreement: { id: `resolved:${event.id}`, feeMode: feePolicy.feeMode },
    lines: [
      {
        id: `resolved:${event.id}:line:organizer`,
        payeeId: event.orgId ?? "organizer",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
  };
}

/** The repo reads {@link resolveBuyerFeeContexts} makes — all batch reads. */
export type BuyerFeeContextBatchRepos = {
  payoutTerms: Pick<PayoutTermsRepo, "listByEventIds" | "listLinesByTermsIds">;
  feePolicies: Pick<
    FeePoliciesRepo,
    "getByIds" | "resolveEffectiveForScopes" | "resolveEffective"
  >;
};

/**
 * {@link resolveFeeContext} for MANY events, in a bounded number of queries
 * that does not grow with the number of events:
 *
 *   1–2. `payoutTerms.listByEventIds` (the events' terms pointers, the terms);
 *   3.   `payoutTerms.listLinesByTermsIds` — lines of every pinned primary;
 *   4.   `feePolicies.getByIds` — every pinned policy;
 *   5.   `feePolicies.resolveEffectiveForScopes` EVENT;
 *   6.   `feePolicies.resolveEffectiveForScopes` ORG;
 *   7.   `feePolicies.resolveEffective` GLOBAL, once.
 *
 * (3–4 and 5–7 are skipped when no event needs them.)
 *
 * SAME PRECEDENCE as the single path, decided per event: an ACTIVE PRIMARY
 * (else PRIMARY_SPLIT) terms row with a `feePolicyId` whose policy exists and
 * which has at least one line wins; otherwise EVENT → ORG → GLOBAL at `now`;
 * no policy anywhere ⇒ `null`. The per-scope reads fetch every scope at once
 * rather than stopping at the first hit — the RESULT is identical, the
 * `fee-pricing-batch.test.ts` parity test pins that.
 *
 * Unlike the single path it does not `logger.info` the resolved scope per
 * event: on a listing page that is one line per card per request.
 */
export async function resolveBuyerFeeContexts(
  repos: BuyerFeeContextBatchRepos,
  events: ReadonlyArray<Pick<EventRecord, "id" | "orgId">>,
  /** The caller's single evaluation instant, from the injected ClockPort. */
  now: Date,
): Promise<Map<string, BuyerFeeContext | null>> {
  const result = new Map<string, BuyerFeeContext | null>();
  if (events.length === 0) return result;

  const termsByEvent = await repos.payoutTerms.listByEventIds(
    events.map((event) => event.id),
  );
  const primaryByEvent = new Map<string, PayoutTermsRecord>();
  for (const event of events) {
    const primary = pickPrimaryTerms(termsByEvent.get(event.id) ?? []);
    if (primary?.feePolicyId) primaryByEvent.set(event.id, primary);
  }

  const pinned = [...primaryByEvent.values()];
  const [linesByTerms, policiesById] =
    pinned.length === 0
      ? [
          new Map<string, PayoutTermsLineRecord[]>(),
          new Map<string, FeePolicyRecord>(),
        ]
      : await Promise.all([
          repos.payoutTerms.listLinesByTermsIds(pinned.map((t) => t.id)),
          repos.feePolicies.getByIds(
            pinned.map((t) => t.feePolicyId as string),
          ),
        ]);

  const needsScopeWalk: Array<Pick<EventRecord, "id" | "orgId">> = [];
  for (const event of events) {
    const primary = primaryByEvent.get(event.id);
    if (primary?.feePolicyId) {
      const feePolicy = policiesById.get(primary.feePolicyId);
      const lines = linesByTerms.get(primary.id) ?? [];
      if (feePolicy && lines.length > 0) {
        result.set(event.id, agreementFeeContext(primary, feePolicy, lines));
        continue;
      }
    }
    needsScopeWalk.push(event);
  }
  if (needsScopeWalk.length === 0) return result;

  const orgIds = needsScopeWalk
    .map((event) => event.orgId)
    .filter((id): id is string => id != null);
  const [byEventScope, byOrgScope, globalPolicy] = await Promise.all([
    repos.feePolicies.resolveEffectiveForScopes({
      scopeType: "EVENT",
      scopeIds: needsScopeWalk.map((event) => event.id),
      at: now,
    }),
    orgIds.length === 0
      ? Promise.resolve(new Map<string, FeePolicyRecord>())
      : repos.feePolicies.resolveEffectiveForScopes({
          scopeType: "ORG",
          scopeIds: orgIds,
          at: now,
        }),
    repos.feePolicies.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: now,
    }),
  ]);

  for (const event of needsScopeWalk) {
    const feePolicy =
      byEventScope.get(event.id) ??
      (event.orgId ? byOrgScope.get(event.orgId) : undefined) ??
      globalPolicy;
    result.set(
      event.id,
      feePolicy ? scopedPolicyFeeContext(event, feePolicy) : null,
    );
  }
  return result;
}
