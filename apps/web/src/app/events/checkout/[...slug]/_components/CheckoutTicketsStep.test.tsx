import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Pay-what-you-want on the MAIN checkout's step 1.
 *
 * The bug this pins: `CheckoutTicketsStep` rendered `<TicketTypeGrid>` without
 * `donationAmounts` / `onDonationAmountChange`, and the grid's amount field was
 * a controlled `value={(cents / 100).toFixed(2)}`. Nothing could ever change
 * it — typing, clearing and the preset chips all snapped back to $15.00, and
 * the order was priced at the tier's stored $0 ("Free").
 *
 * The harness owns the amounts exactly as `Checkout` does (state in the parent,
 * threaded through the step), so this proves the WIRING end to end through
 * the real step, the real grid and the real amount panel.
 */

// The seat map is lazy (next/dynamic); a stub marks where it would render.
vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="seat-map-stub" />,
}));

/** Verbatim copy from apps/web/src/i18n/messages/en.ts. */
const EN: Record<string, string> = {
  "errors.donationAmountRequired": "Enter a donation amount to continue.",
  "errors.donationBelowMinimum":
    "Your donation is below the minimum amount. Enter a higher amount to continue.",
  "checkout.donationAboveMaximum":
    "The most you can pay for one ticket is {max}.",
  "checkout.selectYourTickets": "Select your tickets",
  "checkout.pwywChooseAmount": "Choose your amount",
  "checkout.pwywAmountForTier": "for {name}",
  "checkout.pwywPresetFor": "{amount} for {name}",
  "checkout.pwywMinimum": "Minimum: {amount}",
  "checkout.pwywNonRefundable": "This is a donation and is non-refundable.",
  "checkout.pwywSliderFor": "Set amount for {name}",
  "checkout.calculatingTotal": "Calculating total...",
  "eventDetail.fromPrice": "From {value}",
  "eventDetail.payWhatYouWant": "Pay what you want",
  "eventDetail.suggestedPrice": "suggested {value}",
  "eventDetail.plusFeesAndTax": "+ fees & tax",
};

vi.mock("@th/ui", async () => ({
  // The amount slider (PayWhatYouWantAmount): the real DOM contract.
  RangeSlider: (await import("@/test-support/range-slider-stub")).RangeSliderStub,
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      const template = EN[key];
      if (template === undefined) return key;
      return Object.entries(vals ?? {}).reduce(
        (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
        template,
      );
    },
  useFormatters: () => ({
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
    number: (value: number) => String(value),
    locale: "en-US",
  }),
  QuantityStepper: () => <div />,
}));

import { CheckoutTicketsStep } from "./CheckoutTicketsStep";
import {
  PWYW_FLOOR_ALL_IN_CENTS,
  serverRowAt,
} from "@/lib/pricing/__fixtures__/pwyw-floor";
import type { PlaceLayout } from "./SeatMapPicker";
import type { TicketTypeSummary } from "./useCheckoutState";

/** The live "Manhattan Gallery Walk" tier: min $5.00, suggested $15.00. */
const PWYW: TicketTypeSummary = {
  id: "tt-pwyw",
  name: "Pay What You Want",
  priceCents: 0,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId: null,
  layoutSectionId: null,
  pricingMode: "ADJUSTABLE",
  minimumCents: 500,
  suggestedCents: 1500,
};

/**
 * The tier as `Checkout` hands it to the step: `withBuyerUnitTotals` merges in
 * the server's per-ticket row, which for a PWYW tier is priced at its $5
 * floor — $6.09 all-in at 8.88% tax, fees on top.
 */
const PWYW_PRICED = {
  ...PWYW,
  buyerUnitTotalCents: serverRowAt(PWYW.id, 500).buyerUnitTotalCents,
};

const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

const commits: Array<[string, number]> = [];

const Harness = ({
  showDonationErrors = false,
  tier = PWYW_PRICED,
  placeLayout = null,
}: {
  showDonationErrors?: boolean;
  /** `buyerUnitTotalCents`: the server row `withBuyerUnitTotals` merges in. */
  tier?: TicketTypeSummary & { buyerUnitTotalCents?: number | null };
  placeLayout?: PlaceLayout | null;
}) => {
  const [donationAmounts, setDonationAmounts] = useState<
    Record<string, number>
  >({ [tier.id]: Math.max(tier.minimumCents ?? 0, tier.suggestedCents ?? 0) });
  return (
    <>
      <CheckoutTicketsStep
        placeLayout={placeLayout}
        displayTicketTypes={[tier]}
        quantities={{ [tier.id]: 1 }}
        onQuantityChange={() => {}}
        formatPrice={formatPrice}
        isLoadingSeats={false}
        donationAmounts={donationAmounts}
        onDonationAmountChange={(id, cents) => {
          commits.push([id, cents]);
          setDonationAmounts((prev) => ({ ...prev, [id]: cents }));
        }}
        showDonationErrors={showDonationErrors}
      />
      <output data-testid="priced-at">{donationAmounts[tier.id]}</output>
    </>
  );
};

/** The label now names the tier — no aria-label override on the input. */
const AMOUNT_NAME = "Choose your amount for Pay What You Want";
const amountInput = () =>
  screen.getByLabelText(AMOUNT_NAME) as HTMLInputElement;
const type = (value: string) =>
  fireEvent.change(amountInput(), { target: { value } });
const pricedAt = () => screen.getByTestId("priced-at").textContent;

describe("CheckoutTicketsStep — pay what you want amount", () => {
  it("owner ruling 2026-10-02: labels the row From its minimum ALL-IN ($6.09 for a $5 floor at 8.88%), not the bare floor and not the tier name", () => {
    render(<Harness />);
    expect(PWYW_PRICED.buyerUnitTotalCents).toBe(PWYW_FLOOR_ALL_IN_CENTS);
    expect(screen.getByText("From $6.09")).toBeInTheDocument();
    expect(screen.queryByText("From $5.00")).not.toBeInTheDocument();
    expect(screen.queryByText("+ fees & tax")).not.toBeInTheDocument();
    expect(screen.getAllByText("Pay What You Want")).toHaveLength(1);
  });

  it("fee rates not loaded: 'Calculating total...', never the bare floor", () => {
    render(<Harness tier={PWYW} />);
    expect(screen.getByText("Calculating total...")).toBeInTheDocument();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it("the field's accessible name comes from a translated label that includes the tier", () => {
    render(<Harness />);
    const input = amountInput();
    expect(input).not.toHaveAttribute("aria-label");
    expect(input.labels?.[0]).toHaveTextContent(AMOUNT_NAME);
  });

  it("starts at the suggested amount", () => {
    render(<Harness />);
    expect(amountInput().value).toBe("15.00");
  });

  it("regression: typing changes the amount the order is priced at", () => {
    commits.length = 0;
    render(<Harness />);
    type("22");
    expect(amountInput().value).toBe("22");
    expect(pricedAt()).toBe("2200");
    expect(commits).toContainEqual([PWYW.id, 2200]);
  });

  it("does not reformat under the caret; normalises on blur", () => {
    render(<Harness />);
    type("7.");
    expect(amountInput().value).toBe("7.");
    type("7.5");
    expect(amountInput().value).toBe("7.5");
    expect(pricedAt()).toBe("750");
    fireEvent.blur(amountInput());
    expect(amountInput().value).toBe("7.50");
  });

  it("regression: a preset chip sets the amount, and says it is pressed", () => {
    render(<Harness />);
    const chip = screen.getByRole("button", {
      name: "$30.00 for Pay What You Want",
    });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(amountInput().value).toBe("30.00");
    expect(pricedAt()).toBe("3000");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "$15.00 for Pay What You Want" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("clamps every chip to at least the minimum", () => {
    // Suggested $4 under a $5 minimum: half/one× would be $2/$4 — both refused.
    render(
      <Harness tier={{ ...PWYW, minimumCents: 500, suggestedCents: 400 }} />,
    );
    const amounts = screen
      .getAllByRole("button", { name: / for Pay What You Want$/ })
      .map((b) => b.textContent);
    expect(amounts).toEqual(["$5.00", "$8.00", "$20.00"]);
  });

  it("rejects a keystroke that is not an amount, or has a sixth whole digit", () => {
    render(<Harness />);
    type("12abc");
    expect(amountInput().value).toBe("15.00");
    type("1.234");
    expect(amountInput().value).toBe("15.00");
    type("123456");
    expect(amountInput().value).toBe("15.00");
    expect(pricedAt()).toBe("1500");
  });

  it("reads '12,50' as twelve fifty (comma + two digits = decimal point)", () => {
    render(<Harness />);
    type("12,50");
    expect(pricedAt()).toBe("1250");
  });

  it("regression: typing '1,000' key by key prices one thousand, not $1.00", () => {
    render(<Harness />);
    for (const text of ["1", "1,", "1,0", "1,00", "1,000"]) type(text);
    expect(amountInput().value).toBe("1,000");
    expect(pricedAt()).toBe("100000");
    fireEvent.blur(amountInput());
    expect(amountInput().value).toBe("1000.00");
  });

  it("above the $10,000.00 cap: says so at once", () => {
    render(<Harness />);
    type("10000.01");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The most you can pay for one ticket is $10,000.00.",
    );
    type("10000");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("below the minimum: the error shows once the buyer leaves the field", () => {
    render(<Harness />);
    type("3");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(amountInput());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your donation is below the minimum amount.",
    );
    expect(amountInput()).toHaveAttribute("aria-invalid", "true");
    expect(amountInput()).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("alert").id,
    );
  });

  it("cleared: prices at 0 (refused by the minimum) and asks for an amount", () => {
    render(<Harness />);
    type("");
    expect(pricedAt()).toBe("0");
    fireEvent.blur(amountInput());
    expect(amountInput().value).toBe("");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a donation amount to continue.",
    );
  });

  it("a refused Hold shows the error without waiting for blur", () => {
    const { rerender } = render(<Harness />);
    type("2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<Harness showDonationErrors />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("minimum 0: says 'Pay what you want' with the suggestion, never 'From $15.00'", () => {
    render(<Harness tier={{ ...PWYW, minimumCents: 0, buyerUnitTotalCents: 0 }} />);
    expect(screen.getByText("Pay what you want")).toBeInTheDocument();
    expect(screen.getByText("suggested $15.00")).toBeInTheDocument();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it("copy is translated: minimum and the non-refundable note come from the catalog", () => {
    render(<Harness />);
    expect(screen.getByText("Minimum: $5.00")).toBeInTheDocument();
    expect(
      screen.getByText("This is a donation and is non-refundable."),
    ).toBeInTheDocument();
  });

  it("seat-map path: a seated PWYW tier still gets its amount field", () => {
    const layout = {
      id: "layout-1",
      name: "Hall",
      seatCount: 0,
      sectionCount: 0,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      sections: [],
      stage: null,
    } as PlaceLayout;
    render(<Harness placeLayout={layout} />);
    expect(screen.getByTestId("seat-map-stub")).toBeInTheDocument();
    expect(screen.getByTestId("seated-pwyw-amount")).toBeInTheDocument();
    type("40");
    expect(pricedAt()).toBe("4000");
  });
});

describe("CheckoutTicketsStep — the pay-what-you-want slider (the box office's control)", () => {
  const SLIDER_NAME = "Set amount for Pay What You Want";
  const slider = () => screen.getByRole("slider", { name: SLIDER_NAME });
  const key = (k: string) => fireEvent.keyDown(slider(), { key: k });

  it("has its own accessible name, tied to the tier, and a money valuetext", () => {
    render(<Harness />);
    expect(slider()).toHaveAttribute("aria-valuetext", "$15.00");
    // Never the field's name: two controls announced alike is a known defect.
    expect(SLIDER_NAME).not.toBe(AMOUNT_NAME);
    expect(screen.getAllByLabelText(AMOUNT_NAME)).toHaveLength(1);
    expect(screen.getAllByRole("slider")).toHaveLength(1);
  });

  it("runs from the floor to the largest preset ($75 = 5× the $15 suggestion)", () => {
    render(<Harness />);
    expect(slider()).toHaveAttribute("aria-valuemin", "500");
    expect(slider()).toHaveAttribute("aria-valuemax", "7500");
  });

  it("regression (live run): every preset chip lands ON the track, never past its end", () => {
    render(<Harness />);
    const chips = screen.getAllByRole("button", { name: / for Pay What You Want$/ });
    expect(chips.map((c) => c.textContent)).toEqual(["$7.50", "$15.00", "$30.00", "$75.00"]);
    for (const chip of chips) {
      fireEvent.click(chip);
      // The handle sits exactly on the chip's amount: not pinned under a
      // lower end label.
      expect(slider()).toHaveAttribute("aria-valuenow", pricedAt()!);
    }
  });

  it("moving it sets the amount the order is priced at, and the field follows", () => {
    commits.length = 0;
    render(<Harness />);
    fireEvent.change(slider(), { target: { value: "2500" } });
    expect(pricedAt()).toBe("2500");
    expect(amountInput().value).toBe("25.00");
    expect(slider()).toHaveAttribute("aria-valuetext", "$25.00");
    expect(commits).toContainEqual([PWYW.id, 2500]);
  });

  it("a drag lands on round money (the box office's magnet)", () => {
    render(<Harness />);
    fireEvent.change(slider(), { target: { value: "1985" } });
    expect(pricedAt()).toBe("2000");
  });

  it("typing an exact amount moves the handle — and is never magnetized", () => {
    render(<Harness />);
    // $19.85 is inside the magnet's reach of $20: a drag would land on $20.
    type("19.85");
    expect(pricedAt()).toBe("1985");
    expect(slider()).toHaveAttribute("aria-valuenow", "1985");
    type("17.15");
    expect(pricedAt()).toBe("1715");
  });

  it("typing above the track works up to the cap; the handle pins at its end", () => {
    render(<Harness />);
    type("250");
    expect(pricedAt()).toBe("25000");
    expect(slider()).toHaveAttribute("aria-valuenow", "7500");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("over the $10,000 cap: the field still errors at once, invalid, and the handle stays on the track", () => {
    render(<Harness />);
    type("15000");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The most you can pay for one ticket is $10,000.00.",
    );
    expect(amountInput()).toHaveAttribute("aria-invalid", "true");
    expect(slider()).toHaveAttribute("aria-valuenow", "7500");
  });

  it("keyboard: $1 on the arrows, $5 on Page Up/Down, floor and end on Home/End — never past the track", () => {
    render(<Harness />);
    key("ArrowRight");
    expect(pricedAt()).toBe("1600");
    key("ArrowLeft");
    key("ArrowDown");
    expect(pricedAt()).toBe("1400");
    key("PageUp");
    expect(pricedAt()).toBe("1900");
    key("Home");
    expect(pricedAt()).toBe("500");
    key("ArrowLeft");
    expect(pricedAt()).toBe("500");
    key("End");
    expect(pricedAt()).toBe("7500");
    key("ArrowRight");
    expect(pricedAt()).toBe("7500");
  });

  it("regression: a key never moves a typed amount against its direction", () => {
    render(<Harness />);
    type("200");
    // Up on $200, above the $75 track end, used to "step up" to $75.
    key("ArrowUp");
    expect(pricedAt()).toBe("20000");
    key("PageUp");
    key("End");
    expect(pricedAt()).toBe("20000");
    // Down steps from the amount itself, not from the track end.
    key("ArrowDown");
    expect(pricedAt()).toBe("19900");
    key("PageDown");
    expect(pricedAt()).toBe("19400");
    // Under the floor, a down key does not raise it to the floor.
    type("3");
    key("ArrowDown");
    expect(pricedAt()).toBe("300");
    key("ArrowUp");
    expect(pricedAt()).toBe("500");
  });

  it("below the minimum never comes from the slider; the field's minimum rule still holds", () => {
    render(<Harness />);
    fireEvent.change(slider(), { target: { value: "450" } });
    expect(pricedAt()).toBe("500");
    type("3");
    fireEvent.blur(amountInput());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your donation is below the minimum amount.",
    );
    // The handle sits at the floor while the field holds the refused $3.
    expect(slider()).toHaveAttribute("aria-valuenow", "500");
  });

  it("seat-map path: the seated amount panel has the slider too", () => {
    const layout = {
      id: "layout-1",
      name: "Hall",
      seatCount: 0,
      sectionCount: 0,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      sections: [],
      stage: null,
    } as PlaceLayout;
    render(<Harness placeLayout={layout} />);
    fireEvent.change(slider(), { target: { value: "3000" } });
    expect(pricedAt()).toBe("3000");
  });
});
