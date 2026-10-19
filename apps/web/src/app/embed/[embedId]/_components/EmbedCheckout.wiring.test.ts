import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * EmbedCheckout's wiring, read from the SOURCE. Each is one prop; drop it and
 * the summary falls back to "no rows" / the uncapped "3.33%" label / a cart
 * sent without the buyer's amount, and nothing else fails.
 *
 * What the component DOES with an order (the cart and key it stamps on it,
 * Back while creating, the free order, the timeout, a fresh payment form per
 * order) is rendered and driven in EmbedCheckout.test.tsx.
 */
const SOURCE = readFileSync(join(__dirname, "EmbedCheckout.tsx"), "utf8");

function elements(name: string): string[] {
  return [...SOURCE.matchAll(new RegExp(`<${name}\\b[\\s\\S]*?\\n\\s*/>`, "g"))].map(
    (m) => m[0],
  );
}

describe("EmbedCheckout.tsx — the summary, the tray and the guest checkout call", () => {
  it("the sidebar and the tray both get the step-1 estimate their rows come from", () => {
    for (const name of ["EmbedOrderSummarySidebar", "EmbedMobileCTABar"]) {
      const [el] = elements(name);
      expect(el, name).toContain("preOrderEstimate={orderEstimate}");
    }
  });

  it("both show the CAPPED platform-fee label, never the bare rate", () => {
    for (const name of ["EmbedOrderSummarySidebar", "EmbedMobileCTABar"]) {
      const [el] = elements(name);
      expect(el, name).toContain("platformFeeRateLabel={platformFeeLabel}");
    }
    expect(SOURCE).toMatch(/const platformFeeLabel =\s*cappedPlatformFeeRateLabel\(/);
  });

  it("the guest checkout sends the cart through embedCheckoutItems (the buyer's PWYW amount)", () => {
    expect(SOURCE).toContain(
      "items: embedCheckoutItems(sentCart, displayTicketTypes)",
    );
  });

  it("a failed guest checkout reports the raw error (the widget rotates its key from it) BEFORE the message", () => {
    const catchBlock = SOURCE.slice(SOURCE.indexOf("} catch (err: unknown) {"));
    const failed = catchBlock.indexOf("onCheckoutFailed(err);");
    const message = catchBlock.indexOf("onCheckoutError(msg);");
    expect(failed).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(failed);
  });

  it("a refusal's message goes through formatErrorMessage with the translator, never the raw code", () => {
    const catchBlock = SOURCE.slice(SOURCE.indexOf("} catch (err: unknown) {"));
    const msgExpr = catchBlock.slice(0, catchBlock.indexOf("onCheckoutError(msg);"));
    // `seat_price_changed` / `seat_taken` are codes, not sentences.
    expect(msgExpr).toContain("formatErrorMessage(err, t)");
    expect(msgExpr).not.toMatch(/\?\s*err\.message/);
  });

  it("override seats: the sidebar and the tray print each line at the shown per-seat prices", () => {
    const [sidebar] = elements("EmbedOrderSummarySidebar");
    expect(sidebar).toContain("lineCentsByTicketType={shownLineCents}");
    const [tray] = elements("EmbedMobileCTABar");
    expect(tray).toContain("lineCents: shownLineCents[item.ticketTypeId]");
    expect(SOURCE).toMatch(
      /const shownLineCents = useMemo\(\s*\(\) => embedShownLineCents\(cart, displayTicketTypes\)/,
    );
  });

  it("after the order, the sidebar and the tray print the server's lines (result.lineItems)", () => {
    for (const name of ["EmbedOrderSummarySidebar", "EmbedMobileCTABar"]) {
      const [el] = elements(name);
      expect(el, name).toContain("orderLines={orderLines}");
    }
    expect(SOURCE).toMatch(/embedLinesFromOrder\(orderLineItems\)/);
  });

  it("the order's figures come from the widget's paymentOrder, never local state a remount drops", () => {
    expect(SOURCE).toContain(
      "const clientSecret = paymentOrder?.clientSecret ?? null;",
    );
    expect(SOURCE).toContain("const orderFees = paymentOrder?.orderFees ?? null;");
    expect(SOURCE).toContain(
      "const orderLineItems = paymentOrder?.lineItems ?? null;",
    );
    expect(SOURCE).not.toMatch(/useState<[^>]*EmbedOrderFees/);
    // The created order goes up WITH the cart it was priced from and the
    // server's lines, so the widget can tell when the cart moved on.
    const success = SOURCE.slice(
      SOURCE.indexOf("const createdPaymentOrder"),
      SOURCE.indexOf("} catch (err: unknown) {"),
    );
    // …stamped with the cart and the key that were SENT, pinned before the
    // await (never whatever the page's cart is when the answer lands).
    const pinned = SOURCE.indexOf("const sentCart = cart;");
    expect(pinned).toBeGreaterThan(-1);
    expect(SOURCE.indexOf("const sentClientKey = clientKey;")).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(
      SOURCE.indexOf("const request = createCheckout.mutateAsync({"),
    );
    expect(SOURCE).toContain("clientKey: sentClientKey,");
    expect(success).toMatch(
      /clientSecret: result\.clientSecret,\s*clientKey: sentClientKey,\s*eventId: sentEventId,\s*cart: sentCart,/,
    );
    expect(success).toContain("holdExpiresAt: result.holdExpiresAt,");
    expect(success).toContain("lineItems: result.lineItems,");
    expect(success).toMatch(
      /},\s*createdPaymentOrder,\s*sentClientKey,\s*\);/,
    );
  });

  it("Back is locked while the order is created and while a payment confirms (EmbedCheckoutHeader has the behaviour)", () => {
    const [header] = elements("EmbedCheckoutHeader");
    expect(header).toContain("onBack={onBack}");
    expect(header).toContain("isCreating={isCreating}");
    expect(header).toContain("isPaying={isPaying}");
    // The header holds room for its "payment is processing" line only on the
    // payment step.
    expect(header).toContain("onPaymentStep={clientSecret !== null}");
    // The only thing `onBack` is handed to: no second Back that skips the lock.
    expect(SOURCE.match(/=\{onBack\}/g)).toHaveLength(1);
  });

  it("the 'time left to pay' row is not handed a countdown that has run out, in the summary and in the phone bar alike", () => {
    // The row's own text for that moment says "Hold expired"; the widget
    // says what happened to the order in its notice instead.
    const [summary] = elements("EmbedOrderSummarySidebar");
    const [bar] = elements("EmbedMobileCTABar");
    expect(summary).toContain("countdown={isHoldExpired ? null : countdown}");
    expect(bar).toContain("countdown={isHoldExpired ? null : countdown}");
    // The phone bar's button shows as working for a Continue that is waiting
    // on the bot check, like the form's own (EmbedCheckout.test.tsx).
    expect(bar).toContain("isPending={isSubmitting}");
    // One flag for the wait and the request (what locks the form's email
    // and promo inputs); Back, in the header, locks for the request only.
    expect(SOURCE).toContain(
      "const isSubmitting = isCreating || awaitingVerification;",
    );
    const [form] = elements("EmbedCheckoutFormSection");
    expect(form).toContain("isCreating={isSubmitting}");
    const [header] = elements("EmbedCheckoutHeader");
    expect(header).toContain("isCreating={isCreating}");
  });

  it("the payment form reports its confirm to the widget, stops at a lapsed reservation, and reports an unknown outcome", () => {
    const [form] = elements("EmbedPaymentForm");
    expect(form).toContain("onSubmittingChange={onPayingChange}");
    expect(form).toContain("payDisabled={isHoldExpired}");
    // With the order it is about (see EmbedCheckout.test.tsx).
    expect(form).toContain("onPaymentOutcomeUnknown(clientSecret, report)");
    expect(form).toContain("onOrderExpired={onPaymentOrderExpired}");
  });

  it("a seat_price_changed refusal re-quotes the cart before the button frees up", () => {
    const catchBlock = SOURCE.slice(
      SOURCE.indexOf("} catch (err: unknown) {"),
      SOURCE.indexOf("} finally {"),
    );
    expect(catchBlock).toMatch(
      /err\.message === "seat_price_changed"\)\s*\{\s*try\s*\{\s*await refreshSeatQuotes\(\);/,
    );
    // The refresh re-reads the seats (not the cached map) and re-quotes.
    expect(SOURCE).toContain("await utils.embeds.listAvailableSeats.invalidate();");
    expect(SOURCE).toContain(
      "onCartUpdate((current) => withRefreshedSeatQuotes(current, seatsBySection));",
    );
  });
});

describe("the widget and event detail — the cart's seat quotes", () => {
  const WIDGET = readFileSync(join(__dirname, "EmbedWidget.tsx"), "utf8");
  const DETAIL = readFileSync(join(__dirname, "EmbedEventDetail.tsx"), "utf8");

  it("the checkout can re-quote the page's cart, through the widget's cart rule, never straight into state", () => {
    expect(WIDGET).toContain("onCartUpdate={handleCartUpdate}");
    expect(WIDGET).toMatch(
      /const handleCartUpdate = useCallback\(\s*\(update: \(current: CartItem\[\]\) => CartItem\[\]\) =>\s*handleCartChange\(update\(cart\)\),/,
    );
    // `setCart` is no prop of anything: every cart the widget is handed goes
    // through `handleCartChange`.
    expect(WIDGET).not.toMatch(/=\{setCart\}/);
  });

  it("a seat-picker confirmation stores the shown override prices", () => {
    expect(DETAIL).toContain("onConfirm={(seatIds, seats) => {");
    // …and a seat the data does not cover keeps the line's earlier quote.
    expect(DETAIL).toMatch(
      /seatPickCartItem\(\s*ticketTypeId,\s*seatSectionId,\s*seatIds,\s*seats,\s*previous\?\.seatQuotes,\s*\)/,
    );
  });

  it("the step-1 lines print at the shown per-seat prices", () => {
    expect(DETAIL).toContain("shownLineCents[item.ticketTypeId] ??");
    expect(DETAIL).toContain("lineCents: shownLineCents[item.ticketTypeId],");
  });
});

describe("EmbedCheckout.tsx — what the payment form hands back and is handed", () => {
  it("'paid' goes up with the order's client secret and the status Stripe gave: the widget asks the server about THAT order", () => {
    const [form] = elements("EmbedPaymentForm");
    expect(form).toMatch(
      /onSuccess=\{\(status\) =>\s*onPaymentSuccess\(guestEmail\.trim\(\), \{\s*clientSecret,\s*status,\s*\}\)\s*\}/,
    );
  });

  it("the form is told while the server is asked, and saves the host origin before each confirm (a redirect return needs it)", () => {
    const [form] = elements("EmbedPaymentForm");
    expect(form).toContain("confirmingOrder={isConfirming}");
    expect(form).toContain("onBeforeConfirm={saveHostOriginForReturn}");
    expect(SOURCE).toMatch(
      /const saveHostOriginForReturn = useCallback\(\s*\(\) =>\s*saveEmbedHostOrigin\(embedId, \{\s*loadIsRedirectReturn: loadedAsRedirectReturn,/,
    );
  });

  it("Back is locked while the server is asked", () => {
    const [header] = elements("EmbedCheckoutHeader");
    expect(header).toContain("isConfirming={isConfirming}");
  });
});
