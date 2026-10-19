import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { resolveTicketAmountField } from "../TicketTypeEditor";
import {
  emptyScheduledPriceDraft,
  formatZonedInstant,
  resolveScheduledPriceAtIso,
  resolveScheduledPriceChange,
  scheduledPriceDraftFromTicketType,
  type ScheduledPriceDraft,
} from "../ticket-type-schedule";

/**
 * The pure half of the scheduled price change (FR-005 / FR-007).
 *
 * What this file exists to pin, in order of how badly it hurts when wrong:
 *
 *  1. The organizer's wall clock resolves against the EVENT's timezone, never
 *     the browser's. Every case below names an explicit zone and asserts on
 *     the resulting UTC instant, so a browser-local regression cannot pass —
 *     the expectations are wrong under any runner TZ if the zone is ignored.
 *  2. DST in BOTH directions, since a one-hour error in a price flip is a
 *     real mischarge for everyone who buys inside that hour.
 *  3. Both-or-neither. There is no input to this resolver that produces one
 *     field without the other.
 *
 * `readAmount` is the editor's REAL `resolveTicketAmountField`, not a stub —
 * the whole point of injecting it is that this feature has exactly one money
 * reader, so the tests must exercise that one.
 */

const draft = (
  over: Partial<ScheduledPriceDraft> = {},
): ScheduledPriceDraft => ({
  enabled: true,
  priceDollars: "20.00",
  atLocal: "2026-10-03T00:00",
  ...over,
});

const resolve = (
  over: Partial<ScheduledPriceDraft> = {},
  opts: { timeZone?: string; now?: Date } = {},
) =>
  resolveScheduledPriceChange(draft(over), {
    timeZone: opts.timeZone ?? "America/Chicago",
    readAmount: resolveTicketAmountField,
    now: opts.now ?? new Date("2026-01-01T00:00:00.000Z"),
  });

describe("resolveScheduledPriceAtIso — wall clock resolves in the EVENT's zone", () => {
  it("resolves the spec's worked example: 2026-10-01T20:00 New York", () => {
    // FR-007's acceptance criterion. EDT is UTC-4 on that date.
    expect(
      resolveScheduledPriceAtIso("2026-10-01T20:00", "America/New_York"),
    ).toBe("2026-10-02T00:00:00.000Z");
  });

  it("gives a DIFFERENT instant for the same wall clock in a different zone", () => {
    // The single assertion that a browser-local implementation cannot pass:
    // one reading, four zones, four instants.
    const wall = "2026-10-03T20:00";
    const instants = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ].map((zone) => resolveScheduledPriceAtIso(wall, zone));

    expect(instants).toEqual([
      "2026-10-04T00:00:00.000Z", // EDT, UTC-4
      "2026-10-04T01:00:00.000Z", // CDT, UTC-5
      "2026-10-04T02:00:00.000Z", // MDT, UTC-6
      "2026-10-04T03:00:00.000Z", // PDT, UTC-7
    ]);
    expect(new Set(instants).size).toBe(4);
  });

  it("resolves a positive-offset zone", () => {
    // Europe/Madrid is CEST (UTC+2) in July — the sign of the offset must not
    // matter to the resolution.
    expect(
      resolveScheduledPriceAtIso("2026-07-15T21:30", "Europe/Madrid"),
    ).toBe("2026-07-15T19:30:00.000Z");
  });

  it("refuses an unreadable wall clock instead of inventing an instant", () => {
    for (const bad of [
      "",
      "   ",
      "not-a-date",
      "2026-10-03",
      "10/03/2026 8pm",
    ]) {
      expect(resolveScheduledPriceAtIso(bad, "America/Chicago")).toBeNull();
    }
  });

  it("refuses OUT-OF-RANGE components rather than letting them normalise", () => {
    // `\\d{2}` alone accepts these, and `Date.UTC` then rolls them over
    // silently — month 13 into the next year, hour 99 four days later — so a
    // value the organizer could never have meant would save without complaint.
    for (const bad of [
      "2026-13-01T00:00", // month 13
      "2026-00-01T00:00", // month 0
      "2026-10-32T00:00", // day 32
      "2026-10-00T00:00", // day 0
      "2026-10-03T24:00", // hour 24
      "2026-10-03T99:99", // both
      "2026-10-03T12:60", // minute 60
    ]) {
      expect(resolveScheduledPriceAtIso(bad, "America/Chicago")).toBeNull();
    }
  });

  it("still refuses a date that passes the pattern but does not exist", () => {
    // 31 February is in range component-wise; `zonedWallClockToInstant`'s
    // read-back check is what rejects it.
    expect(
      resolveScheduledPriceAtIso("2026-02-31T12:00", "America/Chicago"),
    ).not.toBe("2026-02-31T18:00:00.000Z");
  });

  it("tolerates a seconds component, truncating to the minute", () => {
    // Some browsers emit `:ss` from datetime-local. The control has no seconds
    // affordance, so the flip resolves to the top of the minute either way.
    expect(
      resolveScheduledPriceAtIso("2026-10-03T00:00:45", "America/Chicago"),
    ).toBe("2026-10-03T05:00:00.000Z");
  });

  it("degrades to null on an unknown zone id rather than throwing", () => {
    // `Intl.DateTimeFormat` throws RangeError here. A throw would take the
    // whole ticket editor down over one optional field.
    expect(
      resolveScheduledPriceAtIso("2026-10-03T20:00", "Mars/Olympus_Mons"),
    ).toBeNull();
  });
});

describe("resolveScheduledPriceAtIso — DST, pinned in both directions", () => {
  // US Central 2026: spring forward 2026-03-08 (02:00 CST → 03:00 CDT),
  // fall back 2026-11-01 (02:00 CDT → 01:00 CST).

  it("SPRING FORWARD: the hour before the gap is CST (UTC-6)", () => {
    expect(
      resolveScheduledPriceAtIso("2026-03-08T01:30", "America/Chicago"),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("SPRING FORWARD: the hour after the gap is CDT (UTC-5)", () => {
    expect(
      resolveScheduledPriceAtIso("2026-03-08T03:30", "America/Chicago"),
    ).toBe("2026-03-08T08:30:00.000Z");
  });

  it("SPRING FORWARD: a reading inside the gap lands one step later, not an hour early", () => {
    // 02:30 never happens on this date. Resolving with the PRE-transition
    // offset (CST, UTC-6) yields 08:30Z, which reads back as 03:30 CDT — one
    // transition step later on the wall clock. That matches what the event
    // builder does with the event's own start time for the same input, which
    // is the property that matters: the flip and the show never disagree.
    const iso = resolveScheduledPriceAtIso(
      "2026-03-08T02:30",
      "America/Chicago",
    );
    expect(iso).toBe("2026-03-08T08:30:00.000Z");
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(iso!)),
    ).toBe("03:30");
  });

  it("FALL BACK: the ambiguous reading takes the FIRST occurrence (CDT)", () => {
    // 01:30 happens twice on 2026-11-01. 06:30Z is 01:30 CDT (the first);
    // 07:30Z would be 01:30 CST (the second). "Early bird until 1:30" means
    // the earlier one.
    expect(
      resolveScheduledPriceAtIso("2026-11-01T01:30", "America/Chicago"),
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("FALL BACK: the hour after the transition is CST (UTC-6)", () => {
    expect(
      resolveScheduledPriceAtIso("2026-11-01T03:30", "America/Chicago"),
    ).toBe("2026-11-01T09:30:00.000Z");
  });

  it("SOUTHERN HEMISPHERE: the transitions run the other way round", () => {
    // Australia/Sydney 2026: DST ENDS 2026-04-05 (AEDT +11 → AEST +10) and
    // BEGINS 2026-10-04 (AEST +10 → AEDT +11) — the inverse calendar of the
    // US cases above, so a fix that hardcodes the northern order fails here.
    expect(
      resolveScheduledPriceAtIso("2026-04-04T20:00", "Australia/Sydney"),
    ).toBe("2026-04-04T09:00:00.000Z"); // AEDT, UTC+11
    expect(
      resolveScheduledPriceAtIso("2026-04-06T20:00", "Australia/Sydney"),
    ).toBe("2026-04-06T10:00:00.000Z"); // AEST, UTC+10
    expect(
      resolveScheduledPriceAtIso("2026-10-05T20:00", "Australia/Sydney"),
    ).toBe("2026-10-05T09:00:00.000Z"); // AEDT again, UTC+11
  });

  it("never depends on America/Chicago — the PAYOUT_TZ shortcut the spec forbids", () => {
    // If the resolver had been written against a hardcoded Central zone (the
    // PAYOUT_TZ / REFUND_TZ pattern), a Pacific event's flip would fire two
    // hours off. Same wall clock, and Los Angeles must NOT equal Chicago.
    const wall = "2026-06-15T20:00";
    expect(resolveScheduledPriceAtIso(wall, "America/Los_Angeles")).not.toBe(
      resolveScheduledPriceAtIso(wall, "America/Chicago"),
    );
    expect(resolveScheduledPriceAtIso(wall, "America/Los_Angeles")).toBe(
      "2026-06-16T03:00:00.000Z",
    );
  });
});

describe("resolveScheduledPriceChange — both or neither", () => {
  it("sends the null PAIR when the affordance is off", () => {
    expect(resolve({ enabled: false })).toEqual({
      kind: "unset",
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });
  });

  it("clears BOTH even when stale text is still in the fields", () => {
    // Defence in depth: the component clears the fields on uncheck, but the
    // resolver must not produce a half-pair if it ever sees an off draft with
    // values in it.
    const result = resolve({
      enabled: false,
      priceDollars: "20.00",
      atLocal: "2026-10-03T00:00",
    });
    expect(result).toMatchObject({
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });
  });

  it("sends BOTH when the affordance is on and complete", () => {
    expect(resolve()).toEqual({
      kind: "set",
      scheduledPriceCents: 2000,
      scheduledPriceAt: "2026-10-03T05:00:00.000Z", // CDT, UTC-5
      isPast: false,
    });
  });

  it("refuses a price with no date rather than emitting a half-pair", () => {
    const result = resolve({ atLocal: "" });
    expect(result).toEqual({
      kind: "error",
      field: "at",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttScheduleAtRequiredMessage",
      // `pending`, not `danger`: the panel is open and unfinished, which is not
      // a mistake. It blocks the submit just as hard — it just doesn't shout.
      tone: "pending",
    });
    expect(result).not.toHaveProperty("scheduledPriceAt");
  });

  it("refuses a date with no price rather than banking a blank as $0", () => {
    // Elsewhere in this editor a blank price means "free". Here it must NOT:
    // treating it as 0 would silently schedule the tier to become free.
    const result = resolve({ priceDollars: "" });
    expect(result).toEqual({
      kind: "error",
      field: "price",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttSchedulePriceRequiredMessage",
      tone: "pending",
    });
  });

  it("refuses an unreadable date", () => {
    expect(resolve({ atLocal: "sometime friday" })).toMatchObject({
      kind: "error",
      field: "at",
      messageKey: "admin.ttScheduleAtInvalidMessage",
    });
  });

  it("blames the missing ZONE, not the organizer's perfectly good date", () => {
    // The caller passes `eventTimezone ?? ""`. Sharing the "couldn't be read"
    // copy here named a date that is fine, for a condition re-picking cannot
    // fix. It still REFUSES — that is the half that matters.
    for (const zone of ["", "Mars/Olympus_Mons"]) {
      expect(resolve({}, { timeZone: zone })).toMatchObject({
        kind: "error",
        field: "at",
        messageKey: "admin.ttScheduleTimezonePending",
      });
    }
    // The price-first ordering above is untouched: a bad PRICE still wins.
    expect(resolve({ priceDollars: "1,500" }, { timeZone: "" })).toMatchObject({
      field: "price",
      messageKey: "admin.ttAmbiguousAmountMessage",
    });
  });
});

describe("resolveScheduledPriceChange — money goes through the shared reader", () => {
  it("accepts an explicit 0 — a tier that becomes FREE at T is legal", () => {
    expect(resolve({ priceDollars: "0" })).toMatchObject({
      kind: "set",
      scheduledPriceCents: 0,
    });
    expect(resolve({ priceDollars: "0.00" })).toMatchObject({
      kind: "set",
      scheduledPriceCents: 0,
    });
  });

  it("reads an es comma decimal as typed", () => {
    // parseFloat("15,50") === 15. That bug is not being reintroduced for the
    // sake of one new field.
    expect(resolve({ priceDollars: "15,50" })).toMatchObject({
      scheduledPriceCents: 1550,
    });
  });

  it("REFUSES an ambiguous amount instead of guessing", () => {
    // "1,500" is $1500 to an en typist and $1.50 to an es one.
    expect(resolve({ priceDollars: "1,500" })).toEqual({
      kind: "error",
      field: "price",
      titleKey: "admin.ttInvalidAmountTitle",
      messageKey: "admin.ttAmbiguousAmountMessage",
      // Unreadable money IS a mistake — red, with the alert glyph.
      tone: "danger",
    });
  });

  it("refuses a negative instead of flooring it to zero", () => {
    expect(resolve({ priceDollars: "-5" })).toMatchObject({
      kind: "error",
      field: "price",
      messageKey: "admin.ttInvalidAmountMessage",
    });
  });
});

describe("resolveScheduledPriceChange — a past instant WARNS, never blocks", () => {
  it("flags a backdated flip but still submits it", () => {
    const result = resolve({}, { now: new Date("2027-01-01T00:00:00.000Z") });
    expect(result).toMatchObject({ kind: "set", isPast: true });
  });

  it("treats exactly T as past — the boundary is INCLUSIVE at T", () => {
    const result = resolve({}, { now: new Date("2026-10-03T05:00:00.000Z") });
    expect(result).toMatchObject({ kind: "set", isPast: true });
  });

  it("does not flag a future flip", () => {
    expect(
      resolve({}, { now: new Date("2026-10-03T04:59:59.999Z") }),
    ).toMatchObject({ kind: "set", isPast: false });
  });
});

describe("formatZonedInstant — the FR-007 read-back", () => {
  const enFormat = (value: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", options).format(value);

  it("names the EVENT's zone, not the runner's", () => {
    // The zone abbreviation IS the feature: without it the organizer cannot
    // tell whether "8pm" landed on the venue's clock.
    const label = formatZonedInstant(
      "2026-10-03T05:00:00.000Z",
      "America/Chicago",
      enFormat,
    );
    // Midnight CDT on 2026-10-03, which is a Saturday.
    expect(label).toBe("Sat, Oct 3, 12:00 AM CDT");
  });

  it("reads the SAME instant differently in a different zone", () => {
    const instant = "2026-10-03T05:00:00.000Z";
    expect(formatZonedInstant(instant, "America/Chicago", enFormat)).not.toBe(
      formatZonedInstant(instant, "America/Los_Angeles", enFormat),
    );
    expect(
      formatZonedInstant(instant, "America/Los_Angeles", enFormat),
    ).toContain("PDT");
  });

  it("shows the winter abbreviation on the other side of a transition", () => {
    expect(
      formatZonedInstant(
        "2026-12-03T06:00:00.000Z",
        "America/Chicago",
        enFormat,
      ),
    ).toContain("CST");
  });

  it("returns null rather than throwing on an unknown zone or bad instant", () => {
    expect(
      formatZonedInstant(
        "2026-10-03T05:00:00.000Z",
        "Mars/Olympus_Mons",
        enFormat,
      ),
    ).toBeNull();
    expect(formatZonedInstant("nope", "America/Chicago", enFormat)).toBeNull();
  });
});

describe("scheduledPriceDraftFromTicketType — seeding the edit form", () => {
  it("round-trips a stored pair back to the organizer's wall clock", () => {
    expect(
      scheduledPriceDraftFromTicketType(
        {
          scheduledPriceCents: 2000,
          scheduledPriceAt: "2026-10-03T05:00:00.000Z",
        },
        "America/Chicago",
      ),
    ).toEqual({
      enabled: true,
      priceDollars: "20.00",
      atLocal: "2026-10-03T00:00",
    });
  });

  it("seeds a stored 0 as an ENABLED free-after-T schedule, not as unset", () => {
    // The `== null` vs falsy trap: `0` is a legitimate scheduled price.
    expect(
      scheduledPriceDraftFromTicketType(
        {
          scheduledPriceCents: 0,
          scheduledPriceAt: "2026-10-03T05:00:00.000Z",
        },
        "America/Chicago",
      ),
    ).toMatchObject({ enabled: true, priceDollars: "0.00" });
  });

  it("returns a DISABLED draft for an unknown zone instead of THROWING", () => {
    // Both callers are fatal places for an exception: `handleStartEdit` is a
    // click handler and the re-seed runs during commit, so a RangeError out of
    // `Intl.DateTimeFormat` would unmount the builder via the error boundary
    // and lose unsaved work on an unrelated form. `Event.timezone` is a bare
    // `z.string()` server-side, so a bad stored value is possible.
    expect(() =>
      scheduledPriceDraftFromTicketType(
        {
          scheduledPriceCents: 2000,
          scheduledPriceAt: "2026-10-03T05:00:00.000Z",
        },
        "Mars/Olympus_Mons",
      ),
    ).not.toThrow();
    expect(
      scheduledPriceDraftFromTicketType(
        {
          scheduledPriceCents: 2000,
          scheduledPriceAt: "2026-10-03T05:00:00.000Z",
        },
        "Mars/Olympus_Mons",
      ),
    ).toEqual(emptyScheduledPriceDraft());
    // Empty string is the "timezone not loaded yet" shape.
    expect(
      scheduledPriceDraftFromTicketType(
        {
          scheduledPriceCents: 2000,
          scheduledPriceAt: "2026-10-03T05:00:00.000Z",
        },
        "",
      ),
    ).toEqual(emptyScheduledPriceDraft());
  });

  it("is DISABLED for an unscheduled row, a half-row, or a row missing the fields", () => {
    const empty = emptyScheduledPriceDraft();
    expect(
      scheduledPriceDraftFromTicketType(
        { scheduledPriceCents: null, scheduledPriceAt: null },
        "America/Chicago",
      ),
    ).toEqual(empty);
    expect(
      scheduledPriceDraftFromTicketType(
        { scheduledPriceCents: 2000, scheduledPriceAt: null },
        "America/Chicago",
      ),
    ).toEqual(empty);
    // What `listTicketTypesForEdit` returns TODAY — neither field present.
    expect(scheduledPriceDraftFromTicketType({}, "America/Chicago")).toEqual(
      empty,
    );
  });
});

describe("every i18n key this module can emit exists in BOTH catalogs", () => {
  const emitted = new Set<string>();
  for (const over of [
    { priceDollars: "" },
    { atLocal: "" },
    { atLocal: "sometime friday" },
    { priceDollars: "1,500" },
    { priceDollars: "-5" },
  ]) {
    const result = resolve(over);
    if (result.kind === "error") {
      emitted.add(result.titleKey);
      emitted.add(result.messageKey);
    }
  }
  // Keys the component renders directly, which the resolver never returns.
  for (const key of [
    "admin.ttScheduleToggle",
    "admin.ttScheduleHelp",
    "admin.ttScheduleNewPrice",
    "admin.ttScheduleAt",
    "admin.ttScheduleReadback",
    "admin.ttScheduleZoneNote",
    "admin.ttSchedulePastWarning",
    "admin.ttScheduleTimezonePending",
    "errors.ticketTypeScheduleIncomplete",
  ]) {
    emitted.add(key);
  }

  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])("%s", (_locale, messages) => {
    const catalog = messages as unknown as Record<
      string,
      Record<string, string>
    >;
    expect(emitted.size).toBeGreaterThan(10);
    for (const key of emitted) {
      const [namespace, name] = key.split(".");
      const value = catalog[namespace!]?.[name!];
      expect(typeof value, `${_locale} is missing ${key}`).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
    }
  });

  it("keeps the {price}/{when}/{timeZone} placeholders in both locales", () => {
    // An argument-parity drift here renders a raw placeholder to the one
    // person who has to verify the timezone.
    for (const messages of [enMessages, esMessages]) {
      const admin = (messages as unknown as { admin: Record<string, string> })
        .admin;
      expect(admin.ttScheduleReadback).toContain("{price}");
      expect(admin.ttScheduleReadback).toContain("{when}");
      expect(admin.ttScheduleZoneNote).toContain("{timeZone}");
    }
  });
});
