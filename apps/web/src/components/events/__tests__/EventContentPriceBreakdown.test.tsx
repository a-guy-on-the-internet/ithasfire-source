import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen } from "@testing-library/react";

/**
 * EventContent — the all-in "from" price NAMES its parts (Option A).
 *
 * The figure stays the buyer's all-in unit total; under it the page says what
 * that total is made of: "$40.00 ticket + $2.12 fees + $3.55 tax" on the wide
 * buy band and the classic hero, "incl. $2.12 fees + $3.55 tax" on the phone's
 * docked bar. The arithmetic lives in `price-breakdown.ts` (its own suite);
 * this file pins WHERE the caption renders and when it must not.
 *
 * The mock prelude is copied from EventContentPayWhatYouWant.test.tsx so this
 * file stands on its own.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
// Mirrors the pattern used by TicketMobileCard.test.tsx / JobMobileCard.test.tsx:
// render Tamagui/`@th/ui` primitives as plain DOM so no TamaguiProvider/theme
// is needed in jsdom.

vi.mock("tamagui", () => {
  // Forward only DOM-safe attributes (data-*/aria-*/role) so `data-testid`
  // markers survive through Tamagui's styled(XStack/YStack, {...}) wrappers,
  // while dropping layout-only props (gap, alignItems, etc.) that would
  // otherwise produce invalid-DOM-attribute warnings on a plain <div>.
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
    // `className` is how a styled() component reaches a real stylesheet, and
    // real Tamagui forwards it to the DOM node. Dropping it here made the hero
    // frame's `.event-hero-poster-frame` (which carries `container-type`)
    // untestable — an assertion on it could not have failed.
    if (typeof rest.className === "string") domProps.className = rest.className;
    // Layout rules under test (the venue badge's 320px overflow fix) —
    // surfaced as data- attributes so an assertion can see them.
    if ("flexWrap" in rest) domProps["data-flex-wrap"] = rest.flexWrap;
    if ("flexShrink" in rest) domProps["data-flex-shrink"] = String(rest.flexShrink);
    if ("minWidth" in rest) domProps["data-min-width"] = String(rest.minWidth);
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

const MESSAGES: Record<string, string> = {
  "eventDetail.presentedBy": "Presented by {name}",
  "eventDetail.atVenue": "At {name}",
  "eventDetail.confirmedByVenue": "Confirmed by the place",
  "eventDetail.refundPolicySection": "Refund policy",
  "eventDetail.refundPolicyUntilStart":
    "Full refund available until this event starts.",
  "eventDetail.refundPolicyUntilDate": "Full refund available until {date}.",
  // Real copy for the keys the community layout reads, so its assertions are
  // about rendered text rather than about raw key strings leaking through.
  "eventDetail.scheduleSection": "Schedule",
  "eventDetail.scheduleEnds": "Ends",
  "eventDetail.locationSection": "Location",
  "eventDetail.lineupSection": "Lineup",
  "eventDetail.goingSection": "Going?",
  "eventDetail.viewVenuePage": "View place page",
  "eventDetail.copyAddress": "Copy address",
  "eventDetail.copied": "Copied",
  "eventDetail.factWhere": "Where",
  "eventDetail.factListedBy": "Listed by",
  "common.dateNotSet": "Date not set",
  "common.fromPrice": "From {value}",
  "common.free": "Free",
  "eventCard.priceFrom": "From",
  "eventDetail.fromPrice": "From {value}",
  "eventDetail.payWhatYouWant": "Pay what you want",
  "eventDetail.suggestedPrice": "suggested {value}",
  "eventDetail.plusFeesAndTax": "+ fees & tax",
  "eventDetail.priceBreakdown.longFull": "{ticket} ticket + {fees} fees + {tax} tax",
  "eventDetail.priceBreakdown.longNoTax": "{ticket} ticket + {fees} fees",
  "eventDetail.priceBreakdown.longNoFees": "{ticket} ticket + {tax} tax",
  "eventDetail.priceBreakdown.shortFull": "incl. {fees} fees + {tax} tax",
  "eventDetail.priceBreakdown.shortNoTax": "incl. {fees} fees",
  "eventDetail.priceBreakdown.shortNoFees": "incl. {tax} tax",
  "eventDetail.lowAvailability": "Only {count} left",
};

const fakeTranslate = (key: string, values?: Record<string, unknown>) => {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    template,
  );
};

/**
 * Forward only DOM-safe attributes (`data-`, `aria-`, `role`) through the `@th/ui`
 * stand-ins. The original mocks dropped every prop, which silently swallowed
 * `data-testid` — so a testid assertion could not have failed even if the
 * component stopped emitting it. Both real components forward `data-*` to
 * their DOM node, so this makes the mock faithful rather than permissive.
 */
const pickDomProps = (rest: Record<string, unknown>) => {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
      domProps[key] = value;
    }
  }
  return domProps;
};

vi.mock("@th/ui", () => ({
  Link: ({
    href,
    children,
    style,
    ...rest
  }: {
    href?: string;
    children?: ReactNode;
    style?: Record<string, unknown>;
  } & Record<string, unknown>) => (
    <a href={href} style={style} {...pickDomProps(rest)}>
      {children}
    </a>
  ),
  // Honours `tag`, because the real `Text` does and that is exactly what
  // broke: `SectionTitle` shipped as `styled(Text, { tag: "h2" })`, the styled
  // layer swallowed the tag, and every section heading rendered as a <span>
  // for months under a comment claiming it was "a real section heading". A
  // mock that always renders <span> can never catch that.
  Text: ({
    children,
    tag,
    ...rest
  }: { children?: ReactNode; tag?: string } & Record<string, unknown>) => {
    const Tag = (tag ?? "span") as "span";
    return <Tag {...pickDomProps(rest)}>{children}</Tag>;
  },
  // `@th/ui` Button takes `onPress` ONLY — never `onClick` — and `tag`
  // re-hosts it on a different element (the Get-tickets link branch passes
  // `tag="span"` so the anchor stays the only interactive node).
  Button: ({
    children,
    onPress,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    tag?: string;
  } & Record<string, unknown>) => {
    const domProps = pickDomProps(rest);
    if (tag === "span") {
      return (
        <span onClick={onPress} {...domProps}>
          {children}
        </span>
      );
    }
    return (
      <button type="button" onClick={onPress} {...domProps}>
        {children}
      </button>
    );
  },
  /**
   * The Date Stub is the hero's no-poster artwork. Stood in as a marker that
   * records what it was FED — the artifact itself is covered against the real
   * design system in `packages/ui/.../__tests__/DateStub.test.tsx`, and a
   * plain-DOM re-render of it here would only prove the mock works.
   */
  DateStub: ({
    title,
    date,
    venueLine,
    layout,
    size,
    testId,
  }: Record<string, unknown>) => (
    <div
      data-testid={testId as string}
      data-stub-size={size as string}
      data-stub-layout={(layout as string) ?? "split"}
      data-stub-date={date ? JSON.stringify(date) : "none"}
      // `?? "<unset>"` matters: React drops an attribute whose value is
      // `undefined`, so `data-stub-title=""` and "no title prop at all" would
      // otherwise be indistinguishable — and "the hero passes no title" is
      // precisely what one of these tests exists to hold.
      data-stub-title={(title as string) ?? "<unset>"}
      data-stub-venue-line={(venueLine as string) ?? "<unset>"}
    />
  ),
  formatStubDateParts: (
    startsAt: Date | string | number | null | undefined,
    timezone?: string | null,
  ) => {
    if (!startsAt) return null;
    const d = startsAt instanceof Date ? startsAt : new Date(startsAt);
    if (Number.isNaN(d.getTime())) return null;
    const at = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", {
        ...opts,
        timeZone: timezone || "UTC",
      }).format(d);
    return {
      weekday: at({ weekday: "short" }).toUpperCase(),
      day: at({ day: "numeric" }),
      month: at({ month: "short" }).toUpperCase(),
    };
  },
  useTranslations: () => fakeTranslate,
  // Option-aware so the community head's DATE label (weekday, no time) and
  // its TIME line (time, no weekday) are distinguishable in assertions. Every
  // pre-existing caller passes weekday AND hour, so their string is unchanged.
  useFormatters: () => ({
    dateTime: (_d: Date, opts?: Intl.DateTimeFormatOptions) => {
      if (opts?.weekday && !opts.hour) return "Sunday, September 13, 2026";
      if (opts?.hour && !opts.weekday) return "8:30 PM";
      return "Sat, Jan 1, 2027";
    },
    // `fmtCurrency` hands this MAJOR units (18, not 1800); a fixed en-US
    // rendering keeps the price assertions about placement, not locale.
    currency: (major: number, currency: string) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        major,
      ),
  }),
}));

// Spy on every next/dynamic-loaded component's props (EventContent only
// loads LocationMapPreview this way) so tests can assert the exact props
// the map receives — the privacy-critical `preObfuscated` gate lives there.
const { dynamicComponentSpy } = vi.hoisted(() => ({
  dynamicComponentSpy: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    dynamicComponentSpy(props);
    return null;
  },
}));


// Mutable so the `waitlists` gate can be flipped per-test. `undefined` (gates
// still loading) is the default, matching the pre-existing suite's assumption.
let mockGates: Partial<FeatureGatesSnapshot> | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates }),
}));

// The join form itself pulls in tRPC hooks; these tests only assert whether
// EventContent *renders* it, so stand in a marker.
vi.mock("../TravelTimeWidget", () => ({
  TravelTimeWidget: () => <div data-testid="travel-time" />,
}));

vi.mock("../WaitlistJoinForm", () => ({
  WaitlistJoinForm: () => <div data-testid="waitlist-join-form" />,
}));

import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";
import { EventContent } from "../EventContent";
import { serverRowAt } from "@/lib/pricing/__fixtures__/pwyw-floor";

beforeEach(() => {
  dynamicComponentSpy.mockClear();
  mockGates = undefined;
});

const posterProps = {
  title: "Warehouse Showcase",
  startsAt: "2026-10-05T01:00:00.000Z",
  timezone: "America/New_York",
  heroImageUrl: "https://cdn.example.test/poster.jpg",
  immersiveHero: true,
  backHref: "/",
  ctaLabel: "Get tickets",
  ctaHref: "/events/checkout/warehouse-showcase",
  feeMode: "PASS_THROUGH" as const,
  admissionTaxRateBps: 8875,
};
const { heroImageUrl: _poster, immersiveHero: _immersive, ...classicProps } =
  posterProps;

// The owner's board example: a $40 ticket in NYC, $45.67 all-in.
const GA = {
  id: "tt-ga",
  name: "General Admission",
  priceCents: 4000,
  capacity: 250,
  remainingCapacity: 250,
};
const NYC = {
  platformFeeCents: 50,
  processorFeeCents: 162,
  taxEstimateCents: 355,
  buyerUnitTotalCents: 4567,
};

describe("EventContent — the all-in price names its parts", () => {
  it("buy band: figure unchanged, long caption under it", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA]}
        feeEstimateMap={{ "tt-ga": NYC }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      /^\$45\.67$/,
    );
    expect(screen.getByTestId("event-buy-band-breakdown")).toHaveTextContent(
      /^\$40\.00 ticket \+ \$2\.12 fees \+ \$3\.55 tax$/,
    );
  });

  it("docked bar: figure unchanged, short caption under it", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA]}
        feeEstimateMap={{ "tt-ga": NYC }}
      />,
    );
    expect(screen.getByTestId("event-sticky-bar-price")).toHaveTextContent(
      /^\$45\.67$/,
    );
    expect(screen.getByTestId("event-sticky-bar-breakdown")).toHaveTextContent(
      /^incl\. \$2\.12 fees \+ \$3\.55 tax$/,
    );
  });

  it("classic hero (no poster): the meta row carries the long caption", () => {
    render(
      <EventContent
        {...classicProps}
        ticketTypes={[GA]}
        feeEstimateMap={{ "tt-ga": NYC }}
      />,
    );
    expect(screen.queryByTestId("event-buy-band")).toBeNull();
    expect(screen.getByText("From $45.67")).toBeInTheDocument();
    expect(
      screen.getByTestId("event-hero-price-breakdown"),
    ).toHaveTextContent(/^\$40\.00 ticket \+ \$2\.12 fees \+ \$3\.55 tax$/);
  });

  it("ABSORB: no fee part, only the tax", () => {
    render(
      <EventContent
        {...posterProps}
        feeMode="ABSORB"
        ticketTypes={[GA]}
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 0,
            processorFeeCents: 0,
            taxEstimateCents: 355,
            buyerUnitTotalCents: 4355,
          },
        }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-breakdown")).toHaveTextContent(
      /^\$40\.00 ticket \+ \$3\.55 tax$/,
    );
    expect(screen.getByTestId("event-sticky-bar-breakdown")).toHaveTextContent(
      /^incl\. \$3\.55 tax$/,
    );
  });

  it("the low-availability line stays, stacked under the caption", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[{ ...GA, remainingCapacity: 4 }]}
        feeEstimateMap={{ "tt-ga": NYC }}
      />,
    );
    const caption = screen.getByTestId("event-buy-band-breakdown");
    const remaining = screen.getByText("Only 4 left");
    expect(
      caption.compareDocumentPosition(remaining) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("no caption when the row's parts imply a different face than the tier's", () => {
    // Row priced at a $35 face (35.00 + 1.95 fees + 3.11 tax = 40.06) while
    // the tier reads $40. The page prints the row's total, $40.06; a caption
    // under it would claim a $40 ticket with fees and tax that don't add up.
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA]}
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 50,
            processorFeeCents: 145,
            taxEstimateCents: 311,
            buyerUnitTotalCents: 4006,
          },
        }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      /^\$40\.06$/,
    );
    expect(screen.queryByTestId("event-buy-band-breakdown")).toBeNull();
    expect(screen.queryByTestId("event-sticky-bar-breakdown")).toBeNull();
  });

  it("no caption when the row names a different face (unitPriceCents)", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA]}
        feeEstimateMap={{ "tt-ga": { ...NYC, unitPriceCents: 3500 } }}
      />,
    );
    expect(screen.queryByTestId("event-buy-band-breakdown")).toBeNull();
  });

  it("no caption while the estimate is still calculating", () => {
    render(<EventContent {...posterProps} ticketTypes={[GA]} />);
    expect(screen.queryByTestId("event-buy-band-breakdown")).toBeNull();
    expect(screen.queryByTestId("event-sticky-bar-breakdown")).toBeNull();
  });

  it("no caption for a free tier", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[{ ...GA, priceCents: 0 }]}
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 0,
            processorFeeCents: 0,
            taxEstimateCents: 0,
            buyerUnitTotalCents: 0,
          },
        }}
      />,
    );
    expect(screen.queryByTestId("event-buy-band-breakdown")).toBeNull();
  });

  it("no caption when fees and tax are both 0", () => {
    render(
      <EventContent
        {...posterProps}
        feeMode="ABSORB"
        ticketTypes={[GA]}
        feeEstimateMap={{
          "tt-ga": {
            platformFeeCents: 0,
            processorFeeCents: 0,
            taxEstimateCents: 0,
            buyerUnitTotalCents: 4000,
          },
        }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "$40.00",
    );
    expect(screen.queryByTestId("event-buy-band-breakdown")).toBeNull();
  });

  it("pay-what-you-want: the floor's ALL-IN figure names its parts, the floor as the ticket (owner ruling 2026-10-02)", () => {
    const row = serverRowAt("tt-pwyw", 500);
    const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[
          {
            ...GA,
            id: "tt-pwyw",
            priceCents: 0,
            pricingMode: "ADJUSTABLE" as const,
            minimumCents: 500,
            suggestedCents: 1500,
          },
        ]}
        feeEstimateMap={{ "tt-pwyw": row }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent("$6.09");
    const fees = row.platformFeeCents + row.processorFeeCents;
    expect(screen.getByTestId("event-buy-band-breakdown")).toHaveTextContent(
      `$5.00 ticket + ${usd(fees)} fees + ${usd(row.taxEstimateCents)} tax`,
    );
    expect(screen.getByTestId("event-sticky-bar-breakdown")).toHaveTextContent(
      `incl. ${usd(fees)} fees + ${usd(row.taxEstimateCents)} tax`,
    );
    expect(screen.getByTestId("event-buy-band")).not.toHaveTextContent(
      "+ fees & tax",
    );
  });
});
