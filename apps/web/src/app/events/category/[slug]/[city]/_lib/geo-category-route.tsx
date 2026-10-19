import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import {
  buildCitySegment,
  MIN_EVENTS_PER_GEO_CATEGORY_PAGE,
} from "@th/core/use-cases/events";
import {
  geoCategoryPageRobots,
  truncateMetaDescription,
  type BreadcrumbListItem,
} from "@th/types";

import { buildCanonicalUrl, getSiteName, getSiteUrl } from "@/config/site";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { PublicTwins, type PublicTwinSet } from "@/i18n";
import { DEFAULT_LOCALE, type AppLocale } from "@/i18n/config";
import { publicPath } from "@/i18n/public-paths";
import { serverTranslator } from "@/i18n/server-translator";
import { homeUrl, twinAlternates } from "@/lib/seo/public-twins";
import { resolveCategoryRoute } from "@/server/categories";
import {
  loadGeoCategoryEvents,
  type GeoCategoryEventsPayload,
} from "@/server/events";
import { GeoCategoryPage } from "../_components/GeoCategoryPage";

/**
 * The category-in-a-city page in one language:
 * `/events/category/<slug>/<city>` (en) and
 * `/es/eventos/categoria/<slug>/<city>` (es). Both route files call these
 * two functions with their locale (spanish-seo R21, FR-001). City segments
 * are the same in every language (R17).
 *
 * The category slug resolves first (FR-010): an old or other-language slug
 * 308s to this language's page with the city segment kept as asked (the
 * next request canonicalises it); an unknown one 404s. The events load by
 * the category's English slug, so an inactive category 404s in both.
 */

/**
 * The ONE city segment a geo×category page lives at, rebuilt from what the
 * use case resolved: `/open-mics/Nashville`, `/open-mics/nashville` and
 * `/open-mics/nashville-tn` all collapse onto `nashville-tn` when every match
 * is in TN (a city spanning several regions keeps its region-less segment).
 * The output is `[a-z0-9-]` only, and requesting it resolves back to itself,
 * so redirecting to it cannot loop.
 */
function canonicalCitySegment(payload: {
  cityLabel: string;
  regionCode: string | null;
}): string {
  return buildCitySegment(payload.cityLabel, payload.regionCode);
}

type Resolved =
  | { kind: "notFound" }
  | {
      kind: "page";
      slugs: Partial<Record<AppLocale, string>>;
      payload: GeoCategoryEventsPayload;
    };

async function resolveAndLoad(
  locale: AppLocale,
  slug: string,
  city: string,
): Promise<Resolved> {
  const resolution = await resolveCategoryRoute(locale, slug);
  if (resolution.kind === "redirect") {
    permanentRedirect(
      publicPath(locale, {
        kind: "cityCategory",
        slug: resolution.slug,
        city,
      }),
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
  if (!enSlug) throw new Error("Category slug resolution unavailable");

  const payload = await loadGeoCategoryEvents(enSlug, city);
  if (!payload) return { kind: "notFound" };
  return { kind: "page", slugs, payload };
}

type PageFacts = {
  /** The category name shown in `locale`. */
  categoryName: string;
  canonicalSegment: string;
  paths: Partial<Record<AppLocale, string>>;
  /** Per language whose path is known: may it be indexed. */
  indexable: Partial<Record<AppLocale, boolean>>;
  /** The page's own robots (thin-page rule, then R9). */
  robots: { index: boolean; follow: boolean };
  title: string;
  description: string;
};

function pageFacts(
  locale: AppLocale,
  r: Extract<Resolved, { kind: "page" }>,
): PageFacts {
  const { payload } = r;
  const t = serverTranslator(locale);
  const translated = payload.names?.[locale]?.trim();
  const categoryName =
    locale === DEFAULT_LOCALE
      ? payload.categoryName
      : translated || payload.categoryName;

  // Canonicalise to the rebuilt segment so `/open-mics/Nashville` and
  // `/open-mics/nashville-tn` both collapse onto ONE canonical URL (kills
  // duplicate content across casing/region variants).
  const canonicalSegment = canonicalCitySegment(payload);
  const paths: Partial<Record<AppLocale, string>> = {};
  for (const [l, s] of Object.entries(r.slugs) as Array<[AppLocale, string]>) {
    paths[l] = publicPath(l, {
      kind: "cityCategory",
      slug: s,
      city: canonicalSegment,
    });
  }

  // Thin-page guard: `index` is only true when the UNGATED count >= MIN.
  // Below it the page stays crawlable (`follow`) but noindex, in every
  // language (both list the same events). Gated ones list but their pages
  // are noindex, so they do not lift a thin page over the threshold (owner
  // ruling 2026-10-13); the geo×category sitemap counts the same way.
  const thinRobots = geoCategoryPageRobots({
    indexableCount: payload.indexableTotal,
    minEvents: MIN_EVENTS_PER_GEO_CATEGORY_PAGE,
  });

  // A language the category has no name in is noindex there (R9). An
  // unknown name set (an older API) claims the English default only.
  const indexable: Partial<Record<AppLocale, boolean>> = {};
  for (const l of Object.keys(paths) as AppLocale[]) {
    indexable[l] =
      thinRobots.index &&
      (l === DEFAULT_LOCALE || Boolean(payload.names?.[l]?.trim()));
  }
  const robots = { index: indexable[locale] ?? false, follow: true };

  const category = categoryName.toLowerCase();
  const city = payload.cityLabel;
  const count = payload.total;
  const description =
    count === 0
      ? t("publicSeo.cityDescriptionNone", { category, city })
      : count === 1
        ? t("publicSeo.cityDescriptionOne", { category, city })
        : t("publicSeo.cityDescriptionMany", { category, city, count });

  return {
    categoryName,
    canonicalSegment,
    paths,
    indexable,
    robots,
    title: t("publicSeo.cityTitle", { category: categoryName, city }),
    description: truncateMetaDescription(description),
  };
}

export async function geoCategoryMetadata(
  locale: AppLocale,
  slug: string,
  city: string,
): Promise<Metadata> {
  const r = await resolveAndLoad(locale, slug, city);

  // Unknown / inactive combo — the page body 404s; keep it out of the index.
  if (r.kind === "notFound") {
    return {
      title: serverTranslator(locale)("publicSeo.notFoundTitle"),
      robots: { index: false, follow: false },
    };
  }

  const facts = pageFacts(locale, r);
  const canonical = buildCanonicalUrl(facts.paths[locale]!);
  const { en, es } = facts.paths;
  const siteName = getSiteName();

  return {
    title: facts.title,
    description: facts.description,
    alternates:
      en && es
        ? twinAlternates(
            locale,
            { en, es },
            {
              en: facts.indexable.en === true,
              es: facts.indexable.es === true,
            },
          )
        : { canonical },
    robots: facts.robots,
    openGraph: {
      type: "website",
      url: canonical,
      title: `${facts.title} • ${siteName}`,
      description: facts.description,
      siteName,
    },
    twitter: {
      card: "summary",
      title: `${facts.title} • ${siteName}`,
      description: facts.description,
    },
  };
}

/** The page body; a server component in both route files. */
export async function GeoCategoryRouteBody({
  locale,
  slug,
  city,
}: {
  locale: AppLocale;
  slug: string;
  city: string;
}) {
  const r = await resolveAndLoad(locale, slug, city);

  // Unknown combos AND thin (zero-event) combos 404 — never render an empty
  // indexable shell.
  if (
    r.kind === "notFound" ||
    r.payload.total === 0 ||
    r.payload.events.length === 0
  ) {
    notFound();
  }

  const facts = pageFacts(locale, r);

  // One indexable URL per page: a casing, region-less or otherwise
  // non-canonical segment 308s to the canonical one instead of rendering a
  // duplicate. An empty segment (a locality with no ASCII letters or digits)
  // has no URL to send anyone to, so it renders in place.
  if (facts.canonicalSegment && facts.canonicalSegment !== city) {
    permanentRedirect(facts.paths[locale]!);
  }

  const t = serverTranslator(locale);
  const siteUrl = getSiteUrl();

  // ItemList → each event's canonical `/events/<slug>`, in render order.
  // Gated events stay out, as on the category page: a gated event's own page
  // is noindex,nofollow, so advertising it here would point crawlers at a
  // page they are told to drop. The geo DTO (`localEventsToDto`) carries
  // `gateType` only for a gated event. Event pages have one URL in every
  // language (R4).
  const listItems = r.payload.events
    .filter((event) => event.slug && !event.gateType)
    .map((event) => ({
      url: buildCanonicalUrl(`/events/${event.slug}`),
      name: event.title,
    }));

  // Home › Events › <Category> › <City> (last crumb = current page, no url).
  const categorySlug = r.slugs[locale]!;
  const breadcrumbItems: BreadcrumbListItem[] = [
    { name: t("publicSeo.crumbHome"), url: homeUrl(locale) },
    { name: t("publicSeo.crumbEvents"), url: `${siteUrl}/search` },
    {
      name: facts.categoryName,
      url: buildCanonicalUrl(
        publicPath(locale, { kind: "category", slug: categorySlug }),
      ),
    },
    { name: r.payload.cityLabel },
  ];

  const twins: PublicTwinSet = {};
  for (const [l, path] of Object.entries(facts.paths) as Array<
    [AppLocale, string]
  >) {
    twins[l] = { path, indexable: facts.indexable[l] === true };
  }

  return (
    <>
      <PublicTwins twins={twins} />
      <EventListJsonLd items={listItems} inLanguage={locale} />
      <BreadcrumbJsonLd items={breadcrumbItems} inLanguage={locale} />
      <GeoCategoryPage
        events={r.payload.events}
        categoryName={r.payload.categoryName}
        categoryNames={r.payload.names}
        cityLabel={r.payload.cityLabel}
        count={r.payload.total}
      />
    </>
  );
}
