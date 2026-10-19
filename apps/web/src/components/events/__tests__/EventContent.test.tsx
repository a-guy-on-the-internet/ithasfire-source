import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";

/**
 * EventContent — calm-honest-ux revivals (docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml)
 *
 * Covers the two honest, non-manipulative disclosures restored by FR-003
 * (organizer "Presented by" badge) and FR-004 (plain refund-policy line).
 * Ports the "Organizer badge visibility" and "Refund policy display logic"
 * `describe` blocks from the deleted
 * apps/web/src/components/events/__tests__/competitive-ux-features.test.ts,
 * adapted to render the real component instead of asserting on inline
 * illustrative logic.
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
  "eventDetail.factWhen": "When",
  "eventDetail.factListedBy": "Listed by",
  "common.dateNotSet": "Date not set",
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
    // The community WHEN row formats its range with a real
    // `Intl.DateTimeFormat(locale)`; a test can switch the locale to prove
    // `fmt.locale` (not a hardcoded one) reaches it.
    locale: mockLocale,
    dateTime: (d: Date, opts?: Intl.DateTimeFormatOptions) => {
      // Real Intl throws on an Invalid Date; the fixed strings below would not.
      if (Number.isNaN(d.getTime())) throw new RangeError("Invalid time value");
      // The time-only form is zone-correct for real. A call with no
      // `timeZone` formats in UTC, not the machine's zone, so a caller that
      // drops the venue zone fails on every machine (this one runs in Chicago).
      const zoned = (o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", {
          ...o,
          timeZone: o.timeZone ?? "UTC",
        }).format(d);
      if (opts?.weekday && !opts.hour) return "Sunday, September 13, 2026";
      if (opts?.hour && !opts.weekday) return zoned(opts);
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
/** The locale `useFormatters()` reports; reset to "en-US" before each test. */
let mockLocale = "en-US";

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

// `isMapEnabled` is read at module scope from the tile-server env; a getter
// lets the arrival-area legend tests flip it per test.
const mapsConfig = vi.hoisted(() => ({ enabled: undefined as boolean | undefined }));
vi.mock("@/config/maps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/maps")>();
  return {
    ...actual,
    get isMapEnabled() {
      return mapsConfig.enabled ?? actual.isMapEnabled;
    },
  };
});

import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";
import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";
import { EventContent } from "../EventContent";
import { CommunityListingHead } from "../CommunityListingHead";

beforeEach(() => {
  dynamicComponentSpy.mockClear();
  mockGates = undefined;
  mockLocale = "en-US";
  mapsConfig.enabled = undefined;
});

// ── The hero's default artwork: the Date Stub (2026-09-12) ────────────────
// The branch this replaced was a bokeh-gradient panel carrying an image icon
// and the words "No hero image" — a decorative blob whose only message was that
// something was missing. What matters here is the WIRING; the artifact itself
// is covered against the real design system in packages/ui.
describe("EventContent — the hero's Date Stub", () => {
  const posterless = {
    title: "Comedy Night at Larry's",
    // 01:30 UTC on the 11th is 20:30 on the 10th in Chicago — so THU 10 SEP
    // below can only be produced by the VENUE's zone. UTC (the helper's own
    // fallback) reads FRI 11 SEP, and so does every European machine zone.
    startsAt: "2026-09-11T01:30:00.000Z",
    timezone: "America/Chicago",
    venueName: "Larry's",
    location: "Nashville, TN",
  };

  it("NEVER displaces a real poster", () => {
    render(
      <EventContent
        {...posterless}
        heroImageUrl="https://cdn.example.test/poster.jpg"
      />,
    );

    expect(screen.queryByTestId("event-hero-date-stub")).toBeNull();
    const poster = screen.getByAltText("eventDetail.heroAlt");
    expect(poster).toHaveAttribute("src", "https://cdn.example.test/poster.jpg");
  });

  it("draws the stub when there is no poster, in the VENUE's zone", () => {
    render(<EventContent {...posterless} />);

    const stub = screen.getByTestId("event-hero-date-stub");
    // Chicago, not UTC (which would read FRI 11 SEP) and not the machine's zone.
    expect(stub.dataset.stubDate).toBe(
      JSON.stringify({ weekday: "THU", day: "10", month: "SEP" }),
    );
  });

  it("is the TORN stub — it repeats nothing the page already states", () => {
    render(<EventContent {...posterless} />);
    const stub = screen.getByTestId("event-hero-date-stub");

    // The guard for the ruling of 2026-09-12. With the full artifact here, a
    // 320px screen read "Comedy Night at Larry's" (stub) / "COMEDY NIGHT AT
    // LARRY'S" (h1) / "Nashville, TN" (stub) / "NASHVILLE, TN" (meta row) —
    // four lines, two facts. On this page the artwork's job is identity; the
    // page states the information.
    expect(stub.dataset.stubLayout).toBe("column");
    expect(stub.dataset.stubTitle).toBe("<unset>");
    expect(stub.dataset.stubVenueLine).toBe("<unset>");

    // ...and the page still states both, exactly once each.
    expect(screen.getByText("Comedy Night at Larry's")).toBeInTheDocument();
  });

  it("renders rather than throwing when the event has no usable date", () => {
    render(<EventContent {...posterless} startsAt={undefined} />);
    expect(
      screen.getByTestId("event-hero-date-stub").dataset.stubDate,
    ).toBe("none");
  });

  it("sizes from the frame, not from the `mobile` device guess", () => {
    // `mobile` is a device flag; a 320px DESKTOP viewport is exactly where a
    // wide-frame numeral overflowed before. The tier is constant and steps
    // down on the `$sm` media query instead, which is the frame's real width.
    const { rerender } = render(<EventContent {...posterless} />);
    expect(screen.getByTestId("event-hero-date-stub").dataset.stubSize).toBe(
      "xl",
    );
    rerender(<EventContent {...posterless} mobile />);
    expect(screen.getByTestId("event-hero-date-stub").dataset.stubSize).toBe(
      "xl",
    );
  });
});

// ── The poster frame: width is the column, height follows the file ────────
// What this replaced: a fixed 16/9 box with the poster `object-fit: contain`ed
// inside it, backed by a blurred, veiled copy of ITSELF whose only job was to
// hide the letterbox bars. A 2:3 gig flyer — the common shape — drew ~240px
// wide in a 768px column, the other ~520px being a blur of the thing you were
// trying to look at.
//
// The shape rules are CSS (container query units), so this block asserts the
// wiring here and the rules against the stylesheet itself — the same split the
// community-body block below already uses. When the upload recorded the file's
// pixel size, the <img> also carries it as width/height so the box is reserved
// before the bytes arrive; under `height: auto` that changes no final shape.
describe("EventContent — the hero poster frame", () => {
  const posterProps = {
    title: "Comedy Night at Larry's",
    startsAt: "2026-09-11T01:30:00.000Z",
    timezone: "America/Chicago",
    heroImageUrl: "https://cdn.example.test/poster.jpg",
  };

  const heroCss = () =>
    readFileSync(resolve(__dirname, "../event-content.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

  const ruleFor = (selector: string) => {
    const css = heroCss();
    const at = css.indexOf(`${selector} {`);
    expect(
      at,
      `${selector} is not declared in event-content.css`,
    ).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("has no blurred self-copy behind the poster any more", () => {
    const { container } = render(<EventContent {...posterProps} />);

    // The fill was a pair of aria-hidden divs: one painting the poster as a
    // blurred `background-image`, one veiling it. Neither may come back — the
    // whole point is that nothing is being filled.
    const fills = Array.from(container.querySelectorAll("div")).filter((el) =>
      (el.getAttribute("style") ?? "").includes(posterProps.heroImageUrl),
    );
    expect(fills).toHaveLength(0);
    expect(container.innerHTML).not.toContain("blur(");
  });

  it("frames the poster as a container, and the poster crops from the bottom", () => {
    const { container } = render(<EventContent {...posterProps} />);

    const frame = container.querySelector(".event-hero-poster-frame");
    expect(frame).not.toBeNull();
    // The <img> is the frame's own child — the container unit it measures
    // against has to be this element, not some ancestor.
    const poster = screen.getByAltText("eventDetail.heroAlt");
    expect(poster.parentElement).toBe(frame);
    expect(poster).toHaveClass("event-hero-poster-img");

    // `height: auto` is the whole rule: natural height, whatever the file is.
    // `cover` + a top anchor is what makes the clamped case a bottom crop
    // rather than a letterbox — a flyer's headliner survives.
    const rule = ruleFor(".event-hero-poster-img");
    expect(rule).toContain("height: auto");
    expect(rule).toContain("max-height: 150cqw");
    expect(rule).toContain("object-fit: cover");
    expect(rule).toContain("object-position: 50% 0%");
    expect(ruleFor(".event-hero-poster-frame")).toContain(
      "container-type: inline-size",
    );
  });

  it("holds the EMBED to a square, and only the embed", () => {
    // `mobile` is the embed flag, not a viewport signal: a real phone renders
    // the `!mobile` branch and gets the full 2:3 ceiling. An embed is a widget
    // in someone else's page — a 2:3 poster there pushes the ticket list and
    // its CTA out of the iframe.
    const { rerender } = render(<EventContent {...posterProps} mobile />);
    expect(screen.getByAltText("eventDetail.heroAlt")).toHaveClass(
      "event-hero-poster-img--compact",
    );

    rerender(<EventContent {...posterProps} />);
    expect(screen.getByAltText("eventDetail.heroAlt")).not.toHaveClass(
      "event-hero-poster-img--compact",
    );

    expect(ruleFor(".event-hero-poster-img--compact")).toContain(
      "max-height: 100cqw",
    );
  });

  it("still renders the embed's whole hero zone", () => {
    render(<EventContent {...posterProps} mobile />);
    expect(screen.getByAltText("eventDetail.heroAlt")).toHaveAttribute(
      "src",
      posterProps.heroImageUrl,
    );
    expect(screen.getByText("Comedy Night at Larry's")).toBeInTheDocument();
  });

  it("carries the file's own size as width/height when it is known", () => {
    render(
      <EventContent
        {...posterProps}
        heroImageSize={{ width: 1080, height: 1350 }}
      />,
    );
    const poster = screen.getByAltText("eventDetail.heroAlt");
    expect(poster).toHaveAttribute("width", "1080");
    expect(poster).toHaveAttribute("height", "1350");
    // The CSS still decides the rendered size; the attributes only feed the
    // UA's aspect-ratio. No inline size sneaks in.
    expect(poster.getAttribute("style") ?? "").not.toMatch(/width|height/);
  });

  it("renders exactly as before when the size is unknown or unusable", () => {
    const { rerender } = render(<EventContent {...posterProps} />);
    let poster = screen.getByAltText("eventDetail.heroAlt");
    expect(poster).not.toHaveAttribute("width");
    expect(poster).not.toHaveAttribute("height");

    rerender(
      <EventContent {...posterProps} heroImageSize={{ width: 0, height: 900 }} />,
    );
    poster = screen.getByAltText("eventDetail.heroAlt");
    expect(poster).not.toHaveAttribute("width");
    expect(poster).not.toHaveAttribute("height");
  });

  it("leaves the Date Stub's fixed plate alone", () => {
    // The generated artwork is drawn for a 16/9 frame and is the OG image's
    // twin. It is not a file whose proportions we are discovering, so none of
    // the poster shape rules may leak onto it.
    const { container } = render(
      <EventContent {...posterProps} heroImageUrl={undefined} />,
    );

    expect(screen.getByTestId("event-hero-date-stub")).toBeInTheDocument();
    expect(container.querySelector(".event-hero-poster-frame")).toBeNull();
    expect(container.querySelector(".event-hero-poster-img")).toBeNull();
    expect(container.querySelector(".event-content-hero")).not.toBeNull();
  });
});

// ── The poster-first page (2026-09-24) ─────────────────────────────────────
// MEASURED at 1440x900 on the one-column page: a 2:3 gig flyer rendered
// 768x1152, so the reader got the navbar, the back link and then a full
// viewport of poster. The first fix split the hero into a rail and a column —
// and left everything below the hero as a 48rem block centred under the grid:
// poster at 200, h1 at 672, sections at 360. THREE left edges. Now the rail,
// the meta block, the buy band, the sections and the sections after them are
// siblings of ONE grid, and the page has two.
describe("EventContent — the poster-first page", () => {
  const posterProps = {
    title: "Comedy Night at Larry's",
    startsAt: "2026-09-11T01:30:00.000Z",
    timezone: "America/Chicago",
    heroImageUrl: "https://cdn.example.test/poster.jpg",
    immersiveHero: true,
    backHref: "/",
  };
  const forSale = {
    ctaLabel: "Get tickets",
    ctaHref: "/events/checkout/comedy-night",
    ticketTypes: [
      {
        id: "tt-1",
        name: "General",
        priceCents: 1800,
        capacity: 100,
        remainingCapacity: 41,
      },
    ],
    // The figure is the buyer's ALL-IN unit total, which only exists once the
    // fee estimate has landed — without it the page honestly says
    // "calculating" rather than quoting a face value checkout will not charge.
    feeEstimateMap: {
      "tt-1": {
        platformFeeCents: 0,
        processorFeeCents: 0,
        taxEstimateCents: 0,
        buyerUnitTotalCents: 1800,
      },
    },
  };

  const css = () =>
    readFileSync(resolve(__dirname, "../event-content.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

  /**
   * The body of one `@media` block, found by walking braces rather than by
   * regex — these assertions are entirely about WHERE a declaration lives,
   * and a regex cannot tell a rule inside a media query from one beside it.
   */
  const mediaBlock = (condition: string) => {
    const sheet = css();
    const at = sheet.indexOf(`@media ${condition} {`);
    expect(at, `@media ${condition} is not declared`).toBeGreaterThan(-1);
    const open = sheet.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < sheet.length; i++) {
      if (sheet[i] === "{") depth++;
      else if (sheet[i] === "}" && --depth === 0) break;
    }
    return sheet.slice(open + 1, i);
  };

  /** The FIRST declaration block for `selector` inside `sheet`. */
  const ruleIn = (sheet: string, selector: string) => {
    const at = sheet.indexOf(`${selector} {`);
    expect(at, `${selector} is not declared here`).toBeGreaterThan(-1);
    return sheet.slice(at, sheet.indexOf("}", at));
  };

  /** Everything BEFORE the first wide media query: the phone rules. */
  const narrowSheet = () => {
    const sheet = css();
    return sheet.slice(0, sheet.indexOf("@media (min-width: 768px) {"));
  };

  const root = (container: HTMLElement) =>
    container.querySelector(".event-page-split");

  it("puts the rail, the meta block, the buy band and the sections in ONE grid", () => {
    const { container } = render(<EventContent {...posterProps} {...forSale} />);

    const grid = root(container);
    expect(grid).not.toBeNull();

    // Every one of these is a DIRECT child of the grid — there is no wrapper
    // left for a third left edge to hide in. The sheet (the h1) comes BEFORE
    // the rail column in the DOM, so a screen reader meets the title first;
    // the grid paints the poster above it on a phone (`grid-row`, below).
    const kids = [...grid!.children];
    const cls = (el: Element) => el.className;
    expect(kids.map(cls)).toEqual([
      "event-page-split__band",
      "event-page-split__fade",
      "event-page-split__back",
      "event-page-split__sheet",
      "event-page-split__aside",
      "event-buy-band",
      "event-page-split__content",
      "event-page-split__after",
    ]);

    // The rail column: the poster + actions, then the facts under them.
    const aside = grid!.querySelector(":scope > .event-page-split__aside")!;
    expect([...aside.children].map(cls)).toEqual([
      "event-page-split__rail",
      "event-page-split__facts",
    ]);
    const rail = aside.querySelector(".event-page-split__rail")!;
    const frame = rail.querySelector(".event-hero-poster-frame");
    expect(frame).not.toBeNull();
    expect(screen.getByAltText("eventDetail.heroAlt").parentElement).toBe(frame);

    const sheet = grid!.querySelector(":scope > .event-page-split__sheet")!;
    expect(sheet).toContainElement(screen.getByRole("heading", { level: 1 }));

    // The numbered sections live in the grid, not under it.
    const content = screen.getByTestId("event-content-stack");
    expect(content.parentElement).toBe(grid);
    expect(content).toContainElement(
      container.querySelector(".event-content-logistics") as HTMLElement,
    );
  });

  it("renders the band and its fade only over a backdrop", () => {
    const { container, rerender } = render(
      <EventContent {...posterProps} {...forSale} />,
    );
    expect(screen.getByTestId("event-page-band")).toBeInTheDocument();
    expect(container.querySelector(".event-page-split__fade")).not.toBeNull();
    expect(root(container)).toHaveClass("event-page-split--immersive");

    // No HeroBackdrop, no band — a dark strip over plain cream would be wrong.
    rerender(<EventContent {...posterProps} {...forSale} immersiveHero={false} />);
    expect(screen.queryByTestId("event-page-band")).toBeNull();
    expect(container.querySelector(".event-page-split__fade")).toBeNull();
    expect(root(container)).not.toHaveClass("event-page-split--immersive");
  });

  it("keeps the embed, the builder preview and the community listing off it", () => {
    // `mobile` is the EMBED flag and `isAdminPreview` is the builder's panel.
    // Both are boxes sized by their host, not viewports, so neither may ever
    // reach this layout however wide the window is. The COMMUNITY listing
    // runs its own two-track body below the head.
    for (const narrow of [
      { mobile: true },
      { isAdminPreview: true },
      { communityLayout: true },
    ]) {
      const { container, unmount } = render(
        <EventContent {...posterProps} {...narrow} />,
      );
      expect(root(container), JSON.stringify(narrow)).toBeNull();
      expect(
        screen.queryByTestId("event-sticky-bar"),
        JSON.stringify(narrow),
      ).toBeNull();
      // The classic hero zone is untouched — the poster-first page is a
      // separate tree, not a re-skin of this one.
      expect(
        container.querySelector(".event-hero-immersive"),
        JSON.stringify(narrow),
      ).not.toBeNull();
      unmount();
    }
  });

  it("leaves a posterless event on the classic hero", () => {
    // The Date Stub is a fixed 16:9 plate and the OG image's twin. There was
    // never a wall to fix, and the split would strand it beside the text.
    const { container } = render(
      <EventContent {...posterProps} heroImageUrl={undefined} />,
    );

    expect(screen.getByTestId("event-hero-date-stub")).toBeInTheDocument();
    expect(root(container)).toBeNull();
    expect(container.querySelector(".event-content-hero")).not.toBeNull();
  });

  it("moves the price out of the meta row — into the buy band and the docked bar", () => {
    render(<EventContent {...posterProps} {...forSale} />);

    // Not a prefix in the meta row any more ("From $18.00")...
    expect(screen.queryByText("common.fromPrice")).toBeNull();

    // ...but a LABEL over a figure, twice: the paper card wide, the ink bar
    // narrow. Same figure, so the two can never disagree.
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent("$18.00");
    expect(screen.getByTestId("event-sticky-bar-price")).toHaveTextContent("$18.00");
    expect(screen.getAllByText("eventCard.priceFrom")).toHaveLength(2);
    // The low-stock line only when it is genuinely low (calm-honest-ux FR-004).
    expect(screen.queryByText("eventDetail.lowAvailability")).toBeNull();

    // The buy band carries the CTA the rest of the page keys on
    // (`useScrolledPast` in EventDetail); the docked bar carries its own.
    const band = screen.getByTestId("event-buy-band");
    expect(band).toContainElement(
      screen.getByTestId("event-hero-get-tickets-btn"),
    );
    expect(screen.getByTestId("event-sticky-bar")).toContainElement(
      screen.getByTestId("event-sticky-get-tickets-btn"),
    );
    // The docked bar is portaled to <body>, clear of the page's transforms.
    expect(screen.getByTestId("event-sticky-bar").parentElement).toBe(
      document.body,
    );
  });

  it("prints a free or still-calculating price without a 'from'", () => {
    render(
      <EventContent
        {...posterProps}
        {...forSale}
        ticketTypes={[{ ...forSale.ticketTypes[0]!, priceCents: 0 }]}
        feeEstimateMap={{
          "tt-1": { ...forSale.feeEstimateMap["tt-1"]!, buyerUnitTotalCents: 0 },
        }}
      />,
    );
    expect(screen.getByTestId("event-buy-band-price")).toHaveTextContent(
      "common.free",
    );
    expect(screen.queryByText("eventCard.priceFrom")).toBeNull();
  });

  it("does not climb over a notice that renders above the hero", () => {
    // EventDetail renders status / sellability notices BEFORE this component.
    // The band (wide) and the poster (narrow) climb back over the shell's top
    // padding to start under the navbar — over a notice, that climb painted
    // 0.62 black across its bottom edge (a DRAFT preview at 1440, in review).
    const { container, rerender } = render(<EventContent {...posterProps} />);
    expect(root(container)).not.toHaveClass("event-page-split--after-notice");
    rerender(<EventContent {...posterProps} heroFollowsNotice />);
    expect(root(container)).toHaveClass("event-page-split--after-notice");
    expect(ruleIn(narrowSheet(), ".event-page-split--after-notice")).toContain(
      "--shell-top: 0px",
    );
    // ...and the climb IS the variable, on both climbers.
    expect(ruleIn(narrowSheet(), ".event-page-split__rail")).toContain(
      "margin-top: calc(-1 * var(--shell-top))",
    );
    expect(
      ruleIn(mediaBlock("(min-width: 768px)"), ".event-page-split__band"),
    ).toContain("margin-top: calc(-1 * var(--shell-top))");
  });

  it("offers ONE 'Add to calendar' per width", () => {
    // The rail carries it from 768px; the schedule section keeps it below.
    // Two buttons with the same accessible name on one page is the collision
    // the passkey page shipped.
    const { container } = render(<EventContent {...posterProps} />);
    const scheduleOne = container.querySelector(".event-schedule-calendar");
    expect(scheduleOne).not.toBeNull();
    expect(scheduleOne).toContainElement(
      within(scheduleOne as HTMLElement).getByRole("button", {
        name: "eventDetail.addToCalendar",
      }),
    );
    expect(
      ruleIn(
        mediaBlock("(min-width: 768px)"),
        ".event-page-split .event-schedule-calendar",
      ),
    ).toContain("display: none");
    expect(ruleIn(narrowSheet(), ".event-poster-action-anchor--calendar")).toContain(
      "display: none",
    );
  });

  it("publishes the docked bar's height for the audio mini-player, narrow only", () => {
    // Both dock at `--consumer-bottom-nav-height`; without this the player
    // (48px, z 9000) covered the price and half the CTA.
    const narrow = mediaBlock("(max-width: 767px)");
    expect(ruleIn(narrow, "html:has(.event-page-split--bar)")).toContain(
      "--event-price-bar-height: 84px",
    );
    const player = readFileSync(
      resolve(__dirname, "../../audio/AudioPlayer.tsx"),
      "utf8",
    );
    expect(player).toContain("var(--event-price-bar-height, 0px)");
  });

  it("docks no bar and quotes no band when there is nothing to buy or quote", () => {
    render(<EventContent {...posterProps} />);
    expect(screen.queryByTestId("event-sticky-bar")).toBeNull();
    expect(screen.queryByTestId("event-buy-band")).toBeNull();
  });

  it("renders Save, Share and the calendar export in the rail, and a back square over the poster", () => {
    const { container } = render(
      <EventContent
        {...posterProps}
        saveAction={<button data-testid="event-save-button">Save</button>}
      />,
    );

    const rail = container.querySelector(".event-page-split__rail")!;
    const actions = rail.querySelector(".event-poster-chrome__actions")!;
    expect(actions).toContainElement(screen.getByTestId("event-save-button"));
    const share = screen.getByRole("button", { name: "eventDetail.share" });
    expect(actions).toContainElement(share);
    expect(share).toHaveClass("event-poster-action");
    // Scoped to the rail: the schedule section still carries the page's
    // default "Add to calendar" button below.
    const calendar = within(actions as HTMLElement).getByRole("button", {
      name: "eventDetail.addToCalendar",
    });
    expect(calendar.closest(".event-poster-action-anchor--calendar")).not.toBeNull();

    // Two back affordances in the tree, one per treatment; the stylesheet
    // shows exactly one at a time (below).
    expect(rail).toContainElement(screen.getByTestId("event-poster-back"));
    expect(screen.getByTestId("event-back-link")).toBeInTheDocument();
    const narrow = narrowSheet();
    expect(ruleIn(narrow, ".event-page-split__band,\n.event-page-split__fade,\n.event-page-split__back,\n.event-buy-band")).toContain("display: none");
    expect(ruleIn(mediaBlock("(min-width: 768px)"), ".event-poster-chrome__back")).toContain("display: none");
  });

  it("never opens the Share or Calendar menus inside a scroll container", () => {
    // `overflow: hidden` is a scroll container and has already clipped a
    // popover on prod here. The poster frame keeps its clip (it holds only
    // the <img>); nothing ABOVE it on the rail may add one.
    const wide = mediaBlock("(min-width: 768px)");
    for (const selector of [
      ".event-page-split__aside",
      ".event-page-split__rail",
      ".event-page-split__facts",
      ".event-poster-chrome",
      ".event-poster-chrome__actions",
      ".event-poster-action-anchor",
    ]) {
      const at = wide.indexOf(`${selector} {`);
      if (at === -1) continue;
      expect(wide.slice(at, wide.indexOf("}", at)), selector).not.toMatch(
        /(?<![-\w])overflow[-\w]*\s*:/,
      );
    }
    const narrow = narrowSheet();
    expect(ruleIn(narrow, ".event-page-split__rail")).not.toMatch(
      /(?<![-\w])overflow[-\w]*\s*:/,
    );
  });

  it("declares the columns only inside the wide media queries", () => {
    const wide = mediaBlock("(min-width: 768px)");
    const grid = ruleIn(wide, ".event-page-split");
    // A grid at every width (the base rule, below), and TWO explicit tracks
    // only here — the rail exists to give a portrait file a KNOWN width
    // (the poster's ceiling is written in `cqw` off exactly this box).
    expect(ruleIn(narrowSheet(), ".event-page-split")).toContain("display: grid");
    expect(ruleIn(narrowSheet(), ".event-page-split")).toContain(
      "grid-template-rows: auto auto auto auto auto",
    );
    expect(grid).toContain("grid-template-columns: minmax(0, 300px)");
    // The last row is the flexible one, so the rail column's overhang lands
    // below the sections rather than as gaps between them (MEASURED: 38px).
    expect(grid).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr)");
    // The canvas gutter.
    expect(grid).toContain("column-gap: 56px");
    expect(grid).toContain("align-items: start");
    expect(grid).toContain("padding-inline: 24px");

    // The rail column: column 1, EVERY row, ONE sticky unit (poster, actions
    // AND facts) — the containing block is the grid area, so it pins while
    // it fits the viewport. Never the poster alone: a pinned poster with the
    // facts scrolling under it would hide them.
    const aside = ruleIn(wide, ".event-page-split__aside");
    expect(aside).toContain("grid-column: 1");
    expect(aside).toContain("grid-row: 2 / -1");
    expect(aside).toContain("position: sticky");
    // Under the navbar's live height (published on the grid by EventContent),
    // plus the 24px the community rail keeps — MEASURED before this: pinned
    // at 24px, the poster's top third sat behind the sticky navbar.
    expect(aside).toContain("top: calc(var(--navbar-visible, 0px) + 24px)");
    expect(ruleIn(wide, ".event-page-split__rail")).not.toContain("sticky");

    // Everything else in column 2, in row order.
    expect(ruleIn(wide, ".event-page-split__sheet")).toContain("grid-row: 2");
    expect(ruleIn(wide, ".event-buy-band")).toContain("grid-row: 3");
    expect(ruleIn(wide, ".event-page-split__content")).toContain("grid-row: 4");
    expect(ruleIn(wide, ".event-page-split__after")).toContain("grid-row: 5");

    // The phone is a grid too — ONE column — so the sheet can sit before the
    // rail in the DOM and still paint under the poster. The two-column
    // template exists only in the wide block.
    const narrow = ruleIn(narrowSheet(), ".event-page-split");
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(narrowSheet()).not.toContain("grid-template-columns: minmax(0, 300px)");
    expect(ruleIn(narrowSheet(), ".event-page-split__aside")).toContain(
      "display: contents",
    );
    expect(ruleIn(narrowSheet(), ".event-page-split__rail")).toContain("grid-row: 1");
    expect(ruleIn(narrowSheet(), ".event-page-split__sheet")).toContain("grid-row: 2");
    expect(ruleIn(narrowSheet(), ".event-page-split__facts")).toContain("grid-row: 3");
    expect(ruleIn(narrowSheet(), ".event-page-split__content")).toContain("grid-row: 4");
  });

  it("puts Schedule, Location and the map UNDER the poster, and only there", () => {
    // Canvas board E1. A landscape photo is ~250px tall in the rail, and the
    // column under Save / Share / Calendar sat empty for a screen while the
    // decision column ran on. The facts fill it; the logistics block in the
    // column opens on the lineup instead.
    const { container } = render(
      <EventContent
        {...posterProps}
        {...forSale}
        location="Nashville, TN"
        address="917 Woodland St, Nashville, TN 37206"
        locationCoords={{ latitude: 36.17, longitude: -86.74, label: null, isExact: true }}
      />,
    );
    const facts = screen.getByTestId("event-page-facts");
    expect(facts.parentElement).toHaveClass("event-page-split__aside");
    // The catalogue stub carries real copy for this key ("Schedule").
    expect(facts).toContainElement(screen.getByText("Schedule"));
    expect(facts).toContainElement(screen.getByTestId("event-location-section"));
    expect(facts).toContainElement(
      screen.getByTestId("event-location-map-container"),
    );
    // Once, not twice: the column's logistics block no longer carries them.
    const content = screen.getByTestId("event-content-stack");
    expect(content.querySelector('[data-testid="event-location-section"]')).toBeNull();
    expect(content.querySelector('[data-testid="event-location-map-container"]')).toBeNull();
    // ...but it still frames the tickets.
    expect(content).toContainElement(container.querySelector(".event-content-logistics") as HTMLElement);
    // The numbering is unchanged: Schedule and Location are still 01 and 02.
    expect(facts.textContent).toContain("01");
    expect(facts.textContent).toContain("02");
  });

  it("frames no empty logistics block when the facts took everything", () => {
    // A poster event with a date and a place but no lineup, tickets or refund
    // policy: classic, the logistics block held Schedule + Location; here they
    // live under the poster, and an empty bordered block would be a mistake.
    const { container } = render(
      <EventContent {...posterProps} location="Nashville, TN" />,
    );
    expect(screen.getByTestId("event-page-facts")).toBeInTheDocument();
    expect(container.querySelector(".event-content-logistics")).toBeNull();
  });

  it("keeps the classic page's logistics block whole", () => {
    // Embed / preview / posterless: Schedule and Location lead the block, the
    // map beside the text, exactly as before the poster-first page existed.
    const { container } = render(
      <EventContent
        {...posterProps}
        heroImageUrl={undefined}
        location="Nashville, TN"
        locationCoords={{ latitude: 36.17, longitude: -86.74, label: null, isExact: true }}
      />,
    );
    expect(screen.queryByTestId("event-page-facts")).toBeNull();
    const logistics = container.querySelector(".event-content-logistics")!;
    expect(logistics).toContainElement(screen.getByTestId("event-location-section"));
    expect(logistics).toContainElement(
      screen.getByTestId("event-location-map-container"),
    );
    expect(logistics).toHaveClass("logistics-row");
  });

  it("turns the columns on at the exact width the page stops being 48rem", () => {
    // THE LOAD-BEARING PAIR. `EventPageBody` opens the page to 68rem with an
    // INLINE max-width, which cannot carry a media query — so from the first
    // pixel past 48rem the poster frame is wider, and a portrait poster that
    // is wider is TALLER. If the split lags that moment there is a band of
    // viewports where this layout is worse than the one it replaces.
    //
    // MEASURED in a browser when these two numbers disagreed (columns at 900,
    // page open from 768): at an 880px viewport a 2:3 flyer rendered 768x1152
    // and the <h1> sat 1325px down the page.
    //
    // 48rem = 768px, so the split threshold is 768px. Change one, change both.
    const wide = mediaBlock("(min-width: 768px)");
    expect(ruleIn(wide, ".event-page-split")).toContain(
      "grid-template-columns: minmax(0, 300px)",
    );
    // ...and no second track is declared anywhere before that block.
    expect(narrowSheet()).not.toMatch(/grid-template-columns:\s*minmax\(0, \d+px\) minmax/);
  });

  it("steps the rail up without ever starving the decision column", () => {
    // Every number is (page − 48px inset − 56px gutter − rail):
    //   >= 768   rail 300  ->  column 364 at 768, 496 at 899
    //   >= 900   rail 360  ->  column 436 at 900, 624 at 1087
    //   >= 1200  rail 440  ->  column 544 (page capped at 1088 by here)
    // 364px is the narrowest the column ever gets; the h1 and the badges are
    // already hardened for a 320px viewport, which is narrower still.
    expect(ruleIn(mediaBlock("(min-width: 768px)"), ".event-page-split")).toContain(
      "grid-template-columns: minmax(0, 300px)",
    );
    expect(ruleIn(mediaBlock("(min-width: 900px)"), ".event-page-split")).toContain(
      "grid-template-columns: minmax(0, 360px)",
    );
    expect(ruleIn(mediaBlock("(min-width: 1200px)"), ".event-page-split")).toContain(
      "grid-template-columns: minmax(0, 440px)",
    );
  });

  it("is a paper design on a phone and a band at the top of the page wide", () => {
    const narrow = narrowSheet();
    // Phone: ink on paper, the sheet riding up over the poster under a rule.
    const base = ruleIn(narrow, ".event-page-split");
    expect(base).toContain("--hero-ink: var(--color, #211C16)");
    expect(base).toContain("--hero-rule: var(--borderColor, #211C16)");
    expect(base).toContain("background: var(--background, #F6F0E4)");
    const sheet = ruleIn(narrow, ".event-page-split__sheet");
    expect(sheet).toContain("margin-top: -24px");
    // ABOVE the poster frame's inline z-index 1: the frame is later in the DOM
    // and won the tie once, hiding the rule and the overlap (review, 09-25).
    expect(sheet).toContain("z-index: 2");
    expect(sheet).toContain("border-top: 2px solid var(--borderColor, #211C16)");
    expect(sheet).toContain("background: var(--background, #F6F0E4)");
    // The docked bar is the inverted pair, both halves.
    const bar = ruleIn(narrow, ".event-sticky-bar");
    expect(bar).toContain("position: fixed");
    expect(bar).toContain("height: 84px");
    expect(bar).toContain("background: var(--backgroundInverted, #211C16)");
    expect(bar).toContain("bottom: var(--consumer-bottom-nav-height, 0px)");
    expect(ruleIn(narrow, ".event-sticky-bar__figure")).toContain(
      "color: var(--colorInverted, #FDFAF3)",
    );

    // Wide: the light rungs, the band under rows 1-2 only, the fade in row 3.
    const wide = mediaBlock("(min-width: 768px)");
    expect(ruleIn(wide, ".event-sticky-bar")).toContain("display: none");
    expect(ruleIn(wide, ".event-page-split--immersive")).toContain(
      "--hero-ink: var(--onStructure, #FDFAF3)",
    );
    const band = ruleIn(wide, ".event-page-split__band");
    expect(band).toContain("grid-row: 1 / 3");
    expect(band).toContain("rgba(0, 0, 0, 0.62)");
    expect(band).not.toContain("transparent");
    const fade = ruleIn(wide, ".event-page-split__fade");
    expect(fade).toContain("grid-row: 3");
    expect(fade).toContain("var(--background, #F6F0E4) 100%");
    // The last line of light text is 24px of solid band above the fade.
    expect(ruleIn(wide, ".event-page-split__sheet")).toContain("padding: 0 0 24px");
    // The card straddles: a paper surface with the ink frame, on top.
    const buy = ruleIn(wide, ".event-buy-band");
    expect(buy).toContain("border: 2px solid var(--borderColor, #211C16)");
    expect(buy).toContain("background: var(--surface, #FDFAF3)");
    expect(buy).toContain("z-index: 1");
    // The poster gets its frame wide only.
    expect(ruleIn(wide, ".event-page-split .event-hero-poster-frame")).toContain(
      "border: 2px solid var(--borderColor, #211C16)",
    );
  });
});

// ── The buy affordance, and the heading ladder (2026-09-02) ───────────────
// Both were measured broken on a live page before this: the only Get-tickets
// button sat 1,452px down a 2,254px page while the hero quoted the price, and
// the five numbered sections rendered as <span>s, leaving the page with two
// headings — the h1 and an unrelated "Welcome".
describe("EventContent — buy affordance placement", () => {
  const withTickets = {
    title: "Test Event",
    ctaLabel: "Get tickets",
    ctaHref: "/events/checkout/test-event",
  };

  it("puts a buy button in the hero, beside the price", () => {
    render(<EventContent {...withTickets} />);

    expect(screen.getByTestId("event-hero-get-tickets-btn")).toBeInTheDocument();
  });

  it("keeps the body button too, for a reader who scrolled", () => {
    render(<EventContent {...withTickets} startsAt="2027-01-01T20:00:00.000Z" />);

    const hero = screen.getByTestId("event-hero-get-tickets-btn");
    const body = screen.getByTestId("event-get-tickets-btn");
    // Distinct nodes, hero first — not one button rendered twice.
    expect(hero).not.toBe(body);
    expect(
      hero.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still sells an event with no schedule, location or lineup", () => {
    // The BODY button lives inside the logistics block, so an event carrying
    // none of that renders only the hero one. Pinned because before the hero
    // button existed this combination produced a ticketed page with no way to
    // buy at all — the same failure the floating bar's deletion caused once.
    render(<EventContent {...withTickets} />);

    expect(screen.getByTestId("event-hero-get-tickets-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("event-get-tickets-btn")).toBeNull();
  });

  it("offers no buy affordance on an RSVP listing", () => {
    render(<EventContent {...withTickets} rsvpAction={<button>RSVP</button>} />);

    expect(screen.queryByTestId("event-hero-get-tickets-btn")).toBeNull();
    expect(screen.queryByTestId("event-get-tickets-btn")).toBeNull();
  });

  it("offers none without an href to send the buyer to", () => {
    render(<EventContent title="Test Event" ctaLabel="Get tickets" />);

    expect(screen.queryByTestId("event-hero-get-tickets-btn")).toBeNull();
    expect(screen.queryByTestId("event-get-tickets-btn")).toBeNull();
  });
});

describe("EventContent — heading ladder", () => {
  it("renders section titles as real h2s", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt="2027-01-01T20:00:00.000Z"
        location="The Chapel"
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.length).toBeGreaterThan(0);
  });
});

describe("EventContent — organizer badge visibility (FR-003)", () => {
  it("renders 'Presented by {name}' as a link when organizerHref is provided", () => {
    render(
      <EventContent
        title="Test Event"
        organizerName="Brooklyn Promotions"
        organizerHref="/orgs/brooklyn-promotions"
      />,
    );

    const badge = screen.getByTestId("event-organizer-badge");
    expect(badge).toHaveTextContent("Presented by Brooklyn Promotions");
    const link = screen.getByRole("link", {
      name: "Presented by Brooklyn Promotions",
    });
    expect(link).toHaveAttribute("href", "/orgs/brooklyn-promotions");
  });

  it("renders as plain text (no link) when organizerHref is absent", () => {
    render(
      <EventContent title="Test Event" organizerName="Brooklyn Promotions" />,
    );

    const badge = screen.getByTestId("event-organizer-badge");
    expect(badge).toHaveTextContent("Presented by Brooklyn Promotions");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not render when organizerName is null", () => {
    render(
      <EventContent
        title="Test Event"
        organizerName={null}
        organizerHref="/orgs/brooklyn-promotions"
      />,
    );

    expect(
      screen.queryByTestId("event-organizer-badge"),
    ).not.toBeInTheDocument();
  });

  it("does not render when organizerName is omitted", () => {
    render(<EventContent title="Test Event" />);

    expect(
      screen.queryByTestId("event-organizer-badge"),
    ).not.toBeInTheDocument();
  });
});

// `placeSlug` is the venue's ENTITY PAGE slug (flat `{name}-{id8}`) — the only
// value the single-segment `/places/[slug]` route resolves on. It is NOT
// `Place.slug`, a multi-segment directory key (`us/ca/x--a1b2c3d4e5`) whose
// literal `/` the route cannot match. Fixtures below use the real page-slug
// shape so nobody reads a bare `the-greek-theatre` and concludes either slug
// would do.
describe("EventContent — venue badge on the attribution row", () => {
  it("renders 'At {venue}' linking to the venue page beside the organizer badge", () => {
    render(
      <EventContent
        title="Test Event"
        organizerName="Brooklyn Promotions"
        organizerHref="/orgs/brooklyn-promotions"
        placeSlug="the-greek-theatre-a1b2c3d4"
        venueName="Greek Theatre"
      />,
    );

    expect(screen.getByTestId("event-organizer-badge")).toBeInTheDocument();
    const badge = screen.getByTestId("event-venue-badge");
    expect(badge).toHaveTextContent("At Greek Theatre");
    const link = screen.getByRole("link", { name: "At Greek Theatre" });
    expect(link).toHaveAttribute("href", "/places/the-greek-theatre-a1b2c3d4");
  });

  it("renders alone when there is no organizer (ownerless COMMUNITY listing)", () => {
    render(
      <EventContent
        title="Test Event"
        placeSlug="the-greek-theatre-a1b2c3d4"
        venueName="Greek Theatre"
      />,
    );

    expect(
      screen.queryByTestId("event-organizer-badge"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("event-venue-badge")).toHaveTextContent(
      "At Greek Theatre",
    );
  });

  // NAME and LINK are separate gates (see build-event-seo.ts). A confirmed,
  // directory-listed venue with no EntityPage — every bulk-imported one — has
  // no page to link to, but is still a real named venue. It used to lose the
  // badge entirely.
  it("renders the badge WITHOUT a link when there is no placeSlug", () => {
    render(
      <EventContent
        title="Test Event"
        organizerName="Brooklyn Promotions"
        venueName="Some Warehouse"
      />,
    );

    const badge = screen.getByTestId("event-venue-badge");
    expect(badge).toHaveTextContent("At Some Warehouse");
    // The name is there; it just is not clickable.
    expect(
      screen.queryByRole("link", { name: "At Some Warehouse" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("event-venue-name-plain"),
    ).toBeInTheDocument();
  });

  it("renders the badge alone (no organizer) even without a placeSlug", () => {
    render(<EventContent title="Test Event" venueName="Some Warehouse" />);

    expect(screen.getByTestId("event-venue-badge")).toHaveTextContent(
      "At Some Warehouse",
    );
    expect(
      screen.queryByTestId("event-organizer-badge"),
    ).not.toBeInTheDocument();
  });

  it("keeps the 'Confirmed by the place' mark on an unlinked badge", () => {
    render(
      <EventContent
        title="Test Event"
        venueName="Some Warehouse"
        venueConfirmed
      />,
    );

    const badge = screen.getByTestId("event-venue-badge");
    expect(badge).toContainElement(
      screen.getByTestId("event-venue-confirmed"),
    );
    expect(
      screen.queryByRole("link", { name: "At Some Warehouse" }),
    ).not.toBeInTheDocument();
  });

  it("the location section's 'View place page' CTA still REQUIRES a placeSlug", () => {
    // Unlike the badge, this one promises a page. Without a slug there is no
    // page to view, so it must stay hidden rather than become dead text.
    render(
      <EventContent
        title="Test Event"
        venueName="Some Warehouse"
        address="123 Harbor Blvd"
      />,
    );

    expect(
      screen.queryByTestId("event-location-venue-link"),
    ).not.toBeInTheDocument();
  });

  it("does not render without a venue name, even with a placeSlug", () => {
    // The NAME is what the badge is; a slug alone has nothing to label.
    render(<EventContent title="Test Event" placeSlug="the-greek-theatre-a1b2c3d4" />);

    expect(screen.queryByTestId("event-venue-badge")).not.toBeInTheDocument();
  });
});

// ── Venue confirmation (docs/specs/2026-08-27) ───────────────────────────
// "Confirmed by the place" is a mark INSIDE the venue badge, never a gate. The
// server nulls `placeSlug` / `name` on an unconfirmed event, so address-only
// must render byte-for-byte like an event with no platform venue.
describe("EventContent — 'Confirmed by the place' mark", () => {
  it("renders the mark inside the venue badge when the venue confirmed", () => {
    render(
      <EventContent
        title="Test Event"
        placeSlug="the-greek-theatre-a1b2c3d4"
        venueName="Greek Theatre"
        venueConfirmed
      />,
    );

    const badge = screen.getByTestId("event-venue-badge");
    const mark = screen.getByTestId("event-venue-confirmed");
    expect(badge).toContainElement(mark);
    expect(mark).toHaveTextContent("Confirmed by the place");
    // The venue link is unchanged and the mark is not part of its name.
    expect(screen.getByRole("link", { name: "At Greek Theatre" })).toHaveAttribute(
      "href",
      "/places/the-greek-theatre-a1b2c3d4",
    );
  });

  it("the badge shrinks and its row wraps, so the mark drops under a long venue name instead of widening the page (measured 320px overflow)", () => {
    for (const immersiveHero of [false, true]) {
      const { unmount } = render(
        <EventContent
          title="Test Event"
          placeSlug="the-paramount-theatre-0f1e2d3c"
          venueName="The Paramount Theatre"
          venueConfirmed
          immersiveHero={immersiveHero}
        />,
      );
      const badge = screen.getByTestId("event-venue-badge");
      expect(badge).toHaveAttribute("data-flex-shrink", "1");
      expect(badge).toHaveAttribute("data-min-width", "0");
      const row = badge.firstElementChild as HTMLElement;
      expect(row).toHaveAttribute("data-flex-wrap", "wrap");
      // Load-bearing: a wrapping row that cannot shrink never wraps.
      expect(row).toHaveAttribute("data-flex-shrink", "1");
      expect(row).toHaveAttribute("data-min-width", "0");
      expect(row).toContainElement(screen.getByTestId("event-venue-confirmed"));
      // The link is the shrinking item: it may ellipsise, never overflow.
      const link = screen.getByRole("link", { name: "At The Paramount Theatre" });
      // jsdom serialises `minWidth: 0` inconsistently ("0" vs "0px");
      // read the inline declaration directly.
      expect(link.style.overflow).toBe("hidden");
      expect(link.style.minWidth).toMatch(/^0(px)?$/);
      expect(link.style.flexShrink).toBe("1");
      unmount();
    }
  });

  it("omits the mark when the venue has not confirmed (default)", () => {
    render(
      <EventContent
        title="Test Event"
        placeSlug="the-greek-theatre-a1b2c3d4"
        venueName="Greek Theatre"
      />,
    );

    expect(screen.getByTestId("event-venue-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("event-venue-confirmed")).not.toBeInTheDocument();
  });

  it("address-only renders exactly like a no-venue event — even with the flag set and no venue fields (the leak that could happen)", () => {
    // The unconfirmed case as the server actually sends it: no placeSlug, no
    // name. Then the same page with venueConfirmed=true but STILL no venue
    // fields — the flag must add nothing on its own.
    const noVenue = (
      <EventContent
        title="Test Event"
        organizerName="Brooklyn Promotions"
        address="123 Harbor Blvd, San Francisco, CA 94111"
      />
    );
    const flagWithoutVenue = (
      <EventContent
        title="Test Event"
        organizerName="Brooklyn Promotions"
        address="123 Harbor Blvd, San Francisco, CA 94111"
        venueConfirmed
      />
    );

    const { container: a, unmount } = render(noVenue);
    const noVenueHtml = a.innerHTML;
    expect(screen.queryByTestId("event-venue-badge")).not.toBeInTheDocument();
    unmount();

    const { container: b } = render(flagWithoutVenue);
    expect(screen.queryByTestId("event-venue-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("event-venue-confirmed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("event-location-venue-link")).not.toBeInTheDocument();
    expect(b.innerHTML).toBe(noVenueHtml);
  });
});

describe("EventContent — refund policy display logic (FR-004)", () => {
  // `startsAt` is required so `hasLogistics` is true and the logistics
  // block (which the refund-policy section lives in) renders at all.
  //
  // The real enforced deadline is `refundCutoffAt ?? startsAt` (an absolute
  // datetime — see get-refund-eligibility.ts), NOT an hours-before-event
  // window. `refundCutoffAt` is:
  //   - omitted (undefined): hidden entirely (RSVP/community — no ticketing)
  //   - null: no organizer override -> "until this event starts"
  //   - an ISO datetime earlier than startsAt: organizer's custom cutoff
  const startsAt = "2027-01-01T18:00:00.000Z";

  it("shows the 'until this event starts' message when refundCutoffAt is null (no organizer override)", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        refundCutoffAt={null}
      />,
    );

    const section = screen.getByTestId("event-refund-policy-section");
    expect(section).toHaveTextContent(
      "Full refund available until this event starts.",
    );
  });

  it("shows the 'until {date}' message when refundCutoffAt is an organizer-set datetime earlier than startsAt", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        refundCutoffAt="2026-12-30T00:00:00.000Z"
      />,
    );

    const section = screen.getByTestId("event-refund-policy-section");
    // `useFormatters().dateTime` is mocked to a fixed string above — the
    // formatting itself is covered by the shared date-display code path.
    expect(section).toHaveTextContent(
      "Full refund available until Sat, Jan 1, 2027.",
    );
  });

  it("falls back to the 'until this event starts' message when refundCutoffAt is not earlier than startsAt", () => {
    // Defensive fallback: the org UI only ever sets an *earlier* cutoff, but
    // if a cutoff at/after startsAt ever showed up we must not fabricate a
    // date-based claim that could understate the buyer's actual rights.
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        refundCutoffAt="2027-01-01T18:00:00.000Z"
      />,
    );

    const section = screen.getByTestId("event-refund-policy-section");
    expect(section).toHaveTextContent(
      "Full refund available until this event starts.",
    );
  });

  it("hides the section when refundCutoffAt is omitted (RSVP/community — no ticketing)", () => {
    render(<EventContent title="Test Event" startsAt={startsAt} />);

    expect(
      screen.queryByTestId("event-refund-policy-section"),
    ).not.toBeInTheDocument();
  });
});

describe("EventContent — obscured-circle map (location-visibility-reveal FR-002)", () => {
  // `startsAt` is required so `hasLogistics` is true and the logistics block
  // (which the map column lives in) renders at all.
  const startsAt = "2027-01-01T18:00:00.000Z";

  /** Server-redacted obscured-circle variant (redactLocation): offset point + radius. */
  const OBSCURED_COORDS = {
    latitude: 40.7484,
    longitude: -73.9856,
    isExact: false,
    radiusMeters: 800,
    areaLabel: "Midtown Manhattan",
  };

  const EXACT_COORDS = {
    latitude: 37.8738,
    longitude: -122.2543,
    label: "Greek Theatre",
    isExact: true,
  };

  it("renders the map (radius circle) for obscured coords, with NO directions", () => {
    render(
      <EventContent
        title="Secret Rooftop Sessions"
        startsAt={startsAt}
        location="Midtown, NYC"
        locationCoords={OBSCURED_COORDS}
      />,
    );

    // Map container renders pre-reveal (the circle itself is drawn by the
    // dynamically-imported LocationMapPreview, mocked out in jsdom) …
    expect(
      screen.getByTestId("event-location-map-container"),
    ).toBeInTheDocument();
    // … but there is nothing to navigate to, so no directions affordances.
    expect(
      screen.queryByTestId("event-location-directions"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-location-directions-desktop"),
    ).not.toBeInTheDocument();
  });

  it("passes preObfuscated=true to the map for public obscured coords (server-redacted centre — no double jitter)", () => {
    render(
      <EventContent
        title="Secret Rooftop Sessions"
        startsAt={startsAt}
        location="Midtown, NYC"
        locationCoords={OBSCURED_COORDS}
      />,
    );

    const mapCalls = getMapPreviewCalls();
    expect(mapCalls.length).toBeGreaterThan(0);
    for (const props of mapCalls) {
      expect(props).toMatchObject({
        latitude: OBSCURED_COORDS.latitude,
        longitude: OBSCURED_COORDS.longitude,
        isExact: false,
        radiusMeters: OBSCURED_COORDS.radiusMeters,
        preObfuscated: true,
      });
    }
  });

  it("passes preObfuscated=false in admin preview (TRUE coords — map applies its own client-side jitter)", () => {
    // The admin builder feeds the REAL venue coordinates with isExact:false;
    // the map component's own jitter is what keeps the centre unrevealed.
    render(
      <EventContent
        title="Secret Rooftop Sessions"
        startsAt={startsAt}
        location="Midtown, NYC"
        locationCoords={OBSCURED_COORDS}
        isAdminPreview
      />,
    );

    const mapCalls = getMapPreviewCalls();
    expect(mapCalls.length).toBeGreaterThan(0);
    for (const props of mapCalls) {
      expect(props).toMatchObject({ preObfuscated: false });
    }
  });

  it("passes preObfuscated=false for exact public coords", () => {
    render(
      <EventContent
        title="Greek Theatre Under the Stars"
        startsAt={startsAt}
        location="Berkeley, CA"
        locationCoords={EXACT_COORDS}
      />,
    );

    const mapCalls = getMapPreviewCalls();
    expect(mapCalls.length).toBeGreaterThan(0);
    for (const props of mapCalls) {
      expect(props).toMatchObject({ isExact: true, preObfuscated: false });
    }
  });

  it("does not link the location text to a maps URL for obscured coords", () => {
    render(
      <EventContent
        title="Secret Rooftop Sessions"
        startsAt={startsAt}
        location="Midtown, NYC"
        locationCoords={OBSCURED_COORDS}
      />,
    );

    // The location string renders in the meta row and the location section;
    // neither occurrence may link out — the obfuscated point isn't the venue.
    // (The @th/ui Text mock drops data-testid, so assert on the text itself.)
    for (const el of screen.getAllByText("Midtown, NYC")) {
      expect(el.closest("a")).toBeNull();
    }
  });

  it("still renders map + directions for exact coords (unchanged)", () => {
    render(
      <EventContent
        title="Greek Theatre Under the Stars"
        startsAt={startsAt}
        location="Berkeley, CA"
        locationCoords={EXACT_COORDS}
      />,
    );

    expect(
      screen.getByTestId("event-location-map-container"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("event-location-directions-desktop"),
    ).toBeInTheDocument();
  });

  /**
   * LEAK TEST — an event AT A WITHHELD VENUE (place-address-withholding).
   *
   * The venue ceiling forces such an event to `(OBSCURED, radius null)`, which
   * `redactLocation` renders as the fully-hidden shape. The case below is the
   * one a partial projection can still produce: a caller that has coordinates
   * in hand AND a null radius. There is no circle to draw and no pin to place,
   * so the answer is no map — and the `radiusMeters != null` half of
   * `showableLocationCoords` is what enforces it.
   */
  it("renders no map, no directions and no copy-address when the venue withholds (radius null WITH coords)", () => {
    const { container } = render(
      <EventContent
        title="Show at the Bat Cave"
        startsAt={startsAt}
        location="East Nashville"
        locationCoords={{
          latitude: 36.1789,
          longitude: -86.7412,
          isExact: false,
          radiusMeters: null,
          areaLabel: "East Nashville",
        }}
      />,
    );

    expect(
      screen.queryByTestId("event-location-map-container"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-location-directions"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-location-directions-desktop"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Copy address")).toBeNull();

    // And nothing routable anywhere in the rendered subtree.
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(
        /google\.[^/]+\/maps|maps\.apple\.com|waze\.com/i,
      );
    }
  });

  /**
   * The SHAPE `EventDetail` actually sends for a fully-hidden event: NO
   * `locationCoords` at all (there are no coordinates to send), plus
   * `locationIsExact={false}`.
   *
   * This is the case the coords block cannot answer — with `locationCoords`
   * undefined, a fully-hidden event is byte-identical to an ordinary event
   * whose address was never geocoded. It kept a "Copy address" button that
   * copied the coarse area label, which is why the explicit flag exists.
   */
  it("renders no copy-address control and no maps link for a fully hidden event", () => {
    const { container } = render(
      <EventContent
        title="Show at the Bat Cave"
        startsAt={startsAt}
        location="East Nashville"
        locationIsExact={false}
      />,
    );

    expect(
      screen.queryByTestId("event-location-map-container"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Copy address")).toBeNull();
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(
        /google\.[^/]+\/maps|maps\.apple\.com|waze\.com/i,
      );
    }
  });

  it("keeps the copy-address control for an exact event with no coordinates", () => {
    // The default is deliberately OPEN for callers that send no privacy
    // signal at all — closing it would strip this control from every ordinary
    // event that has an address but was never geocoded.
    render(
      <EventContent
        title="Ordinary Show"
        startsAt={startsAt}
        location="123 Harbor Blvd, San Francisco, CA"
      />,
    );
    expect(screen.getAllByText("Copy address").length).toBeGreaterThan(0);
  });

  it("renders no map at all without coordinates (fully-hidden variant)", () => {
    // redactLocation's fully-hidden shape has no lat/lng, so callers never
    // build a locationCoords prop — area label text only.
    render(
      <EventContent
        title="Undisclosed Loft Session"
        startsAt={startsAt}
        location="Bushwick, Brooklyn"
      />,
    );

    expect(
      screen.queryByTestId("event-location-map-container"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-location-directions"),
    ).not.toBeInTheDocument();
  });
});

// ── Known coverage gap (not introduced or fixed by this change) ────────────
// The deleted apps/web/src/components/events/__tests__/competitive-ux-features.test.ts
// had a "Waitlist CTA state machine" describe block asserting on an
// `onJoinWaitlist` callback / sold-out-gating state machine. That logic does
// not exist in the real `WaitlistJoinForm.tsx` (it has no `onJoinWaitlist`
// prop and no sold-out gating) — those tests were asserting on fictional,
// never-shipped behavior, so they were deliberately not ported here.
// `WaitlistJoinForm.tsx` currently has ZERO test coverage; that's a
// pre-existing gap, not something introduced by this pass.

// ── `waitlists` feature gate ───────────────────────────────────────────────
// The public join affordance is behind the default-OFF `waitlists` gate: only
// the join half of waitlists exists (nothing ever sets `NOTIFIED`, and there
// is no release trigger, job, or admin roster), so the form must not render
// while the gate is off — not even disabled.
describe("EventContent — waitlist join form behind the `waitlists` gate", () => {
  it("does not render the join form when the gate is off", () => {
    mockGates = { waitlists: false };
    render(
      <EventContent
        title="Test Event"
        eventId="evt_1"
        waitlistOpen
        waitlistDescription="We'll let you know."
      />,
    );

    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("fails closed while the gates are still loading (undefined)", () => {
    mockGates = undefined;
    render(<EventContent title="Test Event" eventId="evt_1" waitlistOpen />);

    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("renders the join form when the gate is on and the waitlist is open", () => {
    mockGates = { waitlists: true };
    render(<EventContent title="Test Event" eventId="evt_1" waitlistOpen />);

    expect(screen.getByTestId("waitlist-join-form")).toBeInTheDocument();
  });

  it("still hides the join form when the gate is on but the waitlist is closed", () => {
    mockGates = { waitlists: true };
    render(
      <EventContent title="Test Event" eventId="evt_1" waitlistOpen={false} />,
    );

    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });
});

// ── Get-tickets CTA ────────────────────────────────────────────────────────
// `event-get-tickets-btn` is the ONLY buy affordance on the event page. It
// used to live in the floating contextual action bar; when that bar was
// removed (2026-08-27) `ctaLabel`/`ctaHref` were briefly passed in and
// silently dropped, leaving the page with no way to buy at all. Until now the
// control was covered by e2e only (checkout-journey, checkout-to-settlement,
// public-series-date-overlay) — nothing here asserted it existed.
//
// The single-element assertions are not decoration: the bar's `ActionBarCTA`
// alias map put `event-get-tickets-btn` on a second element, which broke
// Playwright's strict-mode locators. A duplicate must fail loudly.
describe("EventContent — get-tickets CTA", () => {
  // The CTA lives inside the logistics block, so `hasLogistics` must be true;
  // `startsAt` is the cheapest way to satisfy it (same trick the refund-policy
  // block above uses). NOTE: `ctaHref`/`ctaLabel` do NOT themselves make
  // `hasLogistics` true — an event with a CTA and no schedule, location,
  // lineup, RSVP or community attribution renders no CTA at all.
  const startsAt = "2027-01-01T18:00:00.000Z";

  it("renders a navigating Link when no onCtaPress is supplied", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Get tickets"
        ctaHref="/events/checkout/evt_1"
      />,
    );

    const cta = screen.getByTestId("event-get-tickets-btn");
    expect(cta).toHaveTextContent("Get tickets");
    // The anchor — not the button — owns navigation in this branch.
    expect(cta.closest("a")).toHaveAttribute("href", "/events/checkout/evt_1");
  });

  it("renders exactly one CTA in the Link branch", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Get tickets"
        ctaHref="/events/checkout/evt_1"
      />,
    );

    expect(screen.getAllByTestId("event-get-tickets-btn")).toHaveLength(1);
  });

  it("calls onCtaPress instead of navigating when the handler is supplied (series-date-picker path)", () => {
    const onCtaPress = vi.fn();
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Get tickets"
        ctaHref="/events/checkout/evt_1"
        onCtaPress={onCtaPress}
      />,
    );

    const cta = screen.getByTestId("event-get-tickets-btn");
    // No anchor wraps it: pressing opens the date overlay, it must not
    // navigate straight to a single date's checkout.
    expect(cta.closest("a")).toBeNull();

    fireEvent.click(cta);
    expect(onCtaPress).toHaveBeenCalledTimes(1);
  });

  it("renders exactly one CTA in the onCtaPress branch", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Get tickets"
        ctaHref="/events/checkout/evt_1"
        onCtaPress={() => {}}
      />,
    );

    expect(screen.getAllByTestId("event-get-tickets-btn")).toHaveLength(1);
  });

  // es shows the short "Entradas", which is also the bottom nav's my-tickets
  // tab; the buy control takes the longer name, which contains the visible
  // text (WCAG 2.5.3, label in name).
  it("names the Link-branch CTA from ctaAriaLabel and keeps the short label visible", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Entradas"
        ctaAriaLabel="Obtener entradas"
        ctaHref="/events/checkout/evt_1"
      />,
    );

    const cta = screen.getByTestId("event-get-tickets-btn");
    expect(cta).toHaveTextContent("Entradas");
    expect(
      screen.getAllByRole("link", { name: "Obtener entradas" }),
    ).toContain(cta.closest("a"));
    expect(screen.queryAllByRole("link", { name: "Entradas" })).toHaveLength(0);
  });

  it("names the onCtaPress-branch CTA from ctaAriaLabel", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Entradas"
        ctaAriaLabel="Obtener entradas"
        ctaHref="/events/checkout/evt_1"
        onCtaPress={() => {}}
      />,
    );

    const cta = screen.getByTestId("event-get-tickets-btn");
    expect(cta).toHaveTextContent("Entradas");
    expect(
      screen.getAllByRole("button", { name: "Obtener entradas" }),
    ).toContain(cta);
  });

  it("renders no CTA without both a label and an href", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaHref="/events/checkout/evt_1"
      />,
    );

    expect(
      screen.queryByTestId("event-get-tickets-btn"),
    ).not.toBeInTheDocument();
  });

  it("renders no CTA on an RSVP listing — the RSVP action is the only affordance there", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt={startsAt}
        ctaLabel="Get tickets"
        ctaHref="/events/checkout/evt_1"
        rsvpAction={<span data-testid="rsvp-action">RSVP</span>}
      />,
    );

    expect(screen.getByTestId("rsvp-action")).toBeInTheDocument();
    expect(
      screen.queryByTestId("event-get-tickets-btn"),
    ).not.toBeInTheDocument();
  });
});


// ── The TICKETED / default layout's reading order (2026-09-22) ────────
// The organiser's own description of the show leads the body; the numbered
// logistics block (schedule, location, lineup, tickets, refund) follows it as
// reference material. Pinned because the move is a DOM move, not a CSS
// `order` one — the same Level-A reason the community block below states:
// keyboard focus and screen-reader order have to match what the page paints
// (WCAG 1.3.2 and 2.4.3).
describe("EventContent — ticketed layout reading order", () => {
  const ticketed = {
    title: "Standup Comedy Open Mic",
    startsAt: "2026-09-14T01:30:00.000Z",
    endsAt: "2026-09-14T04:00:00.000Z",
    timezone: "America/Chicago",
    location: "Nashville, TN",
    address: "115 27th Ave N, Nashville, TN 37203",
    bodyHtml: "<p data-testid='body-prose'>Produced by Cameron Gumpy.</p>",
  };

  it("renders the prose BEFORE the numbered logistics block", () => {
    const { container } = render(<EventContent {...ticketed} />);

    const prose = screen.getByTestId("body-prose");
    const logistics = container.querySelector(
      ".event-content-logistics",
    ) as HTMLElement | null;
    const location = screen.getByTestId("event-location-section");

    expect(logistics).not.toBeNull();
    // Document position, not an index into `container.textContent`: the prose
    // has to precede the logistics in the DOM ITSELF, which is what Tab order
    // and a screen reader walk. A textContent index would also pass for a
    // block moved only with CSS.
    for (const later of [logistics!, location]) {
      expect(
        prose.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        later.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    }
  });

  it("does not renumber the sections when the prose sits above them", () => {
    render(<EventContent {...ticketed} />);

    // The "0N." labels come from the visibility flags, not from DOM order, so
    // the unnumbered prose must not consume 01. Schedule and Location are the
    // only two visible numbered sections for this fixture.
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.queryByText("03")).toBeNull();
  });
});


// ── The COMMUNITY listing layout (2026-09-12) ─────────────────────────────
// Measured on a 390x844 phone against the seeded
// `standup-comedy-open-mic-at-springwater-…` listing: 3,151px tall, with the
// event's own prose starting at 2,188px — 69% of the way down, behind a 259px
// date graphic that said only "SUN 13 SEP" (and said it to nobody: it is
// aria-hidden), an <h1>, a meta row restating the date and city, "01 Schedule"
// whose only content was an end time, "02 Location" whose content was an
// address, and a moderator recruitment band.
//
// Every assertion below is scoped to `communityLayout`. The ticketed path is
// held byte-identical by a separate check; here the guards are the ones that
// would catch a regression IN this branch.
describe("EventContent — COMMUNITY listing layout", () => {
  const community = {
    title: "Standup Comedy Open Mic at Springwater",
    // 01:30 UTC on the 14th is 20:30 on the 13th in Chicago.
    startsAt: "2026-09-14T01:30:00.000Z",
    endsAt: "2026-09-14T04:00:00.000Z",
    timezone: "America/Chicago",
    venueName: "Springwater Supper Club Lounge",
    location: "Nashville, TN",
    address: "115 27th Ave N, Nashville, TN 37203",
    placeSlug: "springwater-supper-club-a1b2c3d4",
    bodyHtml: "<p data-testid='body-prose'>Produced by Cameron Gumpy.</p>",
    rsvpSectionTitle: "Upcoming dates",
    communityLayout: true,
    locationCoords: {
      latitude: 36.1521,
      longitude: -86.8025,
      label: "Springwater Supper Club Lounge",
      isExact: true,
    },
  };

  const renderCommunity = (overrides: Record<string, unknown> = {}) =>
    render(
      <EventContent
        {...community}
        rsvpAction={<div data-testid="rsvp-dates">dates</div>}
        communityAttribution={<div data-testid="community-byline">byline</div>}
        communityFooter={<div data-testid="moderator-band">apply</div>}
        {...overrides}
      />,
    );

  /** The WHEN row's key and value, as rendered. */
  const whenKey = () =>
    screen
      .getByTestId("community-fact-when")
      .querySelector(".community-facts__key")?.textContent;
  const whenValue = () =>
    screen
      .getByTestId("community-fact-when")
      .querySelector(".community-facts__value")?.textContent ?? "";

  /** True when the node or any ancestor is hidden from assistive tech. */
  const inAriaHiddenSubtree = (node: HTMLElement | null) => {
    for (let el = node; el; el = el.parentElement) {
      const value = el.getAttribute("aria-hidden");
      if (value === "true" || value === "") return true;
    }
    return false;
  };

  it("has exactly ONE h1, it is the event title, and it is announceable", () => {
    renderCommunity();

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(
      "Standup Comedy Open Mic at Springwater",
    );
    // The Date Stub is aria-hidden by design. Promoting it to the page head
    // is only safe if the title did NOT ride into that subtree with it.
    expect(inAriaHiddenSubtree(headings[0] as HTMLElement)).toBe(false);
    // And the title is printed once, not once in the stub and once below it —
    // the four-lines-two-facts failure this whole change exists to undo.
    expect(
      screen.getAllByText("Standup Comedy Open Mic at Springwater"),
    ).toHaveLength(1);
  });

  it("puts the date in the accessibility tree as prose, and the time above the title", () => {
    renderCommunity();

    // "SUN", "13", "SEP" as three tracked fragments is worse than useless
    // spoken aloud, so the panel is a role=img with the whole date as its name.
    const panel = screen.getByTestId("community-head-date");
    expect(panel).toHaveAttribute("role", "img");
    expect(panel).toHaveAttribute("aria-label", "Sunday, September 13, 2026");
    // The graphic itself still renders — in the VENUE's zone (UTC would read
    // MON 14 SEP), and at the `lg` ramp, not the full-bleed hero's `xl`.
    const stub = screen.getByTestId("event-hero-date-stub");
    expect(panel).toContainElement(stub);
    expect(stub.dataset.stubDate).toBe(
      JSON.stringify({ weekday: "SUN", day: "13", month: "SEP" }),
    );
    expect(stub.dataset.stubSize).toBe("lg");

    // The time is NOT in the panel's label — it is real text, so each of the
    // two facts is announced exactly once.
    expect(screen.getByTestId("community-head-time")).toHaveTextContent(
      "8:30 PM",
    );
    expect(panel.getAttribute("aria-label")).not.toContain("8:30");
  });

  it("labels the head's time with a visible key, spoken once", () => {
    renderCommunity();

    const time = screen.getByTestId("community-head-time");
    // Owner 2026-10-17: the key is printed, not visually hidden. Key and
    // value are separate elements so the value can carry the ink.
    const key = time.querySelector(".community-head__time-key");
    const value = time.querySelector(".community-head__time-value");
    // The mock translator echoes keys, so "Starts" reads as its key here.
    expect(key).toHaveTextContent(/^eventDetail\.scheduleStarts$/);
    expect(value).toHaveTextContent(/^8:30 PM$/);
    // One real space between them — no glyph for a screen reader to speak,
    // and no run-together "Starts8:30 PM". Only the no-break spaces ICU may
    // put inside "8:30 PM" (U+00A0 / U+202F) are normalised, so the separator
    // between key and value still has to be an ASCII space to pass.
    expect(time.textContent?.replace(/[\u00A0\u202F]/g, " ")).toBe(
      "eventDetail.scheduleStarts 8:30 PM",
    );
    // And no sr-only copy left behind to announce the key a second time.
    expect(time.querySelector(".sr-only")).toBeNull();
  });

  it("prints the time alone when the caller passes no key", () => {
    render(
      <CommunityListingHead
        title="Open Mic"
        dateParts={{ weekday: "SUN", day: "13", month: "SEP" }}
        dateLabel="Sunday, September 13, 2026"
        timeLabel="8:30 PM"
      />,
    );

    const time = screen.getByTestId("community-head-time");
    expect(time.textContent).toBe("8:30 PM");
    expect(time.querySelector(".community-head__time-key")).toBeNull();
  });

  it("drops the separate <h1> + attribution + meta stack, since the head states all of it", () => {
    renderCommunity();

    expect(screen.getByTestId("community-listing-head")).toBeInTheDocument();
    expect(screen.getByTestId("community-head-venue")).toHaveTextContent(
      "Springwater Supper Club Lounge · Nashville, TN",
    );
    // The badges and the meta row are what used to restate all of this.
    expect(screen.queryByTestId("event-venue-badge")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-organizer-badge"),
    ).not.toBeInTheDocument();
    // The venue name is a link to its page — the affordance the old badge and
    // the old "View place page" CTA both carried.
    expect(
      screen.getByRole("link", { name: "Springwater Supper Club Lounge" }),
    ).toHaveAttribute("href", "/places/springwater-supper-club-a1b2c3d4");
  });

  it("reads in DOM order on a phone — description, facts, lineup, dates, map, band", () => {
    const { container } = renderCommunity();

    const at = (testId: string) => screen.getByTestId(testId);
    /*
     * This asserts READING order, and reading order here IS DOM order.
     *
     * The first cut of this layout put the fact block in a rail after the
     * dates and pulled it up visually with CSS `order`. That block holds the
     * address link, "View place page", copy-address and "Suggest an edit", so
     * a keyboard user tabbed off the description, skipped the facts, landed
     * in the RSVP toggles hundreds of pixels below, and the next Tab jumped
     * back UP — WCAG 1.3.2 and 2.4.3, both Level A. The layout now carries no
     * `order` rule at all, so this list is what a screen reader hears, what
     * Tab walks, and what a phone paints, in one sequence.
     */
    const order = [
      at("community-listing-head"),
      container.querySelector(".community-body__description") as HTMLElement,
      at("community-fact-block"),
      at("event-rsvp-section"),
      at("event-location-map-container"),
      at("moderator-band"),
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(order[i]).not.toBeNull();
      expect(
        order[i]!.compareDocumentPosition(order[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The prose really is the description, not an empty wrapper.
    expect(at("body-prose")).toHaveTextContent("Produced by Cameron Gumpy.");
    // The description leads the page body — the whole point of the change.
    // (It used to start 2,188px down a 3,151px page.)
    const bodyRoot = container.querySelector(".community-body") as HTMLElement;
    expect(bodyRoot.firstElementChild).toHaveClass("community-body__lead");
    expect(bodyRoot.firstElementChild!.firstElementChild).toBe(
      container.querySelector(".community-body__description"),
    );
  });

  it("carries NO CSS `order` rule — reading order may not be re-sorted by paint", () => {
    const { container } = renderCommunity();

    // The three tracks are the whole placement mechanism: `display: contents`
    // on a phone, explicit grid areas wide. If a future change reaches for
    // `order` again to move a block, it reintroduces the Level-A failure
    // above, so the structure is pinned here.
    const tracks = [...container.querySelectorAll(".community-body__track")];
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toHaveClass("community-body__lead");
    expect(tracks[1]).toHaveClass("community-body__rail");
    expect(tracks[2]).toHaveClass("community-body__rest");

    const css = readFileSync(
      resolve(__dirname, "../event-content.css"),
      "utf8",
    );
    // Strip comments first: this block's own prose explains why `order` is
    // banned here, and `border`/`border-top` contain the substring.
    const communityBlock = css
      .slice(css.indexOf(".community-body {"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const orderDecls = communityBlock.match(/(?<![-\w])order\s*:/g) ?? [];
    expect(orderDecls).toHaveLength(0);
  });

  it("keeps the rail short enough to pin: facts only, map in the wide track", () => {
    const { container } = renderCommunity();

    const at = (testId: string) => screen.getByTestId(testId);
    const rail = container.querySelector(
      ".community-body__rail",
    ) as HTMLElement;
    const rest = container.querySelector(
      ".community-body__rest",
    ) as HTMLElement;

    // Facts stick. The map, the directions dropdown and the calendar do NOT:
    // with all of them in the rail the pinned box ran ~690px, so on a 13"
    // laptop the last control sat off-screen the entire time it was stuck —
    // and a scroll container is not the fix, because the calendar menu opens
    // upward out of its own box and would be clipped.
    expect(rail).toContainElement(at("community-fact-block"));
    expect(rail).not.toContainElement(at("event-location-map-container"));
    expect(rest).toContainElement(at("event-location-map-container"));
    expect(rest).toContainElement(at("event-location-directions"));
  });

  it("collapses Schedule + Location into one WHERE / WHEN / LISTED BY fact block", () => {
    renderCommunity();

    const facts = screen.getByTestId("community-fact-block");
    expect(facts).toHaveTextContent("Where");
    expect(facts).toHaveTextContent("115 27th Ave N, Nashville, TN 37203");
    // 01:30 to 04:00 UTC Sep 14 is 8:30 to 11:00 PM Sep 13 in Chicago.
    expect(whenKey()).toBe("When");
    expect(whenValue()).toBe("Sunday, September 13, 2026, 8:30 – 11:00 PM");
    expect(facts).toHaveTextContent("Listed by");
    // The byline / suggest-edit / "how this works" node is REUSED, not rebuilt.
    expect(facts).toContainElement(screen.getByTestId("community-byline"));

    // The numbered sections they replace are gone.
    expect(
      screen.queryByTestId("event-location-section"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Schedule")).not.toBeInTheDocument();
  });

  it("drops the 01/02/03 index numerals — three facts are not a sequence", () => {
    renderCommunity();

    for (const numeral of ["01", "02", "03"]) {
      expect(screen.queryByText(numeral)).not.toBeInTheDocument();
    }
    // The one remaining heading in the body is the dates section, unnumbered.
    expect(screen.getByTestId("event-rsvp-section")).toHaveTextContent(
      "Upcoming dates",
    );
  });

  it("keeps the numerals on a TICKETED event", () => {
    render(
      <EventContent
        title="Test Event"
        startsAt="2027-01-01T20:00:00.000Z"
        location="The Chapel"
      />,
    );

    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.queryByTestId("community-listing-head")).toBeNull();
  });

  it("leaves the POSTER head exactly as it is — hero image, h1, badges, meta row", () => {
    renderCommunity({ heroImageUrl: "https://cdn.example.test/poster.jpg" });

    // No promoted stub: the immersive HeroBackdrop hero owns this case.
    expect(screen.queryByTestId("community-listing-head")).toBeNull();
    expect(screen.queryByTestId("event-hero-date-stub")).toBeNull();
    expect(screen.getByAltText("eventDetail.heroAlt")).toHaveAttribute(
      "src",
      "https://cdn.example.test/poster.jpg",
    );
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent("Standup Comedy Open Mic at Springwater");
    expect(screen.getByTestId("event-venue-badge")).toHaveTextContent(
      "At Springwater Supper Club Lounge",
    );
    // …but the BODY is still the community one.
    expect(screen.getByTestId("community-fact-block")).toBeInTheDocument();
  });

  it("still renders with no description, no end time and no coordinates", () => {
    renderCommunity({
      bodyHtml: undefined,
      endsAt: undefined,
      locationCoords: undefined,
    });

    expect(screen.getByTestId("community-listing-head")).toBeInTheDocument();
    // No end: the row is the start alone, under "Starts" (echoed key path).
    expect(whenKey()).toBe("eventDetail.scheduleStarts");
    expect(
      screen.queryByTestId("event-location-map-container"),
    ).not.toBeInTheDocument();
    // WHERE and LISTED BY survive, so the block is not empty.
    expect(screen.getByTestId("community-fact-where")).toBeInTheDocument();
    expect(screen.getByTestId("community-fact-listed-by")).toBeInTheDocument();
  });

  // Start and end are ONE row (owner, 2026-10-17): a formatRange in the
  // venue's zone, its spaces made plain by the component.
  it("prints a same-day range in one WHEN row: the date once, both times", () => {
    renderCommunity({
      startsAt: "2026-10-23T00:00:00.000Z",
      endsAt: "2026-10-23T02:00:00.000Z",
    });
    expect(screen.getAllByTestId("community-fact-when")).toHaveLength(1);
    expect(whenKey()).toBe("When");
    // 7:00 to 9:00 PM on Oct 22 in Chicago.
    expect(whenValue()).toBe("Thursday, October 22, 2026, 7:00 – 9:00 PM");
    expect(whenValue().match(/October/g)).toHaveLength(1);
  });

  // Node's ICU (77.1) puts a thin space around the dash and a narrow no-break
  // space before PM; Chrome prints plain spaces. Left in, the server's string
  // fails hydration against the browser's.
  it("prints the range with plain spaces only, so SSR and the browser agree", () => {
    renderCommunity();
    expect(whenValue()).not.toMatch(/[\u2009\u202f\u00a0]/);
    expect(whenValue()).toContain(" – ");
  });

  it("formats the range in the reader's locale", () => {
    mockLocale = "es";
    renderCommunity({
      startsAt: "2026-10-23T00:00:00.000Z",
      endsAt: "2026-10-23T02:00:00.000Z",
    });
    // The mock translator has English copy for this key; the key is the point.
    expect(whenKey()).toBe(MESSAGES["eventDetail.factWhen"]);
    expect(whenValue()).toBe("jueves, 22 de octubre de 2026, 19:00 – 21:00");
  });

  // Node, Chromium and Firefox print a Spanish same-day range "19:00–21:00",
  // WebKit "19:00 – 21:00". The component spaces the dash in every engine, so
  // the row reads the same on every browser and SSR matches each of them.
  it("prints a spaced en dash in every locale", () => {
    for (const locale of ["en", "es"]) {
      mockLocale = locale;
      const { unmount } = renderCommunity({
        startsAt: "2026-10-23T00:00:00.000Z",
        endsAt: "2026-10-23T02:00:00.000Z",
      });
      expect(whenValue()).toContain(" – ");
      expect(whenValue()).not.toMatch(/\S–|–\S/);
      unmount();
    }
  });

  it("prints both dates when the range crosses midnight", () => {
    renderCommunity({
      startsAt: "2026-10-24T02:00:00.000Z",
      endsAt: "2026-10-24T06:30:00.000Z",
    });
    expect(whenKey()).toBe("When");
    expect(whenValue()).toBe(
      "Friday, October 23, 2026 at 9:00 PM – Saturday, October 24, 2026 at 1:30 AM",
    );
  });

  // The two fixtures below are the ones where the venue zone and UTC disagree,
  // so a range formatted in UTC (or the machine's zone) fails one of them.
  // America/Chicago is CDT (UTC-5) on these dates.
  it("prints one date when the UTC dates differ but the venue day is the same", () => {
    // 6:00 PM to 10:00 PM on Oct 22 in Chicago; Oct 22 to Oct 23 in UTC.
    renderCommunity({
      startsAt: "2026-10-22T23:00:00.000Z",
      endsAt: "2026-10-23T03:00:00.000Z",
    });
    expect(whenValue()).toBe("Thursday, October 22, 2026, 6:00 – 10:00 PM");
  });

  it("prints both dates when the range crosses venue midnight on one UTC day", () => {
    // 10:00 PM Oct 22 to 1:00 AM Oct 23 in Chicago; both Oct 23 in UTC.
    renderCommunity({
      startsAt: "2026-10-23T03:00:00.000Z",
      endsAt: "2026-10-23T06:00:00.000Z",
    });
    expect(whenValue()).toBe(
      "Thursday, October 22, 2026 at 10:00 PM – Friday, October 23, 2026 at 1:00 AM",
    );
  });

  it("renders the WHEN row without a venue timezone", () => {
    renderCommunity({ timezone: undefined });
    // The product falls back to the runtime zone, so the exact text depends on
    // the machine; what matters is that one range renders.
    expect(whenKey()).toBe("When");
    expect(whenValue()).toMatch(/2026.* – /);
  });

  // `scheduleStarts` has no entry in MESSAGES (the head's time-key test reads
  // it as its echoed key), so a lone start's key is the key path.
  it("keeps the start alone under Starts when the end is not after it", () => {
    renderCommunity({
      startsAt: "2026-10-23T03:00:00.000Z",
      endsAt: "2026-10-23T01:00:00.000Z",
    });
    expect(whenKey()).toBe("eventDetail.scheduleStarts");
    // The full form (mocked to a fixed string).
    expect(whenValue()).toBe("Sat, Jan 1, 2027");
  });

  it("labels a lone end Ends", () => {
    renderCommunity({ startsAt: undefined });
    expect(whenKey()).toBe("Ends");
    expect(whenValue()).toBe("Sat, Jan 1, 2027");
  });

  it("renders no WHEN row with neither a start nor an end", () => {
    renderCommunity({ startsAt: undefined, endsAt: undefined });
    expect(screen.queryByTestId("community-fact-when")).toBeNull();
  });

  it("leaves no separate STARTS or ENDS row behind", () => {
    const { container } = renderCommunity();
    expect(
      container.querySelector(
        '[data-testid="community-fact-starts"], [data-testid="community-fact-ends"]',
      ),
    ).toBeNull();
  });

  it("reads TBA rather than throwing when the listing has no date", () => {
    renderCommunity({ startsAt: undefined });

    expect(
      screen.getByTestId("event-hero-date-stub").dataset.stubDate,
    ).toBe("none");
    expect(screen.getByTestId("community-head-date")).toHaveAttribute(
      "aria-label",
      "Date not set",
    );
    // No time means no line at all — not an orphan "Starts" key.
    expect(screen.queryByTestId("community-head-time")).toBeNull();
    expect(
      screen
        .getByTestId("community-listing-head")
        .querySelector(".community-head__time-key"),
    ).toBeNull();
  });

  // An unreadable start used to reach `fmt.dateTime(new Date(startsAt))` and
  // take the page down with a RangeError. It now reads exactly like no start.
  it("reads TBA rather than throwing when the start is unreadable", () => {
    renderCommunity({ startsAt: "not-a-date" });

    expect(
      screen.getByTestId("event-hero-date-stub").dataset.stubDate,
    ).toBe("none");
    expect(screen.getByTestId("community-head-date")).toHaveAttribute(
      "aria-label",
      "Date not set",
    );
    expect(screen.queryByTestId("community-head-time")).toBeNull();
    // The readable end keeps its row, as with no start at all.
    expect(whenKey()).toBe("Ends");
  });

  it("keeps the start alone under Starts when the end is unreadable", () => {
    renderCommunity({ endsAt: "not-a-date" });
    expect(whenKey()).toBe("eventDetail.scheduleStarts");
  });

  it("does nothing at all when communityLayout is not set (embeds, admin preview)", () => {
    renderCommunity({ communityLayout: false });

    expect(screen.queryByTestId("community-listing-head")).toBeNull();
    expect(screen.queryByTestId("community-fact-block")).toBeNull();
    // The numbered sections are back.
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByTestId("event-location-section")).toBeInTheDocument();
  });
});

// ── Arrival-area legend only beside a real map (arrival-areas follow-up d) ──
describe("EventContent — arrival-area legend needs a map", () => {
  const LOT: VisibleArrivalArea = {
    id: "00000000-0000-4000-8000-00000000e001",
    source: "PLACE",
    kind: "PARKING",
    label: "Front lot",
    cost: "FREE",
    priceText: null,
    note: null,
    accessibleSpots: false,
    geometry: {
      type: "LineString",
      coordinates: [
        [-86.78, 36.16],
        [-86.779, 36.16],
      ],
    },
    directions: { lat: 36.16, lng: -86.7795 },
  };
  const COORDS = { latitude: 36.16, longitude: -86.78, label: "The Barn", isExact: true };
  const legend = () =>
    document.querySelector('[data-testid="arrival-areas-legend"]');

  it("shows the legend beside the map when tiles are configured", () => {
    mapsConfig.enabled = true;
    render(
      <EventContent
        title="Show"
        startsAt="2027-01-01T18:00:00.000Z"
        location="The Barn"
        locationCoords={COORDS}
        arrivalAreas={[LOT]}
      />,
    );
    expect(legend()).not.toBeNull();
  });

  it("drops the legend when no map renders (no tile server), keeping the list", () => {
    mapsConfig.enabled = false;
    render(
      <EventContent
        title="Show"
        startsAt="2027-01-01T18:00:00.000Z"
        location="The Barn"
        locationCoords={COORDS}
        arrivalAreas={[LOT]}
      />,
    );
    expect(legend()).toBeNull();
    expect(screen.getAllByText("Front lot").length).toBeGreaterThan(0);
  });

  it("drops the legend when there are no showable coords", () => {
    mapsConfig.enabled = true;
    render(
      <EventContent
        title="Show"
        startsAt="2027-01-01T18:00:00.000Z"
        location="The Barn"
        arrivalAreas={[LOT]}
      />,
    );
    expect(legend()).toBeNull();
  });
});

// ── Unreadable dates (owner 2026-10-18) ──────────────────────────────────────
// An unreadable `startsAt` crashed the page: the formatters and the calendar
// builders throw a RangeError on an Invalid Date. EventContent now treats an
// unreadable date as an absent one.
describe("EventContent — an unreadable date reads as no date", () => {
  const googleLink = (container: HTMLElement) =>
    container.querySelector<HTMLAnchorElement>(
      'a[href^="https://calendar.google.com/"]',
    );

  it("renders Date not set, no Schedule section and no calendar link for an unreadable start", () => {
    const { container } = render(
      <EventContent
        title="Show"
        startsAt="not-a-date"
        endsAt="2027-01-01T20:00:00.000Z"
        location="The Barn"
      />,
    );
    expect(screen.getByText("Date not set")).toBeInTheDocument();
    expect(screen.queryByText("Schedule")).toBeNull();
    expect(googleLink(container)).toBeNull();
  });

  it("shows the start alone, and a +2h calendar end, for an unreadable end", () => {
    const { container } = render(
      <EventContent
        title="Show"
        startsAt="2027-01-01T18:00:00.000Z"
        endsAt="not-a-date"
        location="The Barn"
      />,
    );
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.queryByText("Ends")).toBeNull();
    expect(screen.queryByText("Date not set")).toBeNull();
    const dates = new URL(googleLink(container)?.href ?? "").searchParams.get(
      "dates",
    );
    expect(dates).toBe("20270101T180000Z/20270101T200000Z");
  });
});
