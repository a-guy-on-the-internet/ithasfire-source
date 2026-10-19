import { describe, expect, it, vi } from "vitest";

import {
  listPlaceSitemapEntries,
  type ListPlaceSitemapEntriesDeps,
} from "../list-place-sitemap-entries";

import type { Repos } from "@th/ports/repos";
import type { PlaceSitemapEntryRecord } from "@th/ports/repos/places";
import { createTestLogger } from "@th/test-utils/fakes/logger";

function buildDeps(
  records: PlaceSitemapEntryRecord[] = [],
): ListPlaceSitemapEntriesDeps & { reportError: ReturnType<typeof vi.fn> } {
  const placesRepo = {
    listForSitemap: vi.fn(async () => records),
  };
  const reportError = vi.fn();

  return {
    repos: {
      places: placesRepo,
    } as unknown as Repos,
    logger: createTestLogger(),
    reportError,
  };
}

/** A publishable row: has a page, and that page is PUBLIC. */
const publishable = (
  placeId: string,
  pageSlug: string,
  updatedAt: Date | null = null,
): PlaceSitemapEntryRecord => ({
  placeId,
  pageSlug,
  pageVisibility: "PUBLIC",
  updatedAt,
});

describe("listPlaceSitemapEntries", () => {
  it("returns empty array when no places exist", async () => {
    const deps = buildDeps([]);
    const result = await listPlaceSitemapEntries(deps, {});
    expect(result).toEqual([]);
  });

  it("returns place entries with their page slug and ISO date strings", async () => {
    const updatedAt = new Date("2025-01-15T12:00:00.000Z");
    const deps = buildDeps([
      publishable("place-1", "the-basement-east-a1b2c3d4", updatedAt),
      publishable("place-2", "exit-in-9f8e7d6c"),
    ]);

    const result = await listPlaceSitemapEntries(deps, {});

    expect(result).toEqual([
      {
        placeId: "place-1",
        pageSlug: "the-basement-east-a1b2c3d4",
        updatedAt: "2025-01-15T12:00:00.000Z",
      },
      { placeId: "place-2", pageSlug: "exit-in-9f8e7d6c", updatedAt: null },
    ]);
  });

  // The published sitemap is crawler-facing: a URL in it that 404s is an
  // active SEO liability, not a harmless gap. `/p/[slug]` resolves ONLY on
  // `EntityPage.slug` — it has no uuid fallback and calls `notFound()` — so a
  // place with no entity page has no publishable URL at all.
  it("DROPS places with no entity page rather than publishing a known 404", async () => {
    const deps = buildDeps([
      publishable("place-with-page", "the-basement-east-a1b2c3d4"),
      // Bulk-imported venue: a Place row, no EntityPage.
      {
        placeId: "place-without-page",
        pageSlug: null,
        pageVisibility: null,
        updatedAt: null,
      },
    ]);

    const result = await listPlaceSitemapEntries(deps, {});

    expect(result).toEqual([
      {
        placeId: "place-with-page",
        pageSlug: "the-basement-east-a1b2c3d4",
        updatedAt: null,
      },
    ]);
    expect(result.map((r) => r.placeId)).not.toContain("place-without-page");
  });

  it("drops an empty-string page slug too (it would build a bare `/p/`)", async () => {
    const deps = buildDeps([
      {
        placeId: "place-1",
        pageSlug: "",
        pageVisibility: "PUBLIC",
        updatedAt: null,
      },
    ]);

    await expect(listPlaceSitemapEntries(deps, {})).resolves.toEqual([]);
  });

  it("counts the dropped places on the log line so the gap is measurable", async () => {
    const deps = buildDeps([
      publishable("a", "a-11111111"),
      { placeId: "b", pageSlug: null, pageVisibility: null, updatedAt: null },
      { placeId: "c", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);

    await listPlaceSitemapEntries(deps, {});

    expect(deps.logger?.info).toHaveBeenCalledWith(
      "places.list_sitemap_entries",
      { count: 1, skippedWithoutPage: 2, skippedNotPublic: 0 },
    );
  });

  it("passes limit to repo when provided", async () => {
    const deps = buildDeps([]);
    await listPlaceSitemapEntries(deps, { limit: 200 });

    expect(deps.repos.places.listForSitemap).toHaveBeenCalledWith({
      limit: 200,
    });
  });

  it("defaults limit to 50000 when not provided", async () => {
    const deps = buildDeps([]);
    await listPlaceSitemapEntries(deps, {});

    expect(deps.repos.places.listForSitemap).toHaveBeenCalledWith({
      limit: 50000,
    });
  });

  it("accepts a limit above the old 2000 cap up to Google's 50k file limit", async () => {
    const deps = buildDeps([]);
    await expect(
      listPlaceSitemapEntries(deps, { limit: 50000 }),
    ).resolves.toEqual([]);

    expect(deps.repos.places.listForSitemap).toHaveBeenCalledWith({
      limit: 50000,
    });
  });

  it("rejects invalid input", async () => {
    const deps = buildDeps([]);
    await expect(listPlaceSitemapEntries(deps, { limit: 0 })).rejects.toThrow();
    await expect(
      listPlaceSitemapEntries(deps, { limit: 50001 }),
    ).rejects.toThrow();
  });

  it("rejects extra keys (strict schema)", async () => {
    const deps = buildDeps([]);
    await expect(
      listPlaceSitemapEntries(deps, { limit: 10, extra: true }),
    ).rejects.toThrow();
  });
  // ── EntityPage.visibility: the sitemap is the strictest link gate ────────
  //
  // The sitemap exists to hand URLs to crawlers, so it is the one surface
  // where UNLISTED must be excluded alongside PRIVATE:
  //   · PRIVATE  — `get-public-page` throws PAGE_NOT_FOUND and `/p/[slug]`
  //                calls notFound(), so publishing it is a guaranteed 404;
  //   · UNLISTED — renders, but the owner was promised "it stays out of
  //                search and browse" when they chose it.
  // Both stay reachable at `/places/id/{placeId}`, a different route keyed on
  // the Place, so nothing hidden leaks and nothing that exists is lost.
  it.each(["PRIVATE", "UNLISTED"] as const)(
    "EXCLUDES a %s venue page — it keeps its slug, but that slug must not be published",
    async (pageVisibility) => {
      const deps = buildDeps([
        publishable("public-place", "public-venue-11111111"),
        {
          placeId: "hidden-place",
          // The slug still EXISTS in the database — that is the trap.
          pageSlug: "hidden-venue-22222222",
          pageVisibility,
          updatedAt: null,
        },
      ]);

      const result = await listPlaceSitemapEntries(deps, {});

      expect(result.map((r) => r.placeId)).toEqual(["public-place"]);
      expect(JSON.stringify(result)).not.toContain("hidden-venue-22222222");
    },
  );

  it("separates the two skip reasons on the log line", async () => {
    const deps = buildDeps([
      publishable("a", "a-11111111"),
      { placeId: "b", pageSlug: null, pageVisibility: null, updatedAt: null },
      {
        placeId: "c",
        pageSlug: "c-33333333",
        pageVisibility: "UNLISTED",
        updatedAt: null,
      },
    ]);

    await listPlaceSitemapEntries(deps, {});

    expect(deps.logger?.info).toHaveBeenCalledWith(
      "places.list_sitemap_entries",
      { count: 1, skippedWithoutPage: 1, skippedNotPublic: 1 },
    );
  });

  // ── Structural gap: the sitemap can silently shrink to nothing ───────────
  //
  // `sitemaps.ts` skips an empty section entirely, so `sitemap-places.xml` can
  // vanish from the index with no signal. `logger.info` is NOT captured by
  // Sentry (nor is `warn`), so the escalation has to be error + reportError.
  it("escalates to reportError when EVERY eligible place is dropped", async () => {
    const deps = buildDeps([
      { placeId: "a", pageSlug: null, pageVisibility: null, updatedAt: null },
      { placeId: "b", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);

    await expect(listPlaceSitemapEntries(deps, {})).resolves.toEqual([]);

    expect(deps.logger?.error).toHaveBeenCalledWith(
      "places.list_sitemap_entries_structural_gap",
      expect.objectContaining({ eligible: 2, published: 0 }),
    );
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(deps.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "listPlaceSitemapEntries", step: "structuralGap" },
      extra: { eligible: 2, published: 0, skippedWithoutPage: 2 },
    });
  });

  it("escalates when MOST places are dropped, not only when all are", async () => {
    // 12 eligible, 8 dropped (67%) — over the ratio AND over the sample floor.
    const deps = buildDeps([
      ...Array.from({ length: 4 }, (_, i) =>
        publishable(`ok-${i}`, `ok-${i}-11111111`),
      ),
      ...Array.from({ length: 8 }, (_, i) => ({
        placeId: `gap-${i}`,
        pageSlug: null,
        pageVisibility: null,
        updatedAt: null,
      })),
    ]);

    await listPlaceSitemapEntries(deps, {});

    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  // Without a floor, "1 of 1 places has no page" is a 100% gap and would fire
  // every single night in a small or brand-new environment — the fastest way
  // to teach a team to ignore the alert.
  it("does NOT fire the ratio alarm below the sample floor", async () => {
    const deps = buildDeps([
      publishable("a", "a-11111111"),
      { placeId: "b", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);

    await listPlaceSitemapEntries(deps, {});

    expect(deps.reportError).not.toHaveBeenCalled();
    expect(deps.logger?.error).not.toHaveBeenCalled();
  });

  // The zero-published arm has no floor on purpose: an EMPTY places sitemap is
  // worth saying regardless of how small the environment is.
  it("STILL fires below the floor when nothing at all is publishable", async () => {
    const deps = buildDeps([
      { placeId: "a", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);

    await listPlaceSitemapEntries(deps, {});

    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for an incidental gap and for an empty database", async () => {
    const incidental = buildDeps([
      publishable("a", "a-11111111"),
      publishable("b", "b-22222222"),
      publishable("c", "c-33333333"),
      { placeId: "d", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);
    await listPlaceSitemapEntries(incidental, {});
    expect(incidental.reportError).not.toHaveBeenCalled();
    expect(incidental.logger?.error).not.toHaveBeenCalled();

    // Zero eligible places is a young database, not a structural fault.
    const empty = buildDeps([]);
    await listPlaceSitemapEntries(empty, {});
    expect(empty.reportError).not.toHaveBeenCalled();
    expect(empty.logger?.error).not.toHaveBeenCalled();
  });

  it("a throwing reporter never changes the emitted sitemap", async () => {
    const deps = buildDeps([
      { placeId: "a", pageSlug: null, pageVisibility: null, updatedAt: null },
    ]);
    deps.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(listPlaceSitemapEntries(deps, {})).resolves.toEqual([]);
  });
});
