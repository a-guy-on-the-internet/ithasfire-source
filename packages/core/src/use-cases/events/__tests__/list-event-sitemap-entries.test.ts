import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventSitemapEntryRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  listEventSitemapEntries,
  type ListEventSitemapEntriesDeps,
} from "../list-event-sitemap-entries";

const createDeps = (entries: EventSitemapEntryRecord[]) => {
  type ListPublishedForSitemapInput =
    | { limit?: number; now?: Date }
    | undefined;
  const listPublishedForSitemap = vi.fn<
    [input?: ListPublishedForSitemapInput],
    Promise<EventSitemapEntryRecord[]>
  >();
  listPublishedForSitemap.mockImplementation(async (input) => {
    if (input?.limit === 0) {
      return [];
    }
    return entries;
  });

  const repos = {
    events: {
      listPublishedForSitemap,
    },
  } as unknown as Repos;

  const logger = createTestLogger();

  const deps: ListEventSitemapEntriesDeps = {
    repos,
    logger,
  };

  return { deps, logger, listPublishedForSitemap };
};

describe("listEventSitemapEntries", () => {
  it("maps records into serializable payloads and logs the result", async () => {
    const entries: EventSitemapEntryRecord[] = [
      { slug: "alpha", updatedAt: new Date("2024-01-01T00:00:00.000Z") },
      { slug: "beta", updatedAt: null },
    ];
    const context = createDeps(entries);

    const result = await listEventSitemapEntries(context.deps, {});

    expect(context.listPublishedForSitemap).toHaveBeenCalledWith({
      limit: 50000,
      now: expect.any(Date),
    });
    expect(result).toEqual([
      { slug: "alpha", updatedAt: "2024-01-01T00:00:00.000Z" },
      { slug: "beta", updatedAt: null },
    ]);
    expect(context.logger.info).toHaveBeenCalledWith(
      "events.list_sitemap_entries",
      { count: 2 },
    );
  });

  it("forwards custom limit overrides", async () => {
    const entries: EventSitemapEntryRecord[] = [
      { slug: "alpha", updatedAt: null },
    ];
    const context = createDeps(entries);

    await listEventSitemapEntries(context.deps, { limit: 25 });

    expect(context.listPublishedForSitemap).toHaveBeenCalledWith({
      limit: 25,
      now: expect.any(Date),
    });
  });

  it("accepts a limit above the old 2000 cap up to Google's 50k file limit", async () => {
    const context = createDeps([{ slug: "alpha", updatedAt: null }]);

    await expect(
      listEventSitemapEntries(context.deps, { limit: 50000 }),
    ).resolves.toBeDefined();

    expect(context.listPublishedForSitemap).toHaveBeenCalledWith({
      limit: 50000,
      now: expect.any(Date),
    });
  });

  it("passes the current instant so the adapter can drop ended events", async () => {
    const context = createDeps([{ slug: "alpha", updatedAt: null }]);
    const before = Date.now();

    await listEventSitemapEntries(context.deps, {});

    const call = context.listPublishedForSitemap.mock.calls[0]?.[0];
    expect(call?.now).toBeInstanceOf(Date);
    expect(call?.now?.getTime()).toBeGreaterThanOrEqual(before);
    expect(call?.now?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a limit above 50000", async () => {
    const context = createDeps([]);

    await expect(
      listEventSitemapEntries(context.deps, { limit: 50001 }),
    ).rejects.toThrow();
  });

  it("emits null updatedAt when the record has no timestamp", async () => {
    const context = createDeps([{ slug: "alpha", updatedAt: null }]);

    const result = await listEventSitemapEntries(context.deps, {});

    expect(result).toEqual([{ slug: "alpha", updatedAt: null }]);
  });
});
