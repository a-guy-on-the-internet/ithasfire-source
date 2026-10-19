/**
 * A series occurrence opened in the event builder must not change itself.
 *
 * The builder hydrates `startsAt` as a wall clock in the event's zone, then
 * prefills the schedule with `dtstart: toIsoInTimeZone(startsAt, timezone)`
 * one render later. An UNTOUCHED `RecurrenceBuilder` re-emits whenever the
 * dtstart it derives from `eventStartsAt` differs from the one it was given,
 * and any emission after the unsaved-changes baseline would make every
 * occurrence read "Unsaved changes" on open. This renders the real builder
 * with exactly the builder's prefill and proves it stays silent.
 *
 * The REAL builder, the real `@th/ui` + Tamagui stack and the real EN
 * catalogue (same harness as `RecurrenceBuilder.prefill.test.tsx`).
 */
import type { ReactElement } from "react";
import { act, render as rtlRender } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

import { toDateTimeLocalValue, toIsoInTimeZone } from "../event-builder-helpers";
import { RecurrenceBuilder } from "../RecurrenceBuilder";
import type { RecurrenceConfig } from "../recurrence-helpers";

const render = (ui: ReactElement) =>
  rtlRender(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

describe("RecurrenceBuilder — the event builder's series prefill is stable", () => {
  it.each<[string, string, string, string, string | null]>([
    // Bounded rules: without `allowNeverEnds` (the builder does not pass it)
    // an endless rule is an incomplete state the builder never emits from,
    // so only a bounded rule can show drift.
    ["a weekly rule", "2026-09-10T01:00:00.000Z", "America/Chicago", "FREQ=WEEKLY;BYDAY=WE", "2027-01-01T06:00:00.000Z"],
    // Seconds are dropped by the datetime-local wall clock; both sides
    // derive from that same wall clock, so they still agree.
    ["a start with seconds", "2026-09-10T01:00:30.500Z", "America/Chicago", "FREQ=WEEKLY;BYDAY=WE", "2027-01-01T06:00:00.000Z"],
    ["a monthly ordinal rule", "2026-09-10T01:00:00.000Z", "America/Chicago", "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2", "2027-01-01T06:00:00.000Z"],
    ["an endless weekly rule", "2026-09-10T01:00:00.000Z", "America/Chicago", "FREQ=WEEKLY;BYDAY=WE", null],
    // The night before a DST change, in a zone the browser is not in.
    ["a start across a DST change", "2026-11-01T00:30:00.000Z", "America/New_York", "FREQ=WEEKLY;BYDAY=SA", "2027-01-01T06:00:00.000Z"],
    ["a zone east of UTC", "2026-09-09T18:00:00.000Z", "Asia/Tokyo", "FREQ=WEEKLY;BYDAY=TH", "2027-01-01T06:00:00.000Z"],
  ])("stays silent for %s", async (_label, storedStart, timezone, rrule, until) => {
    // Hydration (EventBuilder: `setStartsAt(toDateTimeLocalValue(...))`).
    const startsAt = toDateTimeLocalValue(storedStart, timezone);
    // The series prefill (EventBuilder: `dtstart: toIsoInTimeZone(startsAt,
    // eventTimezone)`).
    const value: RecurrenceConfig = {
      rrule,
      dtstart: toIsoInTimeZone(startsAt, timezone),
      ...(until ? { until } : {}),
    };
    const onChange = vi.fn();

    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={value}
        onChange={onChange}
        eventStartsAt={startsAt}
        onEventStartsAtChange={() => {}}
        eventTimezone={timezone}
        // As `BuilderSettingsSections` renders it for a series occurrence.
        seriesId="series-1"
        manageDatesHref="/admin/acme/events/evt-1/dates"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("control: a dtstart that disagrees with the wall clock DOES re-emit", async () => {
    // The stored instant keeps its seconds; the wall clock drops them. This is
    // the drift the prefill must not have, and the builder does notice it.
    const storedStart = "2026-09-10T01:00:30.500Z";
    const timezone = "America/Chicago";
    const onChange = vi.fn();
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={{
          rrule: "FREQ=WEEKLY;BYDAY=WE",
          dtstart: storedStart,
          until: "2027-01-01T06:00:00.000Z",
        }}
        onChange={onChange}
        eventStartsAt={toDateTimeLocalValue(storedStart, timezone)}
        onEventStartsAtChange={() => {}}
        eventTimezone={timezone}
        seriesId="series-1"
        manageDatesHref="/admin/acme/events/evt-1/dates"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalled();
  });
});
