import { beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok, SearchPortError } from "@th/ports/search";

import { unifiedSearchRouter } from "../unified-search";
import { createCaller } from "./test-helpers";

const ACTOR_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

const buildAutocompleteResponse = () =>
  ok({
    suggestions: [
      {
        type: "event" as const,
        id: "doc-1",
        eventId: "evt-1",
        title: "Sample Event",
        subtitle: null,
        helper: null,
        confidence: 0.9,
        slug: "sample-event",
        startsAt: null,
        imageUrl: null,
        lowestPriceCents: null,
        lowestBuyerTotalCents: null,
        currency: null,
        paidTierCount: 0,
        hasFreeTier: false,
      },
    ],
    latencyMs: 18,
    estimatedTotalHits: 123,
  });

describe("unifiedSearchRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([{ orgId: "not-a-uuid" }, { ownerHumanId: "not-a-uuid" }])(
    "rejects invalid scope UUIDs: %j",
    async (invalidScope) => {
      const multiSearch = {
        autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
      };

      const { caller } = createCaller(unifiedSearchRouter, {
        multiSearch: multiSearch as any,
        actorHumanId: ACTOR_HUMAN_ID,
      });

      await expect(
        caller.autocompleteAdmin({
          query: "party",
          publishedOnly: false,
          ...invalidScope,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(multiSearch.autocomplete).not.toHaveBeenCalled();
    },
  );

  it("forces public autocomplete to published-only filters", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: null,
    });

    const result = await caller.autocomplete({
      query: "party",
      limit: 50,
      offset: 1000,
      publishedOnly: false,
      orgId: ORG_ID,
      ownerHumanId: OTHER_HUMAN_ID,
    });

    const request = multiSearch.autocomplete.mock.calls[0]?.[0];

    expect(request).toEqual(
      expect.objectContaining({
        query: "party",
        limit: 50,
        offset: 1000,
      }),
    );
    expect(request.filters.publishedOnly).toBe(true);
    expect(request.filters.orgId).toBeUndefined();
    expect(request.filters.ownerHumanId).toBeUndefined();
    expect(result.estimatedTotalHits).toBe(123);
    expect(result.suggestions).toHaveLength(1);
  });

  it("allows admin autocomplete for org members and forwards unpublished scope", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller, ctx } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await caller.autocompleteAdmin({
      query: "party",
      orgId: ORG_ID,
      publishedOnly: false,
    });

    expect(ctx.authz.requireOrgRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
      requiredRoles: [
        "OWNER",
        "ADMIN",
        "EDITOR",
        "VIEWER",
        "FINANCE",
        "SCANNER",
      ],
      scope: { action: "read" },
    });

    const request = multiSearch.autocomplete.mock.calls[0]?.[0];
    expect(request.filters.orgId).toBe(ORG_ID);
    expect(request.filters.publishedOnly).toBe(false);
  });

  it("rejects unpublished admin autocomplete without an org or owner scope", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await expect(
      caller.autocompleteAdmin({ query: "party", publishedOnly: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(multiSearch.autocomplete).not.toHaveBeenCalled();
  });

  it("rejects owner-scoped admin autocomplete when the owner does not match the actor", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller, ctx } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await expect(
      caller.autocompleteAdmin({
        query: "party",
        ownerHumanId: OTHER_HUMAN_ID,
        publishedOnly: false,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "owner_scope_mismatch",
    });

    // The default probe: the port applies the second-factor rule, so an
    // un-enrolled staff member gets SECOND_FACTOR_REQUIRED (below) and a
    // non-staff caller gets this `owner_scope_mismatch`.
    expect(ctx.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_HUMAN_ID,
      requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
    });
    expect(multiSearch.autocomplete).not.toHaveBeenCalled();
  });

  it("allows staff to search another owner's drafts through the admin procedure when a 2nd factor is enrolled", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller, ctx } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    // The port's answer for an enrolled role holder.
    vi.mocked(ctx.authz.hasStaffRole).mockResolvedValue({ allowed: true });

    const result = await caller.autocompleteAdmin({
      query: "party",
      ownerHumanId: OTHER_HUMAN_ID,
      publishedOnly: false,
    });

    const request = multiSearch.autocomplete.mock.calls[0]?.[0];
    expect(request.filters.ownerHumanId).toBe(OTHER_HUMAN_ID);
    expect(request.filters.publishedOnly).toBe(false);
    expect(result.suggestions).toHaveLength(1);
    expect(ctx.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_HUMAN_ID,
      requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
    });
  });

  it("blocks the staff owner-scope override when the actor has no enrolled 2nd factor (SECOND_FACTOR_REQUIRED)", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller, ctx } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    // The port's answer for a role holder with nothing enrolled.
    vi.mocked(ctx.authz.hasStaffRole).mockResolvedValue({
      allowed: false,
      secondFactorRequired: true,
    });

    await expect(
      caller.autocompleteAdmin({
        query: "party",
        ownerHumanId: OTHER_HUMAN_ID,
        publishedOnly: false,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "SECOND_FACTOR_REQUIRED" },
    });

    expect(multiSearch.autocomplete).not.toHaveBeenCalled();
  });

  it("does not require a 2nd factor for an ordinary org-scoped admin autocomplete call (no owner-scope override)", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };

    const { caller, ctx } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    // No ownerHumanId at all — this is the plain org-scoped path that
    // ordinary (non-staff) org members use every day. It must never be
    // gated by the staff owner-scope override's 2FA check, so the staff
    // probe is never made.
    await caller.autocompleteAdmin({
      query: "party",
      orgId: ORG_ID,
      publishedOnly: false,
    });

    expect(ctx.authz.hasStaffRole).not.toHaveBeenCalled();
    expect(multiSearch.autocomplete).toHaveBeenCalledTimes(1);
  });

  describe("adminOrgSearch input strictness", () => {
    // `adminOrgSearchInput` is derived as
    // `searchOrgAdminInputSchema.omit({ actorHumanId: true })`. The spec's
    // HIGH-severity "facet widening" mitigation leans on that derived schema
    // still being `.strict()` — Zod 4's `omit` happens to clone the strict
    // catchall, but nothing else pins it, so a Zod major could drop unknown-key
    // rejection here silently while the core-level `.strict()` test stays green.
    /**
     * @param role The actor's org role. Finance access is DERIVED from it —
     *   `searchOrgAdmin` reads it off the single `getOrgMembership` call rather
     *   than probing `authz.canFinanceOrg`. These schema-strictness tests only
     *   need the ungated groups, so the default is a non-finance `VIEWER`.
     */
    const buildAdminSearchDeps = (role: string = "VIEWER") => {
      const listByOwner = vi.fn(async () => ({
        items: [],
        pageInfo: { total: 0, limit: 20, offset: 0 },
      }));
      const listAccessibleByHuman = vi.fn(async () => ({
        items: [],
        pageInfo: { total: 0, limit: 20, offset: 0 },
      }));
      const repos = {
        authz: { getOrgMembership: vi.fn(async () => ({ role })) },
        events: { listByOwner },
        places: { listAccessibleByHuman },
        orders: {
          listForOrg: vi.fn(async () => ({ items: [], total: 0 })),
          countDistinctBuyersForOwner: vi.fn(async () => 0),
          summarizeBuyerOrdersForOwner: vi.fn(async () => []),
        },
      } as any;
      // Context plumbing only. `searchOrgAdmin` no longer takes an AuthZPort —
      // finance access is derived from the OWNER membership above, off the one
      // `getOrgMembership` read. The stub answers `false` so that if the second
      // round-trip is ever reintroduced, the finance-path tests below go red
      // instead of quietly agreeing.
      const authz = {
        canFinanceOrg: vi.fn(async () => ({ allowed: false })),
      } as any;
      return { repos, authz, listByOwner };
    };

    // THIS is the assertion that actually pins `.omit()` preserving strict.
    // Asserting BAD_REQUEST through the caller does NOT: the resolver forwards
    // its input to searchOrgAdmin, which re-parses with the same `.strict()`
    // core schema, so an end-to-end call still 400s even when the TRANSPORT
    // schema has gone loose. Verified by temporarily appending `.loose()` to
    // the derivation: the caller-level test stayed green, this one goes red.
    it("keeps the DERIVED adminOrgSearch input schema strict through .omit()", () => {
      const inputSchema = (unifiedSearchRouter as any).adminOrgSearch?._def
        ?.inputs?.[0];
      expect(typeof inputSchema?.safeParse).toBe("function");

      const parsed = inputSchema.safeParse({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        query: "party",
        priceMax: 1000,
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error.issues[0]).toMatchObject({
        code: "unrecognized_keys",
        keys: ["priceMax"],
      });

      // Non-vacuity guard: the same payload without the unknown key parses.
      expect(
        inputSchema.safeParse({
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          query: "party",
        }).success,
      ).toBe(true);
    });

    it("rejects an unknown key end-to-end with BAD_REQUEST and no repo read", async () => {
      const { repos, authz, listByOwner } = buildAdminSearchDeps();

      const { caller } = createCaller(unifiedSearchRouter, {
        actorHumanId: ACTOR_HUMAN_ID,
        repos,
        authz,
      });

      await expect(
        caller.adminOrgSearch({
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          query: "party",
          priceMax: 1000,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Rejected at a boundary — no repo read was reached. (Defence in depth:
      // either the transport schema or the core re-parse will catch this.)
      expect(listByOwner).not.toHaveBeenCalled();
    });

    it("accepts the SAME payload without the unknown key (proves the rejection is the key, not the shape)", async () => {
      const { repos, authz, listByOwner } = buildAdminSearchDeps();

      const { caller } = createCaller(unifiedSearchRouter, {
        actorHumanId: ACTOR_HUMAN_ID,
        repos,
        authz,
      });

      const result = await caller.adminOrgSearch({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        query: "party",
      });

      expect(listByOwner).toHaveBeenCalledTimes(1);
      // Phase B: counts carry `shown` (this page) and `total` (whole scope)
      // separately, so a saturated page can't masquerade as a total.
      expect(result.counts).toEqual({
        events: { shown: 0, total: 0 },
        attendees: { shown: 0, total: 0 },
        venues: { shown: 0, total: 0 },
      });
      expect(result.order).toBeNull();
    });

    it("accepts the new facet keys through the derived input schema", async () => {
      const { repos, authz, listByOwner } = buildAdminSearchDeps();

      const { caller } = createCaller(unifiedSearchRouter, {
        actorHumanId: ACTOR_HUMAN_ID,
        repos,
        authz,
      });

      await caller.adminOrgSearch({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        query: "",
        types: ["event"],
        statuses: ["DRAFT"],
        dateRange: { from: "2026-01-01T00:00:00.000Z" },
        categoryIds: ["44444444-4444-4444-8444-444444444444"],
        // This file's whole job is pinning the DERIVED schema, so every facet
        // key the UI can send has to appear here — including the newest one.
        includeUncategorised: true,
      });

      expect(listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["DRAFT"],
          dateRange: { from: new Date("2026-01-01T00:00:00.000Z") },
          categoryIds: ["44444444-4444-4444-8444-444444444444"],
          includeUncategorised: true,
        }),
      );
    });

    // Phase B additions ride the SAME derivations — the input via
    // `.omit({ actorHumanId })`, the output via `.output(searchOrgAdmin-
    // OutputSchema)`. These two pin that no router edit is needed (and that a
    // future hand-written duplicate of either schema would be caught).
    it("passes the new 'order' group through the derived input schema", async () => {
      const { repos, authz } = buildAdminSearchDeps();

      const { caller } = createCaller(unifiedSearchRouter, {
        actorHumanId: ACTOR_HUMAN_ID,
        repos,
        authz,
      });

      await expect(
        caller.adminOrgSearch({
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          query: "party",
          types: ["order"],
        }),
      ).resolves.toMatchObject({ order: null });
    });

    it("returns a matched order row through the declared output schema", async () => {
      // OWNER ∈ ORG_FINANCE_ROLES — the order lookup is finance-gated.
      const { repos, authz } = buildAdminSearchDeps("OWNER");
      const occurredAt = new Date("2026-06-02T18:30:00.000Z");
      repos.orders.findForOwner = vi.fn(async () => ({
        id: "0b1e5f2c-1111-4111-8111-0b1e5f2c1111",
        eventId: "55555555-5555-4555-8555-555555555555",
        eventTitle: "Secret Draft Party",
        buyerHumanId: "33333333-3333-4333-8333-333333333333",
        buyerName: "Ada Lovelace",
        buyerEmail: "ada@example.com",
        amountGrossCents: 4500,
        currency: "usd",
        status: "SUCCEEDED",
        occurredAt,
      }));

      const { caller } = createCaller(unifiedSearchRouter, {
        actorHumanId: ACTOR_HUMAN_ID,
        repos,
        authz,
      });

      const result = await caller.adminOrgSearch({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        query: "0b1e5f2c-1111-4111-8111-0b1e5f2c1111",
        types: ["order"],
      });

      expect(result.order).toEqual({
        id: "0b1e5f2c-1111-4111-8111-0b1e5f2c1111",
        status: "SUCCEEDED",
        buyerName: "Ada Lovelace",
        buyerEmail: "ada@example.com",
        eventTitle: "Secret Draft Party",
        amountGrossCents: 4500,
        currency: "usd",
        occurredAt,
      });

      // End-to-end through the router: ONE authz round-trip served both the
      // owner-access gate and the finance gate on the order lookup.
      expect(repos.authz.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(authz.canFinanceOrg).not.toHaveBeenCalled();
    });
  });

  it("maps search failures to TRPC errors instead of returning an empty success payload", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: false,
        error: new SearchPortError("transient", "search_unavailable"),
      } as const),
    };

    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
    });

    await expect(
      caller.autocomplete({ query: "party", limit: 50, offset: 50 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

// `Category.active` is read by the use case from `ctx.repos`, not from the
// search index: an inactive (or unknown) category answers NOT_FOUND, the same
// answer `categories.eventsByCategory` gives, and the search is never run.
// Each failing tier is swallowed (the next tier answers, or the section comes
// back empty), so ctx.reportError is the only way the failure reaches Sentry.
describe("unifiedSearchRouter.tieredPopularEvents", () => {
  it("wires ctx.reportError, so a failing tier is reported and the next one answers", async () => {
    const searchError = new SearchPortError("dependency_failed", "down");
    const multiSearch = {
      autocomplete: vi
        .fn()
        .mockResolvedValueOnce(err(searchError))
        .mockResolvedValue(buildAutocompleteResponse()),
    };
    const reportError = vi.fn();

    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      reportError,
      actorHumanId: null,
    });

    const result = await caller.tieredPopularEvents({
      lat: 36.16,
      lng: -86.78,
      minResults: 1,
    });

    expect(result.tier).toBe("regional");
    expect(result.events).toHaveLength(1);
    expect(reportError).toHaveBeenCalledWith(
      searchError,
      expect.objectContaining({
        tags: { useCase: "tieredPopularEvents", tier: "local" },
      }),
    );
  });
});

describe("unifiedSearchRouter.discoverEventsByCategory", () => {
  const categoryRepos = (category: { active: boolean } | null) => ({
    categories: {
      getBySlug: vi.fn(async (slug: string) =>
        category
          ? {
              id: "44444444-4444-4444-8444-444444444444",
              slug,
              name: "Nightlife",
              active: category.active,
              sortOrder: 1,
              seoType: "Event",
              createdAt: new Date("2026-10-01T00:00:00.000Z"),
              updatedAt: new Date("2026-10-01T00:00:00.000Z"),
            }
          : null,
      ),
    },
  });

  it("returns the events of an active category", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };
    const repos = categoryRepos({ active: true });

    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      repos: repos as any,
      actorHumanId: null,
    });

    const result = await caller.discoverEventsByCategory({
      categorySlug: "nightlife",
    });

    expect(repos.categories.getBySlug).toHaveBeenCalledWith("nightlife");
    expect(result.events).toHaveLength(1);
  });

  it.each([
    ["inactive", { active: false }],
    ["unknown", null],
  ] as const)(
    "answers NOT_FOUND for an %s category and never searches",
    async (_label, category) => {
      const multiSearch = {
        autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
      };

      const { caller } = createCaller(unifiedSearchRouter, {
        multiSearch: multiSearch as any,
        repos: categoryRepos(category) as any,
        actorHumanId: null,
      });

      await expect(
        caller.discoverEventsByCategory({ categorySlug: "nightlife" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(multiSearch.autocomplete).not.toHaveBeenCalled();
    },
  );
});

// `categorySlugs` is the gated way to filter by category: the use case reads
// `Category.active` from `ctx.repos` and drops a missing or inactive slug, so
// the search runs with no category filter instead of surfacing its events.
describe("unifiedSearchRouter.autocomplete: categorySlugs", () => {
  const categoryRepos = (rows: Record<string, { active: boolean }>) => ({
    categories: {
      getBySlug: vi.fn(async (slug: string) =>
        rows[slug] ? { slug, active: rows[slug]!.active } : null,
      ),
      listActive: vi.fn(async () =>
        Object.entries(rows)
          .filter(([, row]) => row.active)
          .map(([slug]) => ({ slug })),
      ),
    },
  });

  const setup = (rows: Record<string, { active: boolean }>) => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(buildAutocompleteResponse()),
    };
    const repos = categoryRepos(rows);
    const { caller } = createCaller(unifiedSearchRouter, {
      multiSearch: multiSearch as any,
      repos: repos as any,
      actorHumanId: null,
    });
    return { multiSearch, repos, caller };
  };

  it("passes an active category through to the tag filter", async () => {
    const { multiSearch, repos, caller } = setup({ music: { active: true } });

    const result = await caller.autocomplete({
      query: "",
      categorySlugs: ["music"],
    });

    expect(repos.categories.getBySlug).toHaveBeenCalledWith("music");
    expect(multiSearch.autocomplete.mock.calls[0]?.[0].filters.tags).toEqual([
      "music",
    ]);
    expect(result.suggestions).toHaveLength(1);
  });

  it("drops an inactive category and still searches, unfiltered by category", async () => {
    const { multiSearch, caller } = setup({ nightlife: { active: false } });

    const result = await caller.autocomplete({
      query: "",
      categorySlugs: ["nightlife"],
    });

    expect(multiSearch.autocomplete).toHaveBeenCalledTimes(1);
    expect(
      multiSearch.autocomplete.mock.calls[0]?.[0].filters,
    ).not.toHaveProperty("tags");
    expect(result.suggestions).toHaveLength(1);
  });

  it("reads no category when the request names none", async () => {
    const { multiSearch, repos, caller } = setup({ music: { active: true } });

    await caller.autocomplete({ query: "", tags: ["music"] });

    expect(repos.categories.getBySlug).not.toHaveBeenCalled();
    expect(repos.categories.listActive).not.toHaveBeenCalled();
    expect(multiSearch.autocomplete.mock.calls[0]?.[0].filters.tags).toEqual([
      "music",
    ]);
  });

  it.each([
    ["an over-long slug", ["x".repeat(65)]],
    ["an empty slug", [""]],
    ["more than 50 slugs", Array.from({ length: 51 }, (_, i) => `c-${i}`)],
  ] as const)("rejects %s", async (_label, categorySlugs) => {
    const { multiSearch, repos, caller } = setup({});

    await expect(
      caller.autocomplete({ query: "", categorySlugs: [...categorySlugs] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(repos.categories.getBySlug).not.toHaveBeenCalled();
    expect(multiSearch.autocomplete).not.toHaveBeenCalled();
  });
});
