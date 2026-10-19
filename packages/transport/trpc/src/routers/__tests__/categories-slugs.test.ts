import { afterEach, describe, expect, it, vi } from "vitest";

import * as categoryUseCases from "@th/core/use-cases/categories";
import { fail } from "@th/errors";

import type { Ctx } from "../../context";
import { categoriesRouter } from "../categories";
import { createCaller } from "./test-helpers";

// Category URL slugs (spanish-seo FR-009, FR-010, FR-012): the transport stays
// thin. resolveSlug is public; changeSlug takes the session's actor and the
// ctx reporter; the staff list carries each category's slug rows.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const staffAuthz = {
  hasOrgRole: vi.fn(),
  requireOrgRole: vi.fn(),
  canEditEvent: vi.fn(),
  canManagePlace: vi.fn(),
  canFinanceOrg: vi.fn(),
  hasStaffRole: vi.fn(async () => ({ allowed: true })),
} as unknown as Ctx["authz"];

afterEach(() => {
  vi.restoreAllMocks();
});

const anonymous = {
  actorHumanId: null,
  auth: null,
} as unknown as Partial<Ctx>;

describe("categories.resolveSlug", () => {
  it("is public and renders a current slug", async () => {
    const categories = {
      findSlug: vi.fn(async () => ({
        categoryId: CATEGORY_ID,
        locale: "es",
        slug: "musica",
        isCurrent: true,
        createdAt: new Date(),
      })),
    };
    const { caller } = createCaller(categoriesRouter, {
      ...anonymous,
      repos: { categories } as unknown as Ctx["repos"],
    });

    await expect(
      caller.resolveSlug({ locale: "es", slug: "musica" }),
    ).resolves.toEqual({
      kind: "render",
      categoryId: CATEGORY_ID,
      locale: "es",
      slug: "musica",
    });
    expect(categories.findSlug).toHaveBeenCalledWith("es", "musica");
  });

  it("a slug that breaks the rules is notFound without a read", async () => {
    const categories = { findSlug: vi.fn() };
    const { caller } = createCaller(categoriesRouter, {
      ...anonymous,
      repos: { categories } as unknown as Ctx["repos"],
    });

    await expect(
      caller.resolveSlug({ locale: "en", slug: "not a slug!" }),
    ).resolves.toEqual({ kind: "notFound" });
    expect(categories.findSlug).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "redirect", locale: "es", slug: "musica" }],
    [{ kind: "notFound" }],
  ] as const)("passes %j through", async (result) => {
    vi.spyOn(categoryUseCases, "resolveCategorySlug").mockResolvedValue(
      result as never,
    );
    const { caller } = createCaller(categoriesRouter, anonymous);

    await expect(
      caller.resolveSlug({ locale: "es", slug: "sonido" }),
    ).resolves.toEqual(result);
  });

  it("refuses an unknown locale, an unbounded slug and extra keys", async () => {
    const spy = vi.spyOn(categoryUseCases, "resolveCategorySlug");
    const { caller } = createCaller(categoriesRouter, anonymous);

    await expect(
      caller.resolveSlug({ locale: "fr", slug: "musique" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.resolveSlug({ locale: "en", slug: "a".repeat(201) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.resolveSlug({ locale: "en", slug: "music", x: 1 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("categories.changeSlug", () => {
  const output = {
    categoryId: CATEGORY_ID,
    locale: "es" as const,
    currentSlug: "musica-en-vivo",
    oldSlugs: ["musica"],
  };

  it("passes the session's actor and the ctx reporter, never an actor from the body", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(categoryUseCases, "changeCategorySlug")
      .mockResolvedValue(output);
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      reportError,
    } as unknown as Partial<Ctx>);

    await expect(
      caller.changeSlug({
        categoryId: CATEGORY_ID,
        locale: "es",
        newSlug: "musica-en-vivo",
      }),
    ).resolves.toEqual(output);

    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({
      actorHumanId: ACTOR_ID,
      categoryId: CATEGORY_ID,
      locale: "es",
      newSlug: "musica-en-vivo",
    });
    expect(deps.reportError).toBe(reportError);

    await expect(
      caller.changeSlug({
        categoryId: CATEGORY_ID,
        locale: "es",
        newSlug: "x-y",
        actorHumanId: "33333333-3333-4333-8333-333333333333",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("maps a taken slug to CONFLICT and a rule break to BAD_REQUEST", async () => {
    const spy = vi.spyOn(categoryUseCases, "changeCategorySlug");
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
    } as unknown as Partial<Ctx>);
    const input = {
      categoryId: CATEGORY_ID,
      locale: "es" as const,
      newSlug: "musica",
    };

    spy.mockImplementationOnce(async () => fail("CATEGORY_SLUG_TAKEN"));
    await expect(caller.changeSlug(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    spy.mockImplementationOnce(async () => fail("INVALID_CATEGORY_SLUG"));
    await expect(caller.changeSlug(input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("non-staff are refused (FORBIDDEN)", async () => {
    const { caller } = createCaller(categoriesRouter);
    await expect(
      caller.changeSlug({
        categoryId: CATEGORY_ID,
        locale: "es",
        newSlug: "musica",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("categories.listAll", () => {
  it("includes each category's slug rows", async () => {
    const at = new Date("2026-10-17T00:00:00Z");
    const categories = {
      listAll: vi.fn(async () => [
        {
          id: CATEGORY_ID,
          slug: "music",
          name: "Music",
          nameTranslations: { es: "Música" },
          active: true,
          sortOrder: 1,
          seoType: "Event",
        },
      ]),
      listAllSlugs: vi.fn(async () => [
        { categoryId: CATEGORY_ID, locale: "es", slug: "musica", isCurrent: true, createdAt: at },
        { categoryId: CATEGORY_ID, locale: "en", slug: "music", isCurrent: true, createdAt: at },
        { categoryId: CATEGORY_ID, locale: "es", slug: "sonido", isCurrent: false, createdAt: at },
      ]),
    };
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      repos: { categories } as unknown as Ctx["repos"],
    } as unknown as Partial<Ctx>);

    const out = await caller.listAll();

    expect(out.categories[0]!.urls).toEqual([
      { locale: "en", slug: "music", isCurrent: true },
      { locale: "es", slug: "musica", isCurrent: true },
      { locale: "es", slug: "sonido", isCurrent: false },
    ]);
    expect(categories.listAllSlugs).toHaveBeenCalledTimes(1);
  });
});
