import { beforeEach, describe, expect, it, vi } from "vitest";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { ok } from "@th/ports/search/types";

/**
 * THE SEARCH-INDEX SIDE of a community listing edit, pinned on BOTH paths that
 * can make one.
 *
 * The gap this covers: a public "the venue moved" suggestion is approved (or a
 * moderator edits the listing directly), the event page updates and the FR-013
 * notice goes out — and search keeps serving the OLD venue until the nightly
 * `search.full-reindex`. Two paths write the same rows, so a fix on one is not
 * a fix; the reindex therefore lives in the shared post-apply pipeline
 * (`_shared/community-edit-applied.ts`) and both callers dispatch the closure
 * it returns.
 *
 * Both edit paths are exercised in ONE file on purpose: the whole point is
 * that they agree, and a per-path suite is exactly how they stopped agreeing.
 */

// Spy that wraps the REAL `reindexAfterMutation`. Most cases only care WHETHER
// it was called and with what (so they stub the body out); the "search is
// down" cases restore the real implementation and drive it end-to-end.
const { reindexSpy, real } = vi.hoisted(() => ({
  reindexSpy: vi.fn(),
  real: { reindexAfterMutation: undefined as unknown as (...a: never[]) => void },
}));
vi.mock("../../search/reindex-after-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../search/reindex-after-mutation")
    >();
  real.reindexAfterMutation = actual.reindexAfterMutation as never;
  return {
    ...actual,
    reindexAfterMutation: (...args: unknown[]) => reindexSpy(...args),
  };
});

import {
  reviewEventEditSuggestion,
  type ReviewEventEditSuggestionDeps,
} from "../review-event-edit-suggestion";
import {
  updateCommunityListing,
  type UpdateCommunityListingDeps,
} from "../update-community-listing";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  NOW,
  SUGGESTION_ID,
  makeBaseVersion,
  makeClock,
  makeCommunityEvent,
  makeContentFilter,
  makeImage,
  makeStaffAuthz,
  makeSuggestion,
} from "./helpers";

/**
 * `MultiSearchPort` fake. `upsertDocuments` is the observable end of the
 * incremental index; `rejectUpsert` simulates the backend being down.
 */
function makeSearchFake(options: { rejectUpsert?: boolean } = {}) {
  const upsertDocuments = vi.fn(async ({ documents }: { documents: unknown[] }) => {
    if (options.rejectUpsert) {
      throw new Error("meilisearch unreachable");
    }
    return ok({ indexed: documents.length });
  });
  const search = {
    ensureIndexes: vi.fn(async () => ok(undefined)),
    upsertDocuments,
    deleteDocuments: vi.fn(async () => ok(undefined)),
    getStats: vi.fn(async () => ok({} as never)),
    autocomplete: vi.fn(async () => ok({} as never)),
  } as unknown as MultiSearchPort;
  return { search, upsertDocuments };
}

/**
 * Read-side repos `reindexAfterMutation → buildSearchIndex` touches for a
 * single-event incremental index. Same shape as
 * `create-community-listing.test.ts`'s — the listing comes back PUBLISHED so a
 * document actually reaches `upsertDocuments`.
 */
/**
 * The mutation's `repos.tx` fake hands its callback the WRITE-side repos. The
 * search index write fence opens a `repos.tx` of its own and reads through
 * it, so the object it gets must carry the read side (and the fence's locks)
 * too.
 */
function fenceAwareTxRepos<T extends object>(
  txRepos: T,
  readRepos: object,
): T {
  // One level deep, per repo: both sides can define `events` / `images`.
  const merged: Record<string, unknown> = { ...readRepos };
  for (const [key, repo] of Object.entries(txRepos)) {
    const read = (readRepos as Record<string, unknown>)[key];
    merged[key] =
      read && typeof read === "object" && repo && typeof repo === "object"
        ? { ...read, ...repo }
        : repo;
  }
  return withSearchIndexFence(merged) as T;
}

function makeSearchReadRepos() {
  return {
    events: {
      getById: vi.fn(async (id: string) => ({
        id,
        slug: "event/us/austin/weekly-open-mic",
        title: "Weekly Open Mic",
        status: "PUBLISHED" as const,
        orgId: null,
        categoryId: null,
        admissionTaxRateBps: 0,
        addressText: "123 Main St, Austin, TX",
        lat: 30.27,
        lng: -97.74,
        locality: "Austin",
        region: "TX",
        locationMode: "EXACT" as const,
        locationRadiusMeters: null,
      })),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    payoutTerms: { listByEvent: vi.fn(async () => []) },
    feePolicies: { resolveEffective: vi.fn(async () => null) },
    images: {
      getPrimaryImageRefs: vi.fn(
        async () => new Map<string, { publicUrl: string; key: string }>(),
      ),
    },
  };
}

type PathOverrides = {
  event?: EventRecord;
  suggestion?: EventEditSuggestionRecord;
  search?: MultiSearchPort;
  /** Records the commit boundary so a test can prove ordering. */
  onCommit?: () => void;
};

/** Deps for the DIRECT moderator edit (`updateCommunityListing`). */
function buildDirectEditDeps(overrides: PathOverrides = {}) {
  const event = overrides.event ?? makeCommunityEvent();
  const applyCommunityEdit = vi.fn(
    async ({ fields }: { fields: Record<string, unknown> }) =>
      ({ ...event, ...fields }) as EventRecord,
  );
  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      getContent: vi.fn(async () => null),
      applyCommunityEdit,
      // The direct edit row-locks the listing before reading it.
      lockRows: vi.fn(async () => undefined),
    },
    images: {
      getById: vi.fn(async () => makeImage()),
      listByEventId: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
    },
    audit: { log: vi.fn() },
    eventChangeNotices: {
      create: vi.fn(async () => ({ id: "notice-1", createdAt: NOW })),
    },
    calendars: { findById: vi.fn(async () => null) },
  };

  const searchReadRepos = makeSearchReadRepos();
  const reportError = vi.fn();
  let committed = false;

  const deps: UpdateCommunityListingDeps = {
    repos: withSearchIndexFence(
      {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
          const out = await fn(fenceAwareTxRepos(txRepos, searchReadRepos));
          committed = true;
          overrides.onCommit?.();
          return out;
        }),
        ...searchReadRepos,
      } as unknown as UpdateCommunityListingDeps["repos"],
    ),
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
    search: overrides.search,
    reportError,
  };

  return {
    deps,
    reportError,
    searchReadRepos,
    isCommitted: () => committed,
    run: (fields: Record<string, unknown>) =>
      updateCommunityListing(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        fields,
      }),
  };
}

/** Deps for the suggestion-APPROVE edit (`reviewEventEditSuggestion`). */
function buildApproveDeps(overrides: PathOverrides = {}) {
  const event = overrides.event ?? makeCommunityEvent();
  const suggestion = overrides.suggestion ?? makeSuggestion();
  const applyCommunityEdit = vi.fn(
    async ({ fields }: { fields?: Record<string, unknown> }) =>
      ({ ...event, ...(fields ?? {}) }) as EventRecord,
  );
  const txRepos = {
    eventEditSuggestions: {
      getById: vi.fn(async () => suggestion),
      claimPendingForReview: vi.fn(async () => ({
        ...suggestion,
        reviewedByHumanId: MODERATOR_ID,
        reviewedAt: NOW,
      })),
      markReviewed: vi.fn(
        async (args: Record<string, unknown>) =>
          ({
            ...suggestion,
            status: args.status,
            reviewedByHumanId: args.reviewedByHumanId,
            reviewedAt: args.reviewedAt,
            reviewNote: (args.reviewNote as string | null) ?? null,
            appliedFields:
              (args.appliedFields as Record<string, unknown> | null) ?? null,
            conflictedFields: (args.conflictedFields as string[] | null) ?? null,
          }) as EventEditSuggestionRecord,
      ),
    },
    events: {
      getById: vi.fn(async () => event),
      getContent: vi.fn(async () => null),
      applyCommunityEdit,
      // The approve path row-locks the event before reading it.
      lockRows: vi.fn(async () => undefined),
    },
    images: {
      getById: vi.fn(async () => makeImage()),
      listByEventId: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn() },
    eventChangeNotices: {
      create: vi.fn(async () => ({ id: "notice-1", createdAt: NOW })),
    },
    calendars: { findById: vi.fn(async () => null) },
  };

  const searchReadRepos = makeSearchReadRepos();
  const reportError = vi.fn();
  let committed = false;

  const deps: ReviewEventEditSuggestionDeps = {
    repos: withSearchIndexFence(
      {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
          const out = await fn(fenceAwareTxRepos(txRepos, searchReadRepos));
          committed = true;
          overrides.onCommit?.();
          return out;
        }),
        notifications: {
          create: vi.fn(async () => ({ id: "notif-1", createdAt: NOW })),
        },
        ...searchReadRepos,
      } as unknown as ReviewEventEditSuggestionDeps["repos"],
    ),
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
    search: overrides.search,
    reportError,
  };

  return {
    deps,
    reportError,
    searchReadRepos,
    isCommitted: () => committed,
    run: (decision: "APPROVE" | "REJECT" = "APPROVE") =>
      reviewEventEditSuggestion(deps, {
        actorHumanId: MODERATOR_ID,
        suggestionId: SUGGESTION_ID,
        decision,
      }),
  };
}

/** The single `reindexAfterMutation` call, destructured. */
function reindexCall() {
  expect(reindexSpy).toHaveBeenCalledTimes(1);
  const [deps, useCaseName, selector] = reindexSpy.mock.calls[0] as [
    { search?: unknown; reportError?: unknown },
    string,
    unknown,
  ];
  return { deps, useCaseName, selector };
}

beforeEach(() => {
  reindexSpy.mockReset();
  // Default: record the call, don't run the real indexer. The "search is down"
  // block restores the real one.
  reindexSpy.mockImplementation(() => undefined);
});

describe("a community listing edit reindexes on BOTH edit paths", () => {
  it("APPROVING a suggestion reindexes the event, threading search + reportError", async () => {
    const { search } = makeSearchFake();
    const event = makeCommunityEvent();
    const { deps, run, reportError } = buildApproveDeps({
      event,
      search,
      suggestion: makeSuggestion({
        fields: { addressText: "500 New Venue Rd, Austin, TX" },
        baseVersion: makeBaseVersion(event),
      }),
    });

    const result = await run("APPROVE");
    expect(result.appliedFields).toEqual(["addressText"]);

    const { deps: reindexDeps, useCaseName, selector } = reindexCall();
    expect(useCaseName).toBe("reviewEventEditSuggestion");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(reportError);
    expect(reindexDeps).toMatchObject({ repos: deps.repos, clock: deps.clock });
  });

  it("a DIRECT moderator edit of a live listing reindexes the event, threading search + reportError", async () => {
    const { search } = makeSearchFake();
    const { deps, run, reportError } = buildDirectEditDeps({ search });

    const result = await run({ addressText: "500 New Venue Rd, Austin, TX" });
    expect(result.updatedFields).toEqual(["addressText"]);

    const { deps: reindexDeps, useCaseName, selector } = reindexCall();
    expect(useCaseName).toBe("updateCommunityListing");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(reportError);
    expect(reindexDeps).toMatchObject({ repos: deps.repos, clock: deps.clock });
  });

  // The FR-013 `material` flag answers "must attendees be told", which is NOT
  // the same question as "did a searchable field change". A title is the most
  // searchable field there is and is deliberately non-material, so gating the
  // reindex on that flag would leave the commonest edit serving a stale title.
  it("a NON-MATERIAL title-only direct edit still reindexes", async () => {
    const { search } = makeSearchFake();
    const { run } = buildDirectEditDeps({ search });

    await run({ title: "Weekly Open Mic & Jam" });

    const { useCaseName, selector } = reindexCall();
    expect(useCaseName).toBe("updateCommunityListing");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
  });

  it("a NON-MATERIAL title-only APPROVE still reindexes", async () => {
    const { search } = makeSearchFake();
    const { run } = buildApproveDeps({ search });

    // The default fixture suggestion is a title change — non-material, and no
    // FR-013 notice is written for it.
    const result = await run("APPROVE");
    expect(result.appliedFields).toEqual(["title"]);

    const { useCaseName } = reindexCall();
    expect(useCaseName).toBe("reviewEventEditSuggestion");
  });

  it("a DRAFT save does NOT reindex — a draft is not in the index", async () => {
    const { search } = makeSearchFake();
    const { run } = buildDirectEditDeps({
      event: makeCommunityEvent({ status: "DRAFT", publishedAt: null }),
      search,
    });

    await run({ title: "Weekly Open Mic & Jam" });

    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("a REJECT does NOT reindex — nothing was applied", async () => {
    const { search } = makeSearchFake();
    const { run } = buildApproveDeps({ search });

    await run("REJECT");

    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("an ALL-CONFLICTED approve does NOT reindex — nothing was applied", async () => {
    const { search } = makeSearchFake();
    const event = makeCommunityEvent();
    const { run } = buildApproveDeps({
      event,
      search,
      // Base version drifted on the one proposed field (FR-009), so it
      // conflicts away and the approve writes no event mutation.
      suggestion: makeSuggestion({
        fields: { title: "Weekly Open Mic & Jam" },
        baseVersion: { ...makeBaseVersion(event), title: "A Different Title" },
      }),
    });

    const result = await run("APPROVE");
    expect(result.appliedFields).toEqual([]);
    expect(result.conflictedFields).toEqual(["title"]);
    expect(reindexSpy).not.toHaveBeenCalled();
  });
});

describe("the reindex is dispatched AFTER the transaction commits", () => {
  // Indexing inside the tx would publish rows the tx may still roll back, and
  // a slow/failing search call would hold the event's row locks for the length
  // of an HTTP round-trip. The shared unit runs INSIDE `tx` and therefore only
  // DECIDES; the call itself rides a closure the caller dispatches after.
  it("on the APPROVE path", async () => {
    const { search } = makeSearchFake();
    const seen: boolean[] = [];
    const harness = buildApproveDeps({ search });
    reindexSpy.mockImplementation(() => {
      seen.push(harness.isCommitted());
    });

    await harness.run("APPROVE");

    expect(seen).toEqual([true]);
  });

  it("on the DIRECT edit path", async () => {
    const { search } = makeSearchFake();
    const seen: boolean[] = [];
    const harness = buildDirectEditDeps({ search });
    reindexSpy.mockImplementation(() => {
      seen.push(harness.isCommitted());
    });

    await harness.run({ title: "Weekly Open Mic & Jam" });

    expect(seen).toEqual([true]);
  });
});

describe("search being down never fails the edit, and is reported", () => {
  beforeEach(() => {
    // These cases drive the REAL fire-and-forget reindex end to end.
    reindexSpy.mockImplementation((...args: unknown[]) =>
      (real.reindexAfterMutation as (...a: unknown[]) => void)(...args),
    );
  });

  it("an APPROVE still succeeds and reports through ReporterPort", async () => {
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const { run, reportError } = buildApproveDeps({ search });

    const result = await run("APPROVE");

    // The edit committed and answered normally...
    expect(result.suggestion.status).toBe("APPROVED");
    expect(result.appliedFields).toEqual(["title"]);
    // ...while the index write blew up and was reported, not swallowed silent.
    await vi.waitFor(() => expect(upsertDocuments).toHaveBeenCalled());
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: {
        useCase: "reviewEventEditSuggestion",
        op: "reindexAfterMutation",
      },
    });
  });

  it("a DIRECT edit still succeeds and reports through ReporterPort", async () => {
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const { run, reportError } = buildDirectEditDeps({ search });

    const result = await run({ title: "Weekly Open Mic & Jam" });

    expect(result.updatedFields).toEqual(["title"]);
    await vi.waitFor(() => expect(upsertDocuments).toHaveBeenCalled());
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "updateCommunityListing", op: "reindexAfterMutation" },
    });
  });

  it("a THROWING reporter still cannot fail the edit", async () => {
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const { run, reportError } = buildDirectEditDeps({ search });
    reportError.mockImplementation(() => {
      throw new Error("sentry transport exploded");
    });

    const result = await run({ title: "Weekly Open Mic & Jam" });

    expect(result.updatedFields).toEqual(["title"]);
    await vi.waitFor(() => expect(upsertDocuments).toHaveBeenCalled());
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    // A throwing reporter inside a fire-and-forget swallow must not become an
    // unhandled rejection; give the microtask chain room to surface one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("no search port at all is a silent, successful no-op", async () => {
    const { run, reportError } = buildDirectEditDeps();

    const result = await run({ title: "Weekly Open Mic & Jam" });

    expect(result.updatedFields).toEqual(["title"]);
    expect(reportError).not.toHaveBeenCalled();
  });
});
