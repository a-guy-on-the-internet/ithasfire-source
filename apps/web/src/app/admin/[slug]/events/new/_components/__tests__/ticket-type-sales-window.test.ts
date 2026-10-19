import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  classifySalesWindowOrder,
  describeSalesWindow,
  emptySalesWindowDraft,
  resolveSalesWindow,
  resolveSalesWindowBoundIso,
  salesWindowDraftFromTicketType,
  type SalesWindowDraft,
} from "../ticket-type-sales-window";

/**
 * The pure half of the per-type sales window (FR-013, adopting FR-009).
 *
 * What this file exists to pin, in order of how badly it hurts when wrong:
 *
 *  1. The organizer's wall clock resolves against the EVENT's timezone, never
 *     the browser's. Every case names an explicit zone and asserts the
 *     resulting UTC instant, so a browser-local regression cannot pass — the
 *     expectations are wrong under any runner TZ if the zone is ignored.
 *  2. DST in BOTH directions. A one-hour error here is a tier that opens or
 *     shuts an hour off, which for a door-time handover means either a dead
 *     hour with nothing on sale or an hour with two tiers selling.
 *  3. The window's rules where they DIFFER from the scheduled price's:
 *     independent bounds, zero-width refused, and no both-or-neither.
 *  4. NFR-001 — an untouched control resolves to `unset`, so the caller can
 *     send the payload it sent before this feature existed.
 */

const draft = (over: Partial<SalesWindowDraft> = {}): SalesWindowDraft => ({
  enabled: true,
  openLocal: "2026-10-09T10:00",
  closeLocal: "2026-10-10T18:00",
  ...over,
});

const resolve = (
  over: Partial<SalesWindowDraft> = {},
  timeZone = "America/Chicago",
) => resolveSalesWindow(draft(over), { timeZone });

describe("resolveSalesWindowBoundIso — wall clock resolves in the EVENT's zone", () => {
  it("resolves the spec's worked example: 2026-10-01T20:00 New York", () => {
    // FR-009's acceptance criterion, shared with the schedule. EDT is UTC-4.
    expect(
      resolveSalesWindowBoundIso("2026-10-01T20:00", "America/New_York"),
    ).toBe("2026-10-02T00:00:00.000Z");
  });

  it("gives a DIFFERENT instant for the same wall clock in a different zone", () => {
    const wall = "2026-10-09T10:00";
    const instants = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ].map((zone) => resolveSalesWindowBoundIso(wall, zone));

    expect(instants).toEqual([
      "2026-10-09T14:00:00.000Z", // EDT, UTC-4
      "2026-10-09T15:00:00.000Z", // CDT, UTC-5
      "2026-10-09T16:00:00.000Z", // MDT, UTC-6
      "2026-10-09T17:00:00.000Z", // PDT, UTC-7
    ]);
    expect(new Set(instants).size).toBe(4);
  });

  it("refuses an unreadable or out-of-range wall clock", () => {
    for (const bad of [
      "",
      "   ",
      "friday night",
      "2026-10-09",
      "2026-13-01T00:00",
      "2026-10-32T00:00",
      "2026-10-09T24:00",
      "2026-10-09T12:60",
    ]) {
      expect(resolveSalesWindowBoundIso(bad, "America/Chicago")).toBeNull();
    }
  });

  it("refuses an unknown zone id rather than degrading to UTC", () => {
    // The whole point of the shared `isKnownTimeZone` guard: resolving against
    // UTC would put the on-sale moment up to 14 hours out with nothing on
    // screen to say so.
    expect(
      resolveSalesWindowBoundIso("2026-10-09T10:00", "Mars/Olympus_Mons"),
    ).toBeNull();
    expect(resolveSalesWindowBoundIso("2026-10-09T10:00", "")).toBeNull();
  });
});

describe("resolveSalesWindowBoundIso — DST, pinned in both directions", () => {
  // US Central 2026: spring forward 2026-03-08 (02:00 CST → 03:00 CDT),
  // fall back 2026-11-01 (02:00 CDT → 01:00 CST).

  it("SPRING FORWARD: the hour before the gap is CST (UTC-6)", () => {
    expect(
      resolveSalesWindowBoundIso("2026-03-08T01:30", "America/Chicago"),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("SPRING FORWARD: the hour AFTER the gap is CDT (UTC-5)", () => {
    // The case the single-probe `toIsoInTimeZone` gets an hour wrong, and the
    // reason neither this module nor the schedule uses it.
    expect(
      resolveSalesWindowBoundIso("2026-03-08T03:30", "America/Chicago"),
    ).toBe("2026-03-08T08:30:00.000Z");
  });

  it("FALL BACK: the ambiguous reading takes the FIRST occurrence (CDT)", () => {
    // 01:30 happens twice on 2026-11-01. 06:30Z is the first (CDT); 07:30Z
    // would be the second (CST). "Sales close at 1:30" means the earlier one.
    expect(
      resolveSalesWindowBoundIso("2026-11-01T01:30", "America/Chicago"),
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("FALL BACK: the hour after the transition is CST (UTC-6)", () => {
    expect(
      resolveSalesWindowBoundIso("2026-11-01T03:30", "America/Chicago"),
    ).toBe("2026-11-01T09:30:00.000Z");
  });

  it("SOUTHERN HEMISPHERE: the transitions run the other way round", () => {
    // Australia/Sydney 2026: DST ENDS 2026-04-05, BEGINS 2026-10-04 — the
    // inverse calendar of the US cases, so a fix that hardcodes the northern
    // order fails here.
    expect(
      resolveSalesWindowBoundIso("2026-04-04T20:00", "Australia/Sydney"),
    ).toBe("2026-04-04T09:00:00.000Z"); // AEDT, UTC+11
    expect(
      resolveSalesWindowBoundIso("2026-04-06T20:00", "Australia/Sydney"),
    ).toBe("2026-04-06T10:00:00.000Z"); // AEST, UTC+10
  });

  it("a window that STRADDLES a transition keeps both bounds honest", () => {
    // Opens 20:00 the evening before spring-forward, closes 20:00 the evening
    // after. Both are 20:00 locally, but the instants are 23 hours apart, not
    // 24 — which is exactly what an organizer means and what a naive
    // "+24h" would get wrong.
    const result = resolveSalesWindow(
      draft({ openLocal: "2026-03-07T20:00", closeLocal: "2026-03-08T20:00" }),
      { timeZone: "America/Chicago" },
    );
    expect(result).toEqual({
      kind: "set",
      salesOpenAt: "2026-03-08T02:00:00.000Z", // CST, UTC-6
      salesCloseAt: "2026-03-09T01:00:00.000Z", // CDT, UTC-5
    });
    const openMs = new Date("2026-03-08T02:00:00.000Z").getTime();
    const closeMs = new Date("2026-03-09T01:00:00.000Z").getTime();
    expect(closeMs - openMs).toBe(23 * 60 * 60 * 1000);
  });

  it("never depends on America/Chicago — the PAYOUT_TZ shortcut the spec forbids", () => {
    const wall = "2026-06-15T20:00";
    expect(resolveSalesWindowBoundIso(wall, "America/Los_Angeles")).not.toBe(
      resolveSalesWindowBoundIso(wall, "America/Chicago"),
    );
  });
});

describe("resolveSalesWindow — the two bounds are INDEPENDENT", () => {
  it("NFR-001: an untouched control resolves to `unset`", () => {
    expect(resolve({ enabled: false })).toEqual({
      kind: "unset",
      salesOpenAt: null,
      salesCloseAt: null,
    });
  });

  it("clears BOTH even when stale text is still in the fields", () => {
    // Defence in depth: the component wipes the fields on uncheck, but the
    // resolver must not emit a bound from an OFF draft either way.
    expect(resolve({ enabled: false })).toMatchObject({
      salesOpenAt: null,
      salesCloseAt: null,
    });
  });

  it("accepts an OPEN bound alone — 'opens Friday, never closes'", () => {
    expect(resolve({ closeLocal: "" })).toEqual({
      kind: "set",
      salesOpenAt: "2026-10-09T15:00:00.000Z", // 10:00 CDT
      salesCloseAt: null,
    });
  });

  it("accepts a CLOSE bound alone — 'on sale now, closes Friday'", () => {
    expect(resolve({ openLocal: "" })).toEqual({
      kind: "set",
      salesOpenAt: null,
      salesCloseAt: "2026-10-10T23:00:00.000Z", // 18:00 CDT
    });
  });

  it("accepts BOTH when open is strictly before close", () => {
    expect(resolve()).toEqual({
      kind: "set",
      salesOpenAt: "2026-10-09T15:00:00.000Z",
      salesCloseAt: "2026-10-10T23:00:00.000Z",
    });
  });

  it("refuses an INVERTED window", () => {
    expect(
      resolve({
        openLocal: "2026-10-10T18:00",
        closeLocal: "2026-10-09T10:00",
      }),
    ).toEqual({
      kind: "error",
      field: "close",
      titleKey: "admin.ttWindowInvalidTitle",
      messageKey: "admin.ttWindowOrderMessage",
      tone: "danger",
    });
  });

  it("refuses a ZERO-WIDTH window — the half-open interval is empty", () => {
    // `salesOpenAt` inclusive, `salesCloseAt` exclusive, so open === close can
    // never sell a ticket while looking fully configured.
    expect(
      resolve({
        openLocal: "2026-10-09T10:00",
        closeLocal: "2026-10-09T10:00",
      }),
    ).toEqual({
      kind: "error",
      field: "close",
      titleKey: "admin.ttWindowInvalidTitle",
      // NOT the inverted message. One string used to cover both orderings and
      // described the zero-width case, so an organizer who had typed a
      // BACKWARDS pair was told they had entered the same moment twice.
      messageKey: "admin.ttWindowZeroWidthMessage",
      tone: "danger",
    });
  });

  it("gives the two orderings DIFFERENT messages", () => {
    const inverted = resolve({
      openLocal: "2026-10-10T18:00",
      closeLocal: "2026-10-09T10:00",
    });
    const zeroWidth = resolve({
      openLocal: "2026-10-09T10:00",
      closeLocal: "2026-10-09T10:00",
    });
    expect(inverted).toMatchObject({ kind: "error" });
    expect(zeroWidth).toMatchObject({ kind: "error" });
    expect((inverted as { messageKey: string }).messageKey).not.toBe(
      (zeroWidth as { messageKey: string }).messageKey,
    );
  });

  it("accepts a ONE-MINUTE window — the narrowest thing that can still sell", () => {
    expect(
      resolve({
        openLocal: "2026-10-09T10:00",
        closeLocal: "2026-10-09T10:01",
      }),
    ).toMatchObject({ kind: "set" });
  });

  it("refuses a ticked-but-empty control instead of silently meaning nothing", () => {
    expect(resolve({ openLocal: "", closeLocal: "" })).toEqual({
      kind: "error",
      field: "window",
      titleKey: "admin.ttWindowInvalidTitle",
      messageKey: "admin.ttWindowEmptyMessage",
      // Blocks the submit exactly as hard as an inverted pair, but reads as
      // guidance rather than a red refusal: it fires the instant the box is
      // ticked, before the organizer has had a chance to do anything wrong.
      tone: "pending",
    });
  });

  it("names the field an unreadable bound belongs to", () => {
    expect(resolve({ openLocal: "friday" })).toMatchObject({
      field: "open",
      messageKey: "admin.ttWindowOpenInvalidMessage",
    });
    expect(resolve({ closeLocal: "friday" })).toMatchObject({
      field: "close",
      messageKey: "admin.ttWindowCloseInvalidMessage",
    });
  });

  it("refuses rather than resolving when the zone is unknown or missing", () => {
    // The important half: never resolved against UTC or the browser's clock.
    expect(resolve({}, "Mars/Olympus_Mons")).toMatchObject({ kind: "error" });
    // "" is the "timezone still in flight" shape the editor passes.
    expect(resolve({}, "")).toMatchObject({ kind: "error" });
  });

  it("blames the missing ZONE, not the organizer's perfectly good dates", () => {
    // Before this arm existed, a zone that never arrived made every bound
    // unreadable and the toast read "That opening date and time couldn't be
    // read. Pick it again." — naming a field that is fine, for a condition
    // re-picking cannot fix.
    for (const zone of ["", "Mars/Olympus_Mons"]) {
      expect(resolve({}, zone)).toEqual({
        kind: "error",
        field: "window",
        titleKey: "admin.ttWindowInvalidTitle",
        messageKey: "admin.ttWindowTimezonePending",
        tone: "pending",
      });
    }
    // And it wins over the per-bound reads, which cannot be evaluated anyway.
    expect(resolve({ openLocal: "friday" }, "")).toMatchObject({
      messageKey: "admin.ttWindowTimezonePending",
    });
  });
});

describe("classifySalesWindowOrder — inverted and zero-width are NOT the same mistake", () => {
  const OPEN = "2026-10-09T15:00:00.000Z";
  const CLOSE = "2026-10-10T23:00:00.000Z";

  it("names a backwards pair `inverted`", () => {
    expect(classifySalesWindowOrder(CLOSE, OPEN)).toBe("inverted");
  });

  it("names an identical pair `zeroWidth`", () => {
    // The closing bound is EXCLUSIVE, so this interval is empty — a tier that
    // looks configured and can never sell.
    expect(classifySalesWindowOrder(OPEN, OPEN)).toBe("zeroWidth");
  });

  it("is null for a good pair, an incomplete one, or an unreadable one", () => {
    expect(classifySalesWindowOrder(OPEN, CLOSE)).toBeNull();
    // A single bound is a COMPLETE configuration for a window; there is no
    // ordering to judge.
    expect(classifySalesWindowOrder(OPEN, null)).toBeNull();
    expect(classifySalesWindowOrder(null, CLOSE)).toBeNull();
    expect(classifySalesWindowOrder(null, null)).toBeNull();
    // Never claim an ordering from an instant that isn't one — NaN comparisons
    // are all false, so a naive `>=` would silently report "fine".
    expect(classifySalesWindowOrder("friday", CLOSE)).toBeNull();
    expect(classifySalesWindowOrder(OPEN, "friday")).toBeNull();
  });

  it("accepts the narrowest window that can still sell — one minute", () => {
    expect(
      classifySalesWindowOrder(
        "2026-10-09T15:00:00.000Z",
        "2026-10-09T15:01:00.000Z",
      ),
    ).toBeNull();
  });
});

describe("resolveSalesWindow — what the control shows INLINE", () => {
  /**
   * The control no longer runs its own inverted-pair predicate. It renders the
   * resolver's refusal, and the Add/Save button is disabled from the same
   * object — the defect this replaced was the two disagreeing: the panel showed
   * an error while the button still invited the click that would fail.
   */
  it("says nothing about a half-typed pair", () => {
    // Shouting mid-keystroke trains an organizer to ignore the message that
    // matters. One bound alone is a legitimate, complete window.
    expect(resolve({ closeLocal: "" })).toMatchObject({ kind: "set" });
    expect(resolve({ openLocal: "" })).toMatchObject({ kind: "set" });
  });

  it("says nothing at all about an UNCHECKED control", () => {
    expect(resolve({ enabled: false })).toMatchObject({ kind: "unset" });
  });

  it("blames the bound that cannot be read, not the ordering", () => {
    expect(resolve({ closeLocal: "2026-10" })).toMatchObject({
      field: "close",
      messageKey: "admin.ttWindowCloseInvalidMessage",
      tone: "danger",
    });
  });
});

describe("salesWindowDraftFromTicketType — seeding the edit form", () => {
  it("round-trips both stored bounds back to the organizer's wall clock", () => {
    expect(
      salesWindowDraftFromTicketType(
        {
          salesOpenAt: "2026-10-09T15:00:00.000Z",
          salesCloseAt: "2026-10-10T23:00:00.000Z",
        },
        "America/Chicago",
      ),
    ).toEqual({
      enabled: true,
      openLocal: "2026-10-09T10:00",
      closeLocal: "2026-10-10T18:00",
    });
  });

  it("seeds a SINGLE stored bound as ENABLED with the other field blank", () => {
    // The difference from the schedule's both-or-neither seed: a one-bound
    // window is complete, so seeding it "off" would make an untouched Save look
    // like a removal.
    expect(
      salesWindowDraftFromTicketType(
        { salesOpenAt: "2026-10-09T15:00:00.000Z", salesCloseAt: null },
        "America/Chicago",
      ),
    ).toEqual({
      enabled: true,
      openLocal: "2026-10-09T10:00",
      closeLocal: "",
    });
    expect(
      salesWindowDraftFromTicketType(
        { salesOpenAt: null, salesCloseAt: "2026-10-10T23:00:00.000Z" },
        "America/Chicago",
      ),
    ).toEqual({
      enabled: true,
      openLocal: "",
      closeLocal: "2026-10-10T18:00",
    });
  });

  it("is DISABLED for an unwindowed row or a row missing the fields", () => {
    const empty = emptySalesWindowDraft();
    expect(
      salesWindowDraftFromTicketType(
        { salesOpenAt: null, salesCloseAt: null },
        "America/Chicago",
      ),
    ).toEqual(empty);
    expect(salesWindowDraftFromTicketType({}, "America/Chicago")).toEqual(
      empty,
    );
  });

  it("returns a DISABLED draft for an unknown zone instead of THROWING", () => {
    // `handleStartEdit` is a click handler and the re-seed runs during commit;
    // a RangeError out of `Intl.DateTimeFormat` would unmount the builder via
    // the error boundary and lose unsaved work on an unrelated form.
    const row = { salesOpenAt: "2026-10-09T15:00:00.000Z", salesCloseAt: null };
    expect(() =>
      salesWindowDraftFromTicketType(row, "Mars/Olympus_Mons"),
    ).not.toThrow();
    expect(salesWindowDraftFromTicketType(row, "Mars/Olympus_Mons")).toEqual(
      emptySalesWindowDraft(),
    );
    expect(salesWindowDraftFromTicketType(row, "")).toEqual(
      emptySalesWindowDraft(),
    );
  });
});

describe("describeSalesWindow — the ticket-list read-back", () => {
  const enFormat = (value: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", options).format(value);
  const NOW = new Date("2026-10-01T00:00:00.000Z");

  it("names the EVENT's zone, not the runner's", () => {
    expect(
      describeSalesWindow(
        {
          salesOpenAt: "2026-10-09T15:00:00.000Z",
          salesCloseAt: "2026-10-10T23:00:00.000Z",
        },
        "America/Chicago",
        enFormat,
        NOW,
      ),
    ).toEqual({
      key: "admin.ttWindowSummaryRange",
      values: {
        opens: "Fri, Oct 9, 10:00 AM CDT",
        closes: "Sat, Oct 10, 6:00 PM CDT",
      },
    });
  });

  it("picks the single-bound key when only one bound is set", () => {
    expect(
      describeSalesWindow(
        { salesOpenAt: "2026-10-09T15:00:00.000Z" },
        "America/Chicago",
        enFormat,
        NOW,
      ),
    ).toMatchObject({ key: "admin.ttWindowSummaryFrom" });
    expect(
      describeSalesWindow(
        { salesCloseAt: "2026-10-10T23:00:00.000Z" },
        "America/Chicago",
        enFormat,
        NOW,
      ),
    ).toMatchObject({ key: "admin.ttWindowSummaryUntil" });
  });

  it("switches to PAST tense once the closing bound has passed", () => {
    // A row promising "on sale until Oct 10" after Oct 10 contradicts the
    // buyer-facing "Sales ended" the same tier is showing.
    expect(
      describeSalesWindow(
        {
          salesOpenAt: "2026-10-09T15:00:00.000Z",
          salesCloseAt: "2026-10-10T23:00:00.000Z",
        },
        "America/Chicago",
        enFormat,
        new Date("2026-10-11T00:00:00.000Z"),
      ),
    ).toMatchObject({ key: "admin.ttWindowSummaryEnded" });
  });

  it("treats exactly the closing instant as ENDED — the bound is EXCLUSIVE", () => {
    expect(
      describeSalesWindow(
        { salesCloseAt: "2026-10-10T23:00:00.000Z" },
        "America/Chicago",
        enFormat,
        new Date("2026-10-10T23:00:00.000Z"),
      ),
    ).toMatchObject({ key: "admin.ttWindowSummaryEnded" });
    expect(
      describeSalesWindow(
        { salesCloseAt: "2026-10-10T23:00:00.000Z" },
        "America/Chicago",
        enFormat,
        new Date("2026-10-10T22:59:59.999Z"),
      ),
    ).toMatchObject({ key: "admin.ttWindowSummaryUntil" });
  });

  it("shows the winter abbreviation on the other side of a transition", () => {
    const summary = describeSalesWindow(
      { salesOpenAt: "2026-12-03T06:00:00.000Z" },
      "America/Chicago",
      enFormat,
      NOW,
    );
    expect(summary?.values.opens).toContain("CST");
  });

  it("withholds the line rather than rendering it on the WRONG clock", () => {
    expect(
      describeSalesWindow(
        { salesOpenAt: "2026-10-09T15:00:00.000Z" },
        null,
        enFormat,
        NOW,
      ),
    ).toBeNull();
    expect(
      describeSalesWindow(
        { salesOpenAt: "2026-10-09T15:00:00.000Z" },
        "Mars/Olympus_Mons",
        enFormat,
        NOW,
      ),
    ).toBeNull();
  });

  it("is null for an unwindowed row", () => {
    expect(
      describeSalesWindow({}, "America/Chicago", enFormat, NOW),
    ).toBeNull();
    expect(
      describeSalesWindow(
        { salesOpenAt: null, salesCloseAt: null },
        "America/Chicago",
        enFormat,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("every i18n key this feature can emit exists in BOTH catalogs", () => {
  const emitted = new Set<string>();
  for (const over of [
    { openLocal: "", closeLocal: "" },
    { openLocal: "friday" },
    { closeLocal: "friday" },
    { openLocal: "2026-10-10T18:00", closeLocal: "2026-10-09T10:00" },
    // The zero-width pair emits its OWN key, so the catalog gate has to see it
    // separately from the inverted one.
    { openLocal: "2026-10-09T10:00", closeLocal: "2026-10-09T10:00" },
  ] as Partial<SalesWindowDraft>[]) {
    const result = resolve(over);
    if (result.kind === "error") {
      emitted.add(result.titleKey);
      emitted.add(result.messageKey);
    }
  }
  // Keys the component and the list row render directly, which the resolver
  // never returns.
  for (const key of [
    "admin.ttWindowToggle",
    "admin.ttWindowHelp",
    "admin.ttWindowOpensAt",
    "admin.ttWindowClosesAt",
    "admin.ttWindowOpensReadback",
    "admin.ttWindowClosesReadback",
    "admin.ttWindowBoundaryNote",
    "admin.ttWindowZoneNote",
    "admin.ttWindowTimezonePending",
    "admin.ttWindowSummaryRange",
    "admin.ttWindowSummaryFrom",
    "admin.ttWindowSummaryUntil",
    "admin.ttWindowSummaryEnded",
    "errors.ticketTypeSalesWindowInvalid",
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
    expect(emitted.size).toBeGreaterThan(15);
    for (const key of emitted) {
      const [namespace, name] = key.split(".");
      const value = catalog[namespace!]?.[name!];
      expect(typeof value, `${_locale} is missing ${key}`).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
    }
  });

  it("keeps the {when}/{opens}/{closes}/{timeZone} placeholders in both locales", () => {
    // An argument-parity drift here throws inside IntlMessageFormat in exactly
    // one locale, or renders a raw placeholder to the one person who has to
    // verify the timezone.
    for (const messages of [enMessages, esMessages]) {
      const admin = (messages as unknown as { admin: Record<string, string> })
        .admin;
      expect(admin.ttWindowOpensReadback).toContain("{when}");
      expect(admin.ttWindowClosesReadback).toContain("{when}");
      expect(admin.ttWindowZoneNote).toContain("{timeZone}");
      expect(admin.ttWindowSummaryRange).toContain("{opens}");
      expect(admin.ttWindowSummaryRange).toContain("{closes}");
      expect(admin.ttWindowSummaryFrom).toContain("{opens}");
      expect(admin.ttWindowSummaryUntil).toContain("{closes}");
      expect(admin.ttWindowSummaryEnded).toContain("{closes}");
    }
  });

  it("passes exactly the arguments each summary key references", () => {
    // `IntlMessageFormat` THROWS on an argument it was not given, so a summary
    // that names {closes} while `describeSalesWindow` supplies only {opens}
    // would take out the ticket list.
    const enFormat = (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value);
    const admin = (enMessages as unknown as { admin: Record<string, string> })
      .admin;
    const cases = [
      { salesOpenAt: "2026-10-09T15:00:00.000Z", salesCloseAt: null },
      { salesOpenAt: null, salesCloseAt: "2026-10-10T23:00:00.000Z" },
      {
        salesOpenAt: "2026-10-09T15:00:00.000Z",
        salesCloseAt: "2026-10-10T23:00:00.000Z",
      },
      { salesOpenAt: null, salesCloseAt: "2020-01-01T00:00:00.000Z" },
    ];
    for (const tt of cases) {
      const summary = describeSalesWindow(
        tt,
        "America/Chicago",
        enFormat,
        new Date("2026-10-01T00:00:00.000Z"),
      )!;
      expect(summary).not.toBeNull();
      const template = admin[summary.key.split(".")[1]!]!;
      for (const arg of ["opens", "closes"]) {
        expect(
          template.includes(`{${arg}}`),
          `${summary.key} references {${arg}} but was not given it`,
        ).toBe(arg in summary.values);
      }
    }
  });
});
