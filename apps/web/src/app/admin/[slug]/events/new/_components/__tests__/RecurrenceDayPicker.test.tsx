/**
 * "Repeat on" weekday chips in the RecurrenceBuilder's Custom panel.
 *
 * The event's own weekday is pinned into every weekly BYDAY set — the backend
 * rejects a schedule that excludes the event's own start
 * (EVENT_START_NOT_IN_SCHEDULE, convert-event-to-series.ts:380). That
 * constraint is real; the DEFECT this suite pins is that the chip used to
 * refuse the click SILENTLY (no lock affordance, no explanation), so an
 * organizer whose show is on a Wednesday just saw a dead Wednesday button.
 *
 * Mocks are enumerated one module at a time on purpose: a catch-all Proxy
 * mock answers `then`, which makes the module namespace a thenable and hangs
 * vitest forever.
 */
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import enMessages from "@/i18n/messages/en";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: (_base: unknown, config?: { tag?: string }) =>
      makeStack(config?.tag === "button" ? "button" : "div"),
    useTheme: () => ({ colorMuted: { val: "#6B6259" } }),
  };
});

// `aria-hidden` is forwarded on purpose: the lock glyph must be invisible to
// assistive tech (the chip's aria-label already says "always included"), and a
// mock that dropped it would let a regression through — the accessible-name
// assertion below passes either way, because aria-label overrides content.
vi.mock("lucide-react", async () => {
  const React = await import("react");
  const Glyph =
    (name: string) =>
    ({
      "data-testid": testId,
      "aria-hidden": ariaHidden,
    }: {
      "data-testid"?: string;
      "aria-hidden"?: boolean;
    }) =>
      React.createElement("span", {
        "data-icon": name,
        ...(testId ? { "data-testid": testId } : {}),
        ...(ariaHidden ? { "aria-hidden": "true" } : {}),
      });
  return { Repeat: Glyph("repeat"), Info: Glyph("info"), Lock: Glyph("lock") };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (/^(data-|aria-)|^id$/.test(key)) domProps[key] = value;
    }
    return React.createElement("span", domProps, children);
  };
  const NextLinkAnchor = ({ children }: { children?: ReactNode }) =>
    React.createElement("a", null, children);
  return {
    Text,
    NextLinkAnchor,
    useTranslations: () => translate,
    useFormatters: () => ({
      dateTime: (d: Date, opts?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", opts).format(d),
    }),
  };
});

vi.mock("../_form-bits", async () => {
  const React = await import("react");
  return {
    FieldLabel: ({ children }: { children?: ReactNode }) =>
      React.createElement("label", null, children),
    NativeDateTimeInput: (props: Record<string, unknown>) =>
      React.createElement("input", props),
  };
});

// ── Minimal ICU-ish translator over the real en catalog keys we touch ──────

// The catalog is typed as a nested `MessageNode` tree (string | subtree), so a
// leaf read needs the same narrowing every other catalog-reading test uses.
const EN_ADMIN = (enMessages as unknown as { admin: Record<string, string> })
  .admin;

const MESSAGES: Record<string, string> = {
  "admin.rbRepeats": "Repeats",
  "admin.rbDoesNotRepeat": "Doesn't repeat",
  "admin.rbPresetWeekly": "Every {weekday}",
  "admin.rbPresetBiweekly": "Every other {weekday}",
  "admin.rbPresetMonthly": "Monthly on the {ordinal} {weekday}",
  "admin.rbCustom": "Custom…",
  "admin.rbRepeatEvery": "Repeat every",
  "admin.rbRepeatOn": "Repeat on",
  "admin.rbMon": "Mon",
  "admin.rbTue": "Tue",
  "admin.rbWed": "Wed",
  "admin.rbThu": "Thu",
  "admin.rbFri": "Fri",
  "admin.rbSat": "Sat",
  "admin.rbSun": "Sun",
  // Read from the REAL catalog rather than hand-copied. These two strings are
  // the lock affordance's entire explanation, and a copy that drifts from
  // en.ts is green by construction while the shipped copy says something else
  // — which is exactly how "…to repeat on other days only" survived long
  // enough to be found by driving the app.
  "admin.rbDayAlwaysIncluded": EN_ADMIN.rbDayAlwaysIncluded!,
  "admin.rbDayAlwaysIncludedNote": EN_ADMIN.rbDayAlwaysIncludedNote!,
};

function translate(key: string, args?: Record<string, unknown>): string {
  const template = MESSAGES[key] ?? key;
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in args ? String(args[name]) : whole,
  );
}

// ── Subject under test (imported AFTER the mocks are registered) ───────────

const { RecurrenceBuilder } = await import("../RecurrenceBuilder");
type RecurrenceConfig = Parameters<
  NonNullable<Parameters<typeof RecurrenceBuilder>[0]["onChange"]>
>[0];

/**
 * Mount the builder in Custom/weekly mode for a given start, returning a
 * handle over the emitted configs.
 */
function mountCustomWeekly(opts: {
  eventStartsAt?: string;
  eventTimezone?: string;
}) {
  const emitted: Array<RecurrenceConfig> = [];
  const onChange = (config: RecurrenceConfig) => emitted.push(config);
  const props = (eventStartsAt?: string) => ({
    enabled: false,
    onEnabledChange: () => {},
    value: null,
    onChange,
    eventStartsAt,
    eventTimezone: opts.eventTimezone,
  });
  const view = render(<RecurrenceBuilder {...props(opts.eventStartsAt)} />);
  fireEvent.change(screen.getByTestId("recurrence-repeats-select"), {
    target: { value: "custom" },
  });
  return {
    emitted,
    lastRrule: () => emitted[emitted.length - 1]?.rrule ?? null,
    chip: (day: string) => screen.getByTestId(`recurrence-day-${day}`),
    /** Simulate the organizer typing a start date into the builder above. */
    setEventStartsAt: (next: string) =>
      view.rerender(<RecurrenceBuilder {...props(next)} />),
  };
}

// A Wednesday in the event timezone AND in UTC (noon UTC, no basis shift).
const WEDNESDAY_UTC = "2026-08-12T12:00";

describe("RecurrenceBuilder — Repeat on weekday chips", () => {
  it("pins the event's own weekday and says so, instead of refusing silently", () => {
    const h = mountCustomWeekly({
      eventStartsAt: WEDNESDAY_UTC,
      eventTimezone: "UTC",
    });

    const wed = h.chip("we");
    expect(wed).toHaveAttribute("aria-checked", "true");

    // The lock must be VISIBLE and EXPLAINED — the original defect was a chip
    // that looked identical to every other selected chip and did nothing.
    expect(wed).toHaveAttribute("aria-disabled", "true");
    const glyph = screen.getByTestId("recurrence-day-locked-icon");
    expect(glyph).toBeInTheDocument();
    // Decorative: the chip's aria-label already carries "always included".
    expect(glyph).toHaveAttribute("aria-hidden", "true");

    const note = screen.getByTestId("recurrence-day-locked-note");
    expect(note).toHaveTextContent(
      "Wed stays selected because it’s this event’s own date.",
    );
    // …and the second sentence has to say what it means. It used to end
    // "Change the event date to repeat on other days only", which parses as
    // "repeat ONLY on other days" — the inverse of the instruction, on the one
    // caption that exists to explain a control the organizer just found
    // unresponsive. The fix is a directive clause, so the dangling modifier
    // cannot come back.
    expect(note).toHaveTextContent(
      "To repeat on a different day, change the event’s date.",
    );
    expect(note.textContent ?? "").not.toMatch(/only\.?$/i);
    expect(wed).toHaveAccessibleName("Wed, always included");
    // The explanation is ASSOCIATED, not duplicated into a keyboard- and
    // touch-invisible title tooltip.
    expect(wed).toHaveAttribute("aria-describedby", note.getAttribute("id"));
    expect(wed).not.toHaveAttribute("title");

    // Clicking it is a no-op by design (the backend rejects a schedule that
    // excludes the event's own start) — but it is now an EXPLAINED no-op.
    fireEvent.click(wed);
    expect(h.chip("we")).toHaveAttribute("aria-checked", "true");
  });

  it("toggles a non-start weekday on and back off, and the RRULE follows", () => {
    const h = mountCustomWeekly({
      eventStartsAt: WEDNESDAY_UTC,
      eventTimezone: "UTC",
    });

    fireEvent.click(h.chip("fr"));
    expect(h.chip("fr")).toHaveAttribute("aria-checked", "true");
    expect(h.lastRrule()).toBe("FREQ=WEEKLY;BYDAY=WE,FR;COUNT=12");

    // Deselecting a non-start day must actually deselect it.
    fireEvent.click(h.chip("fr"));
    expect(h.chip("fr")).toHaveAttribute("aria-checked", "false");
    expect(h.lastRrule()).toBe("FREQ=WEEKLY;BYDAY=WE;COUNT=12");
  });

  it("deselecting every day floors at the event's own weekday", () => {
    const h = mountCustomWeekly({
      eventStartsAt: WEDNESDAY_UTC,
      eventTimezone: "UTC",
    });

    for (const day of ["mo", "tu", "we", "th", "fr", "sa", "su"]) {
      fireEvent.click(h.chip(day));
      fireEvent.click(h.chip(day)); // on then off — everything but WE ends off
    }

    expect(h.chip("we")).toHaveAttribute("aria-checked", "true");
    for (const day of ["mo", "tu", "th", "fr", "sa", "su"]) {
      expect(h.chip(day)).toHaveAttribute("aria-checked", "false");
    }
    expect(h.lastRrule()).toBe("FREQ=WEEKLY;BYDAY=WE;COUNT=12");
  });

  it("seeds and pins the start weekday when a start date arrives after the set was emptied", () => {
    // The one state where the pin (and therefore the whole explanation) used
    // to switch itself off: with no start date every chip is unpinned, so a
    // day can be toggled on and back off, leaving byday empty. Entering a
    // Wednesday start then left all seven chips unchecked with no lock and no
    // caption — while the summary and the emitted FREQ=WEEKLY rule both said
    // "every Wednesday".
    const h = mountCustomWeekly({ eventTimezone: "UTC" });

    fireEvent.click(h.chip("fr"));
    fireEvent.click(h.chip("fr")); // set is now empty, nothing pinned
    expect(h.chip("fr")).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByTestId("recurrence-day-locked-note"),
    ).not.toBeInTheDocument();

    h.setEventStartsAt(WEDNESDAY_UTC);

    // The picker must now agree with the rule it emits.
    expect(h.chip("we")).toHaveAttribute("aria-checked", "true");
    expect(h.chip("we")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("recurrence-day-locked-note")).toHaveTextContent(
      "Wed stays selected because it’s this event’s own date.",
    );
    expect(h.lastRrule()).toBe("FREQ=WEEKLY;BYDAY=WE;COUNT=12");
  });

  it("an evening start emits the LOCAL weekday, not a shifted UTC token", () => {
    // Nashville Wednesday 8pm is a Thursday 01:00Z instant. The chip the
    // organizer sees locked is WED and the RRULE token is WE — one basis.
    // This used to lock WED and emit TH.
    const h = mountCustomWeekly({
      eventStartsAt: "2026-08-12T20:00",
      eventTimezone: "America/Chicago",
    });

    expect(h.chip("we")).toHaveAttribute("aria-disabled", "true");
    expect(h.chip("th")).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("recurrence-day-locked-note")).toHaveTextContent(
      /^Wed stays selected/,
    );

    fireEvent.click(h.chip("fr"));
    // The chips the organizer picked, verbatim — no shift.
    expect(h.lastRrule()).toBe("FREQ=WEEKLY;BYDAY=WE,FR;COUNT=12");
  });
});
