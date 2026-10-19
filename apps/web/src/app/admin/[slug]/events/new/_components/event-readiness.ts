/**
 * Pure publish-readiness computation for the event builder (FR-104).
 *
 * No React, no tRPC — the caller (EventBuilder / the readiness rail) derives
 * the input booleans from its existing state and queries and passes them in.
 * The semantics deliberately mirror the existing gates in EventBuilder.tsx:
 *
 * - "paid ticket types exist" mirrors `hasPaidTicketTypesForChargebackTerms`:
 *   `ticketTypes.some(tt => tt.priceCents > 0 || tt.pricingMode === "ADJUSTABLE")`.
 *   The caller computes that and passes `hasPaidTicketTypes`.
 * - The Stripe item mirrors `blockedByStripeConnect`: only relevant when paid
 *   ticket types exist; "onboarded" means the Connect status query reports
 *   `payoutsEnabled === true`. The caller is responsible for the surrounding
 *   gates that live outside pure data (DRAFT status, org-owned, query success)
 *   when deriving `stripeOnboarded`.
 * - The chargeback-terms item is only required when paid ticket types exist;
 *   "accepted" is an acceptance made in this builder session or a stored
 *   acceptance of the current terms version on the event's owner (combined
 *   in `mapReadinessInput`).
 * - The host-attestation item mirrors the publish flow's
 *   `eventStatus === "DRAFT" && usesPrivateHostAttestation` gate
 *   (`usesPrivateHostAttestation = visibilityMode === "OBSCURED"`); "complete"
 *   mirrors `HOST_ATTESTATION_FIELDS.every(field => hostAttestation[field])`.
 *   The caller passes both as `hostAttestationRequired` /
 *   `hostAttestationComplete`; when not required the item is absent entirely.
 * - The category item mirrors `ensureEventPublishable`'s
 *   `if (!event.categoryId) throw fail("EVENT_CATEGORY_MISSING")`
 *   (packages/core/src/use-cases/events/publish-event.ts). Presence only:
 *   publish does not look at `category.active`, so neither does this.
 * - Lineup is informational only (FR-104): never blocking, never affects
 *   `allClear`.
 */

export type ReadinessItemId =
  | "essentials"
  | "category"
  | "details"
  | "ticketTypes"
  | "lineup"
  | "stripePayouts"
  | "chargebackTerms"
  | "hostAttestation";

export type ReadinessItemStatus = "done" | "todo" | "info";

export type ReadinessItem = {
  id: ReadinessItemId;
  status: ReadinessItemStatus;
  blocking: boolean;
};

export type EventReadinessInput = {
  /** Event title; empty string counts as missing (mirrors `!title`). */
  title: string;
  /** Starts-at value; empty string counts as missing (mirrors `!startsAt`). */
  startsAt: string;
  /** Whether a venue/location is set. */
  hasVenue: boolean;
  /** Whether the saved event has a category (publish refuses without one). */
  hasCategory: boolean;
  /** Whether the prose/details body has any content. */
  detailsNonEmpty: boolean;
  /** Number of ticket types on the event. */
  ticketTypeCount: number;
  /**
   * Mirrors `hasPaidTicketTypesForChargebackTerms`:
   * some ticket type has priceCents > 0 or pricingMode === "ADJUSTABLE".
   */
  hasPaidTicketTypes: boolean;
  /** Connect status `payoutsEnabled === true` for the payee. */
  stripeOnboarded: boolean;
  /** Accepted this session, or stored for the current version (see readiness-input.ts). */
  chargebackTermsAccepted: boolean;
  /**
   * Mirrors the publish gate `eventStatus === "DRAFT" &&
   * usesPrivateHostAttestation` (visibilityMode === "OBSCURED").
   */
  hostAttestationRequired: boolean;
  /** Mirrors `HOST_ATTESTATION_FIELDS.every(f => hostAttestation[f])`. */
  hostAttestationComplete: boolean;
  /** Number of confirmed lineup entries. */
  lineupCount: number;
};

export type EventReadiness = {
  /** All checks in fixed display order. */
  items: ReadinessItem[];
  /** Blocking items that are not done (never includes lineup). */
  blockers: ReadinessItem[];
  /** True when no blockers remain — lineup never affects this. */
  allClear: boolean;
};

const blockingItem = (id: ReadinessItemId, done: boolean): ReadinessItem => ({
  id,
  status: done ? "done" : "todo",
  blocking: true,
});

export function computeEventReadiness(
  input: EventReadinessInput,
): EventReadiness {
  const items: ReadinessItem[] = [];

  // Essentials: title + starts-at + venue. Mirrors the save-time field
  // validation (`!title`, `!startsAt`) plus the publish requirement of a
  // saved location.
  const essentialsDone =
    Boolean(input.title) && Boolean(input.startsAt) && input.hasVenue;
  items.push(blockingItem("essentials", essentialsDone));

  // Category: set inside the Essentials section, so it reads right after it.
  items.push(blockingItem("category", input.hasCategory));

  items.push(blockingItem("details", input.detailsNonEmpty));

  items.push(blockingItem("ticketTypes", input.ticketTypeCount > 0));

  // Lineup is informational only — "done" when at least one entry exists,
  // otherwise a non-blocking "info" nudge. Never a blocker (FR-104).
  items.push({
    id: "lineup",
    status: input.lineupCount > 0 ? "done" : "info",
    blocking: false,
  });

  // Stripe payouts: only present at all when paid ticket types exist
  // (mirrors `blockedByStripeConnect`'s `hasPaidTicketTypesForChargebackTerms`
  // precondition). Free-only events never see this item.
  if (input.hasPaidTicketTypes) {
    items.push(blockingItem("stripePayouts", input.stripeOnboarded));
  }

  // Chargeback terms: required exactly when paid ticket types exist
  // (mirrors `shouldShowChargebackTermsBanner`).
  if (input.hasPaidTicketTypes) {
    items.push(blockingItem("chargebackTerms", input.chargebackTermsAccepted));
  }

  // Host attestation: only present when required (OBSCURED-location DRAFT
  // publish); absent for commercial venues.
  if (input.hostAttestationRequired) {
    items.push(blockingItem("hostAttestation", input.hostAttestationComplete));
  }

  const blockers = items.filter(
    (item) => item.blocking && item.status !== "done",
  );

  return { items, blockers, allClear: blockers.length === 0 };
}
