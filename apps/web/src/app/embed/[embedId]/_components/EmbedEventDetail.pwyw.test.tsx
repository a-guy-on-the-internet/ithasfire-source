import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The embed's ticket step with a pay-what-you-want tier:
 *  - the amount is the main checkout's field (parsing, minimum, $10,000 cap);
 *  - the total prices it like a ticket of that amount, fees and tax ON TOP
 *    (it used to add the raw donation to the total);
 *  - the order rows are main checkout's step-1 rows and add up to the total;
 *  - an amount the server would refuse shows no total and Continue refuses;
 *  - the listing reads the floor ALL-IN, "From $6.09" for a $5 floor at 8.88%
 *    (owner ruling 2026-10-02), the figure the header above it shows;
 *  - the amount has the box office's slider beside the field, and whatever
 *    it lands on is the donationAmountCents the checkout sends.
 */

const ids = vi.hoisted(() => ({ EVENT: "11111111-1111-4111-8111-111111111111" }));

const rates = vi.hoisted(() => ({
  feeMode: "PASS_THROUGH" as const,
  admissionTaxRateBps: 888,
  taxImpositions: [
    {
      code: "SALES",
      label: "Sales tax",
      jurisdiction: "US/NY",
      rateBps: 888,
      base: "TICKET_FACE" as const,
      collector: "PLATFORM" as const,
    },
  ],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeLabel: "3.33%",
  processorFeeLabel: "2.9% + $0.30",
  platformFeeRates: { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 },
  perTicketEstimates: [
    { ticketTypeId: "tt-ga", unitPriceCents: 3500, platformFeeCents: 50 },
    // The server's row for the $5 floor (pinned to core's math below).
    {
      ticketTypeId: "tt-pwyw",
      unitPriceCents: 500,
      platformFeeCents: 17,
      processorFeeCents: 48,
      taxEstimateCents: 44,
      buyerUnitTotalCents: 609,
    },
  ],
}));

/** What `events.getCheckoutFeeRates` answers; `undefined` = not loaded yet. */
const feeRatesQuery = vi.hoisted(() => ({
  data: undefined as unknown,
  refetch: vi.fn(),
}));

const TICKET_TYPES = [
  {
    id: "tt-ga",
    name: "General Admission",
    priceCents: 3500,
    capacity: 100,
    remainingCapacity: 100,
    pricingMode: "FIXED" as const,
  },
  {
    id: "tt-pwyw",
    name: "Pay What You Want",
    priceCents: 0,
    capacity: 100,
    remainingCapacity: 100,
    pricingMode: "ADJUSTABLE" as const,
    minimumCents: 500,
    suggestedCents: 1500,
  },
];

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      getEventDetail: {
        useQuery: () => ({
          isLoading: false,
          data: {
            event: {
              id: ids.EVENT,
              title: "Sixth Street Comedy Night",
              startsAt: new Date("2026-11-01T02:00:00Z"),
              endsAt: null,
              timezone: "America/New_York",
              currency: "usd",
            },
            ticketTypes: TICKET_TYPES,
            salesClosed: false,
            body: null,
            imageMap: {},
            eventHumans: [],
            tags: [],
          },
        }),
      },
    },
    events: {
      getCheckoutFeeRates: {
        useQuery: () => ({ data: feeRatesQuery.data, refetch: feeRatesQuery.refetch }),
      },
    },
  },
}));
vi.mock("@th/ui", async () => ({
  // The amount slider (PayWhatYouWantAmount): the real DOM contract.
  RangeSlider: (await import("@/test-support/range-slider-stub")).RangeSliderStub,
  Spinner: () => <span />,
  useFormatters: () => ({ dateTime: () => "Nov 1" }),
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/embed-host-origin", () => ({ getEmbedHostOrigin: () => "https://host.test" }));
vi.mock("@/app/events/[...slug]/_components/EventDetail", () => ({ EventDetail: () => null }));
vi.mock("./EmbedSeatPicker", () => ({ EmbedSeatPicker: () => null }));
vi.mock("./EmbedSeriesDateSwitcher", () => ({ EmbedSeriesDateSwitcher: () => null }));
vi.mock("./useIsFramed", () => ({ useIsFramed: () => false }));

import { EmbedEventDetail } from "./EmbedEventDetail";
import type { CartItem } from "./embed-types";
import { embedCheckoutItems, embedEstimateItems } from "./embed-pwyw";
import { formatCurrency } from "./embed-helpers";
import { estimateCartTotal } from "@/lib/pricing/order-estimate";
import { serverRowAt } from "@/lib/pricing/__fixtures__/pwyw-floor";

beforeEach(() => {
  feeRatesQuery.data = rates;
  feeRatesQuery.refetch.mockClear();
});

const money = (text: string | null | undefined) =>
  Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);

function Harness({
  initialCart,
  onContinue,
  onCart,
}: {
  initialCart: CartItem[];
  onContinue: () => void;
  /** Sees every cart the widget commits. */
  onCart?: (cart: CartItem[]) => void;
}) {
  const [cart, setCart] = React.useState<CartItem[]>(initialCart);
  return (
    <EmbedEventDetail
      embedId="embed-1"
      eventId={ids.EVENT}
      cart={cart}
      onCartChange={(next) => {
        setCart(next);
        onCart?.(next);
      }}
      onBack={() => {}}
      onContinueToCheckout={onContinue}
      onSelectDate={() => {}}
      stepperStepId="tickets"
      completedStepIds={[]}
    />
  );
}

const CART: CartItem[] = [
  { ticketTypeId: "tt-ga", qty: 1 },
  { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2000 },
];

function detailRows() {
  const one = (id: string) => {
    const el = screen.queryByTestId(`embed-detail-${id}`);
    return el ? money(el.textContent) : 0;
  };
  return {
    lines: screen.getAllByTestId("embed-detail-line-value").map((el) => money(el.textContent)),
    subtotal: one("subtotal-value"),
    platform: one("platform-fee-value"),
    processing: one("processing-fee-value"),
    tax: one("tax-value"),
    total: money(screen.getByTestId("embed-detail-total-value").textContent),
  };
}

describe("EmbedEventDetail — pay what you want", () => {
  it("regression: the total prices the $20 PWYW like a $20 ticket — fees and tax on top — and the rows add up to it", () => {
    render(<Harness initialCart={CART} onContinue={vi.fn()} />);
    const estimate = estimateCartTotal(rates, embedEstimateItems(CART, TICKET_TYPES))!;
    const r = detailRows();
    expect(r.total).toBe(estimate.totalCents);
    // Not GA's all-in + the raw $20.
    expect(r.total).toBeGreaterThan(3500 + 2000);
    expect(r.lines).toEqual([3500, 2000]);
    expect(r.lines.reduce((a, b) => a + b, 0)).toBe(r.subtotal);
    expect(r.subtotal + r.platform + r.processing + r.tax).toBe(r.total);
    expect(screen.getByTestId("embed-detail-total-value").textContent).toBe(
      formatCurrency(estimate.totalCents, "usd"),
    );
  });

  it("the platform-fee row carries the CAPPED rate label", () => {
    render(<Harness initialCart={CART} onContinue={vi.fn()} />);
    expect(
      screen.getAllByText(/checkout\.platformFeeRateCapped:3\.33%/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("(3.33%)")).toBeNull();
  });

  it("regression: the amount field is main checkout's — over the $10,000 cap it errors at once, the total shows no figure, and Continue refuses", () => {
    const onContinue = vi.fn();
    render(<Harness initialCart={CART} onContinue={onContinue} />);
    const field = screen.getByLabelText(/checkout\.pwywChooseAmount/);
    fireEvent.change(field, { target: { value: "15000" } });
    expect(screen.getByRole("alert")).toHaveTextContent("checkout.donationAboveMaximum");
    expect(screen.getByTestId("embed-detail-total-value").textContent).toBe("—");
    expect(screen.queryByTestId("embed-detail-subtotal-value")).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getAllByRole("button", { name: /Continue/ })[0]!);
      act(() => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(onContinue).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it("below the minimum: refused on Continue with the field's error shown", () => {
    const onContinue = vi.fn();
    render(
      <Harness
        initialCart={[{ ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 400 }]}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Continue/ })[0]!);
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("errors.donationBelowMinimum");
  });

  it("a valid amount continues", () => {
    const onContinue = vi.fn();
    render(<Harness initialCart={CART} onContinue={onContinue} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Continue/ })[0]!);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("the fixture's PWYW row is the server's: a $5 floor at 8.88% is $6.09 all-in", () => {
    const pwywRow = rates.perTicketEstimates.find((r) => r.ticketTypeId === "tt-pwyw");
    expect(pwywRow).toEqual(serverRowAt("tt-pwyw", 500));
  });

  it("owner ruling 2026-10-02: the listing reads the floor ALL-IN — 'From $6.09' — with no '+ fees & tax' line", () => {
    render(<Harness initialCart={[]} onContinue={vi.fn()} />);
    const prices = screen.getAllByTestId("embed-ticket-price");
    expect(prices[1]).toHaveTextContent(`eventDetail.fromPrice:${formatCurrency(609, "usd")}`);
    expect(prices[1]).not.toHaveTextContent(`fromPrice:${formatCurrency(500, "usd")}`);
    expect(screen.queryByTestId("embed-ticket-price-hint")).toBeNull();
    expect(screen.queryByText(/plusFeesAndTax/)).toBeNull();
  });

  it("fee rates not loaded: 'Calculating total…', never the bare $5 floor", () => {
    feeRatesQuery.data = undefined;
    render(<Harness initialCart={[]} onContinue={vi.fn()} />);
    const prices = screen.getAllByTestId("embed-ticket-price");
    expect(prices[1]).toHaveTextContent("checkout.calculatingTotal");
    expect(prices[1]).not.toHaveTextContent("fromPrice");
  });
});

describe("EmbedEventDetail — the pay-what-you-want slider", () => {
  const slider = () =>
    screen.getByRole("slider", { name: "checkout.pwywSliderFor:Pay What You Want" });
  const field = () => screen.getByLabelText(/checkout\.pwywChooseAmount/) as HTMLInputElement;

  it("moving it sets the amount, the total, and the donationAmountCents the checkout sends", () => {
    const onCart = vi.fn();
    render(
      <Harness
        initialCart={[{ ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 1500 }]}
        onContinue={vi.fn()}
        onCart={onCart}
      />,
    );
    fireEvent.change(slider(), { target: { value: "2500" } });

    const cart = onCart.mock.lastCall![0] as CartItem[];
    expect(cart).toEqual([{ ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2500 }]);
    // On the wire: cents, as donationAmountCents.
    expect(embedCheckoutItems(cart, TICKET_TYPES)).toEqual([
      { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2500 },
    ]);
    expect(field().value).toBe("25.00");
    expect(slider()).toHaveAttribute("aria-valuetext", formatCurrency(2500, "usd"));
    const estimate = estimateCartTotal(rates, embedEstimateItems(cart, TICKET_TYPES))!;
    expect(screen.getByTestId("embed-detail-total-value").textContent).toBe(
      formatCurrency(estimate.totalCents, "usd"),
    );
  });

  it("typing an exact amount moves the handle; above the track it pins at the end", () => {
    render(
      <Harness
        initialCart={[{ ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 1500 }]}
        onContinue={vi.fn()}
      />,
    );
    // $19.85 is inside the magnet's reach of $20; typed, it stays exact.
    fireEvent.change(field(), { target: { value: "19.85" } });
    expect(slider()).toHaveAttribute("aria-valuenow", "1985");
    // The track runs to the largest preset ($75); $250 typed is still allowed.
    expect(slider()).toHaveAttribute("aria-valuemax", "7500");
    fireEvent.change(field(), { target: { value: "250" } });
    expect(slider()).toHaveAttribute("aria-valuenow", "7500");
    expect(slider()).toHaveAttribute("aria-valuetext", formatCurrency(25_000, "usd"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the slider and the field never share an accessible name", () => {
    render(
      <Harness
        initialCart={[{ ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 1500 }]}
        onContinue={vi.fn()}
      />,
    );
    expect(slider().getAttribute("aria-label")).not.toBe(
      field().labels?.[0]?.textContent,
    );
    expect(screen.getAllByRole("slider")).toHaveLength(1);
  });
});

describe("EmbedEventDetail — a cached fee-rates row priced at another face", () => {
  it("reads 'Calculating total…', refetches the rates ONCE, and does not loop when the refetch changes nothing", () => {
    // The minimum is $5 now; the cached row was priced at a $3 floor.
    feeRatesQuery.data = {
      ...rates,
      perTicketEstimates: rates.perTicketEstimates.map((row) =>
        row.ticketTypeId === "tt-pwyw" ? { ...row, unitPriceCents: 300 } : row,
      ),
    };
    render(<Harness initialCart={[]} onContinue={vi.fn()} />);
    expect(screen.getAllByTestId("embed-ticket-price")[1]).toHaveTextContent(
      "checkout.calculatingTotal",
    );
    expect(feeRatesQuery.refetch).toHaveBeenCalledTimes(1);
    // Re-render with the same stale row (the refetch brought nothing new).
    fireEvent.click(
      screen.getByRole("button", { name: /checkout\.increaseQuantityFor:General Admission/ }),
    );
    expect(feeRatesQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it("fresh rows never refetch", () => {
    render(<Harness initialCart={[]} onContinue={vi.fn()} />);
    expect(feeRatesQuery.refetch).not.toHaveBeenCalled();
  });
});
