// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  eventOgImageSignature,
  type EventOgImageInput,
} from "@th/types/seo/eventOgImage";

/**
 * Route-level tests for the OG Date Stub.
 *
 * The renderer is mocked throughout: what is under test here is the DECISION
 * table (which branch, which status, which single `Cache-Control` value), and
 * rasterising four real PNGs per case would buy nothing but 30 seconds.
 * `date-stub.test.tsx` owns the pixels.
 */

const mocks = vi.hoisted(() => ({
  loadOgEvent: vi.fn(),
  renderDateStubResponse: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}));

vi.mock("@/config/site", () => ({
  getSiteUrl: () => "https://ithasfire.com",
  getSiteName: () => "Ithas Fire",
  buildCanonicalUrl: (p: string) => `https://ithasfire.com${p}`,
}));

vi.mock("@/server/og/load-og-event", () => ({
  loadOgEvent: (...args: unknown[]) => mocks.loadOgEvent(...args),
}));

vi.mock("@/server/og/render", async (importOriginal) => {
  // `loadOgFonts` stays REAL so the font-coverage gate is exercised against the
  // faces we actually ship — that is the whole point of the CJK case below.
  const actual = await importOriginal<typeof import("@/server/og/render")>();
  return {
    ...actual,
    renderDateStubResponse: (...args: unknown[]) =>
      mocks.renderDateStubResponse(...args),
  };
});

const STUB_CACHE =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const SHORT_CACHE = "public, max-age=60, stale-while-revalidate=300";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const SLUG = "drkmttr/us/nashville/sunset-session--ab12cd";

type OgEvent = EventOgImageInput & { status: string };

const anEvent = (overrides: Partial<OgEvent> = {}): OgEvent => ({
  id: "8f0b2e30-1c2a-4c1f-9f9c-0b0d0a0e0f01",
  slug: SLUG,
  title: "Sunset Session Vol. 03",
  startsAt: new Date("2026-09-20T18:00:00.000Z"),
  timezone: "America/Chicago",
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  images: [],
  venueName: "Skyline Rooftop",
  city: null,
  region: null,
  status: "PUBLISHED",
  ...overrides,
});

const call = async (query = "") => {
  const { GET } = await import("../route");
  const req = new NextRequest(`https://ithasfire.com/og/event/${SLUG}${query}`);
  return GET(req, { params: Promise.resolve({ slug: SLUG.split("/") }) });
};

/** Exactly one header line, with exactly this value. */
const expectSingleCacheControl = (res: Response, value: string) => {
  expect(res.headers.get("cache-control")).toBe(value);
  // `getSetCookie`-style duplication would surface as a comma-joined value;
  // asserting the whole string is what catches a merged built-in header.
  expect(res.headers.get("Cache-Control")).toBe(value);
};

beforeEach(() => {
  mocks.loadOgEvent.mockReset();
  mocks.captureException.mockReset();
  mocks.renderDateStubResponse.mockReset();
  mocks.renderDateStubResponse.mockImplementation(
    (_props: unknown, headers: Record<string, string>) =>
      Promise.resolve(
        new Response(PNG_SIGNATURE, {
          status: 200,
          headers: { "Content-Type": "image/png", ...headers },
        }),
      ),
  );
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /og/event/[...slug]", () => {
  it("302s to the real poster once the event has one", async () => {
    mocks.loadOgEvent.mockResolvedValue(
      anEvent({ images: ["https://images.unsplash.com/photo-1.jpg"] }),
    );

    const res = await call("?v=whatever");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://images.unsplash.com/photo-1.jpg",
    );
    expectSingleCacheControl(res, SHORT_CACHE);
    expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
  });

  it("refuses to redirect to a hero image on an unlisted origin", async () => {
    mocks.loadOgEvent.mockResolvedValue(
      anEvent({ images: ["https://evil.test/poster.jpg"] }),
    );

    const res = await call();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("renders under a BOUNDED cache when the ?v= matches", async () => {
    const event = anEvent();
    mocks.loadOgEvent.mockResolvedValue(event);

    const res = await call(`?v=${eventOgImageSignature(event)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expectSingleCacheControl(res, STUB_CACHE);
    // The heal is unreachable behind either of these, which is the whole
    // reason the constant is what it is.
    expect(res.headers.get("cache-control")).not.toMatch(/immutable/);
    expect(res.headers.get("cache-control")).not.toMatch(/31536000/);
  });

  it("302s a MISMATCHED ?v= to the canonical url instead of rendering", async () => {
    const event = anEvent();
    mocks.loadOgEvent.mockResolvedValue(event);

    const res = await call("?v=deadbeefdeadbeef");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://ithasfire.com/og/event/${SLUG}?v=${eventOgImageSignature(event)}`,
    );
    expectSingleCacheControl(res, SHORT_CACHE);
    // Render amplification is the point: a bogus key must cost a lookup, not a
    // 1200x630 rasterisation.
    expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
  });

  it("302s an ABSENT ?v= to the canonical url", async () => {
    const event = anEvent();
    mocks.loadOgEvent.mockResolvedValue(event);

    const res = await call();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      `?v=${eventOgImageSignature(event)}`,
    );
    expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
  });

  it("serves the static poster for an unknown event", async () => {
    mocks.loadOgEvent.mockResolvedValue(null);

    const res = await call();
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expectSingleCacheControl(res, SHORT_CACHE);
    expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
    // A missing event is an ANSWER, not a fault.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "ARCHIVED", "CANCELLED", "COMPLETED"])(
    "never bakes a %s event into a public PNG",
    async (status) => {
      mocks.loadOgEvent.mockResolvedValue(anEvent({ status }));

      const res = await call();
      const bytes = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(bytes.byteLength).toBeGreaterThan(1000); // the static poster
      expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
      expect(mocks.captureException).not.toHaveBeenCalled();
    },
  );

  /**
   * The loader maps a gated event's FORBIDDEN to `null` (see `isExpectedMiss`),
   * so the route's contract is: static poster, no report. Reporting here was
   * systematic — every image-proxy fetch of every waitlist email for a gated
   * event minted an exception.
   */
  it("serves the static poster for a gated event WITHOUT reporting", async () => {
    mocks.loadOgEvent.mockResolvedValue(null);

    const res = await call("?v=abc");

    expect(res.status).toBe(200);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("degrades to the static poster when rasterisation fails", async () => {
    const event = anEvent();
    mocks.loadOgEvent.mockResolvedValue(event);
    mocks.renderDateStubResponse.mockRejectedValue(
      new Error("Unsupported OpenType signature"),
    );

    const res = await call(`?v=${eventOgImageSignature(event)}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expectSingleCacheControl(res, SHORT_CACHE);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("degrades when the title has no glyph any registered face can draw", async () => {
    const event = anEvent({ title: "夏祭りナイト" });
    mocks.loadOgEvent.mockResolvedValue(event);

    const res = await call(`?v=${eventOgImageSignature(event)}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(bytes.byteLength).toBeGreaterThan(1000); // the static poster
    expect(mocks.renderDateStubResponse).not.toHaveBeenCalled();
  });

  it("still renders a title that is only PARTLY unrenderable", async () => {
    const event = anEvent({ title: "Comedy Night 🎤" });
    mocks.loadOgEvent.mockResolvedValue(event);

    await call(`?v=${eventOgImageSignature(event)}`);

    expect(mocks.renderDateStubResponse).toHaveBeenCalledTimes(1);
  });

  it("draws City, Region when the venue is not publicly named", async () => {
    const event = anEvent({
      venueName: null,
      city: "Nashville",
      region: "TN",
    });
    mocks.loadOgEvent.mockResolvedValue(event);

    await call(`?v=${eventOgImageSignature(event)}`);

    expect(mocks.renderDateStubResponse).toHaveBeenCalledWith(
      expect.objectContaining({ venueLine: "Nashville, TN" }),
      expect.objectContaining({ "Cache-Control": STUB_CACHE }),
    );
  });

  it("composes the place line from the SAME helper the signature hashes", async () => {
    const event = anEvent({
      venueName: "Carol Ann's",
      city: "Nashville",
      region: "TN",
    });
    mocks.loadOgEvent.mockResolvedValue(event);

    await call(`?v=${eventOgImageSignature(event)}`);

    expect(mocks.renderDateStubResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        venueLine: "Carol Ann's \u00b7 Nashville, TN",
      }),
      expect.objectContaining({ "Cache-Control": STUB_CACHE }),
    );
  });
});
