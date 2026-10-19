import { describe, expect, it, vi } from "vitest";

import type { CategorySlugRecord } from "@th/ports/repos/categories";

import { reviewCategoryRequest } from "../review-category-request";
import type { ReviewCategoryRequestDeps } from "../review-category-request";
import { createSlugTable, currentEnRows } from "./category-lifecycle-harness";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REQUESTER_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEW_CATEGORY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const FIXED_NOW = new Date("2026-10-11T12:00:00Z");
const EARLIER = new Date("2026-10-01T00:00:00Z");

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  seoType: string;
  nameTranslations?: { es?: string };
  createdAt: Date;
  updatedAt: Date;
};

function categoryRow(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    slug: "music",
    name: "Music",
    active: true,
    sortOrder: 1,
    seoType: "Event",
    nameTranslations: {},
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    categories?: CategoryRow[];
    requestName?: string;
    requestSlug?: string;
    requestLocale?: string | null;
    createError?: unknown;
    /** CategorySlug rows; default one current en row per category. */
    slugs?: CategorySlugRecord[];
  } = {},
) {
  const categoryRows = [...(overrides.categories ?? [])];
  const slugTable = createSlugTable(
    categoryRows,
    overrides.slugs ?? currentEnRows(categoryRows),
  );
  const request = {
    id: REQUEST_ID,
    kind: "CATEGORY" as const,
    status: "PENDING" as const,
    name: overrides.requestName ?? "Experimental Jazz",
    slug: overrides.requestSlug ?? "experimental-jazz",
    categoryId: null,
    categorySlug: null,
    categoryName: null,
    eventId: EVENT_ID,
    requesterHumanId: REQUESTER_ID,
    reviewedByHumanId: null,
    reviewNote: null,
    resolvedCategoryId: null,
    locale: overrides.requestLocale ?? null,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    reviewedAt: null,
  };

  const categories = {
    lockNaming: vi.fn(async () => undefined),
    getById: vi.fn(
      async (id: string) => categoryRows.find((row) => row.id === id) ?? null,
    ),
    ...slugTable.methods,
    getBySlug: vi.fn(
      async (slug: string) =>
        categoryRows.find((row) => row.slug === slug) ?? null,
    ),
    listAll: vi.fn(async () => [...categoryRows]),
    create: vi.fn(
      async (input: {
        slug: string;
        name: string;
        active?: boolean;
        sortOrder?: number;
        nameTranslations?: { es?: string };
      }) => {
        if (overrides.createError) {
          throw overrides.createError;
        }
        const row = categoryRow({
          id: NEW_CATEGORY_ID,
          slug: input.slug,
          name: input.name,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
          nameTranslations: input.nameTranslations ?? {},
        });
        categoryRows.push(row);
        // The adapter's create writes the current en slug row too.
        slugTable.addCurrentEn(row.id, row.slug);
        return row;
      },
    ),
  };

  const categoryRequests = {
    claimPendingForReview: vi.fn(async () => ({ ...request })),
    getById: vi.fn(async () => ({ ...request })),
    markReviewed: vi.fn(
      async (input: {
        status: "APPROVED" | "REJECTED";
        resolvedCategoryId?: string | null;
        reviewNote?: string | null;
      }) => ({
        ...request,
        status: input.status,
        reviewedByHumanId: ACTOR_ID,
        reviewedAt: FIXED_NOW,
        reviewNote: input.reviewNote ?? null,
        resolvedCategoryId: input.resolvedCategoryId ?? null,
      }),
    ),
  };

  const audit = { log: vi.fn() };
  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ categories, categoryRequests, audit }),
  );

  const deps: ReviewCategoryRequestDeps = {
    repos: { tx } as unknown as ReviewCategoryRequestDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    } as unknown as ReviewCategoryRequestDeps["authz"],
    clock: {
      now: () => FIXED_NOW,
    } as unknown as ReviewCategoryRequestDeps["clock"],
  };

  return { deps, categories, categoryRequests, audit, slugs: slugTable.slugs };
}

const approve = {
  actorHumanId: ACTOR_ID,
  requestId: REQUEST_ID,
  decision: "APPROVE",
};

describe("reviewCategoryRequest: approval creates the category", () => {
  it("creates the category at max sortOrder + 1 and resolves the request", async () => {
    const built = buildDeps({ categories: [categoryRow({ sortOrder: 3 })] });

    const result = await reviewCategoryRequest(built.deps, approve);

    expect(built.categories.create).toHaveBeenCalledWith({
      slug: "experimental-jazz",
      name: "Experimental Jazz",
      active: true,
      sortOrder: 4,
      nameTranslations: {},
    });
    expect(built.categoryRequests.markReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "APPROVED",
        resolvedCategoryId: NEW_CATEGORY_ID,
      }),
    );
    expect(result.request).toMatchObject({
      status: "APPROVED",
      resolvedCategoryId: NEW_CATEGORY_ID,
    });
    expect(built.audit.log).toHaveBeenCalledTimes(1);
  });

  it.each<["en" | "es", boolean]>([
    ["en", false],
    ["es", true],
  ])(
    "approves onto the category holding the slug as another of its URLs (%s, current=%s)",
    async (locale, isCurrent) => {
      // Jazz holds `experimental-jazz` as an old en URL, or as its es slug:
      // that URL leads to Jazz, so the request is for Jazz.
      const jazz = categoryRow({ slug: "jazz", name: "Jazz" });
      const built = buildDeps({
        categories: [jazz],
        slugs: [
          ...currentEnRows([jazz]),
          {
            categoryId: jazz.id,
            locale,
            slug: "experimental-jazz",
            isCurrent,
            createdAt: EARLIER,
          },
        ],
      });

      const result = await reviewCategoryRequest(built.deps, approve);

      expect(result.request).toMatchObject({
        status: "APPROVED",
        resolvedCategoryId: jazz.id,
      });
      expect(built.categories.create).not.toHaveBeenCalled();
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: "slug",
            resolvedCategoryId: jazz.id,
            categoryName: "Jazz",
          }),
        }),
      );
    },
  );

  it("writes the es slug when an approval creates a category with an es name", async () => {
    const built = buildDeps({
      requestName: "Música experimental",
      requestSlug: "musica-experimental",
      requestLocale: "es",
    });

    await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Experimental Music",
    });

    expect(
      built.slugs
        .filter((r) => r.categoryId === NEW_CATEGORY_ID)
        .map((r) => [r.locale, r.slug, r.isCurrent]),
    ).toEqual([
      ["en", "experimental-music", true],
      ["es", "musica-experimental", true],
    ]);
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "category_request.reviewed",
        data: expect.objectContaining({
          resolution: "created",
          esSlug: "musica-experimental",
        }),
      }),
    );
  });

  it("refuses with CATEGORY_ALREADY_EXISTS when the name belongs to a category under another slug", async () => {
    const built = buildDeps({
      categories: [
        categoryRow({ slug: "jazz-music", name: "experimental jazz" }),
      ],
    });

    await expect(
      reviewCategoryRequest(built.deps, approve),
    ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
    expect(built.audit.log).not.toHaveBeenCalled();
  });
});

describe("reviewCategoryRequest: the shared naming rule and its lock", () => {
  it("refuses an approval whose slug is the one another category's CURRENT name derives", async () => {
    const built = buildDeps({
      // Renamed since: slug `jazz` stayed, nothing stores `experimental-jazz`,
      // and "Experimental-Jazz" is not the requested name "Experimental Jazz".
      categories: [categoryRow({ slug: "jazz", name: "Experimental-Jazz" })],
    });

    await expect(
      reviewCategoryRequest(built.deps, approve),
    ).rejects.toMatchObject({
      code: "CATEGORY_ALREADY_EXISTS",
      meta: { field: "name" },
    });

    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
  });

  it("an approval takes the naming lock BEFORE it claims the request row", async () => {
    const built = buildDeps();

    await reviewCategoryRequest(built.deps, approve);

    expect(built.categories.lockNaming).toHaveBeenCalledTimes(1);
    const lockOrder = built.categories.lockNaming.mock.invocationCallOrder[0]!;
    // Same order as createCategory (naming lock, then request rows): the
    // opposite order here is the deadlock.
    expect(lockOrder).toBeLessThan(
      built.categoryRequests.claimPendingForReview.mock.invocationCallOrder[0]!,
    );
    expect(lockOrder).toBeLessThan(
      built.categories.getBySlug.mock.invocationCallOrder[0]!,
    );
  });

  it("a rejection creates nothing and does not take the naming lock", async () => {
    const built = buildDeps();

    await reviewCategoryRequest(built.deps, { ...approve, decision: "REJECT" });

    expect(built.categories.lockNaming).not.toHaveBeenCalled();
    expect(built.categoryRequests.claimPendingForReview).toHaveBeenCalledTimes(
      1,
    );
  });
});

describe("reviewCategoryRequest: the category already exists", () => {
  it("approves onto the existing category without checking the name", async () => {
    // The name check must run only after the slug lookup misses. Hoisting it
    // above the early return would refuse this approval (same name, same slug).
    const existing = categoryRow({
      id: "eeeeeeee-1111-4111-8111-111111111111",
      slug: "experimental-jazz",
      name: "Experimental Jazz",
    });
    const built = buildDeps({ categories: [existing] });

    const result = await reviewCategoryRequest(built.deps, approve);

    expect(result.request).toMatchObject({
      status: "APPROVED",
      resolvedCategoryId: existing.id,
    });
    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.categories.listAll).not.toHaveBeenCalled();
  });
});

describe("reviewCategoryRequest: a name-only race with createCategory", () => {
  it("maps a unique violation from the insert to CATEGORY_ALREADY_EXISTS", async () => {
    const built = buildDeps({
      createError: Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      }),
    });

    await expect(
      reviewCategoryRequest(built.deps, approve),
    ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

    expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("rethrows any other error from the insert untouched", async () => {
    const boom = new Error("connection reset");
    const built = buildDeps({ createError: boom });

    await expect(reviewCategoryRequest(built.deps, approve)).rejects.toBe(boom);
  });
});

describe("reviewCategoryRequest: translations on approval", () => {
  it("stores the es name on the category the approval creates and audits it", async () => {
    const built = buildDeps({ categories: [categoryRow({ sortOrder: 3 })] });

    await reviewCategoryRequest(built.deps, {
      ...approve,
      translations: { es: "Jazz experimental" },
    });

    // English name and slug come from the request, as before.
    expect(built.categories.create).toHaveBeenCalledWith({
      slug: "experimental-jazz",
      name: "Experimental Jazz",
      active: true,
      sortOrder: 4,
      nameTranslations: { es: "Jazz experimental" },
    });
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "category_request.reviewed",
        data: expect.objectContaining({
          nameTranslations: { es: "Jazz experimental" },
        }),
      }),
    );
  });

  it("refuses an es name another category has, whatever the case", async () => {
    const built = buildDeps({
      categories: [
        categoryRow({ nameTranslations: { es: "Jazz Experimental" } }),
      ],
    });

    await expect(
      reviewCategoryRequest(built.deps, {
        ...approve,
        translations: { es: "jazz experimental" },
      }),
    ).rejects.toMatchObject({
      code: "CATEGORY_ALREADY_EXISTS",
      meta: { field: "nameTranslations", locale: "es" },
    });

    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("ignores translations when the request resolves to an existing category", async () => {
    const existing = categoryRow({
      id: "eeeeeeee-1111-4111-8111-111111111111",
      slug: "experimental-jazz",
      name: "Experimental Jazz",
    });
    const built = buildDeps({ categories: [existing] });

    await reviewCategoryRequest(built.deps, {
      ...approve,
      translations: { es: "Jazz experimental" },
    });

    expect(built.categories.create).not.toHaveBeenCalled();
    const auditData = built.audit.log.mock.calls[0]?.[0]?.data;
    expect(auditData).not.toHaveProperty("nameTranslations");
  });

  it("ignores translations on a rejection, even ones that break the rules", async () => {
    const built = buildDeps();

    const result = await reviewCategoryRequest(built.deps, {
      ...approve,
      decision: "REJECT",
      translations: { es: "www.x.com" },
    });

    expect(result.request.status).toBe("REJECTED");
    expect(built.categories.create).not.toHaveBeenCalled();
  });
});

describe("reviewCategoryRequest: the English name on approval (FR-007)", () => {
  // A request an organiser made in Spanish: its text is the es name.
  const spanish = {
    requestName: "Música en vivo",
    requestSlug: "musica-en-vivo",
    requestLocale: "es",
  } as const;

  it("takes name and slug from the English name and stores the requested text as es", async () => {
    const built = buildDeps({ ...spanish, categories: [categoryRow({ sortOrder: 3 })] });

    const result = await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "  Live   Music ",
    });

    expect(built.categories.getBySlug).toHaveBeenCalledWith("live-music");
    expect(built.categories.getBySlug).not.toHaveBeenCalledWith(
      "musica-en-vivo",
    );
    expect(built.categories.create).toHaveBeenCalledWith({
      slug: "live-music",
      name: "Live Music",
      active: true,
      sortOrder: 4,
      nameTranslations: { es: "Música en vivo" },
    });
    expect(result.request).toMatchObject({
      status: "APPROVED",
      resolvedCategoryId: NEW_CATEGORY_ID,
    });
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "category_request.reviewed",
        data: expect.objectContaining({
          resolution: "created",
          categoryName: "Live Music",
          nameTranslations: { es: "Música en vivo" },
        }),
      }),
    );
  });

  it("refuses a Spanish request approved without an English name, and writes nothing", async () => {
    const built = buildDeps(spanish);

    await expect(
      reviewCategoryRequest(built.deps, approve),
    ).rejects.toMatchObject({
      code: "CATEGORY_ENGLISH_NAME_REQUIRED",
      meta: { locale: "es" },
    });

    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("still lets a Spanish request be rejected without an English name", async () => {
    const built = buildDeps(spanish);

    const result = await reviewCategoryRequest(built.deps, {
      ...approve,
      decision: "REJECT",
    });

    expect(result.request.status).toBe("REJECTED");
  });

  it("lets explicit translations replace the requested es text", async () => {
    const built = buildDeps(spanish);

    await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Live Music",
      translations: { es: "Música en directo" },
    });

    expect(built.categories.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nameTranslations: { es: "Música en directo" },
      }),
    );
  });

  it("lets an explicit null clear the requested es text", async () => {
    const built = buildDeps(spanish);

    await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Live Music",
      translations: { es: null },
    });

    expect(built.categories.create).toHaveBeenCalledWith(
      expect.objectContaining({ nameTranslations: {} }),
    );
  });

  it("resolves onto a category that already carries the requested text in es, whatever the case", async () => {
    const existing = categoryRow({
      id: "eeeeeeee-2222-4222-8222-222222222222",
      slug: "concerts",
      name: "Concerts",
      nameTranslations: { es: "MÚSICA EN VIVO" },
    });
    const built = buildDeps({ ...spanish, categories: [existing] });

    const result = await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Live Music",
    });

    expect(result.request).toMatchObject({
      status: "APPROVED",
      resolvedCategoryId: existing.id,
    });
    expect(built.categories.create).not.toHaveBeenCalled();
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolution: "translatedName",
          categoryName: "Concerts",
          resolvedCategoryId: existing.id,
        }),
      }),
    );
    const auditData = built.audit.log.mock.calls[0]?.[0]?.data;
    expect(auditData).not.toHaveProperty("nameTranslations");
  });

  it("resolves onto the category at the English name's slug before anything else", async () => {
    const existing = categoryRow({
      id: "eeeeeeee-3333-4333-8333-333333333333",
      slug: "live-music",
      name: "Live Music",
    });
    const built = buildDeps({ ...spanish, categories: [existing] });

    const result = await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Live Music",
    });

    expect(result.request.resolvedCategoryId).toBe(existing.id);
    expect(built.categories.create).not.toHaveBeenCalled();
  });

  it("refuses when the English name belongs to another category under a different slug", async () => {
    const built = buildDeps({
      ...spanish,
      categories: [categoryRow({ slug: "gigs", name: "live music" })],
    });

    await expect(
      reviewCategoryRequest(built.deps, { ...approve, name: "Live Music" }),
    ).rejects.toMatchObject({
      code: "CATEGORY_ALREADY_EXISTS",
      meta: { field: "name" },
    });
    expect(built.categories.create).not.toHaveBeenCalled();
  });

  it("refuses an English name that breaks the word rules, before the transaction", async () => {
    const built = buildDeps(spanish);

    await expect(
      reviewCategoryRequest(built.deps, { ...approve, name: "see www.x.com" }),
    ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });
    expect(built.categories.lockNaming).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["en", "en"],
  ])(
    "approves a request with locale %s from its own name, as before",
    async (_label, requestLocale) => {
      const built = buildDeps({ requestLocale });

      await reviewCategoryRequest(built.deps, approve);

      expect(built.categories.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "experimental-jazz",
          name: "Experimental Jazz",
          nameTranslations: {},
        }),
      );
    },
  );

  it("lets staff give an English request a different English name too", async () => {
    const built = buildDeps({ requestLocale: "en" });

    await reviewCategoryRequest(built.deps, {
      ...approve,
      name: "Free Jazz",
    });

    expect(built.categories.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "free-jazz",
        name: "Free Jazz",
        nameTranslations: {},
      }),
    );
  });
});
