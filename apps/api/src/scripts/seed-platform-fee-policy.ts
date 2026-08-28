/**
 * seed-platform-fee-policy.ts — Reconcile the GLOBAL fee policy row with the
 * code constant.
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api tsx \
 *     src/scripts/seed-platform-fee-policy.ts
 *
 * Or via the root convenience script:
 *   pnpm seed:fee-policy          (local dev DB, dotenv-aware)
 *   pnpm seed:fee-policy:remote   (uses whatever DATABASE_URL is exported)
 *
 * What it does:
 *   - Resolves the currently-effective GLOBAL `FeePolicy` and compares EVERY
 *     field of `PLATFORM_FEE_POLICY`
 *     (packages/core/src/lib/pricing/platform-fee-policy.ts) against it.
 *   - Identical → logs a no-op and exits 0. This is the steady state: the
 *     script runs on EVERY deploy and must not mint a policy version each
 *     time, or `PayoutTerms.feePolicyId` pins churn and a real fee change is
 *     buried in noise.
 *   - Different, or no row at all → writes a new version, archiving the old
 *     ACTIVE row. Logs old vs new field by field.
 *   - On an actual write, reindexes every published event: buyer totals are
 *     FEE-INCLUSIVE in search documents, so a fee change makes the indexed
 *     price of every published event stale. See `runReindex` below.
 *
 * The comparison and the write live in
 * `@th/core/use-cases/platform/reconcile-platform-fee-policy` — this file is
 * the shell (env, Prisma lifecycle, logging, reindex), matching how
 * seed-platform-categories.ts delegates to `ensureCategories`.
 *
 * WHY THIS EXISTS: the platform fee is defined in CODE, not in an admin form.
 * The DB row is a materialization. There is no tRPC mutation to change it;
 * `/platform/fees` is a read-only view.
 *
 * Run automatically by the `migrate_db` job of the deploy-dev / deploy-prod
 * workflows. NOT `continue-on-error`: with no effective GLOBAL policy,
 * `publishEvent` throws `FEE_POLICY_NOT_FOUND` and checkout cannot price a
 * ticket, so it fails loudly.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { MultiIndexPostgresAdapter } from "@th/adapters/search";
import { createSystemClock } from "@th/adapters/infra/clock";
import { reindexAllPublishedEvents } from "@th/core/use-cases/search/reindex-after-mutation";
import { reconcilePlatformFeePolicy } from "@th/core/use-cases/platform/reconcile-platform-fee-policy";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

/**
 * `FeePolicy.createdBy` is a plain String column with no FK to `Human`, so a
 * sentinel is safe. There is no human actor on a deploy-time reconcile, and
 * borrowing one (e.g. the seeded platform admin) would misattribute an
 * automated write to a person in the audit trail. This value names the writer,
 * so `SELECT "createdBy" FROM "FeePolicy"` reads honestly.
 */
const SYSTEM_ACTOR_ID = "system:seed-platform-fee-policy";

/**
 * Provenance metadata, NOT compared by the reconciler — rewording this string
 * must never be able to mint a policy version.
 */
const POLICY_NOTES =
  "Materialized from PLATFORM_FEE_POLICY by seed-platform-fee-policy.ts";

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[fee-policy-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[fee-policy-seed] DATABASE_URL set (could not parse host)");
}

const prisma = getPrisma();

/**
 * The search backend for both dev and prod is Postgres (`SEARCH_BACKEND` in
 * infra/terraform/envs/{dev,prod}/*.tfvars), which means the index lives in the
 * SAME database this script already holds a connection to — so wiring a real
 * `MultiSearchPort` costs one constructor, not a new deployment dependency.
 * Mirrors reindex-search.ts.
 *
 * Ranking weights are left at their defaults on purpose: they are only read
 * when SERVING a query (see `MultiIndexPostgresAdapter`), never when writing a
 * document, so they cannot affect what this script indexes.
 */
function resolveSearchPort(): MultiSearchPort {
  const backend = (process.env.SEARCH_BACKEND || "postgres").toLowerCase();
  if (backend === "meili") {
    throw new Error(
      "SEARCH_BACKEND=meili is not supported by seed-platform-fee-policy.ts. " +
        "Both environments run SEARCH_BACKEND=postgres; if that changed, wire " +
        "the Meilisearch adapter here the way reindex-search.ts does.",
    );
  }
  return new MultiIndexPostgresAdapter({ prisma });
}

/**
 * Reindex every published event after a real fee change.
 *
 * A failure here sets a NON-ZERO exit code on purpose — and that includes a
 * PARTIAL failure. `buildSearchIndex` RESOLVES with per-id errors rather than
 * rejecting, so "497 of 500 indexed" would otherwise print a cheerful count and
 * exit green while three events keep serving the OLD fee-inclusive price.
 *
 * Note the consequence of any failure: re-running the deploy will NOT retry the
 * reindex — the policy row now matches the constant, so the next run is a
 * no-op. Remediate by hand:
 *
 *   DATABASE_URL=<url> pnpm -F api reindex:search
 *
 * The nightly `search.full-reindex` job also reconciles the drift within a day.
 */
const REINDEX_REMEDIATION =
  "Re-running the deploy will NOT retry it (the policy row already matches " +
  "the constant). Run by hand: `DATABASE_URL=<url> pnpm -F api reindex:search`.";

async function runReindex(
  repos: ReturnType<typeof createPrismaRepos>,
): Promise<void> {
  console.log(
    "[fee-policy-seed] Fee change written — reindexing every published event " +
      "(buyer totals are fee-inclusive in search documents)...",
  );
  try {
    const result = await reindexAllPublishedEvents({
      repos,
      search: resolveSearchPort(),
      clock: createSystemClock(),
    });

    if (result.errors.length > 0) {
      console.error(
        `[fee-policy-seed] REINDEX PARTIALLY FAILED: ${result.indexed} of ` +
          `${result.enumerated} published event(s) indexed, ` +
          `${result.errors.length} failed. Those events still serve the OLD ` +
          `fee-inclusive price. ${REINDEX_REMEDIATION}`,
      );
      for (const { id, error } of result.errors.slice(0, 20)) {
        console.error(`[fee-policy-seed]   event ${id}: ${error}`);
      }
      if (result.errors.length > 20) {
        console.error(
          `[fee-policy-seed]   … and ${result.errors.length - 20} more.`,
        );
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      `[fee-policy-seed] Reindexed ${result.indexed} published event(s).`,
    );
  } catch (err) {
    console.error(
      "[fee-policy-seed] REINDEX FAILED after a successful fee-policy write. " +
        "Every published event now carries a STALE fee-inclusive price in " +
        `search until this is fixed. ${REINDEX_REMEDIATION}`,
      err,
    );
    process.exitCode = 1;
  }
}

const describe = (value: unknown) =>
  value === undefined ? "(none)" : JSON.stringify(value);

async function main() {
  const repos = createPrismaRepos(prisma);

  const result = await reconcilePlatformFeePolicy(
    { repos, clock: createSystemClock() },
    { actorHumanId: SYSTEM_ACTOR_ID, notes: POLICY_NOTES },
  );

  if (result.action === "noop") {
    console.log(
      `[fee-policy-seed] No change — GLOBAL policy v${result.policy.version} ` +
        `(${result.policy.id}) already matches PLATFORM_FEE_POLICY.`,
    );
    return;
  }

  if (result.previous) {
    console.log(
      `[fee-policy-seed] GLOBAL policy v${result.previous.version} ` +
        `(${result.previous.id}) differed from PLATFORM_FEE_POLICY in ` +
        `${result.diffs.length} field(s):`,
    );
  } else {
    console.log(
      "[fee-policy-seed] No effective GLOBAL fee policy found — installing v1. " +
        "(Without one, publishEvent throws FEE_POLICY_NOT_FOUND.)",
    );
  }
  for (const { field, current, next } of result.diffs) {
    console.log(
      `[fee-policy-seed]   ${field}: ${describe(current)} -> ${describe(next)}`,
    );
  }

  console.log(
    `[fee-policy-seed] Wrote GLOBAL policy v${result.policy.version} ` +
      `(${result.policy.id})` +
      (result.previous
        ? `; archived v${result.previous.version} (${result.previous.id}).`
        : "."),
  );

  await runReindex(repos);
}

main()
  .catch((err) => {
    console.error("[fee-policy-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
