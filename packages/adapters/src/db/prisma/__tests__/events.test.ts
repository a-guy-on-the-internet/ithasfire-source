import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { encodeGeohash } from "@th/core/lib/geo/geohash";
import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

vi.mock("@th/core/lib/geo", () => ({
  encodeGeohash: vi.fn(),
}));

const DEFAULT_EVENT = {
  id: "event-1",
  orgId: "org-1",
  humanId: null,
  title: "Launch Party",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  startsAt: new Date("2025-01-01T12:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: "cat-1",
  addressText: null,
  countryCode: "US",
  region: "CA",
  locality: "San Francisco",
  postalCode: "94103",
  lat: null,
  lng: null,
  slug: "acme/us/sf/launch-party-2025-01-01-1200--abc123",
  shortId: "abc123",
  regionCode: "ca",
  publishedAt: new Date("2025-01-02T00:00:00.000Z"),
  agreementPrimaryId: "agreement-primary",
  agreementResaleId: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  createdAt: new Date("2024-12-15T00:00:00.000Z"),
  updatedAt: new Date("2024-12-20T00:00:00.000Z"),
} as const;

const createPrisma = () => {
  const update = vi.fn();
  const updateMany = vi.fn();
  const findUnique = vi.fn();
  const findFirst = vi.fn();
  const findMany = vi.fn();
  const count = vi.fn();
  const deleteMany = vi.fn();
  const slugHistoryCreate = vi.fn();
  const slugHistoryCreateMany = vi.fn();
  const slugHistoryFindFirst = vi.fn();

  const prisma = {
    event: {
      update,
      updateMany,
      findUnique,
      findFirst,
      findMany,
      count,
      deleteMany,
    },
    eventSlugHistory: {
      create: slugHistoryCreate,
      createMany: slugHistoryCreateMany,
      findFirst: slugHistoryFindFirst,
    },
    // The withheld-owner lookup (banned-owner.ts): nobody banned, so public
    // list reads carry no extra filter.
    $queryRaw: vi.fn(async () => []),
  } as unknown as PrismaClientOrTx;

  return {
    prisma,
    update,
    updateMany,
    findUnique,
    findFirst,
    findMany,
    count,
    deleteMany,
    slugHistoryCreate,
    slugHistoryCreateMany,
    slugHistoryFindFirst,
  };
};

describe("makeEventsRepo deletion lifecycle guards", () => {
  it("conditionally deletes only never-published draft events without attestations", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(repo.delete({ eventId: DEFAULT_EVENT.id })).resolves.toBe(
      true,
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: DEFAULT_EVENT.id,
        status: "DRAFT",
        publishedAt: null,
        currentAttestationId: null,
        attestations: { none: {} },
      },
    });
  });

  it("returns false when the conditional delete does not match", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(repo.delete({ eventId: DEFAULT_EVENT.id })).resolves.toBe(
      false,
    );
  });

  it("returns false when a concurrent child insert blocks deletion", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    deleteMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
        code: "P2003",
        clientVersion: "test",
      }),
    );

    await expect(repo.delete({ eventId: DEFAULT_EVENT.id })).resolves.toBe(
      false,
    );
  });
});

describe("makeEventsRepo slug support", () => {
  it("assigns slug metadata and returns updated event", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    update.mockResolvedValue({
      ...DEFAULT_EVENT,
      slug: "acme/us/sf/launch-party-2025-01-01-1200--zzz999",
      shortId: "zzz999",
      regionCode: "us-ca",
    });

    const updated = await repo.assignSlug({
      eventId: DEFAULT_EVENT.id,
      slug: "acme/us/sf/launch-party-2025-01-01-1200--zzz999",
      shortId: "zzz999",
      regionCode: "us-ca",
      assignedAt: new Date("2025-01-01T12:00:00.000Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: {
        slug: "acme/us/sf/launch-party-2025-01-01-1200--zzz999",
        shortId: "zzz999",
        regionCode: "us-ca",
      },
      select: expect.any(Object),
    });

    expect(updated.slug).toBe(
      "acme/us/sf/launch-party-2025-01-01-1200--zzz999",
    );
    expect(updated.shortId).toBe("zzz999");
    expect(updated.regionCode).toBe("us-ca");
  });

  it("updates existing slug and returns mapped event", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    update.mockResolvedValue({
      ...DEFAULT_EVENT,
      slug: "acme/us/sf/launch-party-2025-01-01-1200--new123",
      regionCode: "us-ca",
    });

    const updated = await repo.updateSlug({
      eventId: DEFAULT_EVENT.id,
      slug: "acme/us/sf/launch-party-2025-01-01-1200--new123",
      regionCode: "us-ca",
      updatedAt: new Date("2025-01-03T00:00:00.000Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: {
        slug: "acme/us/sf/launch-party-2025-01-01-1200--new123",
        regionCode: "us-ca",
      },
      select: expect.any(Object),
    });

    expect(updated.slug).toBe(
      "acme/us/sf/launch-party-2025-01-01-1200--new123",
    );
  });

  it("records slug history entries, tolerating a duplicate", async () => {
    // `createMany({ skipDuplicates: true })` for one row, not `create`.
    // `EventSlugHistory.slug` is GLOBALLY unique and an ordinary rename
    // flip-flop can put a slug back in play, so filing it twice is a real
    // sequence with nothing to fix — the existing row already says exactly
    // what we were about to say.
    //
    // It also matters structurally: a statement that fails at the database
    // aborts the enclosing Postgres transaction, and the COMMIT that follows
    // is answered with ROLLBACK and no error. A P2002 raised from inside a
    // caller's transaction can therefore silently discard everything else
    // that transaction did. Not raising it is the sturdiest fix available.
    const { prisma, slugHistoryCreateMany, slugHistoryCreate } = createPrisma();
    const repo = makeEventsRepo(prisma);

    slugHistoryCreateMany.mockResolvedValue({ count: 1 });

    const recordedAt = new Date("2025-01-02T12:00:00.000Z");
    await repo.recordSlugHistory({
      eventId: DEFAULT_EVENT.id,
      slug: DEFAULT_EVENT.slug!,
      recordedAt,
    });

    expect(slugHistoryCreateMany).toHaveBeenCalledWith({
      data: [
        {
          eventId: DEFAULT_EVENT.id,
          slug: DEFAULT_EVENT.slug,
          recordedAt,
        },
      ],
      skipDuplicates: true,
    });
    // Never the plain create — that is the variant that throws.
    expect(slugHistoryCreate).not.toHaveBeenCalled();
  });

  it("does not throw when the history row already exists", async () => {
    const { prisma, slugHistoryCreateMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    // What `skipDuplicates` looks like from here: no error, count 0.
    slugHistoryCreateMany.mockResolvedValue({ count: 0 });

    await expect(
      repo.recordSlugHistory({
        eventId: DEFAULT_EVENT.id,
        slug: DEFAULT_EVENT.slug!,
        recordedAt: new Date("2025-01-02T12:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves current slugs without redirect", async () => {
    const { prisma, findFirst } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findFirst.mockResolvedValueOnce({
      id: DEFAULT_EVENT.id,
      slug: DEFAULT_EVENT.slug,
    });

    const resolution = await repo.resolveBySlug(DEFAULT_EVENT.slug!);

    expect(resolution).toEqual({
      eventId: DEFAULT_EVENT.id,
      currentSlug: DEFAULT_EVENT.slug,
      redirect: false,
    });
  });

  it("resolves historical slugs with redirect", async () => {
    const { prisma, findFirst, slugHistoryFindFirst } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findFirst.mockResolvedValueOnce(null);
    slugHistoryFindFirst.mockResolvedValueOnce({
      eventId: DEFAULT_EVENT.id,
      event: { slug: DEFAULT_EVENT.slug },
    });

    const priorSlug = "acme/us/sf/launch-party-2024-12-30-2000--abc123";
    const resolution = await repo.resolveBySlug(priorSlug);

    expect(slugHistoryFindFirst).toHaveBeenCalledWith({
      where: { slug: priorSlug },
      select: {
        eventId: true,
        event: {
          select: {
            slug: true,
          },
        },
      },
    });

    expect(resolution).toEqual({
      eventId: DEFAULT_EVENT.id,
      currentSlug: DEFAULT_EVENT.slug,
      redirect: true,
    });
  });

  it("resolves a short ID by its unique index to the current slug", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findUnique.mockResolvedValueOnce({
      id: DEFAULT_EVENT.id,
      slug: DEFAULT_EVENT.slug,
    });

    const resolution = await repo.resolveByShortId("wqsdk6pxzi");

    expect(findUnique).toHaveBeenCalledWith({
      where: { shortId: "wqsdk6pxzi" },
      select: { id: true, slug: true },
    });
    expect(resolution).toEqual({
      eventId: DEFAULT_EVENT.id,
      currentSlug: DEFAULT_EVENT.slug,
    });
  });

  it("resolves a short ID to null when unknown or the event has no slug", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findUnique.mockResolvedValueOnce(null);
    await expect(repo.resolveByShortId("zzzzzzzzzz")).resolves.toBeNull();

    findUnique.mockResolvedValueOnce({ id: DEFAULT_EVENT.id, slug: null });
    await expect(repo.resolveByShortId("wqsdk6pxzi")).resolves.toBeNull();
  });

  it("builds slug context with place fallbacks", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const startsAt = new Date("2025-01-01T12:00:00.000Z");
    findUnique.mockResolvedValueOnce({
      id: DEFAULT_EVENT.id,
      orgId: DEFAULT_EVENT.orgId,
      humanId: null,
      title: DEFAULT_EVENT.title,
      startsAt,
      timezone: "America/Los_Angeles",
      shortId: DEFAULT_EVENT.shortId,
      countryCode: null,
      region: null,
      locality: null,
      org: { name: "Acme Events" },
      human: null,
      place: {
        city: "San Francisco",
        region: "CA",
        country: "US",
      },
      savedLocation: null,
    });

    const context = await repo.getSlugContext(DEFAULT_EVENT.id);

    // The slug's date segment is formatted in this zone, so the read must
    // select it.
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ timezone: true }),
      }),
    );
    expect(context).toEqual({
      eventId: DEFAULT_EVENT.id,
      orgId: DEFAULT_EVENT.orgId,
      humanId: null,
      eventTitle: DEFAULT_EVENT.title,
      startsAt,
      timezone: "America/Los_Angeles",
      orgName: "Acme Events",
      countryCode: "US",
      regionCode: "CA",
      cityOrRegionCode: "San Francisco",
      shortId: DEFAULT_EVENT.shortId,
    });
  });

  it("returns null when slug context event missing", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findUnique.mockResolvedValueOnce(null);

    const context = await repo.getSlugContext("missing-event");
    expect(context).toBeNull();
  });

  it("listSluggedPage pages slugged events of every status by id keyset", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    const startsAt = new Date("2026-10-13T00:00:00.000Z");
    const createdAt = new Date("2026-09-01T12:00:00.000Z");

    findMany.mockResolvedValueOnce([
      {
        id: "event-2",
        slug: "acme/us/tn/show-2026-10-13-0000--abc123",
        startsAt,
        timezone: "America/Chicago",
        status: "ARCHIVED",
        createdAt,
      },
    ]);

    const rows = await repo.listSluggedPage({ afterId: "event-1", limit: 50 });

    expect(findMany).toHaveBeenCalledWith({
      // No status filter: archived, cancelled and past events keep old links.
      where: { slug: { not: null }, id: { gt: "event-1" } },
      orderBy: { id: "asc" },
      take: 50,
      select: {
        id: true,
        slug: true,
        startsAt: true,
        timezone: true,
        status: true,
        createdAt: true,
      },
    });
    expect(rows).toEqual([
      {
        id: "event-2",
        slug: "acme/us/tn/show-2026-10-13-0000--abc123",
        startsAt,
        timezone: "America/Chicago",
        status: "ARCHIVED",
        createdAt,
      },
    ]);
  });

  it("getSlugDateRow selects only the slug-date columns", async () => {
    // Narrow on purpose: the backfill runs against prod while its `Event`
    // table is behind the Prisma schema, where the full select fails.
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);
    const startsAt = new Date("2026-10-13T00:00:00.000Z");
    const createdAt = new Date("2026-09-01T12:00:00.000Z");
    const row = {
      id: "event-2",
      slug: "acme/us/tn/show-2026-10-13-0000--abc123",
      startsAt,
      timezone: "America/Chicago",
      status: "PUBLISHED",
      createdAt,
    };
    findUnique.mockResolvedValueOnce(row);

    await expect(repo.getSlugDateRow("event-2")).resolves.toEqual(row);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "event-2" },
      select: {
        id: true,
        slug: true,
        startsAt: true,
        timezone: true,
        status: true,
        createdAt: true,
      },
    });
  });

  it("getSlugDateRow is null for a missing or unslugged event", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);
    findUnique.mockResolvedValueOnce(null);
    await expect(repo.getSlugDateRow("missing")).resolves.toBeNull();
    findUnique.mockResolvedValueOnce({ id: "event-3", slug: null });
    await expect(repo.getSlugDateRow("event-3")).resolves.toBeNull();
  });

  it("setSlugOnly writes only the slug and reads back only the id", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);
    update.mockResolvedValueOnce({ id: "event-2" });

    await repo.setSlugOnly({ eventId: "event-2", slug: "a/us/tn/x-2026-10-12-1900--abc123" });

    expect(update).toHaveBeenCalledWith({
      where: { id: "event-2" },
      data: { slug: "a/us/tn/x-2026-10-12-1900--abc123" },
      select: { id: true },
    });
  });

  it("setSlugOnly maps a slug collision to conflict", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "test",
    });
    update.mockRejectedValueOnce(p2002);

    await expect(
      repo.setSlugOnly({ eventId: "event-2", slug: "taken" }),
    ).rejects.toMatchObject({ code: "conflict", cause: p2002 });
  });

  it("listSluggedPage starts from the first id when afterId is null", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    findMany.mockResolvedValueOnce([]);

    await repo.listSluggedPage({ afterId: null, limit: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: { not: null } }, take: 10 }),
    );
  });
});

describe("makeEventsRepo content support", () => {
  it("returns null when content is missing", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findUnique.mockResolvedValue({ body: null });

    const content = await repo.getContent({ eventId: DEFAULT_EVENT.id });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      select: { body: true },
    });
    expect(content).toBeNull();
  });

  it("returns content JSON when present", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const content = {
      version: 1,
      blocks: [],
    };

    findUnique.mockResolvedValue({ body: content });

    const result = await repo.getContent({ eventId: DEFAULT_EVENT.id });
    expect(result).toEqual(content);
  });

  it("updates content and returns mapped event", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const content = {
      version: 1,
      blocks: [{ kind: "richText", doc: { type: "doc", content: [] } }],
    };

    update.mockResolvedValue({
      ...DEFAULT_EVENT,
      body: content,
    });

    const updated = await repo.updateContent({
      eventId: DEFAULT_EVENT.id,
      content: content as any,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: { body: content },
      select: expect.any(Object),
    });

    expect(updated.content).toEqual(content);
  });
});

describe("makeEventsRepo listByOwner", () => {
  it("applies a case-insensitive query filter on title, addressText (EXACT events only), and place name", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(1);
    findMany.mockResolvedValueOnce([DEFAULT_EVENT]);

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      status: ["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"],
      query: "  launch  ",
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      orgId: "org-1",
      status: {
        in: ["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"],
      },
      OR: [
        { title: { contains: "launch", mode: "insensitive" } },
        // A freeform OBSCURED row holds the TRUE street; matching it would
        // let any org role (a SCANNER) probe the street by inclusion.
        {
          AND: [
            { locationMode: "EXACT" },
            { addressText: { contains: "launch", mode: "insensitive" } },
          ],
        },
        { place: { name: { contains: "launch", mode: "insensitive" } } },
      ],
    });
    // The SAME where object backs the count — a searched listing must report
    // a filtered total, or the pager's range label lies about the dataset.
    expect(count).toHaveBeenCalledWith({ where });
    expect(count.mock.calls[0][0].where).toBe(where);
  });

  it("matches a place-linked event by venue name when addressText is null", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    // Exactly the shape the admin table renders as "Friday Night / 📍 The
    // Basement": placeId alone satisfies the publish location gate, so
    // addressText stays null and the title never contains the venue name.
    const placeLinkedEvent = {
      ...DEFAULT_EVENT,
      id: "event-place",
      title: "Friday Night",
      addressText: null,
      placeId: "place-1",
    };
    count.mockResolvedValueOnce(1);
    findMany.mockResolvedValueOnce([placeLinkedEvent]);

    const result = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      query: "basement",
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({
      place: { name: { contains: "basement", mode: "insensitive" } },
    });
    expect(result.items[0]?.id).toBe("event-place");
    expect(result.pageInfo.total).toBe(1);
  });

  it("includes draft events when the status filter spans DRAFT", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const draftEvent = { ...DEFAULT_EVENT, id: "event-draft", status: "DRAFT" };
    count.mockResolvedValueOnce(1);
    findMany.mockResolvedValueOnce([draftEvent]);

    const result = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      status: ["DRAFT", "PUBLISHED"],
    });

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ["DRAFT", "PUBLISHED"] },
    });
    expect(result.items[0]?.status).toBe("DRAFT");
  });

  it("omits the OR clause when no query is provided", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(0);
    findMany.mockResolvedValueOnce([]);

    await repo.listByOwner({ ownerType: "HUMAN", ownerId: "human-1" });

    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ humanId: "human-1" });
    expect(where.OR).toBeUndefined();
  });

  it("omits the facet filters entirely when dateRange and categoryIds are absent", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(0);
    findMany.mockResolvedValueOnce([]);

    await repo.listByOwner({ ownerType: "ORGANIZATION", ownerId: "org-1" });

    const where = findMany.mock.calls[0][0].where;
    expect(where.startsAt).toBeUndefined();
    expect(where.categoryId).toBeUndefined();
  });

  it("composes an inclusive startsAt range as a top-level conjunct beside the query OR", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");

    count.mockResolvedValueOnce(1);
    findMany.mockResolvedValueOnce([DEFAULT_EVENT]);

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      query: "launch",
      dateRange: { from, to },
    });

    const where = findMany.mock.calls[0][0].where;
    // Inclusive bounds, and NOT folded into the text OR — a facet must narrow
    // the search, not widen it.
    expect(where.startsAt).toEqual({ gte: from, lte: to });
    expect(where.OR).toHaveLength(3);
    expect(JSON.stringify(where.OR)).not.toContain("startsAt");
    // The same where object still backs the count.
    expect(count.mock.calls[0][0].where).toBe(where);
  });

  it("emits an open-ended startsAt filter when only one bound is given", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const from = new Date("2026-01-01T00:00:00.000Z");

    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      dateRange: { from },
    });
    expect(findMany.mock.calls[0][0].where.startsAt).toEqual({ gte: from });

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      dateRange: { to: from },
    });
    expect(findMany.mock.calls[1][0].where.startsAt).toEqual({ lte: from });
  });

  it("omits the startsAt filter when dateRange carries neither bound", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(0);
    findMany.mockResolvedValueOnce([]);

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      dateRange: {},
    });

    // An empty range is "no filter", never `startsAt: {}`.
    expect(findMany.mock.calls[0][0].where.startsAt).toBeUndefined();
  });

  it("filters by categoryIds with an IN clause, and ignores an empty array", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      categoryIds: ["cat-1", "cat-2"],
    });
    expect(findMany.mock.calls[0][0].where.categoryId).toEqual({
      in: ["cat-1", "cat-2"],
    });

    await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      categoryIds: [],
    });
    // Empty means "no filter", never "match nothing".
    expect(findMany.mock.calls[1][0].where.categoryId).toBeUndefined();
  });

  /**
   * The four rows of the category truth table, in one place.
   *
   * `Event.categoryId` is NULLABLE and SQL `IN` never matches NULL, so
   * `categoryIds` alone can never reach an uncategorised event — no id exists
   * that would bring them back. `includeUncategorised` is the separate flag
   * that widens the clause, and the LONE-FLAG row is the one this whole
   * feature exists for: it must emit `categoryId IS NULL`, not `{}`.
   */
  describe("category + includeUncategorised", () => {
    it("row 1: emits NO category filter when neither is set", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      count.mockResolvedValueOnce(0);
      findMany.mockResolvedValueOnce([]);

      await repo.listByOwner({ ownerType: "ORGANIZATION", ownerId: "org-1" });

      const where = findMany.mock.calls[0][0].where;
      expect("categoryId" in where).toBe(false);
      expect(where.AND).toBeUndefined();
    });

    it("row 2: emits a bare IN clause for ids without the flag", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      count.mockResolvedValue(0);
      findMany.mockResolvedValue([]);

      await repo.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        categoryIds: ["cat-1", "cat-2"],
      });
      expect(findMany.mock.calls[0][0].where.categoryId).toEqual({
        in: ["cat-1", "cat-2"],
      });
      // Unchanged behaviour: a single arm is NOT wrapped in a pointless OR.
      expect(findMany.mock.calls[0][0].where.AND).toBeUndefined();

      // Explicit `false` is the same as absent — a boolean has no "empty"
      // second spelling to keep apart, unlike the `.nonempty()` arrays.
      await repo.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        categoryIds: ["cat-1", "cat-2"],
        includeUncategorised: false,
      });
      expect(findMany.mock.calls[1][0].where).toEqual(
        findMany.mock.calls[0][0].where,
      );
    });

    it("row 3: ORs the IS NULL arm alongside the IN clause when both are set", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      count.mockResolvedValueOnce(0);
      findMany.mockResolvedValueOnce([]);

      await repo.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        categoryIds: ["cat-1", "cat-2"],
        includeUncategorised: true,
      });

      const where = findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [{ categoryId: { in: ["cat-1", "cat-2"] } }, { categoryId: null }],
        },
      ]);
      // The category OR must NOT land on the top-level `OR` key — that key
      // belongs to the text search, and a spread would overwrite one with the
      // other rather than ANDing them.
      expect(where.OR).toBeUndefined();
      expect(where.categoryId).toBeUndefined();
    });

    /**
     * THE regression this task exists to prevent. A lone "Uncategorised" is a
     * real filter ("what still needs categorising?"), not a no-op — if the
     * adapter emits `{}` here, the option silently means "everything".
     */
    it("row 4: emits categoryId IS NULL and NO IN clause for the flag alone", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      count.mockResolvedValueOnce(0);
      findMany.mockResolvedValueOnce([]);

      await repo.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        includeUncategorised: true,
      });

      const where = findMany.mock.calls[0][0].where;
      // Present AND null — `toBeUndefined()` would pass on a missing key,
      // which is exactly the defect.
      expect("categoryId" in where).toBe(true);
      expect(where.categoryId).toBeNull();
      expect(where.AND).toBeUndefined();
      // The same where object still backs the count, or the total lies.
      expect(count.mock.calls[0][0].where).toBe(where);
    });

    it("row 4 still applies when categoryIds is present but EMPTY", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      count.mockResolvedValueOnce(0);
      findMany.mockResolvedValueOnce([]);

      await repo.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        categoryIds: [],
        includeUncategorised: true,
      });

      const where = findMany.mock.calls[0][0].where;
      expect(where.categoryId).toBeNull();
      expect(where.AND).toBeUndefined();
    });

    /**
     * The composition hazard the OR nesting exists for: with a text query the
     * top-level `OR` is the title/address/place search. The category arms must
     * NARROW that, never join or replace it.
     */
    it("keeps the text-search OR intact when the uncategorised arm is on", async () => {
      const { prisma, findMany, count } = createPrisma();
      const repo = makeEventsRepo(prisma);

      const from = new Date("2026-03-01T00:00:00.000Z");
      count.mockResolvedValueOnce(0);
      findMany.mockResolvedValueOnce([]);

      await repo.listByOwner({
        ownerType: "HUMAN",
        ownerId: "human-1",
        status: ["DRAFT"],
        query: "launch",
        dateRange: { from },
        categoryIds: ["cat-1"],
        includeUncategorised: true,
      });

      const where = findMany.mock.calls[0][0].where;
      // Every sibling facet survives untouched…
      expect(where).toMatchObject({
        humanId: "human-1",
        status: { in: ["DRAFT"] },
        startsAt: { gte: from },
      });
      // …and the text OR is still exactly the three text arms.
      expect(where.OR).toHaveLength(3);
      expect(JSON.stringify(where.OR)).not.toContain("categoryId");
      expect(where.AND).toEqual([
        { OR: [{ categoryId: { in: ["cat-1"] } }, { categoryId: null }] },
      ]);
    });
  });

  it("composes status, query, dateRange, and categoryIds together without collision", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const from = new Date("2026-03-01T00:00:00.000Z");

    count.mockResolvedValueOnce(0);
    findMany.mockResolvedValueOnce([]);

    await repo.listByOwner({
      ownerType: "HUMAN",
      ownerId: "human-1",
      status: ["DRAFT"],
      query: "launch",
      dateRange: { from },
      categoryIds: ["cat-1"],
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      humanId: "human-1",
      status: { in: ["DRAFT"] },
      startsAt: { gte: from },
      categoryId: { in: ["cat-1"] },
    });
    expect(where.OR).toHaveLength(3);
  });
});

describe("makeEventsRepo listPublishedByOrg", () => {
  const FROM = new Date("2026-01-01T00:00:00.000Z");
  const TO = new Date("2031-01-01T00:00:00.000Z");

  it("filters to PUBLISHED + PUBLIC org events in the window, soonest-first", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(1);
    findMany.mockResolvedValueOnce([DEFAULT_EVENT]);

    const result = await repo.listPublishedByOrg({
      orgId: "org-1",
      from: FROM,
      to: TO,
      status: "upcoming",
      limit: 8,
      offset: 0,
    });

    const call = findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      orgId: "org-1",
      startsAt: { gte: FROM, lte: TO },
    });
    // Upcoming → chronological ascending.
    expect(call.orderBy).toEqual([
      { startsAt: "asc" },
      { createdAt: "asc" },
    ]);
    expect(count).toHaveBeenCalledWith({ where: call.where });
    expect(result.items[0]?.id).toBe(DEFAULT_EVENT.id);
  });

  it("orders past org events newest-first", async () => {
    const { prisma, findMany, count } = createPrisma();
    const repo = makeEventsRepo(prisma);

    count.mockResolvedValueOnce(0);
    findMany.mockResolvedValueOnce([]);

    await repo.listPublishedByOrg({
      orgId: "org-1",
      from: FROM,
      to: TO,
      status: "past",
    });

    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { startsAt: "desc" },
      { createdAt: "desc" },
    ]);
  });
});

describe("makeEventsRepo sitemap support", () => {
  it("lists published events with bounded limit", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const firstUpdatedAt = new Date("2024-10-01T00:00:00.000Z");
    const secondUpdatedAt = new Date("2024-09-15T00:00:00.000Z");

    findMany.mockResolvedValueOnce([
      { slug: "event-a", updatedAt: firstUpdatedAt },
      { slug: null, updatedAt: firstUpdatedAt },
      { slug: "event-b", updatedAt: secondUpdatedAt },
    ]);

    const now = new Date("2026-01-01T00:00:00.000Z");
    const results = await repo.listPublishedForSitemap({ limit: 5000, now });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        slug: { not: null },
        endsAt: { gte: now },
        gateType: "NONE",
      },
      orderBy: { updatedAt: "desc" },
      take: 5000,
      select: {
        slug: true,
        updatedAt: true,
      },
    });

    expect(results).toEqual([
      { slug: "event-a", updatedAt: firstUpdatedAt },
      { slug: "event-b", updatedAt: secondUpdatedAt },
    ]);
  });

  it("filters out events that have already ended via an endsAt >= now bound", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const now = new Date("2026-07-05T00:00:00.000Z");
    // The DB applies the WHERE; the mock only returns the survivors. What we
    // assert here is that the adapter builds the correct "not yet ended" bound
    // from the caller-supplied `now`, so ended events never reach the sitemap.
    findMany.mockResolvedValueOnce([
      { slug: "upcoming-event", updatedAt: now },
    ]);

    const results = await repo.listPublishedForSitemap({ now });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ endsAt: { gte: now } });
    expect(results).toEqual([{ slug: "upcoming-event", updatedAt: now }]);
  });

  it("falls back to default limit when none provided", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const updatedAt = new Date("2024-08-10T00:00:00.000Z");
    findMany.mockResolvedValueOnce([{ slug: "event-a", updatedAt }]);

    await repo.listPublishedForSitemap();

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        slug: { not: null },
        endsAt: { gte: expect.any(Date) },
        gateType: "NONE",
      },
      orderBy: { updatedAt: "desc" },
      take: 50000,
      select: {
        slug: true,
        updatedAt: true,
      },
    });
  });
});

describe("makeEventsRepo access controls", () => {
  it("updates visibility", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    update.mockResolvedValueOnce({ ...DEFAULT_EVENT, visibility: "PRIVATE" });

    const result = await repo.updateVisibility({
      eventId: DEFAULT_EVENT.id,
      visibility: "PRIVATE",
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: expect.objectContaining({ visibility: "PRIVATE" }),
      select: expect.any(Object),
    });

    expect(result.visibility).toBe("PRIVATE");
  });

  it("updates gate type", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    update.mockResolvedValueOnce({ ...DEFAULT_EVENT, gateType: "PASSWORD" });

    const result = await repo.updateGateType({
      eventId: DEFAULT_EVENT.id,
      gateType: "PASSWORD",
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: expect.objectContaining({ gateType: "PASSWORD" }),
      select: expect.any(Object),
    });

    expect(result.gateType).toBe("PASSWORD");
  });

  it("updates password metadata", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const passwordUpdatedAt = new Date("2025-01-05T00:00:00.000Z");
    update.mockResolvedValueOnce({
      ...DEFAULT_EVENT,
      passwordHash: "hashed-secret",
      passwordUpdatedAt,
    });

    const result = await repo.updatePassword({
      eventId: DEFAULT_EVENT.id,
      passwordHash: "hashed-secret",
      passwordUpdatedAt,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: expect.objectContaining({
        passwordHash: "hashed-secret",
        passwordUpdatedAt,
      }),
      select: expect.any(Object),
    });

    expect(result.passwordHash).toBe("hashed-secret");
    expect(result.passwordUpdatedAt).toBe(passwordUpdatedAt);
  });

  it("updates waitlist settings", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const publishAt = new Date("2025-01-10T00:00:00.000Z");
    update.mockResolvedValueOnce({
      ...DEFAULT_EVENT,
      waitlistStatus: "OPEN",
      waitlistPublishAt: publishAt,
      waitlistDescription: "First come, first served",
      waitlistCap: 100,
    });

    const result = await repo.updateWaitlistSettings({
      eventId: DEFAULT_EVENT.id,
      status: "OPEN",
      publishAt,
      description: "First come, first served",
      cap: 100,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      data: expect.objectContaining({
        waitlistStatus: "OPEN",
        waitlistPublishAt: publishAt,
        waitlistDescription: "First come, first served",
        waitlistCap: 100,
      }),
      select: expect.any(Object),
    });

    expect(result.waitlistStatus).toBe("OPEN");
    expect(result.waitlistCap).toBe(100);
  });

  it("retrieves gate settings snapshot", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    const gateRecord = {
      id: DEFAULT_EVENT.id,
      visibility: "PRIVATE",
      gateType: "PASSWORD",
      passwordHash: "hashed-secret",
      passwordUpdatedAt: new Date("2025-01-05T00:00:00.000Z"),
      waitlistStatus: "SCHEDULED",
      waitlistPublishAt: new Date("2025-01-08T00:00:00.000Z"),
      waitlistDescription: "Opens Friday",
      waitlistCap: 42,
    };

    findUnique.mockResolvedValueOnce(gateRecord);

    const settings = await repo.getGateSettings(DEFAULT_EVENT.id);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      select: expect.objectContaining({ visibility: true }),
    });

    expect(settings).toEqual({
      eventId: DEFAULT_EVENT.id,
      visibility: "PRIVATE",
      gateType: "PASSWORD",
      passwordHash: "hashed-secret",
      passwordUpdatedAt: gateRecord.passwordUpdatedAt,
      waitlistStatus: "SCHEDULED",
      waitlistPublishAt: gateRecord.waitlistPublishAt,
      waitlistDescription: "Opens Friday",
      waitlistCap: 42,
      waitlistEmailEnabled: false,
      waitlistEmailSubject: null,
      waitlistEmailBody: null,
    });
  });

  it("returns null for missing gate settings", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventsRepo(prisma);

    findUnique.mockResolvedValueOnce(null);

    const settings = await repo.getGateSettings("missing-event");
    expect(settings).toBeNull();
  });
});

describe("makeEventsRepo createCommunityListing", () => {
  it("writes the FR-005 contract explicitly: ownerless, RSVP+COMMUNITY, PUBLISHED, PUBLIC, ungated", async () => {
    const create = vi.fn().mockResolvedValue({
      ...DEFAULT_EVENT,
      orgId: null,
      humanId: null,
      attendanceMode: "RSVP",
      stewardship: "COMMUNITY",
    });
    const prisma = { event: { create } } as unknown as PrismaClientOrTx;
    const repo = makeEventsRepo(prisma);

    await repo.createCommunityListing({
      title: "Weekly Open Mic",
      startsAt: new Date("2026-08-01T20:00:00.000Z"),
      endsAt: new Date("2026-08-01T23:00:00.000Z"),
      timezone: "America/Chicago",
      addressText: "123 Main St",
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
      geohash6: "9v6kpz",
      slug: "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123",
      shortId: "abc123",
      attendanceMode: "RSVP",
      stewardship: "COMMUNITY",
      status: "PUBLISHED",
      publishedAt: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: null,
          humanId: null,
          attendanceMode: "RSVP",
          stewardship: "COMMUNITY",
          status: "PUBLISHED",
          // Pinned explicitly in the adapter (not left to Prisma defaults)
          // so a future schema-default change can't alter FR-005.
          visibility: "PUBLIC",
          gateType: "NONE",
          geohash6: "9v6kpz",
        }),
      }),
    );
  });
});

describe("makeEventsRepo community listing place link", () => {
  const listingInput = {
    title: "Weekly Open Mic",
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: new Date("2026-08-01T23:00:00.000Z"),
    timezone: "America/Chicago",
    addressText: "912 Red River St",
    countryCode: "US",
    lat: 30.2697,
    lng: -97.7363,
    geohash6: "9v6kpz",
    slug: "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123",
    shortId: "abc123",
    attendanceMode: "RSVP" as const,
    stewardship: "COMMUNITY" as const,
    status: "DRAFT" as const,
    publishedAt: null,
  };
  const PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("createCommunityListing writes placeId and no confirmation column", async () => {
    const create = vi.fn().mockResolvedValue({ ...DEFAULT_EVENT });
    const repo = makeEventsRepo({ event: { create } } as unknown as PrismaClientOrTx);

    await repo.createCommunityListing({ ...listingInput, placeId: PLACE_ID });

    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.placeId).toBe(PLACE_ID);
    expect(Object.keys(data).filter((key) => /confirm/i.test(key))).toEqual([]);
  });

  it("createCommunityListing writes placeId null when none is given", async () => {
    const create = vi.fn().mockResolvedValue({ ...DEFAULT_EVENT });
    const repo = makeEventsRepo({ event: { create } } as unknown as PrismaClientOrTx);

    await repo.createCommunityListing(listingInput);

    expect(create.mock.calls[0]![0].data.placeId).toBeNull();
  });

  const EXACT_RESET = {
    locationMode: "EXACT" as const,
    locationRadiusMeters: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    addressRevealNotifiedAt: null,
  };

  it("createCommunityListing writes the place's privacy when given", async () => {
    const create = vi.fn().mockResolvedValue({ ...DEFAULT_EVENT });
    const repo = makeEventsRepo({ event: { create } } as unknown as PrismaClientOrTx);

    await repo.createCommunityListing({
      ...listingInput,
      placeId: PLACE_ID,
      locationPrivacy: EXACT_RESET,
    });

    expect(create.mock.calls[0]![0].data).toMatchObject(EXACT_RESET);
  });

  it("applyCommunityEdit writes the privacy reset only when given", async () => {
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_EVENT });
    const repo = makeEventsRepo({ event: { update } } as unknown as PrismaClientOrTx);

    await repo.applyCommunityEdit({ eventId: "e1", fields: { title: "T" } });
    await repo.applyCommunityEdit({
      eventId: "e1",
      fields: {},
      placeId: PLACE_ID,
      locationPrivacy: EXACT_RESET,
    });

    expect("locationMode" in update.mock.calls[0]![0].data).toBe(false);
    expect("addressRevealAt" in update.mock.calls[0]![0].data).toBe(false);
    expect(update.mock.calls[1]![0].data).toMatchObject(EXACT_RESET);
  });

  it("applyCommunityEdit writes placeId only when it is given (link and unlink)", async () => {
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_EVENT });
    const repo = makeEventsRepo({ event: { update } } as unknown as PrismaClientOrTx);

    await repo.applyCommunityEdit({ eventId: "e1", fields: { title: "T" } });
    await repo.applyCommunityEdit({ eventId: "e1", fields: {}, placeId: PLACE_ID });
    await repo.applyCommunityEdit({ eventId: "e1", fields: {}, placeId: null });

    expect("placeId" in update.mock.calls[0]![0].data).toBe(false);
    expect(update.mock.calls[1]![0].data.placeId).toBe(PLACE_ID);
    expect(update.mock.calls[2]![0].data.placeId).toBeNull();
    // Linking is not confirming: no venue-confirmation column on any write.
    for (const [call] of update.mock.calls) {
      const data = call.data as Record<string, unknown>;
      expect(Object.keys(data).filter((key) => /confirm/i.test(key))).toEqual([]);
    }
  });
});

describe("makeEventsRepo applyCommunityEdit geohash sync", () => {
  const createGeoPrisma = () => {
    const update = vi.fn();
    const findUniqueOrThrow = vi.fn();

    const prisma = {
      event: {
        update,
        findUniqueOrThrow,
      },
    } as unknown as PrismaClientOrTx;

    return { prisma, update, findUniqueOrThrow };
  };

  it("re-derives geohash6 when the diff carries a non-null lat/lng pair", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    update.mockResolvedValue({ ...DEFAULT_EVENT, lat: 44.98, lng: -93.27 });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { lat: 44.98, lng: -93.27 },
    });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lat: 44.98,
          lng: -93.27,
          geohash6: encodeGeohash(44.98, -93.27, 6),
        }),
      }),
    );
  });

  it("nulls geohash6 when the diff clears the pin (both lat and lng null)", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    update.mockResolvedValue({ ...DEFAULT_EVENT });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { lat: null, lng: null },
    });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lat: null,
          lng: null,
          geohash6: null,
        }),
      }),
    );
  });

  it("pre-reads the row to resolve the effective pair when only one coordinate is in the diff", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    findUniqueOrThrow.mockResolvedValue({ lat: 44.98, lng: -93.27 });
    update.mockResolvedValue({ ...DEFAULT_EVENT, lat: 45.0, lng: -93.27 });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { lat: 45.0 },
    });

    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id },
      select: { lat: true, lng: true },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lat: 45.0,
          geohash6: encodeGeohash(45.0, -93.27, 6),
        }),
      }),
    );
  });

  it("nulls geohash6 when a half-diff leaves the effective pair incomplete", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    // Stored row has no lng, so the effective pair stays incomplete.
    findUniqueOrThrow.mockResolvedValue({ lat: null, lng: null });
    update.mockResolvedValue({ ...DEFAULT_EVENT, lat: 45.0 });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { lat: 45.0 },
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lat: 45.0,
          geohash6: null,
        }),
      }),
    );
  });

  it("prefers an explicit caller-provided geohash6 over re-deriving", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    update.mockResolvedValue({ ...DEFAULT_EVENT });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { lat: 44.98, lng: -93.27 },
      geohash6: "9zvxvf",
    });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ geohash6: "9zvxvf" }),
      }),
    );
  });

  it("leaves geohash6 untouched when the diff does not touch the pin", async () => {
    const { prisma, update, findUniqueOrThrow } = createGeoPrisma();
    const repo = makeEventsRepo(prisma);
    update.mockResolvedValue({ ...DEFAULT_EVENT, title: "New Title" });

    await repo.applyCommunityEdit({
      eventId: DEFAULT_EVENT.id,
      fields: { title: "New Title" },
    });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    const data = update.mock.calls[0]?.[0]?.data;
    expect(data).not.toHaveProperty("geohash6");
  });
});

describe("makeEventsRepo address-reveal notification scan + cursor", () => {
  it("scans PUBLISHED OBSCURED events crossing reveal inside (windowStart, windowEnd] with a null cursor", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    findMany.mockResolvedValue([DEFAULT_EVENT]);

    const windowStart = new Date("2026-07-07T11:45:00.000Z");
    const windowEnd = new Date("2026-07-07T12:00:00.000Z");
    const result = await repo.findObscuredEventsCrossingReveal({
      windowStart,
      windowEnd,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PUBLISHED",
          locationMode: "OBSCURED",
          addressRevealAt: { gt: windowStart, lte: windowEnd },
          addressRevealNotifiedAt: null,
        },
        orderBy: { addressRevealAt: "asc" },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(DEFAULT_EVENT.id);
  });

  it("narrows the scan to one event when eventId is provided and BYPASSES the cursor gate (ops re-drive)", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    findMany.mockResolvedValue([]);

    const windowStart = new Date("2026-07-01T00:00:00.000Z");
    const windowEnd = new Date("2026-07-07T12:00:00.000Z");
    await repo.findObscuredEventsCrossingReveal({
      windowStart,
      windowEnd,
      eventId: DEFAULT_EVENT.id,
    });

    // Explicit eventId = re-drive path: the stamped-cursor filter must NOT
    // apply (the dispatcher's ledger subtraction confines the re-run to the
    // un-notified gap). Status/mode/window guards still apply.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PUBLISHED",
          locationMode: "OBSCURED",
          addressRevealAt: { gt: windowStart, lte: windowEnd },
          id: DEFAULT_EVENT.id,
        },
      }),
    );
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty("addressRevealNotifiedAt");
  });

  it("markAddressRevealNotified conditionally stamps the cursor and reports winning the race", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    const at = new Date("2026-07-07T12:00:00.000Z");
    const won = await repo.markAddressRevealNotified(DEFAULT_EVENT.id, at);

    expect(won).toBe(true);
    // Conditional update: only stamps while the cursor is still null, so
    // overlapping runs can't both claim the event.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: DEFAULT_EVENT.id, addressRevealNotifiedAt: null },
      data: { addressRevealNotifiedAt: at },
    });
  });

  it("markAddressRevealNotified returns false when another run already stamped the cursor", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makeEventsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const won = await repo.markAddressRevealNotified(
      DEFAULT_EVENT.id,
      new Date("2026-07-07T12:00:00.000Z"),
    );

    expect(won).toBe(false);
  });
});

describe("makeEventsRepo publishCommunityListingIfDraft (CAS)", () => {
  const createPrisma = () => {
    const updateMany = vi.fn();
    const findUniqueOrThrow = vi.fn();
    const prisma = {
      event: { updateMany, findUniqueOrThrow },
    } as unknown as PrismaClientOrTx;
    return { prisma, updateMany, findUniqueOrThrow };
  };

  const PUBLISHED_AT = new Date("2026-09-15T12:00:00.000Z");

  it("guards on status DRAFT *and* stewardship COMMUNITY in the WHERE", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = createPrisma();
    const repo = makeEventsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      ...DEFAULT_EVENT,
      status: "PUBLISHED",
      publishedAt: PUBLISHED_AT,
    });

    const result = await repo.publishCommunityListingIfDraft({
      eventId: DEFAULT_EVENT.id,
      publishedAt: PUBLISHED_AT,
    });

    // The status guard is what makes a concurrent second publish a no-op;
    // the stewardship guard stops this being a back door around publishEvent.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: DEFAULT_EVENT.id,
        status: "DRAFT",
        stewardship: "COMMUNITY",
      },
      data: { status: "PUBLISHED", publishedAt: PUBLISHED_AT },
    });
    expect(result?.status).toBe("PUBLISHED");
    expect(result?.publishedAt).toEqual(PUBLISHED_AT);
  });

  it("returns null and reads nothing back when the guard matches no row", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = createPrisma();
    const repo = makeEventsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.publishCommunityListingIfDraft({
      eventId: DEFAULT_EVENT.id,
      publishedAt: PUBLISHED_AT,
    });

    expect(result).toBeNull();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("makeEventsRepo sitemap — ban that sticks", () => {
  it("drops a withheld owner's events with a NULL-safe filter", async () => {
    const { prisma, findMany } = createPrisma();
    (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw
      .mockResolvedValueOnce([
        { kind: "HUMAN", id: "banned-human" },
        { kind: "ORG", id: "banned-org" },
      ]);
    findMany.mockResolvedValueOnce([]);
    const now = new Date("2026-09-29T00:00:00.000Z");

    await makeEventsRepo(prisma).listPublishedForSitemap({ now });

    expect(findMany.mock.calls[0][0].where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      slug: { not: null },
      endsAt: { gte: now },
      gateType: "NONE",
      AND: [
        {
          AND: [
            {
              OR: [
                { humanId: null },
                { humanId: { notIn: ["banned-human"] } },
              ],
            },
            { OR: [{ orgId: null }, { orgId: { notIn: ["banned-org"] } }] },
          ],
        },
      ],
    });
  });
});

describe("makeEventsRepo gated events stay out of what crawlers are sent to", () => {
  // Owner ruling 2026-10-13: a gated (PASSWORD / APPLICATION) event's page is
  // noindex, so it is not in the event sitemap and does not count toward a
  // geo×category page's indexability or the geo×category sitemap.

  /** The SQL text of a `$queryRaw` call, tagged-template or `Prisma.sql`. */
  const sqlTextOf = (call: unknown[]): string => {
    const [first, ...values] = call;
    // `Prisma.Sql` is a type, not a runtime constructor, in this Prisma
    // build: tell a `Prisma.sql` object from template strings by shape.
    if (Array.isArray(first)) {
      return Prisma.sql(first as unknown as TemplateStringsArray, ...values)
        .sql;
    }
    return (first as { sql: string }).sql;
  };

  const queryRawOf = (prisma: PrismaClientOrTx) =>
    (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw;

  it("leaves gated events out of the event sitemap", async () => {
    const { prisma, findMany } = createPrisma();
    findMany.mockResolvedValueOnce([]);

    await makeEventsRepo(prisma).listPublishedForSitemap({
      now: new Date("2026-10-13T00:00:00.000Z"),
    });

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      gateType: "NONE",
    });
  });

  it("counts only ungated events toward a geo×category combo's minCount", async () => {
    const { prisma } = createPrisma();
    const $queryRaw = queryRawOf(prisma);
    $queryRaw.mockResolvedValueOnce([]);

    await makeEventsRepo(prisma).enumerateGeoCategoryCombos({
      minCount: 3,
      startsAfter: new Date("2026-10-13T00:00:00.000Z"),
    });

    const sql = sqlTextOf($queryRaw.mock.calls[0]);
    expect(sql).toContain(`e."gateType" = 'NONE'`);
    // The gate sits in the WHERE, before the GROUP BY / HAVING threshold.
    expect(sql.indexOf(`e."gateType" = 'NONE'`)).toBeLessThan(
      sql.indexOf("HAVING count(*) >="),
    );
  });

  it("lists gated events on the geo×category page and reports the ungated count apart", async () => {
    const { prisma, findMany } = createPrisma();
    const $queryRaw = queryRawOf(prisma);
    $queryRaw.mockResolvedValueOnce([
      { id: "event-1", total: 3, indexableTotal: 1 },
    ]);
    findMany.mockResolvedValueOnce([]);

    const page = await makeEventsRepo(prisma).listPublishedByCategoryAndCity({
      categorySlug: "open-mics",
      citySlug: "nashville",
      region: null,
      limit: 48,
      offset: 0,
      startsAfter: new Date("2026-10-13T00:00:00.000Z"),
    });

    const sql = sqlTextOf($queryRaw.mock.calls[0]);
    // The listing's own WHERE carries no gate: gated events still list.
    const where = sql.slice(sql.indexOf('FROM "Event" e'));
    expect(where).not.toContain("gateType");
    // The ungated count is a FILTERed window over the same rows, with the
    // same clause the combos query thresholds on.
    expect(sql).toContain(
      `count(*) FILTER (WHERE e."gateType" = 'NONE') OVER()`,
    );
    expect(page.pageInfo.total).toBe(3);
    expect(page.indexableTotal).toBe(1);
  });

  it("reports zero ungated matches for an empty geo×category page", async () => {
    const { prisma } = createPrisma();
    queryRawOf(prisma).mockResolvedValueOnce([]);

    const page = await makeEventsRepo(prisma).listPublishedByCategoryAndCity({
      categorySlug: "open-mics",
      citySlug: "nowhere",
      region: null,
      limit: 48,
      offset: 0,
      startsAfter: new Date("2026-10-13T00:00:00.000Z"),
    });

    expect(page.pageInfo.total).toBe(0);
    expect(page.indexableTotal).toBe(0);
  });
});
