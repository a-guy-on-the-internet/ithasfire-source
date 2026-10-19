import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { HomeGatedLayout } from "../_components/HomeGatedLayout";
import { WebSiteJsonLd } from "@/components/seo/WebSiteJsonLd";
import { PublicTwins } from "@/i18n";
import type { AppLocale } from "@/i18n/config";
import { publicPath } from "@/i18n/public-paths";
import { serverTranslator } from "@/i18n/server-translator";
import {
  everyLocale,
  staticTwinMetadata,
  twinSet,
  type TwinPaths,
} from "@/lib/seo/public-twins";
import { makeQueryClient } from "@/lib/query-client";
import {
  prefetchHomeDiscovery,
  hydrateHomeDiscovery,
  HOME_SSR_COUNTRY,
} from "@/server/home-discovery";

/**
 * The home page in one language: `/` (en) and `/es` (es). Both route files
 * call these with their locale (spanish-seo R21, FR-001).
 */

const HOME_PATHS: TwinPaths = {
  en: publicPath("en", { kind: "home" }),
  es: publicPath("es", { kind: "home" }),
};

export function homeMetadata(locale: AppLocale): Metadata {
  const t = serverTranslator(locale);
  return staticTwinMetadata({
    locale,
    paths: HOME_PATHS,
    // The layout's default title: the site name, in every language.
    title: null,
    description: t("publicSeo.homeDescription"),
    socialDescription: t("publicSeo.homeSocialDescription"),
    imageAlt: t("publicSeo.ogImageAlt"),
  });
}

export async function HomeRouteBody({ locale }: { locale: AppLocale }) {
  // Deliberately NOT the viewer's country — see `HOME_SSR_COUNTRY`. The edge
  // cache key has no country in it, so varying this per viewer served whichever
  // country warmed a colo to everyone else behind it.
  const data = await prefetchHomeDiscovery({ countryCode: HOME_SSR_COUNTRY });

  const qc = makeQueryClient();
  hydrateHomeDiscovery(qc, data);
  const dehydratedState = dehydrate(qc);

  return (
    <>
      <PublicTwins twins={twinSet(HOME_PATHS, everyLocale(true))} />
      <WebSiteJsonLd inLanguage={locale} />
      <HydrationBoundary state={dehydratedState}>
        <HomeGatedLayout />
      </HydrationBoundary>
    </>
  );
}
