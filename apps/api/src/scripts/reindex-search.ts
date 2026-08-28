/**
 * reindex-search.ts — Rebuild the entire search index from Postgres on demand.
 *
 * This is a thin, standalone wrapper around the SAME `buildSearchIndex({
 * fullReindex: true })` use case that the nightly `search.full-reindex` job and
 * the seed script run. Use it to backfill existing search documents with newly
 * added fields (e.g. `isPublic`, `endsAt`, `city`, `addressText`) WITHOUT
 * re-seeding all demo data.
 *
 * It re-indexes ALL published events — including non-public (PRIVATE) ones,
 * which are stamped `isPublic = false` but stay in the index (admin search
 * needs them). Humans, places, and organizations are rebuilt too.
 *
 * Env resolution mirrors `seed-data.ts`: it prefers a local Postgres and falls
 * back to the repo-root `.env.local` when DATABASE_URL is unset/placeholder.
 * Set `THC_SEED_ALLOW_REMOTE_DB=true` to point it at a non-local host.
 *
 * Usage:
 *   pnpm -F api reindex:search
 *   SEARCH_BACKEND=meili pnpm -F api reindex:search
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load repo-root `.env.local` for DATABASE_URL when the current value looks like
// the placeholder example (USER:PASSWORD@HOST) or is unset.
const placeholderMatch = (process.env.DATABASE_URL || "").match(
  /USER:PASSWORD|@HOST|postgres:\/\/USER/,
);
if (!process.env.DATABASE_URL || placeholderMatch) {
  dotenvConfig({
    path: path.resolve(__dirname, "../../../../.env.local"),
    override: true,
  });
}
// Fill in any still-unset keys from apps/api/.env.local (e.g. MEILISEARCH_*).
dotenvConfig({
  path: path.resolve(__dirname, "../../.env.local"),
  override: false,
});

const localDbUrl =
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
const allowRemoteDb = process.env.THC_SEED_ALLOW_REMOTE_DB === "true";
const resolveDbUrl = (): string => {
  if (!process.env.DATABASE_URL || placeholderMatch) return localDbUrl;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const isLocalHost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocalHost && !allowRemoteDb) return localDbUrl;
  } catch {
    return localDbUrl;
  }
  return process.env.DATABASE_URL;
};
process.env.DATABASE_URL = resolveDbUrl();

const meiliPort = process.env.MEILISEARCH_PORT?.trim() || "7700";
if (!process.env.MEILISEARCH_HOST) {
  process.env.MEILISEARCH_HOST = `http://localhost:${meiliPort}`;
}

const readSearchWeight = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const searchWeightsFromEnv = () => ({
  fulltext: readSearchWeight("SEARCH_W_FULLTEXT", 1.0),
  prefix: readSearchWeight("SEARCH_W_PREFIX", 0.7),
  fuzzy: readSearchWeight("SEARCH_W_FUZZY", 0.5),
  popularity: readSearchWeight("SEARCH_W_POPULARITY", 0.05),
  geo: readSearchWeight("SEARCH_W_GEO", 1.0),
});

// ── Imports (after env is settled) ─────────────────────────────────────────
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import {
  MultiIndexMeilisearchAdapter,
  MultiIndexPostgresAdapter,
} from "@th/adapters/search";
import { buildSearchIndex } from "@th/core/use-cases/search/build-search-index";
import { createSystemClock } from "@th/adapters/infra/clock";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

async function main(): Promise<void> {
  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const backend = (process.env.SEARCH_BACKEND || "postgres").toLowerCase();

  let search: MultiSearchPort;
  if (backend === "meili") {
    const host = process.env.MEILISEARCH_HOST;
    const apiKey =
      process.env.MEILISEARCH_API_KEY || process.env.MEILISEARCH_MASTER_KEY;
    if (!host || !apiKey) {
      throw new Error(
        "SEARCH_BACKEND=meili requires MEILISEARCH_HOST and MEILISEARCH_API_KEY",
      );
    }
    console.log(`[reindex] Rebuilding Meilisearch index at ${host}...`);
    search = new MultiIndexMeilisearchAdapter({ host, apiKey });
  } else {
    console.log("[reindex] Rebuilding Postgres search index...");
    search = new MultiIndexPostgresAdapter({
      prisma,
      weights: searchWeightsFromEnv(),
    });
  }

  const result = await buildSearchIndex(
    { repos, search, clock: createSystemClock() },
    { fullReindex: true },
  );

  console.log(
    `[reindex] Done: ${result.eventsIndexed} events, ${result.humansIndexed} humans, ${result.placesIndexed} places, ${result.organizationsIndexed} organizations`,
  );
  if (result.errors.length > 0) {
    console.warn(`[reindex] ${result.errors.length} errors:`, result.errors);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[reindex] Failed:", err);
    process.exit(1);
  })
  .finally(() => {
    // getPrisma() returns a shared singleton; let the process exit naturally.
  });
