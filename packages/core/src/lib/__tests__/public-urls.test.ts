/**
 * The single implementation every notification uses to build a public event
 * link. Two shipped bugs came from getting this wrong in a second place:
 * the image-moderation notices and the RSVP confirmation email both linked
 * `/events/<uuid>`, which 404s.
 */
import { describe, expect, it } from "vitest";

import {
  eventEmailImageUrl,
  eventPublicPath,
  eventPublicUrl,
  eventShortPath,
  eventShortUrl,
  eventSlugPath,
  normalizeAppBaseUrl,
} from "../public-urls";

describe("normalizeAppBaseUrl", () => {
  it("trims trailing slashes", () => {
    expect(normalizeAppBaseUrl("https://ithasfire.com///")).toBe(
      "https://ithasfire.com",
    );
  });

  it("rejects a base with no scheme rather than emitting an invalid URL", () => {
    // A payload URL is validated by a strict `.url()` inside notify() BEFORE
    // the idempotency claim, so a bad base must cost the link, not the notice.
    expect(normalizeAppBaseUrl("ithasfire.com")).toBeNull();
  });

  it("strips a query or fragment so the composed URL can't be malformed", () => {
    // `https://x.com/?utm=1` + `/events/…` would otherwise splice the path
    // AFTER the query string.
    expect(normalizeAppBaseUrl("https://ithasfire.com/?utm=1")).toBe(
      "https://ithasfire.com",
    );
    expect(normalizeAppBaseUrl("https://ithasfire.com/#top")).toBe(
      "https://ithasfire.com",
    );
    // A path prefix is legitimate and preserved.
    expect(normalizeAppBaseUrl("https://ithasfire.com/app/")).toBe(
      "https://ithasfire.com/app",
    );
  });

  it("rejects non-web protocols and empty values", () => {
    expect(normalizeAppBaseUrl("ftp://ithasfire.com")).toBeNull();
    expect(normalizeAppBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeAppBaseUrl("   ")).toBeNull();
    expect(normalizeAppBaseUrl(null)).toBeNull();
    expect(normalizeAppBaseUrl(undefined)).toBeNull();
  });
});

describe("eventSlugPath", () => {
  it("keeps multi-segment separators as real path separators", () => {
    // `/events/[...slug]` is a catch-all; percent-encoding the slashes 404s.
    expect(eventSlugPath("org/us/general/my-event--ab12cd")).toBe(
      "org/us/general/my-event--ab12cd",
    );
  });

  it("escapes within a segment without escaping the separators", () => {
    expect(eventSlugPath("org/us/café night")).toBe("org/us/caf%C3%A9%20night");
  });

  it("drops empty segments from a sloppy slug", () => {
    expect(eventSlugPath("//org//us//")).toBe("org/us");
  });
});

describe("eventPublicUrl", () => {
  it("builds a slug URL", () => {
    expect(
      eventPublicUrl({
        baseUrl: "https://ithasfire.com/",
        slug: "org/us/general/my-event--ab12cd",
      }),
    ).toBe("https://ithasfire.com/events/org/us/general/my-event--ab12cd");
  });

  it("composes cleanly from a base carrying a query", () => {
    expect(
      eventPublicUrl({
        baseUrl: "https://ithasfire.com/?utm=1",
        slug: "org/us/my-event",
      }),
    ).toBe("https://ithasfire.com/events/org/us/my-event");
  });

  it("returns null without a usable base or slug", () => {
    const slug = "org/us/my-event";
    expect(eventPublicUrl({ baseUrl: "ithasfire.com", slug })).toBeNull();
    expect(eventPublicUrl({ baseUrl: null, slug })).toBeNull();
    expect(
      eventPublicUrl({ baseUrl: "https://ithasfire.com", slug: null }),
    ).toBeNull();
    expect(
      eventPublicUrl({ baseUrl: "https://ithasfire.com", slug: "///" }),
    ).toBeNull();
  });

  it("never accepts an id in place of a slug silently — callers pass slugs", () => {
    // Documents the contract: the function has no id branch at all, so the only
    // way to get an id link is to pass one AS the slug.
    const url = eventPublicUrl({
      baseUrl: "https://ithasfire.com",
      slug: "b987250d-69bc-4a17-932f-6a653745eef7",
    });
    expect(url).toBe(
      "https://ithasfire.com/events/b987250d-69bc-4a17-932f-6a653745eef7",
    );
  });
});

describe("eventPublicPath", () => {
  it("is the root-relative half of eventPublicUrl", () => {
    // In-app notification actions get handed to router.push(), so they need a
    // path, not an origin — but the SAME path the absolute URL would carry.
    const slug = "org/us/general/my-event--ab12cd";
    expect(eventPublicPath(slug)).toBe(`/events/${slug}`);
    expect(eventPublicUrl({ baseUrl: "https://ithasfire.com", slug })).toBe(
      `https://ithasfire.com${eventPublicPath(slug)}`,
    );
  });

  it("returns null without a slug", () => {
    expect(eventPublicPath(null)).toBeNull();
    expect(eventPublicPath(undefined)).toBeNull();
    expect(eventPublicPath("///")).toBeNull();
  });
});

describe("eventShortPath / eventShortUrl", () => {
  it("builds the /e/<shortId> short link", () => {
    expect(eventShortPath("wqsdk6pxzi")).toBe("/e/wqsdk6pxzi");
    expect(
      eventShortUrl({ baseUrl: "https://ithasfire.com/", shortId: "wqsdk6pxzi" }),
    ).toBe("https://ithasfire.com/e/wqsdk6pxzi");
  });

  it("normalises the base the same way eventPublicUrl does", () => {
    expect(
      eventShortUrl({
        baseUrl: "https://ithasfire.com/?utm=1",
        shortId: "wqsdk6pxzi",
      }),
    ).toBe("https://ithasfire.com/e/wqsdk6pxzi");
    expect(
      eventShortUrl({ baseUrl: "ithasfire.com", shortId: "wqsdk6pxzi" }),
    ).toBeNull();
  });

  it("escapes the id as ONE segment", () => {
    expect(eventShortPath("a/b")).toBe("/e/a%2Fb");
  });

  it("returns null without a short ID", () => {
    expect(eventShortPath(null)).toBeNull();
    expect(eventShortPath(undefined)).toBeNull();
    expect(eventShortPath("")).toBeNull();
    expect(
      eventShortUrl({ baseUrl: "https://ithasfire.com", shortId: null }),
    ).toBeNull();
  });
});

describe("eventEmailImageUrl", () => {
  const anEvent = (overrides: Record<string, unknown> = {}) => ({
    id: "8f0b2e30-1c2a-4c1f-9f9c-0b0d0a0e0f01",
    slug: "drkmttr/us/nashville/sunset-session--ab12cd",
    title: "Sunset Session Vol. 03",
    startsAt: new Date("2026-09-20T18:00:00.000Z"),
    timezone: "America/Chicago",
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    heroImageUrl: null as string | null,
    venueName: "Skyline Rooftop",
    ...overrides,
  });

  it("returns the event's own poster when it has one", () => {
    expect(
      eventEmailImageUrl({
        baseUrl: "https://ithasfire.com",
        event: anEvent({ heroImageUrl: "https://cdn.test/poster.jpg" }),
      }),
    ).toBe("https://cdn.test/poster.jpg");
  });

  it("returns the generated Date Stub when the event has no poster", () => {
    const url = eventEmailImageUrl({
      baseUrl: "https://ithasfire.com",
      event: anEvent(),
    });
    expect(url).toMatch(
      /^https:\/\/ithasfire\.com\/og\/event\/drkmttr\/us\/nashville\/sunset-session--ab12cd\?v=[0-9a-f]{16}$/,
    );
  });

  it("always returns an ABSOLUTE url — the ui-email schemas enforce .url()", () => {
    for (const event of [anEvent(), anEvent({ slug: null })]) {
      const url = eventEmailImageUrl({
        baseUrl: "https://ithasfire.com/",
        event,
      });
      expect(url).not.toBeNull();
      expect(() => new URL(url as string)).not.toThrow();
    }
  });

  it("falls back to the static poster when the event has no slug", () => {
    expect(
      eventEmailImageUrl({
        baseUrl: "https://ithasfire.com",
        event: anEvent({ slug: null }),
      }),
    ).toBe("https://ithasfire.com/og-image-v2.png");
  });

  it("returns null (not a relative url) when the base is unusable", () => {
    // A scheme-less PUBLIC_WEB_URL must cost the image and nothing else: a
    // relative string would fail `z.string().url()` inside the renderer, which
    // runs BEFORE notify() claims its idempotency key, and sink the notice.
    expect(
      eventEmailImageUrl({ baseUrl: "ithasfire.com", event: anEvent() }),
    ).toBeNull();
    expect(eventEmailImageUrl({ baseUrl: null, event: anEvent() })).toBeNull();
  });

  it("keeps the event's poster even when the base is unusable", () => {
    expect(
      eventEmailImageUrl({
        baseUrl: null,
        event: anEvent({ heroImageUrl: "https://cdn.test/poster.jpg" }),
      }),
    ).toBe("https://cdn.test/poster.jpg");
  });
});
