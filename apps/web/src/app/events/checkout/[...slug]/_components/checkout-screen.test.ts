import { describe, expect, it } from "vitest";

import { checkoutScreen } from "./checkout-screen";
import type { CheckoutPhase } from "./useCheckoutState";

const at = (
  phase: CheckoutPhase,
  isRedirectReturnPending: boolean,
  isPaymentReceivedUnconfirmed = false,
) => checkoutScreen({ phase, isRedirectReturnPending, isPaymentReceivedUnconfirmed });

describe("checkoutScreen — a paid or being-verified checkout never shows the steps", () => {
  it("regression: a redirect return being verified → the interstitial, in every phase short of confirmed (confirming maps to the PAYMENT step)", () => {
    for (const phase of ["selecting", "held", "confirming", "paying"] as const) {
      expect(at(phase, true)).toBe("redirect-confirming");
    }
  });

  it("confirmed → the confirmation (the steps' last step)", () => {
    expect(at("confirmed", true)).toBe("steps");
    expect(at("confirmed", false)).toBe("steps");
  });

  it("regression: paid, but our confirm failed → the terminal screen, whatever the phase", () => {
    for (const phase of ["confirming", "paying", "selecting"] as const) {
      expect(at(phase, false, true)).toBe("payment-received");
    }
  });

  it("a normal checkout → the steps", () => {
    expect(at("held", false)).toBe("steps");
    expect(at("paying", false)).toBe("steps");
  });
});
