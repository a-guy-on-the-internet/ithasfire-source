/**
 * Pure derivations for the public event detail page — kept out of the
 * component so the RSVP-vs-ticketed branching (community-managed-event-
 * listings spec) is unit-testable.
 */

export type EventAttendanceMode = "TICKETED" | "RSVP";
export type EventStewardship = "OWNED" | "COMMUNITY";

export type EventSellabilityReason =
  | "ok"
  | "free"
  | "no_payee"
  | "stripe_not_connected"
  | "sales_closed";

export type EventDetailModeInput = {
  attendanceMode?: EventAttendanceMode;
  /** Caller-level CTA suppression (feature gate off / payout not ready). */
  hideTicketCta?: boolean;
  sellabilityReason?: EventSellabilityReason;
};

export type EventDetailMode = {
  /** RSVP events never render any ticketed-path UI. */
  isRsvp: boolean;
  /** Effective CTA suppression — always true for RSVP events. */
  hideTicketCta: boolean;
  /**
   * Organizer-side "payment setup required" banner. RSVP events have no
   * payee BY DESIGN, so their `no_payee` sellability reason must never
   * surface this banner — the attendanceMode branch takes precedence.
   */
  showPaymentSetupNotice: boolean;
  /** "Sales closed" banner — also a ticketed-path concept only. */
  showSalesClosedNotice: boolean;
};

export function deriveEventDetailMode({
  attendanceMode = "TICKETED",
  hideTicketCta = false,
  sellabilityReason,
}: EventDetailModeInput): EventDetailMode {
  const isRsvp = attendanceMode === "RSVP";
  return {
    isRsvp,
    hideTicketCta: isRsvp || hideTicketCta,
    showPaymentSetupNotice:
      !isRsvp &&
      (sellabilityReason === "no_payee" ||
        sellabilityReason === "stripe_not_connected"),
    showSalesClosedNotice: !isRsvp && sellabilityReason === "sales_closed",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tier sale state (FR-010) + scheduled-price copy (Q-002)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-010's per-tier derivations are a SIBLING of {@link deriveEventDetailMode},
 * not an extension of it, and the split is the point.
 *
 * `deriveEventDetailMode` answers questions about the EVENT — is this an RSVP
 * listing, should the page banner "payment setup required", should it banner
 * "sales closed". Those are page-level facts and each renders ONCE. Whether a
 * tier is on sale is a fact about ONE ROW in the ticket list, and an event can
 * hold four rows in four different states at the same instant. Folding it into
 * the event-level derivation would force the caller to pass a tier into a
 * function that also decides page chrome, which is how a per-tier fact ends up
 * hiding the whole Buy CTA.
 *
 * They live in `@/components/events/ticket-tier-state` rather than here because
 * `TicketsSection` and the embed widget's `EmbedTicketTypeList` both consume
 * them, and a shared component reaching into this route's `_components` would
 * mean renaming the route breaks the ticket list. Re-exported so the event
 * page's established import path keeps working.
 */
export {
  deriveTicketTierState,
  formatEventZonedInstant,
} from "@/components/events/ticket-tier-state";
export type {
  TicketTierPriceChange,
  TicketTierSellability,
  TicketTierSellabilityReason,
  TicketTierState,
  TicketTierStateInput,
} from "@/components/events/ticket-tier-state";

// `export … from` does not bind locally; the drift guard below needs the type
// in scope. Type-only, so nothing is emitted.
import type { TicketTierSellabilityReason } from "@/components/events/ticket-tier-state";

/**
 * DRIFT GUARD, compile-time and NOT decorative.
 *
 * `TicketTierSellabilityReason` spells the five event-wide reasons out rather
 * than importing {@link EventSellabilityReason}, so the shared module owes
 * nothing to a route folder. This assertion is the thing that stops the two
 * copies diverging: add a reason to the event-level union without adding it to
 * the tier union and `Assert<false>` fails the build here — instead of the tier
 * silently falling through `deriveTicketTierState`'s final branch and rendering
 * an unhandled event-wide refusal as a normal row.
 *
 * Deliberately ONE-DIRECTIONAL. The tier union is a strict SUPERSET: it also
 * carries `not_yet_on_sale` and `sales_ended`, which are per-tier facts and must
 * never appear on the event-level flag.
 */
type Assert<T extends true> = T;
type _AssertEventReasonsSubsetOfTierReasons = Assert<
  EventSellabilityReason extends TicketTierSellabilityReason ? true : false
>;

/**
 * "Suggest an edit" is offered ONLY on COMMUNITY-stewarded published PUBLIC
 * events. FR-006's original "universal on all published PUBLIC events" rule
 * was REVERSED on 2026-07-20 — offering it on OWNED events invited trolling,
 * and the backend now enforces the same boundary
 * (`ensureCommunitySuggestibleEvent` rejects OWNED events with
 * EVENT_NOT_FOUND on both submit and get-suggestion-base), so an OWNED CTA
 * would dead-end anyway. Draft, PRIVATE, and gate-locked views never show
 * it either: the submit path rejects anything non-PUBLIC. Gated events are
 * excluded by gate type, not by unlock state — the page only reaches the
 * full detail render for unlocked/bypass viewers.
 */
export function isSuggestEditVisible({
  status,
  visibility,
  gateType,
  stewardship,
}: {
  status: string;
  visibility?: "PUBLIC" | "PRIVATE" | null;
  gateType?: "NONE" | "PASSWORD" | "APPLICATION" | null;
  stewardship: EventStewardship;
}): boolean {
  return (
    stewardship === "COMMUNITY" &&
    status === "PUBLISHED" &&
    (visibility ?? "PUBLIC") === "PUBLIC" &&
    (gateType ?? "NONE") === "NONE"
  );
}
