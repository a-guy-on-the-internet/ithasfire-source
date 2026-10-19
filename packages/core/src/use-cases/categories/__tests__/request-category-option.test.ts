import { describe, expect, it, vi } from "vitest";

import { requestCategoryOption } from "../request-category-option";
import type { RequestCategoryOptionDeps } from "../request-category-option";

// The event-access guard is not what this file pins: the name normaliser and
// the slugifier are. They are shared with `createCategory`
// (`_shared/category-naming.ts`), so the slug a request stores and the slug a
// directly created category gets must stay byte-identical.
vi.mock("../../../lib/event-edit-rights", () => ({
  ensureActorHoldsHumanEventRole: vi.fn(async () => undefined),
}));

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const FIXED_NOW = new Date("2026-10-11T12:00:00Z");

function buildDeps(
  overrides: {
    existingCategory?: unknown;
    allCategories?: Array<{
      id: string;
      slug: string;
      name: string;
      nameTranslations?: { es?: string };
    }>;
    blocked?: boolean;
  } = {},
) {
  const categories = {
    getBySlug: vi.fn(async () => overrides.existingCategory ?? null),
    listAll: vi.fn(async () => overrides.allCategories ?? []),
  };
  const categoryRequests = {
    findPending: vi.fn(async () => null),
    create: vi.fn(
      async (input: {
        name: string;
        slug: string;
        kind: string;
        locale?: string | null;
      }) => ({
        id: REQUEST_ID,
        kind: input.kind,
        status: "PENDING",
        name: input.name,
        slug: input.slug,
        categoryId: null,
        categorySlug: null,
        categoryName: null,
        eventId: EVENT_ID,
        requesterHumanId: ACTOR_ID,
        reviewedByHumanId: null,
        reviewNote: null,
        resolvedCategoryId: null,
        locale: input.locale ?? null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        reviewedAt: null,
      }),
    ),
  };
  const events = {
    getById: vi.fn(async () => ({
      id: EVENT_ID,
      orgId: null,
      humanId: ACTOR_ID,
      status: "DRAFT",
    })),
  };
  const audit = { log: vi.fn() };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ categories, categoryRequests, events, audit, authz: {} }),
  );

  const deps = {
    repos: { tx } as unknown as RequestCategoryOptionDeps["repos"],
    clock: {
      now: () => FIXED_NOW,
    } as unknown as RequestCategoryOptionDeps["clock"],
    contentFilter: {
      hasBlockedContent: vi.fn(async () => overrides.blocked ?? false),
    } as unknown as RequestCategoryOptionDeps["contentFilter"],
  } satisfies RequestCategoryOptionDeps;

  return { deps, categories, categoryRequests, audit };
}

async function request(name: string) {
  const built = buildDeps();
  const result = await requestCategoryOption(built.deps, {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    kind: "CATEGORY",
    name,
  });
  return { ...built, result };
}

describe("requestCategoryOption: name and slug", () => {
  it.each([
    ["Experimental Jazz", "Experimental Jazz", "experimental-jazz"],
    ["  Café   Société  ", "Café Société", "cafe-societe"],
    ["Rock & Roll", "Rock & Roll", "rock-roll"],
    ["DJ's Night+Day", "DJ's Night+Day", "dj-s-night-day"],
    ["ÉLECTRO Pop-Up", "ÉLECTRO Pop-Up", "electro-pop-up"],
  ])("stores %j as name %j with slug %j", async (raw, name, slug) => {
    const { result, categoryRequests } = await request(raw);

    expect(categoryRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ name, slug, kind: "CATEGORY" }),
    );
    expect(result.request).toMatchObject({ name, slug });
  });

  it.each([
    ["a link", "see https://example.com"],
    ["a handle", "follow @someone"],
    ["a character outside the allowed set", "Jazz / Blues"],
    ["a long run of one character", "Jaaaaaaaazz"],
    ["a name with no latin letters or digits to slug", "音楽の夜"],
  ])("refuses %s", async (_label, raw) => {
    const { deps, categoryRequests } = buildDeps();

    await expect(
      requestCategoryOption(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        kind: "CATEGORY",
        name: raw,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });

    expect(categoryRequests.create).not.toHaveBeenCalled();
  });

  it("refuses a name whose slug is already a category", async () => {
    const { deps, categories, categoryRequests } = buildDeps({
      existingCategory: { id: "c", slug: "experimental-jazz" },
    });

    await expect(
      requestCategoryOption(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        kind: "CATEGORY",
        name: "Experimental Jazz",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

    expect(categories.getBySlug).toHaveBeenCalledWith("experimental-jazz");
    expect(categoryRequests.create).not.toHaveBeenCalled();
  });

  it("refuses a name that belongs to a category under a different slug, case-insensitively", async () => {
    const { deps, categories, categoryRequests, audit } = buildDeps({
      allCategories: [{ id: "c", slug: "music", name: "Live Music" }],
    });

    await expect(
      requestCategoryOption(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        kind: "CATEGORY",
        name: "live MUSIC",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

    expect(categories.getBySlug).toHaveBeenCalledWith("live-music");
    expect(categoryRequests.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("files the request when neither the slug nor the name is taken", async () => {
    const { deps, categoryRequests } = buildDeps({
      allCategories: [{ id: "c", slug: "music", name: "Music" }],
    });

    const result = await requestCategoryOption(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "CATEGORY",
      name: "Live Music",
    });

    expect(categoryRequests.create).toHaveBeenCalledTimes(1);
    expect(result.request).toMatchObject({
      name: "Live Music",
      slug: "live-music",
    });
  });

  it("still runs the content filter on the request path", async () => {
    const { deps, categoryRequests } = buildDeps({ blocked: true });

    await expect(
      requestCategoryOption(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        kind: "CATEGORY",
        name: "Experimental Jazz",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });

    expect(categoryRequests.create).not.toHaveBeenCalled();
  });
});

describe("requestCategoryOption: requester locale", () => {
  const ask = (deps: RequestCategoryOptionDeps, extra: object) =>
    requestCategoryOption(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "CATEGORY",
      name: "Música en vivo",
      ...extra,
    });

  it("stores the organiser's locale on the request and in the audit row", async () => {
    const { deps, categoryRequests, audit } = buildDeps();

    const result = await ask(deps, { locale: "es" });

    expect(categoryRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Música en vivo",
        slug: "musica-en-vivo",
        locale: "es",
      }),
    );
    expect(result.request.locale).toBe("es");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ locale: "es" }),
      }),
    );
  });

  it("stores null when no locale is sent (English, as before)", async () => {
    const { deps, categoryRequests } = buildDeps();

    const result = await ask(deps, {});

    expect(categoryRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ locale: null }),
    );
    expect(result.request.locale).toBeNull();
  });

  it("refuses an es request for a name that is already a category's es name, whatever the case", async () => {
    const { deps, categoryRequests, audit } = buildDeps({
      allCategories: [
        {
          id: "c",
          slug: "live-music",
          name: "Live Music",
          nameTranslations: { es: "MÚSICA EN VIVO" },
        },
      ],
    });

    await expect(ask(deps, { locale: "es" })).rejects.toMatchObject({
      code: "CATEGORY_ALREADY_EXISTS",
      meta: { field: "nameTranslations", locale: "es" },
    });
    expect(categoryRequests.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ["en", { locale: "en" }],
    ["no locale", {}],
  ])(
    "does not compare a request in %s against es names",
    async (_label, extra) => {
      const { deps, categoryRequests } = buildDeps({
        allCategories: [
          {
            id: "c",
            slug: "live-music",
            name: "Live Music",
            nameTranslations: { es: "Música en vivo" },
          },
        ],
      });

      await ask(deps, extra);

      expect(categoryRequests.create).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a locale the UI does not support, before any read", async () => {
    const { deps, categoryRequests } = buildDeps();

    await expect(ask(deps, { locale: "fr" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(categoryRequests.create).not.toHaveBeenCalled();
  });
});
