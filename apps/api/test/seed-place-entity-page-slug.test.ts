import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { buildPageSlug } from "@th/core/use-cases/places/_shared/page-slug";

import { seedPlaceEntityPages } from "../src/scripts/seed/entity-pages";

/**
 * The dev seed must mint the SAME public page slug the create path does.
 *
 * It used to copy `Place.slug` into `EntityPage.slug`. `Place.slug` is the
 * multi-segment DIRECTORY key (`us/tn/name--a1b2c3d4e5`, literal `/`
 * included); `/places/[slug]` and `/p/[slug]` are SINGLE non-catch-all
 * segments, so every page seeded that way 404s. It looked fine only because
 * the ~16 fixture venues in seed/places.ts carry a flat `Place.slug` — and
 * that appearance is exactly what masked the matching production defect in
 * `bulkImportPlaces`.
 *
 * The hand-authored VENUE_BIOS / VENUE_CONTENT maps are still keyed by the
 * fixture venues' flat `Place.slug`, so the page slug and the content lookup
 * key are now two different values. Both halves are pinned below.
 */

type SeededPlace = {
  id: string;
  slug: string | null;
  name: string;
  city: string;
  region: string;
  capacity: number | null;
};

type UpsertCall = { ownerId: string; slug: string; bio: string };

function makeFakePrisma(places: SeededPlace[]) {
  const upserts: UpsertCall[] = [];
  const themes: Array<{ pageId: string; layoutKey?: string | null }> = [];

  const prisma = {
    place: {
      findMany: vi.fn(async () => places),
    },
    entityPage: {
      // No page exists yet — the CREATE branch is the one that writes a slug.
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(
        async (args: {
          create: { ownerId: string; slug: string; bio: string };
        }) => {
          upserts.push({
            ownerId: args.create.ownerId,
            slug: args.create.slug,
            bio: args.create.bio,
          });
          return { id: `page-${args.create.ownerId}` };
        },
      ),
    },
    pageTheme: {
      upsert: vi.fn(
        async (args: {
          where: { pageId: string };
          create: { layoutKey?: string | null };
        }) => {
          themes.push({
            pageId: args.where.pageId,
            layoutKey: args.create.layoutKey ?? null,
          });
          return {};
        },
      ),
    },
    pageBlock: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    upserts,
    themes,
  };
}

// A bulk-imported venue: multi-segment `Place.slug`, no entry in the
// hand-authored content maps.
const IMPORTED: SeededPlace = {
  id: "81d4c5b3-1111-4111-8111-111111111111",
  slug: "us/tn/backstage-nashville--lknkdsbay9",
  name: "Backstage Nashville",
  city: "Nashville",
  region: "TN",
  capacity: 250,
};

// A fixture venue: flat `Place.slug` that IS the content-map key.
const FIXTURE: SeededPlace = {
  id: "00000000-0000-4000-8000-00000000d032",
  slug: "the-fillmore-san-francisco",
  name: "The Fillmore",
  city: "San Francisco",
  region: "CA",
  capacity: 1150, // VENUE_CONTENT standing 950 + seated 200
};

// The deliberate grid-layout holdout, keyed by its flat `Place.slug`.
const GRID_HOLDOUT: SeededPlace = {
  id: "00000000-0000-4000-8000-00000000d035",
  slug: "soma-warehouse-san-francisco",
  name: "SOMA Warehouse",
  city: "San Francisco",
  region: "CA",
  capacity: 600, // VENUE_CONTENT standing 600 + seated 0
};

describe("seedPlaceEntityPages: page slug", () => {
  it("writes the FLAT buildPageSlug form, never the multi-segment Place.slug", async () => {
    const { prisma, upserts } = makeFakePrisma([IMPORTED]);

    await seedPlaceEntityPages(prisma);

    expect(upserts).toHaveLength(1);
    const written = upserts[0]!.slug;

    expect(written).toBe(buildPageSlug(IMPORTED.name, IMPORTED.id));
    expect(written).toBe("backstage-nashville-81d4c5b3");

    // The two claims that matter independently of the helper:
    expect(written).not.toBe(IMPORTED.slug);
    expect(written).not.toContain("/");
  });

  it("does it for the fixture venues too — a flat Place.slug is still not the page slug", async () => {
    const { prisma, upserts } = makeFakePrisma([FIXTURE]);

    await seedPlaceEntityPages(prisma);

    const written = upserts[0]!.slug;
    expect(written).toBe("the-fillmore-00000000");
    expect(written).not.toBe(FIXTURE.slug);
  });

  it("still finds the hand-authored bio, which is keyed by Place.slug and NOT by the page slug", async () => {
    const { prisma, upserts } = makeFakePrisma([FIXTURE]);

    await seedPlaceEntityPages(prisma);

    // Re-keying the content maps to the page slug would silently drop every
    // venue to the DB-derived fallback ("The Fillmore — San Francisco, CA.").
    expect(upserts[0]!.bio).toContain("Geary Blvd institution since 1912");
    expect(upserts[0]!.bio).not.toContain("Capacity 1150");
  });

  it("still applies the grid-layout holdout, also keyed by Place.slug", async () => {
    const { prisma, themes } = makeFakePrisma([GRID_HOLDOUT]);

    await seedPlaceEntityPages(prisma);

    expect(themes[0]!.layoutKey).toBe("grid");
  });

  it("falls back to a name-derived content key when Place.slug is null", async () => {
    const { prisma, upserts } = makeFakePrisma([
      { ...IMPORTED, slug: null, name: "Nameless Room" },
    ]);

    await seedPlaceEntityPages(prisma);

    // Page slug is still the canonical flat form regardless of Place.slug.
    expect(upserts[0]!.slug).toBe("nameless-room-81d4c5b3");
    // No content-map entry ⇒ the DB-derived fallback bio.
    expect(upserts[0]!.bio).toContain("Nashville, TN");
  });
});
