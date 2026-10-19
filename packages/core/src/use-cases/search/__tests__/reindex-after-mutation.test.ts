import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import {
  reindexAfterMutation,
  reindexAllPublishedEvents as reindexAllPublishedEventsFenced,
} from "../reindex-after-mutation";

/** The fixtures below predate the index-write fence; give them its surface. */
const reindexAllPublishedEvents: typeof reindexAllPublishedEventsFenced = (
  deps,
) =>
  reindexAllPublishedEventsFenced({
    ...deps,
    repos: withSearchIndexFence(deps.repos),
  });

// A valid UUID so `buildSearchIndex`'s zod input parse accepts the event id.
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A search port whose `ensureIndexes` fails, forcing `buildSearchIndex` (and
 * therefore the fire-and-forget reindex) into its rejection branch without any
 * real Meilisearch/DB access.
 */
const failingSearch = (): MultiSearchPort =>
  ({
    ensureIndexes: vi.fn(async () => ({
      ok: false as const,
      error: new Error("meili unreachable"),
    })),
  }) as unknown as MultiSearchPort;

/**
 * A search port that is fully healthy — used to isolate a PER-ID failure
 * (a `getById` blip) from a whole-batch failure: `buildSearchIndex` still
 * RESOLVES, but with `result.errors` populated, so the removal is skipped.
 */
const healthySearch = (): MultiSearchPort =>
  ({
    ensureIndexes: vi.fn(async () => ({ ok: true as const })),
    upsertDocuments: vi.fn(async () => ({ ok: true as const })),
    deleteDocuments: vi.fn(async () => ({ ok: true as const })),
  }) as unknown as MultiSearchPort;

describe("reindexAfterMutation swallow-and-report", () => {
  it("reports the underlying error via reportError when the reindex fails", async () => {
    const reportError = vi.fn();

    reindexAfterMutation(
      {
        repos: {} as Repos,
        search: failingSearch(),
        reportError,
      },
      "unitTestUseCase",
      { kind: "event", id: EVENT_ID },
    );

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));

    const [, context] = reportError.mock.calls[0]!;
    expect(context?.tags?.useCase).toBe("unitTestUseCase");
    expect(context?.tags?.op).toBe("reindexAfterMutation");
    expect(context?.extra).toMatchObject({ kind: "event", id: EVENT_ID });
  });

  it("is a no-op (no report) when no search port is wired", () => {
    const reportError = vi.fn();

    reindexAfterMutation(
      { repos: {} as Repos, reportError },
      "unitTestUseCase",
      { kind: "event", id: EVENT_ID },
    );

    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a per-id failure that resolves the batch (removal silently skipped otherwise)", async () => {
    // getById throws → indexEventsByIds catches it into result.errors, so the
    // batch RESOLVES (not rejects) and the cancelled event's removal is skipped.
    // Without escalation this would only be an info line; assert it reports.
    const reportError = vi.fn();
    const repos = {
      events: {
        getById: vi.fn(async () => {
          throw new Error("neon blip");
        }),
      },
    } as unknown as Repos;

    reindexAfterMutation(
      { repos, search: healthySearch(), reportError },
      "cancelEvent",
      { kind: "event", id: EVENT_ID },
    );

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    const [, context] = reportError.mock.calls[0]!;
    expect(context?.tags?.op).toBe("reindexAfterMutation");
    expect(context?.extra).toMatchObject({ kind: "event", id: EVENT_ID });
  });

  it("does not throw when the reporter itself throws (best-effort)", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    expect(() =>
      reindexAfterMutation(
        {
          repos: {} as Repos,
          search: failingSearch(),
          reportError,
        },
        "unitTestUseCase",
        { kind: "event", id: EVENT_ID },
      ),
    ).not.toThrow();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
  });
});

describe("reindexAllPublishedEvents", () => {
  const clock = { now: () => new Date("2026-08-12T00:00:00.000Z") };

  /**
   * `getById` returning null makes `buildSearchIndex` REMOVE the doc instead of
   * upserting it, which exercises the pagination loop without standing up a
   * full event fixture. `throwFor` makes a specific id's `getById` blow up,
   * which is how a PER-ID failure is produced: `buildSearchIndex` catches it,
   * pushes to `result.errors`, and still RESOLVES.
   */
  const reposWithPublishedPages = (
    pages: string[][],
    opts: { throwFor?: Set<string> } = {},
  ) => {
    const listPublished = vi.fn(
      async ({ offset }: { limit: number; offset: number }) => {
        const page = pages[offset / 200] ?? [];
        return { items: page.map((id) => ({ id })) };
      },
    );
    const getById = vi.fn(async (id: string) => {
      if (opts.throwFor?.has(id)) throw new Error(`getById blip for ${id}`);
      return null;
    });
    return {
      repos: { events: { listPublished, getById } } as unknown as Repos,
      listPublished,
      getById,
    };
  };

  it("paginates published events and reports how many it enumerated", async () => {
    // Two FULL pages then a short page — the short page is what terminates the
    // loop, so a regression that never advanced `offset` would hang or
    // under-count here rather than silently pass.
    const fullPage = Array.from(
      { length: 200 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    const shortPage = [EVENT_ID];
    const { repos, listPublished } = reposWithPublishedPages([
      fullPage,
      fullPage,
      shortPage,
    ]);

    const result = await reindexAllPublishedEvents({
      repos,
      search: healthySearch(),
      clock,
    });

    expect(result.enumerated).toBe(401);
    expect(result.errors).toEqual([]);
    expect(listPublished).toHaveBeenCalledTimes(3);
    expect(listPublished.mock.calls.map(([args]) => args!.offset)).toEqual([
      0, 200, 400,
    ]);
  });

  it("returns zero without indexing when nothing is published", async () => {
    const { repos } = reposWithPublishedPages([]);
    const search = healthySearch();

    const result = await reindexAllPublishedEvents({ repos, search, clock });

    expect(result).toEqual({ indexed: 0, enumerated: 0, errors: [] });
    expect(search.upsertDocuments).not.toHaveBeenCalled();
  });

  it("SURFACES per-id failures instead of counting them as successes", async () => {
    // THE BUG THIS GUARDS: `buildSearchIndex` RESOLVES with `result.errors` for
    // a per-id `getById` blip — it only rejects on a whole-batch failure. A
    // caller that ignored that array would print "reindexed 3 events", exit 0,
    // and leave the failed one serving the OLD fee-inclusive price until the
    // nightly reconcile. The deploy step is green; the price is wrong.
    const ids = [
      "11111111-1111-4111-8111-000000000001",
      "11111111-1111-4111-8111-000000000002",
      "11111111-1111-4111-8111-000000000003",
    ];
    const { repos } = reposWithPublishedPages([ids], {
      throwFor: new Set([ids[1]!]),
    });

    const result = await reindexAllPublishedEvents({
      repos,
      search: healthySearch(),
      clock,
    });

    expect(result.enumerated).toBe(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.id).toBe(ids[1]);
    expect(result.errors[0]!.error).toContain("getById blip");
  });

  it("accumulates per-id failures ACROSS pages, not just the last one", async () => {
    const pageA = Array.from(
      { length: 200 },
      (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    );
    const pageB = ["22222222-2222-4222-8222-000000000900"];
    const { repos } = reposWithPublishedPages([pageA, pageB], {
      throwFor: new Set([pageA[0]!, pageB[0]!]),
    });

    const result = await reindexAllPublishedEvents({
      repos,
      search: healthySearch(),
      clock,
    });

    expect(result.enumerated).toBe(201);
    expect(result.errors.map((e) => e.id).sort()).toEqual(
      [pageA[0]!, pageB[0]!].sort(),
    );
  });

  it("REJECTS when enumerating published events fails (never swallows)", async () => {
    // The deploy-time reconciler is the only caller and it turns a rejection
    // into a red step. If this ever went back to swallowing, a fee change
    // would ship with the whole corpus showing stale buyer totals and nothing
    // would say so.
    const repos = {
      events: {
        listPublished: vi.fn(async () => {
          throw new Error("db unreachable");
        }),
      },
    } as unknown as Repos;

    await expect(
      reindexAllPublishedEvents({ repos, search: healthySearch(), clock }),
    ).rejects.toThrow("db unreachable");
  });

  it("REJECTS when the search backend is unreachable", async () => {
    const { repos } = reposWithPublishedPages([[EVENT_ID]]);

    await expect(
      reindexAllPublishedEvents({ repos, search: failingSearch(), clock }),
    ).rejects.toThrow();
  });
  // ── The reporter must reach buildSearchIndex, not just this wrapper ──────
  //
  // `buildSearchIndex` has its own deliberate swallow: a failed EntityPage
  // read leaves a place with `pageSlug: null`, dropping that venue to the
  // `/places/id/{uuid}` fallback in search until the nightly reindex. That
  // swallow reports through `deps.reportError` — which this function used to
  // NOT forward, leaving the reporting dead on the entire mutation-driven
  // path while the nightly job was wired correctly.
  it("FORWARDS reportError into buildSearchIndex, so its own swallows are reportable", async () => {
    const reportError = vi.fn();
    const PLACE_ID = "00000000-0000-4000-8000-00000000d001";

    const repos = {
      places: {
        getById: vi.fn(async () => ({
          id: PLACE_ID,
          name: "The Basement East",
          slug: "us/tn/the-basement-east--a1b2c3d4e5",
          status: "ACTIVE",
          verificationStatus: "VERIFIED",
          listedInDirectory: true,
        })),
      },
      entityPages: {
        // The swallowed failure that lives INSIDE buildSearchIndex.
        getByOwner: vi.fn(async () => {
          throw new Error("entity page read failed");
        }),
      },
    } as unknown as Repos;
    withSearchIndexFence(repos);

    reindexAfterMutation(
      {
        repos,
        search: healthySearch(),
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
        reportError,
      },
      "unitTestUseCase",
      { kind: "place", id: PLACE_ID },
    );

    // Assert on the report we care about, not the total: this wrapper ALSO
    // reports its own partial-batch failure, and pinning a count would make
    // the test fail for an unrelated, correct reason.
    await vi.waitFor(() =>
      expect(
        reportError.mock.calls.some(
          ([, ctx]) =>
            (ctx as { tags?: Record<string, unknown> })?.tags?.useCase ===
            "buildSearchIndex",
        ),
      ).toBe(true),
    );

    const inner = reportError.mock.calls.find(
      ([, ctx]) =>
        (ctx as { tags?: Record<string, unknown> })?.tags?.useCase ===
        "buildSearchIndex",
    )!;
    const context = inner[1] as {
      tags?: Record<string, unknown>;
      extra?: Record<string, unknown>;
    };
    // Reported by buildSearchIndex's own guard, not by this wrapper — proof
    // the dep actually crossed the boundary.
    expect(context?.tags?.step).toBe("fetchEntityPage");
    expect(context?.extra).toMatchObject({
      ownerType: "PLACE",
      ownerId: PLACE_ID,
    });
  });

  it("does NOT report buildSearchIndex's swallow when reportError is omitted (regression guard)", async () => {
    // The inverse of the test above: without the forward, a venue silently
    // loses its search link. Pins that the wiring is what makes it visible.
    const PLACE_ID = "00000000-0000-4000-8000-00000000d002";
    const getByOwner = vi.fn(async () => {
      throw new Error("entity page read failed");
    });
    const repos = {
      places: {
        getById: vi.fn(async () => ({
          id: PLACE_ID,
          name: "The Basement East",
          slug: "us/tn/the-basement-east--a1b2c3d4e5",
          status: "ACTIVE",
          verificationStatus: "VERIFIED",
          listedInDirectory: true,
        })),
      },
      entityPages: { getByOwner },
    } as unknown as Repos;
    withSearchIndexFence(repos);

    reindexAfterMutation(
      {
        repos,
        search: healthySearch(),
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      },
      "unitTestUseCase",
      { kind: "place", id: PLACE_ID },
    );

    // The read still happened and still failed — it just had nowhere to go.
    await vi.waitFor(() => expect(getByOwner).toHaveBeenCalled());
  });
});
