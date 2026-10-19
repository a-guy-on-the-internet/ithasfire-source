import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventCategoryRequestRecord } from "@th/ports/repos/category-requests";
import type { Repos } from "@th/ports/repos";
import { categoryNames, EVENT_SCHEMA_TYPES } from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { isUniqueViolation } from "../places/_shared/claim";
import {
  applyCategoryTranslationChanges,
  assertCategoryNamingFree,
  assertCategoryTranslationsFree,
  categoryNameInputSchema,
  categoryTranslationsInputSchema,
  nextCategorySortOrder,
  normalizeAndValidateCategoryName,
  normalizeCategoryTranslationChanges,
  slugifyCategoryName,
} from "./_shared/category-naming";
import { categoryNamesSchema } from "./_shared/category-output";
import { assertSlugUnheld } from "./_shared/category-slugs";
import { ensureCategorySlugs } from "./ensure-category-slugs";

export const createCategoryInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    // Sanitised and bounded at the boundary, then normalised with the same
    // functions the request path uses (see `_shared/category-naming.ts`).
    name: categoryNameInputSchema,
    // Allowlisted at the boundary: only curated schema.org Event subtypes are
    // accepted, so a bad value can never reach the DB / JSON-LD.
    seoType: z.enum(EVENT_SCHEMA_TYPES).default("Event"),
    // Non-English names, optional. Blank / null = none. Unique within their
    // language (see `assertCategoryTranslationsFree`); never the slug source.
    translations: categoryTranslationsInputSchema.optional(),
  })
  .strict();

export const createCategoryOutputSchema = z
  .object({
    category: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      names: categoryNamesSchema,
      seoType: z.string(),
      active: z.boolean(),
      sortOrder: z.number().int(),
    }),
    /** Pending requests for this slug that this creation approved. */
    resolvedRequestCount: z.number().int().nonnegative(),
  })
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;
export type CreateCategoryOutput = z.infer<typeof createCategoryOutputSchema>;

export type CreateCategoryDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Create a platform category directly. Platform ADMIN / DEVELOPER only, the
 * same level as deleting one or setting its SEO type (REVIEWERs approve
 * requests; they do not author taxonomy).
 *
 * The name is normalised and the slug derived by the functions the request
 * path uses, so a category made here and one made by approving a request
 * agree about the slug. There is no content filter on this staff path.
 *
 * Refused with `CATEGORY_ALREADY_EXISTS` when the slug or the name is taken,
 * by the one rule every naming path shares (`assertCategoryNamingFree`: stored
 * slug, name without case, and the slug another category's current name would
 * derive), and when any category holds the slug as a URL in any language,
 * current or old (a slug string names one category; an old URL keeps
 * redirecting to its category, spanish-seo R14).
 * The transaction takes `categories.lockNaming()` before it reads, so
 * a concurrent create, rename or approval waits and then sees this one's
 * result. The unique indexes on `Category.slug` and `Category.name` remain as
 * the backstop, and that violation is mapped to the same code outside the
 * transaction.
 *
 * Optional `translations` (non-English names) are validated by the same word
 * rules and must be unique within their language across every category,
 * checked under the same lock (`assertCategoryTranslationsFree`). The slug
 * always derives from the English `name`.
 *
 * Lock order: naming lock, THEN request rows. `reviewCategoryRequest` takes
 * them in the same order when it approves, and no path takes the naming lock
 * while holding a request row, so the two cannot deadlock.
 *
 * Every PENDING request for the new slug is approved in the same transaction
 * with `resolvedCategoryId` set, exactly as `reviewCategoryRequest` would
 * leave it (same repo calls, same audit row). Like that path, nothing is sent
 * to the requester. The requests are claimed BEFORE the category is inserted;
 * a request a reviewer is REJECTING at the same moment is already claimed, so
 * it comes back null here and stays theirs.
 */
export async function createCategory(
  deps: CreateCategoryDeps,
  rawInput: unknown,
): Promise<CreateCategoryOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createCategory" });

  const execute = async (): Promise<CreateCategoryOutput> => {
    const input = parseInput(createCategoryInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    const name = normalizeAndValidateCategoryName(input.name);
    const slug = slugifyCategoryName(name);
    // Throws INVALID_CATEGORY_REQUEST_NAME for a translation that breaks the
    // word rules. Blank / null entries drop out.
    const nameTranslations = applyCategoryTranslationChanges(
      {},
      normalizeCategoryTranslationChanges(input.translations),
    );

    const runTx = () =>
      deps.repos.tx(async (tx) => {
        const now = deps.clock.now();

        // First statement, before any read (see the docstring).
        await tx.categories.lockNaming();

        const categories = await tx.categories.listAll();
        assertCategoryNamingFree(categories, { name, slug });
        assertCategoryTranslationsFree(categories, nameTranslations);
        // A slug row of any category in any locale, current OR old: a slug
        // string names one category, and an old URL still 308s to its
        // category and is never taken over (R14).
        await assertSlugUnheld(tx, slug);

        // Claim first, create second (see the docstring). A request another
        // reviewer already claimed comes back null and is theirs to finish.
        const claimed: EventCategoryRequestRecord[] = [];
        for (const pending of await tx.categoryRequests.listPendingBySlug(
          slug,
        )) {
          const request = await tx.categoryRequests.claimPendingForReview({
            id: pending.id,
            reviewedByHumanId: input.actorHumanId,
            reviewedAt: now,
          });
          if (request) {
            claimed.push(request);
          }
        }

        const sortOrder = nextCategorySortOrder(
          categories.map((category) => category.sortOrder),
        );
        const created = await tx.categories.create({
          slug,
          name,
          active: true,
          sortOrder,
          seoType: input.seoType,
          nameTranslations,
        });

        for (const request of claimed) {
          await tx.categoryRequests.markReviewed({
            id: request.id,
            status: "APPROVED",
            reviewedByHumanId: input.actorHumanId,
            reviewedAt: now,
            reviewNote: null,
            resolvedCategoryId: created.id,
          });

          // Same row `reviewCategoryRequest` writes for an approval.
          await tx.audit.log({
            entity: "event_category_request",
            entityId: request.id,
            action: "category_request.reviewed",
            data: {
              actorHumanId: input.actorHumanId,
              decision: "APPROVE",
              status: "APPROVED",
              reviewNote: null,
              resolvedCategoryId: created.id,
            },
            at: now,
          });
        }

        // An es name given here also makes the es slug (FR-008).
        const ensured = await ensureCategorySlugs(tx, created);
        const esSlug =
          ensured.written.find((row) => row.locale === "es")?.slug ?? null;

        const resolvedRequestIds = claimed.map((request) => request.id);

        await tx.audit.log({
          entity: "category",
          entityId: created.id,
          action: "category.created",
          data: {
            actorHumanId: input.actorHumanId,
            slug: created.slug,
            name: created.name,
            seoType: created.seoType,
            sortOrder: created.sortOrder,
            nameTranslations: created.nameTranslations,
            ...(esSlug !== null ? { esSlug } : {}),
            resolvedRequestIds,
          },
          at: now,
        });

        return {
          category: {
            id: created.id,
            slug: created.slug,
            name: created.name,
            names: categoryNames(created),
            seoType: created.seoType,
            active: created.active,
            sortOrder: created.sortOrder,
          },
          resolvedRequestCount: resolvedRequestIds.length,
        };
      });

    let result: Awaited<ReturnType<typeof runTx>>;
    try {
      result = await runTx();
    } catch (err) {
      // Lost a race with another creator (or an approval of a request for the
      // same slug): the unique index on slug or name refused the insert.
      // Translated here, outside the transaction the violation aborted; this
      // rethrows, it does not fall back. The audit row and the request
      // updates use fresh ids, so the category insert is the only statement
      // in the transaction that can raise it.
      // Which index fired (slug or name) is not set on `meta.field` here:
      // Prisma's P2002 target shape differs by driver adapter, so it cannot
      // be read reliably.
      if (isUniqueViolation(err)) {
        throw fail("CATEGORY_ALREADY_EXISTS", { cause: err });
      }
      throw err;
    }

    return createCategoryOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createCategory", execute);
  }

  return execute();
}
