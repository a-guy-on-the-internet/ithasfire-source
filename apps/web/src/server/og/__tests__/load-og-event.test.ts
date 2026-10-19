import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveEventBySlug: vi.fn(),
  getEventSeo: vi.fn(),
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    events: {
      resolveEventBySlug: {
        query: (...args: unknown[]) => mocks.resolveEventBySlug(...args),
      },
      getEventSeo: {
        query: (...args: unknown[]) => mocks.getEventSeo(...args),
      },
    },
  }),
}));

const trpcError = (code: string) =>
  Object.assign(new TRPCClientError(code), { data: { code } });

const seoPayload = (
  location: Record<string, unknown> | null,
): Record<string, unknown> => ({
  id: "8f0b2e30-1c2a-4c1f-9f9c-0b0d0a0e0f01",
  slug: "org/us/nashville/a-show--ab12cd",
  title: "A Show",
  startsAt: "2026-09-20T18:00:00.000Z",
  timezone: "America/Chicago",
  updatedAt: "2026-09-01T12:00:00.000Z",
  images: [],
  status: "PUBLISHED",
  location,
});

beforeEach(() => {
  mocks.resolveEventBySlug.mockReset();
  mocks.getEventSeo.mockReset();
  mocks.resolveEventBySlug.mockResolvedValue({
    currentSlug: "org/us/nashville/a-show--ab12cd",
  });
});

describe("loadOgEvent", () => {
  it("returns null for NOT_FOUND", async () => {
    const { loadOgEvent } = await import("../load-og-event");
    mocks.getEventSeo.mockRejectedValue(trpcError("NOT_FOUND"));

    await expect(loadOgEvent("whatever")).resolves.toBeNull();
  });

  /**
   * A gated event read anonymously throws FORBIDDEN, and this loader is
   * anonymous by design. Rethrowing sent every such fetch to
   * `Sentry.captureException` — routine expected behaviour reported as an
   * error, systematically, because the waitlist email embeds the URL.
   */
  it.each([
    ["the slug resolution", "resolveEventBySlug"] as const,
    ["the seo read", "getEventSeo"] as const,
  ])("returns null (no throw) when %s is FORBIDDEN", async (_label, step) => {
    const { loadOgEvent } = await import("../load-og-event");
    mocks.getEventSeo.mockResolvedValue(seoPayload(null));
    mocks[step].mockRejectedValue(trpcError("FORBIDDEN"));

    await expect(loadOgEvent("gated-event")).resolves.toBeNull();
  });

  it("rethrows anything that is NOT an expected miss", async () => {
    const { loadOgEvent } = await import("../load-og-event");
    mocks.getEventSeo.mockRejectedValue(trpcError("INTERNAL_SERVER_ERROR"));

    await expect(loadOgEvent("boom")).rejects.toThrow();
  });

  it("carries the public city/region for the stub's venue fallback", async () => {
    const { loadOgEvent } = await import("../load-og-event");
    mocks.getEventSeo.mockResolvedValue(
      seoPayload({
        name: null,
        city: "Nashville",
        region: "TN",
        addressLine1: "123 Main St",
        postalCode: "37206",
      }),
    );

    const event = await loadOgEvent("org/us/nashville/a-show--ab12cd");

    expect(event).toMatchObject({
      venueName: null,
      city: "Nashville",
      region: "TN",
    });
    // Nothing finer than city/region may reach a publicly cached PNG.
    expect(Object.keys(event ?? {})).not.toContain("addressLine1");
    expect(Object.keys(event ?? {})).not.toContain("postalCode");
  });

  it("prefers the disclosed venue name when there is one", async () => {
    const { loadOgEvent } = await import("../load-og-event");
    mocks.getEventSeo.mockResolvedValue(
      seoPayload({
        name: "The Basement East",
        city: "Nashville",
        region: "TN",
      }),
    );

    await expect(
      loadOgEvent("org/us/nashville/a-show--ab12cd"),
    ).resolves.toMatchObject({ venueName: "The Basement East" });
  });
});
