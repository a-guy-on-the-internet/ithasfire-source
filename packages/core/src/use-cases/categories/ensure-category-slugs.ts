import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { CategorySlugRecord } from "@th/ports/repos/categories";
import {
  CATEGORY_SLUG_MAX_LENGTH,
  categorySlugIssue,
  deriveCategorySlug,
  normalizeCategoryName,
  type CategoryNameLocale,
  type CategoryNameTranslations,
} from "@th/types";

/** The fields of a category the slug rules read. */
export type CategorySlugSource = {
  id: string;
  /** `Category.slug`, the read copy of the current English slug. */
  slug: string;
  nameTranslations?: CategoryNameTranslations | null;
};

export type EnsureCategorySlugsResult = {
  /** Rows this call made current (inserted, or an old en row flipped back). */
  written: CategorySlugRecord[];
  /**
   * The category has no current en row and its `Category.slug` is held by
   * ANOTHER category's slug row (any locale), so it could not be recorded. Only a
   * category written by an API older than CategorySlug, after another
   * category moved off that slug, can get here; staff fix it by changing one
   * of the two URLs. Nothing was written for en.
   */
  enConflict: boolean;
};

/**
 * Report an en conflict from {@link ensureCategorySlugs} (CLAUDE.md, "Error
 * Reporting Convention": the caller carries on without the en row, so the
 * conflict must reach Sentry, not just a log). Guarded: a throwing reporter
 * never changes the caller's behaviour.
 */
export function reportEnSlugConflict(
  reportError: ReporterPort | undefined,
  useCase: string,
  category: { id: string; slug: string },
): void {
  if (!reportError) return;
  try {
    reportError(new Error("category_en_slug_conflict"), {
      tags: { useCase },
      extra: { categoryId: category.id, slug: category.slug },
    });
  } catch {
    // Best effort by contract (ports/reporter.ts).
  }
}

/** Suffixes tried after the bare derived slug: -2 … -1000. */
const MAX_SUFFIX = 1000;

/**
 * Make a category's slug rows complete (spanish-seo FR-007, FR-008). The
 * CALLER holds `categories.lockNaming()` inside `repos.tx()`, which is what
 * keeps one current row per (category, locale). Idempotent: a second call
 * writes nothing.
 *
 *  a. English. No current en row (a category written by an API older than
 *     CategorySlug, after the migration's backfill): `Category.slug` becomes
 *     its current en row, flipping an old row of its own back or inserting
 *     one. `setCurrentSlug` keeps `Category.slug` as it is (same value).
 *  b. Spanish. The category has an es name and NO es row at all: the slug
 *     derived from the es name (`deriveCategorySlug`, cut to the slug length
 *     at a hyphen) becomes its current es slug; when another category holds
 *     it in ANY locale (a slug string names one category), `-2`, `-3` …
 *     until one is free. A name that derives no valid slug
 *     (no latin letters or digits) uses the English slug as the base.
 *     When es rows exist, nothing happens: a slug never moves on rename
 *     (R14), and a cleared es name keeps its slug reserved and current (R20).
 *
 * Takes the category, not its id: every caller has just read or written it
 * under the same lock.
 */
export async function ensureCategorySlugs(
  tx: Pick<TxRepos, "categories">,
  category: CategorySlugSource,
): Promise<EnsureCategorySlugsResult> {
  const rows = await tx.categories.listSlugs(category.id);
  const written: CategorySlugRecord[] = [];
  let enConflict = false;

  const hasCurrentEn = rows.some((row) => row.locale === "en" && row.isCurrent);
  if (!hasCurrentEn) {
    const result = await tx.categories.setCurrentSlug({
      categoryId: category.id,
      locale: "en",
      slug: category.slug,
    });
    if (result.ok) {
      written.push(result.record);
    } else {
      enConflict = true;
    }
  }

  const esName = category.nameTranslations?.es?.trim();
  const hasEsRow = rows.some((row) => row.locale === "es");
  if (esName && !hasEsRow) {
    written.push(
      await insertFirstFreeSlug(tx, category.id, esSlugBase(esName, category)),
    );
  }

  return { written, enConflict };
}

/** The bare es slug: from the es name, else from the English slug. */
function esSlugBase(esName: string, category: CategorySlugSource): string {
  const derived = cutSlug(
    deriveCategorySlug(normalizeCategoryName(esName)),
    CATEGORY_SLUG_MAX_LENGTH,
  );
  return categorySlugIssue(derived) === null ? derived : category.slug;
}

/**
 * At most `max` characters, never ending in a hyphen. Cuts at the last
 * hyphen inside the limit when there is one, so a word is not split.
 */
function cutSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const lastHyphen = head.lastIndexOf("-");
  const cut = lastHyphen > 0 ? head.slice(0, lastHyphen) : head;
  return cut.replace(/-+$/, "");
}

function candidate(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${cutSlug(base, CATEGORY_SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
}

async function insertFirstFreeSlug(
  tx: Pick<TxRepos, "categories">,
  categoryId: string,
  base: string,
): Promise<CategorySlugRecord> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const result = await tx.categories.setCurrentSlug({
      categoryId,
      locale: "es",
      slug: candidate(base, n),
    });
    if (result.ok) return result.record;
  }
  // Unreachable in practice: it would take 1000 categories holding the
  // same Spanish base. Thrown, not swallowed: the transaction rolls back.
  throw new Error(`ensureCategorySlugs: no free es slug for ${base}`);
}

export type EnsureAllCategorySlugsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type EnsureAllCategorySlugsOptions = {
  /**
   * Compute what would be written without keeping it. The whole run is one
   * transaction that is rolled back at the end, so a later category sees the
   * rows an earlier one "wrote" (the `-2` suffixes come out as a real run's
   * would) and nothing persists. Nothing goes to `reportError` (a dry run is
   * not an incident); conflicts are still logged and listed.
   */
  dryRun?: boolean;
};

export type EnsureAllCategorySlugsOutput = {
  /** Categories read. */
  categories: number;
  /** Categories that got a current en row. */
  enWritten: number;
  /** Categories that got their first es slug. */
  esWritten: number;
  /** Ids whose `Category.slug` another category holds (see `enConflict`). */
  enConflicts: string[];
  /** Every row written (or, in a dry run, that would be). */
  written: { categoryId: string; locale: CategoryNameLocale; slug: string }[];
};

/** Thrown inside the dry run's transaction to roll it back. */
class DryRunRollback extends Error {}

/**
 * System entry for the backfill script (no actor): runs
 * {@link ensureCategorySlugs} on every category, one transaction each under
 * `lockNaming()`, re-reading the category inside it. A category that changed
 * gets one `category.slugs_ensured` audit row listing the rows it wrote.
 * Safe to run again: a complete category writes nothing.
 *
 * A category whose English slug cannot be recorded is listed in
 * `enConflicts` (logged at error and sent to `reportError`) for a person to
 * resolve; the run goes
 * on, because the other categories are independent.
 */
export async function ensureAllCategorySlugs(
  deps: EnsureAllCategorySlugsDeps,
  options: EnsureAllCategorySlugsOptions = {},
): Promise<EnsureAllCategorySlugsOutput> {
  const all = await deps.repos.categories.listAll();
  const output: EnsureAllCategorySlugsOutput = {
    categories: all.length,
    enWritten: 0,
    esWritten: 0,
    enConflicts: [],
    written: [],
  };

  const ensureOne = async (tx: TxRepos, id: string) => {
    await tx.categories.lockNaming();
    const category = await tx.categories.getById(id);
    // Deleted since the list was read: its slugs went with it.
    if (!category) return null;

    const ensured = await ensureCategorySlugs(tx, category);
    if (ensured.written.length > 0) {
      await tx.audit.log({
        entity: "category",
        entityId: category.id,
        action: "category.slugs_ensured",
        data: {
          actorHumanId: null,
          slugs: ensured.written.map((row) => ({
            locale: row.locale,
            slug: row.slug,
          })),
        },
        at: deps.clock.now(),
      });
    }
    return { ...ensured, slug: category.slug };
  };

  const results: {
    id: string;
    result: NonNullable<Awaited<ReturnType<typeof ensureOne>>>;
  }[] = [];
  if (options.dryRun) {
    try {
      await deps.repos.tx(
        async (tx) => {
          for (const { id } of all) {
            const result = await ensureOne(tx, id);
            if (result) results.push({ id, result });
          }
          throw new DryRunRollback();
        },
        // One transaction holds lockNaming() for every category, which can
        // outlast the default 30s; 2 minutes covers a large list. It can't be
        // split: later categories must see earlier rows (see `dryRun`).
        { timeout: 120_000 },
      );
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
  } else {
    for (const { id } of all) {
      const result = await deps.repos.tx((tx) => ensureOne(tx, id));
      if (result) results.push({ id, result });
    }
  }

  for (const { id, result } of results) {
    for (const row of result.written) {
      output.written.push({
        categoryId: id,
        locale: row.locale,
        slug: row.slug,
      });
    }
    if (result.written.some((row) => row.locale === "en")) {
      output.enWritten += 1;
    }
    if (result.written.some((row) => row.locale === "es")) {
      output.esWritten += 1;
    }
    if (result.enConflict) {
      output.enConflicts.push(id);
      deps.logger?.error("categories.ensure_slugs.en_conflict", {
        categoryId: id,
      });
      if (!options.dryRun) {
        reportEnSlugConflict(deps.reportError, "ensureAllCategorySlugs", {
          id,
          slug: result.slug,
        });
      }
    }
  }

  deps.logger?.info("categories.ensure_slugs.done", {
    categories: output.categories,
    enWritten: output.enWritten,
    esWritten: output.esWritten,
    enConflicts: output.enConflicts.length,
    dryRun: options.dryRun === true,
  });
  return output;
}
