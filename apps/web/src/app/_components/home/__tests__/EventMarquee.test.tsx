import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "@th/ui";

// Capture what EventMarquee hands the shell — the shell's own mechanics
// (loop, a11y, self-hide) are MarqueeBand's concern, not this suite's.
type CapturedProps = {
  items: Array<{
    key: string;
    href: string;
    ariaLabel: string;
    segments: Array<{ text: string; tone: "primary" | "muted" }>;
  }>;
  sectionAriaLabel: string;
};

const captured: CapturedProps[] = [];

// EventMarquee renders twice per mount: once pre-mount (`now` null → SSR-safe
// fallback labels) and once after the mount effect sets `now` (relative
// labels). `first()` pins the SSR/hydration render; `latest()` the settled one.
const first = () => captured[0];
const latest = () => captured[captured.length - 1];

// The band's section label must come from the message catalog, not a
// hardcoded English string. The stub answers in Spanish on purpose: an
// assertion of "Upcoming events" would pass again the day someone puts the
// literal back, this one cannot.
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) =>
    key === "home.upcomingEvents" ? "Próximos eventos" : key,
}));

vi.mock("../MarqueeBand", () => ({
  MarqueeBand: (props: CapturedProps) => {
    captured.push(props);
    return <div data-testid="marquee-band" />;
  },
}));

import { EventMarquee, eventTickerDateLabel } from "../EventMarquee";

// Local-time constructors keep every assertion timezone-independent: the
// label logic compares LOCAL calendar days, so both `now` and the event
// instants are built in the runner's local zone.
const local = (
  y: number,
  m: number,
  d: number,
  h = 20,
): string => new Date(y, m, d, h, 0, 0).toISOString();

/** Tue Jul 21 2026, 8pm local. */
const NOW = new Date(2026, 6, 21, 20, 0, 0);

describe("eventTickerDateLabel", () => {
  it("labels an event on the same local calendar day TONIGHT", () => {
    expect(eventTickerDateLabel(local(2026, 6, 21, 23), "Jul 21", NOW)).toBe(
      "TONIGHT",
    );
    // Any time-of-day on the same calendar day counts — even before `now`.
    expect(eventTickerDateLabel(local(2026, 6, 21, 0), "Jul 21", NOW)).toBe(
      "TONIGHT",
    );
  });

  it("labels the next calendar day TOMORROW", () => {
    expect(eventTickerDateLabel(local(2026, 6, 22, 1), "Jul 22", NOW)).toBe(
      "TOMORROW",
    );
  });

  it("labels days 2–6 out with the uppercase 3-letter weekday", () => {
    // Fri Jul 24 2026 (3 days out).
    expect(eventTickerDateLabel(local(2026, 6, 24), "Jul 24", NOW)).toBe("FRI");
    // Mon Jul 27 2026 (6 days out — the boundary stays a weekday).
    expect(eventTickerDateLabel(local(2026, 6, 27), "Jul 27", NOW)).toBe("MON");
  });

  it("falls back to the uppercased pre-formatted date beyond 6 days", () => {
    // Tue Jul 28 2026 (7 days out — first day past the weekday window).
    expect(eventTickerDateLabel(local(2026, 6, 28), "Jul 28", NOW)).toBe(
      "JUL 28",
    );
  });

  it("falls back for past events (never TONIGHT for yesterday)", () => {
    expect(eventTickerDateLabel(local(2026, 6, 20), "Jul 20", NOW)).toBe(
      "JUL 20",
    );
  });

  it("falls back to the uppercased date when startsAt is missing", () => {
    expect(eventTickerDateLabel(undefined, "Apr 15", NOW)).toBe("APR 15");
  });

  it("falls back to the uppercased date when startsAt is invalid", () => {
    expect(eventTickerDateLabel("not-a-date", "Apr 15", NOW)).toBe("APR 15");
  });
});

// ── Component mapping ────────────────────────────────────────────────────────

const makeEvent = (over: Partial<EventSummary> = {}): EventSummary => ({
  id: "evt-1",
  title: "Basement Show",
  date: "Apr 15",
  venue: "The End",
  priceLabel: "$10",
  slug: "basement-show",
  startsAt: local(2099, 3, 15),
  ...over,
});

describe("EventMarquee", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("maps events to muted date / primary title / muted venue segments", () => {
    render(<EventMarquee events={[makeEvent()]} />);

    expect(latest()?.sectionAriaLabel).toBe("Próximos eventos");
    const item = latest()?.items[0];
    expect(item?.key).toBe("evt-1");
    expect(item?.href).toBe("/events/basement-show");
    expect(item?.ariaLabel).toBe("Basement Show at The End, APR 15");
    expect(item?.segments).toEqual([
      { text: "APR 15", tone: "muted" },
      { text: "BASEMENT SHOW", tone: "primary" },
      { text: "— THE END", tone: "muted" },
    ]);
  });

  it("labels the section from the catalog on both the pre- and post-mount render", () => {
    render(<EventMarquee events={[makeEvent()]} />);

    // Same on the render React hydrates against and the settled one — the
    // label is NOT part of the hydration contract (unlike the date labels
    // above), it just has to be translated.
    expect(first()?.sectionAriaLabel).toBe("Próximos eventos");
    expect(latest()?.sectionAriaLabel).toBe("Próximos eventos");
  });

  it("omits the venue segment (and aria suffix) when venue is empty", () => {
    render(<EventMarquee events={[makeEvent({ venue: "" })]} />);

    const item = latest()?.items[0];
    expect(item?.ariaLabel).toBe("Basement Show, APR 15");
    expect(item?.segments).toHaveLength(2);
  });

  it("drops slug-less events, sorts by startsAt ascending with missing startsAt last, and caps at 12", () => {
    const events: EventSummary[] = [
      makeEvent({ id: "no-slug", slug: null }),
      makeEvent({ id: "later", slug: "later", startsAt: local(2099, 5, 2) }),
      makeEvent({ id: "no-starts-b", slug: "nsb", startsAt: undefined }),
      makeEvent({ id: "sooner", slug: "sooner", startsAt: local(2099, 4, 1) }),
      makeEvent({ id: "no-starts-a", slug: "nsa", startsAt: undefined }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeEvent({
          id: `bulk-${i}`,
          slug: `bulk-${i}`,
          startsAt: local(2099, 5, 10 + i),
        }),
      ),
    ];

    render(<EventMarquee events={events} />);

    const keys = latest()?.items.map((i) => i.key) ?? [];
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain("no-slug");
    // Dated events ascend; the two undated ones would sort last (capped off
    // here by the 12-item limit before they surface).
    expect(keys.slice(0, 2)).toEqual(["sooner", "later"]);
    expect(keys).not.toContain("no-starts-b");
  });

  it("keeps input order among events without startsAt (stable tail)", () => {
    const events: EventSummary[] = [
      makeEvent({ id: "b", slug: "b", startsAt: undefined }),
      makeEvent({ id: "dated", slug: "dated" }),
      makeEvent({ id: "a", slug: "a", startsAt: undefined }),
    ];

    render(<EventMarquee events={events} />);

    expect(latest()?.items.map((i) => i.key)).toEqual(["dated", "b", "a"]);
  });

  it("renders SSR-safe fallback labels pre-mount, then relative labels after mount", () => {
    // A show later on the runner's own calendar day: post-mount this is
    // "TONIGHT", but the FIRST render (now == null, what the server emits and
    // what the client hydrates against) must use the timezone-independent
    // pre-formatted date instead — uppercased, identical on both sides.
    const today = new Date();
    const tonight = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      23,
      59,
    ).toISOString();

    render(
      <EventMarquee
        events={[makeEvent({ startsAt: tonight, date: "Apr 15" })]}
      />,
    );

    // Pre-mount render: fallback label everywhere it appears.
    expect(first()?.items[0]?.segments[0]).toEqual({
      text: "APR 15",
      tone: "muted",
    });
    expect(first()?.items[0]?.ariaLabel).toBe(
      "Basement Show at The End, APR 15",
    );

    // Post-mount render: the relative label takes over.
    expect(captured.length).toBeGreaterThan(1);
    expect(latest()?.items[0]?.segments[0]).toEqual({
      text: "TONIGHT",
      tone: "muted",
    });
    expect(latest()?.items[0]?.ariaLabel).toBe(
      "Basement Show at The End, TONIGHT",
    );
  });
});
