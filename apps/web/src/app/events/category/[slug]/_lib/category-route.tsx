import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import type { BreadcrumbListItem } from "@th/types";

import { buildCanonicalUrl, getSiteName, getSiteUrl } from "@/config/site";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { PublicTwins, type PublicTwinSet } from "@/i18n";
import { DEFAULT_LOCALE, type AppLocale } from "@/i18n/config";
import { publicPath } from "@/i18n/public-paths";
import { serverTranslator } from "@/i18n/server-translator";
import {
  homeUrl,
  twinAlternates,
  twinSet,
  type TwinIndexable,
  type TwinPaths,
} from "@/lib/seo/public-twins";
import { resolveCategoryRoute } from "@/server/categories";
import { loadCategoryPageEvents } from "@/server/events";
import type { CategoryPageLoad } from "@/server/events";
import { CategoryPage as CategoryPageClient } from "../_components/CategoryPage";

/**
 * The category page in one language: `/events/category/<slug>` (en) and
 * `/es/eventos/categoria/<slug>` (es). Both route files call these two
 * functions with their locale (spanish-seo R21, FR-001).
 *
 * The URL slug is resolved first (FR-010): an old or other-language slug
 * 308s to this language's page, an unknown one 404s. The events load by the
 * category's ENGLISH slug in both languages, so an inactive category 404s
 * under /es/ exactly as it does in English.
 */

/**
 * The category's own name when the load has it (only `found` carries it);
 * otherwise the slug title-cased: "food-drink" -> "Food Drink". The loader
 * returns the slug itself as the name when the category list failed, so a name
 * equal to the slug counts as unknown.
 */
export function englishCategoryTitle(
  slug: string,
  load: CategoryPageLoad,
): string {
  if (load.status === "found") {
    const name = load.categoryName.trim();
    if (name && name !== slug) return name;
  }
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type Resolved =
  | { kind: "notFound" }
  | {
      kind: "page";
      enSlug: string;
      slugs: Partial<Record<AppLocale, string>>;
      load: Exclude<CategoryPageLoad, { status: "not-found" }>;
    };

/**
 * Resolve the URL and load the page. Throws Next's 308 for a slug that
 * belongs elsewhere; returns notFound for an unknown or inactive category.
 */
async function resolveAndLoad(
  locale: AppLocale,
  slug: string,
): Promise<Resolved> {
  const resolution = await resolveCategoryRoute(locale, slug);
  if (resolution.kind === "redirect") {
    permanentRedirect(
      publicPath(locale, { kind: "category", slug: resolution.slug }),
    );
  }
  if (resolution.kind === "notFound") return { kind: "notFound" };

  let slugs: Partial<Record<AppLocale, string>>;
  if (resolution.kind === "render") {
    slugs = resolution.slugs;
  } else if (locale === DEFAULT_LOCALE) {
    // The resolver is down (reported there): the English page keeps today's
    // behaviour, the URL slug IS the English slug, and claims no twin.
    slugs = { [DEFAULT_LOCALE]: slug };
  } else {
    // Nothing to load the events by. Not reported there; the error page
    // reports this throw.
    throw resolution.error;
  }

  const enSlug = slugs[DEFAULT_LOCALE];
  if (!enSlug) {
    // Not reached: a render always carries the English slug (the helper
    // answers unavailable when it cannot get one).
    throw new Error("Category slug resolution unavailable");
  }
  const load = await loadCategoryPageEvents(enSlug);
  if (load.status === "not-found") return { kind: "notFound" };
  return { kind: "page", enSlug, slugs, load };
}

type PageFacts = {
  /** The name shown and used in the title, in `locale`. */
  name: string;
  paths: Partial<TwinPaths>;
  /** Per language: true indexable, false noindex, null unknown (claim nothing). */
  indexable: Record<AppLocale, boolean | null>;
};

function pageFacts(
  locale: AppLocale,
  r: Extract<Resolved, { kind: "page" }>,
): PageFacts {
  const english = englishCategoryTitle(r.enSlug, r.load);
  const found = r.load.status === "found" ? r.load : null;
  const translated = found?.categoryNames?.[locale]?.trim();
  const name = locale === DEFAULT_LOCALE ? english : translated || english;

  const paths: Partial<TwinPaths> = {};
  for (const [l, s] of Object.entries(r.slugs) as Array<[AppLocale, string]>) {
    paths[l] = publicPath(l, { kind: "category", slug: s });
  }

  // A thin page (no upcoming ungated event) is noindex in every language.
  // A language whose name the category lacks is noindex there (R9), and so
  // is one whose names are unknown (the list read failed): an /es/ page is
  // indexable only when we know the category has a Spanish name. Otherwise
  // an unknown (a read failed) claims nothing.
  const thin = found ? found.indexableTotal === 0 : null;
  const indexable = {} as Record<AppLocale, boolean | null>;
  for (const l of Object.keys(paths) as AppLocale[]) {
    if (l !== DEFAULT_LOCALE && !found?.categoryNames?.[l]?.trim()) {
      indexable[l] = false;
      continue;
    }
    indexable[l] = thin === null ? null : !thin;
  }
  return { name, paths, indexable };
}

/** Both twins known, true only when known indexable. */
function completePair(facts: PageFacts): {
  paths: TwinPaths;
  indexable: TwinIndexable;
} | null {
  const { en, es } = facts.paths;
  if (!en || !es) return null;
  return {
    paths: { en, es },
    indexable: {
      en: facts.indexable.en === true,
      es: facts.indexable.es === true,
    },
  };
}

export async function categoryMetadata(
  locale: AppLocale,
  slug: string,
): Promise<Metadata> {
  const t = serverTranslator(locale);
  const r = await resolveAndLoad(locale, slug);

  // Unknown / inactive category: the page body 404s; keep it out of the index.
  if (r.kind === "notFound") {
    return {
      title: t("publicSeo.notFoundTitle"),
      robots: { index: false, follow: false },
    };
  }

  const facts = pageFacts(locale, r);
  const title = facts.name;
  const description = t("publicSeo.categoryDescription", {
    category: title.toLowerCase(),
  });
  const ownPath = facts.paths[locale]!;
  const canonical = buildCanonicalUrl(ownPath);
  const siteName = getSiteName();
  const pair = completePair(facts);
  const own = facts.indexable[locale];

  return {
    title,
    description,
    alternates: pair
      ? twinAlternates(locale, pair.paths, pair.indexable)
      : { canonical },
    // A category with no upcoming UNGATED event is a thin page: crawlable
    // (`follow`), never indexed. Gated events still list, but their own pages
    // are noindex, so they do not make this one worth indexing (owner ruling
    // 2026-10-13). The sitemap job leaves the same categories out
    // (`listCategorySitemapEntries`). The /es/ page of a category with no
    // Spanish name is noindex too (R9). When a read failed we know nothing,
    // so we claim nothing and keep the default.
    ...(own === false ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "website",
      url: canonical,
      title: `${title} • ${siteName}`,
      description,
      siteName,
    },
    twitter: {
      card: "summary",
      title: `${title} • ${siteName}`,
      description,
    },
  };
}

function twinsElement(facts: PageFacts) {
  const pair = completePair(facts);
  if (pair) return <PublicTwins twins={twinSet(pair.paths, pair.indexable)} />;
  // One language known (the other's answer failed): register just it, so
  // the provider knows the page has no reachable twin.
  const set: PublicTwinSet = {};
  for (const [l, path] of Object.entries(facts.paths) as Array<
    [AppLocale, string]
  >) {
    set[l] = { path, indexable: facts.indexable[l] === true };
  }
  return <PublicTwins twins={set} />;
}

/** The page body; a server component in both route files. */
export async function CategoryRouteBody({
  locale,
  slug,
}: {
  locale: AppLocale;
  slug: string;
}) {
  const r = await resolveAndLoad(locale, slug);
  if (r.kind === "notFound") {
    notFound();
  }

  const facts = pageFacts(locale, r);
  const load = r.load;
  const englishName = englishCategoryTitle(r.enSlug, load);

  if (load.status === "unavailable") {
    // The server read failed (reported): fall back to the client fetch.
    return (
      <>
        {twinsElement(facts)}
        <CategoryPageClient
          categorySlug={r.enSlug}
          initialCategoryName={englishName}
        />
      </>
    );
  }

  const t = serverTranslator(locale);
  const siteUrl = getSiteUrl();

  // ItemList from the DB page (startsAt ascending, the same date order the
  // search answer uses). The DB rows carry `gateType`; search documents do
  // not. A gated event's own page is noindex,nofollow, so advertising it to
  // crawlers here would point them at a page they are told to drop. Event
  // pages have one URL in every language (R4).
  const listItems = load.seed.db.events
    .filter((event) => event.slug && !event.gateType)
    .map((event) => ({
      url: buildCanonicalUrl(`/events/${event.slug}`),
      name: event.title,
    }));

  // Home › Events › <Category> (last crumb = current page, no url).
  const breadcrumbItems: BreadcrumbListItem[] = [
    { name: t("publicSeo.crumbHome"), url: homeUrl(locale) },
    { name: t("publicSeo.crumbEvents"), url: `${siteUrl}/search` },
    { name: facts.name },
  ];

  return (
    <>
      {twinsElement(facts)}
      <EventListJsonLd items={listItems} inLanguage={locale} />
      <BreadcrumbJsonLd items={breadcrumbItems} inLanguage={locale} />
      <CategoryPageClient
        categorySlug={r.enSlug}
        initialCategoryName={englishName}
        initialCategoryNames={load.categoryNames}
        seed={load.seed}
      />
    </>
  );
}
