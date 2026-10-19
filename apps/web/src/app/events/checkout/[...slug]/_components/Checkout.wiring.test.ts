import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Checkout.tsx's wiring, read from the SOURCE (Checkout itself is not
 * rendered in unit tests — it needs the router, tRPC, session and Stripe
 * providers).
 *
 * The safety-critical line is `onPaymentSubmittingChange`: drop it and the
 * hold is again reset under a Stripe confirm that may still succeed — and
 * nothing else fails. The lock props are UI affordances (disabled buttons):
 * the hook refuses a locked "back" whatever the UI does, so they are pinned
 * here for consistency, not for money safety.
 */
// The Checkout.tsx BESIDE this test (not a cwd-relative path, which pinned
// the real file even when the test ran from a copy).
// (`import.meta.url` is not a file: URL under the jsdom environment;
// vite-node provides `__dirname`.)
const SOURCE = readFileSync(join(__dirname, "Checkout.tsx"), "utf8");

/** Every `<Name … />` element in the source (props may span lines). */
function elements(name: string): string[] {
  return [...SOURCE.matchAll(new RegExp(`<${name}\\b[\\s\\S]*?\\n\\s*/>`, "g"))].map(
    (m) => m[0],
  );
}

describe("Checkout.tsx — the back-navigation lock and the submitting report are wired", () => {
  it("BOTH 'Change tickets' headers (details step, and the payment step's) get the lock", () => {
    const headers = elements("CheckoutTicketSummaryHeader");
    expect(headers).toHaveLength(1); // the details step's; the payment step renders its own
    for (const header of headers) {
      expect(header).toContain("changeTicketsDisabled={isBackNavigationLocked}");
    }
    const [paymentStep] = elements("CheckoutPaymentStep");
    expect(paymentStep).toContain("changeTicketsDisabled={isBackNavigationLocked}");
  });

  it("the payment step reports a Stripe confirm in flight back to the hook", () => {
    const [paymentStep] = elements("CheckoutPaymentStep");
    expect(paymentStep).toContain(
      "onPaymentSubmittingChange={handlePaymentSubmittingChange}",
    );
  });

  it("the hold-warning dialog's Release is disabled by the same flag", () => {
    const [dialog] = elements("CheckoutHoldWarningDialog");
    expect(dialog).toContain("confirmDisabled={isBackNavigationLocked}");
  });

  it("the stepper's way back is locked by the same flag", () => {
    const [stepper] = elements("CheckoutStepper");
    expect(stepper).toContain("backNavigationLocked={isBackNavigationLocked}");
  });

  it("step 4's payment comes from stepperPayment for every state (never undefined → 'Confirmed')", () => {
    const [stepper] = elements("CheckoutStepper");
    expect(stepper).toMatch(
      /payment=\{stepperPayment\(confirmedOrder, \{\s*restoring: isRestoringConfirmation,\s*sessionPayment,\s*\}\)\}/,
    );
  });

  it("the not-ready confirmation is told what the page knows of the payment", () => {
    const [pending] = elements("CheckoutConfirmedPending").filter((el) =>
      el.includes("confirmedOrder.status"),
    );
    expect(pending).toContain("payment={sessionPayment}");
  });
});

describe("Checkout.tsx — redirect return, the info-bar lock, the dialog on confirmation", () => {
  it("a Stripe redirect return confirms through its OWN entry (PaymentIntent only), not the in-page one", () => {
    expect(SOURCE).toMatch(
      /useStripeRedirectReturn\(\s*handleRedirectPaymentSuccess,\s*handleRedirectPaymentError,\s*handleRedirectUnverifiable,?\s*\)/,
    );
  });

  it("regression: the redirect seed comes from the PROP (server-read), passed into the hook — no hydration mismatch", () => {
    expect(SOURCE).toMatch(/useCheckoutState\(\{[\s\S]*?isStripeRedirectReturn,/);
    const page = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(page).toMatch(
      /isStripeRedirectReturn=\{hasStripeRedirectParams\(\s*\(key\) => query\[key\] !== undefined,?\s*\)\}/,
    );
  });

  it("the info bar's back link is locked while a payment is submitting or confirming", () => {
    // The steps' info bar (the interstitial renders its own, always locked
    // while confirming).
    const bar = elements("CheckoutInfoBar").find((el) =>
      el.includes("isHoldActive"),
    );
    expect(bar).toContain(
      'backLocked={isPaymentSubmitting || phase === "confirming"}',
    );
  });

  it("the hold-warning dialog is forced closed once the purchase is confirmed", () => {
    expect(SOURCE).toMatch(
      /useHoldWarningDialog\(\{[\s\S]*?forceClosed: phase === "confirmed" \|\| phase === "done"/,
    );
  });
});

describe("Checkout.tsx — the confirmation never totals an estimate", () => {
  it("the confirmed step gets the CONFIRMED order (page's, or loaded from the server), and waits for it", () => {
    const [step] = elements("CheckoutConfirmedStep");
    expect(step).toContain("order={confirmedOrder.order}");
    expect(step).toContain("quantities={confirmedOrder.quantities ?? quantities}");
    // The .ics UID basis: without it the checkout calendar entry stops matching the event page's.
    expect(step).toContain("eventId={event.id}");
    expect(SOURCE).toMatch(/confirmedOrder\.status === "ready" && \(\s*<CheckoutConfirmedStep/);
    expect(SOURCE).toMatch(/confirmedOrder\.status !== "ready" && \(\s*<CheckoutConfirmedPending/);
    expect(SOURCE).toMatch(/const confirmedOrder = useConfirmedOrder\(/);
  });
});

describe("Checkout.tsx — a redirect return / an unconfirmed payment renders NO steps", () => {
  it("regression: the interstitial is an early return, before the steps, the sidebar and the mobile CTA — none of which it renders", () => {
    const start = SOURCE.indexOf('if (checkoutView !== "steps") {');
    expect(start).toBeGreaterThan(-1);
    const main = SOURCE.indexOf("// ── Render ─", start);
    expect(main).toBeGreaterThan(start);
    const interstitial = SOURCE.slice(start, main);
    expect(interstitial).toContain("<CheckoutConfirmedPending");
    for (const forbidden of [
      "CheckoutPaymentStep",
      "StripePaymentCard",
      "CheckoutSidebar",
      "CheckoutMobileCTA",
      "displayTotal",
      "orderEstimate",
    ]) {
      expect(interstitial, forbidden).not.toContain(forbidden);
    }
    expect(SOURCE).toMatch(
      /const checkoutView = checkoutScreen\(\{\s*phase,\s*isRedirectReturnPending,\s*isPaymentReceivedUnconfirmed,/,
    );
  });
});

describe("Checkout.tsx — step 1 prices picked seats at the price the map shows", () => {
  it("regression: the estimated total comes from the hook's shown lines, never tier price × qty", () => {
    // From `ticketType.priceCents × qty`, a $50 seat on a $35 tier estimated
    // $39.85 until Hold re-priced it to $56.58.
    expect(SOURCE).toMatch(
      /estimateCartTotal\(\s*feeRatesQuery\.data,\s*shownLines,/,
    );
    const start = SOURCE.indexOf("const orderEstimate = useMemo(");
    expect(start).toBeGreaterThan(-1);
    const estimate = SOURCE.slice(start, SOURCE.indexOf("\n  );", start));
    expect(estimate).not.toContain("priceCents: ticketType.priceCents");
  });

  it("each step-1 line reads the hook's per-seat line amount", () => {
    expect(SOURCE).toContain(
      "shownLineCents: shownLineCents[ticketType.id] ?? null",
    );
  });
});

describe("Checkout.tsx — a ticket a promo frees pays no fee on any total the page shows", () => {
  // Owner ruling 2026-10-10. The figures are proved against the real use
  // cases in `src/lib/pricing/promo-to-zero-create-checkout.test.ts`; these
  // pin that the page actually feeds them to every surface. Unwired, steps 1
  // and 2 quoted $32.24 for a card charge of $31.72.
  it("step 1: the estimate takes the preview's fee reduction next to its discount", () => {
    const start = SOURCE.indexOf("const orderEstimate = useMemo(");
    expect(start).toBeGreaterThan(-1);
    const estimate = SOURCE.slice(start, SOURCE.indexOf("\n  );", start));
    expect(estimate).toContain("discountCents: livePromoDiscountCents");
    expect(estimate).toContain(
      "platformFeeReductionCents: livePromoFeeReductionCents",
    );
    // …and re-computes when it changes.
    expect(estimate).toMatch(/\[[\s\S]*livePromoFeeReductionCents[\s\S]*\]/);
  });

  it("step 2: the held order carries the fee the SERVER states; the payment step's order is left alone", () => {
    expect(SOURCE).toMatch(
      /const heldOrder = useMemo\(\s*\(\) =>\s*isPostCheckoutPhase\s*\? order\s*: withStatedHeldFees\(order, liveHeldCartFees, effectiveFeeMode\),/,
    );
    // The fee is stated, never subtracted on the page.
    expect(SOURCE).not.toMatch(/buyerFeesCents\s*-\s*livePromoFeeReductionCents/);
    expect(SOURCE).not.toMatch(/estimateHeldOrderCharge\([^)]*livePromoFeeReductionCents/);
  });

  it("every held surface reads that ONE order: the charge solve, the total, the summary and the tray", () => {
    const start = SOURCE.indexOf("const heldCharge = useMemo(");
    expect(start).toBeGreaterThan(-1);
    const heldCharge = SOURCE.slice(start, SOURCE.indexOf("\n  );", start));
    expect(heldCharge).toContain("{ ...heldOrder, feeMode: effectiveFeeMode }");
    expect(heldCharge).not.toMatch(/\.\.\.order\b/);

    expect(SOURCE).toMatch(/useCheckoutDisplayTotal\(\{[\s\S]*?\n {4}order: heldOrder,/);
    expect(SOURCE).toContain("order={summarySurfaceOrder(heldOrder, displayTaxCents)}");
    expect(SOURCE).toContain(
      "order={traySurfaceOrder(heldOrder, displayTaxCents, heldCharge)}",
    );
    // No surface is still handed the raw order.
    expect(SOURCE).not.toMatch(/summarySurfaceOrder\(order\b/);
    expect(SOURCE).not.toMatch(/traySurfaceOrder\(order\b/);
  });
});
