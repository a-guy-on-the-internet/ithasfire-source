/**
 * The create affordance is REMOVED AT REST, not removed.
 *
 * 42 evenly-spaced "+" glyphs in the month grid, and seven more across the
 * week header, laid a second rhythm of controls over a surface meant to read
 * as content — and each month one claimed ~28px at the bottom of its cell, so
 * every week row was inflated and the grid ran ~170px past its canvas.
 *
 * What could NOT change: the buttons stay in the DOM, in the tab order, and
 * keep their date-bearing accessible name (e2e asserts it). So the assertions
 * split in two:
 *   - the DOM half runs against the rendered views;
 *   - the "invisible at rest" half runs against `calendar.css`, because
 *     nothing in this suite loads a stylesheet — a `getComputedStyle` check in
 *     jsdom would report `opacity: ""` and pass no matter what the file says.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);

import { CalendarMonthView } from "../CalendarMonthView";
import { CalendarWeekView } from "../CalendarWeekView";
import { getMonthGridWeeks, getWeekDays, groupByDay } from "../helpers";
import { TZ, at, event } from "./fixtures.stub";

const anchor = at(9, 2, 12);
const weeks = getMonthGridWeeks(anchor, TZ);
const weekDays = getWeekDays(anchor, TZ);
const items = [
  event({ id: "a", startsAt: at(9, 5, 18), endsAt: at(9, 5, 19) }),
  event({ id: "b", startsAt: at(9, 5, 19), endsAt: at(9, 5, 20) }),
];
const itemsByDay = groupByDay(items, weeks.flat());

const renderMonth = (props: Record<string, unknown> = {}) =>
  render(
    <CalendarMonthView
      weeks={weeks}
      month={9}
      todayKey="2026-09-02"
      itemsByDay={itemsByDay}
      timezone={TZ}
      viewerTimezone={TZ}
      mode="internal"
      onCreateAt={vi.fn()}
      {...props}
    />,
  );

// ── the stylesheet contract ────────────────────────────────────────────────

// `import.meta.url` is not a file: URL under this vitest transform, and the
// web suite is pinned to run from `apps/web` (vitest.config.ts), so the path
// comes off the cwd.
const CSS_PATH = join(
  process.cwd(),
  "src/app/admin/[slug]/_components/calendar/calendar.css",
);
const CSS = readFileSync(CSS_PATH, "utf8")
  // Comments carry the word "opacity" in prose; strip them before matching.
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The declaration body of the rule whose selector LIST contains `selector`
 * exactly. Nested `@media` rules fall out of this for free: the prelude has no
 * declaration block of its own, so only the inner rules match.
 */
function declarationsFor(selector: string): string {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find((rule) =>
    rule[1]!
      .split(",")
      .map((part) => part.trim())
      .includes(selector),
  );
  if (!hit) throw new Error(`calendar.css has no rule for "${selector}"`);
  return hit[2]!;
}

const declares = (selector: string, property: string, value: string) =>
  new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(declarationsFor(selector));

describe("create affordance — hidden at rest", () => {
  it("calendar.css hides both variants at rest", () => {
    expect(declares(".th-cal-create", "opacity", "0")).toBe(true);
    expect(declares(".th-cal-create", "pointer-events", "none")).toBe(true);
  });

  it("the month variant is out of flow, so the cell owes it no height", () => {
    expect(declares(".th-cal-cell .th-cal-create", "position", "absolute")).toBe(true);
  });

  it("hover on the cell / week header and the button's own focus reveal it", () => {
    for (const selector of [
      ".th-cal-cell:hover .th-cal-create",
      ".th-cal-weekhead:hover .th-cal-create",
      ".th-cal-create:focus-visible",
    ]) {
      expect(declares(selector, "opacity", "1"), selector).toBe(true);
      expect(declares(selector, "pointer-events", "auto"), selector).toBe(true);
    }
  });

  it("the hover reveal is gated on a hovering pointer; focus-visible is not", () => {
    // Sticky hover on a touch device would paint a glyph the reader cannot
    // dismiss; the keyboard path has to work on every device regardless.
    const hoverGate = CSS.slice(CSS.indexOf("@media (hover: hover)"));
    expect(hoverGate).toContain(".th-cal-cell:hover .th-cal-create");
    expect(CSS.indexOf(".th-cal-create:focus-visible")).toBeGreaterThan(
      CSS.indexOf(".th-cal-cell:hover .th-cal-create"),
    );
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("create affordance — still in the DOM and the tab order", () => {
  it("every month cell keeps its button, its test id and its dated name", () => {
    const { container } = renderMonth();
    const buttons = container.querySelectorAll<HTMLButtonElement>(".th-cal-create");
    expect(buttons).toHaveLength(42);
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      // Focusable: no tabindex="-1", no `disabled`, no `aria-hidden`.
      expect(button.getAttribute("tabindex")).toBeNull();
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-hidden")).toBeNull();
      expect(button.getAttribute("aria-label")).toMatch(/^Create event on /);
    }
    expect(
      screen.getByTestId("calendar-day-create-2026-09-05").getAttribute("aria-label"),
    ).toBe("Create event on September 5");
  });

  it("a populated cell keeps its button too, and it still creates when pressed", () => {
    const onCreateAt = vi.fn();
    renderMonth({ onCreateAt });
    const button = screen.getByTestId("calendar-day-create-2026-09-05");
    expect(button.closest('[data-testid="calendar-day-2026-09-05"]')).not.toBeNull();
    fireEvent.click(button);
    expect(onCreateAt).toHaveBeenCalledTimes(1);
    expect(onCreateAt).toHaveBeenCalledWith(at(9, 5, 0));
  });

  it("the week header keeps one per column, inside a hover-scoped header", () => {
    const { container } = render(
      <CalendarWeekView
        days={weekDays}
        todayKey="2026-09-02"
        now={null}
        items={[]}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        showAllHours
        onCreateAt={vi.fn()}
      />,
    );
    const heads = container.querySelectorAll(".th-cal-weekhead");
    expect(heads).toHaveLength(7);
    for (const head of heads) {
      const button = head.querySelector<HTMLButtonElement>(".th-cal-create");
      expect(button).not.toBeNull();
      expect(button!.getAttribute("data-inline")).toBe("true");
      expect(button!.getAttribute("aria-label")).toMatch(/^Create event on /);
    }
  });

  it("public mode still paints neither", () => {
    const { container } = renderMonth({ mode: "public" });
    expect(container.querySelectorAll(".th-cal-create")).toHaveLength(0);
  });
});
