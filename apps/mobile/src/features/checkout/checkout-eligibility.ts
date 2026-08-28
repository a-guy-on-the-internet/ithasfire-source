/**
 * Pure checkout-path eligibility (FR-002, FR-011).
 *
 * Decides which purchase surface the event detail screen offers:
 *
 *   - "native"   — GA-only, ungated (or gate passed) → in-app checkout
 *   - "password" — password gate still locked → native password prompt
 *   - "web"      — flows the app can't serve (application gate, reserved
 *                  seating, waivers) → deep-link to web checkout
 *   - "hidden"   — no purchase CTA at all (feature gate off / not sellable)
 *
 * Rule order matters: hidden checks run first, then gates, then
 * seating/waiver fallbacks. No React, no transport — keep this testable.
 */

export type CheckoutPath = "native" | "password" | "web" | "hidden";

/** Mirrors `eventGateTypeSchema` in `@th/schema`. */
export type CheckoutGateType = "NONE" | "PASSWORD" | "APPLICATION";

export type ResolveCheckoutPathInput = {
  /** `features.getFeatureGates().buyTickets`. False hides every purchase CTA. */
  enableBuyTickets: boolean;
  /**
   * `listEventTicketTypes().sellability.available`. Pass `null` when unknown
   * (the procedure is FORBIDDEN while the event gate is still locked) — the
   * gate rules below decide the path in that case.
   */
  sellabilityAvailable: boolean | null;
  /** From `events.getGateState`. */
  gateType: CheckoutGateType;
  /** From `events.getGateState` — already false when bypassed/unlocked. */
  passwordRequired: boolean;
  viewerCanBypass: boolean;
  viewerIsUnlocked: boolean;
  /** `listEventTicketTypes().placeLayoutId` — non-null means reserved seating. */
  placeLayoutId: string | null;
  /**
   * Whether `waivers.getEventWaiver` returned a waiver. Pass `null` when
   * unknown (still loading / gate-locked); treated as "no waiver" because the
   * gate rules above resolve locked events before this rule is reached.
   */
  hasWaiver: boolean | null;
};

export const resolveCheckoutPath = (
  input: ResolveCheckoutPathInput,
): CheckoutPath => {
  // 1. Feature gate off → no CTA anywhere (FR-002).
  if (!input.enableBuyTickets) return "hidden";

  // 2. Not sellable (sales closed, Stripe not connected, …) → informational
  //    note instead of a CTA. `null` (unknown) falls through to the gates.
  if (input.sellabilityAvailable === false) return "hidden";

  // 3. Application gate the viewer hasn't passed → web handles submission.
  if (
    input.gateType === "APPLICATION" &&
    !input.viewerCanBypass &&
    !input.viewerIsUnlocked
  ) {
    return "web";
  }

  // 4. Locked password gate → native password prompt (FR-011).
  if (input.gateType === "PASSWORD" && input.passwordRequired) {
    return "password";
  }

  // 5. Reserved seating → web seat picker.
  if (input.placeLayoutId !== null) return "web";

  // 6. Waiver-bearing events → web waiver acceptance flow.
  if (input.hasWaiver === true) return "web";

  // 7. GA, ungated (or unlocked), no waiver → native checkout.
  return "native";
};
