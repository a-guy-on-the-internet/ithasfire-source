import type { CategoryNameTranslations } from "../category-names";

export interface CategoryRecord {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  /**
   * schema.org Event `@type` emitted in JSON-LD for events in this category
   * (e.g. "MusicEvent"). Validated against the shared allowlist
   * (EVENT_SCHEMA_TYPES) at the write boundary; unknown values fall back to
   * "Event" when the SEO builder consumes them. Defaults to "Event".
   */
  seoType: string;
  /**
   * Non-English names keyed by locale (`{ es: "Música" }`). English is
   * `name`; an absent key means no translation (readers show `name`).
   */
  nameTranslations: CategoryNameTranslations;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryListItem {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  /** schema.org Event `@type` for this category's events. See CategoryRecord. */
  seoType: string;
  /** Non-English names keyed by locale. See CategoryRecord. */
  nameTranslations: CategoryNameTranslations;
}
