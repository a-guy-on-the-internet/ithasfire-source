import type { Metadata } from "next";

import { buildCanonicalUrl, getSiteName } from "@/config/site";
import { PageContainer } from "@/components/layout/PagePrimitives";
import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { searchEventsByQuery } from "@/server/event-search";
import { UniversalSearchPage } from "./_components/UniversalSearchPage";
import {
  parseCategoryParam,
  parseScopeParam,
} from "./_components/search-url";
import { parseSortParam } from "./_components/search-sort";

const canonical = buildCanonicalUrl("/search");
const siteName = getSiteName();

export const metadata: Metadata = {
  title: "Search",
  description: "Find events, humans, and places.",
  alternates: { canonical },
  openGraph: {
    type: "website",
    url: canonical,
    title: `Search • ${siteName}`,
    description: "Find events, humans, and places.",
    siteName,
  },
  twitter: {
    card: "summary",
    title: `Search • ${siteName}`,
    description: "Find events, humans, and places.",
  },
};

const resolveSearchParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? "";
  }
  return value?.trim() ?? "";
};

type SearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const MIN_SEARCH_QUERY_LENGTH = 2;

export default async function SearchPageRoute({
  searchParams,
}: SearchPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const searchQuery = resolveSearchParam(resolvedSearchParams?.search);

  const seoResults =
    searchQuery.length >= MIN_SEARCH_QUERY_LENGTH
      ? await searchEventsByQuery(searchQuery)
      : [];

  const jsonLdItems = seoResults
    .filter((r) => r.slug)
    .map((r) => ({
      url: buildCanonicalUrl(`/events/${r.slug}`),
      name: r.title,
    }));

  const nearMe = resolveSearchParam(resolvedSearchParams?.near) === "1";
  const radiusRaw = Number(resolveSearchParam(resolvedSearchParams?.radius));
  const radiusKm =
    Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : undefined;

  const placeName = resolveSearchParam(resolvedSearchParams?.place);
  const latRaw = Number(resolveSearchParam(resolvedSearchParams?.lat));
  const lngRaw = Number(resolveSearchParam(resolvedSearchParams?.lng));
  const initialGeoLocation =
    placeName && Number.isFinite(latRaw) && Number.isFinite(lngRaw)
      ? { lat: latRaw, lng: lngRaw, label: placeName }
      : null;

  // Parsed with the SAME helper the client page uses, so the two cannot drift
  // and legacy `?sort=` values in bookmarks (`date`, `featured`) migrate the
  // same way on the server as they do on the client.
  const initialSort = parseSortParam(
    resolveSearchParam(resolvedSearchParams?.sort),
  );

  // Preselected categories / scope arrive on the URL (e.g. "music,comedy"
  // deep links, `?type=place`). Parse with the SAME helpers the client page
  // uses so server and client can't drift.
  const initialCategories = parseCategoryParam(
    resolveSearchParam(resolvedSearchParams?.category),
  );

  const parsedScope = parseScopeParam(
    resolveSearchParam(resolvedSearchParams?.type),
  );
  const initialScope = parsedScope === "all" ? undefined : parsedScope;

  return (
    <>
      <EventListJsonLd items={jsonLdItems} />
      {/* PageContainer defaults to 896, which is narrower than /search needs:
          the client page grows a persistent ~260px facet rail beside the
          results and, wider still, a sticky map pane. 1376 is the shell's own
          usable width (SHELL_MAX_WIDTH 1440 minus its 32px gutters), so this
          hands the page the full content box and lets `UniversalSearchPage`
          clamp itself down per breakpoint — 896 here would have made those
          clamps dead code. */}
      <PageContainer gap={32} padding="32px 0" maxWidth={1376}>
        <UniversalSearchPage
          initialQuery={searchQuery}
          initialNearMe={nearMe}
          initialRadiusKm={radiusKm}
          initialGeoLocation={initialGeoLocation}
          initialSort={initialSort}
          initialCategories={initialCategories}
          initialScope={initialScope}
        />
      </PageContainer>
    </>
  );
}
