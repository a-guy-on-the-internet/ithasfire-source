import "server-only";

import { cache } from "react";
import type { MetadataRoute } from "next";

import { TRPCClientError } from "@trpc/client";

import { buildCanonicalUrl } from "@/config/site";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/i18n/config";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { getPublicTrpcClient, getServerTrpcClient } from "@/server/trpc-client";

type SitemapEntry = MetadataRoute.Sitemap[number];

export const listCategorySitemapEntries = cache(
  async (): Promise<SitemapEntry[]> => {
    const client = getServerTrpcClient();

    try {
      const { categories } = await client.categories.list.query();
      return categories
        .filter((c) => c.active)
        .map((c) => ({
          url: buildCanonicalUrl(`/events/category/${c.slug}`),
          lastModified: new Date(),
          changeFrequency: "weekly" as const,
          priority: 0.5,
        }));
    } catch {
      return [];
    }
  },
);

/**
 * A category route's slug in each language, or where to send the reader.
 *
 * - `render`: the URL names this category's page in its own language.
 *   `slugs` holds the page slug in every language it could get, always the
 *   English one (the event loaders key on it); the others build twin paths.
 * - `redirect`: an old slug, or a slug from the other language; 308 to
 *   `slug` in the SAME language (spanish-seo FR-010, R14, R16).
 * - `notFound`: no category has this slug (or it is not a slug at all).
 * - `unavailable`: the API could not answer the English slug. On an English
 *   page that is a swallow (reported here; the page falls back to the URL
 *   slug and claims no twin). On any other page there is nothing to load
 *   the events by, so the caller throws `error` and the error page reports
 *   it: reported once either way.
 *
 * `active` is not checked here: the event loaders 404 an inactive category,
 * in both languages, because both load by its English slug.
 */
export type CategoryRouteResolution =
  | { kind: "render"; slugs: Partial<Record<AppLocale, string>> }
  | { kind: "redirect"; slug: string }
  | { kind: "notFound" }
  | { kind: "unavailable"; error: unknown };

type SlugAnswer =
  | { kind: "render"; slug: string }
  | { kind: "redirect"; slug: string }
  | { kind: "notFound" }
  | { kind: "unavailable"; error: unknown };

const REPORT_LABEL = "server.categories.resolveCategoryRoute";

const isBadRequest = (err: unknown): boolean =>
  err instanceof TRPCClientError &&
  (err.data as { code?: unknown } | null | undefined)?.code === "BAD_REQUEST";

/** One resolver call. Does not report: the caller decides swallow or throw. */
const resolveOne = async (
  locale: AppLocale,
  slug: string,
): Promise<SlugAnswer> => {
  try {
    const answer = await getPublicTrpcClient().categories.resolveSlug.query({
      locale,
      slug,
    });
    return answer.kind === "notFound"
      ? answer
      : { kind: answer.kind, slug: answer.slug };
  } catch (err) {
    // The input schema rejects a slug no category can have (too long).
    if (isBadRequest(err)) return { kind: "notFound" };
    return { kind: "unavailable", error: err };
  }
};

/**
 * Resolve a category URL slug (`/events/category/<slug>` in `locale`) and,
 * when it renders, the same category's page slug in every other language.
 *
 * The twin's slug is the resolver's own answer for this page slug in the
 * twin's language: a category's slugs share one namespace across languages
 * (spec R15), so asking "es, music" lands on the category that owns "music"
 * and answers with its Spanish page slug (or renders "music" itself when the
 * category has no Spanish slug: its /es/ page lives at the English slug).
 *
 * Not cached across requests (a slug change must 308 at once); `cache()`
 * only shares the answer between `generateMetadata` and the page, which is
 * also why the swallows are reported here, once.
 */
export const resolveCategoryRoute = cache(
  async (locale: AppLocale, slug: string): Promise<CategoryRouteResolution> => {
    const own = await resolveOne(locale, slug);
    if (own.kind === "unavailable") {
      if (locale === DEFAULT_LOCALE) traceIgnoredError(REPORT_LABEL)(own.error);
      return own;
    }
    if (own.kind !== "render") return own;
    // The resolver trims and lowercases: `/Music` names the page at `/music`,
    // which is the one URL it lives at.
    if (own.slug !== slug) return { kind: "redirect", slug: own.slug };

    const slugs: Partial<Record<AppLocale, string>> = { [locale]: own.slug };
    const others = SUPPORTED_LOCALES.filter((l) => l !== locale);
    const answers = await Promise.all(
      others.map((other) => resolveOne(other, own.slug)),
    );
    for (const [i, other] of others.entries()) {
      const answer = answers[i]!;
      if (answer.kind === "render" || answer.kind === "redirect") {
        slugs[other] = answer.slug;
      } else if (answer.kind === "unavailable") {
        // No English slug: the page cannot load, the caller throws.
        if (other === DEFAULT_LOCALE) return answer;
        // Any other twin: the page renders without it.
        traceIgnoredError(REPORT_LABEL)(answer.error);
      }
    }
    return { kind: "render", slugs };
  },
);
