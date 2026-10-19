/**
 * EventDetail — the poster-first page's contracts with the SHELL.
 *
 * `EventContent` owns the page; these pin what EventDetail decides AROUND it,
 * all of which key on the one shared predicate (`isPosterFirstLayout`):
 *
 *   - the bottom nav's centre "Get tickets" stands DOWN while the docked price
 *     bar is on screen (poster event, viewport under 768px), so a phone never
 *     shows two "Get tickets" a few pixels apart;
 *   - the rail's Save button and the rating line take the poster treatment;
 *   - a status / sellability notice above the hero is announced to the page,
 *     so the band does not climb over it.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { SeoEvent } from "@th/types/seo/types";

// ── The two viewport / scroll signals, mutable per test ────────────────────
let wideEnough = true;
let heroCtaGone = false;

vi.mock("@/hooks/useMinViewportWidth", () => ({
  useMinViewportWidth: () => wideEnough,
}));
vi.mock("@/components/events/use-scrolled-past", () => ({
  useScrolledPast: () => heroCtaGone,
}));

// ── What EventDetail publishes to the shell, captured ──────────────────────
const primaryActionCalls: Array<{ label: string; enabled?: boolean }> = [];
vi.mock("@/components/navigation/page-primary-action", () => ({
  usePagePrimaryAction: (opts: { label: string; enabled?: boolean }) => {
    primaryActionCalls.push({ label: opts.label, enabled: opts.enabled });
  },
}));

// ── What EventDetail hands the page, captured ──────────────────────────────
let contentProps: Record<string, any> = {};
vi.mock("@/components/events/EventContent", async () => {
  const React = await import("react");
  return {
    EventContent: (props: Record<string, unknown>) => {
      contentProps = props;
      return React.createElement("div", { "data-testid": "event-content" });
    },
  };
});

// ── Everything else EventDetail touches, stood in ──────────────────────────
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/components/events/event-body-to-html", () => ({
  eventBodyToHtml: () => "",
}));
vi.mock("@/lib/attribution", () => ({ captureAttribution: vi.fn() }));
vi.mock("@/components/saves/SaveButton", async () => {
  const React = await import("react");
  return {
    SaveButton: (props: Record<string, unknown>) =>
      React.createElement("button", { "data-variant": props.variant }),
  };
});
vi.mock("../EventRatingLine", async () => {
  const React = await import("react");
  return {
    EventRatingLine: (props: Record<string, unknown>) =>
      React.createElement("span", { "data-ink": props.ink }),
  };
});
// The series picker's props, or null when EventDetail does not mount it.
let pickerProps: { seriesDates: Array<{ slug: string }> } | null = null;
vi.mock("../SeriesTicketDatePicker", () => ({
  SeriesTicketDatePicker: (props: { seriesDates: Array<{ slug: string }> }) => {
    pickerProps = props;
    return null;
  },
}));
vi.mock("@/components/community/RsvpButton", () => ({ RsvpButton: () => null }));
vi.mock("@/components/community/CommunityDateList", () => ({
  CommunityDateList: () => null,
}));
vi.mock("@/components/community/CommunityListingNotice", () => ({
  CommunityListingNotice: () => null,
}));
vi.mock("@/components/community/BecomeModeratorCta", () => ({
  BecomeModeratorCta: () => null,
}));

import { EventDetail } from "../EventDetail";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function seoEvent(overrides: Partial<SeoEvent> = {}): SeoEvent {
  return {
    id: EVENT_ID,
    slug: "great-show",
    url: "https://tickets.local/events/great-show",
    name: "Great Show",
    startsAt: new Date("2027-04-01T19:00:00.000Z"),
    status: "PUBLISHED",
    images: ["https://cdn.test/poster.jpg"],
    performers: [],
    ...overrides,
  };
}

const onSale = [
  {
    id: "tt-1",
    name: "General",
    priceCents: 1800,
    capacity: 100,
    remainingCapacity: 41,
    soldOut: false,
  },
];

function renderDetail(
  props: Partial<Parameters<typeof EventDetail>[0]> = {},
  event: SeoEvent = seoEvent(),
) {
  return render(
    <EventDetail
      event={event}
      bodyContent={null}
      ticketTypes={onSale}
      eventId={EVENT_ID}
      showSaveAction
      immersiveHero
      {...props}
    />,
  );
}

const lastPrimary = () => primaryActionCalls[primaryActionCalls.length - 1]!;

beforeEach(() => {
  wideEnough = true;
  heroCtaGone = false;
  primaryActionCalls.length = 0;
  contentProps = {};
  pickerProps = null;
});

describe("EventDetail — the poster-first page and the shell", () => {
  it("stands the bottom nav's 'Get tickets' down while the docked bar is on screen", () => {
    // Narrow: the page docks its own price bar (always visible), so the nav's
    // raised square would be a second "Get tickets" a few pixels above it —
    // even once the (display: none) buy band counts as scrolled past.
    wideEnough = false;
    heroCtaGone = true;
    renderDetail();
    expect(lastPrimary()).toEqual({
      label: "common.navGetTickets",
      enabled: false,
    });
  });

  it("hands the nav the action wide, once the buy band has scrolled away", () => {
    // 768–959: no docked bar, the buy band scrolls like any in-page button,
    // and the nav takes over exactly as before this layout existed.
    wideEnough = true;
    heroCtaGone = false;
    const { rerender } = renderDetail();
    expect(lastPrimary().enabled).toBe(false);

    heroCtaGone = true;
    rerender(
      <EventDetail
        event={seoEvent()}
        bodyContent={null}
        ticketTypes={onSale}
        eventId={EVENT_ID}
        showSaveAction
        immersiveHero
      />,
    );
    expect(lastPrimary().enabled).toBe(true);
  });

  it("leaves a posterless event on the old rule — the nav follows the hero button alone", () => {
    wideEnough = false;
    heroCtaGone = true;
    renderDetail({}, seoEvent({ images: [] }));
    expect(lastPrimary().enabled).toBe(true);
    // ...and its Save button keeps the labelled default.
    expect(contentProps.saveAction.props.variant).toBe("default");
    expect(contentProps.organizerRating.props.ink).toBeUndefined();
  });

  it("gives the rail's Save button and the rating line the poster treatment", () => {
    renderDetail();
    expect(contentProps.saveAction.props.variant).toBe("poster");
    // The custom property, so the line is ink on the phone's paper and the
    // dimmed on-dark rung over the desktop band — CSS decides which.
    expect(contentProps.organizerRating.props.ink).toBe(
      "var(--hero-ink-muted)",
    );
  });

  it("never docks the bar's rule on an embed — `mobile` is the EMBED flag", () => {
    // An embed is a box in someone else's page, never poster-first, so the
    // nav rule is untouched there whatever the window width.
    wideEnough = false;
    heroCtaGone = true;
    renderDetail({ mobile: true, immersiveHero: false });
    expect(lastPrimary().enabled).toBe(true);
    expect(contentProps.saveAction.props.variant).toBe("default");
  });

  it("tells the page when a notice renders above the hero", () => {
    // PUBLISHED, sellable: nothing above the hero.
    renderDetail();
    expect(contentProps.heroFollowsNotice).toBe(false);

    // DRAFT: the "draft preview" banner renders first — the band must not
    // climb over it. (`eventStatus` is the prop EventDetail reads, threaded
    // from the page; `event.status` feeds JSON-LD only.)
    renderDetail({ eventStatus: "DRAFT" });
    expect(contentProps.heroFollowsNotice).toBe(true);

    // A sellability notice (organizer's payment setup unfinished) too.
    renderDetail({ hideTicketCta: true, sellabilityReason: "no_payee" });
    expect(contentProps.heroFollowsNotice).toBe(true);
  });

  it("holder view: a neutral paused notice, never the fake 'ended' one, no CTA", () => {
    // Even if the payload's own reason said "sales_closed" (a past event) or
    // "no_payee", the holder path shows only the neutral notice.
    const { getByTestId, queryByTestId, container } = renderDetail({
      hideTicketCta: true,
      holderView: true,
      sellabilityReason: "sales_closed",
    });
    expect(getByTestId("event-holder-sales-paused-notice")).toHaveTextContent(
      "eventDetail.holderSalesPausedTitle",
    );
    expect(queryByTestId("event-sales-closed-notice")).toBeNull();
    expect(container.textContent).not.toContain("has ended");
    expect(contentProps.heroFollowsNotice).toBe(true);
    expect(contentProps.ctaLabel).toBeUndefined();
    expect(contentProps.ctaHref).toBeUndefined();
  });

  it("without holderView the paused notice never renders; sales-closed still does", () => {
    const { queryByTestId, getByTestId } = renderDetail({
      hideTicketCta: true,
      sellabilityReason: "sales_closed",
    });
    expect(queryByTestId("event-holder-sales-paused-notice")).toBeNull();
    expect(getByTestId("event-sales-closed-notice")).toBeInTheDocument();
  });

  it("threads the sections the page owns through as belowContent", () => {
    const below: ReactNode = <div data-testid="below" />;
    renderDetail({ belowContent: below });
    expect(contentProps.belowContent).toBe(below);
  });
});

// ── The pre-reveal notice names who gets the street (owner ruling Q16) ─────
describe("EventDetail — address reveal notice", () => {
  const hidden = (): SeoEvent =>
    seoEvent({
      location: { name: "Somewhere", isExact: false },
      addressRevealAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

  it("a ticketed event promises the address to ticket holders", () => {
    const { container } = renderDetail({}, hidden());
    expect(container.textContent).toContain("admin.ebRevealNotice");
    expect(container.textContent).not.toContain("admin.ebRevealNoticeRsvp");
  });

  it("an RSVP listing promises it to people who RSVP", () => {
    const { container } = renderDetail({ attendanceMode: "RSVP" }, hidden());
    expect(container.textContent).toContain("admin.ebRevealNoticeRsvp");
  });
});

describe("EventDetail — the series picker counts only readable dates", () => {
  function seriesDate(slug: string, startsAt: string) {
    return {
      occurrenceId: `occ-${slug}`,
      eventId: `evt-${slug}`,
      slug,
      title: "Great Show",
      startsAt,
      endsAt: null,
      timezone: "America/Chicago",
      isCurrent: slug === "great-show",
    };
  }
  const readableA = seriesDate("great-show", "2027-04-01T19:00:00.000Z");
  const readableB = seriesDate("great-show-2", "2027-04-08T19:00:00.000Z");
  const unreadable = seriesDate("great-show-3", "not a date");

  it("two readable dates: the picker mounts with only those, and Get tickets opens it", () => {
    renderDetail({ seriesDates: [readableA, unreadable, readableB] });
    expect(pickerProps?.seriesDates.map((d) => d.slug)).toEqual([
      "great-show",
      "great-show-2",
    ]);
    expect(typeof contentProps.onCtaPress).toBe("function");
  });

  it("one readable date: no picker, Get tickets is the plain checkout link", () => {
    renderDetail({ seriesDates: [readableA, unreadable] });
    expect(pickerProps).toBeNull();
    expect(contentProps.onCtaPress).toBeUndefined();
    expect(contentProps.ctaHref).toBe("/events/checkout/great-show");
  });

  it("every date unreadable: no picker, Get tickets is the plain checkout link", () => {
    renderDetail({
      seriesDates: [unreadable, seriesDate("great-show-4", "")],
    });
    expect(pickerProps).toBeNull();
    expect(contentProps.onCtaPress).toBeUndefined();
    expect(contentProps.ctaHref).toBe("/events/checkout/great-show");
  });
});
