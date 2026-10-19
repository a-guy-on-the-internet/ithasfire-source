import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route shell for `/places/[slug]`. Pins: a historical slug PERMANENT-redirects
 * (308) to the current page; a non-PLACE entity (historical slug or not)
 * temp-redirects to `/p/<current slug>`; a missing page 404s.
 */

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {
  constructor(
    public readonly kind: "permanent" | "temporary",
    public readonly to: string,
  ) {
    super(`${kind}-redirect:${to}`);
  }
}

const mocks = vi.hoisted(() => ({
  loadEntityPageBySlug: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
  permanentRedirect: (to: string) => {
    throw new RedirectSignal("permanent", to);
  },
  redirect: (to: string) => {
    throw new RedirectSignal("temporary", to);
  },
}));

vi.mock("@/server/entity-pages", () => ({
  loadEntityPageBySlug: mocks.loadEntityPageBySlug,
}));

// The anonymous arrival-areas read (its own tests:
// src/server/__tests__/arrival-areas.test.ts and the place leak test).
vi.mock("@/server/arrival-areas", () => ({
  loadPublicPlaceArrivalAreas: () => Promise.resolve([]),
}));
vi.mock("@/config/site", () => ({
  buildCanonicalUrl: (path: string) => `https://ithasfire.com${path}`,
  getSiteName: () => "Ithas Fire",
  getSiteUrl: () => "https://ithasfire.com",
}));

vi.mock("@/app/p/[slug]/_components/EntityPageShell", () => ({
  EntityPageShell: () => null,
}));
vi.mock("@/app/p/[slug]/_components/EntityPageJsonLd", () => ({
  EntityPageJsonLd: () => null,
}));
vi.mock("@/app/p/[slug]/_components/to-seo-entity-page", () => ({
  toSeoEntityPage: () => ({}),
}));
vi.mock("@th/types/seo/buildEntityPageMetadata", () => ({
  buildEntityPageMetadata: () => ({}),
}));

import PlaceBySlugPage from "../page";

function payload(type: string, redirect: boolean, currentSlug = "new-slug") {
  return {
    redirect,
    data: { entity: { type }, page: { slug: currentSlug } },
  };
}

function render(slug: string) {
  return PlaceBySlugPage({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  mocks.loadEntityPageBySlug.mockReset();
});

describe("/places/[slug]", () => {
  it("308s a historical slug to the current place page", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(payload("PLACE", true));

    await expect(render("old-slug")).rejects.toMatchObject({
      kind: "permanent",
      to: "/places/new-slug",
    });
  });

  it("still temp-redirects a non-PLACE entity to /p/<slug>", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(
      payload("ARTIST", false, "some-artist"),
    );

    await expect(render("some-artist")).rejects.toMatchObject({
      kind: "temporary",
      to: "/p/some-artist",
    });
  });

  it("sends a non-PLACE historical slug straight to /p/<current>, never a 308", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(
      payload("ARTIST", true, "artist-now"),
    );

    await expect(render("artist-then")).rejects.toMatchObject({
      kind: "temporary",
      to: "/p/artist-now",
    });
  });

  it("404s a missing page", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(null);

    await expect(render("nope")).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("renders the current slug without a redirect", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(payload("PLACE", false));

    await expect(render("new-slug")).resolves.toBeTruthy();
  });
});
