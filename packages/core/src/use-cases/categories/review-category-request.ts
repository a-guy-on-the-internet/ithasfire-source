import { z } from "zod";

import { eventCategoryRequestRecordSchema } from "@th/schema";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventCategoryRequestRecord } from "@th/ports/repos/category-requests";
import type {
  CategoryNameTranslations,
  CategoryRecord,
} from "@th/ports/repos/categories";
import type { Repos, TxRepos } from "@th/ports/repos";
import {
  isCategoryTranslationLocale,
  type CategoryTranslationLocale,
} from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { isUniqueViolation } from "../places/_shared/claim";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  applyCategoryTranslationChanges,
  assertCategoryNamingFree,
  assertCategoryTranslationsFree,
  categoryNameInputSchema,
  categoryTranslationsInputSchema,
  findCategoryByTranslatedName,
  nextCategorySortOrder,
  normalizeAndValidateCategoryName,
  normalizeCategoryTranslationChanges,
  slugifyCategoryName,
} from "./_shared/category-naming";
import { ensureCategorySlugs } from "./ensure-category-slugs";

export const reviewCategoryRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    requestId: z.uuid(),
    decision: z.enum(["APPROVE", "REJECT"]),
    reviewNote: plainTextMultilineOptional(1000).optional(),
    // The English name for the category an APPROVAL creates; its slug derives
    // from it. Omitted = the requested name, as before. REQUIRED when the
    // request was made in another language (category-translations FR-007).
    // Ignored on a rejection.
    name: categoryNameInputSchema.optional(),
    // Non-English names for the category an APPROVAL creates. A request made
    // in another language puts its own text under that language unless this
    // names that language explicitly (a value wins; null clears). Ignored on a
    // rejection, and when the request resolves to a category that already
    // exists (that category's names are edited with setCategoryTranslations).
    translations: categoryTranslationsInputSchema.optional(),
  })
  .strict();

export const reviewCategoryRequestOutputSchema = z
  .object({
    request: eventCategoryRequestRecordSchema,
  })
  .strict();

export type ReviewCategoryRequestInput = z.infer<
  typeof reviewCategoryRequestInputSchema
>;
export type ReviewCategoryRequestOutput = z.infer<
  typeof reviewCategoryRequestOutputSchema
>;

export type ReviewCategoryRequestDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function reviewCategoryRequest(
  deps: ReviewCategoryRequestDeps,
  rawInput: unknown,
): Promise<ReviewCategoryRequestOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "reviewCategoryRequest" });

  const execute = async (): Promise<ReviewCategoryRequestOutput> => {
    const input = parseInput(reviewCategoryRequestInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "REVIEWER", "DEVELOPER"],
    });

    // Validated up front (word rules) only when they can be used.
    const approval: ApprovalChoices | null =
      input.decision === "APPROVE" ? approvalChoices(input) : null;

    const reviewed = await translateUniqueViolation(
      deps.repos.tx(async (tx) => {
        const now = deps.clock.now();
        // An approval may create a category, so it takes the naming lock, and
        // takes it FIRST: naming lock, then the request row, the same order
        // `createCategory` uses. Claiming the row first would let a creator
        // (holding the naming lock, waiting for this row) and this approval
        // (holding the row, waiting for the naming lock) deadlock. A rejection
        // creates nothing and takes only its request row.
        if (input.decision === "APPROVE") {
          await tx.categories.lockNaming();
        }
        const request = await tx.categoryRequests.claimPendingForReview({
          id: input.requestId,
          reviewedByHumanId: input.actorHumanId,
          reviewedAt: now,
        });
        if (!request) {
          const existing = await tx.categoryRequests.getById(input.requestId);
          if (!existing) {
            throw fail("CATEGORY_REQUEST_NOT_FOUND");
          }
          throw fail("CATEGORY_REQUEST_ALREADY_REVIEWED");
        }

        const resolved = approval
          ? await approveRequest(tx, request, approval)
          : null;

        const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
        const updated = await tx.categoryRequests.markReviewed({
          id: request.id,
          status,
          reviewedByHumanId: input.actorHumanId,
          reviewedAt: now,
          reviewNote: input.reviewNote ?? null,
          resolvedCategoryId: resolved?.categoryId ?? null,
        });

        await tx.audit.log({
          entity: "event_category_request",
          entityId: request.id,
          action: "category_request.reviewed",
          data: {
            actorHumanId: input.actorHumanId,
            decision: input.decision,
            status,
            reviewNote: input.reviewNote ?? null,
            resolvedCategoryId: resolved?.categoryId ?? null,
            ...(resolved
              ? {
                  // How the approval found its category, the English name
                  // that category carries, and the translations stored by
                  // this approval (none when it resolved to one).
                  resolution: resolved.resolution,
                  categoryName: resolved.categoryName,
                  ...(Object.keys(resolved.nameTranslations).length > 0
                    ? { nameTranslations: resolved.nameTranslations }
                    : {}),
                  ...(resolved.esSlug !== null
                    ? { esSlug: resolved.esSlug }
                    : {}),
                }
              : {}),
          },
          at: now,
        });

        return updated;
      }),
    );

    return reviewCategoryRequestOutputSchema.parse({ request: reviewed });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reviewCategoryRequest", execute);
  }

  return execute();
}

/** What the reviewer chose for an approval, validated before the tx. */
type ApprovalChoices = {
  /** Normalised English name, or null to use the requested name. */
  englishName: string | null;
  /** Slug derived from `englishName`; null when it is null. */
  englishSlug: string | null;
  /** Per locale: a name to store, null to clear, absent = default. */
  translationChanges: ReturnType<typeof normalizeCategoryTranslationChanges>;
};

function approvalChoices(input: {
  name?: string;
  translations?: Parameters<typeof normalizeCategoryTranslationChanges>[0];
}): ApprovalChoices {
  const englishName =
    input.name === undefined
      ? null
      : normalizeAndValidateCategoryName(input.name);
  return {
    englishName,
    // Throws INVALID_CATEGORY_REQUEST_NAME for a name that cannot be slugged.
    englishSlug: englishName === null ? null : slugifyCategoryName(englishName),
    translationChanges: normalizeCategoryTranslationChanges(input.translations),
  };
}

type ApprovalResult = {
  categoryId: string;
  /** English name of the category the request resolved to. */
  categoryName: string;
  /**
   * "created": this approval made the category. "slug": one already had the
   * slug the English name derives. "translatedName": one already carried the
   * requested name in the request's language.
   */
  resolution: "created" | "slug" | "translatedName";
  /** The translations stored: none when the category already existed. */
  nameTranslations: CategoryNameTranslations;
  /** The es slug this approval made; null when it made none. */
  esSlug: string | null;
};

/**
 * Find or create the category an approved request asked for.
 *
 * English name and slug: the reviewer's `name` when given, else the request's
 * (as before). A request made in a translation locale (`request.locale` "es")
 * MUST come with the reviewer's English name, refused with
 * `CATEGORY_ENGLISH_NAME_REQUIRED` otherwise: the requested Spanish text never
 * becomes the English name (or the slug). Requests with locale null or "en"
 * behave as before when no name is given.
 *
 * Resolution, in order (the caller holds the naming lock):
 *  1. a category already at the final slug: approve onto it (as before).
 *     That includes a category holding the slug as another of its URLs,
 *     an old English one or a Spanish one (resolution "slug"): a slug
 *     string names one category across locales and its URL leads there. A
 *     reviewer who wants a separate category gives a different English name;
 *  2. for a request in a translation locale, a category whose name in that
 *     language is the requested text, without case: approve onto it. This is
 *     the translated twin of 1: the organiser asked for a category that
 *     already exists under that name in their language;
 *  3. otherwise create it, held to the shared English rule
 *     (`assertCategoryNamingFree`) and the per-language rule.
 *
 * Translations stored on create: the requested text under the request's
 * language, then the reviewer's explicit `translations` on top (a value
 * replaces it, null clears it).
 */
async function approveRequest(
  tx: TxRepos,
  request: EventCategoryRequestRecord,
  choices: ApprovalChoices,
): Promise<ApprovalResult> {
  const requestLocale: CategoryTranslationLocale | null =
    request.locale && isCategoryTranslationLocale(request.locale)
      ? request.locale
      : null;

  if (requestLocale && choices.englishName === null) {
    throw fail("CATEGORY_ENGLISH_NAME_REQUIRED", {
      meta: { locale: requestLocale },
    });
  }

  const name = choices.englishName ?? request.name;
  const slug = choices.englishSlug ?? request.slug;

  const bySlug = await tx.categories.getBySlug(slug);
  if (bySlug) {
    return {
      categoryId: bySlug.id,
      categoryName: bySlug.name,
      resolution: "slug",
      nameTranslations: {},
      esSlug: null,
    };
  }

  // The slug is another URL of a category: an old English one, or a Spanish
  // one. A slug string names one category across locales, and the resolver
  // sends that URL to it, so the request is for that category.
  const slugHolder = (await tx.categories.findSlugsBySlug(slug))[0];
  const byOtherUrl = slugHolder
    ? await tx.categories.getById(slugHolder.categoryId)
    : null;
  if (byOtherUrl) {
    return {
      categoryId: byOtherUrl.id,
      categoryName: byOtherUrl.name,
      resolution: "slug",
      nameTranslations: {},
      esSlug: null,
    };
  }

  const categories = await tx.categories.listAll();

  if (requestLocale) {
    const byTranslatedName = findCategoryByTranslatedName(
      categories,
      requestLocale,
      request.name,
    );
    if (byTranslatedName) {
      return {
        categoryId: byTranslatedName.id,
        categoryName: byTranslatedName.name,
        resolution: "translatedName",
        nameTranslations: {},
        esSlug: null,
      };
    }
  }

  const nameTranslations = applyCategoryTranslationChanges(
    requestLocale ? { [requestLocale]: request.name } : {},
    choices.translationChanges,
  );

  assertCategoryNamingFree(categories, { name, slug });
  assertCategoryTranslationsFree(categories, nameTranslations);
  const sortOrder = nextCategorySortOrder(
    categories.map((category) => category.sortOrder),
  );
  const created: CategoryRecord = await tx.categories.create({
    slug,
    name,
    active: true,
    sortOrder,
    nameTranslations,
  });
  // A Spanish name stored by this approval also makes the es slug (FR-008).
  const ensured = await ensureCategorySlugs(tx, created);
  return {
    categoryId: created.id,
    categoryName: created.name,
    resolution: "created",
    nameTranslations: created.nameTranslations ?? {},
    esSlug: ensured.written.find((row) => row.locale === "es")?.slug ?? null,
  };
}

/**
 * Translate-and-throw, outside the transaction the violation aborted. A
 * name-only race with a concurrent `createCategory` makes the insert in
 * `approveRequest` raise P2002 on `Category.name`. No other write in the
 * transaction can: the claim is an `updateMany` on an existing row, and
 * `markReviewed` and the audit insert use fresh or existing ids.
 */
async function translateUniqueViolation<T>(run: Promise<T>): Promise<T> {
  try {
    return await run;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw fail("CATEGORY_ALREADY_EXISTS", { cause: err });
    }
    throw err;
  }
}
