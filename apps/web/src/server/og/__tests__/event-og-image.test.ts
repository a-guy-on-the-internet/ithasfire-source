import { describe, expect, it, vi } from "vitest";

import {
  eventOgImageSignature,
  eventStubCaption,
  eventStubVenueLine,
  pickHeroImageUrl,
  resolveEventOgImage,
  type EventOgImageInput,
} from "@th/types/seo/eventOgImage";

vi.mock("@/config/site", () => ({
  getSiteUrl: () => "https://ithasfire.com",
  getSiteName: () => "Ithas Fire",
  buildCanonicalUrl: (p: string) => `https://ithasfire.com${p}`,
}));

const BASE = "https://ithasfire.com";

const anEvent = (
  overrides: Partial<EventOgImageInput> = {},
): EventOgImageInput => ({
  id: "8f0b2e30-1c2a-4c1f-9f9c-0b0d0a0e0f01",
  slug: "drkmttr/us/nashville/sunset-session--ab12cd",
  title: "Sunset Session Vol. 03",
  startsAt: new Date("2026-09-20T18:00:00.000Z"),
  timezone: "America/Chicago",
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  images: [],
  venueName: "Skyline Rooftop",
  ...overrides,
});

describe("resolveEventOgImage", () => {
  it("returns the STUB url when the event has no hero image", () => {
    const resolved = resolveEventOgImage(anEvent(), BASE);
    expect(resolved.kind).toBe("stub");
    if (resolved.kind !== "stub") throw new Error("unreachable");
    expect(resolved.url).toBe(
      `${BASE}/og/event/drkmttr/us/nashville/sunset-session--ab12cd?v=${resolved.signature}`,
    );
    expect(resolved.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the HERO url when the event has one", () => {
    const resolved = resolveEventOgImage(
      anEvent({ images: ["https://cdn.example.com/poster.jpg"] }),
      BASE,
    );
    expect(resolved).toEqual({
      kind: "hero",
      url: "https://cdn.example.com/poster.jpg",
    });
  });

  it("skips empty/whitespace entries when picking the hero", () => {
    expect(pickHeroImageUrl([null, "", "   ", "https://x.test/a.png"])).toBe(
      "https://x.test/a.png",
    );
    expect(pickHeroImageUrl([])).toBeNull();
    expect(pickHeroImageUrl(null)).toBeNull();
  });

  it("drops traversal segments from the slug path", () => {
    // `.` is UNRESERVED, so `encodeURIComponent("..")` returns it untouched.
    // Safe today only because slugs are sanitized upstream — which is precisely
    // the dependency this filter removes.
    const resolved = resolveEventOgImage(
      anEvent({ slug: "org/../us/./general/show--zz99" }),
      BASE,
    );
    if (resolved.kind !== "stub") throw new Error("expected a stub");
    expect(resolved.url).toContain("/og/event/org/us/general/show--zz99?v=");
  });

  it("refuses a base url that is not an http(s) origin", () => {
    // A scheme-less `PUBLIC_WEB_URL` used to splice into
    // `ithasfire.com/og/event/…`; a base with a query used to splice into
    // `https://x.test/?utm=1/og/event/…`. Neither is a URL anyone meant.
    expect(resolveEventOgImage(anEvent(), "ithasfire.com")).toEqual({
      kind: "hero",
      url: "/og-image-v2.png",
    });
    const withQuery = resolveEventOgImage(anEvent(), "https://x.test/?utm=1");
    if (withQuery.kind !== "stub") throw new Error("expected a stub");
    expect(withQuery.url.startsWith("https://x.test/og/event/")).toBe(true);
  });

  it("keeps slug slashes as path separators and escapes within segments", () => {
    const resolved = resolveEventOgImage(
      anEvent({ slug: "org/us/general/a b?c--zz99" }),
      BASE,
    );
    if (resolved.kind !== "stub") throw new Error("expected a stub");
    expect(resolved.url).toContain(
      "/og/event/org/us/general/a%20b%3Fc--zz99?v=",
    );
  });

  it("tolerates a trailing slash on the base url", () => {
    const resolved = resolveEventOgImage(anEvent(), "https://ithasfire.com///");
    if (resolved.kind !== "stub") throw new Error("expected a stub");
    expect(resolved.url.startsWith("https://ithasfire.com/og/event/")).toBe(
      true,
    );
  });

  // ── Totality ─────────────────────────────────────────────────────────────
  it.each([
    ["a null startsAt", anEvent({ startsAt: null })],
    ["an undefined startsAt", anEvent({ startsAt: undefined })],
    ["an Invalid Date", anEvent({ startsAt: new Date("garbage") })],
    ["a bogus timezone", anEvent({ timezone: "Mars/Olympus_Mons" })],
    ["an empty title", anEvent({ title: "" })],
    ["a missing venue", anEvent({ venueName: null })],
  ])("never throws and returns a usable stub for %s", (_label, event) => {
    const resolved = resolveEventOgImage(event, BASE);
    expect(resolved.kind).toBe("stub");
    expect(() => new URL(resolved.url)).not.toThrow();
  });

  it("degrades to the static poster when the event has no slug", () => {
    expect(resolveEventOgImage(anEvent({ slug: "" }), BASE)).toEqual({
      kind: "hero",
      url: `${BASE}/og-image-v2.png`,
    });
  });

  it("degrades to the static poster rather than throwing on junk input", () => {
    const resolved = resolveEventOgImage(
      undefined as unknown as EventOgImageInput,
      BASE,
    );
    expect(resolved).toEqual({ kind: "hero", url: `${BASE}/og-image-v2.png` });
  });
});

describe("eventOgImageSignature", () => {
  it("is stable for identical input", () => {
    expect(eventOgImageSignature(anEvent())).toBe(
      eventOgImageSignature(anEvent()),
    );
  });

  /**
   * THE regression this whole design exists for.
   *
   * Attaching an image writes an `EventImage` row and is NOT guaranteed to bump
   * `Event.updatedAt`. An `updatedAt`-keyed cache key would therefore hand back
   * the SAME `?v=` after a real poster was uploaded, so every surface that had
   * already cached that URL would keep showing the generated stub. (The route
   * closes the other half by refusing to serve a stub under an unbounded cache
   * — see its cache constants.)
   */
  it("CHANGES when a hero image is attached even though updatedAt is UNCHANGED", () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    const before = anEvent({ updatedAt, images: [] });
    const after = anEvent({
      updatedAt, // identical — the whole point
      images: ["https://cdn.example.com/poster.jpg"],
    });

    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(eventOgImageSignature(after)).not.toBe(
      eventOgImageSignature(before),
    );
  });

  it("changes when the hero image is REPLACED with a different one", () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    expect(
      eventOgImageSignature(
        anEvent({ updatedAt, images: ["https://cdn.test/a.jpg"] }),
      ),
    ).not.toBe(
      eventOgImageSignature(
        anEvent({ updatedAt, images: ["https://cdn.test/b.jpg"] }),
      ),
    );
  });

  it.each([
    ["title", { title: "A Different Title" }],
    ["startsAt", { startsAt: new Date("2026-09-21T18:00:00.000Z") }],
    ["venueName", { venueName: "Another Room" }],
    ["updatedAt", { updatedAt: new Date("2026-09-02T12:00:00.000Z") }],
  ])("changes when %s changes", (_field, patch) => {
    expect(eventOgImageSignature(anEvent(patch))).not.toBe(
      eventOgImageSignature(anEvent()),
    );
  });

  it("does not change when only the timezone changes", () => {
    // The stub renders the date in the venue's zone, so the zone IS a rendered
    // input — but it only matters via `startsAt`, which is already hashed as an
    // absolute instant. Documented here so the omission is deliberate rather
    // than forgotten: a zone change with the same instant CAN move the printed
    // day. Left out because `Event.timezone` never changes without `updatedAt`
    // moving (it is a column on the event itself, written by `save-event`).
    expect(eventOgImageSignature(anEvent({ timezone: "UTC" }))).toBe(
      eventOgImageSignature(anEvent({ timezone: "America/Chicago" })),
    );
  });

  it("cannot be collided by shifting a boundary between fields", () => {
    expect(
      eventOgImageSignature(anEvent({ title: "ab", venueName: "" })),
    ).not.toBe(eventOgImageSignature(anEvent({ title: "a", venueName: "b" })));
  });
});

describe("withGeneratedEventOgImage", () => {
  it("injects the stub for an image-less event and upgrades the twitter card", async () => {
    const { withGeneratedEventOgImage } = await import("../event-og-image");

    const result = withGeneratedEventOgImage(
      {
        title: "Sunset Session Vol. 03",
        openGraph: { title: "Sunset Session Vol. 03", type: "website" },
        twitter: { card: "summary", title: "Sunset Session Vol. 03" },
      },
      anEvent(),
    );

    const images = (result.openGraph as { images?: { url: string }[] }).images;
    expect(images?.[0]?.url).toMatch(
      /^https:\/\/ithasfire\.com\/og\/event\/.+\?v=[0-9a-f]{16}$/,
    );
    expect((result.twitter as { card?: string }).card).toBe(
      "summary_large_image",
    );
    // Untouched fields survive.
    expect((result.openGraph as { type?: string }).type).toBe("website");
    expect(result.title).toBe("Sunset Session Vol. 03");
  });

  it("leaves metadata alone when the event already has a hero", async () => {
    const { withGeneratedEventOgImage } = await import("../event-og-image");

    const metadata = {
      openGraph: {
        images: [{ url: "https://cdn.example.com/poster.jpg", alt: "x" }],
      },
      twitter: { card: "summary_large_image" as const },
    };
    const result = withGeneratedEventOgImage(
      metadata,
      anEvent({ images: ["https://cdn.example.com/poster.jpg"] }),
    );
    expect(result).toBe(metadata);
  });
});

describe("eventStubVenueLine", () => {
  it.each([
    [
      "venue AND place, per the artifact's `Carol Ann\u2019s \u00b7 Nashville, TN`",
      { venueName: "The Basement East", city: "Nashville", region: "TN" },
      "The Basement East \u00b7 Nashville, TN",
    ],
    [
      "city + region when the venue is not publicly named",
      { venueName: null, city: "Nashville", region: "TN" },
      "Nashville, TN",
    ],
    [
      "city alone",
      { venueName: null, city: "Nashville", region: null },
      "Nashville",
    ],
    [
      "venue alone when there is no public city",
      { venueName: "The Basement East", city: null, region: null },
      "The Basement East",
    ],
    ["region alone", { venueName: "  ", city: null, region: "TN" }, "TN"],
    ["nothing at all", { venueName: null, city: null, region: null }, ""],
    [
      "whitespace is not a venue",
      { venueName: "   ", city: "  ", region: "  " },
      "",
    ],
  ])("%s", (_label, input, expected) => {
    expect(eventStubVenueLine(input)).toBe(expected);
  });

  it("never reads anything finer than city/region", () => {
    // Guards the disclosure boundary: the street line and postcode are exactly
    // what OBSCURED mode withholds, and this string lands in a public PNG.
    expect(
      eventStubVenueLine({
        venueName: null,
        city: null,
        region: null,
        // @ts-expect-error — deliberately passing fields the helper must ignore
        addressLine1: "123 Main St",
        postalCode: "37206",
      }),
    ).toBe("");
  });
});

describe("eventStubCaption", () => {
  it("is INERT — the stub draws no caption row today", () => {
    // The artifact's caption idiom is `CATEGORY \u00b7 VENUE` and it belongs to
    // the HERO specimen; the card composition a 1200x630 share image actually
    // is has no caption at all. The anonymous public SEO payload carries only
    // `seoType` (a schema.org subtype), so the category half does not exist
    // here, and rendering the venue half alone made the same string appear
    // twice in one frame. The function survives as the composition point for
    // the day a public category lands — hence this asserts "" for a NAMED
    // venue, which is the whole behaviour.
    expect(eventStubCaption({ venueName: "Carol Ann's" })).toBe("");
    expect(eventStubCaption({ venueName: null })).toBe("");
    expect(eventStubCaption(null)).toBe("");
  });
});

describe("eventOgImageSignature — rendered inputs", () => {
  it("changes when the CITY/REGION fallback line changes", () => {
    // The fallback is a RENDERED input, so it must be hashed: an event whose
    // city changes must not keep serving the old stub.
    const base = anEvent({ venueName: null, city: "Nashville", region: "TN" });
    expect(eventOgImageSignature(base)).not.toBe(
      eventOgImageSignature({ ...base, city: "Memphis" }),
    );
    expect(eventOgImageSignature(base)).not.toBe(
      eventOgImageSignature({
        ...base,
        venueName: null,
        city: null,
        region: null,
      }),
    );
  });

  it("STILL changes with city/region once the venue IS publicly named", () => {
    // This assertion is the inverse of the one it replaced. The stub used to
    // draw the venue name OR the city line, so hashing city/region behind a
    // named venue was dead weight. "Direction C" draws BOTH halves, so an
    // event that moves city while keeping its venue name is a content change
    // the key has to follow — otherwise the old PNG outlives it.
    expect(
      eventOgImageSignature(anEvent({ city: "Nashville", region: "TN" })),
    ).not.toBe(eventOgImageSignature(anEvent()));
  });

  it("changes when the venue name changes", () => {
    expect(
      eventOgImageSignature(anEvent({ venueName: "Skyline Roof Top" })),
    ).not.toBe(eventOgImageSignature(anEvent()));
  });

  it("is unmoved by stray whitespace around the title", () => {
    // `generateMetadata` feeds a normalized title and the route feeds the raw
    // payload; an untrimmed preimage made those two disagree forever.
    expect(
      eventOgImageSignature(anEvent({ title: "  Sunset Session Vol. 03 " })),
    ).toBe(eventOgImageSignature(anEvent()));
  });
});
