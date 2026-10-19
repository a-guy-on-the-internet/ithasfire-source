import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  // Verbatim from apps/web/src/i18n/messages/en.ts.
  useTranslations: () => (key: string) =>
    ({
      "errors.promoMinOrderNotMet":
        "Your order doesn't yet meet the minimum required for this promo code.",
      "errors.promoNotApplicable":
        "This promo code doesn't apply to the items in your order.",
    })[key] ?? key,
}));

import { PromoCodeInput } from "./PromoCodeInput";

describe("PromoCodeInput — a kept code that doesn't apply right now", () => {
  it("stays applied, with the reason beside it (existing promo copy)", () => {
    render(
      <PromoCodeInput
        appliedCodes={["earlybird", "STUDENT"]}
        onApply={() => null}
        onRemove={() => {}}
        rejections={{ EARLYBIRD: "errors.promoMinOrderNotMet" }}
      />,
    );
    // Both codes are still applied (each has its remove button).
    expect(screen.getAllByRole("button", { name: /checkout.promoCodeRemove/ })).toHaveLength(2);
    const reasons = screen.getAllByTestId("promo-code-rejection");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toHaveTextContent(
      "EARLYBIRD: Your order doesn't yet meet the minimum required for this promo code.",
    );
    // Announced politely, not as an alert.
    expect(reasons[0]!.parentElement).toHaveAttribute("role", "status");
  });

  it("no rejections → no reason text", () => {
    render(
      <PromoCodeInput appliedCodes={["STUDENT"]} onApply={() => null} onRemove={() => {}} />,
    );
    expect(screen.queryByTestId("promo-code-rejection")).not.toBeInTheDocument();
  });
});

describe("PromoCodeInput — while one code is flagged, the others don't apply either", () => {
  it("says so when other codes are applied", () => {
    render(
      <PromoCodeInput
        appliedCodes={["EARLYBIRD", "STUDENT"]}
        onApply={() => null}
        onRemove={() => {}}
        rejections={{ EARLYBIRD: "errors.promoMinOrderNotMet" }}
      />,
    );
    expect(screen.getByTestId("promo-code-others-blocked")).toHaveTextContent(
      "checkout.promoOthersBlocked",
    );
  });

  it("a lone flagged code gets no such note", () => {
    render(
      <PromoCodeInput
        appliedCodes={["TYPO"]}
        onApply={() => null}
        onRemove={() => {}}
        rejections={{ TYPO: "errors.promoNotFound" }}
      />,
    );
    expect(screen.queryByTestId("promo-code-others-blocked")).not.toBeInTheDocument();
  });
});

describe("PromoCodeInput — a preview that couldn't run is explained", () => {
  it("says the codes couldn't be checked, and keeps them applied", () => {
    render(
      <PromoCodeInput
        appliedCodes={["WELCOME10"]}
        onApply={() => null}
        onRemove={() => {}}
        checkUnavailable
      />,
    );
    expect(screen.getByTestId("promo-code-check-unavailable")).toHaveTextContent(
      "checkout.promoCheckUnavailable",
    );
    expect(screen.getByRole("button", { name: /checkout.promoCodeRemove/ })).toBeInTheDocument();
  });

  it("regression: a signed-in member's benefit preview failing with NO typed code still says so", () => {
    render(
      <PromoCodeInput appliedCodes={[]} onApply={() => null} onRemove={() => {}} checkUnavailable />,
    );
    expect(screen.getByTestId("promo-code-check-unavailable")).toHaveTextContent(
      "checkout.promoCheckUnavailable",
    );
  });

  it("nothing failed → no note", () => {
    render(<PromoCodeInput appliedCodes={[]} onApply={() => null} onRemove={() => {}} />);
    expect(screen.queryByTestId("promo-code-check-unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("promo-code-url-check-unavailable")).not.toBeInTheDocument();
  });

  it("regression: the link's code couldn't be checked → says so, and how to retry", () => {
    render(
      <PromoCodeInput appliedCodes={[]} onApply={() => null} onRemove={() => {}} urlCheckUnavailable />,
    );
    expect(screen.getByTestId("promo-code-url-check-unavailable")).toHaveTextContent(
      "checkout.promoUrlCheckUnavailable",
    );
  });
});
