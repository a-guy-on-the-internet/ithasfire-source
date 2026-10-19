import { afterEach, describe, expect, it, vi } from "vitest";

import * as categoryUseCases from "@th/core/use-cases/categories";

import type { Ctx } from "../../context";
import { categoriesRouter } from "../categories";
import { createCaller } from "./test-helpers";

// Category translations (spec 2026-10-16): the transport stays thin. The actor
// is the session's, the translator and reporter are the ctx's, and every
// category output carries `names` (`{ en, es? }`) beside `name`.

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

const row = (slug: string, nameTranslations?: Record<string, string>) => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  nameTranslations,
  active: true,
  sortOrder: 1,
  seoType: "Event",
});

describe("categories.list / listBrowsable output", () => {
  it("carries names: en always, es when set", async () => {
    const categories = {
      listActive: vi.fn(async () => [
        row("music", { es: "Música" }),
        row("comedy"),
      ]),
      listActiveWithListedEvents: vi.fn(async () => [
        row("music", { es: "Música" }),
      ]),
      listCurrentSlugs: vi.fn(async () => []),
    };
    const { caller } = createCaller(categoriesRouter, {
      repos: { categories } as unknown as Ctx["repos"],
      actorHumanId: null,
      auth: null,
    } as unknown as Partial<Ctx>);

    const list = await caller.list();
    expect(list.categories.map((c) => c.names)).toEqual([
      { en: "music", es: "Música" },
      { en: "comedy" },
    ]);
    expect(list.categories[0]!.name).toBe("music");

    const browsable = await caller.listBrowsable();
    expect(browsable.categories[0]!.names).toEqual({
      en: "music",
      es: "Música",
    });
  });
});

describe("categories.list / listBrowsable slugs", () => {
  it("carries slugs: en always, es when the category has a current Spanish slug", async () => {
    const esRow = (categoryId: string, slug: string) => ({
      categoryId,
      locale: "es" as const,
      slug,
      isCurrent: true,
      createdAt: new Date(0),
    });
    const categories = {
      listActive: vi.fn(async () => [
        row("music", { es: "Música" }),
        row("comedy"),
      ]),
      listActiveWithListedEvents: vi.fn(async () => [
        row("music", { es: "Música" }),
      ]),
      listCurrentSlugs: vi.fn(async (locale: string) =>
        locale === "es" ? [esRow("cat-music", "musica")] : [],
      ),
    };
    const { caller } = createCaller(categoriesRouter, {
      repos: { categories } as unknown as Ctx["repos"],
      actorHumanId: null,
      auth: null,
    } as unknown as Partial<Ctx>);

    const list = await caller.list();
    expect(list.categories.map((c) => c.slugs)).toEqual([
      { en: "music", es: "musica" },
      { en: "comedy" },
    ]);
    // The English `slug` is unchanged for existing callers.
    expect(list.categories.map((c) => c.slug)).toEqual(["music", "comedy"]);

    const browsable = await caller.listBrowsable();
    expect(browsable.categories.map((c) => c.slugs)).toEqual([
      { en: "music", es: "musica" },
    ]);
    // One read per language per call, never one per category.
    expect(categories.listCurrentSlugs).toHaveBeenCalledTimes(2);
    expect(categories.listCurrentSlugs).toHaveBeenCalledWith("es");
  });
});

describe("categories.setTranslations", () => {
  it("passes the session's actor, never one from the body", async () => {
    const category = {
      id: CATEGORY_ID,
      slug: "music",
      name: "Music",
      names: { en: "Music", es: "Música" },
      seoType: "Event",
      active: true,
      sortOrder: 1,
    };
    const spy = vi
      .spyOn(categoryUseCases, "setCategoryTranslations")
      .mockResolvedValue({ category });

    const { caller } = createCaller(categoriesRouter);
    const out = await caller.setTranslations({
      categoryId: CATEGORY_ID,
      translations: { es: "Música" },
    });

    expect(out).toEqual({ category });
    const [, input] = spy.mock.calls[0]!;
    expect(input).toEqual({
      actorHumanId: ACTOR_ID,
      categoryId: CATEGORY_ID,
      translations: { es: "Música" },
    });

    await expect(
      caller.setTranslations({
        categoryId: CATEGORY_ID,
        translations: { es: null },
        actorHumanId: "33333333-3333-4333-8333-333333333333",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("non-staff are refused (STAFF_ONLY → FORBIDDEN)", async () => {
    const { caller } = createCaller(categoriesRouter);
    await expect(
      caller.setTranslations({
        categoryId: CATEGORY_ID,
        translations: { es: "Música" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("categories.suggestTranslations", () => {
  it("passes the ctx translator and returns its suggestions", async () => {
    const translate = vi.fn(async () => ({ es: "Música" }));
    const consume = vi.fn(async () => ({
      allowed: true,
      remaining: 59,
      retryAfterSeconds: 0,
    }));
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      translator: { translate },
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    } as unknown as Partial<Ctx>);

    const out = await caller.suggestTranslations({
      text: "Music",
      sourceLocale: "en",
      targetLocales: ["es"],
    });

    expect(out).toEqual({ suggestions: { es: "Música" } });
    expect(translate).toHaveBeenCalledWith({
      text: "Music",
      source: "en",
      targets: ["es"],
    });
    expect(consume).toHaveBeenCalledWith(
      `categories:suggest-translations:${ACTOR_ID}`,
      60,
      600,
    );
  });

  it("a spent rate limit is TOO_MANY_REQUESTS and the translator is not called", async () => {
    const translate = vi.fn();
    const consume = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    }));
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      translator: { translate },
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    } as unknown as Partial<Ctx>);
    await expect(
      caller.suggestTranslations({
        text: "Music",
        sourceLocale: "en",
        targetLocales: ["es"],
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(translate).not.toHaveBeenCalled();
  });

  it("an actorHumanId in the body is refused (the actor is the session's)", async () => {
    const translate = vi.fn();
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      translator: { translate },
    } as unknown as Partial<Ctx>);
    await expect(
      caller.suggestTranslations({
        text: "Music",
        sourceLocale: "en",
        targetLocales: ["es"],
        actorHumanId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(translate).not.toHaveBeenCalled();
  });

  it("an unwired translator returns no suggestions", async () => {
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      translator: null,
    } as unknown as Partial<Ctx>);
    await expect(
      caller.suggestTranslations({
        text: "Music",
        sourceLocale: "en",
        targetLocales: ["es"],
      }),
    ).resolves.toEqual({ suggestions: {} });
  });

  it("a failing translator is reported through the ctx reporter", async () => {
    const reportError = vi.fn();
    const { caller } = createCaller(categoriesRouter, {
      authz: staffAuthz,
      translator: {
        translate: vi.fn(async () => {
          throw new Error("down");
        }),
      },
      reportError,
    } as unknown as Partial<Ctx>);
    await expect(
      caller.suggestTranslations({
        text: "Music",
        sourceLocale: "en",
        targetLocales: ["es"],
      }),
    ).resolves.toEqual({ suggestions: {} });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("non-staff are refused and the translator is not called", async () => {
    const translate = vi.fn();
    const { caller } = createCaller(categoriesRouter, {
      translator: { translate },
    } as unknown as Partial<Ctx>);
    await expect(
      caller.suggestTranslations({
        text: "Music",
        sourceLocale: "en",
        targetLocales: ["es"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(translate).not.toHaveBeenCalled();
  });
});

describe("categories.requestOption / reviewRequest / create inputs", () => {
  it("requestOption forwards the locale", async () => {
    const spy = vi
      .spyOn(categoryUseCases, "requestCategoryOption")
      .mockResolvedValue({} as never);
    const { caller } = createCaller(categoriesRouter);
    // The mock returns no record, so output validation rejects; the point is
    // what reached the use case.
    await caller
      .requestOption({
        kind: "CATEGORY",
        eventId: CATEGORY_ID,
        name: "Música",
        locale: "es",
      })
      .catch(() => undefined);
    const [, input] = spy.mock.calls[0]!;
    expect(input).toMatchObject({ actorHumanId: ACTOR_ID, locale: "es" });
  });

  it("reviewRequest forwards the English name and translations", async () => {
    const spy = vi
      .spyOn(categoryUseCases, "reviewCategoryRequest")
      .mockResolvedValue({} as never);
    const { caller } = createCaller(categoriesRouter);
    await caller
      .reviewRequest({
        requestId: CATEGORY_ID,
        decision: "APPROVE",
        name: "Music",
        translations: { es: "Música" },
      })
      .catch(() => undefined);
    const [, input] = spy.mock.calls[0]!;
    expect(input).toMatchObject({
      actorHumanId: ACTOR_ID,
      name: "Music",
      translations: { es: "Música" },
    });
  });

  it("create forwards translations", async () => {
    const spy = vi
      .spyOn(categoryUseCases, "createCategory")
      .mockResolvedValue({} as never);
    const { caller } = createCaller(categoriesRouter);
    await caller
      .create({ name: "Music", translations: { es: "Música" } })
      .catch(() => undefined);
    const [, input] = spy.mock.calls[0]!;
    expect(input).toMatchObject({
      actorHumanId: ACTOR_ID,
      translations: { es: "Música" },
    });
  });
});
