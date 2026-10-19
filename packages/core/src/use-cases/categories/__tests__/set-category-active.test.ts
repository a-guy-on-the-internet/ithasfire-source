import { describe, expect, it } from "vitest";

import { setCategoryActive } from "../set-category-active";
import {
  ACTOR_ID,
  COMEDY_ID,
  FIXED_NOW,
  JAZZ_ID,
  UNKNOWN_ID,
  buildCategoryDeps,
  expectNothingWritten,
  expectReposUntouched,
  type StaffRole,
} from "./category-lifecycle-harness";

const setActive = (
  built: ReturnType<typeof buildCategoryDeps>,
  input: Record<string, unknown>,
) => setCategoryActive(built.deps, { actorHumanId: ACTOR_ID, ...input });

describe("setCategoryActive", () => {
  it.each<StaffRole>(["ADMIN", "DEVELOPER"])(
    "lets a platform %s deactivate a category",
    async (role) => {
      const built = buildCategoryDeps({ actorRoles: [role] });

      const result = await setActive(built, {
        categoryId: JAZZ_ID,
        active: false,
      });

      expect(result.category.active).toBe(false);
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
      setActive(built, { categoryId: JAZZ_ID, active: false }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expectReposUntouched(built);
    expect(built.rows.find((row) => row.id === JAZZ_ID)?.active).toBe(true);
  });

  it("deactivates and writes a category.deactivated audit row", async () => {
    const built = buildCategoryDeps();

    const result = await setActive(built, {
      categoryId: JAZZ_ID,
      active: false,
    });

    expect(result).toEqual({
      category: {
        id: JAZZ_ID,
        slug: "jazz",
        name: "Jazz",
        names: { en: "Jazz" },
        seoType: "Event",
        active: false,
        sortOrder: 2,
      },
    });
    expect(built.categories.setActive).toHaveBeenCalledTimes(1);
    expect(built.categories.setActive).toHaveBeenCalledWith(JAZZ_ID, false);
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: JAZZ_ID,
      action: "category.deactivated",
      data: {
        actorHumanId: ACTOR_ID,
        slug: "jazz",
        name: "Jazz",
        previousActive: true,
        active: false,
      },
      at: FIXED_NOW,
    });
  });

  it("reactivates and writes a category.reactivated audit row", async () => {
    const built = buildCategoryDeps();

    const result = await setActive(built, {
      categoryId: COMEDY_ID,
      active: true,
    });

    expect(result.category).toMatchObject({ id: COMEDY_ID, active: true });
    expect(built.categories.setActive).toHaveBeenCalledWith(COMEDY_ID, true);
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: COMEDY_ID,
      action: "category.reactivated",
      data: {
        actorHumanId: ACTOR_ID,
        slug: "comedy",
        name: "Comedy",
        previousActive: false,
        active: true,
      },
      at: FIXED_NOW,
    });
  });

  it.each([
    ["deactivating an inactive category", COMEDY_ID, false],
    ["reactivating an active category", JAZZ_ID, true],
  ])(
    "%s succeeds without a write or an audit row",
    async (_label, categoryId, active) => {
      const built = buildCategoryDeps();

      const result = await setActive(built, { categoryId, active });

      expect(result.category).toMatchObject({ id: categoryId, active });
      expectNothingWritten(built);
    },
  );

  it("answers CATEGORY_NOT_FOUND for an id that does not exist", async () => {
    const built = buildCategoryDeps();

    await expect(
      setActive(built, { categoryId: UNKNOWN_ID, active: false }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expectNothingWritten(built);
  });

  it("answers CATEGORY_NOT_FOUND when the row is deleted before the write", async () => {
    const built = buildCategoryDeps({ deletedBeforeWrite: [JAZZ_ID] });

    await expect(
      setActive(built, { categoryId: JAZZ_ID, active: false }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", { categoryId: JAZZ_ID, active: false, cascade: true }],
    ["a non-boolean active", { categoryId: JAZZ_ID, active: "false" }],
    ["a missing active", { categoryId: JAZZ_ID }],
  ])("refuses %s (strict schema)", async (_label, input) => {
    const built = buildCategoryDeps();

    await expect(setActive(built, input)).rejects.toMatchObject({
      code: "invalid_input",
    });

    expectReposUntouched(built);
  });
});
