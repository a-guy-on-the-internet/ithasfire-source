import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import { makeFeaturedEventsRepo } from "../featured-events";

/**
 * M5 sweep: every PUBLIC event listing filters `visibility = PUBLIC` in the
 * query (count and page), not just `status = PUBLISHED`. A PRIVATE event is
 * link-only; these lists used to carry it — with its location — to anyone.
 * Anonymous title search additionally drops GATED events (the gate protects
 * the details; the gated preview is title + hero only).
 *
 * Real-Postgres coverage of the same filters:
 * `test/integration/public-event-visibility.test.ts`.
 */

function eventPrisma() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  // The banned-owner lookup (banned-owner.ts); nobody is withheld here.
  const $queryRaw = vi.fn(async () => []);
  return { prisma: { event: { findMany, count }, $queryRaw }, findMany, count };
}

describe("public event listings — PUBLIC only", () => {
  it.each([
    ["filterByCategory", (repo: ReturnType<typeof makeEventsRepo>) =>
      repo.filterByCategory({ categorySlug: "music" })],
    ["listPublishedByRegion", (repo: ReturnType<typeof makeEventsRepo>) =>
      repo.listPublishedByRegion({ regionCode: "us-tn" })],
    ["listPublishedByCountry", (repo: ReturnType<typeof makeEventsRepo>) =>
      repo.listPublishedByCountry({ countryCode: "US" })],
  ] as const)("%s filters PUBLISHED + PUBLIC in the page AND the count", async (_name, call) => {
    const { prisma, findMany, count } = eventPrisma();
    await call(makeEventsRepo(prisma as never));
    const where = (findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(where).toMatchObject({ status: "PUBLISHED", visibility: "PUBLIC" });
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("listPublished: PUBLIC only when asked (the global discover feed), every visibility by default (the indexer)", async () => {
    const asked = eventPrisma();
    await makeEventsRepo(asked.prisma as never).listPublished({
      limit: 10,
      visibility: ["PUBLIC"],
    });
    const askedWhere = (asked.findMany.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    expect(askedWhere).toMatchObject({
      status: "PUBLISHED",
      visibility: { in: ["PUBLIC"] },
    });
    expect(asked.count).toHaveBeenCalledWith({ where: askedWhere });

    const indexer = eventPrisma();
    await makeEventsRepo(indexer.prisma as never).listPublished({ limit: 10 });
    const indexerWhere = (indexer.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ])[0].where;
    expect(indexerWhere).toEqual({ status: "PUBLISHED" });
    // The indexer does not opt into the banned-owner filter.
    expect(indexer.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("searchPublished (anonymous title search) is PUBLISHED + PUBLIC + UNGATED", async () => {
    const { prisma, findMany } = eventPrisma();
    await makeEventsRepo(prisma as never).searchPublished({ query: "jazz" });
    const where = (findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(where).toMatchObject({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      gateType: "NONE",
    });
  });

  it("the featured rail drops an event made PRIVATE after it was featured", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeFeaturedEventsRepo({
      featuredEvent: { findMany },
      $queryRaw: vi.fn(async () => []),
    } as never);
    await repo.listActive({ now: new Date("2026-09-25"), limit: 8 });
    const where = (findMany.mock.calls[0] as unknown as [{ where: { event: unknown } }])[0]
      .where;
    expect(where.event).toMatchObject({ status: "PUBLISHED", visibility: "PUBLIC" });
  });
});
