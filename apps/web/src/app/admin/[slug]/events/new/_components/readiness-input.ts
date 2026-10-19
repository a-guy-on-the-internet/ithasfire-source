/**
 * Maps EventBuilder's live state/queries onto the pure readiness module's
 * input (FR-104), mirroring the EXACT semantics of the banners the rail
 * replaces (FR-105 — presentation-only change, no new gating logic).
 *
 * Mirrored expressions (EventBuilder.tsx):
 *
 * - `hasPaidTicketTypes` ← `hasPaidTicketTypesForChargebackTerms`.
 * - Stripe item ← `blockedByStripeConnect`:
 *   `canEditEvent && hasPaidTicketTypesForChargebackTerms &&
 *    eventStatus === "DRAFT" && isOrgOwner && connectStatusQuery.isSuccess &&
 *    !connectFullyEnabled`.
 *   NB: "mirrors" here means mirrors the CLIENT flag, which is itself only an
 *   approximation of the server's publish gate — see the long comment on
 *   `blockedByStripeConnect` in EventBuilder.tsx for exactly where the two
 *   diverge (data source, human-owned events, co-payee lines). Do not read
 *   these mappings as a guarantee that Publish will succeed.
 *   The caller renders the rail only under `canEditEvent`, so here we mirror
 *   the remaining gates:
 *     - Human-owned events have no Connect status endpoint and the banner
 *       stayed silent for them — the item is OMITTED (`hideStripeItem`).
 *     - While the status query hasn't succeeded the state is unknowable —
 *       OMITTED, matching today's silence.
 *     - For non-DRAFT events the banner never showed (`eventStatus ===
 *       "DRAFT"` gate) — the item reads done (`stripeOnboarded: true`).
 * - Chargeback-terms item ← accepted in this builder session
 *   (`chargebackTermsAcceptedThisSession`) OR a stored acceptance of the
 *   CURRENT terms version on the event's owner
 *   (`storedChargebackTermsAcceptance === "current"`, read through
 *   `useStoredChargebackTermsAcceptance`). Any other stored status (loading,
 *   read failed, `forbidden` for a non-finance org member, stale version)
 *   leaves the session flag to decide. No event-status gate. Like every item
 *   here this is advisory: the server's publish check is the gate, and a
 *   `chargeback_terms_required` refusal still opens the terms dialog.
 * - Category ← the server's publish gate (`EVENT_CATEGORY_MISSING`):
 *   `Boolean(eventForEditQuery.data?.categoryId)`.
 * - Host attestation ← the publish flow's
 *   `eventStatus === "DRAFT" && usesPrivateHostAttestation`
 *   (`visibilityMode === "OBSCURED"`); complete ←
 *   `allHostAttestationChecked`.
 */

import type { EventLocationMode } from "@th/types";

import type { ChargebackTermsAcceptance } from "@/app/admin/[slug]/payouts/_components/chargeback-terms-acceptance";

import type { EventReadinessInput } from "./event-readiness";

export type ReadinessRailState = {
  /** Event title from builder state. */
  title: string;
  /** Starts-at (datetime-local string) from builder state; undefined = unset. */
  startsAt: string | undefined;
  /** Whether the builder holds a usable venue/location (place or geocoded address). */
  hasVenue: boolean;
  /** `Boolean(eventForEditQuery.data?.categoryId)` — the SAVED category. */
  hasCategory: boolean;
  /** `hasContent(bodyContent)` — prose body has meaningful content. */
  detailsNonEmpty: boolean;
  /** `ticketTypesForEditQuery.data?.ticketTypes.length ?? 0`. */
  ticketTypeCount: number;
  /** Mirrors `hasPaidTicketTypesForChargebackTerms`. */
  hasPaidTicketTypes: boolean;
  /** Mirrors `isOrgOwner` (`ownerType === "org"`). */
  isOrgOwner: boolean;
  /** `eventForEditQuery.data?.status ?? "DRAFT"`. */
  eventStatus: string;
  /** Mirrors `connectStatusQuery.isSuccess`. */
  connectStatusKnown: boolean;
  /** Mirrors `connectFullyEnabled` (live `chargesEnabled && payoutsEnabled`). */
  payoutsEnabled: boolean;
  /** Terms accepted inside this builder session. */
  chargebackTermsAcceptedThisSession: boolean;
  /**
   * The owner's stored acceptance (`useStoredChargebackTermsAcceptance`).
   * Only `"current"` counts; every other status defers to the session flag.
   */
  storedChargebackTermsAcceptance: ChargebackTermsAcceptance["status"];
  /** Location visibility mode from builder state. */
  visibilityMode: EventLocationMode;
  /** Mirrors `allHostAttestationChecked`. */
  allHostAttestationChecked: boolean;
  /** `lineupListQuery.data?.length ?? 0`. */
  lineupCount: number;
};

export type MappedReadinessInput = {
  input: EventReadinessInput;
  /**
   * True when the Stripe item must not render at all: paid ticket types
   * exist but the Connect status is unknowable (human-owned event, or the
   * status query hasn't succeeded). Matches the banner's silence in those
   * states. The paired `input.stripeOnboarded: true` keeps the hidden item
   * out of `blockers`/`allClear`.
   */
  hideStripeItem: boolean;
};

export function mapReadinessInput(
  state: ReadinessRailState,
): MappedReadinessInput {
  // Connect status is only knowable for org-owned events with a successful
  // status query (`trpc.stripeConnect.getStatus` has no human variant yet).
  const stripeStatusKnowable = state.isOrgOwner && state.connectStatusKnown;

  // Mirrors `blockedByStripeConnect`'s remaining gates: only a DRAFT event
  // with a known, not-enabled payout status reads as "todo". Non-DRAFT
  // events never showed the banner, so they read done.
  const stripeOnboarded = !stripeStatusKnowable
    ? true
    : state.eventStatus !== "DRAFT" || state.payoutsEnabled;

  return {
    input: {
      title: state.title,
      startsAt: state.startsAt ?? "",
      hasVenue: state.hasVenue,
      hasCategory: state.hasCategory,
      detailsNonEmpty: state.detailsNonEmpty,
      ticketTypeCount: state.ticketTypeCount,
      hasPaidTicketTypes: state.hasPaidTicketTypes,
      stripeOnboarded,
      chargebackTermsAccepted:
        state.chargebackTermsAcceptedThisSession ||
        state.storedChargebackTermsAcceptance === "current",
      hostAttestationRequired:
        state.eventStatus === "DRAFT" && state.visibilityMode === "OBSCURED",
      hostAttestationComplete: state.allHostAttestationChecked,
      lineupCount: state.lineupCount,
    },
    hideStripeItem: state.hasPaidTicketTypes && !stripeStatusKnowable,
  };
}
