import type {
  CategoryListItem,
  CategoryNameLocale,
  CategoryNameTranslations,
  CategoryRecord,
  EventSchemaType,
} from "@th/types";

/**
 * One URL slug of a category in one locale. `locale` is `CategoryNameLocale`
 * from `@th/types`, which mirrors `SUPPORTED_LOCALES` in `@th/locale` (ports
 * cannot import that package; a test in `@th/types` fails on drift).
 */
export type CategorySlugRecord = {
  categoryId: string;
  locale: CategoryNameLocale;
  slug: string;
  isCurrent: boolean;
  createdAt: Date;
};

export interface CategoriesRepo {
  listActive(): Promise<CategoryListItem[]>;
  /**
   * Active categories with at least one INDEXABLE upcoming event, ordered like
   * `listActive`. "Indexable" is the category page's robots rule
   * (`EventsRepo.countIndexableByCategory` with `startsAfter: now`):
   * PUBLISHED, PUBLIC, `startsAt >= now`, owner not withheld, and ungated
   * (`gateType = NONE`; owner ruling 2026-10-13). The sitemap reads this so a
   * category URL is advertised only when its page is indexable.
   */
  listActiveWithUpcomingEvents(input: {
    now: Date;
  }): Promise<CategoryListItem[]>;
  /**
   * Active categories whose page lists at least one upcoming event, ordered
   * like `listActive`. This is the BROWSE rule (the homepage's category chips
   * and "Browse by category" section; owner ruling 2026-10-14: offer only
   * categories that have something): PUBLISHED, PUBLIC, `startsAt >= now`,
   * owner not withheld (`publicListedEventWhere`).
   *
   * It differs from `listActiveWithUpcomingEvents` (the sitemap's indexable
   * rule) on gated events only: a PASSWORD / APPLICATION event still lists on
   * the category page, gate on the card, so a person sent there finds
   * something, while a crawler gets nothing it may index.
   */
  listActiveWithListedEvents(input: {
    now: Date;
  }): Promise<CategoryListItem[]>;
  listAll(): Promise<CategoryRecord[]>;
  getBySlug(slug: string): Promise<CategoryRecord | null>;
  getById(id: string): Promise<CategoryRecord | null>;
  /**
   * Exact lookup of a slug row on the unique (locale, slug), current or old.
   * Returns `null` when no row matches.
   */
  findSlug(
    locale: CategoryNameLocale,
    slug: string,
  ): Promise<CategorySlugRecord | null>;
  /**
   * Every slug row with this slug in ANY locale (at most one per locale, so
   * a handful). The resolver's cross-language fallback reads it. Unordered.
   */
  findSlugsBySlug(slug: string): Promise<CategorySlugRecord[]>;
  /**
   * All slug rows of a category, every locale: current rows first, then the
   * newest first (`createdAt` desc), ties (rows written in one transaction)
   * by locale, then slug.
   */
  listSlugs(categoryId: string): Promise<CategorySlugRecord[]>;
  /**
   * Every slug row of every category, one read (the staff list). Same order
   * as `listSlugs` across the whole table: current rows first, then newest
   * first, ties by locale, then slug; so a caller that groups by category
   * keeps `listSlugs`' order within each.
   */
  listAllSlugs(): Promise<CategorySlugRecord[]>;
  /**
   * The current slug row of every category in a locale (sitemap, links).
   * A category with no current row in that locale is absent. Unordered.
   */
  listCurrentSlugs(locale: CategoryNameLocale): Promise<CategorySlugRecord[]>;
  /**
   * Make `slug` the current slug of `categoryId` in `locale`: the category's
   * other rows in that locale become not current; a row (locale, slug) that
   * already belongs to THIS category is flipped back to current (changing
   * back to an old slug is allowed). The slug is TAKEN, and
   * `{ ok: false, reason: "taken" }` is returned with nothing written, when
   * another category holds that slug string in ANY locale (current or old
   * row) or as its `Category.slug`: a slug string names one category across
   * locales (a category's own en and es slug may be equal). Otherwise a new
   * current row is inserted. For `locale === "en"` it also writes
   * `Category.slug` (the read copy of the current English slug) in the same
   * call.
   *
   * Does NOT validate the slug's format (the use case calls
   * `categorySlugIssue`) and does NOT lock: call it inside `repos.tx()` after
   * `lockNaming()`, which is what keeps one current row per (category,
   * locale). Writes are sequential, so it works on an interactive-tx client.
   * Throws when the category does not exist.
   */
  setCurrentSlug(input: {
    categoryId: string;
    locale: CategoryNameLocale;
    slug: string;
  }): Promise<
    { ok: true; record: CategorySlugRecord } | { ok: false; reason: "taken" }
  >;
  /**
   * Insert a category. Also writes its current English slug row (`slug`), so
   * every category has one. `seoType` (the schema.org Event `@type`) defaults to
   * `"Event"` when omitted; the caller validates it against the shared
   * allowlist (EVENT_SCHEMA_TYPES) first.
   *
   * `slug` and `name` are each unique. A collision is NOT translated here: the
   * unique violation (Prisma `P2002`) propagates, aborting the surrounding
   * transaction, and the use case maps it to `CATEGORY_ALREADY_EXISTS` outside
   * the transaction.
   *
   * `nameTranslations` (non-English names keyed by locale) defaults to `{}`.
   * It is stored as given: the caller validates each name and checks it is
   * unique within its locale under `lockNaming()` first (no DB index does).
   */
  create(input: {
    slug: string;
    name: string;
    active?: boolean;
    sortOrder?: number;
    seoType?: EventSchemaType;
    nameTranslations?: CategoryNameTranslations;
  }): Promise<CategoryRecord>;
  /**
   * Hard-delete a category by id. Returns `true` on success, `false` when
   * no row matched (already deleted). Events referencing the deleted
   * category have their `categoryId` set to null via the schema's
   * `onDelete: SetNull` rule.
   */
  deleteById(id: string): Promise<boolean>;
  /**
   * Set the schema.org Event `@type` for a category (e.g. "MusicEvent").
   * The caller is responsible for validating `seoType` against the shared
   * allowlist (EVENT_SCHEMA_TYPES) before calling. Returns the updated record,
   * or `null` when no row matched the id.
   */
  setSeoType(id: string, seoType: string): Promise<CategoryRecord | null>;
  /**
   * Change a category's display name. The slug is NOT touched: category URLs
   * and sitemap entries key on it. Returns the updated record, or `null` when
   * no row matched the id.
   *
   * `name` is unique. As with `create`, a collision is not translated here:
   * the unique violation (Prisma `P2002`) propagates and the use case maps it
   * to `CATEGORY_ALREADY_EXISTS` outside the transaction.
   */
  rename(id: string, name: string): Promise<CategoryRecord | null>;
  /**
   * Replace a category's non-English names (the whole map; pass `{}` to
   * clear them all). English (`name`) and the slug are not touched. Returns
   * the updated record, or `null` when no row matched the id.
   *
   * Stored as given: the caller validates each name and checks per-locale
   * uniqueness under `lockNaming()` first. There is no DB index on these
   * names, so nothing here can raise a unique violation.
   */
  setNameTranslations(
    id: string,
    nameTranslations: CategoryNameTranslations,
  ): Promise<CategoryRecord | null>;
  /**
   * Ids of the PUBLISHED events in a category, for marking their search
   * documents stale when the category's names change (the documents carry
   * them as a searchable field). Every published event, past or upcoming:
   * the reindex decides what the index keeps. Unordered.
   */
  listPublishedEventIds(categoryId: string): Promise<string[]>;
  /**
   * Switch a category on or off. Returns the updated record, or `null` when no
   * row matched the id. Writes only `active`: events keep their category, and
   * their search documents keep its slug tag. `active` is read by the readers
   * (`listActive`, `listEventsByCategory`, `discoverEventsByCategory`, the
   * geo-category queries, the pickers that validate a chosen category), so
   * the switch takes effect on the next read with no reindex.
   */
  setActive(id: string, active: boolean): Promise<CategoryRecord | null>;
  /**
   * Serialise writers of the category order. Transaction-scoped
   * (`pg_advisory_xact_lock`): released on commit or rollback, no unlock
   * call. MUST be called inside `repos.tx()`, before the caller reads the
   * list it is about to renumber, so two reorders cannot each read the same
   * starting order and write an interleaved mix of both.
   */
  lockSortOrder(): Promise<void>;
  /**
   * Serialise writers of category NAMES (create, rename, approval of a
   * request). Transaction-scoped (`pg_advisory_xact_lock`), a different key
   * from `lockSortOrder`. MUST be called inside `repos.tx()` before the caller
   * reads the categories it compares the new name against: the name rule is
   * case-insensitive and also compares derived slugs, which the unique indexes
   * cannot enforce, so without the lock two writers can both pass the check.
   * Callers that also lock request rows take this lock FIRST.
   */
  lockNaming(): Promise<void>;
  /**
   * Write `sortOrder` for the given categories, one statement per entry, in
   * the caller's transaction. Returns how many rows were updated: fewer than
   * `entries.length` means a category was deleted since the caller read it.
   */
  setSortOrders(
    entries: ReadonlyArray<{ id: string; sortOrder: number }>,
  ): Promise<number>;
  /**
   * Create the seed categories that are missing, each with its current
   * English slug row. A seed slug counts as present when any category holds
   * it as `Category.slug` or as an English slug row, current or old (a
   * category whose URL staff changed keeps its old slug reserved). On create,
   * `seoType` (the schema.org Event `@type`) is applied, defaulting to `"Event"`
   * when omitted, and `sortOrder` is the entry's 1-based position. A category
   * that already exists is left exactly as it is: its name, `active`,
   * `sortOrder` and `seoType` belong to platform staff, and re-seeding must
   * never write over them.
   */
  upsertSeed(
    categories: Array<{ slug: string; name: string; seoType?: EventSchemaType }>,
  ): Promise<void>;
}

export type {
  CategoryListItem,
  CategoryNameLocale,
  CategoryNameTranslations,
  CategoryRecord,
};
