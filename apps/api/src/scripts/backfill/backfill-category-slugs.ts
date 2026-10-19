/**
 * backfill-category-slugs.ts — DRY-RUN-BY-DEFAULT completion of every
 * category's URL slug rows (spanish-seo FR-007, FR-008).
 *
 * Runs `ensureAllCategorySlugs`, the same code the category use cases run for
 * one category, over all of them:
 *
 *   - a category with no current English row gets one from `Category.slug`
 *     (a category written by an API older than CategorySlug);
 *   - a category with a Spanish name and no Spanish row gets its first es
 *     slug, derived from the name (`-2`, `-3` when taken).
 *
 * Idempotent: a second run writes nothing. Each category is one transaction
 * and gets one `category.slugs_ensured` audit row.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *   - Nothing is kept unless `--apply` is passed. A dry run executes the real
 *     code inside ONE transaction that is rolled back, so the report is what
 *     `--apply` would write, `-2` suffixes included.
 *   - A dry run holds the category naming lock for its whole run, so it
 *     briefly blocks category edits on /platform.
 *   - `--apply` against a non-local database requires
 *     `--confirm-remote-host=<host>` matching the resolved hostname.
 *   - Reporting: no script here reports to Sentry. The reporter passed to the
 *     use case logs to stderr and the script lists every English conflict at
 *     the end; the exit code is 1 when there is one. A dry run reports
 *     nothing through the reporter (it is not an incident).
 *
 * An English conflict means a category's `Category.slug` is held by ANOTHER
 * category's slug row; staff resolve it by changing one of the two URLs on
 * /platform.
 *
 * USAGE — from apps/api:
 *
 *   DATABASE_URL=… pnpm backfill:category-slugs                  # dry run
 *   DATABASE_URL=… pnpm backfill:category-slugs --apply
 *   DATABASE_URL=<remote> pnpm backfill:category-slugs \
 *     --apply --confirm-remote-host=<host>
 */

import "dotenv/config";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { ensureAllCategorySlugs } from "@th/core/use-cases/categories";

import {
  assertWriteAllowed,
  parseBackfillArgs,
  resolveDbHost,
} from "./backfill-category-slugs-args";

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const host = resolveDbHost(process.env.DATABASE_URL);
  assertWriteAllowed(args, host);

  const repos = createPrismaRepos(getPrisma());
  const result = await ensureAllCategorySlugs(
    {
      repos,
      clock: createSystemClock(),
      logger: createPinoLoggerAdapter({ options: { level: "warn" } }),
      reportError: (err, context) =>
        console.error("[backfill-category-slugs] reported", err, context ?? {}),
    },
    { dryRun: !args.apply },
  );

  console.log(
    `backfill-category-slugs ${args.apply ? "APPLY" : "DRY RUN (nothing written)"} on ${host}`,
  );
  console.log(`  categories:        ${result.categories}`);
  console.log(`  en rows ${args.apply ? "written" : "to write"}:   ${result.enWritten}`);
  console.log(`  es rows ${args.apply ? "written" : "to write"}:   ${result.esWritten}`);
  for (const row of result.written) {
    console.log(`    ${row.categoryId}  ${row.locale}  ${row.slug}`);
  }
  console.log(`  en conflicts:      ${result.enConflicts.length}`);
  for (const id of result.enConflicts) {
    console.log(`    CONFLICT ${id} (its Category.slug is held by another category)`);
  }
  if (result.enConflicts.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
