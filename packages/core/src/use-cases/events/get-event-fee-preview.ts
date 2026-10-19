import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { FeePolicyRecord, FeePolicyScopeType } from "@th/types";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  computeTicketPriceForAgreement,
  FeeMode,
  SALE_FEE_MODE,
  SALE_ORGANISER_CREDIT,
} from "../../lib/pricing/compute-ticket-price-for-agreement";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { solveTaxLinesAndProcessorFee } from "../../lib/pricing/solve-tax-and-processor-fee";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import { resolveEventTaxSitus } from "./_shared/resolve-event-tax-rate";
import {
  resolveQuoteTaxRate,
  type QuoteTaxRateLookupDeps,
} from "./_shared/resolve-quote-tax-rate";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { computeAgreementBasis } from "../orders/finalize-from-payment-intent";

/**
 * This preview is forward-looking: it describes a ticket sold NOW, so it asks
 * `computeAgreementBasis` for the rule checkout stamps on a new order
 * (`buildFeePolicySnapshot`). It never describes a past order.
 */
const NEW_SALE_SNAPSHOT = { organiserCredit: SALE_ORGANISER_CREDIT } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getEventFeePreviewInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

const ticketFeeBreakdownSchema = z.object({
  ticketTypeId: z.uuid(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  platformFeeCents: z.number().int().nonnegative(),
  /**
   * Null when the tax rate is unknown in PASS_THROUGH: the processor fee is
   * grossed up over the tax, so it is unknown too.
   */
  processorFeeCents: z.number().int().nonnegative().nullable(),
  /**
   * Tax on one ticket, as the event page quotes it (every imposition, on its
   * jurisdictional base). Part of `buyerTotalCents`. NULL when the venue's
   * rate is unknown (the provider lookup failed): never quoted as 0 (owner
   * ruling 2026-10-06).
   */
  taxEstimateCents: z.number().int().nonnegative().nullable(),
  /** Null exactly when `taxEstimateCents` is (it includes the tax). */
  buyerTotalCents: z.number().int().nonnegative().nullable(),
  /**
   * What the EVENT is credited at settlement for one ticket sold at
   * `unitPriceCents`: the full ticket price, before the event's payout terms
   * split it among payees. The buyer pays the platform fee on top and it is
   * taken once (owner ruling 2026-10-11,
   * docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml).
   *
   * It is the same function settlement uses (`computeAgreementBasis`), given
   * the marker a new sale is stamped with (`NEW_SALE_SNAPSHOT`), so this
   * figure cannot drift from what a new order credits. It does not depend on
   * tax, so it is never null.
   */
  eventCreditCents: z.number().int().nonnegative(),
});

export const getEventFeePreviewOutputSchema = z.object({
  eventId: z.uuid(),
  /** The effective fee mode. null if no fee policy could be resolved. */
  feeMode: z.enum(["ABSORB", "PASS_THROUGH"]).nullable(),
  /** Human-readable summary of the fee policy rates. */
  policyRates: z
    .object({
      buyerFeePct: z.number().nonnegative(),
      maxFeeCents: z.number().int().nonnegative().nullable(),
      processorFeePct: z.number().nonnegative(),
      processorFixedCents: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Per-ticket-type fee breakdown. Empty if no fee policy or no ticket types. */
  ticketBreakdowns: z.array(ticketFeeBreakdownSchema),
});

export type GetEventFeePreviewInput = z.infer<
  typeof getEventFeePreviewInputSchema
>;
export type GetEventFeePreviewOutput = z.infer<
  typeof getEventFeePreviewOutputSchema
>;

export type GetEventFeePreviewDeps = {
  repos: Repos;
  /**
   * Required (FR-003). This preview tells the organizer what a buyer will be
   * charged; quoting it off the pre-flip price while checkout charges the
   * post-flip one is the exact disagreement FR-004 exists to remove.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The quote-path provider lookup (same as the event page's fee quote): a
   * venue with no cached rate is looked up once and cached. Absent = no
   * lookup; a cache miss then previews with no tax figure.
   */
  taxLookup?: QuoteTaxRateLookupDeps | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a preview of fee calculations for each ticket type on an event.
 *
 * Resolves the effective fee policy (pinned on agreement, or scoped EVENT → ORG → GLOBAL)
 * and computes per-ticket platform fee, processor fee, buyer total, and what
 * the event is credited at settlement.
 *
 * This is for the admin event builder UI — it does NOT mutate anything.
 */
export async function getEventFeePreview(
  deps: GetEventFeePreviewDeps,
  rawInput: unknown,
): Promise<GetEventFeePreviewOutput> {
  const logger = deps.logger?.child({ useCase: "getEventFeePreview" });

  const input = parseInput(getEventFeePreviewInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // RBAC: must be org member with edit permissions
  await ensureActorCanView(deps, event, input.actorHumanId);

  // ONE instant for the whole preview — fee-policy resolution and every tier's
  // price are read against the same moment so the breakdown is internally
  // consistent even if a flip lands mid-request.
  const now = deps.clock.now();

  // Resolve the effective fee policy and agreement context
  const ctx = await resolvePreviewContext(deps, event, now, logger);
  if (!ctx) {
    // No fee policy available yet (e.g. no global policy exists)
    return getEventFeePreviewOutputSchema.parse({
      eventId: event.id,
      feeMode: null,
      policyRates: null,
      ticketBreakdowns: [],
    });
  }

  const { feePolicy, agreement, lines } = ctx;
  // The mode the next sale will be priced under (SALE_FEE_MODE), never the
  // stored one: this preview must match what checkout charges.
  const effectiveFeeMode: FeeMode = SALE_FEE_MODE;

  // Fetch ticket types
  const ticketTypes = await deps.repos.events.listTicketTypes(event.id);

  // Every tax the admission owes — the SAME list the event page and checkout
  // quote from (`getCheckoutFeeRates`), so "Buyer pays" here is the figure a
  // buyer is shown there. Without it this preview left tax out entirely.
  //
  // The rate comes from `resolveQuoteTaxRate`, as in `getCheckoutFeeRates`
  // (with the same provider lookup, cached on the venue), so an unstamped
  // event's preview takes the rate checkout would charge. When the rate is
  // UNKNOWN — the lookup failed, or nobody could ask — the preview shows no
  // tax and no "Buyer pays" rather than a 0% figure below the charge (owner
  // ruling 2026-10-06). `no_rate` (an unsupported province, a provider that
  // answered "no rate here") is what checkout charges 0 on, so it previews 0.
  const situs = await resolveEventTaxSitus(deps.repos, event);
  const quote = await resolveQuoteTaxRate(
    { repos: deps.repos, clock: deps.clock, lookup: deps.taxLookup ?? null },
    event,
    situs,
    logger,
  );
  const taxUnknown = !quote.known && quote.reason !== "no_rate";
  const taxLines = resolveTaxImpositions({
    situs,
    salesTaxRateBps: quote.known ? quote.rateBps : 0,
  });
  const passThrough = effectiveFeeMode === "PASS_THROUGH";

  const ticketBreakdowns = ticketTypes.map((tt) => {
    // FR-004: the effective price at `now` — what a buyer pays.
    const unitPriceCents = resolveUnitPriceCents(tt, { now });

    if (unitPriceCents === 0) {
      return {
        ticketTypeId: tt.id,
        name: tt.name,
        unitPriceCents: 0,
        platformFeeCents: 0,
        processorFeeCents: 0,
        taxEstimateCents: 0,
        buyerTotalCents: 0,
        eventCreditCents: computeAgreementBasis({
          amountGrossCents: unitPriceCents,
          feesPlatformCents: 0,
          feePolicySnapshot: NEW_SALE_SNAPSHOT,
        }),
      };
    }

    const result = computeTicketPriceForAgreement({
      qty: 1,
      unitPriceCents,
      agreement: {
        id: agreement.id,
        feeMode: agreement.feeMode as FeeMode | undefined,
        lines: lines.map((l) => ({
          id: l.id,
          payeeId: l.payeeId,
          percent: l.percent,
          floorCents: l.floorCents,
          capPercent: l.capPercent,
          priority: l.priority,
          rounding: l.rounding,
        })),
        policy: {
          id: feePolicy.id,
          version: feePolicy.version,
          feeMode: feePolicy.feeMode as FeeMode,
          processsorFeePct: feePolicy.processsorFeePct,
          processorFixedCents: feePolicy.processorFixedCents,
          payoutPct: feePolicy.payoutPct,
          payoutFixedCents: feePolicy.payoutFixedCents,
          monthlyPayoutCents: feePolicy.monthlyPayoutCents,
          buyerFeePct: feePolicy.buyerFeePct,
          maxFeeCents: feePolicy.maxFeeCents,
          minFeeCents: feePolicy.minFeeCents,
          platformFixedCents: feePolicy.platformFixedCents,
        },
      },
    });

    // The per-ticket solve the event page's estimator runs
    // (`estimateBuyerTicketPricingForEvent`): tax on the jurisdictional base,
    // and in PASS_THROUGH the processor fee grossed up over face + platform
    // fee + tax. The old `ceil((price + fee) × pct + fixed)` markup ignored
    // tax twice — it quoted no tax, and grossed up over a base without it —
    // so "Buyer pays" read $36.83 for a ticket the event page sold at $40.08.
    const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
      taxableGrossCents: unitPriceCents,
      buyerPlatformFeeCents: passThrough ? result.platformFeePerTicketCents : 0,
      taxLines,
      passThrough,
      processorPct: feePolicy.processsorFeePct,
      processorFixedCents: feePolicy.processorFixedCents,
    });

    // Settlement's own basis for one ticket sold now at this price (see the
    // schema): the ticket price. Read before the tax branch: the credit is the
    // same whether or not the tax rate is known.
    const eventCreditCents = computeAgreementBasis({
      amountGrossCents: unitPriceCents,
      feesPlatformCents: result.platformFeePerTicketCents,
      feePolicySnapshot: NEW_SALE_SNAPSHOT,
    });

    if (taxUnknown) {
      return {
        ticketTypeId: tt.id,
        name: tt.name,
        unitPriceCents,
        platformFeeCents: result.platformFeePerTicketCents,
        processorFeeCents: passThrough ? null : 0,
        taxEstimateCents: null,
        buyerTotalCents: null,
        eventCreditCents,
      };
    }

    return {
      ticketTypeId: tt.id,
      name: tt.name,
      unitPriceCents,
      platformFeeCents: result.platformFeePerTicketCents,
      processorFeeCents: passThrough ? processorFeeCents : 0,
      taxEstimateCents: taxCents,
      buyerTotalCents: passThrough
        ? unitPriceCents +
          result.platformFeePerTicketCents +
          processorFeeCents +
          taxCents
        : unitPriceCents + taxCents,
      eventCreditCents,
    };
  });

  return getEventFeePreviewOutputSchema.parse({
    eventId: event.id,
    feeMode: effectiveFeeMode,
    policyRates: {
      buyerFeePct: feePolicy.buyerFeePct,
      maxFeeCents: feePolicy.maxFeeCents,
      processorFeePct: feePolicy.processsorFeePct,
      processorFixedCents: feePolicy.processorFixedCents,
    },
    ticketBreakdowns,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface PreviewContext {
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
 * Tries to resolve the fee policy for an event:
 * 1. Check if the event already has a PRIMARY agreement with a pinned fee policy.
 * 2. Otherwise, resolve the scoped policy cascade (EVENT → ORG → GLOBAL).
 */
async function resolvePreviewContext(
  deps: GetEventFeePreviewDeps,
  event: { id: string; orgId: string | null },
  /** The caller's single evaluation instant, from the injected ClockPort. */
  now: Date,
  logger: LoggerPort | undefined,
): Promise<PreviewContext | null> {
  // Try the existing agreement first. Match the lookup order used by
  // setEventFeeMode so a DRAFT event's PENDING agreement is visible to
  // the preview — otherwise toggling fee mode on a draft "saves" but
  // re-renders with the fee-policy default.
  const terms = await deps.repos.payoutTerms.listByEvent(event.id);
  const primary =
    terms.find((t) => t.kind === "PRIMARY" && t.status === "ACTIVE") ??
    terms.find(
      (t) => (t.kind as string) === "PRIMARY_SPLIT" && t.status === "ACTIVE",
    ) ??
    terms.find((t) => t.kind === "PRIMARY" && t.status === "PENDING") ??
    terms.find(
      (t) => (t.kind as string) === "PRIMARY_SPLIT" && t.status === "PENDING",
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

  // Fallback: resolve the scoped fee policy
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

  // Build a synthetic agreement context from the primary (if it exists) or a default
  const agreementId = primary?.id ?? "preview";
  const agreementFeeMode = primary?.feeMode ?? null;

  // If no agreement lines exist yet, create a synthetic 100% line
  // (used for DRAFT events before publish creates the real agreement)
  let lines;
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
              id: "preview-line",
              payeeId: "preview-payee",
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
        id: "preview-line",
        payeeId: "preview-payee",
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

async function ensureActorCanView(
  deps: GetEventFeePreviewDeps,
  event: { orgId: string | null; humanId: string | null },
  actorHumanId: string,
): Promise<void> {
  // Personal event: owner check
  if (!event.orgId) {
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      actorHumanId,
    );
    return;
  }

  // Org event: role check
  await requireOrgMembership({
    repos: deps.repos,
    orgId: event.orgId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
}
