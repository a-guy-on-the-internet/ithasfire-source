import { describe, expect, it, vi } from "vitest";

import type { CategorySlugRecord } from "@th/ports/repos/categories";

import { createCategory } from "../create-category";
import type { CreateCategoryDeps } from "../create-category";
import { requestCategoryOption } from "../request-category-option";
import type { RequestCategoryOptionDeps } from "../request-category-option";
import { createSlugTable, currentEnRows } from "./category-lifecycle-harness";

// Only used by the request-path half of the slug-parity test below.
vi.mock("../../../lib/event-edit-rights", () => ({
  ensureActorHoldsHumanEventRole: vi.fn(async () => undefined),
}));

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REQUESTER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_REVIEWER_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEW_CATEGORY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REQUEST_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const REQUEST_C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const FIXED_NOW = new Date("2026-10-11T12:00:00Z");
const EARLIER = new Date("2026-10-01T00:00:00Z");

type StaffRole = "ADMIN" | "DEVELOPER" | "REVIEWER";

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

type RequestRow = {
  id: string;
  kind: "CATEGORY";
  status: "PENDING" | "APPROVED" | "REJECTED";
  name: string;
  slug: string;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  eventId: string | null;
  requesterHumanId: string;
  reviewedByHumanId: string | null;
  reviewNote: string | null;
  resolvedCategoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
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

function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: REQUEST_A,
    kind: "CATEGORY",
    status: "PENDING",
    name: "Experimental Jazz",
    slug: "experimental-jazz",
    categoryId: null,
    categorySlug: null,
    categoryName: null,
    eventId: EVENT_ID,
    requesterHumanId: REQUESTER_ID,
    reviewedByHumanId: null,
    reviewNote: null,
    resolvedCategoryId: null,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    reviewedAt: null,
    ...overrides,
  };
}

/**
 * In-memory repos that behave like the Prisma adapters where it matters here:
 * `claimPendingForReview` only takes an unclaimed PENDING row, and `create`
 * can be made to throw what Prisma throws on a unique violation.
 */
function buildDeps(
  overrides: {
    /** Staff roles the actor holds; [] is a signed-in non-staff human. */
    actorRoles?: StaffRole[];
    categories?: CategoryRow[];
    requests?: RequestRow[];
    createError?: unknown;
    /** CategorySlug rows; default one current en row per category. */
    slugs?: CategorySlugRecord[];
  } = {},
) {
  const actorRoles = overrides.actorRoles ?? ["ADMIN"];
  const categoryRows = [...(overrides.categories ?? [])];
  const slugTable = createSlugTable(
    categoryRows,
    overrides.slugs ?? currentEnRows(categoryRows),
  );
  const requestRows = (overrides.requests ?? []).map((row) => ({ ...row }));

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
        seoType?: string;
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
          seoType: input.seoType ?? "Event",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        });
        categoryRows.push(row);
        // The adapter's create writes the current en slug row too.
        slugTable.addCurrentEn(row.id, row.slug);
        return row;
      },
    ),
  };

  const categoryRequests = {
    listPendingBySlug: vi.fn(async (slug: string) =>
      requestRows
        .filter((row) => row.status === "PENDING" && row.slug === slug)
        .map((row) => ({ ...row })),
    ),
    claimPendingForReview: vi.fn(
      async (input: {
        id: string;
        reviewedByHumanId: string;
        reviewedAt: Date;
      }) => {
        const row = requestRows.find((candidate) => candidate.id === input.id);
        if (
          !row ||
          row.status !== "PENDING" ||
          row.reviewedByHumanId !== null ||
          row.reviewedAt !== null
        ) {
          return null;
        }
        row.reviewedByHumanId = input.reviewedByHumanId;
        row.reviewedAt = input.reviewedAt;
        return { ...row };
      },
    ),
    markReviewed: vi.fn(
      async (input: {
        id: string;
        status: "APPROVED" | "REJECTED";
        reviewedByHumanId: string;
        reviewedAt: Date;
        reviewNote?: string | null;
        resolvedCategoryId?: string | null;
      }) => {
        const row = requestRows.find((candidate) => candidate.id === input.id);
        if (!row) throw new Error("request_not_found");
        row.status = input.status;
        row.reviewedByHumanId = input.reviewedByHumanId;
        row.reviewedAt = input.reviewedAt;
        row.reviewNote = input.reviewNote ?? null;
        row.resolvedCategoryId = input.resolvedCategoryId ?? null;
        return { ...row };
      },
    ),
  };

  const audit = { log: vi.fn() };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ categories, categoryRequests, audit }),
  );

  const hasStaffRole = vi.fn(
    async (input: { actorHumanId: string; requiredRoles: string[] }) => ({
      allowed: actorRoles.some((role) => input.requiredRoles.includes(role)),
    }),
  );

  const deps: CreateCategoryDeps = {
    repos: {
      categories,
      categoryRequests,
      audit,
      tx,
    } as unknown as CreateCategoryDeps["repos"],
    authz: { hasStaffRole } as unknown as CreateCategoryDeps["authz"],
    clock: { now: () => FIXED_NOW } as unknown as CreateCategoryDeps["clock"],
  };

  return {
    deps,
    categories,
    categoryRequests,
    audit,
    slugs: slugTable.slugs,
    tx,
    hasStaffRole,
    categoryRows,
    requestRows,
  };
}

function expectNothingWritten(built: ReturnType<typeof buildDeps>) {
  expect(built.categories.create).not.toHaveBeenCalled();
  expect(built.categoryRequests.claimPendingForReview).not.toHaveBeenCalled();
  expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
  expect(built.audit.log).not.toHaveBeenCalled();
}

describe("createCategory", () => {
  describe("who may create", () => {
    it.each<[StaffRole]>([["ADMIN"], ["DEVELOPER"]])(
      "lets a platform %s create a category",
      async (role) => {
        const built = buildDeps({ actorRoles: [role] });

        const result = await createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
          seoType: "MusicEvent",
        });

        expect(result).toEqual({
          category: {
            id: NEW_CATEGORY_ID,
            slug: "live-music",
            name: "Live Music",
            names: { en: "Live Music" },
            seoType: "MusicEvent",
            active: true,
            sortOrder: 1,
          },
          resolvedRequestCount: 0,
        });
        expect(built.hasStaffRole).toHaveBeenCalledWith({
          actorHumanId: ACTOR_ID,
          requiredRoles: ["ADMIN", "DEVELOPER"],
        });
        expect(built.categories.create).toHaveBeenCalledWith({
          slug: "live-music",
          name: "Live Music",
          active: true,
          sortOrder: 1,
          seoType: "MusicEvent",
          nameTranslations: {},
        });
      },
    );

    it.each<[string, StaffRole[]]>([
      ["a REVIEWER", ["REVIEWER"]],
      ["a human with no staff role", []],
    ])("refuses %s and writes nothing", async (_label, actorRoles) => {
      const built = buildDeps({
        actorRoles,
        requests: [requestRow({ slug: "live-music", name: "Live Music" })],
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });

      expect(built.tx).not.toHaveBeenCalled();
      expectNothingWritten(built);
      expect(built.requestRows[0]).toMatchObject({
        status: "PENDING",
        resolvedCategoryId: null,
      });
    });
  });

  describe("name and slug", () => {
    it("normalises the name and derives the slug from it", async () => {
      const built = buildDeps();

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "  Café   SOCIÉTÉ  Nights ",
      });

      expect(result.category).toMatchObject({
        name: "Café SOCIÉTÉ Nights",
        slug: "cafe-societe-nights",
      });
    });

    it.each([
      ["  Café   SOCIÉTÉ  Nights "],
      ["Rock & Roll"],
      ["DJ's Night+Day"],
      ["ÉLECTRO Pop-Up"],
    ])(
      "gives %j the name and slug a category request for it stores",
      async (rawName) => {
        const requestCreate = vi.fn(
          async (input: { name: string; slug: string }) =>
            requestRow({ name: input.name, slug: input.slug }),
        );
        const requestDeps = {
          repos: {
            tx: async (fn: (txRepos: unknown) => Promise<unknown>) =>
              fn({
                categories: {
                  getBySlug: async () => null,
                  listAll: async () => [],
                },
                categoryRequests: {
                  findPending: async () => null,
                  create: requestCreate,
                },
                events: {
                  getById: async () => ({
                    id: EVENT_ID,
                    orgId: null,
                    humanId: REQUESTER_ID,
                    status: "DRAFT",
                  }),
                },
                audit: { log: vi.fn() },
                authz: {},
              }),
          },
          clock: { now: () => FIXED_NOW },
          contentFilter: { hasBlockedContent: async () => false },
        } as unknown as RequestCategoryOptionDeps;

        const { request } = await requestCategoryOption(requestDeps, {
          actorHumanId: REQUESTER_ID,
          eventId: EVENT_ID,
          kind: "CATEGORY",
          name: rawName,
        });

        const built = buildDeps();
        const { category } = await createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: rawName,
        });

        expect(category.slug).toBe(request.slug);
        expect(category.name).toBe(request.name);
      },
    );

    it.each([
      ["a link", "see https://example.com"],
      ["a character outside the allowed set", "Jazz / Blues"],
      ["a name that slugs to nothing", "音楽の夜"],
    ])("refuses %s", async (_label, name) => {
      const built = buildDeps();

      await expect(
        createCategory(built.deps, { actorHumanId: ACTOR_ID, name }),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });

      expectNothingWritten(built);
    });

    it("strips markup from the name before it is validated", async () => {
      const built = buildDeps();

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "<b>Live</b> Music",
      });

      expect(result.category).toMatchObject({
        name: "Live Music",
        slug: "live-music",
      });
    });
  });

  describe("duplicates", () => {
    it("refuses a slug that is already a category", async () => {
      const built = buildDeps({
        // Same slug, a different name: the slug alone must refuse it.
        categories: [categoryRow({ slug: "live-music", name: "Gigs" })],
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
        }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "slug" },
      });

      expectNothingWritten(built);
    });

    it.each([
      ["the same name", "Live Music"],
      ["the same name in another case", "LIVE music"],
    ])("refuses %s under a different slug", async (_label, name) => {
      const built = buildDeps({
        // A seeded category whose slug was not derived from its name.
        categories: [categoryRow({ slug: "music", name: "Live Music" })],
      });

      await expect(
        createCategory(built.deps, { actorHumanId: ACTOR_ID, name }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "name" },
      });

      expectNothingWritten(built);
    });

    it("refuses a name whose slug is the one another category's CURRENT name derives", async () => {
      const built = buildDeps({
        // "Jazz" was renamed: the slug stayed `jazz`, so nothing stores
        // `improvised-music` and no name matches "Improvised-Music" exactly.
        categories: [categoryRow({ slug: "jazz", name: "Improvised Music" })],
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Improvised-Music",
        }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "name" },
      });

      expectNothingWritten(built);
    });

    it("refuses a slug taken by another category's old URL (it still 308s there)", async () => {
      // Gigs moved its URL from `live-music` to `gigs`; the old one is kept.
      const gigs = categoryRow({ slug: "gigs", name: "Gigs" });
      const built = buildDeps({
        categories: [gigs],
        slugs: [
          ...currentEnRows([gigs]),
          {
            categoryId: gigs.id,
            locale: "en",
            slug: "live-music",
            isCurrent: false,
            createdAt: EARLIER,
          },
        ],
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
        }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "slug" },
      });

      expect(built.categories.findSlugsBySlug).toHaveBeenCalledWith(
        "live-music",
      );
      expectNothingWritten(built);
    });

    it("refuses a slug that is another category's es slug (one category per slug string)", async () => {
      // Music's es slug is `musica`; a new en category "Musica" must not get it.
      const music = categoryRow();
      const built = buildDeps({
        categories: [music],
        slugs: [
          ...currentEnRows([music]),
          {
            categoryId: music.id,
            locale: "es",
            slug: "musica",
            isCurrent: true,
            createdAt: EARLIER,
          },
        ],
      });

      await expect(
        createCategory(built.deps, { actorHumanId: ACTOR_ID, name: "Musica" }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "slug" },
      });

      expectNothingWritten(built);
    });

    it("is not stopped by an old category whose name the rules cannot slug", async () => {
      const built = buildDeps({
        categories: [categoryRow({ slug: "kanji", name: "音楽" })],
      });

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      });

      expect(result.category.slug).toBe("live-music");
    });

    it("takes the naming lock once, before it reads anything or claims a request", async () => {
      const built = buildDeps({ requests: [requestRow({ id: REQUEST_A })] });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
      });

      expect(built.categories.lockNaming).toHaveBeenCalledTimes(1);
      const lockOrder = built.categories.lockNaming.mock.invocationCallOrder[0]!;
      expect(lockOrder).toBeLessThan(
        built.categories.listAll.mock.invocationCallOrder[0]!,
      );
      expect(lockOrder).toBeLessThan(
        built.categoryRequests.listPendingBySlug.mock.invocationCallOrder[0]!,
      );
      // Naming lock THEN request rows: the order `reviewCategoryRequest` uses.
      expect(lockOrder).toBeLessThan(
        built.categoryRequests.claimPendingForReview.mock
          .invocationCallOrder[0]!,
      );
    });

    it("maps a unique violation on insert to CATEGORY_ALREADY_EXISTS", async () => {
      // What Prisma throws when another creator's insert won the race.
      const p2002 = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      const built = buildDeps({ createError: p2002 });

      const error = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      }).catch((err: unknown) => err);

      expect(error).toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });
      expect((error as { cause?: unknown }).cause).toBe(p2002);
      expect(built.categories.create).toHaveBeenCalledTimes(1);
      expect(built.audit.log).not.toHaveBeenCalled();
    });

    it("rethrows any other repo failure untouched", async () => {
      const boom = Object.assign(new Error("connection lost"), {
        code: "P1001",
      });
      const built = buildDeps({ createError: boom });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
        }),
      ).rejects.toBe(boom);
    });
  });

  describe("sort order", () => {
    it("is 1 when there are no categories", async () => {
      const built = buildDeps({ categories: [] });

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      });

      expect(result.category.sortOrder).toBe(1);
    });

    it("is one past the highest in use, gaps and inactive rows included", async () => {
      const built = buildDeps({
        categories: [
          categoryRow({ id: "1", slug: "music", name: "Music", sortOrder: 2 }),
          categoryRow({
            id: "2",
            slug: "comedy",
            name: "Comedy",
            sortOrder: 9,
            active: false,
          }),
          categoryRow({ id: "3", slug: "film", name: "Film", sortOrder: 4 }),
        ],
      });

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Theatre",
      });

      expect(result.category.sortOrder).toBe(10);
      expect(built.categories.create).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 10, active: true }),
      );
    });
  });

  describe("seoType", () => {
    it('defaults to "Event"', async () => {
      const built = buildDeps();

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      });

      expect(result.category.seoType).toBe("Event");
      expect(built.categories.create).toHaveBeenCalledWith(
        expect.objectContaining({ seoType: "Event" }),
      );
    });

    it("rejects a seoType outside the allowlist at the boundary", async () => {
      const built = buildDeps();

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
          seoType: "MovieEvent",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(built.hasStaffRole).not.toHaveBeenCalled();
      expectNothingWritten(built);
    });

    it("rejects unknown input keys", async () => {
      const built = buildDeps();

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
          slug: "something-else",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expectNothingWritten(built);
    });
  });

  describe("pending requests for the new slug", () => {
    it("approves the matching PENDING request and leaves the others alone", async () => {
      const rejected = requestRow({
        id: REQUEST_B,
        status: "REJECTED",
        reviewedByHumanId: OTHER_REVIEWER_ID,
        reviewedAt: EARLIER,
        reviewNote: "not now",
      });
      const otherSlug = requestRow({
        id: REQUEST_C,
        slug: "ambient",
        name: "Ambient",
      });
      const built = buildDeps({
        requests: [requestRow({ id: REQUEST_A }), rejected, otherSlug],
      });

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
      });

      expect(result.resolvedRequestCount).toBe(1);
      expect(built.categoryRequests.listPendingBySlug).toHaveBeenCalledWith(
        "experimental-jazz",
      );

      const [matching, stillRejected, stillPending] = built.requestRows;
      expect(matching).toMatchObject({
        id: REQUEST_A,
        status: "APPROVED",
        resolvedCategoryId: NEW_CATEGORY_ID,
        reviewedByHumanId: ACTOR_ID,
        reviewedAt: FIXED_NOW,
        reviewNote: null,
      });
      expect(stillRejected).toEqual(rejected);
      expect(stillPending).toEqual(otherSlug);

      expect(built.categoryRequests.markReviewed).toHaveBeenCalledTimes(1);
      expect(built.categoryRequests.markReviewed).toHaveBeenCalledWith({
        id: REQUEST_A,
        status: "APPROVED",
        reviewedByHumanId: ACTOR_ID,
        reviewedAt: FIXED_NOW,
        reviewNote: null,
        resolvedCategoryId: NEW_CATEGORY_ID,
      });
    });

    it("writes the audit row a staff approval writes, per request", async () => {
      const built = buildDeps({ requests: [requestRow({ id: REQUEST_A })] });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
      });

      expect(built.audit.log).toHaveBeenCalledWith({
        entity: "event_category_request",
        entityId: REQUEST_A,
        action: "category_request.reviewed",
        data: {
          actorHumanId: ACTOR_ID,
          decision: "APPROVE",
          status: "APPROVED",
          reviewNote: null,
          resolvedCategoryId: NEW_CATEGORY_ID,
        },
        at: FIXED_NOW,
      });
    });

    it("claims the requests before it inserts the category", async () => {
      const built = buildDeps({ requests: [requestRow({ id: REQUEST_A })] });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
      });

      const claimOrder =
        built.categoryRequests.claimPendingForReview.mock
          .invocationCallOrder[0]!;
      const createOrder = built.categories.create.mock.invocationCallOrder[0]!;
      const markOrder =
        built.categoryRequests.markReviewed.mock.invocationCallOrder[0]!;
      expect(claimOrder).toBeLessThan(createOrder);
      expect(createOrder).toBeLessThan(markOrder);
    });

    it("leaves a request another reviewer rejected first alone, and still creates the category", async () => {
      // In the real adapter a null claim means the row is no longer
      // PENDING-and-unclaimed: the other reviewer's transaction committed.
      const rejected = requestRow({
        id: REQUEST_A,
        status: "REJECTED",
        reviewedByHumanId: OTHER_REVIEWER_ID,
        reviewedAt: EARLIER,
      });
      const built = buildDeps({ requests: [rejected] });
      // Our list read a stale PENDING copy, taken before their commit.
      built.categoryRequests.listPendingBySlug.mockImplementationOnce(
        async () => [requestRow({ id: REQUEST_A })],
      );

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
      });

      expect(
        built.categoryRequests.claimPendingForReview,
      ).toHaveBeenCalledTimes(1);
      expect(result.resolvedRequestCount).toBe(0);
      expect(built.categories.create).toHaveBeenCalledTimes(1);
      expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
      expect(built.audit.log).toHaveBeenCalledTimes(1);
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "category",
          data: expect.objectContaining({ resolvedRequestIds: [] }),
        }),
      );
      expect(built.requestRows[0]).toEqual(rejected);
    });

    it("refuses with CATEGORY_ALREADY_EXISTS when another reviewer approved the request first", async () => {
      // Their approval created the category, so our claim comes back null and
      // our insert hits the unique index.
      const approved = requestRow({
        id: REQUEST_A,
        status: "APPROVED",
        reviewedByHumanId: OTHER_REVIEWER_ID,
        reviewedAt: EARLIER,
        resolvedCategoryId: NEW_CATEGORY_ID,
      });
      const built = buildDeps({
        requests: [approved],
        createError: Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        }),
      });
      built.categoryRequests.listPendingBySlug.mockImplementationOnce(
        async () => [requestRow({ id: REQUEST_A })],
      );

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Experimental Jazz",
        }),
      ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

      expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
      expect(built.audit.log).not.toHaveBeenCalled();
      expect(built.requestRows[0]).toEqual(approved);
    });

    it("does not call markReviewed or write an audit row when the insert loses the race", async () => {
      const built = buildDeps({
        requests: [requestRow({ id: REQUEST_A })],
        createError: Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        }),
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Experimental Jazz",
        }),
      ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

      expect(built.categoryRequests.markReviewed).not.toHaveBeenCalled();
      expect(built.audit.log).not.toHaveBeenCalled();
    });
  });

  describe("translations", () => {
    it("writes the en slug row and, for an es name, the es slug", async () => {
      const built = buildDeps({ categories: [categoryRow()] });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
        translations: { es: "Música en vivo" },
      });

      expect(
        built.slugs
          .filter((r) => r.categoryId === NEW_CATEGORY_ID)
          .map((r) => [r.locale, r.slug, r.isCurrent]),
      ).toEqual([
        ["en", "live-music", true],
        ["es", "musica-en-vivo", true],
      ]);
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "category.created",
          data: expect.objectContaining({ esSlug: "musica-en-vivo" }),
        }),
      );
    });

    it("writes no es slug without an es name", async () => {
      const built = buildDeps({ categories: [categoryRow()] });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      });

      expect(
        built.slugs.filter(
          (r) => r.categoryId === NEW_CATEGORY_ID && r.locale === "es",
        ),
      ).toEqual([]);
    });

    it("stores the es name, returns it in names, and audits it", async () => {
      const built = buildDeps({ categories: [categoryRow()] });

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
        translations: { es: "  Música   en vivo " },
      });

      expect(result.category.names).toEqual({
        en: "Live Music",
        es: "Música en vivo",
      });
      // The slug still derives from the English name.
      expect(result.category.slug).toBe("live-music");
      expect(built.categories.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "live-music",
          nameTranslations: { es: "Música en vivo" },
        }),
      );
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "category.created",
          data: expect.objectContaining({
            nameTranslations: { es: "Música en vivo" },
          }),
        }),
      );
    });

    it.each([
      ["null", null],
      ["blank", "  "],
    ])("stores no es name when it is %s", async (_label, es) => {
      const built = buildDeps();

      const result = await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
        translations: { es },
      });

      expect(result.category.names).toEqual({ en: "Live Music" });
      expect(built.categories.create).toHaveBeenCalledWith(
        expect.objectContaining({ nameTranslations: {} }),
      );
    });

    it("refuses an es name another category has, whatever the case", async () => {
      const built = buildDeps({
        categories: [categoryRow({ nameTranslations: { es: "Música" } })],
      });

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
          translations: { es: "música" },
        }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "nameTranslations", locale: "es" },
      });
      expect(built.categories.create).not.toHaveBeenCalled();
      expect(built.audit.log).not.toHaveBeenCalled();
    });

    it("refuses an es name that breaks the word rules, before any read", async () => {
      const built = buildDeps();

      await expect(
        createCategory(built.deps, {
          actorHumanId: ACTOR_ID,
          name: "Live Music",
          translations: { es: "www.musica.com" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });
      expect(built.tx).not.toHaveBeenCalled();
    });
  });

  describe("audit", () => {
    it("records the creation with the requests it resolved", async () => {
      const built = buildDeps({
        categories: [categoryRow({ sortOrder: 3 })],
        requests: [requestRow({ id: REQUEST_A })],
      });

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Experimental Jazz",
        seoType: "MusicEvent",
      });

      expect(built.audit.log).toHaveBeenCalledWith({
        entity: "category",
        entityId: NEW_CATEGORY_ID,
        action: "category.created",
        data: {
          actorHumanId: ACTOR_ID,
          slug: "experimental-jazz",
          name: "Experimental Jazz",
          seoType: "MusicEvent",
          sortOrder: 4,
          nameTranslations: {},
          resolvedRequestIds: [REQUEST_A],
        },
        at: FIXED_NOW,
      });
      expect(built.audit.log).toHaveBeenCalledTimes(2);
    });

    it("records an empty list when no request was waiting", async () => {
      const built = buildDeps();

      await createCategory(built.deps, {
        actorHumanId: ACTOR_ID,
        name: "Live Music",
      });

      expect(built.audit.log).toHaveBeenCalledTimes(1);
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "category.created",
          data: expect.objectContaining({ resolvedRequestIds: [] }),
        }),
      );
    });
  });
});
