import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./constants";
import {
  messageDictionarySchema,
  type MessageCatalog,
} from "./messages-schema";

import enCatalog from "../messages/en.json" with { type: "json" };
import esCatalog from "../messages/es.json" with { type: "json" };

const AVAILABLE_CATALOGS: Record<SupportedLocale, unknown> = {
  en: enCatalog,
  es: esCatalog,
};

const cache = new Map<SupportedLocale, MessageCatalog>();

const normalizeLocale = (input: string): SupportedLocale => {
  if (SUPPORTED_LOCALES.includes(input as SupportedLocale)) {
    return input as SupportedLocale;
  }

  const [languageCode] = input.split("-");
  if (SUPPORTED_LOCALES.includes(languageCode as SupportedLocale)) {
    return languageCode as SupportedLocale;
  }

  return DEFAULT_LOCALE;
};

export const loadMessages = async (locale: string): Promise<MessageCatalog> => {
  const normalized = normalizeLocale(locale);
  if (cache.has(normalized)) {
    return cache.get(normalized)!;
  }

  const rawCatalog = AVAILABLE_CATALOGS[normalized];
  const parsed = messageDictionarySchema.parse(rawCatalog);
  cache.set(normalized, parsed);
  return parsed;
};

export const preloadAllMessages = async (): Promise<
  Map<SupportedLocale, MessageCatalog>
> => {
  for (const locale of SUPPORTED_LOCALES) {
    await loadMessages(locale);
  }
  return new Map(cache);
};
