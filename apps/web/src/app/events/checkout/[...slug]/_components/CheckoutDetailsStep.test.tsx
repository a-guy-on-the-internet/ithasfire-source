import React, { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CheckoutContactFormRef } from "./CheckoutContactForm";

// ── Mocks ─────────────────────────────────────────────────────────────────
// ICU-aware ONLY for the two summary keys; everything else returns the key so
// existing copy assertions stay key-stable.
vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      if (key === "checkout.fieldsNeedAttention") {
        const count = Number(vals?.count ?? 0);
        return count === 1
          ? "1 field still needs your attention"
          : `${count} fields still need your attention`;
      }
      if (key === "checkout.nextField") return "Next field";
      return key;
    },
}));

// Heavy children collapsed to nulls — the summary wiring is what's under test.
vi.mock("./ArtistAttributionPicker", () => ({
  ArtistAttributionPicker: () => null,
}));
vi.mock("./RefundDisclosure", () => ({
  RefundDisclosure: () => null,
}));

// Stub the contact form: forwards a ref whose focusNextInvalid is a spy, and
// renders buttons that drive its onValidationStateChange so the parent's
// summary state can be exercised without the real form internals.
const focusNextInvalidSpy = vi.fn();
vi.mock("./CheckoutContactForm", () => {
  return {
    CheckoutContactForm: React.forwardRef(
      (
        props: {
          onValidationStateChange?: (s: {
            submitAttempted: boolean;
            invalidCount: number;
          }) => void;
        },
        ref: React.Ref<unknown>,
      ) => {
        React.useImperativeHandle(ref, () => ({
          focusNextInvalid: focusNextInvalidSpy,
        }));
        return React.createElement("div", { "data-testid": "contact-form" }, [
          React.createElement(
            "button",
            {
              key: "one",
              type: "button",
              onClick: () =>
                props.onValidationStateChange?.({
                  submitAttempted: true,
                  invalidCount: 1,
                }),
            },
            "emit-1",
          ),
          React.createElement(
            "button",
            {
              key: "three",
              type: "button",
              onClick: () =>
                props.onValidationStateChange?.({
                  submitAttempted: true,
                  invalidCount: 3,
                }),
            },
            "emit-3",
          ),
        ]);
      },
    ),
  };
});

import { CheckoutDetailsStep } from "./CheckoutDetailsStep";

function renderStep() {
  const contactFormRef = createRef<CheckoutContactFormRef>();
  render(
    <CheckoutDetailsStep
      eventId="evt_1"
      attributionArtistSelection=""
      onAttributionArtistChange={vi.fn()}
      contactFormRef={contactFormRef}
      detailsSectionRef={createRef()}
      isSignedIn
      onRequestSignIn={vi.fn()}
      onBillingAddressComplete={vi.fn()}
      onContactDraftChange={vi.fn()}
      subtotalCents={5000}
      waiverAccepted={false}
      onWaiverAcceptedChange={vi.fn()}
      waiverHighlight={false}
      waiverCheckboxRef={createRef()}
      displayTicketTypes={[]}
      quantities={{}}
      refundPolicyAccepted={false}
      onRefundPolicyChange={vi.fn()}
      termsAccepted={false}
      onTermsChange={vi.fn()}
      setAgreementCheckboxRef={vi.fn()}
      isPending={false}
      onContinueToPayment={vi.fn()}
    />,
  );
}

describe("CheckoutDetailsStep — validation summary", () => {
  it("renders nothing before a submit attempt", () => {
    renderStep();
    expect(screen.queryByText(/need(s)? your attention/)).toBeNull();
    expect(screen.queryByRole("button", { name: /next field/i })).toBeNull();
  });

  it("shows singular copy with NO Next control for a single invalid field", () => {
    renderStep();
    fireEvent.click(screen.getByText("emit-1"));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1 field still needs your attention");
    expect(screen.queryByRole("button", { name: /next field/i })).toBeNull();
  });

  it("shows pluralized copy + a Next control that calls focusNextInvalid for 2+ invalid fields", () => {
    focusNextInvalidSpy.mockClear();
    renderStep();
    fireEvent.click(screen.getByText("emit-3"));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("3 fields still need your attention");

    const next = screen.getByRole("button", { name: /next field/i });
    fireEvent.click(next);
    expect(focusNextInvalidSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CheckoutDetailsStep — continue CTA prominence", () => {
  // Step 2's primary spent a release rendering the muted ink wash, which reads
  // as disabled. It now shares `primaryActionStyle` with step 1's "Hold
  // tickets" so the two steps cannot disagree about what a primary looks like.
  it("renders the continue CTA on the accent fill, not the muted wash", () => {
    renderStep();
    const cta = screen.getByTestId("checkout-continue-btn");

    // Brand-secondary rung + its white foreground: #E2481D clears AA in
    // neither polarity, so a label on the fill must sit on #B93312.
    expect(cta.style.background).toContain("--brandSecondaryHover");
    expect(cta.style.color).toContain("--onBrandSecondary");
    expect(cta.style.background).not.toContain("rgba(33,28,22");

    // Strict Swiss: content, so no radius. Focus ring comes from the class.
    // (Read off the attribute — jsdom's shorthand getter returns "".)
    expect(cta.getAttribute("style")).toContain("border-radius: 0;");
    expect(cta.className).toContain("checkout-primary-action");
  });
});
