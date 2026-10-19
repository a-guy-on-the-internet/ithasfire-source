import { describe, expect, it } from "vitest";

import {
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "../event-builder-helpers";

/**
 * DST correctness for the event builder's wall-clock → instant conversion.
 *
 * `toIsoInTimeZone` turns the organizer's `<input type="datetime-local">`
 * reading into the instant stored as `Event.startsAt` / `endsAt`, so a
 * one-hour error here is a one-hour error on the buyer's ticket, the door
 * list, the reminder email, and every deadline derived from `startsAt`.
 *
 * Every expectation below was verified independently against
 * `Intl.DateTimeFormat` ground truth: formatting the expected instant in the
 * zone yields exactly the wall clock the test feeds in (except the two edge
 * cases that are documented as such — the gap hour and the ambiguous hour).
 *
 * These tests never construct a `Date` from a bare local string and never
 * assert on the runner's own zone, so they hold under any `TZ`. They are run
 * under `TZ=UTC` and `TZ=Australia/Sydney` in CI-equivalent local runs.
 */

const CHICAGO = "America/Chicago";
const SYDNEY = "Australia/Sydney";

describe("toIsoInTimeZone — the four originally-measured cases", () => {
  it("resolves a far-side-of-fall-back reading with the POST-transition offset", () => {
    // 2026-11-01 03:30 in Chicago is CST (UTC-6): the clocks went back at
    // 02:00. Probing the zone once at the naive-UTC instant lands on
    // 2026-10-31 22:30 CDT and answers 08:30Z — an hour early.
    expect(toIsoInTimeZone("2026-11-01T03:30", CHICAGO)).toBe(
      "2026-11-01T09:30:00.000Z",
    );
  });

  it("resolves an ordinary summer reading (CDT)", () => {
    expect(toIsoInTimeZone("2026-06-01T03:30", CHICAGO)).toBe(
      "2026-06-01T08:30:00.000Z",
    );
  });

  it("resolves an ordinary winter reading (CST)", () => {
    expect(toIsoInTimeZone("2026-01-15T03:30", CHICAGO)).toBe(
      "2026-01-15T09:30:00.000Z",
    );
  });

  it("resolves a southern-hemisphere reading on the day before a transition", () => {
    // Sydney leaves AEDT (UTC+11) at 03:00 on 2026-04-05, so 20:00 on the 4th
    // is still AEDT. The single probe reads the naive instant as 06:00 AEST on
    // the 5th and answers 10:00Z — an hour late.
    expect(toIsoInTimeZone("2026-04-04T20:00", SYDNEY)).toBe(
      "2026-04-04T09:00:00.000Z",
    );
  });
});

describe("toIsoInTimeZone — northern hemisphere (America/Chicago)", () => {
  it("spring forward: the reading after the gap uses the POST-transition offset", () => {
    // 2026-03-08 02:00 CST → 03:00 CDT. 03:30 is CDT (UTC-5).
    expect(toIsoInTimeZone("2026-03-08T03:30", CHICAGO)).toBe(
      "2026-03-08T08:30:00.000Z",
    );
    expect(toIsoInTimeZone("2026-03-08T04:30", CHICAGO)).toBe(
      "2026-03-08T09:30:00.000Z",
    );
  });

  it("spring forward: a reading INSIDE the gap resolves with the pre-transition offset", () => {
    // PINNED DECISION: 02:30 on 2026-03-08 names no instant at all. We resolve
    // it with the offset in effect BEFORE the transition (CST, UTC-6), which
    // lands one transition step later on the wall clock — the resulting
    // instant reads back as 03:30 CDT. That is what ECMAScript's own
    // `Date.UTC`-based local-time handling does with an impossible reading, and
    // it matches `zonedWallClockToInstant`'s documented behaviour, so the whole
    // repo answers the same way. The alternative (refusing) would reject a
    // value the native picker happily produces.
    expect(toIsoInTimeZone("2026-03-08T02:30", CHICAGO)).toBe(
      "2026-03-08T08:30:00.000Z",
    );
    expect(toDateTimeLocalValue("2026-03-08T08:30:00.000Z", CHICAGO)).toBe(
      "2026-03-08T03:30",
    );
  });

  it("fall back: the ambiguous reading resolves to the FIRST occurrence", () => {
    // PINNED DECISION: 01:30 on 2026-11-01 happens twice — 06:30Z (CDT) and
    // 07:30Z (CST). We take the EARLIER one. An organizer typing "doors 01:30"
    // means the first time the clock reads it, and the earlier instant is also
    // the conservative choice for anything gated on the start (sales close,
    // refund cutoffs).
    expect(toIsoInTimeZone("2026-11-01T01:30", CHICAGO)).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("resolves both edges of the fall-back day consistently", () => {
    expect(toIsoInTimeZone("2026-11-01T00:30", CHICAGO)).toBe(
      "2026-11-01T05:30:00.000Z", // CDT
    );
    expect(toIsoInTimeZone("2026-11-01T02:30", CHICAGO)).toBe(
      "2026-11-01T08:30:00.000Z", // CST
    );
  });
});

describe("toIsoInTimeZone — southern hemisphere (Australia/Sydney)", () => {
  it("fall back (April): the ambiguous reading resolves to the FIRST occurrence", () => {
    // 2026-04-05 03:00 AEDT → 02:00 AEST, so 02:30 happens twice:
    // 15:30Z (AEDT, +11) then 16:30Z (AEST, +10). First occurrence wins.
    expect(toIsoInTimeZone("2026-04-05T02:30", SYDNEY)).toBe(
      "2026-04-04T15:30:00.000Z",
    );
  });

  it("fall back (April): the reading after the transition uses AEST", () => {
    expect(toIsoInTimeZone("2026-04-05T03:30", SYDNEY)).toBe(
      "2026-04-04T17:30:00.000Z",
    );
  });

  it("spring forward (October): the reading after the gap uses AEDT", () => {
    // 2026-10-04 02:00 AEST → 03:00 AEDT.
    expect(toIsoInTimeZone("2026-10-04T03:30", SYDNEY)).toBe(
      "2026-10-03T16:30:00.000Z",
    );
    expect(toIsoInTimeZone("2026-10-04T04:30", SYDNEY)).toBe(
      "2026-10-03T17:30:00.000Z",
    );
  });

  it("spring forward (October): a reading inside the gap uses the pre-transition offset", () => {
    // Same rule as the northern gap: 02:30 doesn't exist, resolve with AEST
    // (+10) and read back as 03:30 AEDT.
    expect(toIsoInTimeZone("2026-10-04T02:30", SYDNEY)).toBe(
      "2026-10-03T16:30:00.000Z",
    );
  });

  it("resolves ordinary readings in both AEDT and AEST", () => {
    expect(toIsoInTimeZone("2026-01-15T20:00", SYDNEY)).toBe(
      "2026-01-15T09:00:00.000Z", // AEDT, +11
    );
    expect(toIsoInTimeZone("2026-06-15T20:00", SYDNEY)).toBe(
      "2026-06-15T10:00:00.000Z", // AEST, +10
    );
  });
});

describe("toIsoInTimeZone — zones without DST", () => {
  it("resolves UTC readings unchanged", () => {
    expect(toIsoInTimeZone("2026-11-01T03:30", "UTC")).toBe(
      "2026-11-01T03:30:00.000Z",
    );
    expect(toIsoInTimeZone("2026-03-08T02:30", "UTC")).toBe(
      "2026-03-08T02:30:00.000Z",
    );
  });

  it("resolves a fixed-offset zone that never observes DST", () => {
    // Phoenix stays on MST (UTC-7) year round.
    expect(toIsoInTimeZone("2026-07-03T19:00", "America/Phoenix")).toBe(
      "2026-07-04T02:00:00.000Z",
    );
    expect(toIsoInTimeZone("2026-01-03T19:00", "America/Phoenix")).toBe(
      "2026-01-04T02:00:00.000Z",
    );
  });

  it("resolves a half-hour offset zone", () => {
    // Kolkata is UTC+05:30 year round — a regression here would show up as a
    // 30-minute error, which whole-hour reasoning misses.
    expect(toIsoInTimeZone("2026-11-02T01:30", "Asia/Kolkata")).toBe(
      "2026-11-01T20:00:00.000Z",
    );
  });
});

describe("toIsoInTimeZone — unknown timezone", () => {
  it("refuses rather than silently degrading to UTC", () => {
    // `zonedWallClockToInstant` degrades an unrecognized zone to UTC, which is
    // right for its volunteer-draft caller and wrong here: an event start
    // resolved against UTC instead of the venue's zone is a silent multi-hour
    // error on a real show. Throwing also preserves the pre-fix behaviour
    // (`Intl.DateTimeFormat` throws `RangeError` on an unknown zone), so no
    // caller's contract moves.
    expect(() => toIsoInTimeZone("2026-11-01T03:30", "Mars/Olympus")).toThrow(
      RangeError,
    );
    expect(() => toIsoInTimeZone("2026-11-01T03:30", "")).toThrow(RangeError);
  });
});

describe("write → read → write round-trip stability", () => {
  // The builder prefills the datetime-local fields from the stored instant via
  // `toDateTimeLocalValue` and, on save, unconditionally re-resolves them via
  // `toIsoInTimeZone`. An organizer who opens an event, changes only the
  // title, and saves therefore round-trips the start through both helpers —
  // so any asymmetry silently MOVES a published show.
  const roundTrip = (iso: string, timeZone: string) =>
    toIsoInTimeZone(toDateTimeLocalValue(iso, timeZone), timeZone);

  const stable: Array<[string, string, string]> = [
    ["far side of fall back (CST)", "2026-11-01T09:30:00.000Z", CHICAGO],
    ["first 01:30 of the fall-back day", "2026-11-01T06:30:00.000Z", CHICAGO],
    ["just after spring forward (CDT)", "2026-03-08T08:30:00.000Z", CHICAGO],
    ["just before spring forward (CST)", "2026-03-08T07:30:00.000Z", CHICAGO],
    ["ordinary summer evening", "2026-06-20T01:00:00.000Z", CHICAGO],
    ["Sydney, day before fall back", "2026-04-04T09:00:00.000Z", SYDNEY],
    ["Sydney, first 02:30 of fall back", "2026-04-04T15:30:00.000Z", SYDNEY],
    ["Sydney, just after spring forward", "2026-10-03T16:30:00.000Z", SYDNEY],
    ["UTC event", "2026-11-01T03:30:00.000Z", "UTC"],
    ["Phoenix event", "2026-07-04T02:00:00.000Z", "America/Phoenix"],
    ["Kolkata event", "2026-11-01T20:00:00.000Z", "Asia/Kolkata"],
  ];

  for (const [label, iso, timeZone] of stable) {
    it(`leaves an untouched save unchanged: ${label}`, () => {
      expect(roundTrip(iso, timeZone)).toBe(iso);
      // Idempotent under repeated untouched saves, too.
      expect(roundTrip(roundTrip(iso, timeZone), timeZone)).toBe(iso);
    });
  }

  it("KNOWN, IRREDUCIBLE: the SECOND occurrence of an ambiguous hour snaps to the first", () => {
    // 07:30Z reads as 01:30 CST — the repeated hour's second pass. The
    // datetime-local string carries no offset, so "01:30" cannot distinguish
    // the two, and the first-occurrence rule pulls it back an hour.
    //
    // This is a property of the wire format, not of the resolver: any helper
    // that round-trips through a bare wall clock has it. It is bounded to
    // events starting inside the one repeated hour per year per zone. The fix
    // in this file removes the UNBOUNDED version of the same failure (every
    // reading on the far side of a transition), which is what was live.
    expect(roundTrip("2026-11-01T07:30:00.000Z", CHICAGO)).toBe(
      "2026-11-01T06:30:00.000Z",
    );
    expect(roundTrip("2026-04-04T16:30:00.000Z", SYDNEY)).toBe(
      "2026-04-04T15:30:00.000Z",
    );
  });
});
