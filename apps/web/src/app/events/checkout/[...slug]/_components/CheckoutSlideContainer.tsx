"use client";

import type React from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SlideDirection = "forward" | "back" | "fade";

export type CheckoutSlideContainerProps = {
  /** Unique key per step — forces React to remount and replay the animation. */
  stepKey: string;
  /** Direction of the transition. "fade" uses a scale fade for confirmation. */
  direction: SlideDirection;
  children: React.ReactNode;
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const CLASS_MAP: Record<SlideDirection, string> = {
  forward: "th-checkout-slide-forward",
  back: "th-checkout-slide-back",
  fade: "th-checkout-fade-in",
};

/**
 * Wraps a checkout step's content and applies a CSS slide/fade animation
 * when the step key changes.
 *
 * Usage:
 * ```tsx
 * <CheckoutSlideContainer stepKey={currentStep} direction={slideDirection}>
 *   {currentStep === "tickets" && <TicketStep />}
 *   {currentStep === "details" && <DetailsStep />}
 *   ...
 * </CheckoutSlideContainer>
 * ```
 *
 * The animation classes (`th-checkout-slide-forward`, `th-checkout-slide-back`,
 * `th-checkout-fade-in`) are defined in `globals.css`.
 *
 * ## Why this does NOT hold the outgoing step's height
 *
 * The div is keyed on the step, so advancing unmounts the outgoing subtree and
 * mounts the incoming one in a single commit — and the incoming one starts at
 * `opacity: 0`. That combination once produced a real defect: 952px of filled
 * details form replaced by a 544px payment step fading in from nothing, because
 * the payment card is lazily loaded and had no placeholder.
 *
 * A `min-height` floor here, pinned to the outgoing height for the length of the
 * entrance, was built for that and then MEASURED AWAY. Two findings killed it:
 *
 *  - **It bridges nothing.** The fix belongs to the step, not the container.
 *    `checkout.css` is in the page bundle from first paint and `next/dynamic`'s
 *    `loading:` renders the skeleton in the same commit that mounts the step, so
 *    the payment step's FIRST painted frame is already at its reserved height.
 *    Measured with the floor removed: the wrapper still never drops below 947px
 *    out of an outgoing 952px.
 *  - **It actively hurt.** The floor's only remaining effect was holding the
 *    OUTGOING height for 300ms, and the details step is TALLER than the payment
 *    step at most widths — measured details/payment 950/947 at 1280px,
 *    1144/1113 at 390px, 1195/1131 at 320px. That is a fully-opaque snap-down
 *    after the fade has finished, which is a worse read than collapsing under
 *    it, and it is exactly the failure that made the floor wrong for
 *    payment → tickets.
 *
 * So: if a step's content arrives late, give THAT step a reserved height (see
 * `.checkout-payment-slot` in `checkout.css`). Do not reach for a floor here.
 */
export const CheckoutSlideContainer = ({
  stepKey,
  direction,
  children,
}: CheckoutSlideContainerProps) => (
  <div key={stepKey} className={CLASS_MAP[direction]}>
    {children}
  </div>
);
