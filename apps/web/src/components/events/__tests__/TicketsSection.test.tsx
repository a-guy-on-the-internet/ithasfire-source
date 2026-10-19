import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * FR-010 / Q-002 — the public ticket list renders DISTINCT per-tier states.
 *
 * This is the render half of the acceptance criterion ("an event with one open
 * and one not-yet-open tier renders correct, distinct states on the public
 * page"). The derivation itself is pinned in
 * `app/events/[...slug]/_components/__tests__/event-detail.helpers.test.ts`;
 * what this file proves is the WIRING — that the payload reaches the row, that
 * the i18n keys exist, and that the instant is formatted in the EVENT's zone
 * rather than the runner's.
 */

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (
        key.startsWith("data-") ||
        key.startsWith("aria-") ||
        key === "role"
      ) {
        domProps[key] = value;
      }
    }
    return <div {...domProps}>{children}</div>;
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

/**
 * The REAL copy from `apps/web/src/i18n/messages/en.ts`. Copied rather than
 * imported because the catalog is a large TS module and this only needs four
 * keys — but copied VERBATIM, and the whole-catalog parity gate plus the
 * "no raw key on screen" assertion below keep the two honest.
 */
const MESSAGES: Record<string, string> = {
  "eventDetail.ticketsSection": "Tickets",
  "eventDetail.ticketCapacity": "{count} available",
  "eventDetail.tierOnSaleFrom": "On sale {date}",
  "eventDetail.tierNotOnSale": "Not on sale yet",
  "eventDetail.tierSalesEnded": "Sales ended",
  "eventDetail.tierPriceUntil": "{price} until {date}, then {newPrice}",
  "common.free": "Free",
  "eventDetail.fromPrice": "From {value}",
  "eventDetail.payWhatYouWant": "Pay what you want",
  "eventDetail.plusFeesAndTax": "+ fees & tax",
  "eventDetail.plusFees": "+ fees",
  "eventDetail.plusTax": "+ tax",
  "eventDetail.suggestedPrice": "suggested {value}",
  "eventDetail.feesTapHint": "Tap for fee details",
  "eventDetail.feesPlatform": "Platform fee",
  "eventDetail.feesProcessing": "Processing fee",
  "eventDetail.feesTax": "Tax",
  "checkout.calculatingTotal": "Calculating total...",
  "checkout.platformFeeRateCapped": "{rate}, max {max}/ticket",
  "checkout.platformFeeRatePctCapped": "{pct} (max {max}) + {fixed}",
};

const fakeTranslate = (key: string, values?: Record<string, unknown>) => {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    template,
  );
};

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => fakeTranslate,
  useFormatters: () => ({
    // The real Intl, fixed locale — the zone under test comes from the caller.
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
    // Matches `Translator.formatCurrency`: it takes MAJOR units — `fmtCurrency`
    // in @/lib/format is the thing that converts cents.
    currency: (majorUnits: number, currency: string) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        majorUnits,
      ),
    number: (value: number) => String(value),
    locale: "en-US",
    getRawMessage: (key: string) => MESSAGES[key],
  }),
}));

import { TicketsSection } from "../TicketsSection";
import type {
  EventContentTicketType,
  TicketFeeEstimate,
} from "../event-content-types";
import {
  PWYW_FLOOR_ALL_IN_CENTS,
  PWYW_FLOOR_CENTS,
  serverRowAt,
} from "@/lib/pricing/__fixtures__/pwyw-floor";

const OPENS_AT = new Date("2026-10-09T15:00:00.000Z"); // 10:00 AM CDT
const CLOSED_AT = new Date("2026-09-01T15:00:00.000Z");
const FLIPS_AT = new Date("2026-10-03T20:00:00.000Z"); // 3:00 PM CDT

const OPEN: EventContentTicketType = {
  id: "tt-open",
  name: "Advance",
  priceCents: 1500,
  capacity: 40,
  sellability: {
    available: true,
    reason: "ok",
    opensAt: null,
    closedAt: null,
  },
};
const NOT_YET: EventContentTicketType = {
  id: "tt-not-yet",
  name: "Late release",
  priceCents: 3000,
  capacity: 40,
  sellability: {
    available: false,
    reason: "not_yet_on_sale",
    opensAt: OPENS_AT,
    closedAt: null,
  },
};
const ENDED: EventContentTicketType = {
  id: "tt-ended",
  name: "Early bird",
  priceCents: 500,
  capacity: 40,
  sellability: {
    available: false,
    reason: "sales_ended",
    opensAt: null,
    closedAt: CLOSED_AT,
  },
};
/** No sellability at all — a pre-FR-010 payload (NFR-001). */
const PLAIN: EventContentTicketType = {
  id: "tt-plain",
  name: "General",
  priceCents: 2500,
  capacity: 40,
};

const renderSection = (
  ticketTypes: EventContentTicketType[],
  // NOT a default parameter: passing `undefined` explicitly would silently
  // re-apply the default and make the "no timezone" case untestable.
  ...rest: [] | [timezone: string | undefined]
) =>
  render(
    <TicketsSection
      ticketTypes={ticketTypes}
      feeMode={null}
      mobile={false}
      currency="USD"
      timezone={rest.length ? rest[0] : "America/Chicago"}
    />,
  );

describe("TicketsSection — per-tier sale state (FR-010)", () => {
  it("renders four distinct states for a mixed set", () => {
    renderSection([OPEN, NOT_YET, ENDED, PLAIN]);

    // Every tier is still LISTED — a buyer who came for the late release needs
    // to see it exists and when it opens.
    for (const name of ["Advance", "Late release", "Early bird", "General"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }

    // The not-yet-open tier carries its open instant, on the EVENT's clock.
    expect(screen.getByText(/^On sale /)).toHaveTextContent("Oct 9");
    expect(screen.getByText(/^On sale /)).toHaveTextContent("10:00");
    expect(screen.getByText(/^On sale /)).toHaveTextContent("CDT");

    // The ended tier says so, with no date — a passed deadline is not
    // actionable.
    expect(screen.getByText("Sales ended")).toBeInTheDocument();

    // Exactly two notices: the OPEN and PLAIN tiers say nothing extra.
    expect(screen.queryAllByText(/^On sale /)).toHaveLength(1);
    expect(screen.queryAllByText("Sales ended")).toHaveLength(1);
  });

  it("renders NOTHING extra for an event-wide refusal (the page banners it once)", () => {
    renderSection([
      {
        ...PLAIN,
        sellability: {
          available: false,
          reason: "stripe_not_connected",
          opensAt: null,
          closedAt: null,
        },
      },
    ]);
    expect(screen.queryByText(/^On sale /)).not.toBeInTheDocument();
    expect(screen.queryByText("Sales ended")).not.toBeInTheDocument();
  });

  it("NFR-001: a tier with no sellability renders exactly as before", () => {
    const { container } = renderSection([PLAIN]);
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(container.textContent).not.toContain("On sale");
    expect(container.textContent).not.toContain("Sales ended");
  });

  it("REFUSES a wall time when the event has no timezone (Phase 1c: refuse, don't degrade)", () => {
    renderSection([NOT_YET], undefined);
    // Rendering the instant with no `timeZone` puts it on the READER's clock
    // AND drops the abbreviation, so a London buyer would read "4:00 PM" for a
    // 10:00 AM CDT window with nothing admitting the substitution. The
    // zone-free copy is the only honest thing left to say.
    expect(screen.queryByText(/^On sale /)).not.toBeInTheDocument();
    expect(screen.getByText("Not on sale yet")).toBeInTheDocument();
  });

  it("REFUSES the price-change line entirely when the event has no timezone", () => {
    // Same rule, other notice: there is no zone-free fallback copy for a price
    // flip, so the line simply does not render.
    const { container } = renderSection(
      [
        {
          ...PLAIN,
          priceCents: 1200,
          upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
        },
      ],
      undefined,
    );
    expect(container.textContent).not.toContain("until");
  });

  it("never leaves a raw i18n key on screen", () => {
    // The dual-catalog failure mode: a missing key renders as its own name.
    const { container } = renderSection([OPEN, NOT_YET, ENDED, PLAIN]);
    expect(container.textContent).not.toContain("eventDetail.");
  });
});

describe("TicketsSection — scheduled-price copy (Q-002)", () => {
  it("BEFORE the flip: says what it costs and until when, in the event's zone", () => {
    renderSection([
      {
        ...PLAIN,
        priceCents: 1200,
        upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
      },
    ]);
    const label = screen.getByText(/until/);
    // The CURRENT effective price, which core already resolved.
    expect(label).toHaveTextContent("$12.00");
    expect(label).toHaveTextContent("Oct 3");
    expect(label).toHaveTextContent("3:00");
    expect(label).toHaveTextContent("CDT");
    // …AND the price it rises to (Q-002). Without this the line is a bare date
    // sitting directly under "On sale …" / "Sales ended" notices that ARE
    // about availability, and reads as a second sales deadline.
    expect(label).toHaveTextContent("then $20.00");
  });

  it("AFTER the flip: says NOTHING — core sends no pending change", () => {
    // The honesty requirement. Core nulls `upcomingPriceChange` at exactly the
    // instant `priceCents` becomes the post-flip number, so the row cannot
    // still read "until <a date in the past>".
    const { container } = renderSection([
      { ...PLAIN, priceCents: 2000, upcomingPriceChange: null },
    ]);
    expect(container.textContent).not.toContain("until");
  });

  it("shows the price-change line ALONGSIDE a not-yet-on-sale notice", () => {
    renderSection([
      { ...NOT_YET, upcomingPriceChange: { toPriceCents: 4000, at: FLIPS_AT } },
    ]);
    expect(screen.getByText(/^On sale /)).toBeInTheDocument();
    expect(screen.getByText(/until/)).toBeInTheDocument();
  });

  /**
   * Drift guard for the contrast fix — twin of the ones in
   * `TicketTypeGrid.test.tsx` and `EmbedTicketTypeList.test.tsx`. An unbuyable
   * row is dimmed; the sentence explaining why must not be. Opacity multiplies
   * down the tree, so the note has to sit outside every dimmed element.
   */
  it("renders the availability note outside every dimmed ancestor", () => {
    renderSection([NOT_YET]);

    const note = screen.getByText(/^On sale /);
    const row = note.closest(".ticket-type-row") as HTMLElement | null;
    expect(row).not.toBeNull();

    const dimmed: string[] = [];
    for (
      let el: HTMLElement | null = note as HTMLElement;
      el && el !== row;
      el = el.parentElement
    ) {
      const opacity = el.style.opacity;
      if (opacity !== "" && Number(opacity) < 1) {
        dimmed.push(`<${el.tagName.toLowerCase()} opacity=${opacity}>`);
      }
    }
    const rowOpacity = row!.style.opacity;
    if (rowOpacity !== "" && Number(rowOpacity) < 1) {
      dimmed.push(`<row opacity=${rowOpacity}>`);
    }

    expect(
      dimmed,
      `The availability note is inside ${dimmed.length} dimmed element(s): ` +
        `${dimmed.join(", ")}. Opacity multiplies, so this reduces the note's ` +
        `contrast no matter what colour it uses. Dim the row's other content ` +
        `instead.`,
    ).toEqual([]);

    // The row's other content IS still dimmed, so the guard cannot be
    // satisfied by dropping the treatment altogether.
    const right = row!.querySelector(
      ".ticket-type-row__right",
    ) as HTMLElement | null;
    expect(right).not.toBeNull();
    expect(Number(right!.style.opacity)).toBeLessThan(1);
  });
});

/**
 * The "{count} available" label. It used to count the AUTHORED `capacity`
 * column, which no write path decrements — so it read "250 available" on a
 * tier with 43 left, and kept reading it on a tier with none.
 */
describe("TicketsSection — availability count", () => {
  it("counts what is LEFT, not what was authored", () => {
    renderSection([{ ...PLAIN, capacity: 250, remainingCapacity: 43 }]);
    expect(screen.getByText("43 available")).toBeInTheDocument();
    expect(screen.queryByText("250 available")).not.toBeInTheDocument();
  });

  it("renders no count at all once nothing is left", () => {
    const { container } = renderSection([
      { ...PLAIN, capacity: 250, remainingCapacity: 0, soldOut: true },
    ]);
    expect(container.textContent).not.toContain("available");
  });

  it("falls back to the authored column for a payload without the field", () => {
    // Story fixtures and any cached pre-change payload render exactly as before.
    renderSection([{ ...PLAIN, capacity: 40 }]);
    expect(screen.getByText("40 available")).toBeInTheDocument();
  });
});

describe("TicketsSection — pay what you want (ADJUSTABLE) rows", () => {
  /** The live "Manhattan Gallery Walk" tier: min $5.00, suggested $15.00. */
  const PWYW: EventContentTicketType = {
    id: "tt-pwyw",
    name: "Pay What You Want",
    priceCents: 0,
    capacity: 40,
    pricingMode: "ADJUSTABLE",
    minimumCents: 500,
    suggestedCents: 1500,
  };

  /** The server's row for the $5 floor: $6.09 all-in at 8.88%, fees on top. */
  const FLOOR_ROW = serverRowAt("tt-pwyw", PWYW_FLOOR_CENTS);

  const renderPwyw = (
    tier: EventContentTicketType,
    feeMode: "ABSORB" | "PASS_THROUGH" | null,
    admissionTaxRateBps: number | null,
    /** `null` = the fee rates have not loaded. */
    estimate: TicketFeeEstimate | null = FLOOR_ROW,
  ) =>
    render(
      <TicketsSection
        ticketTypes={[tier]}
        feeMode={feeMode}
        // The per-ticket estimate for a PWYW tier is priced at its FLOOR.
        feeEstimateMap={estimate ? { [tier.id]: estimate } : {}}
        admissionTaxRateBps={admissionTaxRateBps}
        platformFeeLabel="3.33%"
        processorFeeLabel="2.9% + $0.30"
        mobile={false}
        currency="USD"
        timezone="America/Chicago"
      />,
    );

  it("owner ruling 2026-10-02: quotes From the minimum ALL-IN — $6.09 for a $5 floor at 8.88% — never Free, never the bare floor", () => {
    const { container } = renderPwyw(PWYW, "PASS_THROUGH", 888);
    expect(FLOOR_ROW.buyerUnitTotalCents).toBe(PWYW_FLOOR_ALL_IN_CENTS);
    expect(screen.getByText("From $6.09")).toBeInTheDocument();
    expect(container.textContent).not.toContain("From $5.00");
    expect(container.textContent).not.toContain("Free");
  });

  it("the figure includes fees and tax, so no '+ fees & tax' line follows it", () => {
    const { container } = renderPwyw(PWYW, "PASS_THROUGH", 888);
    expect(container.textContent).not.toContain("+ fees");
    expect(container.textContent).not.toContain("+ tax");
  });

  it("the fee tooltip explains the floor's figure, as a fixed tier's does", () => {
    renderPwyw(PWYW, "PASS_THROUGH", 888);
    expect(
      screen.getByRole("button", { name: "Tap for fee details" }),
    ).toBeInTheDocument();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      `$${(FLOOR_ROW.platformFeeCents / 100).toFixed(2)}`,
    );
    expect(tooltip).toHaveTextContent(
      `$${(FLOOR_ROW.taxEstimateCents / 100).toFixed(2)}`,
    );
  });

  it("the floor's row not loaded: 'Calculating total...', no tooltip, never the bare floor", () => {
    const { container } = renderPwyw(PWYW, "PASS_THROUGH", 888, null);
    expect(screen.getByText("Calculating total...")).toBeInTheDocument();
    expect(container.textContent).not.toContain("From");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("a row priced at another face (the minimum moved) is not quoted", () => {
    renderPwyw({ ...PWYW, minimumCents: 700 }, "PASS_THROUGH", 888);
    expect(screen.getByText("Calculating total...")).toBeInTheDocument();
  });

  it("no minimum → 'Pay what you want' + the suggestion, never 'From $15.00'", () => {
    const { container } = renderPwyw(
      { ...PWYW, minimumCents: 0 },
      "PASS_THROUGH",
      888,
      serverRowAt("tt-pwyw", 0),
    );
    expect(screen.getByText("Pay what you want")).toBeInTheDocument();
    expect(screen.getByText("suggested $15.00")).toBeInTheDocument();
    expect(container.textContent).not.toContain("From");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("no minimum and no suggestion → says pay what you want, with no hint", () => {
    const { container } = renderPwyw(
      { ...PWYW, minimumCents: null, suggestedCents: null },
      "PASS_THROUGH",
      888,
      null,
    );
    expect(screen.getByText("Pay what you want")).toBeInTheDocument();
    expect(container.textContent).not.toContain("+ fees");
  });
});

describe("TicketsSection — the fee tooltip names the per-ticket cap", () => {
  it("regression: '3.33%' alone read like 3.33% of the order — it says 'max $0.50/ticket'", () => {
    render(
      <TicketsSection
        ticketTypes={[{ id: "tt-ga", name: "General Admission", priceCents: 3500, capacity: 100 }]}
        feeMode="PASS_THROUGH"
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 50,
            processorFeeCents: 147,
            taxEstimateCents: 311,
            buyerUnitTotalCents: 4008,
          },
        }}
        admissionTaxRateBps={888}
        platformFeeLabel="3.33%"
        platformFeeRates={{
          buyerFeePct: 0.0333,
          maxFeeCents: 50,
          minFeeCents: 0,
          platformFixedCents: 0,
        }}
        processorFeeLabel="2.9% + $0.30"
        mobile={false}
        currency="USD"
        timezone="America/Chicago"
      />,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Platform fee (3.33%, max $0.50/ticket): $0.50",
    );
  });

  it("regression: with a fixed part the cap is on the % only — '3.33% (max $0.50) + $0.30'", () => {
    render(
      <TicketsSection
        ticketTypes={[{ id: "tt-ga", name: "General Admission", priceCents: 3500, capacity: 100 }]}
        feeMode="PASS_THROUGH"
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 80,
            processorFeeCents: 148,
            taxEstimateCents: 311,
            buyerUnitTotalCents: 4039,
          },
        }}
        admissionTaxRateBps={888}
        platformFeeLabel="3.33% + $0.30"
        platformFeeRates={{
          buyerFeePct: 0.0333,
          maxFeeCents: 50,
          minFeeCents: 0,
          platformFixedCents: 30,
        }}
        processorFeeLabel="2.9% + $0.30"
        mobile={false}
        currency="USD"
        timezone="America/Chicago"
      />,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Platform fee (3.33% (max $0.50) + $0.30): $0.80",
    );
  });
});


describe("TicketsSection — a cached row priced at another face is never quoted", () => {
  const GA_ROW = serverRowAt("tt-ga", 3000);
  const renderGa = (priceCents: number) =>
    render(
      <TicketsSection
        ticketTypes={[{ id: "tt-ga", name: "General Admission", priceCents, capacity: 100 }]}
        feeMode="PASS_THROUGH"
        feeEstimateMap={{ "tt-ga": GA_ROW }}
        admissionTaxRateBps={888}
        platformFeeLabel="3.33%"
        processorFeeLabel="2.9% + $0.30"
        mobile={false}
        currency="USD"
        timezone="America/Chicago"
      />,
    );

  it("control: the row's face matches, the all-in figure shows", () => {
    renderGa(3000);
    expect(
      screen.getByText(`$${(GA_ROW.buyerUnitTotalCents / 100).toFixed(2)}`),
    ).toBeInTheDocument();
  });

  it("regression: repriced $30 → $35 under the $30 row reads 'Calculating total...', with no fee tooltip of the old row's parts", () => {
    const { container } = renderGa(3500);
    expect(screen.getByText("Calculating total...")).toBeInTheDocument();
    expect(container.textContent).not.toContain(
      `$${(GA_ROW.buyerUnitTotalCents / 100).toFixed(2)}`,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("regression: a cached 'Free' beside a row priced at $30 reads 'Calculating total...', not Free", () => {
    renderGa(0);
    expect(screen.getByText("Calculating total...")).toBeInTheDocument();
    expect(screen.queryByText("Free")).not.toBeInTheDocument();
  });
});
