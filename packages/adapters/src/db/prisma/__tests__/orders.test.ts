import { describe, expect, it, vi } from "vitest";

import {
  decodeCashSalesCursor,
  encodeCashSalesCursor,
  makeOrdersRepo,
} from "../orders";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-05-15T12:00:00.000Z");

describe("makeOrdersRepo", () => {
  it("mirrors open then won dispute state without changing global order status", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeOrdersRepo(prisma);

    await repo.markDisputeStatus({
      orderId: "order-1",
      disputeStatus: "OPEN",
      disputedAt: NOW,
    });
    await repo.markDisputeStatus({
      orderId: "order-1",
      disputeStatus: "WON",
      disputedAt: NOW,
    });

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "order-1" },
      data: {
        disputeStatus: "OPEN",
        disputedAt: NOW,
      },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "order-1" },
      data: {
        disputeStatus: "WON",
        disputedAt: NOW,
      },
    });
  });

  it("records warning-closed mirror state without changing global order status", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeOrdersRepo(prisma);

    await repo.markDisputeStatus({
      orderId: "order-1",
      disputeStatus: "WARNING_CLOSED",
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        disputeStatus: "WARNING_CLOSED",
        disputedAt: undefined,
      },
    });
  });
});

function createPrisma() {
  const update = vi.fn(async () => undefined);
  const prisma = {
    order: { update },
  } as unknown as PrismaClientOrTx;

  return { prisma, update };
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner-scoped order lookup + buyer aggregates (admin search — FR-012/FR-013)
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "org-1";
const OWNER_HUMAN = "human-owner-1";
const ORDER_ID = "0b1e5f2c-1111-4111-8111-0b1e5f2c1111";
/**
 * A 10-char base-36 string of the shape `Order.shortId` USED to have. The
 * column is still in the schema but the code neither writes nor reads it, so
 * this is now just an ordinary text query — pinned below.
 */
const LEGACY_SHORT_ID = "k3f9q1z7ab";

const ORDER_ROW = {
  id: ORDER_ID,
  eventId: "event-1",
  buyerHumanId: "buyer-1",
  amountGrossCents: 4500,
  currency: "usd",
  status: "SUCCEEDED",
  occurredAt: NOW,
  event: { title: "Secret Draft Party" },
  buyer: { name: "Ada Lovelace", authUser: { email: "ada@example.com" } },
};

/** The 8-hex tail the admin dashboard renders as `#{id.slice(-8)}`. */
const ID_SUFFIX = ORDER_ID.slice(-8);

const LIST_ROW = {
  ...ORDER_ROW,
  feesPlatformCents: 100,
  taxAmountCents: 0,
  stripePaymentIntentId: null,
  source: "PRIMARY",
  event: { title: "Secret Draft Party", orgId: ORG },
};

function createSearchPrisma(overrides?: {
  findManyResult?: unknown[];
  groupByResult?: unknown[];
  countResult?: number;
}) {
  const findMany = vi.fn(async () => overrides?.findManyResult ?? []);
  const groupBy = vi.fn(async () => overrides?.groupByResult ?? []);
  const count = vi.fn(async () => overrides?.countResult ?? 0);

  const prisma = {
    order: { findMany, groupBy, count },
  } as unknown as PrismaClientOrTx;

  return { prisma, findMany, groupBy, count };
}

describe("makeOrdersRepo.findForOwner", () => {
  it("ANDs the ORG owner scope into the same where-clause as the identifier", async () => {
    const { prisma, findMany } = createSearchPrisma({
      findManyResult: [ORDER_ROW],
    });

    const result = await makeOrdersRepo(prisma).findForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      id: ORDER_ID,
    });

    // The tenancy predicate lives IN the query. There is no post-fetch
    // ownership comparison to get wrong, and no branch that could behave
    // differently for "exists but not yours".
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ id: ORDER_ID }], event: { orgId: ORG } },
        take: 2,
      }),
    );
    expect(result).toEqual({
      id: ORDER_ID,
      eventId: "event-1",
      eventTitle: "Secret Draft Party",
      buyerHumanId: "buyer-1",
      buyerName: "Ada Lovelace",
      buyerEmail: "ada@example.com",
      amountGrossCents: 4500,
      currency: "usd",
      status: "SUCCEEDED",
      occurredAt: NOW,
    });
  });

  it("scopes a HUMAN owner through event.humanId, like listForHumanOwnedEvents", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).findForOwner({
      ownerType: "HUMAN",
      ownerId: OWNER_HUMAN,
      idSuffix: ID_SUFFIX,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ id: { endsWith: ID_SUFFIX, mode: "insensitive" } }],
          event: { humanId: OWNER_HUMAN },
        },
      }),
    );
  });

  it("matches the dashboard's 8-hex code as a suffix on id, inside the owner scope", async () => {
    const { prisma, findMany } = createSearchPrisma({
      findManyResult: [ORDER_ROW],
    });

    const result = await makeOrdersRepo(prisma).findForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      idSuffix: ID_SUFFIX,
    });

    expect(result?.id).toBe(ORDER_ID);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ id: { endsWith: ID_SUFFIX, mode: "insensitive" } }],
          // Same owner scope as every other arm — a suffix match is NOT a new
          // cross-tenant surface.
          event: { orgId: ORG },
        },
      }),
    );
  });

  it("returns NULL when an 8-hex suffix is ambiguous within the owner", async () => {
    // 8 hex = 32 bits, so a suffix can legitimately hit two of the owner's
    // orders. Presenting an arbitrary one as "the" order would be worse than
    // presenting none.
    const { prisma } = createSearchPrisma({
      findManyResult: [ORDER_ROW, { ...ORDER_ROW, id: "other-id" }],
    });

    await expect(
      makeOrdersRepo(prisma).findForOwner({
        ownerType: "ORGANIZATION",
        ownerId: ORG,
        idSuffix: ID_SUFFIX,
      }),
    ).resolves.toBeNull();
  });

  it("ORs both identifiers when both are supplied", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).findForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      id: ORDER_ID,
      idSuffix: ID_SUFFIX,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { id: ORDER_ID },
            { id: { endsWith: ID_SUFFIX, mode: "insensitive" } },
          ],
          event: { orgId: ORG },
        },
      }),
    );
  });

  it("returns null WITHOUT querying when no identifier is given", async () => {
    const { prisma, findMany } = createSearchPrisma({
      findManyResult: [ORDER_ROW],
    });

    const result = await makeOrdersRepo(prisma).findForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
    });

    // An owner scope alone must never be able to select an arbitrary order.
    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns null when the scoped query matches nothing", async () => {
    const { prisma } = createSearchPrisma({ findManyResult: [] });

    await expect(
      makeOrdersRepo(prisma).findForOwner({
        ownerType: "ORGANIZATION",
        ownerId: ORG,
        id: ORDER_ID,
      }),
    ).resolves.toBeNull();
  });
});

describe("makeOrdersRepo.countDistinctBuyersForOwner", () => {
  it("drives from ORDER, not Human — bounded by the owner's orders", async () => {
    const { prisma, groupBy } = createSearchPrisma({
      groupByResult: [{ buyerHumanId: "buyer-1" }, { buyerHumanId: "buyer-2" }],
    });

    const total = await makeOrdersRepo(prisma).countDistinctBuyersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
    });

    expect(total).toBe(2);
    // `Human.name` has no index, so a Human-driven ILIKE could full-scan the
    // PLATFORM'S humans. Grouping the OWNER'S orders is bounded by org size.
    expect(groupBy).toHaveBeenCalledWith({
      by: ["buyerHumanId"],
      where: { kind: "TICKETING", event: { orgId: ORG } },
    });
  });

  it("applies the same name/email predicate the order lists apply", async () => {
    const { prisma, groupBy } = createSearchPrisma();

    await makeOrdersRepo(prisma).countDistinctBuyersForOwner({
      ownerType: "HUMAN",
      ownerId: OWNER_HUMAN,
      searchQuery: "  ada  ",
    });

    expect(groupBy).toHaveBeenCalledWith({
      by: ["buyerHumanId"],
      where: {
        kind: "TICKETING",
        event: { humanId: OWNER_HUMAN },
        buyer: {
          OR: [
            { name: { contains: "ada", mode: "insensitive" } },
            { authUser: { email: { contains: "ada", mode: "insensitive" } } },
          ],
        },
      },
    });
  });

  it("is NOT status-filtered — it must count the same population as the page", async () => {
    const { prisma, groupBy } = createSearchPrisma();

    await makeOrdersRepo(prisma).countDistinctBuyersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
    });

    // `shown` comes from listForOrg, which applies no status filter. Filtering
    // one and not the other would make the two count different things.
    expect(groupBy.mock.calls[0]![0]).not.toHaveProperty("where.status");
  });

  it("treats a whitespace-only query as no query at all", async () => {
    const { prisma, groupBy } = createSearchPrisma();

    await makeOrdersRepo(prisma).countDistinctBuyersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      searchQuery: "   ",
    });

    expect(groupBy).toHaveBeenCalledWith({
      by: ["buyerHumanId"],
      where: { kind: "TICKETING", event: { orgId: ORG } },
    });
  });
});

describe("makeOrdersRepo.summarizeBuyerOrdersForOwner", () => {
  it("aggregates count + max(occurredAt) per buyer in ONE grouped query", async () => {
    const { prisma, groupBy } = createSearchPrisma({
      groupByResult: [
        {
          buyerHumanId: "buyer-1",
          _count: { _all: 7 },
          _max: { occurredAt: NOW },
        },
        {
          buyerHumanId: "buyer-2",
          _count: { _all: 1 },
          _max: { occurredAt: null },
        },
      ],
    });

    const result = await makeOrdersRepo(prisma).summarizeBuyerOrdersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      // Duplicate id proves the repo dedupes before querying.
      buyerHumanIds: ["buyer-1", "buyer-2", "buyer-1"],
    });

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ["buyerHumanId"],
      where: {
        buyerHumanId: { in: ["buyer-1", "buyer-2"] },
        event: { orgId: ORG },
        status: {
          in: [
            "PROCESSING",
            "SUCCEEDED",
            "PART_REFUNDED",
            "REFUNDED",
            "DISPUTED",
          ],
        },
      },
      _count: { _all: true },
      _max: { occurredAt: true },
    });
    expect(result).toEqual([
      { buyerHumanId: "buyer-1", orderCount: 7, lastOrderAt: NOW },
      { buyerHumanId: "buyer-2", orderCount: 1, lastOrderAt: null },
    ]);
  });

  it("excludes PENDING carts and CANCELLED orders from the buyer's count", async () => {
    const { prisma, groupBy } = createSearchPrisma();

    await makeOrdersRepo(prisma).summarizeBuyerOrdersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      buyerHumanIds: ["buyer-1"],
    });

    // A buyer who abandoned three carts yesterday must not read as
    // "4 orders · last yesterday" against one real purchase from March.
    const statuses = (groupBy.mock.calls[0]![0] as any).where.status.in;
    expect(statuses).not.toContain("PENDING");
    expect(statuses).not.toContain("CANCELLED");
    expect(statuses).toContain("SUCCEEDED");
  });

  it("skips the query entirely for an empty buyer list", async () => {
    const { prisma, groupBy } = createSearchPrisma();

    const result = await makeOrdersRepo(prisma).summarizeBuyerOrdersForOwner({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      buyerHumanIds: [],
    });

    expect(result).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner-scoped order LISTS: identifier search arm + skipTotal
// ─────────────────────────────────────────────────────────────────────────────

describe("makeOrdersRepo.listForOrg search predicate", () => {
  it("emits the byte-identical buyer-only predicate for a NON-id query", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForOrg({ orgId: ORG, searchQuery: "ada" });

    // No `OR` wrapper: existing callers must see exactly today's where-clause.
    // `kind: "TICKETING"` is part of that clause since membership orders
    // landed — the org order list is a ticketing surface.
    expect((findMany.mock.calls[0]![0] as any).where).toEqual({
      kind: "TICKETING",
      event: { orgId: ORG },
      buyer: {
        OR: [
          { name: { contains: "ada", mode: "insensitive" } },
          { authUser: { email: { contains: "ada", mode: "insensitive" } } },
        ],
      },
    });
  });

  it("adds an id arm for a UUID query so the ?q=<id> hand-off resolves", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForOrg({
      orgId: ORG,
      searchQuery: ORDER_ID,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    // Owner scope is UNCHANGED and still ANDed — the id arm cannot reach
    // another org's orders.
    expect(where.event).toEqual({ orgId: ORG });
    expect(where.OR).toEqual([
      {
        buyer: {
          OR: [
            { name: { contains: ORDER_ID, mode: "insensitive" } },
            {
              authUser: { email: { contains: ORDER_ID, mode: "insensitive" } },
            },
          ],
        },
      },
      { id: ORDER_ID },
    ]);
  });

  it("adds an 8-hex suffix arm, uppercase and '#'-prefixed", async () => {
    for (const query of [ID_SUFFIX, ID_SUFFIX.toUpperCase(), `#${ID_SUFFIX}`]) {
      const { prisma, findMany } = createSearchPrisma();

      await makeOrdersRepo(prisma).listForOrg({
        orgId: ORG,
        searchQuery: query,
      });

      const where = (findMany.mock.calls[0]![0] as any).where;
      expect(where.event).toEqual({ orgId: ORG });
      expect(where.OR).toContainEqual({
        id: { endsWith: ID_SUFFIX, mode: "insensitive" },
      });
    }
  });

  /**
   * Regression for the `Order.shortId` contraction. A 10-char base-36 string
   * used to add a `{ shortId }` equality arm; the column is no longer read, so
   * the query must degrade to an ORDINARY buyer text search with NO identifier
   * arm and — critically — no `shortId` clause reaching Prisma.
   */
  it("treats a legacy 10-char short code as plain text, not an identifier", async () => {
    for (const query of [LEGACY_SHORT_ID, LEGACY_SHORT_ID.toUpperCase()]) {
      const { prisma, findMany } = createSearchPrisma();

      await makeOrdersRepo(prisma).listForOrg({
        orgId: ORG,
        searchQuery: query,
      });

      const where = (findMany.mock.calls[0]![0] as any).where;
      expect(where.event).toEqual({ orgId: ORG });
      // No `OR` wrapper at all: the buyer arm is emitted bare, exactly as it is
      // for any other non-id-shaped query.
      expect(where.OR).toBeUndefined();
      expect(where.buyer).toEqual({
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { authUser: { email: { contains: query, mode: "insensitive" } } },
        ],
      });
      expect(JSON.stringify(where)).not.toContain("shortId");
    }
  });

  it("keeps a FOREIGN org's order id unfindable", async () => {
    const { prisma, findMany, count } = createSearchPrisma({
      findManyResult: [],
      countResult: 0,
    });

    const result = await makeOrdersRepo(prisma).listForOrg({
      orgId: "other-org",
      searchQuery: ORDER_ID,
    });

    // The owner scope is still the outer AND, so an id from another org
    // matches nothing — the id arm narrows, it never widens.
    expect((findMany.mock.calls[0]![0] as any).where.event).toEqual({
      orgId: "other-org",
    });
    expect(result.items).toEqual([]);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("skipTotal suppresses the COUNT and returns -1, not a plausible 0", async () => {
    const { prisma, count } = createSearchPrisma({ findManyResult: [] });

    const result = await makeOrdersRepo(prisma).listForOrg({
      orgId: ORG,
      searchQuery: "ada",
      skipTotal: true,
    });

    expect(count).not.toHaveBeenCalled();
    // -1 cannot be mistaken for a real count by a caller that opts out and
    // then reads it anyway.
    expect(result.total).toBe(-1);
  });

  it("still runs the COUNT when skipTotal is absent", async () => {
    const { prisma, count } = createSearchPrisma({ countResult: 42 });

    const result = await makeOrdersRepo(prisma).listForOrg({ orgId: ORG });

    expect(count).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(42);
  });
});

describe("attendee list and attendee count share ONE search predicate", () => {
  /**
   * Run the page query and the distinct-buyer count with the same query string
   * and hand back both where-clauses. With no other filters set, the two are
   * built from the same parts and must come out DEEP-EQUAL — that equality is
   * the invariant, not the specific shape.
   */
  async function predicatesFor(
    query: string | undefined,
    scope: "ORGANIZATION" | "HUMAN" = "ORGANIZATION",
  ) {
    const { prisma, findMany, groupBy } = createSearchPrisma();
    const repo = makeOrdersRepo(prisma);

    if (scope === "ORGANIZATION") {
      await repo.listForOrg({ orgId: ORG, searchQuery: query });
    } else {
      await repo.listForHumanOwnedEvents({
        ownerHumanId: OWNER_HUMAN,
        searchQuery: query,
      });
    }
    await repo.countDistinctBuyersForOwner({
      ownerType: scope,
      ownerId: scope === "ORGANIZATION" ? ORG : OWNER_HUMAN,
      searchQuery: query,
    });

    return {
      list: (findMany.mock.calls[0]![0] as any).where,
      count: (groupBy.mock.calls[0]![0] as any).where,
    };
  }

  // `counts.attendees.shown` comes from the LIST, `.total` from the COUNT.
  // When these two predicates diverged, an id-shaped query rendered a visible
  // attendee row beneath the header "0 attendees" (and the live region
  // announced "0 attendees") — because the list matched the order through its
  // identifier arm and the count only ever looked at buyer name/email.
  it.each([
    ["no query", undefined],
    ["plain text", "ada"],
    ["a full order UUID", ORDER_ID],
    ["a legacy 10-char short code", LEGACY_SHORT_ID],
    ["an 8-hex order code", ID_SUFFIX],
  ])("agree for %s (ORG scope)", async (_label, query) => {
    const { list, count } = await predicatesFor(query);
    expect(count).toEqual(list);
  });

  it.each([
    ["plain text", "ada"],
    ["a full order UUID", ORDER_ID],
    ["an 8-hex dashboard code", ID_SUFFIX],
  ])("agree for %s (HUMAN owner scope)", async (_label, query) => {
    const { list, count } = await predicatesFor(query, "HUMAN");
    expect(count).toEqual(list);
  });

  it("NON-VACUITY: the shared predicate really does carry the identifier arm", async () => {
    // Without this, "both are empty" would satisfy the equality above.
    const { list, count } = await predicatesFor(ORDER_ID);

    expect(list.OR).toContainEqual({ id: ORDER_ID });
    expect(count.OR).toContainEqual({ id: ORDER_ID });
  });

  it("NON-VACUITY: a text query carries the buyer arm on both sides", async () => {
    const { list, count } = await predicatesFor("ada");

    const buyerArm = {
      OR: [
        { name: { contains: "ada", mode: "insensitive" } },
        { authUser: { email: { contains: "ada", mode: "insensitive" } } },
      ],
    };
    expect(list.buyer).toEqual(buyerArm);
    expect(count.buyer).toEqual(buyerArm);
  });
});

describe("makeOrdersRepo.listForHumanOwnedEvents search predicate", () => {
  it("adds the same identifier arms under the human owner scope", async () => {
    const { prisma, findMany } = createSearchPrisma({
      findManyResult: [LIST_ROW],
    });

    await makeOrdersRepo(prisma).listForHumanOwnedEvents({
      ownerHumanId: OWNER_HUMAN,
      searchQuery: ORDER_ID,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.event).toEqual({ humanId: OWNER_HUMAN });
    expect(where.OR).toContainEqual({ id: ORDER_ID });
  });

  it("emits the byte-identical buyer-only predicate for a NON-id query", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForHumanOwnedEvents({
      ownerHumanId: OWNER_HUMAN,
      searchQuery: "ada",
    });

    expect((findMany.mock.calls[0]![0] as any).where).toEqual({
      kind: "TICKETING",
      event: { humanId: OWNER_HUMAN },
      buyer: {
        OR: [
          { name: { contains: "ada", mode: "insensitive" } },
          { authUser: { email: { contains: "ada", mode: "insensitive" } } },
        ],
      },
    });
  });

  it("skipTotal suppresses the COUNT and returns -1", async () => {
    const { prisma, count } = createSearchPrisma({ findManyResult: [] });

    const result = await makeOrdersRepo(prisma).listForHumanOwnedEvents({
      ownerHumanId: OWNER_HUMAN,
      skipTotal: true,
    });

    expect(count).not.toHaveBeenCalled();
    expect(result.total).toBe(-1);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Comps ledger — listEventCompOrders.
//
// The core use case (`packages/core/src/use-cases/comp/list-comp-orders.ts`)
// derives `origin: HAND_ISSUED | VOLUNTEER_REWARD` from ONE input:
// `hasVolunteerRewardGrant`. Its 43 tests feed that flag in from a fixture, so
// they stay green no matter what this adapter asks Prisma for. Three contracts
// therefore have to be pinned HERE or nowhere:
//
//   1. `where` is eventId + source only. Adding `status: "SUCCEEDED"` would
//      silently drop revoked volunteer rewards (CANCELLED comps) out of the
//      ledger — the record that a comp was issued at all.
//   2. `orderBy` keeps the `{ id: "asc" }` tiebreaker. Without it, comps
//      sharing a millisecond (a batched reward fire) are free to swap places
//      between page requests, which under offset paging duplicates one row and
//      drops another.
//   3. `volunteerRewardGrants` stays in the `select`. Tidy it away and every
//      row's flag goes false, every row's origin collapses to HAND_ISSUED, and
//      a volunteer-earned comp is reported as an unattributed hand-issue —
//      exactly the conflation this read path exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

const COMP_EVENT_ID = "7b2c4d6e-3333-4333-8333-7b2c4d6e3333";

/** Hand-issued: issuer stamped, no grant row. */
const HAND_ISSUED_ROW = {
  id: "aaaaaaaa-0001-4000-8000-aaaaaaaa0001",
  occurredAt: NOW,
  status: "SUCCEEDED",
  compReason: "Artist guest list",
  compIssuedByHumanId: "human-issuer-1",
  buyerHumanId: "recipient-1",
  buyer: { name: "Grace Hopper", authUser: { email: "grace@example.com" } },
  items: [{ qty: 2, ticketTypeId: "tt-ga", ticketType: { name: "GA" } }],
  volunteerRewardGrants: [] as { id: string }[],
};

/**
 * Reward-granted: reason AND issuer both null — byte-identical to a legacy
 * hand-issue on every column. Only the grant row separates them.
 */
const REWARD_GRANTED_ROW = {
  id: "aaaaaaaa-0002-4000-8000-aaaaaaaa0002",
  occurredAt: new Date("2026-05-14T09:30:00.000Z"),
  status: "CANCELLED",
  compReason: null,
  compIssuedByHumanId: null,
  buyerHumanId: "recipient-2",
  buyer: { name: null, authUser: null },
  items: [{ qty: 1, ticketTypeId: "tt-ga", ticketType: { name: "GA" } }],
  volunteerRewardGrants: [{ id: "grant-1" }],
};

function compQueryArgs(findMany: ReturnType<typeof vi.fn>) {
  return findMany.mock.calls[0]![0] as any;
}

describe("makeOrdersRepo.listEventCompOrders", () => {
  it("filters on eventId + source only — NO status filter", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    const where = compQueryArgs(findMany).where;
    expect(where).toEqual({ eventId: COMP_EVENT_ID, source: "COMP" });
    // Spelled out separately from the deep-equal so that narrowing the ledger
    // fails with the reason, not just "objects differ". A revoked volunteer
    // reward is a CANCELLED comp and MUST still appear.
    expect(compQueryArgs(findMany)).not.toHaveProperty("where.status");
  });

  it("orders by occurredAt desc with an id tiebreaker, in that order", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    // Deep-equal on the ARRAY pins both the presence of the tiebreaker and its
    // position: `id` must break ties within `occurredAt`, not lead the sort.
    expect(compQueryArgs(findMany).orderBy).toEqual([
      { occurredAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("selects volunteerRewardGrants — the ONLY input to the origin discriminator", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    const select = compQueryArgs(findMany).select;
    expect(select).toHaveProperty("volunteerRewardGrants");
    // Existence is all the port field carries (a boolean), so `take: 1` with no
    // orderBy is correct — but the relation itself is not optional.
    expect(select.volunteerRewardGrants).toEqual({
      select: { id: true },
      take: 1,
    });
    // The provenance columns the ledger reads alongside it.
    expect(select).toMatchObject({
      compReason: true,
      compIssuedByHumanId: true,
    });
  });

  it("maps a present grant to hasVolunteerRewardGrant true and an absent one to false", async () => {
    const { prisma } = createSearchPrisma({
      findManyResult: [HAND_ISSUED_ROW, REWARD_GRANTED_ROW],
      countResult: 2,
    });

    const result = await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    expect(result.items).toEqual([
      {
        orderId: HAND_ISSUED_ROW.id,
        occurredAt: NOW,
        status: "SUCCEEDED",
        recipientHumanId: "recipient-1",
        recipientName: "Grace Hopper",
        recipientEmail: "grace@example.com",
        ticketTypes: [{ ticketTypeId: "tt-ga", name: "GA", quantity: 2 }],
        quantity: 2,
        reason: "Artist guest list",
        issuedByHumanId: "human-issuer-1",
        hasVolunteerRewardGrant: false,
      },
      {
        orderId: REWARD_GRANTED_ROW.id,
        occurredAt: REWARD_GRANTED_ROW.occurredAt,
        // Carried, not filtered: a revoked reward voids its comp.
        status: "CANCELLED",
        recipientHumanId: "recipient-2",
        recipientName: null,
        recipientEmail: null,
        ticketTypes: [{ ticketTypeId: "tt-ga", name: "GA", quantity: 1 }],
        quantity: 1,
        // Null reason + null issuer + a grant row. Without the grant this is
        // indistinguishable from a legacy hand-issue.
        reason: null,
        issuedByHumanId: null,
        hasVolunteerRewardGrant: true,
      },
    ]);
  });

  it("reads the flag PER ROW, never once for the whole page", async () => {
    const { prisma } = createSearchPrisma({
      // Ungranted row first, so a `.some()`-style bug that hoisted the check to
      // the page level would light BOTH rows up.
      findManyResult: [HAND_ISSUED_ROW, REWARD_GRANTED_ROW],
      countResult: 2,
    });

    const result = await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    expect(result.items.map((item) => item.hasVolunteerRewardGrant)).toEqual([
      false,
      true,
    ]);
  });

  it("forwards skip/take from the input and echoes them back", async () => {
    const { prisma, findMany } = createSearchPrisma({ countResult: 61 });

    const result = await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
      limit: 10,
      offset: 40,
    });

    const args = compQueryArgs(findMany);
    expect(args.skip).toBe(40);
    expect(args.take).toBe(10);
    expect(result).toMatchObject({ total: 61, limit: 10, offset: 40 });
  });

  it("defaults to the first page of 25 when pagination is omitted", async () => {
    const { prisma, findMany } = createSearchPrisma();

    const result = await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
    });

    const args = compQueryArgs(findMany);
    expect(args.skip).toBe(0);
    expect(args.take).toBe(25);
    expect(result).toMatchObject({ limit: 25, offset: 0 });
  });

  it("scopes the COUNT with the identical predicate as the page query", async () => {
    const { prisma, findMany, count } = createSearchPrisma({ countResult: 3 });

    const result = await makeOrdersRepo(prisma).listEventCompOrders({
      eventId: COMP_EVENT_ID,
      limit: 2,
      offset: 0,
    });

    // `total` drives the pager. If the count were scoped differently from the
    // page — say one gained a status filter — the ledger would render rows the
    // header claims do not exist.
    expect(count).toHaveBeenCalledTimes(1);
    expect((count.mock.calls[0]![0] as any).where).toEqual(
      compQueryArgs(findMany).where,
    );
    // NON-VACUITY: the shared predicate is really the comp scope, not `{}`.
    expect((count.mock.calls[0]![0] as any).where).toEqual({
      eventId: COMP_EVENT_ID,
      source: "COMP",
    });
    expect(result.total).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPending — the WRITE side of the Order.shortId contraction.
//
// Every order writer (create-checkout, claim-free-tickets,
// create-resale-checkout, issue-comp-tickets) used to derive a random 10-char
// base-36 `shortId` and pass it here. They no longer do, and the adapter no
// longer forwards one — the column stays in the schema (expand/contract step 1)
// but nothing writes it, so it must not appear in the Prisma `data` payload.
// ─────────────────────────────────────────────────────────────────────────────

describe("makeOrdersRepo.createPending", () => {
  function createWritePrisma() {
    const create = vi.fn(async (args: any) => ({
      ...args.data,
      id: args.data.id ?? ORDER_ID,
      occurredAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      nonRefundable: false,
      parentOrderId: null,
      billingAddressLine1: null,
      billingAddressLine2: null,
      billingCity: null,
      billingState: null,
      billingPostalCode: null,
      billingCountry: null,
      stripeTaxCalculationId: null,
      items: [],
    }));
    const prisma = { order: { create } } as unknown as PrismaClientOrTx;
    return { prisma, create };
  }

  it("never writes a shortId", async () => {
    const { prisma, create } = createWritePrisma();

    await makeOrdersRepo(prisma).createPending({
      id: ORDER_ID,
      eventId: "event-1",
      buyerHumanId: "buyer-1",
      amountGrossCents: 4500,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      currency: "usd",
      feePolicySnapshot: {},
      source: "PRIMARY",
      items: [],
    });

    const data = (create.mock.calls[0]![0] as any).data;
    expect(data).not.toHaveProperty("shortId");
    expect(Object.keys(data)).not.toContain("shortId");
  });

  it("does not read a shortId back onto the returned record", async () => {
    const { prisma } = createWritePrisma();

    const order = await makeOrdersRepo(prisma).createPending({
      id: ORDER_ID,
      eventId: "event-1",
      buyerHumanId: "buyer-1",
      amountGrossCents: 4500,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      currency: "usd",
      feePolicySnapshot: {},
      source: "PRIMARY",
      items: [],
    });

    expect(order).not.toHaveProperty("shortId");
  });
});

describe("dispute-mirror filter arm (disputeStatuses)", () => {
  const DISPUTED = ["OPEN", "UNDER_REVIEW", "LOST"] as const;

  it("listForOrg: filters on Order.disputeStatus IN (...) and never on status = DISPUTED", async () => {
    const { prisma, findMany, count } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForOrg({
      orgId: ORG,
      disputeStatuses: DISPUTED,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      kind: "TICKETING",
      event: { orgId: ORG },
      disputeStatus: { in: ["OPEN", "UNDER_REVIEW", "LOST"] },
    });
    // The COUNT beside the page uses the same predicate.
    expect((count.mock.calls[0]![0] as any).where).toEqual(where);
  });

  it("listForOrg: a plain status filter is unchanged (no dispute arm)", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForOrg({ orgId: ORG, status: "SUCCEEDED" });

    expect((findMany.mock.calls[0]![0] as any).where).toEqual({
      kind: "TICKETING",
      event: { orgId: ORG },
      status: "SUCCEEDED",
    });
  });

  it("listForHumanOwnedEvents: same arm inside the human owner scope", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listForHumanOwnedEvents({
      ownerHumanId: "human-1",
      disputeStatuses: DISPUTED,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.disputeStatus).toEqual({
      in: ["OPEN", "UNDER_REVIEW", "LOST"],
    });
    expect(where.status).toBeUndefined();
    expect(where.event).toEqual({ humanId: "human-1" });
  });

  it("listAll: dispute arm alone is a plain clause", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listAll({ disputeStatuses: DISPUTED });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.disputeStatus).toEqual({
      in: ["OPEN", "UNDER_REVIEW", "LOST"],
    });
    expect(where.status).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it("listAll: dispute arm ORs with a remaining multi-select, nested so the search OR survives", async () => {
    const { prisma, findMany } = createSearchPrisma();

    await makeOrdersRepo(prisma).listAll({
      statuses: ["SUCCEEDED"],
      disputeStatuses: DISPUTED,
      searchQuery: "ada",
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.AND).toEqual([
      {
        OR: [
          { status: { in: ["SUCCEEDED"] } },
          { disputeStatus: { in: ["OPEN", "UNDER_REVIEW", "LOST"] } },
        ],
      },
    ]);
    // The free-text search still has its own top-level OR.
    expect(where.OR).toHaveLength(2);
    expect(where.status).toBeUndefined();
  });
});

// ── The expired-cart scan ───────────────────────────────────────────────────
//
// `orderBy: occurredAt asc, take: limit` means the OLDEST expired carts fill
// the page. A cart the reaper cannot retire (its PaymentIntent succeeded but
// finalize DLQ'd, so it stays PENDING) is by definition among them, and would
// occupy a slot on every pass forever — displacing a cart that could actually
// be reaped. `excludeOrderIds` is how the reaper's quarantine keeps them out,
// and it has to happen IN the query: filtering afterwards leaves the slot
// consumed.
describe("makeOrdersRepo.listExpiredPending", () => {
  const CUTOFF = new Date("2026-05-15T11:40:00.000Z");

  function createScanPrisma() {
    const findMany = vi.fn(async () => []);
    const prisma = { order: { findMany } } as unknown as PrismaClientOrTx;
    return { prisma, findMany };
  }

  it("excludes quarantined ids in the WHERE clause, not after the take", async () => {
    const { prisma, findMany } = createScanPrisma();

    await makeOrdersRepo(prisma).listExpiredPending({
      createdBefore: CUTOFF,
      limit: 100,
      excludeOrderIds: ["stuck-1", "stuck-2"],
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where).toEqual({
      status: "PENDING",
      occurredAt: { lt: CUTOFF },
      id: { notIn: ["stuck-1", "stuck-2"] },
    });
    expect(args.take).toBe(100);
    expect(args.orderBy).toEqual({ occurredAt: "asc" });
  });

  it("omits the id predicate entirely when nothing is quarantined", async () => {
    // `notIn: []` is a needless predicate on the hot path of a cron scan.
    const { prisma, findMany } = createScanPrisma();

    await makeOrdersRepo(prisma).listExpiredPending({
      createdBefore: CUTOFF,
      limit: 100,
      excludeOrderIds: [],
    });
    await makeOrdersRepo(prisma).listExpiredPending({
      createdBefore: CUTOFF,
      limit: 100,
    });

    for (const call of findMany.mock.calls) {
      expect((call[0] as any).where).not.toHaveProperty("id");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listByBuyer — the raw venue-confirmation inputs the holder gate needs
//
// A venue that withholds its address releases it on the my-tickets list only
// for its own show or one it confirmed (core `venueConfirmationArm`). The
// adapter hands core the event's raw confirmation columns; a column dropped
// here would read as "unconfirmed" and hide the venue's own show.
// ─────────────────────────────────────────────────────────────────────────────

describe("makeOrdersRepo.listByBuyer venue-confirmation inputs", () => {
  it("selects and passes through the event's confirmation columns and start", async () => {
    const startsAt = new Date("2026-10-01T01:00:00.000Z");
    const confirmedAt = new Date("2026-09-20T00:00:00.000Z");
    const { prisma, findMany } = createSearchPrisma({
      countResult: 1,
      findManyResult: [
        {
          id: ORDER_ID,
          eventId: "event-1",
          amountGrossCents: 2000,
          feesPlatformCents: 0,
          currency: "usd",
          status: "SUCCEEDED",
          occurredAt: NOW,
          source: "PRIMARY",
          event: {
            title: "Porch Show",
            slug: "porch-show",
            startsAt,
            locationMode: "OBSCURED",
            locationRadiusMeters: 800,
            locationLabel: "East Nashville",
            addressRevealAt: null,
            addressRevealPreset: "DAY_BEFORE",
            locality: "Nashville",
            region: "TN",
            placeId: "place-1",
            orgId: "org-stranger",
            humanId: null,
            stewardship: "OWNED",
            venueConfirmedAt: confirmedAt,
            venueConfirmationWithdrawnAt: null,
            venueConfirmedPlaceId: "place-1",
            place: {
              name: "The Blue Door House",
              city: "Nashville",
              locationMode: "OBSCURED",
              locationRadiusMeters: 800,
            },
          },
          _count: { tickets: 1 },
          tickets: [],
        },
      ],
    });
    const repo = makeOrdersRepo(prisma);

    const result = await repo.listByBuyer({ buyerHumanId: "buyer-1" });

    const select = (findMany.mock.calls[0] as unknown as [
      { include: { event: { select: Record<string, unknown> } } },
    ])[0].include.event.select;
    for (const column of [
      "placeId",
      "orgId",
      "humanId",
      "stewardship",
      "venueConfirmedAt",
      "venueConfirmationWithdrawnAt",
      "venueConfirmedPlaceId",
      "startsAt",
    ]) {
      expect(select[column]).toBe(true);
    }
    expect(result.items[0]!.eventLocation).toMatchObject({
      placeId: "place-1",
      orgId: "org-stranger",
      humanId: null,
      stewardship: "OWNED",
      venueConfirmedAt: confirmedAt,
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: "place-1",
      startsAt,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createCheckout links its PaymentIntent AFTER the order commits, so both
// sides of that window are single conditional UPDATEs.
// ─────────────────────────────────────────────────────────────────────────────

describe("makeOrdersRepo.linkPaymentIntentIfPending", () => {
  const makeRepo = (count: number) => {
    const updateMany = vi.fn(async () => ({ count }));
    const repo = makeOrdersRepo({
      order: { updateMany },
    } as unknown as PrismaClientOrTx);
    return { repo, updateMany };
  };

  it("links only a PENDING order with no PI yet (or already this one)", async () => {
    const { repo, updateMany } = makeRepo(1);

    await expect(
      repo.linkPaymentIntentIfPending("order-1", "pi_1"),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        status: "PENDING",
        OR: [
          { stripePaymentIntentId: null },
          { stripePaymentIntentId: "pi_1" },
        ],
      },
      data: { stripePaymentIntentId: "pi_1" },
    });
  });

  it("returns false when the order was retired, released or reaped first", async () => {
    const { repo } = makeRepo(0);

    await expect(
      repo.linkPaymentIntentIfPending("order-1", "pi_1"),
    ).resolves.toBe(false);
  });
});

describe("makeOrdersRepo.cancelPendingOrder", () => {
  const makeRepo = () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repo = makeOrdersRepo({
      order: { updateMany },
    } as unknown as PrismaClientOrTx);
    return { repo, updateMany };
  };

  it("is a status-only CAS without an expectation", async () => {
    const { repo, updateMany } = makeRepo();

    await repo.cancelPendingOrder("order-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });

  it.each([
    ["the settled PI", "pi_settled"],
    ["no PI (IS NULL)", null],
  ] as const)(
    "also requires the order to still carry %s when given",
    async (_label, expected) => {
      const { repo, updateMany } = makeRepo();

      await repo.cancelPendingOrder("order-1", {
        expectedPaymentIntentId: expected,
      });

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "order-1",
          status: "PENDING",
          stripePaymentIntentId: expected,
        },
        data: { status: "CANCELLED" },
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Cash till split (spec 2026-10-07 door-sales-same-price-and-tax, FR-009)
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeCashTillForEvent", () => {
  const at = new Date("2026-04-01T21:00:00.000Z");
  function cashOrder(
    id: string,
    amounts: { gross: number; fee: number; tax: number },
    status = "SUCCEEDED",
    tickets = 1,
    extra: { itemMetas?: unknown[]; codes?: string[] } = {},
  ) {
    return {
      id,
      shortId: null,
      amountGrossCents: amounts.gross,
      feesPlatformCents: amounts.fee,
      taxAmountCents: amounts.tax,
      status,
      occurredAt: at,
      _count: { tickets },
      items: (extra.itemMetas ?? []).map((meta) => ({ meta })),
      promoRedemptions: (extra.codes ?? []).map((code) => ({ code })),
    };
  }

  it("splits the cash collected into tax, platform fee owed and what the organiser keeps", async () => {
    const findMany = vi.fn(async () => [
      // TN cart from door-cash-parity: 9000 + 600 + 936 = 10536.
      cashOrder("o-tn", { gross: 9_000, fee: 600, tax: 936 }, "SUCCEEDED", 3),
      // Recorded before the door was priced: gross only, no fee, no tax.
      cashOrder("o-legacy", { gross: 2_000, fee: 0, tax: 0 }),
      // A comp: $0.
      cashOrder("o-comp", { gross: 0, fee: 0, tax: 0 }, "SUCCEEDED", 2),
      // Refunded: the whole total went back; its fee + tax were reversed.
      cashOrder("o-refunded", { gross: 2_500, fee: 175, tax: 261 }, "REFUNDED"),
    ]);
    const repo = makeOrdersRepo({
      order: { findMany },
    } as unknown as PrismaClientOrTx);

    const summary = await repo.summarizeCashTillForEvent({
      eventId: "event-1",
      recentLimit: 20,
    });

    expect(summary).toMatchObject({
      paidSaleCount: 2,
      cashCollectedCents: 12_536,
      taxCents: 936,
      platformFeeOwedCents: 600,
      organiserKeepsCents: 11_000,
      compSaleCount: 1,
      compTicketCount: 2,
      paidTicketCount: 4,
      refundedSaleCount: 1,
      refundedCents: 2_936,
    });
    // The split always adds back up to the drawer.
    expect(
      summary.taxCents +
        summary.platformFeeOwedCents +
        summary.organiserKeepsCents,
    ).toBe(summary.cashCollectedCents);
    // Each recent row shows what changed hands, not the face.
    expect(
      summary.recentSales.map((r) => [r.orderId, r.amountCents, r.isComp]),
    ).toEqual([
      ["o-tn", 10_536, false],
      ["o-legacy", 2_000, false],
      ["o-comp", 0, true],
      ["o-refunded", 2_936, false],
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          feesPlatformCents: true,
          taxAmountCents: true,
        }),
      }),
    );
  });

  it("platform fee owed is what each order RECORDED: 0 for cash sales since the 2026-10-08 ruling, the old fee for sales before it", async () => {
    const findMany = vi.fn(async () => [
      // Since the ruling (cash = no platform fee): TN 9000 + round(9.75% ×
      // 9000) = 878 → 9878, fee 0.
      cashOrder("o-new", { gross: 9_000, fee: 0, tax: 878 }, "SUCCEEDED", 3),
      // Before it: 9000 + 600 fee + 936 tax = 10536.
      cashOrder("o-old", { gross: 9_000, fee: 600, tax: 936 }, "SUCCEEDED", 3),
    ]);
    const repo = makeOrdersRepo({
      order: { findMany },
    } as unknown as PrismaClientOrTx);

    const summary = await repo.summarizeCashTillForEvent({
      eventId: "event-1",
      recentLimit: 20,
    });

    expect(summary).toMatchObject({
      paidSaleCount: 2,
      cashCollectedCents: 20_414,
      taxCents: 1_814,
      platformFeeOwedCents: 600,
      organiserKeepsCents: 18_000,
    });
    expect(
      summary.taxCents +
        summary.platformFeeOwedCents +
        summary.organiserKeepsCents,
    ).toBe(summary.cashCollectedCents);
    expect(summary.recentSales.map((r) => r.amountCents)).toEqual([
      9_878, 10_536,
    ]);
  });

  it("a door taking only new cash sales owes no platform fee", async () => {
    const findMany = vi.fn(async () => [
      cashOrder("o-a", { gross: 9_000, fee: 0, tax: 878 }, "SUCCEEDED", 3),
      // Tax-free (OR): the face alone.
      cashOrder("o-b", { gross: 2_500, fee: 0, tax: 0 }),
    ]);
    const repo = makeOrdersRepo({
      order: { findMany },
    } as unknown as PrismaClientOrTx);
    const summary = await repo.summarizeCashTillForEvent({
      eventId: "event-1",
      recentLimit: 20,
    });
    expect(summary).toMatchObject({
      cashCollectedCents: 12_378,
      taxCents: 878,
      platformFeeOwedCents: 0,
      organiserKeepsCents: 11_500,
    });
  });

  it("a 100%-off code sale is free with the code, not a comp; comps are the explicit action only", async () => {
    // What recordCashSale writes: priced items carry buyerTotalCents; a comp
    // also carries meta.comp.
    const priced0 = { buyerTotalCents: 0 };
    const findMany = vi.fn(async () => [
      cashOrder("o-free", { gross: 0, fee: 0, tax: 0 }, "SUCCEEDED", 2, {
        itemMetas: [priced0, priced0],
        codes: ["FREEALL"],
      }),
      cashOrder("o-comp", { gross: 0, fee: 0, tax: 0 }, "SUCCEEDED", 1, {
        itemMetas: [{ comp: true, buyerTotalCents: 0 }],
      }),
      // A partial code on a paid sale: counted as paid, row shows the code.
      cashOrder("o-disc", { gross: 2_000, fee: 0, tax: 195 }, "SUCCEEDED", 1, {
        itemMetas: [{ buyerTotalCents: 2_000 }],
        codes: ["DOOR10", "STACK5"],
      }),
      // A free tier sold as a sale (comp: false), no code: a $0 sale.
      cashOrder("o-tier0", { gross: 0, fee: 0, tax: 0 }, "SUCCEEDED", 1, {
        itemMetas: [priced0],
      }),
      // Refunded free-with-code: moved no money, so no "$0 refund".
      cashOrder("o-free-ref", { gross: 0, fee: 0, tax: 0 }, "REFUNDED", 1, {
        itemMetas: [priced0],
        codes: ["FREEALL"],
      }),
    ]);
    const repo = makeOrdersRepo({
      order: { findMany },
    } as unknown as PrismaClientOrTx);

    const summary = await repo.summarizeCashTillForEvent({
      eventId: "event-1",
      recentLimit: 20,
    });

    expect(summary).toMatchObject({
      compSaleCount: 1,
      compTicketCount: 1,
      freeWithCodeSaleCount: 1,
      freeWithCodeTicketCount: 2,
      paidSaleCount: 2,
      paidTicketCount: 2,
      cashCollectedCents: 2_195,
      taxCents: 195,
      platformFeeOwedCents: 0,
      organiserKeepsCents: 2_000,
      refundedSaleCount: 0,
      refundedCents: 0,
    });
    expect(
      summary.taxCents +
        summary.platformFeeOwedCents +
        summary.organiserKeepsCents,
    ).toBe(summary.cashCollectedCents);
    expect(
      summary.recentSales.map((r) => [r.orderId, r.isComp, r.promoCode]),
    ).toEqual([
      ["o-free", false, "FREEALL"],
      ["o-comp", true, null],
      ["o-disc", false, "DOOR10"],
      ["o-tier0", false, null],
      ["o-free-ref", false, "FREEALL"],
    ]);
    // The read asks for typed codes only, in redemption order, and the item
    // meta the classifier needs.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          items: { where: { kind: "ticket" }, take: 1, select: { meta: true } },
          promoRedemptions: {
            where: { promoId: { not: null } },
            select: { code: true },
            orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
          },
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One event's cash sales, paged (owner ruling 2026-10-08: editors refund
// cash from the Sell screen; the list carries no buyer PII)
// ─────────────────────────────────────────────────────────────────────────────

describe("listCashSalesForEvent", () => {
  const t1 = new Date("2026-04-01T21:30:00.000Z");
  const t2 = new Date("2026-04-01T21:00:00.000Z");
  function row(id: string, occurredAt: Date, extra: Record<string, unknown> = {}) {
    return {
      id,
      status: "SUCCEEDED",
      occurredAt,
      amountGrossCents: 5_000,
      feesPlatformCents: 0,
      taxAmountCents: 522,
      _count: { tickets: 2 },
      items: [
        { kind: "ticket", amountCents: 2_500, meta: { buyerTotalCents: 2_500 }, refundedAt: null },
      ],
      promoRedemptions: [],
      ...extra,
    };
  }

  it("selects only the row's columns: no buyer, billing or IP fields", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeOrdersRepo({ order: { findMany } } as unknown as PrismaClientOrTx);

    await repo.listCashSalesForEvent({ eventId: "event-1", cursor: null, limit: 25 });

    const args = (findMany.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(args.where).toEqual({
      eventId: "event-1",
      paymentChannel: "CASH",
      status: { in: ["SUCCEEDED", "REFUNDED", "PART_REFUNDED"] },
    });
    expect(args.orderBy).toEqual([{ occurredAt: "desc" }, { id: "desc" }]);
    expect(args.take).toBe(26);
    expect(args.select).toEqual({
      id: true,
      status: true,
      occurredAt: true,
      amountGrossCents: true,
      feesPlatformCents: true,
      taxAmountCents: true,
      _count: { select: { tickets: true } },
      items: {
        select: { kind: true, amountCents: true, meta: true, refundedAt: true },
        orderBy: { id: "asc" },
      },
      promoRedemptions: {
        where: { promoId: { not: null } },
        select: { code: true },
        orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
      },
    });
    const serialized = JSON.stringify(args.select);
    for (const pii of ["buyer", "billing", "checkoutIp", "email", "name", "address"]) {
      expect(serialized).not.toMatch(new RegExp(pii, "i"));
    }
    // No `include` either: an include would pull every scalar column.
    expect(args.include).toBeUndefined();
  });

  it("maps the rows and returns a cursor only when there is a further page", async () => {
    const findMany = vi.fn(async () => [
      row("o-2", t1, {
        status: "REFUNDED",
        items: [
          { kind: "ticket", amountCents: 2_500, meta: {}, refundedAt: t1 },
          { kind: "discount", amountCents: -500, meta: {}, refundedAt: null },
        ],
        promoRedemptions: [{ code: "SAVE10" }, { code: "LATER" }],
      }),
      row("o-1", t2),
      row("o-0", t2),
    ]);
    const repo = makeOrdersRepo({ order: { findMany } } as unknown as PrismaClientOrTx);

    const page = await repo.listCashSalesForEvent({ eventId: "event-1", cursor: null, limit: 2 });

    expect(page.items).toEqual([
      {
        orderId: "o-2",
        status: "REFUNDED",
        occurredAt: t1,
        amountGrossCents: 5_000,
        feesPlatformCents: 0,
        taxAmountCents: 522,
        ticketCount: 2,
        items: [
          { kind: "ticket", amountCents: 2_500, meta: {}, refundedAt: t1 },
          { kind: "discount", amountCents: -500, meta: {}, refundedAt: null },
        ],
        promoCodes: ["SAVE10", "LATER"],
      },
      expect.objectContaining({ orderId: "o-1", promoCodes: [] }),
    ]);
    expect(page.nextCursor).toBe(encodeCashSalesCursor(t2, "o-1"));

    findMany.mockResolvedValueOnce([row("o-0", t2)]);
    const last = await repo.listCashSalesForEvent({
      eventId: "event-1",
      cursor: page.nextCursor,
      limit: 2,
    });
    expect(last.nextCursor).toBeNull();
  });

  it("continues strictly after the cursor row in (occurredAt, id) desc order", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeOrdersRepo({ order: { findMany } } as unknown as PrismaClientOrTx);

    await repo.listCashSalesForEvent({
      eventId: "event-1",
      cursor: encodeCashSalesCursor(t2, "o-1"),
      limit: 2,
    });

    const args = (findMany.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(args.where.OR).toEqual([
      { occurredAt: { lt: t2 } },
      { occurredAt: t2, id: { lt: "o-1" } },
    ]);
  });

  it.each(["garbage", "|o-1", "2026-04-01T21:00:00.000Z|", "not-a-date|o-1"])(
    "an unreadable cursor %j restarts from the first page",
    async (cursor) => {
      expect(decodeCashSalesCursor(cursor)).toBeNull();
      const findMany = vi.fn(async () => []);
      const repo = makeOrdersRepo({ order: { findMany } } as unknown as PrismaClientOrTx);

      await repo.listCashSalesForEvent({ eventId: "event-1", cursor, limit: 2 });

      const args = (findMany.mock.calls[0] as unknown as [Record<string, any>])[0];
      expect(args.where.OR).toBeUndefined();
    },
  );
});
