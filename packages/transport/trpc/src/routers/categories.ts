import { z } from "zod";
import { eventSummaryDtoSchema } from "@th/types";
import {
  listCategories,
  listBrowseCategories,
  setEventCategory,
  listEventsByCategory,
  listEventsByCategoryInputSchema,
  requestCategoryOption,
  requestCategoryOptionInputSchema,
  requestCategoryOptionOutputSchema,
  listCategoryRequests,
  listCategoryRequestsInputSchema,
  listCategoryRequestsOutputSchema,
  reviewCategoryRequest,
  reviewCategoryRequestInputSchema,
  reviewCategoryRequestOutputSchema,
  createCategory,
  createCategoryInputSchema,
  createCategoryOutputSchema,
  deleteCategory,
  deleteCategoryInputSchema,
  deleteCategoryOutputSchema,
  setCategorySeoType,
  setCategorySeoTypeInputSchema,
  setCategorySeoTypeOutputSchema,
  renameCategory,
  renameCategoryInputSchema,
  renameCategoryOutputSchema,
  setCategoryActive,
  setCategoryActiveInputSchema,
  setCategoryActiveOutputSchema,
  reorderCategories,
  reorderCategoriesInputSchema,
  reorderCategoriesOutputSchema,
  listAllCategories,
  listAllCategoriesOutputSchema,
  categoryNamesSchema,
  categorySlugsSchema,
  setCategoryTranslations,
  setCategoryTranslationsInputSchema,
  setCategoryTranslationsOutputSchema,
  suggestCategoryTranslations,
  suggestCategoryTranslationsInputSchema,
  suggestCategoryTranslationsOutputSchema,
  resolveCategorySlug,
  resolveCategorySlugInputSchema,
  resolveCategorySlugOutputSchema,
  changeCategorySlug,
  changeCategorySlugInputSchema,
  changeCategorySlugOutputSchema,
} from "@th/core/use-cases/categories";
import { publicProcedure, authedProcedure, rateLimit } from "../init";
import { publicDiscoveryCacheFor } from "../anonymous-request";
import { countryEventsToDto } from "../event-summary-mapper";
import { toTrpcError } from "../utils";

const requestOptionInput = requestCategoryOptionInputSchema.omit({
  actorHumanId: true,
});

const categoryListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** `en` always, each translation when set; show `names[locale] ?? names.en`. */
  names: categoryNamesSchema,
  /**
   * Current URL slug per language: `en` (= `slug`) always, `es` when the
   * category has one. Links on an /es/ page use `slugs.es ?? slugs.en`.
   */
  slugs: categorySlugsSchema,
  active: z.boolean(),
  sortOrder: z.number().int(),
  /** schema.org Event `@type` this category emits in event JSON-LD. */
  seoType: z.string(),
});

export const categoriesRouter = {
  /** List all active categories, sorted by sortOrder. Public. */
  list: publicProcedure
    .output(z.object({ categories: z.array(categoryListItemSchema) }))
    .query(async ({ ctx }) => {
      const categories = await listCategories({
        repos: ctx.repos,
        logger: ctx.logger,
        // Anonymous requests only — see `isAnonymousRequest`. The home page
        // renders this for the uptime check every ~50s.
        cache: publicDiscoveryCacheFor(ctx),
      });
      return { categories };
    }),

  /**
   * Active categories whose page lists at least one upcoming event, sorted by
   * sortOrder: the homepage's browse entry points (hero chips, "Browse by
   * category"). Public. Pickers and facets keep `list`, which includes empty
   * categories.
   */
  listBrowsable: publicProcedure
    .output(z.object({ categories: z.array(categoryListItemSchema) }))
    .query(async ({ ctx }) => {
      const categories = await listBrowseCategories({
        repos: ctx.repos,
        logger: ctx.logger,
        clock: ctx.clock,
        // Anonymous requests only — see `isAnonymousRequest`. The home page
        // renders this for the uptime check every ~50s.
        cache: publicDiscoveryCacheFor(ctx),
      });
      return { categories };
    }),

  /** Set the category on an event. Authed. */
  setEventCategory: authedProcedure
    .input(
      z.object({
        eventId: z.string().uuid(),
        categorySlug: z.string().min(2).max(32),
      }),
    )
    .output(
      z.object({
        eventId: z.string(),
        category: z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          names: categoryNamesSchema,
          sortOrder: z.number().int(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await setEventCategory(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  requestOption: authedProcedure
    .input(requestOptionInput)
    .use(
      rateLimit<z.infer<typeof requestOptionInput>>({
        key: (ctx) => `categories:requestOption:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 12,
        windowSeconds: 60 * 60,
        message: "requesting category options",
      }),
    )
    .output(requestCategoryOptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await requestCategoryOption(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            contentFilter: ctx.contentFilter,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listRequests: authedProcedure
    .input(listCategoryRequestsInputSchema.omit({ actorHumanId: true }))
    .output(listCategoryRequestsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listCategoryRequests(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reviewRequest: authedProcedure
    .input(reviewCategoryRequestInputSchema.omit({ actorHumanId: true }))
    .output(reviewCategoryRequestOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await reviewCategoryRequest(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Create a category directly. Platform ADMIN / DEVELOPER only (enforced in
   * the use case). The slug is derived from the name the same way a category
   * request derives it; a taken slug or name is refused with
   * CATEGORY_ALREADY_EXISTS. Pending requests for the new slug are approved
   * in the same transaction (`resolvedRequestCount`). `seoType` is optional
   * and defaults to "Event".
   */
  create: authedProcedure
    .input(createCategoryInputSchema.omit({ actorHumanId: true }))
    .output(createCategoryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCategory(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Hard-delete a category. Platform ADMIN / DEVELOPER only. Events that
   * referenced the category fall back to uncategorised via SetNull.
   */
  delete: authedProcedure
    .input(deleteCategoryInputSchema.omit({ actorHumanId: true }))
    .output(deleteCategoryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await deleteCategory(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Set the schema.org Event `@type` a category emits in event JSON-LD.
   * Platform ADMIN / DEVELOPER only (enforced in the use case). The input is
   * allowlist-validated against EVENT_SCHEMA_TYPES.
   */
  setSeoType: authedProcedure
    .input(setCategorySeoTypeInputSchema.omit({ actorHumanId: true }))
    .output(setCategorySeoTypeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await setCategorySeoType(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Rename a category. Platform ADMIN / DEVELOPER only (enforced in the use
   * case). The slug does not change, so category URLs stay where they are.
   * A name another category carries, or whose derived slug another category
   * holds, is refused with CATEGORY_ALREADY_EXISTS. Renaming to the current
   * name succeeds and writes nothing.
   */
  rename: authedProcedure
    .input(renameCategoryInputSchema.omit({ actorHumanId: true }))
    .output(renameCategoryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await renameCategory(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Set, change or clear a category's non-English names. Platform ADMIN /
   * DEVELOPER only (enforced in the use case). `translations.es`: a name sets
   * it, null clears it, absent leaves it. English and the slug do not change.
   */
  setTranslations: authedProcedure
    .input(setCategoryTranslationsInputSchema.omit({ actorHumanId: true }))
    .output(setCategoryTranslationsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await setCategoryTranslations(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Machine-translate a category name to prefill the /platform forms. Platform
   * ADMIN / DEVELOPER / REVIEWER (enforced in the use case). Writes nothing;
   * a translator failure or an unwired translator returns no suggestions.
   * Rate-limited per actor inside the use case.
   */
  suggestTranslations: authedProcedure
    .input(suggestCategoryTranslationsInputSchema.omit({ actorHumanId: true }))
    .output(suggestCategoryTranslationsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await suggestCategoryTranslations(
          {
            authz: ctx.authz,
            translator: ctx.translator ?? undefined,
            rateLimit: ctx.rateLimit,
            reportError: ctx.reportError ?? undefined,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Which category page a URL slug names, in the URL's language: render it,
   * redirect (308) to the current slug, or not found. Public, read-only. The
   * web calls it from the category and /es/ category routes.
   */
  resolveSlug: publicProcedure
    .input(resolveCategorySlugInputSchema)
    .output(resolveCategorySlugOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await resolveCategorySlug(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Change a category's URL slug in one language; the old one keeps
   * redirecting. Platform ADMIN / DEVELOPER only (enforced in the use case).
   * A slug another category holds is CATEGORY_SLUG_TAKEN (CONFLICT); one
   * that breaks the slug rules is INVALID_CATEGORY_SLUG.
   */
  changeSlug: authedProcedure
    .input(changeCategorySlugInputSchema.omit({ actorHumanId: true }))
    .output(changeCategorySlugOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await changeCategorySlug(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Deactivate or reactivate a category. Platform ADMIN / DEVELOPER only
   * (enforced in the use case). Events keep their category. Setting the state
   * it already has succeeds and writes nothing.
   */
  setActive: authedProcedure
    .input(setCategoryActiveInputSchema.omit({ actorHumanId: true }))
    .output(setCategoryActiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await setCategoryActive(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Put the categories in a new order. Platform ADMIN / DEVELOPER only
   * (enforced in the use case). `orderedCategoryIds` must be every category
   * id, inactive ones included, each once; otherwise INVALID_INPUT and
   * nothing is written. Returns the full list in the new order.
   */
  reorder: authedProcedure
    .input(reorderCategoriesInputSchema.omit({ actorHumanId: true }))
    .output(reorderCategoriesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await reorderCategories(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * List every category, inactive ones included, by sortOrder then name.
   * Platform ADMIN / REVIEWER / DEVELOPER only (enforced in the use case).
   * `list` is the public, active-only one.
   */
  listAll: authedProcedure
    .output(listAllCategoriesOutputSchema)
    .query(async ({ ctx }) => {
      try {
        return await listAllCategories(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** List published events in a given category. Public. */
  eventsByCategory: publicProcedure
    .input(
      listEventsByCategoryInputSchema.omit({ categorySlug: true }).extend({
        categorySlug: z.string().min(1).max(64),
      }),
    )
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        total: z.number().int(),
        /** Ungated upcoming events: the page is indexable when >= 1. */
        indexableTotal: z.number().int(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const result = await listEventsByCategory(
          {
            repos: ctx.repos,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );

        // Re-use the country event DTO mapper since the shape matches.
        const events = countryEventsToDto(result.events);
        return {
          events,
          total: result.total,
          indexableTotal: result.indexableTotal,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
