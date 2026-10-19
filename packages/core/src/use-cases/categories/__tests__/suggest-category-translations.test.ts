import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { TranslatorPort } from "@th/ports/translator";

import {
  SUGGEST_CATEGORY_TRANSLATIONS_MAX,
  SUGGEST_CATEGORY_TRANSLATIONS_WINDOW_SECONDS,
  suggestCategoryTranslations,
  type SuggestCategoryTranslationsDeps,
} from "../suggest-category-translations";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

type StaffRole = "ADMIN" | "DEVELOPER" | "REVIEWER" | "SUPPORT";

function buildDeps(
  overrides: {
    actorRoles?: StaffRole[];
    translate?: TranslatorPort["translate"];
    noTranslator?: boolean;
    rateLimit?: Pick<RateLimitPort, "consume"> | null;
    reportError?: SuggestCategoryTranslationsDeps["reportError"];
  } = {},
) {
  const actorRoles = overrides.actorRoles ?? ["ADMIN"];
  const translate = vi.fn(
    overrides.translate ?? (async () => ({ es: "Música" })),
  );
  const hasStaffRole = vi.fn(
    async (input: { actorHumanId: string; requiredRoles: string[] }) => ({
      allowed: actorRoles.some((role) => input.requiredRoles.includes(role)),
    }),
  );
  const logError = vi.fn();
  const logger = {
    child: () => logger,
    error: logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerPort;

  const deps: SuggestCategoryTranslationsDeps = {
    authz: { hasStaffRole } as unknown as AuthZPort,
    translator: overrides.noTranslator ? undefined : { translate },
    rateLimit:
      overrides.rateLimit === undefined
        ? { consume: vi.fn(async () => ({ allowed: true, remaining: 59, retryAfterSeconds: 0 })) }
        : overrides.rateLimit,
    reportError: overrides.reportError,
    logger,
  };
  return { deps, translate, hasStaffRole, logError };
}

const music = {
  actorHumanId: ACTOR_ID,
  text: "Music",
  sourceLocale: "en",
  targetLocales: ["es"],
};

describe("suggestCategoryTranslations", () => {
  it("returns the translator's suggestion for each requested locale", async () => {
    const built = buildDeps();

    const result = await suggestCategoryTranslations(built.deps, music);

    expect(result).toEqual({ suggestions: { es: "Música" } });
    expect(built.translate).toHaveBeenCalledWith({
      text: "Music",
      source: "en",
      targets: ["es"],
    });
  });

  it("translates an es request's name into English", async () => {
    const built = buildDeps({ translate: async () => ({ en: "Live music" }) });

    const result = await suggestCategoryTranslations(built.deps, {
      ...music,
      text: "Música en vivo",
      sourceLocale: "es",
      targetLocales: ["en"],
    });

    expect(result).toEqual({ suggestions: { en: "Live music" } });
  });

  it("keeps only requested locales and drops blank, unsafe or oversized values", async () => {
    const built = buildDeps({
      translate: async () => ({
        es: "  <b>Música</b>  ",
        en: "Should not appear",
      }),
    });

    const result = await suggestCategoryTranslations(built.deps, music);

    expect(result.suggestions.es).toBe("Música");
    expect(result.suggestions).not.toHaveProperty("en");

    const tooLong = buildDeps({ translate: async () => ({ es: "a".repeat(81) }) });
    await expect(
      suggestCategoryTranslations(tooLong.deps, music),
    ).resolves.toEqual({ suggestions: {} });
  });

  it("does not call the translator when the only target is the source", async () => {
    const built = buildDeps();

    const result = await suggestCategoryTranslations(built.deps, {
      ...music,
      targetLocales: ["en"],
    });

    expect(result).toEqual({ suggestions: {} });
    expect(built.translate).not.toHaveBeenCalled();
  });

  describe("who may ask", () => {
    it.each<StaffRole>(["ADMIN", "DEVELOPER", "REVIEWER"])(
      "lets a platform %s ask",
      async (role) => {
        const built = buildDeps({ actorRoles: [role] });
        await expect(
          suggestCategoryTranslations(built.deps, music),
        ).resolves.toEqual({ suggestions: { es: "Música" } });
      },
    );

    it.each<[string, StaffRole[]]>([
      ["SUPPORT", ["SUPPORT"]],
      ["a human with no staff role", []],
    ])(
      "refuses %s before the limiter or the translator",
      async (_label, actorRoles) => {
        const consume = vi.fn();
        const built = buildDeps({ actorRoles, rateLimit: { consume } });

        await expect(
          suggestCategoryTranslations(built.deps, music),
        ).rejects.toMatchObject({ code: "STAFF_ONLY" });
        expect(consume).not.toHaveBeenCalled();
        expect(built.translate).not.toHaveBeenCalled();
      },
    );
  });

  describe("rate limit", () => {
    it("consumes one token from the actor's bucket", async () => {
      const consume = vi.fn(async () => ({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      }));
      const built = buildDeps({ rateLimit: { consume } });

      await suggestCategoryTranslations(built.deps, music);

      expect(consume).toHaveBeenCalledWith(
        `categories:suggest-translations:${ACTOR_ID}`,
        SUGGEST_CATEGORY_TRANSLATIONS_MAX,
        SUGGEST_CATEGORY_TRANSLATIONS_WINDOW_SECONDS,
      );
    });

    it("refuses with RATE_LIMITED when the bucket is spent, without translating", async () => {
      const built = buildDeps({
        rateLimit: {
          consume: vi.fn(async () => ({
            allowed: false,
            remaining: 0,
            retryAfterSeconds: 42,
          })),
        },
      });

      await expect(
        suggestCategoryTranslations(built.deps, music),
      ).rejects.toMatchObject({
        code: "RATE_LIMITED",
        meta: { retryAfterSeconds: 42 },
      });
      expect(built.translate).not.toHaveBeenCalled();
    });

    it("fails open and reports when the limiter itself throws", async () => {
      const limiterError = new Error("redis down");
      const reportError = vi.fn();
      const built = buildDeps({
        reportError,
        rateLimit: {
          consume: vi.fn(async () => {
            throw limiterError;
          }),
        },
      });

      const result = await suggestCategoryTranslations(built.deps, music);

      expect(result).toEqual({ suggestions: { es: "Música" } });
      expect(reportError).toHaveBeenCalledWith(limiterError, {
        tags: { useCase: "suggestCategoryTranslations" },
        extra: { stage: "rateLimit" },
      });
      expect(built.logError).toHaveBeenCalledWith(
        "categories.suggest_translations.rate_limit_failed",
        { err: limiterError },
      );
    });
  });

  describe("translator failure (deliberate swallow)", () => {
    const translatorError = new Error("translate.googleapis.com 403");
    const failing = async () => {
      throw translatorError;
    };

    it("returns no suggestions, logs at error level and reports the error", async () => {
      const reportError = vi.fn();
      const built = buildDeps({ translate: failing, reportError });

      const result = await suggestCategoryTranslations(built.deps, music);

      expect(result).toEqual({ suggestions: {} });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(translatorError, {
        tags: { useCase: "suggestCategoryTranslations" },
        extra: { stage: "translate", sourceLocale: "en", targets: ["es"] },
      });
      expect(built.logError).toHaveBeenCalledWith(
        "categories.suggest_translations.translator_failed",
        expect.objectContaining({ err: translatorError }),
      );
    });

    it("still returns no suggestions when reportError is not wired", async () => {
      const built = buildDeps({ translate: failing });

      await expect(
        suggestCategoryTranslations(built.deps, music),
      ).resolves.toEqual({ suggestions: {} });
    });

    it("a throwing reporter never changes the result", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const built = buildDeps({ translate: failing, reportError });

      await expect(
        suggestCategoryTranslations(built.deps, music),
      ).resolves.toEqual({ suggestions: {} });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not report on the success path", async () => {
      const reportError = vi.fn();
      const built = buildDeps({ reportError });

      await suggestCategoryTranslations(built.deps, music);

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("returns no suggestions, and reports nothing, when no translator is wired", async () => {
    const reportError = vi.fn();
    const consume = vi.fn();
    const built = buildDeps({
      noTranslator: true,
      reportError,
      rateLimit: { consume },
    });

    const result = await suggestCategoryTranslations(built.deps, music);

    expect(result).toEqual({ suggestions: {} });
    expect(reportError).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsupported target", { targetLocales: ["fr"] }],
    ["no targets", { targetLocales: [] }],
    ["empty text", { text: "   " }],
    ["text over 80 characters", { text: "a".repeat(81) }],
    ["an extra field", { store: true }],
  ])("refuses %s at the boundary", async (_label, extra) => {
    const built = buildDeps();

    await expect(
      suggestCategoryTranslations(built.deps, { ...music, ...extra }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(built.translate).not.toHaveBeenCalled();
  });
});
