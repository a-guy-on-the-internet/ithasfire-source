import "server-only";

import enPackage from "@th/locale/messages/en.json" with { type: "json" };
import esPackage from "@th/locale/messages/es.json" with { type: "json" };

import enApp from "@/i18n/messages/en";
import esApp from "@/i18n/messages/es";
import type { AppLocale } from "@/i18n/config";

/**
 * Server-side `t` for a known language: the shared package catalog with the
 * web app's catalog laid over it, falling back to English per key (as the
 * client provider does). For code that runs outside the React tree, such as
 * `generateMetadata`. The caller picks the language: an /es/ page passes "es"
 * from its URL, help pages pass the viewer's language.
 */

type Catalog = Record<string, unknown>;

const merge = (base: Catalog, over: Catalog): Catalog => {
  const out: Catalog = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const existing = out[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[k] = merge(existing as Catalog, v as Catalog);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const MERGED: Record<AppLocale, Catalog> = {
  en: merge(enPackage as Catalog, enApp as unknown as Catalog),
  es: merge(esPackage as Catalog, esApp as unknown as Catalog),
};

const lookup = (catalog: Catalog, key: string): string | undefined => {
  const parts = key.split(".");
  let cursor: unknown = catalog;
  for (const p of parts) {
    if (
      cursor !== null &&
      typeof cursor === "object" &&
      p in (cursor as Catalog)
    ) {
      cursor = (cursor as Catalog)[p];
    } else {
      return undefined;
    }
  }
  return typeof cursor === "string" ? cursor : undefined;
};

const format = (
  template: string,
  values?: Record<string, string | number>,
): string => {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
};

export type ServerTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** `t` for `locale`; a key missing there reads English, then the key itself. */
export const serverTranslator = (locale: AppLocale): ServerTranslator => {
  const catalog = MERGED[locale] ?? MERGED.en;
  const fallback = MERGED.en;
  return (key, values) => {
    const value = lookup(catalog, key) ?? lookup(fallback, key);
    return value !== undefined ? format(value, values) : key;
  };
};
