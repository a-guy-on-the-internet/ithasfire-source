import type { TxRepos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";
import type { PromoRecord, PromoScope } from "@th/ports/repos/promos";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";
import type { TicketDiscount } from "../../lib/orders/discounted-to-zero";
import type { MemberBenefitGrant } from "../memberships/resolve-member-benefits";
import type {
  OrderComputation,
  TicketLineComputation,
} from "./checkout-helpers";

// ── Types ───────────────────────────────────────────────────────────────────

export type PromoCodeEntry = {
  original: string;
  normalized: string;
};

/**
 * The ONE normalized discount shape.
 *
 * A typed promo code and a membership grant compile to this before any maths
 * runs, which is what makes "exactly one discount computation" structural
 * rather than aspirational: `computeEligibleAmount` and `clampDiscount` below
 * take THIS, never a `PromoRecord`, so neither source can grow its own
 * arithmetic.
 */
export type DiscountTerms = {
  kind: "AMOUNT" | "PERCENT";
  /** Cents off (AMOUNT) or percent 1–100 (PERCENT). */
  value: number;
  /** Optional clamp on the computed discount, integer cents. */
  maxDiscountCents: number | null;
  scope: PromoScope;
  scopeId: string | null;
};

/**
 * An applied discount, discriminated by where the entitlement came from.
 *
 * A union rather than a `PromoRecord` with optional membership fields: every
 * consumer (holds, order-item meta, audit, preview) has to answer "which
 * source is this?" differently, and a union makes forgetting to a compile
 * error instead of an `undefined` promo id written into the ledger.
 */
export type PromoApplication =
  | {
      kind: "code";
      promo: PromoRecord;
      code: PromoCodeEntry;
      terms: DiscountTerms;
      discountCents: number;
    }
  | {
      kind: "membership";
      grant: MemberBenefitGrant;
      terms: DiscountTerms;
      discountCents: number;
    };

export type PromoEvaluationResult = {
  applications: PromoApplication[];
  totalDiscountCents: number;
  discountItems: OrderComputation["items"];
  /**
   * The applied discounts in the shape `computeOrderAmounts({ discounts })`
   * spreads over tickets, in application order. A ticket the discounts bring
   * down to $0 pays no platform fee (owner ruling 2026-10-10, see
   * `lib/orders/discounted-to-zero.ts`), so whoever prices a cart with this
   * evaluation MUST price it with these: `priceCart` does it itself, and
   * `priceComputedCart` refuses a computation that was priced without them.
   */
  ticketDiscounts: TicketDiscount[];
};

/**
 * Which tickets each applied discount comes off: its ticket type's when it is
 * scoped to one, every ticket on the order otherwise. `computeEligibleAmount`
 * below is the other half of this rule (what the discount is computed ON);
 * the two must name the same tickets.
 */
export function ticketDiscountsOf(
  applications: ReadonlyArray<PromoApplication>,
): TicketDiscount[] {
  return applications.map((application) => ({
    discountCents: application.discountCents,
    ticketTypeId:
      application.terms.scope === "TICKET_TYPE"
        ? application.terms.scopeId
        : null,
  }));
}

// ── Constants ───────────────────────────────────────────────────────────────

export const PROMO_HOLD_TTL_SECONDS = 900;

// ── Public helpers ──────────────────────────────────────────────────────────

export function preparePromoCodes(
  rawCodes: string[] | undefined | null,
): PromoCodeEntry[] {
  if (!rawCodes || rawCodes.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const prepared: PromoCodeEntry[] = [];

  for (const raw of rawCodes) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    const normalized = normalizePromoCode(trimmed);
    if (seen.has(normalized)) {
      throw fail("DUPLICATE_PROMO", { meta: { promoCode: normalized } });
    }

    seen.add(normalized);
    prepared.push({ original: trimmed, normalized });
  }

  return prepared;
}

/**
 * The ledger `code` recorded for a membership-sourced hold/redemption.
 *
 * A benefit has no code — that is the point of the entity. This is a stable
 * source marker for the ledger's `code` column, NOT anything a buyer could
 * type: the typed-code path resolves by `codeNormalized` on Promo, which this
 * will never match.
 */
export function benefitLedgerCode(benefitId: string): string {
  return `benefit:${benefitId}`;
}

/**
 * The single string that identifies an applied discount in the ledger's `code`
 * column and in Stripe PaymentIntent metadata. One helper so the two never
 * disagree about what a membership-sourced line is called.
 */
export function applicationLedgerCode(application: PromoApplication): string {
  return application.kind === "code"
    ? application.code.normalized
    : benefitLedgerCode(application.grant.benefitId);
}

export async function evaluatePromoApplications(params: {
  codes: PromoCodeEntry[];
  tx: TxRepos;
  event: EventRecord;
  /** Buyer UUID for per-human redemption checks. `null` skips that check (used by anonymous URL previews — final check still fires at checkout). */
  buyerHumanId: string | null;
  now: Date;
  orderSubtotalCents: number;
  ticketLines: TicketLineComputation[];
  /**
   * The buyer's own PENDING cart on this event, whose live promo holds must
   * not count against them: the live preview while they edit that cart, and
   * the checkout that supersedes it (`createCheckout`'s routing probe and
   * `claimFreeTickets` both evaluate BEFORE the cart is retired). The caller
   * has verified ownership (buyer + event + PENDING). Never the authority:
   * `createHolds` re-checks under its lock with no exclusion regardless.
   */
  excludeOrderId?: string;
  /**
   * When `true`, only `isPublic` codes resolve — private codes look like
   * "not found" so URL crafters can't enumerate them. Used by the URL-seed
   * preview path. Defaults to false (manual entry & checkout flow).
   * Never applies to `memberGrants` — those are entitlements, not typed codes.
   */
  publicOnly?: boolean;
  /**
   * Benefits granted by the buyer's active memberships
   * (`resolveMemberBenefits`), auto-applied with no code. They join THIS
   * pipeline after code resolution, so scope, stacking and clamping apply
   * exactly once — but with three deliberate behavioural differences from
   * typed codes:
   *
   *  1. Best-effort, never fatal. A typed code that doesn't apply is a buyer
   *     mistake and throws; a granted benefit that doesn't apply to THIS
   *     order (wrong owner, subtotal already fully discounted, stacking
   *     conflict) is silently skipped — a member's open-mic benefit must not
   *     brick their arena checkout.
   *  2. AT MOST ONE benefit applies per order, the best one for the buyer.
   *     Benefits carry no `stackable` knob (that was a campaign property with
   *     no meaning as a membership term), so stacking them would be a policy
   *     invented here rather than one an owner chose. Deferred deliberately;
   *     the losers are logged, not silently dropped.
   *  3. No redemption caps and no min-order. Those are campaign limits. A
   *     benefit is valid exactly as long as the membership is, which is why
   *     grants skip the `getRedemptionStats` read entirely.
   */
  memberGrants?: MemberBenefitGrant[];
  /** Optional — used only to record skipped benefits. Never load-bearing. */
  logger?: LoggerPort;
}): Promise<PromoEvaluationResult> {
  const memberGrants = params.memberGrants ?? [];
  if (params.codes.length === 0 && memberGrants.length === 0) {
    return {
      applications: [],
      totalDiscountCents: 0,
      discountItems: [],
      ticketDiscounts: [],
    };
  }

  const normalizedCodes = params.codes.map((entry) => entry.normalized);
  const promos =
    params.codes.length === 0
      ? []
      : await params.tx.promos.findActiveByCodes({
          codes: normalizedCodes,
          now: params.now,
          publicOnly: params.publicOnly,
        });

  const promosByCode = new Map(
    promos.map((promo) => [promo.codeNormalized, promo]),
  );

  if (promosByCode.size < params.codes.length) {
    const missing = params.codes.find(
      (entry) => !promosByCode.has(entry.normalized),
    );
    if (missing) {
      throw {
        code: "invalid_input",
        message: "promo_not_found",
        promoCode: missing.original,
        // Every promo rejection below carries `meta.promoCode`: the legacy
        // error path forwards `meta` to the wire (`data.meta`), so the checkout
        // can drop exactly the code that failed rather than guessing the newest.
        meta: { promoCode: missing.original },
      } as const;
    }
  }

  ensurePromosStackable(promos);

  const promoEntries = params.codes.map((codeEntry) => {
    const promo = promosByCode.get(codeEntry.normalized);
    if (!promo) {
      throw {
        code: "invalid_input",
        message: "promo_not_found",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }
    return { codeEntry, promo };
  });

  const seenPromoIds = new Set<string>();
  for (const { promo, codeEntry } of promoEntries) {
    if (seenPromoIds.has(promo.id)) {
      throw {
        code: "invalid_input",
        message: "duplicate_promo",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }
    seenPromoIds.add(promo.id);
  }

  const redemptionStats = await Promise.all(
    Array.from(seenPromoIds).map(async (promoId) => ({
      promoId,
      stats: await params.tx.promos.getRedemptionStats({
        promoId,
        // `null` (anonymous preview) → skip per-human stat (adapter
        // returns redemptionsForHuman: 0, which short-circuits the cap
        // check below). The real cap fires at checkout.
        humanId: params.buyerHumanId ?? undefined,
        // The stats fold in LIVE holds (PENDING and either unexpired at `now`
        // or still on an open cart), so a
        // slot promised to another in-flight checkout is already spoken for
        // here. This is the cheap early rejection; `createHolds` re-checks
        // under a per-promo lock and is the authority.
        now: params.now,
        excludeOrderId: params.excludeOrderId,
      }),
    })),
  );

  const statsByPromoId = new Map(
    redemptionStats.map(({ promoId, stats }) => [promoId, stats]),
  );

  const applications: PromoApplication[] = [];
  let totalDiscountCents = 0;

  for (const { promo, codeEntry } of promoEntries) {
    const stats = statsByPromoId.get(promo.id);
    if (!stats) {
      throw {
        code: "invalid_input",
        message: "promo_not_found",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }

    if (
      typeof promo.maxRedemptions === "number" &&
      stats.totalRedemptions >= promo.maxRedemptions
    ) {
      throw {
        code: "conflict",
        message: "promo_max_redeemed",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }

    if (
      typeof promo.maxRedemptionsPerHuman === "number" &&
      stats.redemptionsForHuman >= promo.maxRedemptionsPerHuman
    ) {
      throw {
        code: "conflict",
        message: "promo_redeemed_by_human",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }

    if (params.orderSubtotalCents < promo.minOrderCents) {
      throw {
        code: "invalid_input",
        message: "promo_min_order_not_met",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
        minOrderCents: promo.minOrderCents,
      } as const;
    }

    const terms = promoTerms(promo);
    const eligibleAmount = computeEligibleAmount(
      terms,
      params.event,
      params.ticketLines,
    );
    if (eligibleAmount <= 0) {
      throw {
        code: "invalid_input",
        message: "promo_not_applicable",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }

    const discountCents = clampDiscount(
      terms,
      eligibleAmount,
      params.orderSubtotalCents,
      totalDiscountCents,
    );

    if (discountCents <= 0) {
      throw {
        code: "invalid_input",
        message: "promo_not_applicable",
        promoCode: codeEntry.original,
        meta: { promoCode: codeEntry.original },
      } as const;
    }

    totalDiscountCents += discountCents;

    applications.push({
      kind: "code",
      promo,
      code: codeEntry,
      terms,
      discountCents,
    });
  }

  // ── Membership-granted benefits (auto-applied, no code) ───────────────────
  // Evaluated AFTER every typed code has applied, so typed codes keep first
  // claim on the discountable subtotal and are never evicted in favour of a
  // grant. Every rejection here is a silent skip (see the memberGrants doc
  // above) — a benefit that doesn't fit THIS order simply doesn't appear.
  if (memberGrants.length > 0) {
    // Stacking, same rule that governs typed codes: more than one applied
    // discount requires every APPLIED PROMO to be stackable. A benefit has no
    // stackable flag of its own — it is a membership term, not a campaign — so
    // the only question is whether the owner's own codes opted into stacking.
    const codesAllowStacking = applications.every(
      (application) =>
        application.kind !== "code" || application.promo.stackable,
    );

    if (!codesAllowStacking) {
      logSkippedGrants(
        params.logger,
        memberGrants,
        "non_stackable_code_applied",
      );
    } else {
      // One benefit per order, best for the buyer. Each candidate is priced
      // against the SAME remaining subtotal, so the comparison is fair and the
      // winner's number is the number that gets applied.
      let best: { grant: MemberBenefitGrant; terms: DiscountTerms; discountCents: number } | null =
        null;

      for (const grant of memberGrants) {
        const terms = grantTerms(grant);
        const eligibleAmount = computeEligibleAmount(
          terms,
          params.event,
          params.ticketLines,
        );
        if (eligibleAmount <= 0) {
          continue;
        }
        const discountCents = clampDiscount(
          terms,
          eligibleAmount,
          params.orderSubtotalCents,
          totalDiscountCents,
        );
        if (discountCents <= 0) {
          continue;
        }
        // Strict `>` keeps the earliest grant on a tie. `memberGrants` arrives
        // in a deterministic order (oldest membership, then benefit createdAt),
        // so equal-value benefits resolve the same way on every checkout.
        if (!best || discountCents > best.discountCents) {
          best = { grant, terms, discountCents };
        }
      }

      if (best) {
        const winner = best;
        totalDiscountCents += winner.discountCents;
        applications.push({
          kind: "membership",
          grant: winner.grant,
          terms: winner.terms,
          discountCents: winner.discountCents,
        });

        const losers = memberGrants.filter(
          (grant) => grant.benefitId !== winner.grant.benefitId,
        );
        logSkippedGrants(params.logger, losers, "one_benefit_per_order");
      } else {
        logSkippedGrants(params.logger, memberGrants, "not_applicable");
      }
    }
  }

  const discountItems = applications.map<OrderComputation["items"][number]>(
    (application) => ({
      kind: "discount",
      ticketTypeId: undefined,
      qty: 1,
      unitPriceCents: -application.discountCents,
      amountCents: -application.discountCents,
      meta:
        application.kind === "code"
          ? {
              promoId: application.promo.id,
              code: application.code.original,
              normalizedCode: application.code.normalized,
              scope: application.terms.scope,
              kind: application.terms.kind,
              value: application.terms.value,
              appliedDiscountCents: application.discountCents,
            }
          : {
              // No promoId and no code material: a membership grant has
              // neither. Attribution is the benefit/tier/membership triple,
              // which is also what lets reporting separate granted margin
              // from typed margin.
              source: "membership",
              membershipBenefitId: application.grant.benefitId,
              membershipId: application.grant.membershipId,
              tierId: application.grant.tierId,
              tierName: application.grant.tierName,
              label: application.grant.label,
              scope: application.terms.scope,
              kind: application.terms.kind,
              value: application.terms.value,
              appliedDiscountCents: application.discountCents,
            },
    }),
  );

  return {
    applications,
    totalDiscountCents,
    discountItems,
    ticketDiscounts: ticketDiscountsOf(applications),
  };
}

/**
 * The audit shape for one applied discount, so the three call sites that log
 * `promos: [...]` cannot each invent their own branch (and drift).
 */
export function describeApplicationForAudit(
  application: PromoApplication,
): Record<string, unknown> {
  if (application.kind === "code") {
    return {
      promoId: application.promo.id,
      code: application.code.original,
      normalizedCode: application.code.normalized,
      discountCents: application.discountCents,
    };
  }
  return {
    source: "membership",
    membershipBenefitId: application.grant.benefitId,
    membershipId: application.grant.membershipId,
    tierId: application.grant.tierId,
    discountCents: application.discountCents,
  };
}

export async function createPromoHolds(
  repo: TxRepos["promos"],
  applications: PromoApplication[],
  params: {
    orderId: string;
    buyerHumanId: string;
    now: Date;
    /**
     * Hold lifetime override. Defaults to the web checkout TTL (15 min).
     * The POS card path passes `POS_HELD_WINDOW_SECONDS` (cart TTL + 2 reaper
     * periods, 80 min) so a slow tap can't lose its promo hold before the
     * cart reaper would have released the order anyway.
     */
    ttlSeconds?: number;
  },
) {
  if (!repo || applications.length === 0) {
    return;
  }

  const expiresAtMs =
    params.now.getTime() +
    (params.ttlSeconds ?? PROMO_HOLD_TTL_SECONDS) * 1000;
  const expiresAt = new Date(expiresAtMs);

  // ONE ledger, two sources. `promoId` XOR `membershipBenefitId`, with
  // idempotency keys that mirror each other so a retry of either kind lands on
  // the same row rather than double-counting the discount.
  //
  // `now` rides along because the adapter re-checks the caps under its lock,
  // and that count must use the same clock `expiresAt` above came from. The
  // re-check throws the same `promo_max_redeemed` / `promo_redeemed_by_human`
  // as `evaluatePromoApplications` — a lost race rejects the checkout rather
  // than quietly charging full price.
  await repo.createHolds(
    applications.map((application) =>
      application.kind === "code"
        ? {
            promoId: application.promo.id,
            orderId: params.orderId,
            humanId: params.buyerHumanId,
            idempotencyKey: `order:${params.orderId}:promo:${application.promo.id}`,
            code: application.code.normalized,
            amountDiscountCents: application.discountCents,
            expiresAt,
          }
        : {
            membershipBenefitId: application.grant.benefitId,
            orderId: params.orderId,
            humanId: params.buyerHumanId,
            idempotencyKey: `order:${params.orderId}:benefit:${application.grant.benefitId}`,
            code: applicationLedgerCode(application),
            amountDiscountCents: application.discountCents,
            expiresAt,
          },
    ),
    { now: params.now },
  );
}

// ── Private helpers ─────────────────────────────────────────────────────────

function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

function promoTerms(promo: PromoRecord): DiscountTerms {
  return {
    kind: promo.kind,
    value: promo.value,
    maxDiscountCents: promo.maxDiscountCents ?? null,
    scope: promo.scope,
    scopeId: promo.scopeId ?? null,
  };
}

/**
 * A grant's owner scope becomes an ORG / HUMAN promo scope, so the SAME
 * `computeEligibleAmount` gate that keeps a typed code inside its owner's
 * events keeps an entitlement inside its tier owner's events. GLOBAL is
 * unrepresentable here, which is why the old GLOBAL filter in the resolver is
 * gone rather than relocated.
 */
function grantTerms(grant: MemberBenefitGrant): DiscountTerms {
  return {
    kind: grant.discountKind,
    value: grant.discountValue,
    maxDiscountCents: grant.maxDiscountCents,
    ...(grant.ownerScope.kind === "ORG"
      ? { scope: "ORG" as const, scopeId: grant.ownerScope.orgId }
      : { scope: "HUMAN" as const, scopeId: grant.ownerScope.humanId }),
  };
}

function logSkippedGrants(
  logger: LoggerPort | undefined,
  grants: MemberBenefitGrant[],
  reason: string,
): void {
  if (!logger || grants.length === 0) {
    return;
  }
  logger.info("checkout.member_benefit_skipped", {
    reason,
    benefitIds: grants.map((grant) => grant.benefitId),
  });
}

/**
 * The one discount computation, shared by typed codes and membership grants:
 * kind maths (AMOUNT vs PERCENT with floor), clamped to the eligible amount,
 * then the terms' own maxDiscountCents, then whatever subtotal earlier
 * applications left undiscounted. Integer cents throughout.
 */
function clampDiscount(
  terms: DiscountTerms,
  eligibleAmount: number,
  orderSubtotalCents: number,
  totalDiscountCentsSoFar: number,
): number {
  let computedDiscountCents = 0;
  if (terms.kind === "AMOUNT") {
    computedDiscountCents = Math.min(terms.value, eligibleAmount);
  } else {
    computedDiscountCents = Math.min(
      Math.floor((eligibleAmount * terms.value) / 100),
      eligibleAmount,
    );
  }

  if (terms.maxDiscountCents != null) {
    computedDiscountCents = Math.min(
      computedDiscountCents,
      terms.maxDiscountCents,
    );
  }

  const remainingDiscountCents = Math.max(
    orderSubtotalCents - totalDiscountCentsSoFar,
    0,
  );
  return Math.min(computedDiscountCents, remainingDiscountCents);
}

function ensurePromosStackable(promos: PromoRecord[]) {
  if (promos.length <= 1) {
    return;
  }

  const nonStackable = promos.find((promo) => !promo.stackable);
  if (nonStackable) {
    throw {
      code: "invalid_input",
      message: "promo_not_stackable",
      promoCode: nonStackable.code,
      meta: { promoCode: nonStackable.code },
    } as const;
  }
}

function computeEligibleAmount(
  terms: DiscountTerms,
  event: EventRecord,
  ticketLines: TicketLineComputation[],
): number {
  const sumAll = () =>
    ticketLines.reduce((sum, line) => sum + line.lineGrossCents, 0);

  switch (terms.scope) {
    case "GLOBAL":
      return sumAll();
    case "ORG":
      if (!terms.scopeId || !event.orgId || terms.scopeId !== event.orgId) {
        return 0;
      }
      return sumAll();
    case "HUMAN":
      // Seller-wide scope for direct/personal sellers. The `event.orgId !=
      // null` guard is mandatory: orgId takes precedence as the payee, so an
      // org-owned event that also carries a humanId must NEVER match a
      // human's promo — only truly personal events (orgId = null) qualify.
      // This is ALSO the cross-tenant guard for a human-owned tier's benefit.
      if (
        !terms.scopeId ||
        event.orgId != null ||
        !event.humanId ||
        terms.scopeId !== event.humanId
      ) {
        return 0;
      }
      return sumAll();
    case "EVENT":
      if (!terms.scopeId || terms.scopeId !== event.id) {
        return 0;
      }
      return sumAll();
    case "TICKET_TYPE":
      if (!terms.scopeId) {
        return 0;
      }
      return ticketLines
        .filter((line) => line.ticketTypeId === terms.scopeId)
        .reduce((sum, line) => sum + line.lineGrossCents, 0);
    default:
      return 0;
  }
}
