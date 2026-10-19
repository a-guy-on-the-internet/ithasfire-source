import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * THE GRID SAYS IT OUT LOUD.
 *
 * The month's cues are visual — an ink fill, a hatch, a corner notch, a row of
 * ticks, an accent selection. This suite is the contract that none of them is
 * ONLY visual: every one has a sentence in the cell's accessible name, and the
 * offered position — the fact the whole control exists to surface — is in
 * there before anything is clicked.
 *
 * The catalog is stubbed with the PROPOSED English so the assertions read as
 * the sentence a screen reader speaks, not as a key.
 */

const EN: Record<string, string> = {
  "admin.bkHoldPickGridLabel": "{month} — pick dates to hold",
  "admin.bkHoldPickDayPast": "in the past",
  "admin.bkHoldPickDayDarkFree": "dark — this act would be 1st",
  "admin.bkHoldPickDayDarkLine":
    "dark — {count} holds, this act would be {position}",
  "admin.bkHoldPickDayTaken": "{label} has the night",
  "admin.bkHoldPickDayTakenUnnamed": "the night is taken",
  "admin.bkHoldPickDayHeld": "already held for this act, {position} in line",
  "admin.bkHoldPickDayOpen": "open, this act would be 1st",
  "admin.bkHoldPickDayLine": "{count} holds, this act would be {position}",
  "admin.bkHoldPickDayChallenged": "One hold is on the reply clock",
  "admin.bkHoldPickDayAsked": "The act asked for this date",
  "admin.bkHoldPickDayFailed": "The last attempt was refused on this date",
  "admin.bkHoldPickShortDark": "Dark",
  "admin.bkHoldPickShortTaken": "Taken",
  "admin.bkHoldPickShortHeld": "Held",
  "admin.bkHoldPickShortOffer": "→ {position}",
  "admin.bkHoldPosition1": "1st",
  "admin.bkHoldPosition2": "2nd",
  "admin.bkHoldPosition3": "3rd",
  "admin.bkHoldPositionNth": "{position}th",
};

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const raw = EN[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ""));
  },
  useFormatters: () => ({
    locale: "en-US",
    dateTime: (value: Date | string, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(new Date(value)),
  }),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { Bookmark: Icon, Check: Icon, Lock: Icon };
});

import type { CalendarHold } from "@/app/admin/[slug]/_components/event-calendar-types";

import { HoldMonthGrid } from "../HoldMonthGrid";
import {
  buildHoldMonth,
  EMPTY_HOLD_SELECTION,
  toggleHoldDate,
  type HoldMonthInput,
} from "../hold-date-grid";

const REQUEST = "req-1";

const hold = (over: Partial<CalendarHold> & Pick<CalendarHold, "date" | "position">): CalendarHold => ({
  id: `h-${over.date}-${over.position}`,
  bookingRequestId: "req-other",
  calendarId: "cal-1",
  spaceId: null,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  actName: "Marrow Twin",
  performerDisplayName: null,
  ...over,
});

function monthInput(over: Partial<HoldMonthInput> = {}): HoldMonthInput {
  return {
    year: 2026,
    month: 9, // October 2026
    today: "2026-10-06",
    bookingRequestId: REQUEST,
    holds: [
      hold({ date: "2026-10-16", position: 1 }),
      hold({ date: "2026-10-16", position: 2, status: "CHALLENGED" }),
      hold({ date: "2026-10-08", position: 1, bookingRequestId: REQUEST }),
    ],
    closedDates: new Set(["2026-10-12"]),
    takenDates: new Map([["2026-10-17", "Palegrass"]]),
    preferredDates: new Set(["2026-10-16"]),
    ...over,
  };
}

function renderGrid(over: Partial<HoldMonthInput> = {}, selectedDate?: string) {
  const month = buildHoldMonth(monthInput(over));
  const selection = selectedDate
    ? toggleHoldDate(EMPTY_HOLD_SELECTION, month.byDate.get(selectedDate)!)
    : EMPTY_HOLD_SELECTION;
  const onActivate = vi.fn();
  const onNavigate = vi.fn();
  render(
    <HoldMonthGrid
      month={month}
      selection={selection}
      focusDate="2026-10-16"
      focusNonce={0}
      failedDates={new Set()}
      onNavigate={onNavigate}
      onActivate={onActivate}
      testIdBase="pick"
    />,
  );
  return { onActivate, onNavigate };
}

const nameOf = (date: string) =>
  screen.getByTestId(`pick-day-${date}`).getAttribute("aria-label");

describe("HoldMonthGrid — the accessible name carries every cue", () => {
  it("an OPEN night says the position it would take", () => {
    renderGrid();
    expect(nameOf("2026-10-15")).toBe(
      "Thursday, October 15 — open, this act would be 1st",
    );
  });

  it("a night with a LINE names the depth AND the offer, before any click", () => {
    renderGrid();
    expect(nameOf("2026-10-16")).toBe(
      "Friday, October 16 — 2 holds, this act would be 3rd. " +
        "One hold is on the reply clock. The act asked for this date",
    );
  });

  it("a BOOKED night says who has it, not just that it is unavailable", () => {
    renderGrid();
    expect(nameOf("2026-10-17")).toBe(
      "Saturday, October 17 — Palegrass has the night",
    );
  });

  it("a DARK night LEADS with the warning, then still states the offer", () => {
    renderGrid();
    expect(nameOf("2026-10-12")).toBe(
      "Monday, October 12 — dark — this act would be 1st",
    );
  });

  it("a DARK night with a line names the depth too", () => {
    renderGrid({
      closedDates: new Set(["2026-10-16"]),
      preferredDates: new Set(),
    });
    expect(nameOf("2026-10-16")).toBe(
      "Friday, October 16 — dark — 2 holds, this act would be 3rd. " +
        "One hold is on the reply clock",
    );
  });

  it("a night this request already holds says so, with its place", () => {
    renderGrid();
    expect(nameOf("2026-10-08")).toBe(
      "Thursday, October 8 — already held for this act, 1st in line",
    );
  });

  it("a PAST day says it is past", () => {
    renderGrid();
    expect(nameOf("2026-10-01")).toBe("Thursday, October 1 — in the past");
  });
});

describe("HoldMonthGrid — state is never colour alone", () => {
  it("carries aria-pressed on every holdable night — DARK included — and nothing on the rest", () => {
    renderGrid({}, "2026-10-15");
    expect(screen.getByTestId("pick-day-2026-10-15").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("pick-day-2026-10-16").getAttribute("aria-pressed")).toBe("false");
    // Dark is a warning, not a wall: pressable, and not aria-disabled.
    expect(screen.getByTestId("pick-day-2026-10-12").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("pick-day-2026-10-12").getAttribute("aria-disabled")).toBeNull();
    // Past, taken, and a night this request already holds are hard-blocked.
    for (const date of ["2026-10-01", "2026-10-17", "2026-10-08"]) {
      expect(screen.getByTestId(`pick-day-${date}`).getAttribute("aria-pressed")).toBeNull();
      expect(screen.getByTestId(`pick-day-${date}`).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("prints the offer in the cell for a night with a line, and stays quiet on an empty one", () => {
    renderGrid();
    expect(screen.getByTestId("pick-day-2026-10-16").textContent).toContain("→ 3rd");
    expect(screen.getByTestId("pick-day-2026-10-15").textContent).toBe("15");
    expect(screen.getByTestId("pick-day-2026-10-17").textContent).toContain("Taken");
    expect(screen.getByTestId("pick-day-2026-10-12").textContent).toContain("Dark");
  });
});

describe("HoldMonthGrid — one tab stop, and the keys that move it", () => {
  it("puts exactly one cell in the tab order", () => {
    renderGrid();
    const tabbable = document.querySelectorAll('[data-date][tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    expect((tabbable[0] as HTMLElement).dataset.date).toBe("2026-10-16");
  });

  it("moves by day, week, week-end and month — and crosses the month boundary", () => {
    const { onNavigate } = renderGrid();
    const cell = screen.getByTestId("pick-day-2026-10-16");
    const press = (key: string, shiftKey = false) =>
      fireEvent.keyDown(cell, { key, shiftKey });

    press("ArrowLeft");
    press("ArrowDown");
    press("Home");
    press("End");
    press("PageDown");
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual([
      "2026-10-15",
      "2026-10-23",
      "2026-10-11",
      "2026-10-17",
      "2026-11-16",
    ]);

    press("ArrowRight", true);
    expect(onNavigate.mock.calls.at(-1)).toEqual(["2026-10-17", true]);
  });

  it("Space and Enter toggle; Shift carries the range intent", () => {
    const { onActivate } = renderGrid();
    const cell = screen.getByTestId("pick-day-2026-10-16");
    fireEvent.keyDown(cell, { key: " " });
    fireEvent.keyDown(cell, { key: "Enter", shiftKey: true });
    expect(onActivate.mock.calls).toEqual([
      ["2026-10-16", false],
      ["2026-10-16", true],
    ]);
  });

  it("a click on a night the SERVER refuses does nothing; a dark night is taken", () => {
    const { onActivate } = renderGrid();
    fireEvent.click(screen.getByTestId("pick-day-2026-10-17")); // taken
    fireEvent.click(screen.getByTestId("pick-day-2026-10-01")); // past
    fireEvent.click(screen.getByTestId("pick-day-2026-10-08")); // already ours
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pick-day-2026-10-12")); // dark, allowed
    fireEvent.click(screen.getByTestId("pick-day-2026-10-15"));
    expect(onActivate.mock.calls).toEqual([
      ["2026-10-12", false],
      ["2026-10-15", false],
    ]);
  });

  it("keeps the word Dark in the cell rather than the offer — the offer is in the name", () => {
    renderGrid({}, "2026-10-12");
    const dark = screen.getByTestId("pick-day-2026-10-12");
    expect(dark.textContent).toContain("Dark");
    expect(dark.textContent).not.toContain("→");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(dark.getAttribute("data-status")).toBe("dark");
  });
});

describe("HoldMonthGrid — a month of identical dark cells drops the word, not the marks", () => {
  const ALL_OCTOBER = new Set(
    Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`),
  );

  it("suppresses the per-cell word when EVERY day is dark — hatch and name stay", () => {
    renderGrid({
      holds: [],
      takenDates: new Map(),
      preferredDates: new Set(),
      closedDates: ALL_OCTOBER,
    });
    const cell = screen.getByTestId("pick-day-2026-10-16");
    // The WORD is gone (31 repetitions carry no information)…
    expect(cell.textContent).toBe("16");
    // …but nothing else is: the hatch hook, the accessible warning and the
    // pressability all survive.
    expect(cell.getAttribute("data-status")).toBe("dark");
    expect(cell.getAttribute("aria-label")).toBe(
      "Friday, October 16 — dark — this act would be 1st",
    );
    expect(cell.getAttribute("aria-pressed")).toBe("false");
  });

  it("still suppresses when the only other days are PAST — the visible field is uniform", () => {
    // today = 2026-10-06: days 1–5 are past (no word of their own), the rest dark.
    renderGrid({
      holds: [],
      takenDates: new Map(),
      preferredDates: new Set(),
      closedDates: new Set(
        Array.from({ length: 26 }, (_, i) => `2026-10-${String(i + 6).padStart(2, "0")}`),
      ),
    });
    expect(screen.getByTestId("pick-day-2026-10-16").textContent).toBe("16");
    expect(screen.getByTestId("pick-day-2026-10-01").textContent).toBe("1");
  });

  it("the word RETURNS the moment one day differs", () => {
    const oneTaken = new Set(ALL_OCTOBER);
    renderGrid({
      holds: [],
      preferredDates: new Set(),
      takenDates: new Map([["2026-10-17", "Palegrass"]]),
      closedDates: oneTaken,
    });
    expect(screen.getByTestId("pick-day-2026-10-16").textContent).toContain("Dark");
    expect(screen.getByTestId("pick-day-2026-10-17").textContent).toContain("Taken");
  });
});
