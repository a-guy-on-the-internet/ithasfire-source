import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EmbedCalendarBrowse — the public-mode mount of the shared calendar engine
 * (event-calendar-redesign FR-020 … FR-024).
 *
 * The engine renders FOR REAL here (only `@th/ui` is stood in), because the
 * things worth locking down are what the mount asks of it: public mode, month
 * and week only, no peek / filters / holds / create, the click contract, and
 * the theme bridge reaching the painted subtree. Stubbing the engine would
 * assert nothing but prop plumbing.
 */

const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock.value,
}));

vi.mock("@th/ui", async () => (await import("./embed-calendar-ui.stub")).uiStub);

import { EmbedCalendarBrowse } from "./EmbedCalendarBrowse";
import type { EmbedCalendarEvent } from "./embed-calendar-helpers";

const TZ = "America/Chicago";

/** 2026-09-05 19:00 America/Chicago (CDT, UTC-5). */
const SEP_5_7PM = new Date("2026-09-06T00:00:00.000Z");
/** 2026-09-12 19:00 America/Chicago — a different WEEK, same month. */
const SEP_12_7PM = new Date("2026-09-13T00:00:00.000Z");

const event = (over: Partial<EmbedCalendarEvent> = {}): EmbedCalendarEvent => ({
  id: "e1",
  title: "Doom Night",
  startsAt: SEP_5_7PM,
  endsAt: null,
  status: "PUBLISHED",
  slug: "doom-night",
  location: "The Cobra",
  city: "Nashville",
  region: "TN",
  timezone: TZ,
  occurrence: null,
  checkoutEligible: true,
  ...over,
});

type BrowseProps = Parameters<typeof EmbedCalendarBrowse>[0];

const NO_OVERRIDES: BrowseProps["themeOverrides"] = {
  brandColor: null,
  bg: null,
  fontColor: null,
  accentColor: null,
};

function renderBrowse(over: Partial<BrowseProps> = {}) {
  const onSelectEvent = vi.fn();
  const utils = render(
    <EmbedCalendarBrowse
      ownerName="Dev QA Collective"
      events={[event()]}
      linkOut={false}
      buildEventUrl={(slugOrId) => `https://ithasfire.com/events/${slugOrId}`}
      onSelectEvent={onSelectEvent}
      themeOverrides={NO_OVERRIDES}
      {...over}
    />,
  );
  return { ...utils, onSelectEvent };
}

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  isMobileMock.value = false;
  openSpy = vi.fn();
  vi.stubGlobal("open", openSpy);
  // The grid paints around "now"; pin it so the seeded event is on screen.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EmbedCalendarBrowse", () => {
  it("mounts the shared engine in PUBLIC mode, month view, month + week only", () => {
    renderBrowse();
    const root = screen.getByTestId("event-calendar");
    expect(root.getAttribute("data-mode")).toBe("public");
    expect(root.getAttribute("data-view")).toBe("month");
    expect(screen.getByTestId("calendar-month-grid")).toBeInTheDocument();

    // FR-008: no agenda option on the embed.
    expect(screen.getByTestId("calendar-view-mode-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-view-month")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-view-week")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-view-agenda")).toBeNull();
  });

  it("draws none of the internal chrome: no filters, no overflow menu, no create affordance", () => {
    renderBrowse();
    expect(screen.queryByTestId("calendar-filters")).toBeNull();
    expect(screen.queryByTestId("calendar-overflow")).toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="calendar-day-create-"]'),
    ).toHaveLength(0);
  });

  it("switches to the week view through the toggle", () => {
    renderBrowse();
    fireEvent.click(screen.getByTestId("calendar-view-week"));
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("week");
    expect(screen.getByTestId("calendar-week-grid")).toBeInTheDocument();
  });

  it("never opens a peek — a chip press runs the embed's own click handler", () => {
    const { onSelectEvent } = renderBrowse();
    const chip = screen.getByTestId("calendar-event-chip-e1");
    // Public mode advertises no popup.
    expect(chip.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(onSelectEvent).toHaveBeenCalledWith("e1");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("links a checkout-INELIGIBLE event out to the canonical page in a new tab", () => {
    const { onSelectEvent } = renderBrowse({
      events: [event({ checkoutEligible: false })],
    });
    fireEvent.click(screen.getByTestId("calendar-event-chip-e1"));
    expect(onSelectEvent).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://ithasfire.com/events/doom-night",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("links EVERY event out on a linkOut embed, eligible or not", () => {
    const { onSelectEvent } = renderBrowse({ linkOut: true });
    fireEvent.click(screen.getByTestId("calendar-event-chip-e1"));
    expect(onSelectEvent).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://ithasfire.com/events/doom-night",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("falls back to the event id when the row carries no slug", () => {
    renderBrowse({ events: [event({ slug: null, checkoutEligible: false })] });
    fireEvent.click(screen.getByTestId("calendar-event-chip-e1"));
    expect(openSpy).toHaveBeenCalledWith(
      "https://ithasfire.com/events/e1",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("routes a multi-date occurrence to its PARENT event id, resolving eligibility per night", () => {
    const { onSelectEvent } = renderBrowse({
      events: [
        event({
          startsAt: SEP_5_7PM,
          occurrence: { index: 1, total: 2, eventDateId: "d1" },
          checkoutEligible: false,
        }),
        event({
          startsAt: SEP_12_7PM,
          occurrence: { index: 2, total: 2, eventDateId: "d2" },
          checkoutEligible: true,
        }),
      ],
    });
    // The past night links out…
    fireEvent.click(screen.getByTestId("calendar-event-chip-e1:d1"));
    expect(onSelectEvent).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledTimes(1);
    // …while the buyable one enters the in-iframe flow on the PARENT id.
    fireEvent.click(screen.getByTestId("calendar-event-chip-e1:d2"));
    expect(onSelectEvent).toHaveBeenCalledWith("e1");
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("never paints a draft on this unauthenticated surface", () => {
    renderBrowse({
      events: [event({ id: "draft", status: "DRAFT" }), event()],
    });
    expect(screen.queryByTestId("calendar-event-chip-draft")).toBeNull();
    expect(screen.getByTestId("calendar-event-chip-e1")).toBeInTheDocument();
  });

  it("keeps the owner label", () => {
    renderBrowse();
    expect(screen.getByText("Dev QA Collective")).toBeInTheDocument();
  });

  it("bridges the host theme overrides onto the vars the engine paints with (FR-021)", () => {
    renderBrowse({
      themeOverrides: {
        brandColor: "1A1A2E",
        bg: "FAFAFA",
        fontColor: "222222",
        accentColor: "FF0000",
      },
    });
    const bridge = screen.getByTestId("embed-calendar-theme-bridge");
    // The engine paints INSIDE the bridge, so the custom properties cascade.
    expect(bridge.contains(screen.getByTestId("event-calendar"))).toBe(true);
    const style = bridge.getAttribute("style") ?? "";
    for (const decl of [
      "--borderColor: var(--hf-brand)",
      "--borderColorStrong: var(--hf-brand)",
      "--accent: var(--hf-accent)",
      "--accentSoft: var(--hf-accent-soft)",
      "--color: var(--hf-text)",
      "--colorMuted: var(--hf-text-muted)",
      // The TODAY square / selected dot-grid day fill with --color and print
      // their numeral in --onStructure; without this a dark-site host got a
      // white block carrying the stub's near-white numeral.
      "--onStructure: var(--hf-on-text)",
      // Its fill travels with it: `.th-cal-action:hover` pairs the two, and
      // half-bridged that pair is ink on ink (1.05:1) for a white fontColor.
      "--structure: var(--hf-text)",
      "--surface: var(--hf-bg)",
      "background: var(--hf-bg)",
    ]) {
      expect(style).toContain(decl);
    }
  });

  it("explains an empty month instead of leaving a blank grid, INSIDE the frame", () => {
    renderBrowse({ events: [] });
    const empty = screen.getByTestId("calendar-empty-state");
    expect(empty).toHaveTextContent("No upcoming events in September 2026");
    // The engine owns it now — a caption outside the frame read as page copy.
    expect(screen.getByTestId("calendar-month-grid").contains(empty)).toBe(true);
  });

  it("explains an empty WEEK too, inside the week frame", () => {
    renderBrowse({ events: [] });
    fireEvent.click(screen.getByTestId("calendar-view-week"));
    const empty = screen.getByTestId("calendar-empty-state");
    expect(empty).toHaveTextContent("No upcoming events this week");
    expect(screen.getByTestId("calendar-week-grid").contains(empty)).toBe(true);
  });

  it("drops the caption once the visible range has an event", () => {
    renderBrowse();
    expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
  });

  /**
   * FR-022 — the chip treatment already existed; nothing on the embed set the
   * flag. `data-sold-out` is what `calendar.css` dims on
   * (`.th-cal-chip[data-sold-out="true"] { opacity: .55 }`), which jsdom does
   * not compute, so the attribute IS the assertion.
   */
  describe("sold out (FR-022)", () => {
    const soldOutEvent = () =>
      event({
        soldOut: true,
        // 2 hours, so the week block is tall enough to be a fair test of what
        // the tag displaces.
        endsAt: new Date("2026-09-06T02:00:00.000Z"),
      });

    it("dims the chip and tags it in MONTH", () => {
      renderBrowse({ events: [soldOutEvent()] });
      const chip = screen.getByTestId("calendar-event-chip-e1");
      expect(chip.getAttribute("data-sold-out")).toBe("true");
      expect(screen.getByTestId("calendar-event-chip-e1-sold-out")).toHaveTextContent(
        "Sold out",
      );
    });

    it("dims the chip and tags it in WEEK", () => {
      renderBrowse({ events: [soldOutEvent()] });
      fireEvent.click(screen.getByTestId("calendar-view-week"));
      const chip = screen.getByTestId("calendar-event-chip-e1");
      expect(chip.getAttribute("data-density")).toBe("week");
      expect(chip.getAttribute("data-sold-out")).toBe("true");
      expect(screen.getByTestId("calendar-event-chip-e1-sold-out")).toHaveTextContent(
        "Sold out",
      );
    });

    it("leaves a sellable event undimmed and untagged", () => {
      renderBrowse({ events: [event({ soldOut: false })] });
      const chip = screen.getByTestId("calendar-event-chip-e1");
      expect(chip.getAttribute("data-sold-out")).toBeNull();
      expect(screen.queryByTestId("calendar-event-chip-e1-sold-out")).toBeNull();
    });

    it("the explicit flag WINS over the sold/capacity derivation", () => {
      // The mount never sends counts, but the engine's `isSoldOut` falls back
      // to them; an explicit `false` must not be overridden by a full house.
      renderBrowse({ events: [event({ soldOut: false })] });
      expect(
        screen.getByTestId("calendar-event-chip-e1").getAttribute("data-sold-out"),
      ).toBeNull();
    });
  });

  /** FR-023 — week rows only, never a month chip. */
  describe("price (FR-023)", () => {
    const pricedEvent = () =>
      event({
        priceLabel: "From $15",
        endsAt: new Date("2026-09-06T02:00:00.000Z"),
      });

    it("shows the price on the WEEK block and never in the month grid", () => {
      renderBrowse({ events: [pricedEvent()] });
      expect(screen.getByTestId("calendar-month-grid").textContent).not.toContain(
        "From $15",
      );
      expect(screen.queryByTestId("calendar-event-chip-e1-price")).toBeNull();

      fireEvent.click(screen.getByTestId("calendar-view-week"));
      expect(screen.getByTestId("calendar-event-chip-e1-price")).toHaveTextContent(
        "From $15",
      );
    });

    it("a priceless event paints no third line at all", () => {
      renderBrowse({
        events: [event({ priceLabel: null, endsAt: new Date("2026-09-06T02:00:00.000Z") })],
      });
      fireEvent.click(screen.getByTestId("calendar-view-week"));
      expect(screen.queryByTestId("calendar-event-chip-e1-price")).toBeNull();
      expect(screen.getByTestId("calendar-event-chip-e1").children).toHaveLength(2);
    });

    it("a SOLD OUT week block keeps the sold-out tag and drops the price", () => {
      renderBrowse({
        events: [
          event({
            soldOut: true,
            priceLabel: "From $15",
            endsAt: new Date("2026-09-06T02:00:00.000Z"),
          }),
        ],
      });
      fireEvent.click(screen.getByTestId("calendar-view-week"));
      expect(screen.getByTestId("calendar-event-chip-e1-sold-out")).toBeInTheDocument();
      expect(screen.queryByTestId("calendar-event-chip-e1-price")).toBeNull();
    });
  });

  describe("below 600px (FR-010)", () => {
    beforeEach(() => {
      isMobileMock.value = true;
    });

    it("paints the engine's dot grid + tapped-day list, with no week option", () => {
      renderBrowse();
      expect(screen.getByTestId("calendar-month-dotgrid")).toBeInTheDocument();
      expect(screen.getByTestId("calendar-day-list")).toBeInTheDocument();
      expect(screen.queryByTestId("calendar-month-grid")).toBeNull();
      expect(screen.queryByTestId("calendar-view-week")).toBeNull();
      // The day list carries its own empty copy — no duplicate caption.
      expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
    });

    it("carries no INTERNAL status tag on a third-party page", () => {
      renderBrowse();
      fireEvent.click(screen.getByTestId("calendar-dot-2026-09-05"));
      const list = screen.getByTestId("calendar-day-list");
      expect(screen.queryByTestId("calendar-status-tag")).toBeNull();
      expect(list.textContent).not.toContain("Published");
      // The row itself still reads.
      expect(list.textContent).toContain("Doom Night");
    });

    it("routes a day-list row press through the same click contract", () => {
      const { onSelectEvent } = renderBrowse();
      fireEvent.click(screen.getByTestId("calendar-dot-2026-09-05"));
      fireEvent.click(screen.getByTestId("calendar-day-list-row-e1"));
      expect(onSelectEvent).toHaveBeenCalledWith("e1");
    });
  });
});
