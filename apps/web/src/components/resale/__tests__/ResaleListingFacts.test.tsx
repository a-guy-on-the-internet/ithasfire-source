import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string, v?: Record<string, string>) =>
    `${key}|${v?.amount ?? ""}|${v?.ticket ?? ""}`,
  useFormatters: () => ({ currency: (n: number) => `$${n.toFixed(2)}` }),
  Text: ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={rest["data-testid"]}>{children}</span>,
}));

import { ResaleListingFacts } from "../ResaleListingFacts";

afterEach(cleanup);

const base = { askPriceCents: 5000, currency: "usd" };
const fixed = {
  listPriceCents: 4000,
  pricingMode: "FIXED" as const,
  minimumCents: null,
};

describe("ResaleListingFacts", () => {
  it("SELLER pays: original price, then the share inside the ask", () => {
    render(
      <ResaleListingFacts
        listing={{
          ...base,
          originalPriceCents: 4000,
          eventShareCents: 500,
          sharePayer: "SELLER",
          ticketTypePricing: fixed,
        }}
      />,
    );
    expect(screen.getByTestId("resale-original-price").textContent).toBe(
      "resell.originalPriceFixed|$40.00|",
    );
    expect(screen.getByTestId("resale-event-share").textContent).toBe(
      "resell.shareToEventSeller|$5.00|$50.00",
    );
  });

  it("BUYER pays: the share line adds to the ticket", () => {
    render(
      <ResaleListingFacts
        listing={{
          ...base,
          originalPriceCents: 4000,
          eventShareCents: 500,
          sharePayer: "BUYER",
          ticketTypePricing: fixed,
        }}
      />,
    );
    expect(screen.getByTestId("resale-event-share").textContent).toContain(
      "resell.shareToEventBuyer",
    );
  });

  it("a comp reads 'given free' with the list price", () => {
    render(
      <ResaleListingFacts
        listing={{
          ...base,
          originalPriceCents: 0,
          eventShareCents: 500,
          sharePayer: "SELLER",
          ticketTypePricing: fixed,
        }}
      />,
    );
    expect(screen.getByTestId("resale-original-price").textContent).toBe(
      "resell.originalPriceComp|$40.00|",
    );
  });

  it("a listing from before the share existed shows neither line", () => {
    const { container } = render(
      <ResaleListingFacts listing={{ ...base, originalPriceCents: null }} />,
    );
    expect(container.textContent).toBe("");
  });

  it("showShare=false leaves the share line out", () => {
    render(
      <ResaleListingFacts
        showShare={false}
        listing={{
          ...base,
          originalPriceCents: 4000,
          eventShareCents: 500,
          sharePayer: "BUYER",
        }}
      />,
    );
    expect(screen.queryByTestId("resale-event-share")).toBeNull();
  });
});
