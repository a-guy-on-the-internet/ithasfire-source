import { describe, expect, it, vi } from "vitest";

import {
  orderIdentifierFromQuery,
  searchOrgAdmin,
} from "../search-org-admin";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const BUYER_A = "33333333-3333-4333-8333-333333333333";
const BUYER_B = "44444444-4444-4444-8444-444444444444";
const DRAFT_EVENT = "55555555-5555-4555-8555-555555555555";
const VENUE = "66666666-6666-4666-8666-666666666666";

/** An order the searched ORG owns. */
const OWN_ORDER_ID = "0b1e5f2c-1111-4111-8111-0b1e5f2c1111";
/**
 * The 8-hex TAIL of OWN_ORDER_ID — the ONE code every surface renders
 * (`formatOrderCode`, i.e. `#{order.id.slice(-8).toUpperCase()}`).
 */
const OWN_ORDER_ID_SUFFIX = "0b1e5f2c1111".slice(-8); // "5f2c1111"
/**
 * A 10-char base-36 string of the shape `Order.shortId` USED to have. It is no
 * longer an order identifier at all — pinned below so the removed arm cannot
 * quietly come back.
 */
const LEGACY_SHORT_ID = "k3f9q1z7ab";
/** An order belonging to some OTHER org — the repo scope must hide it. */
const FOREIGN_ORDER_ID = "0b1e5f2c-2222-4222-8222-0b1e5f2c2222";
const FOREIGN_ORDER_ID_SUFFIX = "5f2c2222";
/** An id that matches nothing at all. */
const NONEXISTENT_ORDER_ID = "0b1e5f2c-3333-4333-8333-0b1e5f2c3333";

const OWN_ORDER_ROW = {
  id: OWN_ORDER_ID,
  eventId: DRAFT_EVENT,
  eventTitle: "Secret Draft Party",
  buyerHumanId: BUYER_A,
  buyerName: "Ada Lovelace",
  buyerEmail: "ada@example.com",
  amountGrossCents: 4500,
  currency: "usd",
  status: "SUCCEEDED" as const,
  occurredAt: new Date("2026-06-02T18:30:00.000Z"),
};

/**
 * The ORG attendee page: 3 orders across 2 buyers. A factory rather than a
 * literal inside the mock, so a test can reuse the rows WITHOUT calling the
 * mock (which would burn call #1 and make any `toHaveBeenCalledTimes` assertion
 * lie).
 */
function orgOrderPageItems() {
  return [
    {
      buyerHumanId: BUYER_A,
      buyerName: "Ada Lovelace",
      buyerEmail: "ada@example.com",
      eventTitle: "Secret Draft Party",
      occurredAt: new Date("2026-06-01T00:00:00.000Z"),
    },
    {
      buyerHumanId: BUYER_A,
      buyerName: "Ada Lovelace",
      buyerEmail: "ada@example.com",
      eventTitle: "Launch Night",
      occurredAt: new Date("2026-06-02T00:00:00.000Z"),
    },
    {
      buyerHumanId: BUYER_B,
      buyerName: "Grace Hopper",
      buyerEmail: "grace@example.com",
      eventTitle: "Launch Night",
      occurredAt: new Date("2026-05-20T00:00:00.000Z"),
    },
  ];
}

/**
 * @param role The actor's org role. Finance-ness is DERIVED from it
 *   (`ORG_FINANCE_ROLES` = OWNER/ADMIN/FINANCE) off the single
 *   `getOrgMembership` read, so a non-finance actor is expressed as a real
 *   membership row — `VIEWER` — not by stubbing a separate probe.
 */
function makeDeps(role: string = "OWNER") {
  const deps = {
    repos: {
      authz: {
        getOrgMembership: vi.fn(async () => ({ role })),
      },
      events: {
        listByOwner: vi.fn(async () => ({
          items: [
            {
              id: DRAFT_EVENT,
              title: "Secret Draft Party",
              status: "DRAFT",
              startsAt: new Date("2026-07-01T00:00:00.000Z"),
              slug: null,
            },
          ],
          pageInfo: { total: 1, limit: 20, offset: 0 },
        })),
      },
      places: {
        listAccessibleByHuman: vi.fn(async () => ({
          items: [
            {
              id: VENUE,
              name: "The Warehouse",
              formattedAddress: "1 Main St",
              // A venue that publishes its address. Explicit: the redactor
              // fails closed, so a row without it is treated as withheld.
              locationMode: "EXACT",
              orgIdsWithAccess: [ORG],
              humanIdsWithAccess: [],
            },
          ],
          pageInfo: { total: 1, limit: 20, offset: 0 },
        })),
      },
      orders: {
        // `total: -1` mirrors the repo's `skipTotal` contract — the use case
        // must never read it.
        listForOrg: vi.fn(async () => ({
          items: orgOrderPageItems(),
          total: -1,
        })),
        // The HUMAN-owner attendee path. Distinct buyer so a test can prove
        // which repo call produced the attendees.
        listForHumanOwnedEvents: vi.fn(async () => ({
          items: [
            {
              buyerHumanId: BUYER_B,
              buyerName: "Grace Hopper",
              buyerEmail: "grace@example.com",
              eventTitle: "Solo Show",
              occurredAt: new Date("2026-05-20T00:00:00.000Z"),
            },
          ],
          total: -1,
        })),
        // COUNT(DISTINCT buyer) — deliberately a DIFFERENT number from the
        // order totals above, so a test can catch an order count wearing an
        // attendee label.
        countDistinctBuyersForOwner: vi.fn(async () => 2),
        summarizeBuyerOrdersForOwner: vi.fn(async () => [
          {
            buyerHumanId: BUYER_A,
            orderCount: 7,
            lastOrderAt: new Date("2026-06-02T00:00:00.000Z"),
          },
          {
            buyerHumanId: BUYER_B,
            orderCount: 1,
            lastOrderAt: new Date("2026-05-20T00:00:00.000Z"),
          },
        ]),
        /**
         * Stands in for the owner-scoped repo query: it answers ONLY for the
         * identifiers the searched owner actually owns. A foreign org's id and
         * a nonexistent id both fall through to `null` here for the same
         * reason they do in SQL — the owner scope is part of the predicate.
         */
        findForOwner: vi.fn(
          async (input: { id?: string; idSuffix?: string; ownerId: string }) => {
            const ownsOrder = input.ownerId === ORG;
            if (!ownsOrder) return null;
            if (input.id === OWN_ORDER_ID) return OWN_ORDER_ROW;
            if (input.idSuffix === OWN_ORDER_ID_SUFFIX) return OWN_ORDER_ROW;
            return null;
          },
        ),
      },
    },
    /**
     * `canManagePlace` is the ONE authz method `SearchOrgAdminDeps` declares
     * (the D5 bar for a withheld venue's address). `canFinanceOrg` is a
     * tripwire, not a dependency: every assertion on it below is "the second
     * authz round-trip has NOT come back".
     */
    authz: {
      canFinanceOrg: vi.fn(async () => ({ allowed: true })),
      canManagePlace: vi.fn(async () => ({
        allowed: ["OWNER", "ADMIN", "EDITOR"].includes(role),
      })),
    },
  } as any;

  return deps;
}

const baseInput = {
  actorHumanId: ACTOR,
  ownerType: "ORGANIZATION" as const,
  ownerId: ORG,
  query: "party",
  limit: 20,
};

describe("searchOrgAdmin", () => {
  it("returns drafts, deduped attendees, and venues for a finance-allowed actor", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, baseInput);

    // Draft event is visible.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: DRAFT_EVENT,
      status: "DRAFT",
    });

    // Attendees deduped by buyer: Ada (2 events) + Grace (1 event).
    expect(result.attendees).toHaveLength(2);
    const ada = result.attendees.find((a) => a.buyerHumanId === BUYER_A);
    expect(ada?.eventTitles).toEqual(["Secret Draft Party", "Launch Night"]);
    expect(ada?.moreCount).toBe(0);

    // Venue present.
    expect(result.venues).toEqual([
      { id: VENUE, name: "The Warehouse", address: "1 Main St" },
    ]);

    expect(result.counts).toEqual({
      events: { shown: 1, total: 1 },
      attendees: { shown: 2, total: 2 },
      venues: { shown: 1, total: 1 },
    });

    // Events were queried across all statuses incl. DRAFT.
    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "ORGANIZATION",
        ownerId: ORG,
        query: "party",
        status: expect.arrayContaining(["DRAFT"]),
      }),
    );
  });

  it("omits attendees (without throwing) when the actor lacks finance access", async () => {
    const deps = makeDeps("VIEWER");

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.attendees).toEqual([]);
    expect(result.counts.attendees).toEqual({ shown: 0, total: 0 });
    // Events + venues still returned.
    expect(result.events).toHaveLength(1);
    expect(result.venues).toHaveLength(1);
    // Orders repo never consulted.
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
  });

  /**
   * The omit-don't-throw contract, stated in one place over the WHOLE payload:
   * a real org member who is not finance gets events + venues, an empty
   * attendees group, `order: null` for an id-shaped query that WOULD have
   * matched, and no error — with exactly ONE authz round-trip.
   */
  it("a non-finance org member gets events + venues, attendees omitted, order null, no throw", async () => {
    for (const role of ["VIEWER", "EDITOR", "SCANNER"]) {
      const deps = makeDeps(role);

      const result = await searchOrgAdmin(deps, {
        ...baseInput,
        // An id the ORG genuinely owns — `findForOwner` would return a row.
        query: OWN_ORDER_ID,
      });

      expect(result.events).toHaveLength(1);
      expect(result.venues).toHaveLength(1);
      expect(result.attendees).toEqual([]);
      expect(result.counts.attendees).toEqual({ shown: 0, total: 0 });
      // NFR-002: null for lack-of-permission is the SAME null as no-such-order.
      expect(result.order).toBeNull();
      expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
      expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
      expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
    }
  });

  /** The other half: every finance role really does get the gated groups. */
  it("every ORG_FINANCE_ROLE gets attendees and the order row", async () => {
    for (const role of ["OWNER", "ADMIN", "FINANCE"]) {
      const deps = makeDeps(role);

      const result = await searchOrgAdmin(deps, {
        ...baseInput,
        query: OWN_ORDER_ID,
      });

      expect(result.attendees).toHaveLength(2);
      expect(result.order?.id).toBe(OWN_ORDER_ID);
      expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    }
  });

  /**
   * The point of the whole change: the finance path costs ONE authz read, not
   * two. `toHaveBeenCalledTimes(1)` is exact — it fails at 2 as well as at 0.
   */
  it("makes exactly ONE getOrgMembership round-trip on the finance path", async () => {
    const deps = makeDeps("OWNER");

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      query: OWN_ORDER_ID,
    });

    // Both gated groups were served.
    expect(result.attendees).toHaveLength(2);
    expect(result.order?.id).toBe(OWN_ORDER_ID);

    expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG,
      humanId: ACTOR,
    });
    // ...and the round-trip it replaced is gone for good.
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  /**
   * HUMAN owner: there is no org and therefore no membership row. The actor is
   * proven to BE the owner, so the gated groups are served with ZERO authz
   * reads of any kind.
   */
  it("a HUMAN owner searching their own scope makes NO authz round-trip at all", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      ownerType: "HUMAN",
      ownerId: ACTOR,
      query: OWN_ORDER_ID,
    });

    expect(deps.repos.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
    // Finance-gated groups are served: the human owns the scope.
    expect(result.attendees).toHaveLength(1);
    expect(deps.repos.orders.listForHumanOwnedEvents).toHaveBeenCalledTimes(1);
    expect(deps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR,
      id: OWN_ORDER_ID,
    });
  });

  it("rejects when the actor is not an org member", async () => {
    const deps = makeDeps();
    deps.repos.authz.getOrgMembership.mockResolvedValueOnce(null);

    await expect(searchOrgAdmin(deps, baseInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
  });
});

describe("searchOrgAdmin facets", () => {
  const CATEGORY_A = "77777777-7777-4777-8777-777777777777";
  const CATEGORY_B = "88888888-8888-4888-8888-888888888888";
  const FOREIGN_ORG = "99999999-9999-4999-8999-999999999999";
  const FOREIGN_HUMAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("forwards an explicit statuses facet in place of ALL_EVENT_STATUSES", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, { ...baseInput, statuses: ["DRAFT"] });

    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["DRAFT"] }),
    );
  });

  it("still forwards all five statuses when the statuses facet is absent", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, baseInput);

    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"],
      }),
    );
  });

  it("forwards dateRange and categoryIds verbatim to listByOwner", async () => {
    const deps = makeDeps();
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");

    await searchOrgAdmin(deps, {
      ...baseInput,
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      categoryIds: [CATEGORY_A, CATEGORY_B],
    });

    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        dateRange: { from, to },
        categoryIds: [CATEGORY_A, CATEGORY_B],
      }),
    );
  });

  it("leaves the dateRange and categoryIds KEYS absent when the facets are absent", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, baseInput);

    const arg = deps.repos.events.listByOwner.mock.calls[0][0];
    // Not just undefined values — the keys must not be present at all, so the
    // repo sees byte-identical input to today's.
    expect(Object.keys(arg)).not.toContain("dateRange");
    expect(Object.keys(arg)).not.toContain("categoryIds");
    expect(Object.keys(arg)).not.toContain("includeUncategorised");
    expect(arg.dateRange).toBeUndefined();
    expect(arg.categoryIds).toBeUndefined();
    expect(arg.includeUncategorised).toBeUndefined();
  });

  /**
   * "Uncategorised" cannot be an id — `Event.categoryId` is nullable and SQL
   * `IN` never matches NULL — so it rides as a separate boolean the repo turns
   * into `categoryId IS NULL`.
   */
  it("forwards includeUncategorised to listByOwner, with and without categoryIds", async () => {
    const deps = makeDeps();

    // Composed: "these categories OR uncategorised".
    await searchOrgAdmin(deps, {
      ...baseInput,
      categoryIds: [CATEGORY_A],
      includeUncategorised: true,
    });
    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryIds: [CATEGORY_A],
        includeUncategorised: true,
      }),
    );

    // Alone: "ONLY uncategorised" — a real filter, so `categoryIds` stays
    // absent rather than being back-filled with anything.
    const solo = makeDeps();
    await searchOrgAdmin(solo, { ...baseInput, includeUncategorised: true });
    const arg = solo.repos.events.listByOwner.mock.calls[0][0];
    expect(arg.includeUncategorised).toBe(true);
    expect(Object.keys(arg)).not.toContain("categoryIds");
  });

  /**
   * `false` and absent are deliberately the SAME thing for a boolean (unlike
   * the `.nonempty()` arrays, where `[]` had to be rejected to stop it becoming
   * a second spelling of "absent"). It is accepted, and it drops the key.
   */
  it("accepts includeUncategorised: false and forwards nothing for it", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, { ...baseInput, includeUncategorised: false });

    const arg = deps.repos.events.listByOwner.mock.calls[0][0];
    expect(Object.keys(arg)).not.toContain("includeUncategorised");
    expect(arg.includeUncategorised).toBeUndefined();
  });

  it("rejects a non-boolean includeUncategorised", async () => {
    const deps = makeDeps();

    await expect(
      searchOrgAdmin(deps, {
        ...baseInput,
        includeUncategorised: "1" as unknown as boolean,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
  });

  it("facets never reach the attendees or venues queries", async () => {
    const deps = makeDeps();
    const from = new Date("2026-01-01T00:00:00.000Z");

    await searchOrgAdmin(deps, {
      ...baseInput,
      statuses: ["DRAFT"],
      dateRange: { from: from.toISOString() },
      categoryIds: [CATEGORY_A],
    });

    const venueArg = deps.repos.places.listAccessibleByHuman.mock.calls[0][0];
    const orderArg = deps.repos.orders.listForOrg.mock.calls[0][0];
    for (const arg of [venueArg, orderArg]) {
      expect(arg.statuses).toBeUndefined();
      expect(arg.dateRange).toBeUndefined();
      expect(arg.categoryIds).toBeUndefined();
      expect(arg.status).toBeUndefined();
    }
    expect(venueArg).toMatchObject({ query: "party", ownedOnly: true });
    expect(orderArg).toMatchObject({ orgId: ORG, searchQuery: "party" });
  });

  it("types: ['event'] genuinely skips the venue and attendee repo queries", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      types: ["event"],
    });

    expect(deps.repos.events.listByOwner).toHaveBeenCalledTimes(1);
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    // No separate finance probe — finance-ness rides the membership read.
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();

    expect(result.events).toHaveLength(1);
    expect(result.attendees).toEqual([]);
    expect(result.venues).toEqual([]);
    expect(result.counts).toEqual({
      events: { shown: 1, total: 1 },
      attendees: { shown: 0, total: 0 },
      venues: { shown: 0, total: 0 },
    });
    // A skipped group must not report a total either — its query never ran.
    expect(deps.repos.orders.countDistinctBuyersForOwner).not.toHaveBeenCalled();
  });

  it("types: ['venue'] genuinely skips the events and attendee repo queries", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      types: ["venue"],
    });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).toHaveBeenCalledTimes(1);
    expect(result.events).toEqual([]);
    expect(result.counts).toEqual({
      events: { shown: 0, total: 0 },
      attendees: { shown: 0, total: 0 },
      venues: { shown: 1, total: 1 },
    });
  });

  it("types: ['attendee'] for a NON-finance actor omits attendees without throwing", async () => {
    const deps = makeDeps("VIEWER");

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      types: ["attendee"],
    });

    expect(result.attendees).toEqual([]);
    expect(result.counts).toEqual({
      events: { shown: 0, total: 0 },
      attendees: { shown: 0, total: 0 },
      venues: { shown: 0, total: 0 },
    });
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
  });

  it("types: ['attendee'] for a HUMAN owner still fetches attendees WITHOUT a finance probe", async () => {
    const deps = makeDeps();

    // The one branch where the finance probe is bypassed AND attendee data is
    // genuinely fetched and returned: a human searching their own events. The
    // actor is already proven to BE the owner by requireOwnerAccess, so
    // canFinanceOrg is neither called nor meaningful (there is no org).
    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      ownerType: "HUMAN",
      ownerId: ACTOR,
      types: ["attendee"],
    });

    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForHumanOwnedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ ownerHumanId: ACTOR, searchQuery: "party" }),
    );
    // The org path must NOT be the one that ran.
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();

    expect(result.attendees).toHaveLength(1);
    expect(result.attendees[0]).toMatchObject({
      buyerHumanId: BUYER_B,
      email: "grace@example.com",
      eventTitles: ["Solo Show"],
    });
    expect(result.counts).toEqual({
      events: { shown: 0, total: 0 },
      attendees: { shown: 1, total: 2 },
      venues: { shown: 0, total: 0 },
    });
  });

  it("an explicit types list of ALL groups behaves identically to types absent", async () => {
    const withoutTypes = makeDeps();
    const withAllTypes = makeDeps();

    const absentResult = await searchOrgAdmin(withoutTypes, baseInput);
    const explicitResult = await searchOrgAdmin(withAllTypes, {
      ...baseInput,
      // "order" joined the enum in Phase B and is part of the default set, so
      // the equivalence is against all FOUR groups.
      types: ["event", "attendee", "venue", "order"],
    });

    // Same output...
    expect(explicitResult).toEqual(absentResult);
    // ...and the same repo calls with the same args. The `?? ALL_SEARCH_GROUPS`
    // / Set interaction is exactly what a refactor breaks quietly.
    expect(withAllTypes.repos.events.listByOwner.mock.calls).toEqual(
      withoutTypes.repos.events.listByOwner.mock.calls,
    );
    expect(withAllTypes.repos.places.listAccessibleByHuman.mock.calls).toEqual(
      withoutTypes.repos.places.listAccessibleByHuman.mock.calls,
    );
    expect(withAllTypes.repos.orders.listForOrg.mock.calls).toEqual(
      withoutTypes.repos.orders.listForOrg.mock.calls,
    );
    // One authz read serves the ungated groups AND the finance gate.
    expect(withAllTypes.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(withAllTypes.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("NFR-001: a non-member is rejected BEFORE any repo read even with facets set", async () => {
    const deps = makeDeps();
    deps.repos.authz.getOrgMembership.mockResolvedValueOnce(null);

    await expect(
      searchOrgAdmin(deps, {
        ...baseInput,
        types: ["event"],
        statuses: ["DRAFT"],
        categoryIds: [CATEGORY_A],
        dateRange: { from: "2026-01-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("NFR-002: a foreign org ownerId with facets rejects before any repo read", async () => {
    const deps = makeDeps();
    deps.repos.authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      searchOrgAdmin(deps, {
        ...baseInput,
        ownerId: FOREIGN_ORG,
        categoryIds: [CATEGORY_A],
        dateRange: { to: "2030-01-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("NFR-002: a foreign HUMAN ownerId with facets rejects before any repo read", async () => {
    const deps = makeDeps();

    await expect(
      searchOrgAdmin(deps, {
        ...baseInput,
        ownerType: "HUMAN",
        ownerId: FOREIGN_HUMAN,
        statuses: ["DRAFT"],
        categoryIds: [CATEGORY_A],
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForHumanOwnedEvents).not.toHaveBeenCalled();
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("FR-005: an EMPTY query with an active facet still runs a filtered browse", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      actorHumanId: ACTOR,
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      query: "",
      limit: 20,
      types: ["event"],
      statuses: ["DRAFT"],
    });

    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({ query: "", status: ["DRAFT"] }),
    );
    expect(result.events).toHaveLength(1);
  });

  it("keeps .strict(): an unknown facet key is rejected as invalid_input", async () => {
    const deps = makeDeps();

    await expect(
      searchOrgAdmin(deps, { ...baseInput, priceMax: 1000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
  });

  it("accepts the 'order' group in types (additive enum widening)", async () => {
    const deps = makeDeps();

    await expect(
      searchOrgAdmin(deps, { ...baseInput, types: ["order"] }),
    ).resolves.toBeDefined();
  });

  it("rejects empty facet arrays so absent and empty cannot diverge", async () => {
    const deps = makeDeps();

    for (const facet of [
      { types: [] },
      { statuses: [] },
      { categoryIds: [] },
    ]) {
      await expect(
        searchOrgAdmin(deps, { ...baseInput, ...facet }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }

    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-011 — counts are TOTALS, not page lengths
// ─────────────────────────────────────────────────────────────────────────────

describe("searchOrgAdmin counts (FR-011)", () => {
  /** A page of `n` distinct draft events, as the events repo would return it. */
  function eventPage(n: number, total: number) {
    return {
      items: Array.from({ length: n }, (_, i) => ({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        title: `Draft ${i}`,
        status: "DRAFT" as const,
        startsAt: new Date("2026-07-01T00:00:00.000Z"),
        slug: null,
      })),
      pageInfo: { total, limit: 20, offset: 0 },
    };
  }

  it("reports the repo's TOTAL for events, not the page length", async () => {
    const deps = makeDeps();
    // 200 matching drafts, 20 on this page — the defect this replaces reported
    // 20, silently saturating at `limit`.
    deps.repos.events.listByOwner.mockResolvedValueOnce(eventPage(20, 200));

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.events).toHaveLength(20);
    expect(result.counts.events).toEqual({ shown: 20, total: 200 });
  });

  it("reports the repo's TOTAL for venues, not the page length", async () => {
    const deps = makeDeps();
    deps.repos.places.listAccessibleByHuman.mockResolvedValueOnce({
      items: [
        { id: VENUE, name: "The Warehouse", formattedAddress: "1 Main St" },
      ],
      pageInfo: { total: 57, limit: 20, offset: 0 },
    });

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.counts.venues).toEqual({ shown: 1, total: 57 });
  });

  it("attendee total is DISTINCT BUYERS, never the order count", async () => {
    const deps = makeDeps();
    // 3 orders on the page → 2 distinct buyers shown. The orders repo's own
    // `total` counts ORDERS (412 org-wide here); reporting it as "attendees"
    // would just be a different lie than the page length.
    deps.repos.orders.listForOrg.mockResolvedValueOnce({
      items: orgOrderPageItems(),
      total: 412,
    });
    deps.repos.orders.countDistinctBuyersForOwner.mockResolvedValueOnce(137);

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.attendees).toHaveLength(2);
    expect(result.counts.attendees).toEqual({ shown: 2, total: 137 });
    expect(result.counts.attendees.total).not.toBe(412);
    // Exactly one page fetch — nothing pre-invoked the mock.
    expect(deps.repos.orders.listForOrg).toHaveBeenCalledTimes(1);

    // The distinct-buyer count is scoped and filtered exactly like the page.
    expect(deps.repos.orders.countDistinctBuyersForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      searchQuery: "party",
    });
  });

  /**
   * `shown` and `total` per group come from DIFFERENT queries for attendees
   * (page vs distinct-buyer count), so they can drift apart. A visible row
   * under a "0 attendees" header is the observable symptom.
   */
  function expectCountsCoherent(counts: {
    events: { shown: number; total: number };
    attendees: { shown: number; total: number };
    venues: { shown: number; total: number };
  }) {
    for (const [group, count] of Object.entries(counts)) {
      expect(
        count.total,
        `${group}: total (${count.total}) must not be below shown (${count.shown}) — a rendered row under a zero header`,
      ).toBeGreaterThanOrEqual(count.shown);
    }
  }

  it("shown never exceeds total, in any group", async () => {
    const deps = makeDeps();

    expectCountsCoherent((await searchOrgAdmin(deps, baseInput)).counts);
  });

  it("shown never exceeds total when every group is page-limited", async () => {
    const deps = makeDeps();
    deps.repos.events.listByOwner.mockResolvedValueOnce(eventPage(20, 200));
    deps.repos.places.listAccessibleByHuman.mockResolvedValueOnce({
      items: [
        { id: VENUE, name: "The Warehouse", formattedAddress: "1 Main St" },
      ],
      pageInfo: { total: 57, limit: 20, offset: 0 },
    });
    deps.repos.orders.countDistinctBuyersForOwner.mockResolvedValueOnce(137);

    expectCountsCoherent((await searchOrgAdmin(deps, baseInput)).counts);
  });

  it("an id-shaped query that surfaces the order's BUYER also counts them", async () => {
    const deps = makeDeps();
    // The live shape of the defect: the identifier arm makes the attendee LIST
    // return the order's buyer, so the count — built over the same predicate —
    // must see that same buyer. It previously searched buyer name/email only
    // and returned 0, printing "0 attendees" above a rendered attendee row.
    deps.repos.orders.listForOrg.mockResolvedValueOnce({
      items: [orgOrderPageItems()[0]!],
      total: -1,
    });
    deps.repos.orders.countDistinctBuyersForOwner.mockResolvedValueOnce(1);

    const result = await searchOrgAdmin(deps, {
      ...baseInput,
      query: OWN_ORDER_ID,
    });

    expect(result.attendees).toHaveLength(1);
    expect(result.counts.attendees).toEqual({ shown: 1, total: 1 });
    expectCountsCoherent(result.counts);

    // Both sides must receive the SAME query string — the divergence must not
    // be reintroduced at this layer either. (The predicates themselves are
    // built in the adapter; their equivalence is pinned in orders.test.ts.)
    expect(deps.repos.orders.listForOrg.mock.calls[0][0].searchQuery).toBe(
      OWN_ORDER_ID,
    );
    expect(
      deps.repos.orders.countDistinctBuyersForOwner.mock.calls[0][0]
        .searchQuery,
    ).toBe(OWN_ORDER_ID);
  });

  it("a non-finance actor gets attendees {shown: 0, total: 0}, never a stale total", async () => {
    const deps = makeDeps("VIEWER");

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.counts.attendees).toEqual({ shown: 0, total: 0 });
    expect(deps.repos.orders.countDistinctBuyersForOwner).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-013 — attendee enrichment
// ─────────────────────────────────────────────────────────────────────────────

describe("searchOrgAdmin attendee enrichment (FR-013)", () => {
  it("uses the owner-scoped aggregate for orderCount/lastOrderAt, not the page", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, baseInput);

    const ada = result.attendees.find((a) => a.buyerHumanId === BUYER_A);
    // Ada has 2 orders ON THIS PAGE but 7 with the org — the aggregate wins,
    // otherwise the orders-page hand-off is guessed from a page window.
    expect(ada).toMatchObject({
      orderCount: 7,
      lastOrderAt: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(deps.repos.orders.summarizeBuyerOrdersForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      buyerHumanIds: [BUYER_A, BUYER_B],
    });
  });

  it("a buyer with no aggregate row reports ZERO, not a page-derived count", async () => {
    const deps = makeDeps();
    // The aggregate filters to COMPLETED_ORDER_STATUSES, so a buyer whose only
    // orders are abandoned PENDING carts legitimately has no row. Ada still
    // has 2 orders ON THE PAGE — falling back to that would reinstate exactly
    // the cart-counting lie the status filter exists to remove.
    deps.repos.orders.summarizeBuyerOrdersForOwner.mockResolvedValueOnce([]);

    const result = await searchOrgAdmin(deps, baseInput);

    const ada = result.attendees.find((a) => a.buyerHumanId === BUYER_A);
    expect(ada).toMatchObject({ orderCount: 0, lastOrderAt: null });
    // She is still LISTED — a pending cart makes you an attendee row, it just
    // doesn't make you a purchaser.
    expect(ada?.name).toBe("Ada Lovelace");
  });

  it("asks the orders list to SKIP its count — the attendee total comes from elsewhere", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, baseInput);

    expect(deps.repos.orders.listForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ skipTotal: true }),
    );
  });

  it("asks the HUMAN-owner orders list to skip its count too", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, {
      ...baseInput,
      ownerType: "HUMAN",
      ownerId: ACTOR,
      types: ["attendee"],
    });

    expect(deps.repos.orders.listForHumanOwnedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ skipTotal: true }),
    );
  });

  it("skips the aggregate query entirely when the page has no buyers", async () => {
    const deps = makeDeps();
    deps.repos.orders.listForOrg.mockResolvedValueOnce({ items: [], total: 0 });

    const result = await searchOrgAdmin(deps, baseInput);

    expect(result.attendees).toEqual([]);
    expect(
      deps.repos.orders.summarizeBuyerOrdersForOwner,
    ).not.toHaveBeenCalled();
  });

  it("adds no PII beyond name, email and event titles", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, baseInput);

    expect(Object.keys(result.attendees[0]!).sort()).toEqual([
      "buyerHumanId",
      "email",
      "eventTitles",
      "lastOrderAt",
      "moreCount",
      "name",
      "orderCount",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-012 — order lookup by identifier (highest-risk surface in Phase B)
// ─────────────────────────────────────────────────────────────────────────────

describe("searchOrgAdmin order lookup (FR-012)", () => {
  const orderInput = (query: string) => ({ ...baseInput, query });

  it("resolves the org's OWN order by UUID", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, orderInput(OWN_ORDER_ID));

    expect(result.order).toEqual({
      id: OWN_ORDER_ID,
      status: "SUCCEEDED",
      buyerName: "Ada Lovelace",
      buyerEmail: "ada@example.com",
      eventTitle: "Secret Draft Party",
      amountGrossCents: 4500,
      currency: "usd",
      occurredAt: new Date("2026-06-02T18:30:00.000Z"),
    });

    // The owner scope travels WITH the identifier; only the uuid field is set.
    expect(deps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      id: OWN_ORDER_ID,
    });
    const arg = deps.repos.orders.findForOwner.mock.calls[0][0];
    expect(arg.idSuffix).toBeUndefined();
  });

  /**
   * Regression for the `Order.shortId` contraction. The 10-char base-36 code
   * is GONE: it must not be parsed, must not reach the repo, and must not
   * produce an order row. Replaces the old "resolves by short code" case
   * rather than deleting it — the behaviour it pinned was inverted, not
   * dropped.
   */
  it("does NOT resolve anything for a legacy 10-char short code", async () => {
    for (const typed of [
      LEGACY_SHORT_ID,
      LEGACY_SHORT_ID.toUpperCase(),
      `#${LEGACY_SHORT_ID.toUpperCase()}`,
    ]) {
      const deps = makeDeps();

      const result = await searchOrgAdmin(deps, orderInput(typed));

      expect(result.order).toBeNull();
      expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    }
  });

  it("resolves the 8-hex code every surface renders — uppercase and '#'-prefixed", async () => {
    // `formatOrderCode` renders `order.id.slice(-8).toUpperCase()`, so this is
    // the code an admin copies. It is the only non-UUID order identifier.
    for (const typed of [
      OWN_ORDER_ID_SUFFIX,
      OWN_ORDER_ID_SUFFIX.toUpperCase(),
      `#${OWN_ORDER_ID_SUFFIX.toUpperCase()}`,
    ]) {
      const deps = makeDeps();

      const result = await searchOrgAdmin(deps, orderInput(typed));

      expect(result.order?.id).toBe(OWN_ORDER_ID);
      expect(deps.repos.orders.findForOwner).toHaveBeenCalledWith({
        ownerType: "ORGANIZATION",
        ownerId: ORG,
        idSuffix: OWN_ORDER_ID_SUFFIX,
      });
      const arg = deps.repos.orders.findForOwner.mock.calls[0][0];
      expect(arg.id).toBeUndefined();
    }
  });

  it("NFR-002: a FOREIGN org's 8-hex code yields nothing", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(
      deps,
      orderInput(FOREIGN_ORDER_ID_SUFFIX),
    );

    expect(result.order).toBeNull();
    // Still went through the owner-scoped repo method — the suffix arm rides
    // inside the same where-clause as the owner scope.
    expect(deps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      idSuffix: FOREIGN_ORDER_ID_SUFFIX,
    });
  });

  it("an 8-letter non-hex word does NOT trigger a lookup", async () => {
    for (const word of ["computer", "birthday", "festival", "tickets1"]) {
      const deps = makeDeps();

      await searchOrgAdmin(deps, orderInput(word));

      expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    }
  });

  it("NFR-002: a FOREIGN org's order UUID is byte-identical to a nonexistent id", async () => {
    const foreignDeps = makeDeps();
    const missingDeps = makeDeps();

    const foreign = await searchOrgAdmin(
      foreignDeps,
      orderInput(FOREIGN_ORDER_ID),
    );
    const missing = await searchOrgAdmin(
      missingDeps,
      orderInput(NONEXISTENT_ORDER_ID),
    );

    // No existence signal: same shape, same null, no throw on either path.
    expect(foreign.order).toBeNull();
    expect(missing.order).toBeNull();
    expect(foreign).toEqual(missing);
    // ...and the repo was consulted identically in both cases — the ONLY
    // difference is the id, never a branch.
    expect(foreignDeps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      id: FOREIGN_ORDER_ID,
    });
    expect(missingDeps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG,
      id: NONEXISTENT_ORDER_ID,
    });
  });

  it("a non-finance actor gets NO order row and NO error", async () => {
    const deps = makeDeps("VIEWER");

    const result = await searchOrgAdmin(deps, orderInput(OWN_ORDER_ID));

    expect(result.order).toBeNull();
    expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    // Same omit-never-throw semantics as the attendees group.
    expect(result.attendees).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.venues).toHaveLength(1);
  });

  it("a NON-id-shaped query never touches the orders lookup", async () => {
    for (const query of [
      "party",
      "ada@example.com",
      "Secret Draft",
      "short",
      "0b1e5f2c-1111-4111-8111",
      "k3f9q1z7abc",
      "k3f9-q1z7ab",
    ]) {
      const deps = makeDeps();

      const result = await searchOrgAdmin(deps, orderInput(query));

      expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
      expect(result.order).toBeNull();
    }
  });

  it("an empty query never touches the orders lookup", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, { ...baseInput, query: "" });

    expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    expect(result.order).toBeNull();
  });

  it("types without 'order' skips the lookup even for an id-shaped query", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      ...orderInput(OWN_ORDER_ID),
      types: ["event"],
    });

    expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    expect(result.order).toBeNull();
    // ...and there is no separate finance probe to skip.
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("types: ['order'] runs ONLY the lookup, with a single authz read", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, {
      ...orderInput(OWN_ORDER_ID),
      types: ["order"],
    });

    expect(result.order?.id).toBe(OWN_ORDER_ID);
    expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
    expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    expect(deps.repos.places.listAccessibleByHuman).not.toHaveBeenCalled();
    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
  });

  it("one authz read serves both the attendees group and the order lookup", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, orderInput(OWN_ORDER_ID));

    expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("NFR-001: a non-member is rejected BEFORE the order lookup", async () => {
    const deps = makeDeps();
    deps.repos.authz.getOrgMembership.mockResolvedValueOnce(null);

    await expect(
      searchOrgAdmin(deps, orderInput(OWN_ORDER_ID)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(deps.repos.orders.findForOwner).not.toHaveBeenCalled();
    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
  });

  it("a HUMAN owner's lookup is scoped to that human, with no finance probe", async () => {
    const deps = makeDeps();

    await searchOrgAdmin(deps, {
      ...orderInput(OWN_ORDER_ID),
      ownerType: "HUMAN",
      ownerId: ACTOR,
      types: ["order"],
    });

    expect(deps.authz.canFinanceOrg).not.toHaveBeenCalled();
    expect(deps.repos.orders.findForOwner).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR,
      id: OWN_ORDER_ID,
    });
  });

  it("an id-shaped query still returns the other groups", async () => {
    const deps = makeDeps();

    const result = await searchOrgAdmin(deps, orderInput(OWN_ORDER_ID));

    expect(result.order?.id).toBe(OWN_ORDER_ID);
    expect(result.events).toHaveLength(1);
    expect(result.venues).toHaveLength(1);
    expect(result.attendees).toHaveLength(2);
    // The id is passed to the other groups as an ordinary query string — they
    // simply won't match, which is correct, not special-cased.
    expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({ query: OWN_ORDER_ID }),
    );
  });
});

describe("orderIdentifierFromQuery", () => {
  it("classifies UUIDs, 8-hex order codes, and everything else", () => {
    expect(orderIdentifierFromQuery(OWN_ORDER_ID)).toEqual({
      id: OWN_ORDER_ID,
    });
    expect(orderIdentifierFromQuery(OWN_ORDER_ID.toUpperCase())).toEqual({
      id: OWN_ORDER_ID,
    });
    // The one displayed form: `#{id.slice(-8).toUpperCase()}`.
    expect(orderIdentifierFromQuery("#DB21B2C3")).toEqual({
      idSuffix: "db21b2c3",
    });
    // Accepted imprecision: an 8-letter hex-only word matches the suffix shape.
    // Harmless — the lookup is owner-scoped and finds nothing.
    expect(orderIdentifierFromQuery("deadbeef")).toEqual({
      idSuffix: "deadbeef",
    });

    for (const notAnId of [
      "",
      "   ",
      "#",
      "party",
      "ada@example.com",
      // A 10-char base-36 string is the shape `Order.shortId` used to have.
      // The arm is GONE — these must classify as "not an identifier".
      LEGACY_SHORT_ID,
      ` #${LEGACY_SHORT_ID.toUpperCase()} `,
      "javascript",
      "javascripts",
      "k3f9 q1z7a",
      "k3f9-q1z7a",
      // 8 chars but NOT hex — must not become a lookup.
      "computer",
      "birthday",
      // 7 and 9 hex chars — the suffix arm is exactly 8.
      "db21b2c",
      "db21b2c3d",
      OWN_ORDER_ID.replace(/-/g, ""),
    ]) {
      expect(orderIdentifierFromQuery(notAnId)).toBeNull();
    }
  });
});
