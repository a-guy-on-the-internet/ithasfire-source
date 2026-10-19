import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";
import type { EventTicketTypeSummary } from "@th/types";

import { fail, isAppError } from "@th/errors";
import { classifySeatOverride } from "../../../lib/orders/seat-pricing";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  requireOrgMembership,
  ORG_EDIT_ROLES,
  type OrgMembershipLookup,
} from "../../../lib/rbac";
import {
  ensureActorHoldsHumanEventRole,
  type EventEditRightsAuthz,
} from "../../../lib/event-edit-rights";
import {
  ensureFeePolicyResolvableForPaidTicketing,
  ticketTypeNeedsFeePolicy,
  type FeePolicyTicketingGateDeps,
} from "../../ticket-types/_shared/ensure-fee-policy-for-paid-ticketing";
import {
  ensureStripeConnectedForPaidTicketing,
  ticketTypeRequiresStripe,
} from "../../ticket-types/_shared/ensure-stripe-connected-for-paid-ticketing";

/**
 * The rules a seat price override is written under, shared by the write
 * (`setSeatPriceOverrides`) and the organizer's editor read
 * (`listEventSeatPriceOverridesForEdit`), so the read can never tell the
 * editor something the write then contradicts: who may touch the overrides,
 * on which events, which sections refuse a price, and which free sections
 * cannot take a PAID price yet. `publishEvent` reads it too, to learn whether
 * an override already stored makes a free-tier event take money, and the
 * ticket type writes (`upsertTicketType`, `updateTicketType`,
 * `assignTicketTypeSections`) run the paid gates here before they make a free
 * FIXED tier start selling a section that already stores one. See the WRITE RULES in
 * `set-seat-price-overrides.ts` (spec 2026-08-12 FR-006, D-004).
 */

/**
 * The ticket type fields these rules read. A full `EventTicketTypeSummary`
 * satisfies it; a write that has no stored row yet (a create) builds one.
 */
export type OverrideRuleTier = Pick<
  EventTicketTypeSummary,
  | "status"
  | "pricingMode"
  | "seatSectionId"
  | "priceCents"
  | "scheduledPriceCents"
  | "minimumCents"
>;

// ─────────────────────────────────────────────────────────────────────────────
// Who
// ─────────────────────────────────────────────────────────────────────────────

export type SeatPriceOverrideAuthzRepos = {
  authz: OrgMembershipLookup["authz"] & EventEditRightsAuthz;
};

/**
 * Org-owned event: the actor holds an `ORG_EDIT_ROLES` role on the event's
 * organizing org (`INSUFFICIENT_ROLE` otherwise). Person-owned event: the
 * owner or an edit-role delegate (`NOT_RESOURCE_OWNER` otherwise; an
 * ownerless row admits nobody).
 */
export async function ensureActorCanEditSeatPriceOverrides(
  repos: SeatPriceOverrideAuthzRepos,
  event: Pick<EventRecord, "orgId" | "humanId">,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  await ensureActorHoldsHumanEventRole(
    repos.authz,
    event.humanId,
    actorHumanId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Which events
// ─────────────────────────────────────────────────────────────────────────────

/** Overrides are frozen once an event is cancelled, completed or archived. */
export function seatPriceOverridesEditable(
  event: Pick<EventRecord, "status">,
): boolean {
  return !(
    event.status === "CANCELLED" ||
    event.status === "COMPLETED" ||
    event.status === "ARCHIVED"
  );
}

export function ensureEventIsEditable(event: Pick<EventRecord, "status">): void {
  if (!seatPriceOverridesEditable(event)) {
    throw fail("EVENT_NOT_EDITABLE");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Which sections (FR-006)
// ─────────────────────────────────────────────────────────────────────────────

export type SectionTiers = Map<string, EventTicketTypeSummary[]>;

/**
 * The tiers that will sell each section; a section with none maps to [].
 * DRAFT event: every tier, since publish activates them all (WRITE RULES 2).
 * Any other status: ACTIVE tiers only. (The write refuses every status but
 * DRAFT and PUBLISHED before it gets here; the read shows the same rule.)
 */
export function tiersForSections<
  T extends Pick<OverrideRuleTier, "seatSectionId" | "status">,
>(
  event: Pick<EventRecord, "status">,
  ticketTypes: readonly T[],
  sectionIds: Iterable<string>,
): Map<string, T[]> {
  const countsEveryTier = event.status === "DRAFT";
  const bySection = new Map<string, T[]>(
    [...sectionIds].map((id) => [id, []]),
  );
  for (const tier of ticketTypes) {
    if (!tier.seatSectionId) continue;
    if (!countsEveryTier && tier.status !== "ACTIVE") continue;
    bySection.get(tier.seatSectionId)?.push(tier);
  }
  return bySection;
}

/**
 * Why setting a price on a seat of this section is refused, or `null` when it
 * is allowed. Judged on the section's counting tiers (`tiersForSections`):
 *   - any ADJUSTABLE (pay-what-you-want) tier → `ADJUSTABLE_TIER`: that
 *     buyer names the price, so an override would never be charged (D-004),
 *     even when a FIXED tier shares the section;
 *   - otherwise no FIXED tier → `NO_FIXED_TIER`.
 * Clearing an override is never refused.
 */
export type SeatPriceOverrideRefusal = "ADJUSTABLE_TIER" | "NO_FIXED_TIER";

export function seatPriceOverrideRefusal(
  tiers: readonly Pick<EventTicketTypeSummary, "pricingMode">[],
): SeatPriceOverrideRefusal | null {
  if (tiers.some((t) => t.pricingMode === "ADJUSTABLE")) {
    return "ADJUSTABLE_TIER";
  }
  if (!tiers.some((t) => t.pricingMode === "FIXED")) {
    return "NO_FIXED_TIER";
  }
  return null;
}

/** FR-006: every section sells through FIXED tiers only, and has one. */
export function ensureSectionsSellAtFixedPrice(bySection: SectionTiers): void {
  const adjustableSections: string[] = [];
  const adjustableTiers: string[] = [];
  const noFixedSections: string[] = [];
  for (const [sectionId, tiers] of bySection) {
    switch (seatPriceOverrideRefusal(tiers)) {
      case "ADJUSTABLE_TIER":
        adjustableSections.push(sectionId);
        adjustableTiers.push(
          ...tiers
            .filter((t) => t.pricingMode === "ADJUSTABLE")
            .map((t) => t.id),
        );
        break;
      case "NO_FIXED_TIER":
        noFixedSections.push(sectionId);
        break;
      case null:
        break;
    }
  }
  if (adjustableSections.length > 0) {
    throw fail("SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER", {
      meta: {
        seatSectionIds: adjustableSections,
        ticketTypeIds: adjustableTiers,
      },
    });
  }
  if (noFixedSections.length > 0) {
    throw fail("SEAT_PRICE_OVERRIDE_NO_FIXED_TIER", {
      meta: { seatSectionIds: noFixedSections },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paid price on a free tier (WRITE RULES 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which free→paid gates a PAID (> 0) override on seats sold by `tiers` must
 * pass: the same predicates `updateTicketType` gates a tier's free→paid flip
 * with. A tier that already takes money passed its gate when it was priced,
 * so only a FREE tier among them triggers one.
 */
export type PaidOverrideGates = { stripe: boolean; feePolicy: boolean };

/** What the two free→paid predicates read of a tier. */
type PaidGateTier = Pick<
  OverrideRuleTier,
  "pricingMode" | "priceCents" | "scheduledPriceCents" | "minimumCents"
>;

export function paidOverrideGates(
  tiers: readonly PaidGateTier[],
): PaidOverrideGates {
  return {
    stripe: tiers.some((tier) => !ticketTypeRequiresStripe(tier)),
    feePolicy: tiers.some((tier) => !ticketTypeNeedsFeePolicy(tier)),
  };
}

/**
 * The write's gate: Stripe first, then the fee policy, so a seat missing both
 * reports the same code the tier editor would.
 */
export async function ensurePaidOverrideGates(
  tx: TxRepos,
  event: EventRecord,
  tiers: readonly PaidGateTier[],
  now: Date,
  feePolicyDeps: FeePolicyTicketingGateDeps,
): Promise<void> {
  const gates = paidOverrideGates(tiers);
  if (gates.stripe) {
    await ensureStripeConnectedForPaidTicketing(tx, event);
  }
  if (gates.feePolicy) {
    await ensureFeePolicyResolvableForPaidTicketing(
      tx,
      event,
      now,
      feePolicyDeps,
    );
  }
}

export type PaidOverrideBlock = "STRIPE" | "FEE_POLICY";

/**
 * The read's side of {@link ensurePaidOverrideGates}: the SAME two gate
 * functions, run once each for the whole event (only when some section
 * needs them), with their refusal turned into a fact instead of a throw.
 * Any other failure (a database error) still throws. Returns, per set of
 * section tiers, the code the write would refuse a paid override with
 * right now, or `null`.
 */
export async function probePaidOverrideGates(
  tx: TxRepos,
  event: EventRecord,
  needed: PaidOverrideGates,
  now: Date,
  feePolicyDeps: FeePolicyTicketingGateDeps,
): Promise<(gates: PaidOverrideGates) => PaidOverrideBlock | null> {
  const stripeLinked = needed.stripe
    ? await passes(
        () => ensureStripeConnectedForPaidTicketing(tx, event),
        "PAID_TICKETING_REQUIRES_STRIPE",
      )
    : true;
  const feePolicyResolves = needed.feePolicy
    ? await passes(
        () =>
          ensureFeePolicyResolvableForPaidTicketing(
            tx,
            event,
            now,
            feePolicyDeps,
          ),
        "PAID_TICKETING_REQUIRES_FEE_POLICY",
      )
    : true;
  // Same order as the write: Stripe is refused first.
  return (gates) => {
    if (gates.stripe && !stripeLinked) return "STRIPE";
    if (gates.feePolicy && !feePolicyResolves) return "FEE_POLICY";
    return null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Will a stored override take money? (the publish gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether checkout charges a seat's override in a section sold by `tiers`:
 * a FIXED tier sells the seat at its override, an ADJUSTABLE tier ignores it
 * (D-004). Wider than `seatPriceOverrideRefusal(tiers) === null` on purpose:
 * a section shared by a FIXED and an ADJUSTABLE tier refuses a NEW price, but
 * a FIXED-tier sale there still charges a price already stored.
 */
export function sectionChargesSeatOverrides(
  tiers: readonly Pick<EventTicketTypeSummary, "pricingMode">[],
): boolean {
  return tiers.some((tier) => tier.pricingMode === "FIXED");
}

export type StoredSeatOverrideCharges = {
  /** A seat a FIXED tier sells carries a valid override above $0. */
  paid: boolean;
  /** The sections where one does. Sorted, distinct; empty when `paid` is false. */
  paidSectionIds: string[];
  /**
   * Sections a FIXED tier sells that hold an override checkout refuses
   * (`seatOverrideCents`): the `{ invalid: true }` marker, or a negative,
   * fractional or unsafe amount. Sorted, distinct.
   */
  invalidSectionIds: string[];
};

/**
 * What the event's stored overrides can charge, judged with the write's
 * counting rule (`tiersForSections`: every tier on a DRAFT, ACTIVE tiers
 * otherwise) and the charge's amount rule (`classifySeatOverride`). An
 * override in a section no FIXED tier sells is never charged and is ignored,
 * corrupt or not.
 */
export function storedSeatOverrideCharges(
  event: Pick<EventRecord, "status">,
  ticketTypes: readonly Pick<
    OverrideRuleTier,
    "seatSectionId" | "status" | "pricingMode"
  >[],
  overrides: readonly SeatSectionPriceOverride[],
): StoredSeatOverrideCharges {
  const bySection = tiersForSections(
    event,
    ticketTypes,
    overrides.map((o) => o.seatSectionId),
  );
  const paid = new Set<string>();
  const invalid = new Set<string>();
  for (const { seatSectionId, priceOverride } of overrides) {
    if (!sectionChargesSeatOverrides(bySection.get(seatSectionId) ?? [])) {
      continue;
    }
    const cents = classifySeatOverride(priceOverride);
    if (cents === "invalid") {
      invalid.add(seatSectionId);
    } else if (cents !== null && cents > 0) {
      paid.add(seatSectionId);
    }
  }
  return {
    paid: paid.size > 0,
    paidSectionIds: [...paid].sort(),
    invalidSectionIds: [...invalid].sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A ticket type write that starts charging a stored override
// ─────────────────────────────────────────────────────────────────────────────

/** One ticket type as a write finds it and as the write leaves it. */
export type TierSectionWrite = {
  /** The stored tier; `null` when the write creates it. */
  before: Pick<OverrideRuleTier, "pricingMode" | "seatSectionId"> | null;
  /** The tier as the write will store it. */
  after: OverrideRuleTier;
};

/**
 * The section this write makes the tier START selling at a FIXED price, or
 * `null`. A tier that already sold that section at a FIXED price starts
 * nothing; neither does an unassign, a delete or a switch to ADJUSTABLE,
 * which is why those writes are never refused here.
 */
export function sectionNewlySoldAtFixedPrice(
  write: TierSectionWrite,
): string | null {
  const { before, after } = write;
  if (after.pricingMode !== "FIXED" || !after.seatSectionId) return null;
  if (
    before?.pricingMode === "FIXED" &&
    before.seatSectionId === after.seatSectionId
  ) {
    return null;
  }
  return after.seatSectionId;
}

export type TierWriteOverrideGateDeps = {
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
  /**
   * The calling use case, e.g. `"upsertTicketType"`: the `useCase` tag on a
   * corrupt-value report and the fee-policy walk's `source`.
   */
  source: string;
};

/**
 * The gate a ticket type write runs before it stores: a FREE tier may not
 * start selling, at a FIXED price, a section that already stores a paid seat
 * override without the gates the override write itself runs
 * ({@link ensurePaidOverrideGates}: a linked Stripe account, then a
 * resolvable fee policy; `PAID_TICKETING_REQUIRES_STRIPE` /
 * `PAID_TICKETING_REQUIRES_FEE_POLICY`). Checkout charges the override, not
 * the tier's $0, so without this an override gated once could go on sale
 * again later with nothing checked (override set, tier unassigned, event
 * published as free, tier assigned back).
 *
 * Reads the seats at most once (`listDistinctPriceOverridesByEvent`), and
 * not at all when:
 *   - no write makes a tier start selling a section at a FIXED price
 *     ({@link sectionNewlySoldAtFixedPrice}); or
 *   - every tier that does is itself paid. A tier that takes money passed
 *     these same gates when it was priced, the rule `paidOverrideGates`
 *     applies to the override write.
 * The stored overrides are judged against the tiers AS WRITTEN
 * (`storedSeatOverrideCharges`), with the override write's counting rule: on
 * a PUBLISHED event a tier that is not ACTIVE sells nothing until the next
 * publish, whose own gate covers it.
 *
 * A stored value checkout refuses, in a section such a tier starts selling,
 * counts as paid (the amount behind it is unknown) and is reported, as at
 * publish. A refusal carries {@link StoredSeatPriceRefusalMeta}.
 *
 * NOT SERIALISED, on purpose. The callers read the tier and this reads the
 * seats without a lock, so two concurrent writes can each pass on a state
 * the other is changing (a mode switch and an assign of the same tier; an
 * override write and an assign beside a paid tier). Do not close that with
 * `events.lockRows(update)`: checkout and mint lock Seat and SeatSection rows
 * first (`findByIdsForUpdate`, no `OF`) and reach the Event row afterwards
 * through the Order / Ticket foreign key, so a tier write holding the event
 * row and then pointing a tier at a section deadlocks with a checkout in
 * that section (40P01; the `ticket_type_capacity` advisory lock exists for
 * the same reason). The accepted gaps are listed in the spec's `as_built`
 * entry "tier write gate (7e)". A card payment still needs a Ready account
 * at checkout in each of them.
 */
export async function ensureStoredOverridesGatedForTierWrites(
  tx: TxRepos,
  event: EventRecord,
  writes: readonly TierSectionWrite[],
  now: Date,
  deps: TierWriteOverrideGateDeps,
): Promise<void> {
  const startingTiers = writes
    .filter((write) => sectionNewlySoldAtFixedPrice(write) !== null)
    .map((write) => write.after)
    .filter((tier) => {
      const gates = paidOverrideGates([tier]);
      return gates.stripe || gates.feePolicy;
    });
  if (startingTiers.length === 0) return;

  // Judged against the starting tiers alone, so an override in a section
  // none of them sells is ignored (`storedSeatOverrideCharges`).
  const overrides = await tx.seats.listDistinctPriceOverridesByEvent({
    eventId: event.id,
  });
  const charges = storedSeatOverrideCharges(event, startingTiers, overrides);
  if (!charges.paid && charges.invalidSectionIds.length === 0) return;

  if (charges.invalidSectionIds.length > 0) {
    const invalid = new Error(
      "seat_price_override_invalid_at_tier_write: a section a FIXED tier is about to sell stores an override checkout refuses; the write counts it as paid",
    );
    // Guarded: a throwing reporter does not change the gate's verdict.
    reportBestEffort(deps.reportError, invalid, {
      tags: { useCase: deps.source, fault: "seat_price_override_invalid" },
      extra: {
        eventId: event.id,
        seatSectionIds: charges.invalidSectionIds,
      },
    });
    deps.logger?.error("seat_price_override_invalid_at_tier_write", {
      eventId: event.id,
      seatSectionIds: charges.invalidSectionIds,
      useCase: deps.source,
    });
  }

  try {
    await ensurePaidOverrideGates(tx, event, startingTiers, now, deps);
  } catch (err) {
    // Not a swallow: the same refusal goes out, now saying why. The tier is
    // free, so without this the organizer is told a $0 ticket needs payouts
    // and nothing names the seat price behind it.
    if (
      isAppError(err) &&
      (err.code === "PAID_TICKETING_REQUIRES_STRIPE" ||
        err.code === "PAID_TICKETING_REQUIRES_FEE_POLICY")
    ) {
      throw fail(err.code, {
        message: err.message,
        category: err.category,
        meta: { ...(err.meta ?? {}), ...storedSeatPriceRefusalMeta(charges) },
      });
    }
    throw err;
  }
}

/**
 * What a tier write's refusal says about the stored seat prices behind it,
 * on `meta` (the wire's `error.data.meta`). Never read to decide.
 *   - `cause`: `"stored_seat_price"`, or `"seat_price_override_invalid"`
 *     when a value checkout refuses is the ONLY reason (the same cause
 *     publish puts on its Stripe refusal);
 *   - `seatSectionIds`: every section behind the refusal, sorted;
 *   - `invalidSeatSectionIds`: those of them holding a value checkout
 *     refuses (empty when none).
 * The ways out it lets a client name: clear or zero the price in those
 * sections, or put the tier on another section.
 */
export type StoredSeatPriceRefusalMeta = {
  cause: "stored_seat_price" | "seat_price_override_invalid";
  seatSectionIds: string[];
  invalidSeatSectionIds: string[];
};

export function storedSeatPriceRefusalMeta(
  charges: StoredSeatOverrideCharges,
): StoredSeatPriceRefusalMeta {
  return {
    cause: charges.paid ? "stored_seat_price" : "seat_price_override_invalid",
    seatSectionIds: [
      ...new Set([...charges.paidSectionIds, ...charges.invalidSectionIds]),
    ].sort(),
    invalidSeatSectionIds: [...charges.invalidSectionIds],
  };
}

async function passes(
  gate: () => Promise<void>,
  refusalCode: "PAID_TICKETING_REQUIRES_STRIPE" | "PAID_TICKETING_REQUIRES_FEE_POLICY",
): Promise<boolean> {
  try {
    await gate();
    return true;
  } catch (err) {
    if (isAppError(err) && err.code === refusalCode) return false;
    throw err;
  }
}
