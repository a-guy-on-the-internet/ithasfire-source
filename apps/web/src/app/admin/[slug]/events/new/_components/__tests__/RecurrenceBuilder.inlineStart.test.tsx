/**
 * The inline start field the event builder mirrors into Settings → Scheduling.
 *
 * The event's start is what the whole rule hangs off — it pins the weekday
 * chip, sets the monthly ordinal and becomes DTSTART — so the organizer can
 * edit it from the schedule instead of scrolling back to Essentials. What this
 * suite pins is that it stays ONE field: the builder owns no start state of its
 * own, it only calls the setter it was handed, and it renders nothing at all on
 * a surface that does not hand one over (the moderator's listing schedule page,
 * which keeps its single start field).
 *
 * The REAL builder, the real `@th/ui` + Tamagui stack and the real EN
 * catalogue: a mocked builder would test the mock.
 */
import { useState, type ReactElement } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

import { RecurrenceBuilder } from "../RecurrenceBuilder";
import type { RecurrenceConfig } from "../recurrence-helpers";

const TIMEZONE = "America/Chicago";
/** A Wednesday, 8:00 PM Central — the datetime-local wall clock the input holds. */
const STARTS_AT = "2026-09-09T20:00";

const WEEKLY: RecurrenceConfig = {
  rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=8",
  dtstart: "2026-09-10T01:00:00.000Z",
};

/**
 * A leaf string from the real EN catalogue, so the accessible-name assertions
 * track a copy edit instead of freezing a sentence into this file. The narrowing
 * is needed because `MessageNode` is a recursive string-or-object union, and the
 * throw doubles as the missing-key guard.
 */
const en = (key: string): string => {
  const value = (enMessages.admin as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`admin.${key} is missing from the EN catalogue`);
  }
  return value;
};

/**
 * The builder as the event builder mounts it: ONE piece of start state, handed
 * down and edited from either place. Needed for the cases where the assertion
 * is about what the start's NEW value does to the rule, which a fixed prop
 * cannot show.
 */
function Harness({ initialStartsAt }: { initialStartsAt: string | undefined }) {
  const [startsAt, setStartsAt] = useState<string | undefined>(initialStartsAt);
  const [config, setConfig] = useState<RecurrenceConfig | null>(WEEKLY);
  return (
    <RecurrenceBuilder
      enabled
      onEnabledChange={() => {}}
      value={config}
      onChange={setConfig}
      eventStartsAt={startsAt}
      eventTimezone={TIMEZONE}
      onEventStartsAtChange={setStartsAt}
    />
  );
}

const render = (ui: ReactElement) =>
  rtlRender(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

describe("RecurrenceBuilder — inline event start", () => {
  it("is absent while the event does not repeat", () => {
    render(
      <RecurrenceBuilder
        enabled={false}
        onEnabledChange={() => {}}
        value={null}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={() => {}}
      />,
    );

    expect(screen.getByTestId("recurrence-repeats-select")).toHaveValue("none");
    expect(
      screen.queryByTestId("recurrence-event-starts-at"),
    ).not.toBeInTheDocument();
  });

  it("is absent when the caller hands over no setter, repeat or not", () => {
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={WEEKLY}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
      />,
    );

    expect(screen.getByTestId("recurrence-config")).toBeInTheDocument();
    expect(
      screen.queryByTestId("recurrence-event-starts-at"),
    ).not.toBeInTheDocument();
  });

  it("renders the event's start, labelled and described, once a repeat is picked", () => {
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={WEEKLY}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={() => {}}
      />,
    );

    const input = screen.getByTestId("recurrence-event-starts-at");
    expect(input).toHaveValue(STARTS_AT);
    expect(input).toHaveAttribute("type", "datetime-local");
    expect(input).toHaveAccessibleName(en("ebStarts"));
    expect(input).toHaveAccessibleDescription(en("rbStartsHint"));
    // An existing series can legitimately have started in the past; a `min` of
    // now would make the field unusable in edit mode.
    expect(input).not.toHaveAttribute("min");
  });

  it("reports an edit to the caller's setter instead of holding its own copy", () => {
    const onEventStartsAtChange = vi.fn();
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={WEEKLY}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={onEventStartsAtChange}
      />,
    );

    const input = screen.getByTestId("recurrence-event-starts-at");
    fireEvent.change(input, { target: { value: "2026-09-16T21:30" } });

    expect(onEventStartsAtChange).toHaveBeenCalledWith("2026-09-16T21:30");
    // The value shown is still the prop's — the parent owns the state.
    expect(input).toHaveValue(STARTS_AT);
  });

  it("reports a cleared field as undefined, not an empty string", () => {
    const onEventStartsAtChange = vi.fn();
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={WEEKLY}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={onEventStartsAtChange}
      />,
    );

    fireEvent.change(screen.getByTestId("recurrence-event-starts-at"), {
      target: { value: "" },
    });

    expect(onEventStartsAtChange).toHaveBeenCalledWith(undefined);
  });

  it("names the MISSING START, not an end date that is already set", () => {
    // Through the real loop: the mirror's setter is the parent's state, so
    // clearing the field is what leaves the builder with no dtstart. The band
    // used to answer that with "choose an end date" — while COUNT=8 was set.
    render(<Harness initialStartsAt={STARTS_AT} />);

    fireEvent.change(screen.getByTestId("recurrence-event-starts-at"), {
      target: { value: "" },
    });

    const note = screen.getByTestId("recurrence-incomplete-note");
    expect(note).toHaveTextContent(en("rbAddStartDate"));
    expect(note).not.toHaveTextContent(en("rbChooseEndDate"));
  });

  it("drops the field hint once the warning is saying the same thing", () => {
    render(<Harness initialStartsAt={STARTS_AT} />);

    // With a start, the hint is the only place that sentence appears.
    expect(
      screen.getByTestId("recurrence-event-starts-hint"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("recurrence-incomplete-note"),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("recurrence-event-starts-at"), {
      target: { value: "" },
    });

    // Cleared, the warning takes over and states it in the imperative. Two
    // lines ending "the repeat pattern is built from it" is noise exactly
    // when the one actionable instruction has to land.
    expect(
      screen.queryByTestId("recurrence-event-starts-hint"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("recurrence-incomplete-note")).toHaveTextContent(
      en("rbAddStartDate"),
    );
    // The description must drop with the node it pointed at, not dangle.
    expect(
      screen.getByTestId("recurrence-event-starts-at"),
    ).not.toHaveAttribute("aria-describedby");
  });

  it("never shows a repeat it is not holding once the start is cleared", () => {
    // The preset labels name the start's weekday ("Every Wednesday"), so they
    // unmount with the start — and a <select> whose value matches no option
    // displays its FIRST one, which read "Doesn't repeat" above a fully
    // configured series. Both halves are asserted because the bug IS the gap
    // between them: the value was still "weekly", the option was gone.
    render(<Harness initialStartsAt={STARTS_AT} />);
    const select = screen.getByTestId(
      "recurrence-repeats-select",
    ) as HTMLSelectElement;
    expect(select).toHaveValue("weekly");

    fireEvent.change(screen.getByTestId("recurrence-event-starts-at"), {
      target: { value: "" },
    });

    expect(select).toHaveValue("weekly");
    expect(Array.from(select.options).map((o) => o.value)).toContain("weekly");
    expect(select.selectedIndex).toBeGreaterThan(-1);
    // Weekday-free, since there is no weekday left to name.
    expect(select.options[select.selectedIndex]?.textContent).toBe(
      en("rbPresetWeeklyPlain"),
    );
    // Exactly one option per value, never the generic beside the specific.
    const values = Array.from(select.options).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps the end-date warning for the case it does describe", () => {
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={WEEKLY}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={() => {}}
      />,
    );
    // "On date" with no date picked: the start is fine, the end is what's
    // missing, and the original sentence is the right one.
    fireEvent.click(screen.getByTestId("recurrence-end-on"));

    expect(screen.getByTestId("recurrence-incomplete-note")).toHaveTextContent(
      en("rbChooseEndDate"),
    );
  });

  it("drops the hint for an advanced rule it would be false about", () => {
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={{ rrule: "FREQ=MONTHLY;BYDAY=2WE", dtstart: WEEKLY.dtstart }}
        onChange={() => {}}
        eventStartsAt={STARTS_AT}
        eventTimezone={TIMEZONE}
        onEventStartsAtChange={() => {}}
      />,
    );

    // A rule the builder cannot express passes through verbatim, so moving the
    // start does NOT rebuild the pattern — the hint's two sentences would both
    // be false. `rbCustomRawNote` says the rule is advanced instead.
    expect(screen.getByTestId("recurrence-custom-panel")).toBeInTheDocument();
    const input = screen.getByTestId("recurrence-event-starts-at");
    expect(input).toBeInTheDocument();
    expect(
      screen.queryByTestId("recurrence-event-starts-hint"),
    ).not.toBeInTheDocument();
    // No dangling association to an id nothing renders.
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).toHaveAccessibleDescription("");
  });
});
