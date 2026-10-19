import { describe, expect, it } from "vitest";

import { reorderCategories } from "../reorder-categories";
import {
  ACTOR_ID,
  COMEDY_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  UNKNOWN_ID,
  buildCategoryDeps,
  categoryRow,
  expectNothingWritten,
  expectReposUntouched,
  type StaffRole,
} from "./category-lifecycle-harness";

const reorder = (
  built: ReturnType<typeof buildCategoryDeps>,
  orderedCategoryIds: unknown,
  extra: Record<string, unknown> = {},
) =>
  reorderCategories(built.deps, {
    actorHumanId: ACTOR_ID,
    orderedCategoryIds,
    ...extra,
  });

const sortOrders = (built: ReturnType<typeof buildCategoryDeps>) =>
  Object.fromEntries(built.rows.map((row) => [row.id, row.sortOrder]));

describe("reorderCategories", () => {
  it.each<StaffRole>(["ADMIN", "DEVELOPER"])(
    "lets a platform %s reorder",
    async (role) => {
      const built = buildCategoryDeps({ actorRoles: [role] });

      const result = await reorder(built, [COMEDY_ID, MUSIC_ID, JAZZ_ID]);

      expect(result.categories.map((c) => c.id)).toEqual([
        COMEDY_ID,
        MUSIC_ID,
        JAZZ_ID,
      ]);
      expect(built.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "DEVELOPER"],
      });
    },
  );

  it.each<[string, StaffRole[]]>([
    ["a REVIEWER", ["REVIEWER"]],
    ["a signed-in human with no staff role", []],
  ])("refuses %s before any read", async (_label, actorRoles) => {
    const built = buildCategoryDeps({ actorRoles });

    await expect(
      reorder(built, [COMEDY_ID, MUSIC_ID, JAZZ_ID]),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expectReposUntouched(built);
  });

  it("writes 1..n in the given order, returns the full list, and audits once", async () => {
    const built = buildCategoryDeps();

    const result = await reorder(built, [COMEDY_ID, MUSIC_ID, JAZZ_ID]);

    expect(result).toEqual({
      categories: [
        {
          id: COMEDY_ID,
          slug: "comedy",
          name: "Comedy",
          names: { en: "Comedy" },
          seoType: "Event",
          active: false,
          sortOrder: 1,
        },
        {
          id: MUSIC_ID,
          slug: "music",
          name: "Music",
          names: { en: "Music" },
          seoType: "Event",
          active: true,
          sortOrder: 2,
        },
        {
          id: JAZZ_ID,
          slug: "jazz",
          name: "Jazz",
          names: { en: "Jazz" },
          seoType: "Event",
          active: true,
          sortOrder: 3,
        },
      ],
    });
    expect(sortOrders(built)).toEqual({
      [COMEDY_ID]: 1,
      [MUSIC_ID]: 2,
      [JAZZ_ID]: 3,
    });
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: null,
      action: "category.reordered",
      data: {
        actorHumanId: ACTOR_ID,
        previousOrderedCategoryIds: [MUSIC_ID, JAZZ_ID, COMEDY_ID],
        orderedCategoryIds: [COMEDY_ID, MUSIC_ID, JAZZ_ID],
        changedCount: 3,
      },
      at: FIXED_NOW,
    });
  });

  it("writes only the rows whose sortOrder changes", async () => {
    const built = buildCategoryDeps();

    // Music stays 1; Jazz and Comedy swap.
    await reorder(built, [MUSIC_ID, COMEDY_ID, JAZZ_ID]);

    expect(built.categories.setSortOrders).toHaveBeenCalledTimes(1);
    expect(built.categories.setSortOrders).toHaveBeenCalledWith([
      { id: COMEDY_ID, sortOrder: 2 },
      { id: JAZZ_ID, sortOrder: 3 },
    ]);
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changedCount: 2 }),
      }),
    );
  });

  it("takes the order lock inside the transaction, before it reads the list", async () => {
    const built = buildCategoryDeps();

    await reorder(built, [COMEDY_ID, MUSIC_ID, JAZZ_ID]);

    expect(built.tx).toHaveBeenCalledTimes(1);
    expect(built.categories.lockSortOrder).toHaveBeenCalledTimes(1);
    const lockOrder = built.categories.lockSortOrder.mock.invocationCallOrder[0]!;
    const readOrder = built.categories.listAll.mock.invocationCallOrder[0]!;
    const writeOrder =
      built.categories.setSortOrders.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(readOrder);
    expect(readOrder).toBeLessThan(writeOrder);
  });

  describe("no-op", () => {
    it("succeeds without a write or an audit row when the order already matches 1..n", async () => {
      const built = buildCategoryDeps();

      const result = await reorder(built, [MUSIC_ID, JAZZ_ID, COMEDY_ID]);

      expect(result.categories.map((c) => [c.id, c.sortOrder])).toEqual([
        [MUSIC_ID, 1],
        [JAZZ_ID, 2],
        [COMEDY_ID, 3],
      ]);
      expectNothingWritten(built);
    });

    it("accepts an empty list when there are no categories", async () => {
      const built = buildCategoryDeps({ categories: [] });

      await expect(reorder(built, [])).resolves.toEqual({ categories: [] });
      expectNothingWritten(built);
    });

    it("still renumbers when the order matches but the values are not 1..n", async () => {
      const built = buildCategoryDeps({
        categories: [
          categoryRow({ sortOrder: 0 }),
          categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 7 }),
        ],
      });

      await reorder(built, [MUSIC_ID, JAZZ_ID]);

      expect(built.categories.setSortOrders).toHaveBeenCalledWith([
        { id: MUSIC_ID, sortOrder: 1 },
        { id: JAZZ_ID, sortOrder: 2 },
      ]);
      expect(built.audit.log).toHaveBeenCalledTimes(1);
    });
  });

  describe("the input must be exactly the set of all category ids", () => {
    it("refuses a duplicate id before any read", async () => {
      const built = buildCategoryDeps();

      await expect(
        reorder(built, [MUSIC_ID, JAZZ_ID, JAZZ_ID, COMEDY_ID]),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        meta: {
          field: "orderedCategoryIds",
          reason: "duplicate_id",
          ids: [JAZZ_ID],
        },
      });

      expectReposUntouched(built);
    });

    it("refuses an id that is not a category", async () => {
      const built = buildCategoryDeps();

      await expect(
        reorder(built, [MUSIC_ID, JAZZ_ID, COMEDY_ID, UNKNOWN_ID]),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        meta: {
          field: "orderedCategoryIds",
          reason: "unknown_id",
          ids: [UNKNOWN_ID],
        },
      });

      expectNothingWritten(built);
    });

    it("refuses a list that leaves a category out, an inactive one included", async () => {
      const built = buildCategoryDeps();

      // Comedy is inactive: a client reading the public list never saw it.
      await expect(reorder(built, [JAZZ_ID, MUSIC_ID])).rejects.toMatchObject({
        code: "INVALID_INPUT",
        meta: {
          field: "orderedCategoryIds",
          reason: "missing_id",
          ids: [COMEDY_ID],
        },
      });

      expectNothingWritten(built);
      expect(sortOrders(built)).toEqual({
        [MUSIC_ID]: 1,
        [JAZZ_ID]: 2,
        [COMEDY_ID]: 3,
      });
    });

    it("carries at most 20 offending ids in the refusal, with the full count beside them", async () => {
      const built = buildCategoryDeps();
      const unknown = Array.from(
        { length: 25 },
        (_, i) => `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, "0")}`,
      );

      const error = await reorder(built, [
        MUSIC_ID,
        JAZZ_ID,
        COMEDY_ID,
        ...unknown,
      ]).catch((err: unknown) => err);

      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        meta: { reason: "unknown_id", idCount: 25 },
      });
      expect((error as { meta: { ids: string[] } }).meta.ids).toEqual(
        unknown.slice(0, 20),
      );
    });

    it("refuses an empty list when categories exist", async () => {
      const built = buildCategoryDeps();

      await expect(reorder(built, [])).rejects.toMatchObject({
        code: "INVALID_INPUT",
        meta: { reason: "missing_id" },
      });

      expectNothingWritten(built);
    });

    it.each([
      ["an id that is not a uuid", ["not-a-uuid"], {}],
      ["a non-array", "all", {}],
      ["an unknown key", [MUSIC_ID, JAZZ_ID, COMEDY_ID], { normalise: true }],
    ])("refuses %s (strict schema)", async (_label, ids, extra) => {
      const built = buildCategoryDeps();

      await expect(reorder(built, ids, extra)).rejects.toMatchObject({
        code: "invalid_input",
      });

      expectReposUntouched(built);
    });
  });

  it("fails with CATEGORY_NOT_FOUND and no audit row when a category is deleted before the write", async () => {
    const built = buildCategoryDeps({ deletedBeforeWrite: [JAZZ_ID] });

    await expect(
      reorder(built, [COMEDY_ID, MUSIC_ID, JAZZ_ID]),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(built.audit.log).not.toHaveBeenCalled();
  });
});
