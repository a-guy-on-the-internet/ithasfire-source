import { describe, expect, it, vi } from "vitest";

import { makeCategoriesRepo } from "../categories";
import { makeEventsRepo } from "../events";
import {
  indexableListedEventWhere,
  publicListedEventWhere,
} from "../public-listed-event-where";

/**
 * The category page's robots rule (`countIndexableByCategory`) and the
 * category sitemap (`listActiveWithUpcomingEvents`) must count the SAME
 * events, or the sitemap advertises category pages that are noindex. Both
 * build from `indexableListedEventWhere`; the parity test below fails if
 * either one grows a rule the other lacks. The listing (`filterByCategory`)
 * is that rule minus the gate: gated events list, they just do not make the
 * page indexable (owner ruling 2026-10-13).
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");

function prismaWith(withheld: Array<{ kind: "HUMAN" | "ORG"; id: string }>) {
  const eventFindMany = vi.fn(async () => []);
  const eventCount = vi.fn(async (_args: unknown) => 0);
  const categoryFindMany = vi.fn(async () => []);
  const $queryRaw = vi.fn(async () => withheld);
  const prisma = {
    event: { findMany: eventFindMany, count: eventCount },
    category: { findMany: categoryFindMany },
    $queryRaw,
  };
  return { prisma, eventFindMany, eventCount, categoryFindMany };
}

describe("publicListedEventWhere", () => {
  it("is PUBLISHED + PUBLIC from the given start, with no withheld owners", async () => {
    const { prisma } = prismaWith([]);

    await expect(
      publicListedEventWhere(prisma as never, { startsAfter: NOW }),
    ).resolves.toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      startsAt: { gte: NOW },
    });
  });

  it("omits the start bound when none is given", async () => {
    const { prisma } = prismaWith([]);

    await expect(publicListedEventWhere(prisma as never)).resolves.toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
    });
  });

  it("adds the withheld-owner clause when someone is withheld", async () => {
    const { prisma } = prismaWith([{ kind: "ORG", id: "banned-org" }]);

    const where = await publicListedEventWhere(prisma as never);

    expect(where).toHaveProperty("AND");
  });
});

describe("indexableListedEventWhere", () => {
  it("is the listing rule plus ungated", async () => {
    const { prisma } = prismaWith([{ kind: "ORG", id: "banned-org" }]);

    const listed = await publicListedEventWhere(prisma as never, {
      startsAfter: NOW,
    });
    const indexable = await indexableListedEventWhere(prisma as never, {
      startsAfter: NOW,
    });

    expect(indexable).toEqual({ ...listed, gateType: "NONE" });
  });
});

const WITHHELD_CASES = [
  ["nobody withheld", []],
  ["a withheld owner", [{ kind: "HUMAN" as const, id: "banned-human" }]],
] as const;

describe("category page indexability and category sitemap count the same events", () => {
  it.each(WITHHELD_CASES)("with %s", async (_label, withheld) => {
    const { prisma, eventCount, categoryFindMany } = prismaWith([...withheld]);

    await makeEventsRepo(prisma as never).countIndexableByCategory({
      categorySlug: "open-mics",
      startsAfter: NOW,
    });
    await makeCategoriesRepo(prisma as never).listActiveWithUpcomingEvents({
      now: NOW,
    });

    const pageWhere = (
      eventCount.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    const sitemapWhere = (
      categoryFindMany.mock.calls[0] as unknown as [
        { where: { events: { some: Record<string, unknown> } } },
      ]
    )[0].where;

    // The page adds only its own category scope on top of the shared rule.
    const { category, ...pageEventRule } = pageWhere;
    expect(category).toEqual({ slug: "open-mics", active: true });
    expect(pageEventRule).toEqual(sitemapWhere.events.some);
    expect(pageEventRule).toHaveProperty("gateType", "NONE");
  });
});

describe("the category listing shows gated events", () => {
  it.each(WITHHELD_CASES)("with %s", async (_label, withheld) => {
    const { prisma, eventFindMany } = prismaWith([...withheld]);

    await makeEventsRepo(prisma as never).filterByCategory({
      categorySlug: "open-mics",
      startsAfter: NOW,
    });

    const listWhere = (
      eventFindMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    const { category, ...listEventRule } = listWhere;
    expect(category).toEqual({ slug: "open-mics", active: true });
    expect(listEventRule).not.toHaveProperty("gateType");
    expect(listEventRule).toEqual(
      await publicListedEventWhere(prisma as never, { startsAfter: NOW }),
    );
  });
});

describe("homepage browse categories count what the category page lists", () => {
  // The homepage offers a category only when its page lists something (owner
  // ruling 2026-10-14). The browse query and the page's listing must apply the
  // same event rule, gated events included, or an offered chip leads to an
  // empty page (or a category with a gated show is hidden from browse).
  it.each(WITHHELD_CASES)("with %s", async (_label, withheld) => {
    const { prisma, eventFindMany, categoryFindMany } = prismaWith([
      ...withheld,
    ]);

    await makeEventsRepo(prisma as never).filterByCategory({
      categorySlug: "open-mics",
      startsAfter: NOW,
    });
    await makeCategoriesRepo(prisma as never).listActiveWithListedEvents({
      now: NOW,
    });

    const listWhere = (
      eventFindMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    const browseWhere = (
      categoryFindMany.mock.calls[0] as unknown as [
        { where: { events: { some: Record<string, unknown> } } },
      ]
    )[0].where;

    const { category, ...listEventRule } = listWhere;
    expect(category).toEqual({ slug: "open-mics", active: true });
    expect(browseWhere.events.some).toEqual(listEventRule);
    expect(browseWhere.events.some).not.toHaveProperty("gateType");
  });
});
