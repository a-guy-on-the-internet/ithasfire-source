import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);

import { CalendarChip } from "../CalendarChip";
import { CalendarPeek } from "../CalendarPeek";
import { CalendarLabelsProvider } from "../use-calendar-labels";
import { DEFAULT_CALENDAR_LABELS } from "../labels";
import { TZ, at, event, hold } from "./fixtures.stub";

const chipProps = { timezone: TZ, viewerTimezone: TZ, density: "month" as const };

describe("CalendarChip", () => {
  it("published: status fill + bar, accessible name '{time} {title}'", () => {
    render(<CalendarChip {...chipProps} mode="internal" item={event({ id: "a", title: "Jazz Night" })} />);
    const chip = screen.getByTestId("calendar-event-chip-a");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("aria-label")).toBe("8:00 PM Jazz Night");
    expect(chip.getAttribute("data-status")).toBe("PUBLISHED");
    expect(chip.style.background).toContain("accentSoft");
    expect(chip.style.borderLeft).toContain("3px solid");
    expect(chip.textContent).toContain("8:00 PM");
    expect(chip.textContent).toContain("Jazz Night");
  });

  it("draft uses the muted fill; series and occurrence show the repeat glyph; conflict shows a warning", () => {
    render(
      <>
        <CalendarChip {...chipProps} mode="internal" item={event({ id: "d", status: "DRAFT" })} />
        <CalendarChip {...chipProps} mode="internal" item={event({ id: "s", seriesId: "s1", conflict: true })} />
        <CalendarChip {...chipProps} mode="internal" item={event({ id: "o", occurrence: { index: 2, total: 6 } })} />
      </>,
    );
    expect(screen.getByTestId("calendar-event-chip-d").style.background).toContain("surfaceMuted");
    const s = screen.getByTestId("calendar-event-chip-s");
    expect(s.getAttribute("data-conflict")).toBe("true");
    // Inset ring, never `outline` — the focus-visible ring must survive.
    expect(s.style.boxShadow).toContain("inset 0 0 0 1px");
    expect(s.style.outline).toBe("");
    expect(s.querySelector('[aria-label="Double-booked"]')).toBeTruthy();
    expect(s.querySelectorAll("[data-icon]")).toHaveLength(2);
    expect(screen.getByTestId("calendar-event-chip-o").querySelectorAll("[data-icon]")).toHaveLength(1);
  });

  it("unconfirmed: no fill, dashed outline, muted text and an Unconfirmed kicker", () => {
    render(<CalendarChip {...chipProps} mode="internal" item={event({ id: "u", venueConfirmed: false })} />);
    const chip = screen.getByTestId("calendar-event-chip-u");
    expect(chip.getAttribute("data-unconfirmed")).toBe("true");
    expect(chip.style.background).toBe("transparent");
    expect(chip.style.border).toContain("dashed");
    expect(screen.getByTestId("calendar-event-chip-u-unconfirmed").textContent).toBe("Unconfirmed");
  });

  it("timezone mismatch adds the globe with the venue-local time", () => {
    const ny = event({ id: "ny", timezone: "America/New_York", startsAt: at(9, 5, 21, 0, "America/New_York") });
    render(<CalendarChip {...chipProps} mode="internal" item={ny} />);
    const chip = screen.getByTestId("calendar-event-chip-ny");
    expect(chip.querySelector('[aria-label="Local time at the place: 9:00 PM EDT"]')).toBeTruthy();
    expect(chip.textContent).toContain("8:00 PM");
  });

  // Sold out mutes the FRAME, never the words. The chip carried
  // `opacity: 0.55` in calendar.css, which took its 12px semibold title to
  // 3.77:1 on paper — below AA, on a third-party page (this rule is public
  // mode only). The bar and tint go neutral instead.
  it("sold out mutes the frame with a tag in public mode only", () => {
    const so = event({ id: "so", ticketsSold: 200, totalCapacity: 200 });
    const { rerender } = render(<CalendarChip {...chipProps} mode="public" item={so} />);
    const chip = screen.getByTestId("calendar-event-chip-so");
    expect(chip.getAttribute("data-sold-out")).toBe("true");
    expect(chip.textContent).toContain("Sold out");
    const style = chip.getAttribute("style") ?? "";
    expect(style).toContain("--colorMuted");
    expect(style).not.toContain("--accent");
    rerender(<CalendarChip {...chipProps} mode="internal" item={so} />);
    const internal = screen.getByTestId("calendar-event-chip-so");
    expect(internal.getAttribute("data-sold-out")).toBeNull();
    expect(internal.getAttribute("style") ?? "").toContain("--accent");
  });

  it("hold chips: dashed active, warning + glyph when challenged, solid when confirmed", () => {
    render(
      <>
        <CalendarChip {...chipProps} mode="internal" item={hold({ id: "a", position: 2 })} />
        <CalendarChip {...chipProps} mode="internal" item={hold({ id: "c", position: 2, status: "CHALLENGED" })} />
        <CalendarChip {...chipProps} mode="internal" item={hold({ id: "k", position: 1, status: "CONFIRMED" })} />
      </>,
    );
    const a = screen.getByTestId("calendar-hold-chip-a");
    expect(a.style.border).toContain("dashed");
    expect(a.textContent).toContain("Hold · #2");
    const c = screen.getByTestId("calendar-hold-chip-c");
    expect(c.style.border).toContain("warning");
    expect(c.querySelector('[aria-label="Challenged"]')).toBeTruthy();
    expect(screen.getByTestId("calendar-hold-chip-c-row").textContent).toBe("#2 · Challenged");
    const k = screen.getByTestId("calendar-hold-chip-k");
    expect(k.style.border).toContain("solid");
    expect(k.textContent).toContain("#1 · Confirmed");
  });

  it("a challenged hold carries its respond-by on the chip (FR-016)", () => {
    render(
      <CalendarChip
        {...chipProps}
        mode="internal"
        item={hold({ id: "c", position: 2, status: "CHALLENGED", respondBy: at(9, 4, 17) })}
      />,
    );
    expect(screen.getByTestId("calendar-hold-chip-c-row").textContent).toBe("#2 · Fri · 5:00 PM");
    expect(screen.getByTestId("calendar-hold-chip-c").querySelector('[aria-label="Challenged"]')).toBeTruthy();
  });

  it("reports the item, its element and the render key on press; haspopup only when a peek can open", () => {
    const onPress = vi.fn();
    const item = event({ id: "p" });
    const { rerender } = render(
      <CalendarChip {...chipProps} mode="internal" item={item} onPress={onPress} />,
    );
    const bare = screen.getByTestId("calendar-event-chip-p");
    expect(bare.getAttribute("aria-haspopup")).toBeNull();
    expect(bare.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(bare);
    expect(onPress).toHaveBeenCalledWith(item, expect.any(HTMLButtonElement), "p");
    rerender(
      <CalendarChip {...chipProps} mode="internal" item={item} onPress={onPress} renderKey="2026-09-05:p" hasPopup testId="calendar-event-chip-p-2026-09-05" />,
    );
    const keyed = screen.getByTestId("calendar-event-chip-p-2026-09-05");
    expect(keyed.getAttribute("aria-haspopup")).toBe("dialog");
    expect(keyed.getAttribute("aria-expanded")).toBe("false");
    expect(keyed.getAttribute("data-render-key")).toBe("2026-09-05:p");
    fireEvent.click(keyed);
    expect(onPress).toHaveBeenLastCalledWith(item, expect.any(HTMLButtonElement), "2026-09-05:p");
  });

  it("paints the labels it is given", () => {
    render(
      <CalendarLabelsProvider
        value={{ ...DEFAULT_CALENDAR_LABELS, holdTag: (n) => `Reserva · #${n}`, soldOut: "Agotado" }}
      >
        <CalendarChip {...chipProps} mode="internal" item={hold({ id: "h", position: 3 })} />
        <CalendarChip {...chipProps} mode="public" item={event({ id: "so", ticketsSold: 1, totalCapacity: 1 })} />
      </CalendarLabelsProvider>,
    );
    expect(screen.getByTestId("calendar-hold-chip-h").textContent).toContain("Reserva · #3");
    expect(screen.getByTestId("calendar-hold-chip-h").getAttribute("aria-label")).toContain("Reserva · #3");
    expect(screen.getByTestId("calendar-event-chip-so").textContent).toContain("Agotado");
  });
});

describe("CalendarPeek", () => {
  const rich = event({
    id: "e",
    title: "Jazz Night",
    venueName: "Drkmttr",
    ownerName: "Night Owls",
    ticketsSold: 148,
    totalCapacity: 200,
    occurrence: { index: 2, total: 6 },
    seriesId: "s1",
    seriesName: "Friday Jazz",
    href: { edit: "/edit/e", public: "/events/e", series: "/series/s1", booking: "/bookings/b1" },
  });
  const base = { anchorElement: null, timezone: TZ, viewerTimezone: TZ, onClose: vi.fn() };

  it("closed: renders nothing — the chip it belongs to is never mounted here", () => {
    const { container } = render(
      <CalendarPeek {...base} item={rich} open={false} variant="dashboard" />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("event peek: kicker, title, key/values, and the actions — Edit routes to the series editor", () => {
    const onDownloadIcs = vi.fn();
    render(<CalendarPeek {...base} item={rich} open variant="dashboard" onDownloadIcs={onDownloadIcs} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("#" + CSS.escape(dialog.getAttribute("aria-labelledby")!))?.id);
    expect(screen.getByTestId("calendar-peek-kicker").textContent).toBe("Sat · Sep 5 · 8:00 – 11:00 PM");
    expect(dialog.textContent).toContain("Jazz Night");
    expect(dialog.textContent).toContain("Drkmttr");
    expect(screen.getByTestId("calendar-peek-sold").textContent).toBe("148 / 200");
    expect(screen.getByTestId("calendar-peek-occurrence").textContent).toBe("2 of 6");
    expect(screen.getByTestId("calendar-peek-series").getAttribute("href")).toBe("/series/s1");
    expect(dialog.textContent).toContain("Night Owls");
    expect(screen.getByTestId("calendar-peek-edit").getAttribute("href")).toBe("/series/s1");
    expect(screen.getByTestId("calendar-peek-public").getAttribute("href")).toBe("/events/e");
    expect(screen.getByTestId("calendar-peek-copy").getAttribute("aria-label")).toBe("Copy link");
    fireEvent.click(screen.getByTestId("calendar-peek-ics"));
    expect(onDownloadIcs).toHaveBeenCalledWith(rich);
    expect(screen.queryByTestId("calendar-peek-booking")).toBeNull();
    expect(screen.queryByTestId("calendar-peek-local")).toBeNull();
    expect(document.activeElement).toBe(dialog);
  });

  it("Edit falls back to the event editor without a series; place variant adds Open booking; Going for RSVP", () => {
    const plain = event({ id: "p", ticketsSold: 12, totalCapacity: null, href: { edit: "/edit/p", booking: "/bookings/b" } });
    render(<CalendarPeek {...base} item={plain} open variant="place" />);
    expect(screen.getByTestId("calendar-peek-edit").getAttribute("href")).toBe("/edit/p");
    expect(screen.getByTestId("calendar-peek-booking").getAttribute("href")).toBe("/bookings/b");
    expect(screen.getByRole("dialog").textContent).toContain("Going");
    expect(screen.getByTestId("calendar-peek-sold").textContent).toBe("12");
    expect(screen.queryByTestId("calendar-peek-public")).toBeNull();
    expect(screen.queryByTestId("calendar-peek-ics")).toBeNull();
  });

  it("shows the venue-local row on a zone mismatch", () => {
    const ny = event({ id: "ny", timezone: "America/New_York", startsAt: at(9, 5, 21, 0, "America/New_York"), endsAt: null });
    render(<CalendarPeek {...base} item={ny} open variant="dashboard" />);
    expect(screen.getByTestId("calendar-peek-local").textContent).toBe("9:00 PM EDT");
  });

  it("hold peek: the line with respond-by / placed stamps and a single Open booking action", () => {
    const item = hold({
      id: "h",
      position: 2,
      status: "CHALLENGED",
      spaceName: "Main Room",
      bookingHref: "/bookings/x",
      lineMates: [
        { position: 1, title: "The Quiet Ones", status: "ACTIVE", placedAt: at(8, 28, 10) },
        { position: 2, title: "Act h", status: "CHALLENGED", respondBy: at(9, 4, 17) },
      ],
    });
    render(<CalendarPeek {...base} item={item} open variant="place" />);
    const dialog = screen.getByRole("dialog");
    expect(screen.getByTestId("calendar-peek-kicker").textContent).toBe("Sat · Sep 5 · Main Room");
    expect(dialog.textContent).toContain("Hold line");
    expect(dialog.textContent).toContain("2 holds");
    expect(screen.getByTestId("calendar-peek-hold-1").textContent).toContain("Placed Aug 28");
    expect(screen.getByTestId("calendar-peek-hold-2").textContent).toContain("Respond by Fri · 5:00 PM");
    expect(screen.getByTestId("calendar-peek-hold-2").querySelector('[data-hold-status="CHALLENGED"]')?.textContent).toBe("Challenged");
    expect(screen.getByTestId("calendar-peek-booking").getAttribute("href")).toBe("/bookings/x");
    expect(screen.queryByTestId("calendar-peek-edit")).toBeNull();
    expect(screen.queryByTestId("calendar-peek-copy")).toBeNull();
    expect(screen.queryByTestId("calendar-peek-ics")).toBeNull();
  });

  it("Escape closes; focus returns to the chip on unmount; sheet mode renders a bottom sheet", () => {
    const onClose = vi.fn();
    const chip = document.createElement("button");
    document.body.appendChild(chip);
    const { rerender, unmount } = render(
      <CalendarPeek {...base} onClose={onClose} returnFocusTo={chip} item={rich} open variant="dashboard" />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<CalendarPeek {...base} onClose={onClose} returnFocusTo={chip} item={rich} open sheet variant="dashboard" />);
    expect(screen.getByTestId("bottom-sheet").querySelector('[role="dialog"]')).toBeTruthy();
    unmount();
    expect(document.activeElement).toBe(chip);
    chip.remove();
  });

  it("returns focus only when the peek still held it, resolving a function target at close time", () => {
    const chip = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(chip, elsewhere);
    const target = vi.fn(() => chip);
    const { unmount } = render(
      <CalendarPeek {...base} returnFocusTo={target} item={rich} open variant="dashboard" />,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    unmount();
    expect(document.activeElement).toBe(elsewhere);
    expect(target).not.toHaveBeenCalled();

    const second = render(
      <CalendarPeek {...base} returnFocusTo={target} item={rich} open variant="dashboard" />,
    );
    second.unmount();
    expect(target).toHaveBeenCalled();
    expect(document.activeElement).toBe(chip);
    chip.remove();
    elsewhere.remove();
  });

  it("a rejected clipboard write shows nothing; the copied flash timer is cleared on unmount", async () => {
    const writeText = vi.fn<[string], Promise<void>>(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    try {
      const { unmount } = render(<CalendarPeek {...base} item={rich} open variant="dashboard" />);
      const baseline = vi.getTimerCount();
      await act(async () => {
        fireEvent.click(screen.getByTestId("calendar-peek-copy"));
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/events/e`);
      expect(screen.getByTestId("calendar-peek-copy").getAttribute("aria-label")).toBe("Copy link");
      expect(vi.getTimerCount()).toBe(baseline);

      writeText.mockImplementation(() => Promise.resolve());
      await act(async () => {
        fireEvent.click(screen.getByTestId("calendar-peek-copy"));
        await Promise.resolve();
      });
      expect(screen.getByTestId("calendar-peek-copy").getAttribute("aria-label")).toBe("Copied");
      expect(vi.getTimerCount()).toBe(baseline + 1);
      unmount();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });
});
