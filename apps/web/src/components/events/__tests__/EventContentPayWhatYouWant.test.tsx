import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";

/**
 * EventContent — the hero "from" price when a tier is pay-what-you-want.
 *
 * The mock prelude is copied from EventContent.test.tsx so this file stands on
 * its own. What it pins: a PWYW tier is RANKED and DISPLAYED by its floor's
 * all-in (the server prices its estimate row at `minimumCents`, fees and tax
 * on top) — "From $6.09" for a $5 floor at 8.88% (owner ruling 2026-10-02),
 * or "Pay what you want" + the suggestion at minimum 0. Never "Free", never
 * the bare floor.
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
  "checkout.calculatingTotal": "Calculating total...",
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

/** Props of dynamic-component renders that are LocationMapPreview calls. */
const getMapPreviewCalls = (): Record<string, unknown>[] =>
  dynamicComponentSpy.mock.calls
    .map(([props]) => props as Record<string, unknown>)
    .filter((props) => "latitude" in props && "longitude" in props);

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
import {
  PWYW_FLOOR_ALL_IN_CENTS,
  serverRowAt,
} from "@/lib/pricing/__fixtures__/pwyw-floor";

beforeEach(() => {
  dynamicComponentSpy.mockClear();
  mockGates = undefined;
});


const posterProps = {
  title: "Gallery Walk",
  startsAt: "2026-09-11T01:30:00.000Z",
  timezone: "America/Chicago",
  heroImageUrl: "https://cdn.example.test/poster.jpg",
  immersiveHero: true,
  backHref: "/",
  ctaLabel: "Get tickets",
  ctaHref: "/events/checkout/gallery-walk",
  feeMode: "PASS_THROUGH" as const,
  admissionTaxRateBps: 888,
};

const PWYW = {
  id: "tt-pwyw",
  name: "Pay What You Want",
  priceCents: 0,
  capacity: 40,
  remainingCapacity: 40,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};
const GA = {
  id: "tt-ga",
  name: "General Admission",
  priceCents: 3700,
  capacity: 250,
  remainingCapacity: 250,
};
const row = (buyerUnitTotalCents: number) => ({
  platformFeeCents: 0,
  processorFeeCents: 0,
  taxEstimateCents: 0,
  buyerUnitTotalCents,
});

const bandPrice = () => screen.getByTestId("event-buy-band");

describe("EventContent — hero price with a pay-what-you-want tier", () => {
  it("owner ruling 2026-10-02: a $5-minimum tier at 8.88% is quoted 'From $6.09' — the floor all-in — never Free, never the bare floor", () => {
    const floorRow = serverRowAt("tt-pwyw", 500);
    expect(floorRow.buyerUnitTotalCents).toBe(PWYW_FLOOR_ALL_IN_CENTS);
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA, PWYW]}
        // The server prices the PWYW row at its $5 floor, fees and tax on top.
        feeEstimateMap={{ "tt-ga": row(4008), "tt-pwyw": floorRow }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "$6.09",
    );
    expect(bandPrice()).toHaveTextContent("From");
    expect(bandPrice()).not.toHaveTextContent("+ fees & tax");
    expect(bandPrice()).not.toHaveTextContent("Free");
  });

  it("regression: a fixed tier repriced under a cached row reads 'Calculating total...' in the hero, as its Tickets row does", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[{ ...GA, priceCents: 3500 }]}
        feeEstimateMap={{ "tt-ga": serverRowAt("tt-ga", 3000) }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "Calculating total...",
    );
  });

  it("regression: a PWYW floor moved under a cached row reads 'Calculating total...' in the hero", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[{ ...PWYW, minimumCents: 700 }]}
        feeEstimateMap={{ "tt-pwyw": serverRowAt("tt-pwyw", 500) }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "Calculating total...",
    );
  });

  it("fee rates not loaded: 'Calculating total...', never the bare $5 floor", () => {
    render(
      <EventContent {...posterProps} ticketTypes={[PWYW]} feeEstimateMap={undefined} />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "Calculating total...",
    );
    expect(bandPrice()).not.toHaveTextContent("From");
  });

  it("ranks by the floor's ALL-IN, not its face: a fixed tier cheaper all-in wins", () => {
    // PWYW floor $5 face but $6.10 all-in; a fixed $6.00 all-in is cheaper.
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[PWYW, { ...GA, priceCents: 550 }]}
        feeEstimateMap={{ "tt-ga": row(600), "tt-pwyw": row(610) }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "$6.00",
    );
    expect(bandPrice()).not.toHaveTextContent("+ fees & tax");
  });

  it("minimum 0: 'Pay what you want' + the suggestion — not 'From $15.00', not Free", () => {
    render(
      <EventContent
        {...posterProps}
        ticketTypes={[GA, { ...PWYW, minimumCents: 0 }]}
        feeEstimateMap={{ "tt-ga": row(4008), "tt-pwyw": row(0) }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "Pay what you want",
    );
    expect(bandPrice()).toHaveTextContent("suggested $15.00");
    expect(bandPrice()).not.toHaveTextContent("From");
    expect(bandPrice()).not.toHaveTextContent("Free");
  });
});
