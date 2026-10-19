import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

/**
 * Refuse a new category whose English slug another category already holds
 * as a slug row in ANY locale, current or old. A slug string names one
 * category across locales (orchestrator ruling 2026-10-17), and an old URL
 * keeps redirecting to its category and is never taken over (spanish-seo
 * R14). `CATEGORY_ALREADY_EXISTS`, the code the create paths already answer
 * for a taken slug (`meta.field: "slug"`). The caller holds
 * `categories.lockNaming()`.
 */
export async function assertSlugUnheld(
  tx: Pick<TxRepos, "categories">,
  slug: string,
): Promise<void> {
  if ((await tx.categories.findSlugsBySlug(slug)).length > 0) {
    throw fail("CATEGORY_ALREADY_EXISTS", { meta: { field: "slug" } });
  }
}
