import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { PayoutTermsDealRecord } from "@th/ports/repos/deals";
import { fail as failApp } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import {
  MAX_DEAL_ITEMS,
  MAX_PROJECTED_TICKETS,
  computeDealSettlement,
} from "../../lib/settlement";
import { loadAgreementDealContext } from "./_shared/agreement-deal-context";
import {
  isStoredPerOrderLine,
  toDealTerms,
  type DealRemainder,
} from "./_shared/deal-from-storage";
import {
  projectSettlementForViewer,
  settlementViewSchema,
  visiblePayeeIds,
  type DealViewer,
} from "./_shared/deal-visibility";
import { describePayees, dealPayeeSchema, dealRemainderSourceSchema } from "./get-agreement-deal";
import { MAX_STORED_DEAL_CENTS } from "./set-agreement-deal";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const tierSchema = z
  .object({
    tickets: z.number().int().nonnegative().max(MAX_PROJECTED_TICKETS),
    /** The ticket's face price — its basis with the fee passed to the buyer. */
    unitBasisCents: z.number().int().nonnegative().max(MAX_STORED_DEAL_CENTS),
  })
  .strict();

export const projectAgreementDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    /**
     * "If we sell N at $P". Absent = default from the event's ticket types
     * (every ACTIVE type at full capacity) when the booking has an event.
     */
    tiers: z.array(tierSchema).min(1).max(MAX_DEAL_ITEMS).optional(),
  })
  .strict();

/** The stored deal, run on tiers (typed, or the event's ticket types). */
const projectedDealShape = {
  needsTiers: z.literal(false),
  tiers: z.array(tierSchema),
  tiersSource: z.enum(["INPUT", "EVENT_TICKET_TYPES"]),
  remainder: z
    .object({
      payeeId: z.string(),
      source: dealRemainderSourceSchema,
      /**
       * "The rest", in total: the remainder holder's share of the pool plus
       * its own per-order lines (role REMAINDER_PER_ORDER). Summed here so
       * the calculator never adds money in the browser (NFR-002).
       */
      restTotalCents: z.number().int(),
    })
    .strict()
    .nullable(),
  projection: settlementViewSchema,
  payees: z.array(dealPayeeSchema),
};

/**
 * The caller asked for the event's tiers (no `tiers` sent) and there are none
 * to read: no event yet, or an event with no ACTIVE ticket types — the normal
 * state of a draft right after "Create event". Not an error: the editor shows
 * typed rows ("if we sell ___ at $__") instead. Nothing is projected, so
 * there is no projection, no remainder and no payee.
 */
const needsTiersShape = {
  needsTiers: z.literal(true),
  /** NO_EVENT: nothing to read tiers from. NO_TICKET_TYPES: the event has no ACTIVE type. */
  reason: z.enum(["NO_EVENT", "NO_TICKET_TYPES"]),
  tiers: z.array(tierSchema).max(0),
  tiersSource: z.literal("EVENT_TICKET_TYPES"),
  payees: z.array(dealPayeeSchema).max(0),
};

/** Without the target key: shared by every projection target (`projectTermsDeal`). */
export const projectedDealOutputShapes = {
  projected: projectedDealShape,
  needsTiers: needsTiersShape,
} as const;

export const projectAgreementDealOutputSchema = z.discriminatedUnion("needsTiers", [
  z.object({ agreementId: z.uuid(), ...projectedDealShape }).strict(),
  z.object({ agreementId: z.uuid(), ...needsTiersShape }).strict(),
]);

export type ProjectAgreementDealInput = z.infer<typeof projectAgreementDealInputSchema>;
export type ProjectAgreementDealOutput = z.infer<typeof projectAgreementDealOutputSchema>;

export type ProjectAgreementDealDeps = {
  repos: Pick<
    Repos,
    | "agreements"
    | "deals"
    | "bookingRequests"
    | "events"
    | "payees"
    | "authz"
    | "humans"
    | "organizations"
  >;
  /** The instant the default tiers are priced at (resolveUnitPriceCents, FR-004). */
  clock: ClockPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The editor's calculator (M3, FR-003d data): the stored deal run by
 * `computeDealSettlement` in PROJECTED mode — exact percentages (M9), no real
 * payment mixed in (W4) — shaped for the viewer (M5).
 */
export async function projectAgreementDeal(
  deps: ProjectAgreementDealDeps,
  rawInput: unknown,
): Promise<ProjectAgreementDealOutput> {
  const input = parseInput(projectAgreementDealInputSchema, rawInput);
  const ctx = await loadAgreementDealContext(deps.repos, input);
  const projected = await projectDealForViewer(deps, ctx, input.tiers);

  return projectAgreementDealOutputSchema.parse({
    agreementId: ctx.agreement.id,
    ...projected,
  });
}

const projectedDealSchema = z.discriminatedUnion("needsTiers", [
  z.object(projectedDealShape).strict(),
  z.object(needsTiersShape).strict(),
]);
export type ProjectedDeal = z.infer<typeof projectedDealSchema>;

/**
 * The stored deal run in PROJECTED mode and shaped for its viewer. Shared by
 * every projection target. Tiers default from the event's ticket types when
 * there is an event; with none to read (no event, no ACTIVE type) the result
 * is `needsTiers: true` and the caller types them.
 */
export async function projectDealForViewer(
  deps: Pick<ProjectAgreementDealDeps, "clock"> & {
    repos: Pick<Repos, "events" | "payees" | "humans" | "organizations">;
  },
  ctx: {
    deal: PayoutTermsDealRecord;
    remainder: DealRemainder | null;
    viewer: DealViewer;
    eventId: string | null;
  },
  inputTiers: ProjectAgreementDealInput["tiers"],
): Promise<ProjectedDeal> {
  if (!ctx.remainder) throw failApp("DEAL_REMAINDER_UNRESOLVED");

  let tiers = inputTiers ?? null;
  let tiersSource: "INPUT" | "EVENT_TICKET_TYPES" = "INPUT";
  if (!tiers) {
    tiers = ctx.eventId ? await defaultTiers(deps.repos, ctx.eventId, deps.clock.now()) : [];
    tiersSource = "EVENT_TICKET_TYPES";
    if (tiers.length === 0) {
      return {
        needsTiers: true,
        reason: ctx.eventId ? "NO_TICKET_TYPES" : "NO_EVENT",
        tiers: [],
        tiersSource: "EVENT_TICKET_TYPES",
        payees: [],
      };
    }
  }

  const result = computeDealSettlement(toDealTerms(ctx.deal, ctx.remainder.payeeId), {
    ticketRevenue: { mode: "PROJECTED", tiers },
  });
  const projection = projectSettlementForViewer(result, ctx.viewer);
  const payees = await describePayees(deps.repos, visiblePayeeIds(projection));

  // The remainder holder's own per-order lines: the same rule as the read's
  // REMAINDER_PER_ORDER role (`describeDealForViewer`).
  const remainderPayeeId = ctx.remainder.payeeId;
  const restLineIds = new Set(
    ctx.deal.clauses
      .filter((c) => c.payeeId === remainderPayeeId && isStoredPerOrderLine(c))
      .map((c) => c.id),
  );
  const restTotalCents =
    (result.payees.find((p) => p.payeeId === remainderPayeeId && p.isRemainder)
      ?.remainderShareCents ?? 0) +
    result.clauses
      .filter((c) => restLineIds.has(c.clauseId))
      .reduce((total, c) => total + c.entitlementCents, 0);

  return {
    needsTiers: false,
    tiers,
    tiersSource,
    remainder:
      ctx.viewer.visibility === "FULL" ? { ...ctx.remainder, restTotalCents } : null,
    projection,
    payees,
  };
}

/**
 * Every ACTIVE ticket type, at capacity, at its online price right now — through
 * `resolveUnitPriceCents` (FR-004: no direct `priceCents` reads), so a scheduled
 * price change is honoured — or, for a pay-what-you-want type, its suggested
 * price (else its minimum, else that resolved price).
 */
async function defaultTiers(
  repos: Pick<Repos, "events">,
  eventId: string,
  now: Date,
): Promise<Array<{ tickets: number; unitBasisCents: number }>> {
  const types = await repos.events.listTicketTypes(eventId);
  return types
    .filter((t) => t.status === "ACTIVE")
    .slice(0, MAX_DEAL_ITEMS)
    .map((t) => ({
      tickets: Math.min(Math.max(0, t.capacity), MAX_PROJECTED_TICKETS),
      unitBasisCents: Math.min(
        Math.max(
          0,
          t.pricingMode === "ADJUSTABLE"
            ? (t.suggestedCents ??
                t.minimumCents ??
                resolveUnitPriceCents(t, { now }))
            : resolveUnitPriceCents(t, { now }),
        ),
        MAX_STORED_DEAL_CENTS,
      ),
    }));
}
