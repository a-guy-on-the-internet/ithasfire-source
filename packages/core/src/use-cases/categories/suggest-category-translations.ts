import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { TranslatorPort } from "@th/ports/translator";
import { CATEGORY_NAME_LOCALES, type CategoryNameLocale } from "@th/types";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import {
  plainTextRequired,
  sanitizePlainText,
} from "../../lib/sanitize-plain-text";

const localeSchema = z.enum(CATEGORY_NAME_LOCALES);

export const suggestCategoryTranslationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    // The name typed so far; only bounded and cleaned, since nothing is
    // stored (the form's submit runs the full name rules).
    text: plainTextRequired(80),
    sourceLocale: localeSchema,
    targetLocales: z
      .array(localeSchema)
      .min(1)
      .max(CATEGORY_NAME_LOCALES.length),
  })
  .strict();

export const suggestCategoryTranslationsOutputSchema = z
  .object({
    /** Machine suggestions keyed by target locale; absent = none. */
    suggestions: z
      .object({
        en: z.string().optional(),
        es: z.string().optional(),
      } satisfies Record<CategoryNameLocale, unknown>)
      .strict(),
  })
  .strict();

export type SuggestCategoryTranslationsInput = z.infer<
  typeof suggestCategoryTranslationsInputSchema
>;
export type SuggestCategoryTranslationsOutput = z.infer<
  typeof suggestCategoryTranslationsOutputSchema
>;

export type SuggestCategoryTranslationsDeps = {
  authz: AuthZPort;
  /** Unwired (no credentials, e.g. local dev) = no suggestions, no report. */
  translator?: TranslatorPort;
  /** Per-actor cap on calls to the paid translation API. */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  /** Translator and limiter failures are swallowed; this makes them visible. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/** Calls per actor per window. A form opening asks once per blank field. */
export const SUGGEST_CATEGORY_TRANSLATIONS_MAX = 60;
export const SUGGEST_CATEGORY_TRANSLATIONS_WINDOW_SECONDS = 10 * 60;

export const suggestCategoryTranslationsRateKey = (actorHumanId: string) =>
  `categories:suggest-translations:${actorHumanId}`;

const EMPTY: SuggestCategoryTranslationsOutput = { suggestions: {} };

/**
 * Machine-translate a category name to PREFILL the /platform create, edit and
 * approve forms (category-translations FR-005). Platform ADMIN / DEVELOPER /
 * REVIEWER (reviewers approve requests, whose form gets the prefill too).
 * Writes nothing: staff see the suggestion, may change it, and only their
 * submit stores anything.
 *
 * Rate-limited per actor (`RATE_LIMITED` when spent), checked after the role
 * so a refused caller burns nothing.
 *
 * Translation is optional, so a translator failure is SWALLOWED: the result is
 * `{ suggestions: {} }` and the form shows blank fields (FR-005). That branch
 * logs at error level and reports through `reportError` (CLAUDE.md, Error
 * Reporting Convention), guarded so a throwing reporter changes nothing. A
 * limiter failure fails open the same way. No translator wired returns no
 * suggestions without a report: that is configuration, not a failure.
 */
export async function suggestCategoryTranslations(
  deps: SuggestCategoryTranslationsDeps,
  rawInput: unknown,
): Promise<SuggestCategoryTranslationsOutput> {
  const logger = deps.logger?.child({
    useCase: "suggestCategoryTranslations",
  });

  const report = (err: unknown, extra: Record<string, unknown>) => {
    try {
      deps.reportError?.(err, {
        tags: { useCase: "suggestCategoryTranslations" },
        extra,
      });
    } catch {
      // Best-effort: a throwing reporter must never change the result.
    }
  };

  const input = parseInput(suggestCategoryTranslationsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "DEVELOPER", "REVIEWER"],
  });

  const targets = [...new Set(input.targetLocales)].filter(
    (locale) => locale !== input.sourceLocale,
  );
  if (targets.length === 0 || !deps.translator) {
    return EMPTY;
  }

  if (deps.rateLimit) {
    let limit: RateLimitResult | null = null;
    try {
      limit = await deps.rateLimit.consume(
        suggestCategoryTranslationsRateKey(input.actorHumanId),
        SUGGEST_CATEGORY_TRANSLATIONS_MAX,
        SUGGEST_CATEGORY_TRANSLATIONS_WINDOW_SECONDS,
      );
    } catch (err) {
      // Fail open: a broken counter must not take the prefill away from
      // staff. Deliberate swallow → log AND report.
      logger?.error("categories.suggest_translations.rate_limit_failed", {
        err,
      });
      report(err, { stage: "rateLimit" });
    }
    if (limit && !limit.allowed) {
      throw fail("RATE_LIMITED", {
        meta: {
          scope: "category_translation_suggestions",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
      });
    }
  }

  let raw: Record<string, string>;
  try {
    raw = await deps.translator.translate({
      text: input.text,
      source: input.sourceLocale,
      targets,
    });
  } catch (err) {
    // Deliberate swallow (FR-005: the form stays usable with blank fields).
    logger?.error("categories.suggest_translations.translator_failed", {
      err,
      sourceLocale: input.sourceLocale,
      targets,
    });
    report(err, {
      stage: "translate",
      sourceLocale: input.sourceLocale,
      targets,
    });
    return EMPTY;
  }

  // Keep only what was asked for, as plain text a name field can hold.
  const suggestions: SuggestCategoryTranslationsOutput["suggestions"] = {};
  for (const locale of targets) {
    const value = raw?.[locale];
    if (typeof value !== "string") continue;
    const clean = sanitizePlainText(value).replace(/\s+/g, " ").trim();
    if (clean.length > 0 && clean.length <= 80) {
      suggestions[locale] = clean;
    }
  }

  return suggestCategoryTranslationsOutputSchema.parse({ suggestions });
}
