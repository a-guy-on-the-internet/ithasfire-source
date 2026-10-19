import { describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { createTestLogger } from "@th/test-utils";
import { categoriesRouter } from "../categories";

// `categories.listBrowsable` feeds the homepage's browse entry points (owner
// ruling 2026-10-14: offer only categories that have something). It must read
// the browse rule with the request's clock, need no sign-in, and leave
// `categories.list` (pickers, facets) on the plain active list.

const NOW = new Date("2026-10-14T12:00:00.000Z");

const row = (slug: string, sortOrder: number) => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  active: true,
  sortOrder,
  seoType: "Event",
});
const withNames = (r: ReturnType<typeof row>) => ({
  ...r,
  names: { en: r.name },
  slugs: { en: r.slug },
});

const buildCtx = () => {
  const categories = {
    listActive: vi.fn(async () => [row("music", 1), row("open-mics", 9)]),
    listActiveWithListedEvents: vi.fn(async () => [row("open-mics", 9)]),
    listActiveWithUpcomingEvents: vi.fn(async () => []),
    listCurrentSlugs: vi.fn(async () => []),
  };
  const ctx = {
    repos: { categories } as unknown as Ctx["repos"],
    clock: { now: () => NOW } as Ctx["clock"],
    logger: createTestLogger(),
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"],
    actorHumanId: null,
    auth: null,
    authToken: null,
    apiKey: null,
  } as unknown as Ctx;
  return { ctx, categories };
};

const callerFor = (ctx: Ctx) =>
  trpcRouter({ categories: router(categoriesRouter) }).createCaller(ctx);

describe("categories.listBrowsable", () => {
  it("returns only categories with something listed, for an anonymous caller, at the request clock's now", async () => {
    const { ctx, categories } = buildCtx();

    await expect(callerFor(ctx).categories.listBrowsable()).resolves.toEqual({
      categories: [withNames(row("open-mics", 9))],
    });
    expect(categories.listActiveWithListedEvents).toHaveBeenCalledWith({
      now: NOW,
    });
    expect(categories.listActive).not.toHaveBeenCalled();
  });

  it("leaves categories.list on every active category", async () => {
    const { ctx, categories } = buildCtx();

    const result = await callerFor(ctx).categories.list();

    expect(result.categories.map((c) => c.slug)).toEqual([
      "music",
      "open-mics",
    ]);
    expect(categories.listActiveWithListedEvents).not.toHaveBeenCalled();
  });
});
