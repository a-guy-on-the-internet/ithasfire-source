/**
 * `resolveCategoryRoute`: a category URL slug → render (with the page slug in
 * every language), redirect, notFound or unavailable (spanish-seo FR-010).
 *
 * Pins: reads through the NO-IDENTITY client; the twin slug is the
 * resolver's answer for the page slug in the other language; a slug that is
 * not the resolver's lowercase form redirects to it; an input the API
 * rejects is a 404, any other failure is reported and "unavailable".
 */
import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSlug: vi.fn(),
  reported: vi.fn(),
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    categories: { resolveSlug: { query: mocks.resolveSlug } },
  }),
  getServerTrpcClient: () => {
    throw new Error("must use the public client");
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    mocks.reported(label, err),
}));

import { resolveCategoryRoute } from "@/server/categories";

type Answer =
  | { kind: "render"; categoryId: string; locale: string; slug: string }
  | { kind: "redirect"; locale: string; slug: string }
  | { kind: "notFound" };

/** A resolver fake: answers keyed by "locale:slug". */
const answers = (table: Record<string, Answer>) =>
  mocks.resolveSlug.mockImplementation(
    async ({ locale, slug }: { locale: string; slug: string }) =>
      table[`${locale}:${slug}`] ?? { kind: "notFound" },
  );

const render = (locale: string, slug: string): Answer => ({
  kind: "render",
  categoryId: "c1",
  locale,
  slug,
});

beforeEach(() => {
  mocks.resolveSlug.mockReset();
  mocks.reported.mockReset();
});

describe("resolveCategoryRoute", () => {
  it("renders an English slug and finds the Spanish twin's slug", async () => {
    answers({
      "en:music": render("en", "music"),
      "es:music": { kind: "redirect", locale: "es", slug: "musica" },
    });

    await expect(resolveCategoryRoute("en", "music")).resolves.toEqual({
      kind: "render",
      slugs: { en: "music", es: "musica" },
    });
  });

  it("renders a Spanish slug and finds the English twin's slug", async () => {
    answers({
      "es:musica": render("es", "musica"),
      "en:musica": { kind: "redirect", locale: "en", slug: "music" },
    });

    await expect(resolveCategoryRoute("es", "musica")).resolves.toEqual({
      kind: "render",
      slugs: { es: "musica", en: "music" },
    });
  });

  it("a category with no Spanish slug has its /es/ page at the English slug", async () => {
    answers({
      "en:jazz": render("en", "jazz"),
      "es:jazz": render("es", "jazz"),
    });

    await expect(resolveCategoryRoute("en", "jazz")).resolves.toEqual({
      kind: "render",
      slugs: { en: "jazz", es: "jazz" },
    });
  });

  it("passes a redirect through (old or other-language slug)", async () => {
    answers({ "es:music": { kind: "redirect", locale: "es", slug: "musica" } });

    await expect(resolveCategoryRoute("es", "music")).resolves.toEqual({
      kind: "redirect",
      slug: "musica",
    });
    expect(mocks.resolveSlug).toHaveBeenCalledTimes(1);
  });

  it("redirects a slug that is not the resolver's lowercase form", async () => {
    answers({ "en:Music": render("en", "music") });

    await expect(resolveCategoryRoute("en", "Music")).resolves.toEqual({
      kind: "redirect",
      slug: "music",
    });
  });

  it("is notFound for an unknown slug and for one the API rejects", async () => {
    answers({});
    await expect(resolveCategoryRoute("en", "nope")).resolves.toEqual({
      kind: "notFound",
    });

    mocks.resolveSlug.mockRejectedValue(
      new TRPCClientError("bad", {
        result: { error: { data: { code: "BAD_REQUEST" } } },
      } as never),
    );
    await expect(resolveCategoryRoute("en", "x".repeat(300))).resolves.toEqual({
      kind: "notFound",
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("English page, API down: reports once and answers unavailable", async () => {
    const boom = new Error("api down");
    mocks.resolveSlug.mockRejectedValue(boom);

    await expect(resolveCategoryRoute("en", "music")).resolves.toEqual({
      kind: "unavailable",
      error: boom,
    });
    expect(mocks.reported).toHaveBeenCalledTimes(1);
    expect(mocks.reported).toHaveBeenCalledWith(
      "server.categories.resolveCategoryRoute",
      boom,
    );
  });

  it("Spanish page, API down: does not report (the page throws it)", async () => {
    const boom = new Error("api down");
    mocks.resolveSlug.mockRejectedValue(boom);

    await expect(resolveCategoryRoute("es", "musica")).resolves.toEqual({
      kind: "unavailable",
      error: boom,
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("Spanish page whose English answer fails: unavailable, not reported", async () => {
    const boom = new Error("api down");
    mocks.resolveSlug.mockImplementation(
      async ({ locale }: { locale: string }) => {
        if (locale === "es") return render("es", "musica");
        throw boom;
      },
    );

    await expect(resolveCategoryRoute("es", "musica")).resolves.toEqual({
      kind: "unavailable",
      error: boom,
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });

  it("English page whose Spanish answer fails: renders without it, reported", async () => {
    const boom = new Error("api down");
    mocks.resolveSlug.mockImplementation(
      async ({ locale }: { locale: string }) => {
        if (locale === "en") return render("en", "music");
        throw boom;
      },
    );

    await expect(resolveCategoryRoute("en", "music")).resolves.toEqual({
      kind: "render",
      slugs: { en: "music" },
    });
    expect(mocks.reported).toHaveBeenCalledTimes(1);
  });
});
