import { describe, expect, it } from "vitest";

import { toSeoEntityPage } from "../to-seo-entity-page";

/**
 * A VENUE HAS ONE NAME — `Place.name`. `EntityPage.displayName` is no longer a
 * venue's name (the page editor offers PLACE owners no such field), so every
 * PLACE reader resolves `entity.name` FIRST. HUMAN and ORGANIZATION keep
 * `displayName` first: it is still their editable field.
 *
 * This mapper is the single funnel behind OG tags, page metadata AND JSON-LD
 * for `/p/`, `/places/`, `/orgs/` and `/humans/` — verified by grepping
 * `toSeoEntityPage`, whose only callers are those four route files'
 * `generateMetadata` + page bodies. `buildEntityPageJsonLd` and
 * `buildEntityPageMetadata` take an already-built `SeoEntityPage`, so their
 * suites stay green no matter what this mapper resolves. Hence this file.
 */

type MapperInput = Parameters<typeof toSeoEntityPage>[0];

const NOW = new Date("2026-09-01T00:00:00.000Z");
const URL = "https://ithasfire.com/places/the-basement-a1b2c3d4";

function page(
  overrides: Partial<MapperInput["page"]> = {},
): MapperInput["page"] {
  return {
    id: "page-1",
    ownerType: "PLACE",
    ownerId: "owner-1",
    slug: "the-basement-a1b2c3d4",
    displayName: "Stale Page Name",
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: true,
    category: null,
    templateAppliedCategories: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const placeEntity: Extract<MapperInput["entity"], { type: "PLACE" }> = {
  type: "PLACE",
  id: "place-1",
  name: "The Basement",
  formattedAddress: "917 Woodland St, Nashville, TN",
  city: "Nashville",
  region: "TN",
  lat: null,
  lng: null,
};

const humanEntity: Extract<MapperInput["entity"], { type: "HUMAN" }> = {
  type: "HUMAN",
  id: "human-1",
  name: "Legal Human Name",
  jobs: [],
  genreTags: [],
  otherJobDescription: null,
  acceptsBookingRequests: false,
};

const orgEntity: Extract<MapperInput["entity"], { type: "ORGANIZATION" }> = {
  type: "ORGANIZATION",
  id: "org-1",
  name: "Registered Org Name",
  slug: "demo-org",
  trustTier: "STANDARD",
  trustBadgeLabel: null,
  acceptsBookingRequests: false,
};

describe("toSeoEntityPage — a venue has ONE name", () => {
  it("resolves a PLACE to entity.name even when page.displayName is set AND different", () => {
    const seo = toSeoEntityPage(
      {
        page: page(),
        blocks: [],
        theme: null,
        entity: placeEntity,
        communityAttribution: null,
      },
      URL,
    );

    expect(seo.displayName).toBe("The Basement");
    expect(seo.displayName).not.toBe("Stale Page Name");
  });

  it("falls back to page.displayName for a PLACE whose entity.name is missing", () => {
    const seo = toSeoEntityPage(
      {
        page: page(),
        blocks: [],
        theme: null,
        communityAttribution: null,
        // The summary type declares `name: string`; the fallback exists for the
        // runtime case a payload arrives without one (a nameless row must still
        // render SOMETHING rather than an empty <title>).
        entity: { ...placeEntity, name: null as unknown as string },
      },
      URL,
    );

    expect(seo.displayName).toBe("Stale Page Name");
  });

  it("falls back to the slug for a PLACE with neither a name nor a display name", () => {
    const seo = toSeoEntityPage(
      {
        page: page({ displayName: null }),
        blocks: [],
        theme: null,
        communityAttribution: null,
        entity: { ...placeEntity, name: null as unknown as string },
      },
      URL,
    );

    expect(seo.displayName).toBe("the-basement-a1b2c3d4");
  });

  // ── Regression guards: the ruling is PLACE-only ─────────────────────────

  it("keeps page.displayName FIRST for a HUMAN", () => {
    const seo = toSeoEntityPage(
      {
        page: page({ ownerType: "HUMAN", displayName: "Stage Name" }),
        blocks: [],
        theme: null,
        communityAttribution: null,
        entity: humanEntity,
      },
      URL,
    );

    expect(seo.displayName).toBe("Stage Name");
    expect(seo.displayName).not.toBe("Legal Human Name");
  });

  it("keeps page.displayName FIRST for an ORGANIZATION", () => {
    const seo = toSeoEntityPage(
      {
        page: page({ ownerType: "ORGANIZATION", displayName: "Act Name" }),
        blocks: [],
        theme: null,
        communityAttribution: null,
        entity: orgEntity,
      },
      URL,
    );

    expect(seo.displayName).toBe("Act Name");
    expect(seo.displayName).not.toBe("Registered Org Name");
  });

  it("still falls back to entity.name for a HUMAN with no display name", () => {
    const seo = toSeoEntityPage(
      {
        page: page({ ownerType: "HUMAN", displayName: null }),
        blocks: [],
        theme: null,
        communityAttribution: null,
        entity: humanEntity,
      },
      URL,
    );

    expect(seo.displayName).toBe("Legal Human Name");
  });

  it("passes the rest of the SEO surface through untouched", () => {
    const seo = toSeoEntityPage(
      {
        page: page({
          bio: "A basement.",
          avatarUrl: "/a.png",
          bannerUrl: null,
        }),
        blocks: [],
        theme: null,
        communityAttribution: null,
        entity: placeEntity,
      },
      URL,
    );

    expect(seo).toEqual({
      url: URL,
      ownerType: "PLACE",
      displayName: "The Basement",
      bio: "A basement.",
      avatarUrl: "/a.png",
      bannerUrl: null,
      entity: placeEntity,
    });
  });
});
