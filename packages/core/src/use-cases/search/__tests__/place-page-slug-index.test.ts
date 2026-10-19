import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";
import { ok } from "@th/ports/search/types";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );

/**
 * A place has exactly ONE addressable slug: its `EntityPage.slug` — flat
 * `{name}-{id8}`, and the only value the single-segment `/places/[slug]` route
 * resolves on.
 *
 * It used to have a second one. `Place.slug` was a multi-segment DIRECTORY key
 * (`us/tn/x--a1b2c3d4e5`, literal `/` included) that NOTHING routed on, and the
 * place search document carried only THAT — so every venue result in Spotlight
 * and /search navigated to a 404. Seeded dev DBs made the two slugs identical,
 * which is exactly what hid it.
 *
 * `Place.slug` is now deprecated and off the payload entirely. These tests pin
 * that the indexed document carries the page slug as `pageSlug`, that it is
 * null (never a substitute) for venues with no entity page, and that no second
 * slug has crept back onto the document.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const PLACE_WITH_PAGE = "00000000-0000-4000-8000-00000000b001";
const PLACE_WITHOUT_PAGE = "00000000-0000-4000-8000-00000000b002";

const PAGE_SLUG = "the-basement-east-a1b2c3d4";

const placeRecord = (id: string) =>
  ({
    id,
    name: "The Basement East",
    formattedAddress: "917 Woodland St, Nashville, TN",
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: 36.176,
    lng: -86.751,
    capacity: 400,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
  }) as never;

type PlaceDoc = {
  type: "place";
  placeId: string;
  pageSlug: string | null;
  bio: string | null;
};

type OrgDoc = { type: "organization"; orgId: string; bio: string | null };

function buildDeps(options: {
  places: Array<{ id: string }>;
  /** ownerId → entity page, or absent for "this place has no page". */
  pages: Record<
    string,
    {
      slug: string;
      bio: string | null;
      visibility?: "PUBLIC" | "PRIVATE" | "UNLISTED";
    }
  >;
  entityPagesError?: Error;
  reportError?: (...args: unknown[]) => void;
}) {
  const records = options.places.map((p) => placeRecord(p.id));

  const page = (ownerId: string) => {
    const p = options.pages[ownerId];
    return p ? { ownerId, visibility: "PUBLIC" as const, ...p } : null;
  };
  // The by-id path still reads one owner at a time…
  const getByOwner = vi.fn(async (_ownerType: string, ownerId: string) => {
    if (options.entityPagesError) throw options.entityPagesError;
    return page(ownerId);
  });
  // …while the batch path is ONE bulk read for the whole batch (not a
  // findUnique per owner), which is why its failure reporting is per-batch.
  const getByOwners = vi.fn(async (_ownerType: string, ownerIds: string[]) => {
    if (options.entityPagesError) throw options.entityPagesError;
    return ownerIds.map(page).filter((p) => p !== null);
  });

  const repos = {
    events: {
      listPublished: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] }),
      ),
      getById: vi.fn(async () => null),
    },
    humans: {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] }),
      ),
    },
    places: {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: records }),
      ),
      getById: vi.fn(async (id: string) =>
        records.find((r) => (r as unknown as { id: string }).id === id) ?? null,
      ),
    },
    organizations: {
      listActive: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
    },
    categories: { listAll: vi.fn(async () => []) },
    entityPages: { getByOwner, getByOwners },
  } as unknown as Repos;

  const captured: Array<Record<string, unknown>> = [];
  const upsertDocuments = vi.fn(async ({ documents }) => {
    captured.push(...documents);
    return ok({ indexed: documents.length });
  });

  return {
    captured,
    getByOwner,
    getByOwners,
    deps: {
      clock: testClock,
      repos,
      ...(options.reportError ? { reportError: options.reportError } : {}),
      search: {
        ensureIndexes: vi.fn(async () => ok(undefined)),
        // Non-destructive full rebuild: marker, then per-type sweep.
        beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
        deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
        upsertDocuments,
        deleteDocuments: vi.fn(async () => ok(undefined)),
      },
    } as never,
  };
}

const placeDocs = (captured: Array<Record<string, unknown>>) =>
  captured.filter((d) => d.type === "place") as unknown as PlaceDoc[];

describe("buildSearchIndex — place documents carry the ENTITY PAGE slug", () => {
  it("full reindex: indexes pageSlug from the EntityPage, keeping Place.slug separate", async () => {
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: { [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: "A rock club." } },
    });

    await buildSearchIndex(deps, { fullReindex: true });

    const docs = placeDocs(captured);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.pageSlug).toBe(PAGE_SLUG);
    // `/places/[slug]` is a single non-catch-all segment — a `/` in the
    // routable value means a directory key leaked back in.
    expect(docs[0]!.pageSlug).not.toContain("/");
    // And there is no SECOND slug on the document to link off by mistake.
    expect(docs[0]).not.toHaveProperty("slug");
    // Bio still rides the same page read.
    expect(docs[0]!.bio).toBe("A rock club.");
  });

  it("full reindex: pageSlug is NULL — never the Place slug — for a venue with no entity page", async () => {
    const { deps, captured } = buildDeps({
      // Bulk-imported venue: a Place row with no EntityPage.
      places: [{ id: PLACE_WITHOUT_PAGE }],
      pages: {},
    });

    await buildSearchIndex(deps, { fullReindex: true });

    const docs = placeDocs(captured);
    expect(docs).toHaveLength(1);
    // Null, and no fallback to anything else — a venue with no page has no
    // link, and the consumer routes to `/places/id/{placeId}`.
    expect(docs[0]!.pageSlug).toBeNull();
    expect(docs[0]).not.toHaveProperty("slug");
  });

  it("targeted reindex by id carries the page slug too", async () => {
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: { [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: null } },
    });

    await buildSearchIndex(deps, { placeIds: [PLACE_WITH_PAGE] });

    const docs = placeDocs(captured);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.pageSlug).toBe(PAGE_SLUG);
  });

  // ReporterPort convention (CLAUDE.md): the entity-page read is a deliberate
  // catch-and-fallback — the batch keeps going and the venue silently loses
  // both its bio AND its public link. Invisible in the index ⇒ must be visible
  // in Sentry.
  it("reports the entity-page read failure instead of swallowing it (full reindex)", async () => {
    const reportError = vi.fn();
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: {},
      entityPagesError: new Error("entity page read failed"),
      reportError,
    });

    await buildSearchIndex(deps, { fullReindex: true });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "buildSearchIndex", step: "fetchEntityPage" },
      // The batch path reads every owner in ONE query, so the report names
      // the batch rather than firing once per owner.
      extra: {
        ownerType: "PLACE",
        ownerId: PLACE_WITH_PAGE,
        ownerCount: 1,
        ownerIds: [PLACE_WITH_PAGE],
      },
    });
    // Degraded, not dropped: the venue is still indexed, just without a link.
    expect(placeDocs(captured)[0]!.pageSlug).toBeNull();
  });

  it("reports the entity-page read failure on the targeted-by-id path too", async () => {
    const reportError = vi.fn();
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: {},
      entityPagesError: new Error("entity page read failed"),
      reportError,
    });

    await buildSearchIndex(deps, { placeIds: [PLACE_WITH_PAGE] });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "buildSearchIndex", step: "fetchEntityPage" },
      extra: { ownerType: "PLACE", ownerId: PLACE_WITH_PAGE },
    });
    expect(placeDocs(captured)[0]!.pageSlug).toBeNull();
  });

  it("a throwing reporter never changes indexing behaviour", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: {},
      entityPagesError: new Error("entity page read failed"),
      reportError,
    });

    await expect(
      buildSearchIndex(deps, { placeIds: [PLACE_WITH_PAGE] }),
    ).resolves.toMatchObject({ placesIndexed: 1 });
    expect(placeDocs(captured)[0]!.pageSlug).toBeNull();
  });
  // ── EntityPage.visibility ────────────────────────────────────────────────
  //
  // The search index is a "search and browse" surface, which is exactly what
  // the owner is told UNLISTED opts out of. PRIVATE additionally 404s. The
  // house precedent is already in the codebase: `humans.listForSearchIndex`
  // filters human pages to `visibility: "PUBLIC"` before they may be indexed;
  // places now match it.
  it.each(["PRIVATE", "UNLISTED"] as const)(
    "indexes a NULL pageSlug for a %s venue page (full reindex)",
    async (visibility) => {
      const { deps, captured } = buildDeps({
        places: [{ id: PLACE_WITH_PAGE }],
        pages: {
          [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: null, visibility },
        },
      });

      await buildSearchIndex(deps, { fullReindex: true });

      const docs = placeDocs(captured);
      expect(docs).toHaveLength(1);
      // The venue is STILL searchable — it just carries no link, so clients
      // fall back to `/places/id/{placeId}`.
      expect(docs[0]!.placeId).toBe(PLACE_WITH_PAGE);
      expect(docs[0]!.pageSlug).toBeNull();
      // Never a substitute, and never the directory key.
      expect(JSON.stringify(docs[0]!.pageSlug)).not.toContain(PAGE_SLUG);
    },
  );

  it.each(["PRIVATE", "UNLISTED"] as const)(
    "indexes a NULL pageSlug for a %s venue page (targeted by id)",
    async (visibility) => {
      const { deps, captured } = buildDeps({
        places: [{ id: PLACE_WITH_PAGE }],
        pages: {
          [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: null, visibility },
        },
      });

      await buildSearchIndex(deps, { placeIds: [PLACE_WITH_PAGE] });

      expect(placeDocs(captured)[0]!.pageSlug).toBeNull();
    },
  );

  // The mutation-driven path matters as much as the nightly one: flipping a
  // page PUBLIC → UNLISTED in the page editor reindexes that place, and THAT
  // is what strips the now-hidden slug back out of the index.
  it("a PUBLIC → UNLISTED flip removes the slug on the next targeted reindex", async () => {
    const before = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: { [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: null } },
    });
    await buildSearchIndex(before.deps, { placeIds: [PLACE_WITH_PAGE] });
    expect(placeDocs(before.captured)[0]!.pageSlug).toBe(PAGE_SLUG);

    const after = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: {
        [PLACE_WITH_PAGE]: {
          slug: PAGE_SLUG,
          bio: null,
          visibility: "UNLISTED",
        },
      },
    });
    await buildSearchIndex(after.deps, { placeIds: [PLACE_WITH_PAGE] });
    expect(placeDocs(after.captured)[0]!.pageSlug).toBeNull();
  });

  // ── One bulk read per batch, not a findUnique per owner ──────────────────
  it("reads the whole batch with ONE getByOwners call, never per-owner getByOwner", async () => {
    const ids = Array.from(
      { length: 5 },
      (_, i) => `00000000-0000-4000-8000-00000000c0${String(i).padStart(2, "0")}`,
    );
    const { deps, getByOwner, getByOwners } = buildDeps({
      places: ids.map((id) => ({ id })),
      pages: Object.fromEntries(
        ids.map((id) => [id, { slug: `venue-${id.slice(-4)}`, bio: null }]),
      ),
    });

    await buildSearchIndex(deps, { fullReindex: true });

    expect(getByOwners).toHaveBeenCalledTimes(1);
    expect(getByOwners.mock.calls[0]![1]).toHaveLength(5);
    expect(getByOwner).not.toHaveBeenCalled();
  });

  it("maps every place in a batch to its OWN page", async () => {
    const a = "00000000-0000-4000-8000-00000000c101";
    const b = "00000000-0000-4000-8000-00000000c102";
    const { deps, captured } = buildDeps({
      places: [
        { id: a },
        { id: b },
      ],
      pages: {
        [a]: { slug: "venue-a-1111", bio: null },
        // b is UNLISTED — it must not inherit a's slug.
        [b]: { slug: "venue-b-2222", bio: null, visibility: "UNLISTED" },
      },
    });

    await buildSearchIndex(deps, { fullReindex: true });

    const byId = new Map(placeDocs(captured).map((d) => [d.placeId, d.pageSlug]));
    expect(byId.get(a)).toBe("venue-a-1111");
    expect(byId.get(b)).toBeNull();
  });
});
// ── The sibling swallow, three lines away in the same file ─────────────────
//
// `indexOrganizationsByIds` did `.getByOwner("ORGANIZATION", id).catch(() =>
// null)` with no log and no report, so an org silently losing its bio was
// invisible. CLAUDE.md's opportunistic-migration rule: routed through the same
// guard while editing this file.
describe("buildSearchIndex — organization entity-page swallow is reported", () => {
  function buildOrgDeps(reportError?: (...args: unknown[]) => void) {
    const ORG_ID = "00000000-0000-4000-8000-00000000e001";
    const repos = {
      organizations: {
        getById: vi.fn(async () => ({
          id: ORG_ID,
          name: "Brooklyn Promotions",
          slug: "brooklyn-promotions",
          status: "ACTIVE",
        })),
      },
      entityPages: {
        getByOwner: vi.fn(async () => {
          throw new Error("entity page read failed");
        }),
        getByOwners: vi.fn(async () => []),
      },
    } as unknown as Repos;

    const captured: Array<Record<string, unknown>> = [];
    return {
      ORG_ID,
      captured,
      deps: {
        clock: testClock,
        repos,
        ...(reportError ? { reportError } : {}),
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments: vi.fn(async ({ documents }) => {
            captured.push(...documents);
            return ok({ indexed: documents.length });
          }),
          deleteDocuments: vi.fn(async () => ok(undefined)),
        },
      } as never,
    };
  }

  it("reports the failed org entity-page read instead of swallowing it silently", async () => {
    const reportError = vi.fn();
    const { deps, captured, ORG_ID } = buildOrgDeps(reportError);

    await buildSearchIndex(deps, { organizationIds: [ORG_ID] });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "buildSearchIndex", step: "fetchEntityPage" },
      extra: { ownerType: "ORGANIZATION", ownerId: ORG_ID },
    });
    // Degraded, not dropped: the org is still indexed, just without its bio.
    const org = captured.find((d) => d.type === "organization");
    expect(org).toBeDefined();
    expect(org!.bio).toBeNull();
  });

  it.each(["PRIVATE", "UNLISTED"] as const)(
    "does not index a %s ORG page's bio either",
    async (visibility) => {
      const ORG_ID = "00000000-0000-4000-8000-00000000e002";
      const captured: Array<Record<string, unknown>> = [];
      const repos = {
        organizations: {
          getById: vi.fn(async () => ({
            id: ORG_ID,
            name: "Brooklyn Promotions",
            slug: "brooklyn-promotions",
            status: "ACTIVE",
          })),
        },
        entityPages: {
          getByOwner: vi.fn(async () => ({
            ownerId: ORG_ID,
            slug: "brooklyn-promotions-a1b2c3d4",
            bio: "An org page nobody can open.",
            visibility,
          })),
          getByOwners: vi.fn(async () => []),
        },
      } as unknown as Repos;

      await buildSearchIndex(
        {
          clock: testClock,
          repos,
          search: {
            ensureIndexes: vi.fn(async () => ok(undefined)),
            // Non-destructive full rebuild: marker, then per-type sweep.
            beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
            deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
            upsertDocuments: vi.fn(async ({ documents }) => {
              captured.push(...documents);
              return ok({ indexed: documents.length });
            }),
            deleteDocuments: vi.fn(async () => ok(undefined)),
          },
        } as never,
        { organizationIds: [ORG_ID] },
      );

      const org = captured.find((d) => d.type === "organization") as
        | OrgDoc
        | undefined;
      expect(org).toBeDefined();
      expect(org!.bio).toBeNull();
      expect(JSON.stringify(org)).not.toContain("nobody can open");
    },
  );

  it("a throwing reporter still indexes the org", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const { deps, ORG_ID } = buildOrgDeps(reportError);

    await expect(
      buildSearchIndex(deps, { organizationIds: [ORG_ID] }),
    ).resolves.toMatchObject({ organizationsIndexed: 1 });
  });
});
// ── The BIO rides the same gate as the link ────────────────────────────────
//
// A page's bio is rendered as the search result's SUBTITLE. Indexing it for a
// PRIVATE page publishes the description of a page nobody can open; for an
// UNLISTED one it puts the content in exactly the "search and browse" the
// owner opted out of. The two were briefly gated differently inside ONE call
// expression — slug gated, bio not, three characters apart.
describe("buildSearchIndex — a non-PUBLIC page's bio is not indexed either", () => {
  it.each(["PRIVATE", "UNLISTED"] as const)(
    "drops the bio AND the slug for a %s venue page",
    async (visibility) => {
      const { deps, captured } = buildDeps({
        places: [{ id: PLACE_WITH_PAGE }],
        pages: {
          [PLACE_WITH_PAGE]: {
            slug: PAGE_SLUG,
            bio: "A rock club nobody can open.",
            visibility,
          },
        },
      });

      await buildSearchIndex(deps, { fullReindex: true });

      const doc = placeDocs(captured)[0]!;
      expect(doc.pageSlug).toBeNull();
      expect(doc.bio).toBeNull();
      // The whole document must not carry the private text anywhere.
      expect(JSON.stringify(doc)).not.toContain("nobody can open");
      // The venue itself is still searchable by NAME — public directory data.
      expect(doc.placeId).toBe(PLACE_WITH_PAGE);
    },
  );

  it.each(["PRIVATE", "UNLISTED"] as const)(
    "drops the bio for a %s venue page on the targeted-by-id path too",
    async (visibility) => {
      const { deps, captured } = buildDeps({
        places: [{ id: PLACE_WITH_PAGE }],
        pages: {
          [PLACE_WITH_PAGE]: {
            slug: PAGE_SLUG,
            bio: "A rock club nobody can open.",
            visibility,
          },
        },
      });

      await buildSearchIndex(deps, { placeIds: [PLACE_WITH_PAGE] });

      expect(placeDocs(captured)[0]!.bio).toBeNull();
    },
  );

  it("still indexes the bio for a PUBLIC page (the gate is not a blanket drop)", async () => {
    const { deps, captured } = buildDeps({
      places: [{ id: PLACE_WITH_PAGE }],
      pages: { [PLACE_WITH_PAGE]: { slug: PAGE_SLUG, bio: "A rock club." } },
    });

    await buildSearchIndex(deps, { fullReindex: true });

    expect(placeDocs(captured)[0]!.bio).toBe("A rock club.");
  });
});
