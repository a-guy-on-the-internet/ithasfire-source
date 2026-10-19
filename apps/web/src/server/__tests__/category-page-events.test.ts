/**
 * `loadCategoryPageEvents`: the server read that puts the plain category
 * page's first page of events into the HTML.
 *
 * Pins: it reads through the NO-IDENTITY client with the shared page size; an
 * unknown category or an unparseable slug is a 404 (not-found), not a report;
 * every other failure degrades and is REPORTED, except search's known states
 * (category not found, search not configured).
 */
import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  searchQuery: vi.fn(),
  listQuery: vi.fn(),
  serverClient: vi.fn(),
  reported: vi.fn(),
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    categories: {
      eventsByCategory: { query: mocks.dbQuery },
      list: { query: mocks.listQuery },
    },
    search: { discoverEventsByCategory: { query: mocks.searchQuery } },
  }),
  getServerTrpcClient: mocks.serverClient,
}));

// Same contract as the real helper: an `expected` match is not reported.
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError:
    (label: string, expected?: (err: unknown) => boolean) =>
    (err: unknown) => {
      if (expected?.(err)) return;
      mocks.reported(label, err);
    },
}));

import { CATEGORY_PAGE_SIZE } from "@/lib/events/category-page";
import { loadCategoryPageEvents } from "@/server/events";

/** A tRPC client error with the wire `data` the API actually sends. */
const trpcError = (code: string, appCode?: string) =>
  new TRPCClientError(code, {
    result: { error: { data: { code, ...(appCode ? { appCode } : {}) } } },
  } as never);

const event = { id: "e1", slug: "us/mn/open-mic--a", title: "Open Mic" };
const DB = { events: [event], total: 1, indexableTotal: 1 };
const SEARCH = { events: [event], latencyMs: 2 };
const LIST = {
  categories: [{ id: "c1", slug: "open-mics", name: "Open Mics", active: true }],
};

// `cache()` memoises per slug inside a request scope; a fresh slug per test
// keeps the cases independent wherever it does memoise.
let n = 0;
const slug = () => `open-mics-${++n}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbQuery.mockResolvedValue(DB);
  mocks.searchQuery.mockResolvedValue(SEARCH);
  mocks.listQuery.mockResolvedValue(LIST);
});

describe("loadCategoryPageEvents", () => {
  it("reads both first-page queries anonymously with the shared page size", async () => {
    mocks.listQuery.mockResolvedValue({
      categories: [{ slug: "open-mics", name: "Open Mics" }],
    });

    const load = await loadCategoryPageEvents("open-mics");

    expect(mocks.dbQuery).toHaveBeenCalledWith({
      categorySlug: "open-mics",
      limit: CATEGORY_PAGE_SIZE,
      offset: 0,
    });
    expect(mocks.searchQuery).toHaveBeenCalledWith({
      categorySlug: "open-mics",
      limit: CATEGORY_PAGE_SIZE,
    });
    expect(mocks.serverClient).not.toHaveBeenCalled();
    expect(load).toMatchObject({
      status: "found",
      categoryName: "Open Mics",
      total: 1,
      indexableTotal: 1,
      seed: { search: SEARCH, db: DB },
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("passes the ungated count apart from the listed total", async () => {
    // Two gated events list; none makes the page indexable.
    mocks.dbQuery.mockResolvedValue({
      events: [event, { ...event, id: "e2" }],
      total: 2,
      indexableTotal: 0,
    });

    const load = await loadCategoryPageEvents(slug());

    expect(load).toMatchObject({
      status: "found",
      total: 2,
      indexableTotal: 0,
    });
  });

  it.each([
    ["NOT_FOUND", trpcError("NOT_FOUND", "CATEGORY_NOT_FOUND")],
    ["BAD_REQUEST (a slug the input schema rejects)", trpcError("BAD_REQUEST")],
  ])("is not-found on a DB %s, unreported", async (_label, err) => {
    mocks.dbQuery.mockRejectedValue(err);
    // A slug past the DB's max(64) is one search does not reject: it answers
    // CATEGORY_NOT_FOUND, which is expected.
    mocks.searchQuery.mockRejectedValue(
      trpcError("NOT_FOUND", "CATEGORY_NOT_FOUND"),
    );

    await expect(loadCategoryPageEvents(slug())).resolves.toEqual({
      status: "not-found",
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("is unavailable and reported when the DB read fails", async () => {
    const err = new TypeError("fetch failed");
    mocks.dbQuery.mockRejectedValue(err);

    await expect(loadCategoryPageEvents(slug())).resolves.toEqual({
      status: "unavailable",
    });
    expect(mocks.reported).toHaveBeenCalledWith(
      "server.events.loadCategoryPageEvents.db",
      err,
    );
  });

  it("degrades to search: null and reports when search fails", async () => {
    const err = trpcError("INTERNAL_SERVER_ERROR");
    mocks.searchQuery.mockRejectedValue(err);

    const load = await loadCategoryPageEvents(slug());

    expect(load).toMatchObject({ status: "found", seed: { search: null, db: DB } });
    expect(mocks.reported).toHaveBeenCalledWith(
      "server.events.loadCategoryPageEvents.search",
      err,
    );
  });

  it("reports a search BAD_REQUEST while the DB read succeeds (our input is wrong)", async () => {
    const err = trpcError("BAD_REQUEST");
    mocks.searchQuery.mockRejectedValue(err);

    const load = await loadCategoryPageEvents(slug());

    expect(load).toMatchObject({ status: "found", seed: { search: null, db: DB } });
    expect(mocks.reported).toHaveBeenCalledWith(
      "server.events.loadCategoryPageEvents.search",
      err,
    );
  });

  it("does not report search not being configured (PRECONDITION_FAILED)", async () => {
    mocks.searchQuery.mockRejectedValue(trpcError("PRECONDITION_FAILED"));

    const load = await loadCategoryPageEvents(slug());

    expect(load).toMatchObject({ status: "found", seed: { search: null } });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("falls back to the slug as the name and reports when the list fails", async () => {
    const err = new TypeError("fetch failed");
    mocks.listQuery.mockRejectedValue(err);
    const s = slug();

    const load = await loadCategoryPageEvents(s);

    expect(load).toMatchObject({ status: "found", categoryName: s });
    expect(mocks.reported).toHaveBeenCalledWith(
      "server.events.loadCategoryPageEvents.list",
      err,
    );
  });
});

describe("CATEGORY_PAGE_SIZE", () => {
  it("fits both procedures' limit caps (search 50, DB 100)", () => {
    // Over 50, `search.discoverEventsByCategory` rejects every page view's
    // input with BAD_REQUEST (reported, but the page silently loses search).
    expect(CATEGORY_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(CATEGORY_PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});
