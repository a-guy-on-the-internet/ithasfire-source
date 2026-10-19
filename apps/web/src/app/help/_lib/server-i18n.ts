import "server-only";

import { cookies, headers } from "next/headers";

import { resolveLocale } from "@/i18n/resolve-locale";
import { LOCALE_COOKIE, type AppLocale } from "@/i18n/config";
import {
  serverTranslator,
  type ServerTranslator,
} from "@/i18n/server-translator";

export type { ServerTranslator };

export const getHelpLocale = async (): Promise<AppLocale> => {
  const [hdrs, cookieStore] = await Promise.all([headers(), cookies()]);
  return resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: hdrs.get("accept-language"),
  });
};

export const getHelpTranslator = async (): Promise<{
  locale: AppLocale;
  t: ServerTranslator;
}> => {
  const locale = await getHelpLocale();
  return { locale, t: serverTranslator(locale) };
};
