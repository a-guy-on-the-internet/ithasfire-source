/**
 * A loaded config survives the builder's first render UNTOUCHED.
 *
 * The moderator's schedule page seeds `RecurrenceBuilder` with the listing's
 * STORED rule and relies on the builder not rewriting it: its emission effect
 * re-emits a canonicalised config whenever the loaded `dtstart` disagrees
 * with the one it derives from `eventStartsAt`, and a canonicalised rule is
 * not the stored rule (a COUNT-bounded rule, a monthly ordinal and a rule the
 * parser refuses all round-trip DIFFERENTLY from how they were stored). The
 * page keeps the two anchors equal by construction — `normaliseAnchor` in
 * `schedule-reconcile.ts` — and this file is the proof that the builder then
 * stays silent, for each shape the prefill can take.
 *
 * The REAL builder, the real `@th/ui` + Tamagui stack and the real EN
 * catalogue: a mocked builder would test the mock.
 */
import type { ReactElement } from "react";
import { act, render as rtlRender } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

import { normaliseAnchor } from "@/app/moderate/listings/[eventId]/schedule/_components/schedule-reconcile";
import { toDateTimeLocalValue } from "../event-builder-helpers";
import { RecurrenceBuilder } from "../RecurrenceBuilder";
import type { RecurrenceConfig } from "../recurrence-helpers";

const TIMEZONE = "America/Chicago";
/** A Wednesday, 8:00 PM Central — the second Wednesday of September 2026. */
const STARTS_AT = "2026-09-10T01:00:00.000Z";

const render = (ui: ReactElement) =>
  rtlRender(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

describe("RecurrenceBuilder — a loaded config is not rewritten on mount", () => {
  const anchorIso = normaliseAnchor(STARTS_AT, TIMEZONE);

  it.each<[string, Omit<RecurrenceConfig, "dtstart">]>([
    ["a weekly rule", { rrule: "FREQ=WEEKLY;BYDAY=WE" }],
    ["a COUNT-bounded weekly rule", { rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=17" }],
    ["a monthly ordinal rule", { rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2" }],
    [
      "an UNTIL-bounded biweekly rule",
      {
        rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
        until: "2027-01-01T06:00:00.000Z",
      },
    ],
    // The builder's parser refuses an nth-prefixed BYDAY token; the rule must
    // pass through as raw text rather than be rebuilt into something else.
    ["a rule the builder cannot express", { rrule: "FREQ=MONTHLY;BYDAY=2WE" }],
  ])("stays silent for %s", async (_label, shape) => {
    const value: RecurrenceConfig = { ...shape, dtstart: anchorIso };
    const onChange = vi.fn();

    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={value}
        onChange={onChange}
        eventStartsAt={toDateTimeLocalValue(anchorIso, TIMEZONE)}
        eventTimezone={TIMEZONE}
        allowNeverEnds
      />,
    );
    // Let every mount-time effect (sync, degrade, day-list, emission) settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("DOES re-emit when the anchors disagree — the trap the page guards against", async () => {
    // Same instant, a different string: `Event.startsAt` with seconds, as a
    // server Date might carry, handed over un-normalised.
    const onChange = vi.fn();
    render(
      <RecurrenceBuilder
        enabled
        onEnabledChange={() => {}}
        value={{ rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=17", dtstart: "2026-09-10T01:00:30.000Z" }}
        onChange={onChange}
        eventStartsAt={toDateTimeLocalValue(STARTS_AT, TIMEZONE)}
        eventTimezone={TIMEZONE}
        allowNeverEnds
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]?.[0]?.dtstart).toBe(anchorIso);
  });
});
