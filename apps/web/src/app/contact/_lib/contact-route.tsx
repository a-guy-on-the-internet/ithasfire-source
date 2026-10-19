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
import { ContactContent } from "../_components/ContactContent";

/** The contact page in one language: `/contact` and `/es/contacto` (R21). */

const CONTACT_PATHS: TwinPaths = {
  en: publicPath("en", { kind: "contact" }),
  es: publicPath("es", { kind: "contact" }),
};

export function contactMetadata(locale: AppLocale): Metadata {
  const t = serverTranslator(locale);
  return staticTwinMetadata({
    locale,
    paths: CONTACT_PATHS,
    title: t("publicSeo.contactTitle"),
    description: t("publicSeo.contactDescription"),
    imageAlt: t("publicSeo.ogImageAlt"),
  });
}

export function ContactRouteBody() {
  return (
    <>
      <PublicTwins twins={twinSet(CONTACT_PATHS, everyLocale(true))} />
      <ContactContent />
    </>
  );
}
