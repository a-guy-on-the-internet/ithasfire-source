import type { Metadata } from "next";

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
import { AboutContent } from "../_components/AboutContent";

/** The about page in one language: `/about` and `/es/acerca-de` (R21). */

const ABOUT_PATHS: TwinPaths = {
  en: publicPath("en", { kind: "about" }),
  es: publicPath("es", { kind: "about" }),
};

export function aboutMetadata(locale: AppLocale): Metadata {
  const t = serverTranslator(locale);
  return staticTwinMetadata({
    locale,
    paths: ABOUT_PATHS,
    title: t("publicSeo.aboutTitle"),
    description: t("publicSeo.aboutDescription"),
    imageAlt: t("publicSeo.ogImageAlt"),
  });
}

export function AboutRouteBody() {
  return (
    <>
      <PublicTwins twins={twinSet(ABOUT_PATHS, everyLocale(true))} />
      <AboutContent />
    </>
  );
}
