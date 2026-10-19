import { describe, expect, it } from "vitest";

import type { EventSlugContext } from "@th/ports/repos/events";
import { isAppError } from "@th/errors";

import {
  generateEventSlug,
  testablesForSlugGeneration,
} from "../_shared/slug";

/**
 * Unit tests for the EVENT slug generator — the analogue of
 * `use-cases/places/__tests__/slug.test.ts`.
 *
 * This had no coverage at all before slug-at-create, including the
 * `EVENT_LOCATION_REQUIRED` throw that is now load-bearing: it is the branch
 * that decides whether a brand-new event gets a URL, and both the create-time
 * assignment and the publish-time re-derive treat it as an EXPECTED outcome
 * they swallow rather than an error they report. `testablesForSlugGeneration`
 * has been exported for a test like this since the module was written and had
 * no callers.
 */

const EVENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
/** `deriveShortIdFromUuid(EVENT_ID)` — pinned so slug assertions stay exact. */
const EVENT_SHORT_ID = "2dmtus8w40";

function makeContext(
  overrides: Partial<EventSlugContext> = {},
): EventSlugContext {
  return {
    eventId: EVENT_ID,
    orgId: "11111111-1111-4111-8111-111111111111",
    humanId: null,
    eventTitle: "Spring Fling",
    // 20:30Z is 15:30 CDT: the slug's date segment is the LOCAL start.
    startsAt: new Date("2026-04-18T20:30:00.000Z"),
    timezone: "America/Chicago",
    orgName: "Drkmttr",
    countryCode: "US",
    regionCode: "TN",
    cityOrRegionCode: "Nashville",
    shortId: null,
    ...overrides,
  } satisfies EventSlugContext;
}

describe("generateEventSlug", () => {
  // -----------------------------------------------------------------------
  // Shape
  // -----------------------------------------------------------------------
  it("produces {host}/{country}/{region}/{title}-{date}--{shortId}", () => {
    const result = generateEventSlug(makeContext());
    expect(result.slug).toBe(
      `drkmttr/us/nashville/spring-fling-2026-04-18-1530--${EVENT_SHORT_ID}`,
    );
    expect(result.shortId).toBe(EVENT_SHORT_ID);
    expect(result.regionCode).toBe("TN");
  });

  it("prefers cityOrRegionCode over regionCode for the location segment", () => {
    const result = generateEventSlug(
      makeContext({ regionCode: "TN", cityOrRegionCode: "Memphis" }),
    );
    expect(result.slug).toContain("/us/memphis/");
    // `regionCode` is what gets PERSISTED, and it is unaffected by which of
    // the two won the segment.
    expect(result.regionCode).toBe("TN");
  });

  it("falls back to regionCode when there is no city", () => {
    const result = generateEventSlug(
      makeContext({ cityOrRegionCode: null }),
    );
    expect(result.slug).toContain("/us/tn/");
  });

  it("falls back to 'general' when neither city nor region is known", () => {
    const result = generateEventSlug(
      makeContext({ regionCode: null, cityOrRegionCode: null }),
    );
    expect(result.slug).toContain("/us/general/");
    expect(result.regionCode).toBeNull();
  });

  // -----------------------------------------------------------------------
  // The location gate — the branch slug-at-create hangs off
  // -----------------------------------------------------------------------
  it("throws EVENT_LOCATION_REQUIRED when there is no country code", () => {
    let thrown: unknown;
    try {
      generateEventSlug(makeContext({ countryCode: null }));
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe("EVENT_LOCATION_REQUIRED");
  });

  it("throws EVENT_LOCATION_REQUIRED for an EMPTY-STRING country code", () => {
    // The guard is falsy-based, not null-based. A place row with `country: ""`
    // must not produce an `//`-segmented slug.
    expect(() => generateEventSlug(makeContext({ countryCode: "" }))).toThrow();
  });

  it("does NOT throw when only the country is known", () => {
    const result = generateEventSlug(
      makeContext({
        countryCode: "SG",
        regionCode: null,
        cityOrRegionCode: null,
      }),
    );
    expect(result.slug).toContain("/sg/general/");
  });

  // -----------------------------------------------------------------------
  // Host segment
  // -----------------------------------------------------------------------
  // A PERSON's name never reaches an event URL: name + city + date is a
  // people-search lead to a home address. Person-owned events get the neutral
  // `event` host; only an org's name is ever used.
  it("uses 'event' as the host for a person-owned event (no org)", () => {
    const result = generateEventSlug(
      makeContext({ orgId: null, orgName: null, humanId: EVENT_ID }),
    );
    expect(result.slug).toBe(
      `event/us/nashville/spring-fling-2026-04-18-1530--${EVENT_SHORT_ID}`,
    );
  });

  it("uses the org's name for an org-owned event (unchanged)", () => {
    const result = generateEventSlug(
      makeContext({ humanId: EVENT_ID, orgName: "Drkmttr" }),
    );
    expect(result.slug.startsWith("drkmttr/")).toBe(true);
  });

  describe("never leaks a person's name, even if a caller smuggles one in", () => {
    // `EventSlugContext` has no `humanName` field. These cases hand the
    // generator one anyway (as an untyped adapter row could) and prove it is
    // ignored — the host is `event` and no fragment of the name appears.
    const names: Array<[string, string[]]> = [
      ["Ada Lovelace", ["ada", "lovelace"]],
      ["José Ñúñez-García", ["jose", "nunez", "garcia"]],
      ["Zoë O'Brien", ["zoe", "brien"]],
      ["Siobhán Mac Giolla Phádraig", ["siobhan", "giolla", "phadraig"]],
      ["Łukasz Żółkiewski", ["ukasz", "lkiewski"]],
      ["李小龙 Bruce", ["bruce"]],
    ];

    it.each(names)("%s", (humanName, fragments) => {
      const context = {
        ...makeContext({
          orgId: null,
          orgName: null,
          humanId: EVENT_ID,
          eventTitle: "House Show",
        }),
        humanName,
        human: { name: humanName },
      } as unknown as EventSlugContext;

      const { slug } = generateEventSlug(context);

      expect(slug.split("/")[0]).toBe("event");
      for (const fragment of fragments) {
        expect(slug).not.toContain(fragment);
      }
    });
  });

  it("falls back to 'event' when the org has no usable name", () => {
    const result = generateEventSlug(makeContext({ orgName: null }));
    expect(result.slug.startsWith("event/")).toBe(true);
  });

  it("falls back to 'event' for an emoji-only host name", () => {
    const result = generateEventSlug(makeContext({ orgName: "🎸🔥" }));
    expect(result.slug.startsWith("event/")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Title segment
  // -----------------------------------------------------------------------
  it("strips accents from the title", () => {
    const result = generateEventSlug(
      makeContext({ eventTitle: "Soirée à Montréal" }),
    );
    expect(result.slug).toContain("/soiree-a-montreal-");
  });

  it("falls back to 'event' for an empty title", () => {
    const result = generateEventSlug(makeContext({ eventTitle: "" }));
    expect(result.slug).toContain("/event-2026-04-18-1530--");
  });

  it("truncates a very long title to 96 characters", () => {
    const result = generateEventSlug(
      makeContext({ eventTitle: "A".repeat(300) }),
    );
    const lastSegment = result.slug.split("/").pop()!;
    const titlePart = lastSegment.split("-2026-04-18-1530--")[0]!;
    expect(titlePart.length).toBeLessThanOrEqual(96);
  });

  // -----------------------------------------------------------------------
  // Date segment: the event's LOCAL start, in `Event.timezone`
  // -----------------------------------------------------------------------
  // Regression (prod, 2026-10-13): the segment used to format the UTC
  // instant, so a 7pm CDT show (00:00Z the next day) got tomorrow's date.
  // Each case is pinned to an explicit zone, so the result is the same on a
  // UTC machine and a Chicago one (run with TZ=UTC and TZ=America/Chicago).
  it.each([
    {
      name: "7pm CDT, the evening that crosses midnight UTC",
      startsAt: "2026-10-13T00:00:00.000Z",
      timezone: "America/Chicago",
      segment: "-2026-10-12-1900--",
    },
    {
      name: "10pm CDT Tuesday",
      startsAt: "2026-10-14T03:00:00.000Z",
      timezone: "America/Chicago",
      segment: "-2026-10-13-2200--",
    },
    {
      name: "2pm CDT, same day in both zones",
      startsAt: "2026-10-13T19:00:00.000Z",
      timezone: "America/Chicago",
      segment: "-2026-10-13-1400--",
    },
    {
      name: "7pm CST in winter (UTC-6, not -5)",
      startsAt: "2026-12-08T01:00:00.000Z",
      timezone: "America/Chicago",
      segment: "-2026-12-07-1900--",
    },
    {
      name: "9pm PDT in Los Angeles",
      startsAt: "2026-10-13T04:00:00.000Z",
      timezone: "America/Los_Angeles",
      segment: "-2026-10-12-2100--",
    },
  ])("formats the date segment as local time: $name", (c) => {
    const result = generateEventSlug(
      makeContext({ startsAt: new Date(c.startsAt), timezone: c.timezone }),
    );
    expect(result.slug).toContain(c.segment);
  });

  it("zero-pads the local date and time", () => {
    const result = generateEventSlug(
      makeContext({
        startsAt: new Date("2026-01-02T09:04:00.000Z"),
        timezone: "America/Chicago",
      }),
    );
    expect(result.slug).toContain("-2026-01-02-0304--");
  });

  it("writes local midnight as 0000 of the same day", () => {
    const result = generateEventSlug(
      makeContext({
        startsAt: new Date("2026-10-13T05:00:00.000Z"),
        timezone: "America/Chicago",
      }),
    );
    expect(result.slug).toContain("-2026-10-13-0000--");
  });

  it("falls back to America/Chicago for an unknown or empty zone", () => {
    const at = new Date("2026-10-13T00:00:00.000Z");
    for (const timezone of ["Mars/Olympus_Mons", ""]) {
      const result = generateEventSlug(
        makeContext({ startsAt: at, timezone }),
      );
      expect(result.slug).toContain("-2026-10-12-1900--");
    }
  });

  // -----------------------------------------------------------------------
  // shortId
  // -----------------------------------------------------------------------
  it("derives the shortId from the event id when none is stored", () => {
    const result = generateEventSlug(
      makeContext({ eventId: "deadbeef-0000-0000-0000-000000000000" }),
    );
    expect(result.shortId).toBe("6n42vyc4jk");
    expect(result.slug.endsWith("--6n42vyc4jk")).toBe(true);
  });

  it("REUSES an already-stored shortId", () => {
    // This is what makes the publish-time re-derive safe: `updateSlug` never
    // touches `shortId`, so the suffix has to come back identical or the two
    // slugs would not obviously be the same event.
    const result = generateEventSlug(makeContext({ shortId: "abc123xyz0" }));
    expect(result.shortId).toBe("abc123xyz0");
    expect(result.slug.endsWith("--abc123xyz0")).toBe(true);
  });

  it("sanitises a stored shortId that carries junk", () => {
    const result = generateEventSlug(makeContext({ shortId: "AB-C1_23!" }));
    expect(result.shortId).toBe("abc1230000");
  });

  it("falls back to the derived shortId when the stored one sanitises to empty", () => {
    const result = generateEventSlug(makeContext({ shortId: "!!!" }));
    expect(result.shortId).toBe(EVENT_SHORT_ID);
  });

  // -----------------------------------------------------------------------
  // Determinism / uniqueness
  // -----------------------------------------------------------------------
  it("is deterministic for the same context", () => {
    expect(generateEventSlug(makeContext()).slug).toBe(
      generateEventSlug(makeContext()).slug,
    );
  });

  it("produces different slugs for identical events with different ids", () => {
    const a = generateEventSlug(
      makeContext({ eventId: "11111111-1111-1111-1111-111111111111" }),
    );
    const b = generateEventSlug(
      makeContext({ eventId: "22222222-2222-2222-2222-222222222222" }),
    );
    expect(a.slug).not.toBe(b.slug);
  });

  it("re-derives a DIFFERENT slug when only the title changed", () => {
    // The premise of the publish-time re-derive: an event created as
    // "Untitled" and published as "Spring Fling" must not keep the first URL.
    const before = generateEventSlug(
      makeContext({ eventTitle: "Untitled event", shortId: EVENT_SHORT_ID }),
    );
    const after = generateEventSlug(
      makeContext({ eventTitle: "Spring Fling", shortId: EVENT_SHORT_ID }),
    );
    expect(after.slug).not.toBe(before.slug);
    // …but the shortId suffix is stable across the rename.
    expect(after.shortId).toBe(before.shortId);
  });
});

describe("testablesForSlugGeneration", () => {
  it("exposes the internal helpers the module documents", () => {
    const t = testablesForSlugGeneration();
    expect(t.sanitizeCountryCode("us-A")).toBe("usa");
    expect(t.sanitizeCountryCode(null)).toBe("xx");
    expect(t.slugSegment("  ", "fallback", 10)).toBe("fallback");
    expect(t.sanitizeText("Café Noir")).toBe("cafe-noir");
    expect(
      t.formatDateSegment(new Date("2026-12-05T07:09:00.000Z"), "UTC"),
    ).toBe("2026-12-05-0709");
    expect(
      t.formatDateSegment(
        new Date("2026-12-05T07:09:00.000Z"),
        "America/Chicago",
      ),
    ).toBe("2026-12-05-0109");
    expect(t.deriveShortIdFromEventId(EVENT_ID)).toBe(EVENT_SHORT_ID);
    expect(t.ensureShortId(makeContext())).toBe(EVENT_SHORT_ID);
  });
});
