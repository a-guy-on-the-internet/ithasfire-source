/**
 * reproject-withheld-locations.ts — re-project the STORED location of every
 * event at every withheld venue, then re-index what changed.
 *
 * WHY. An event at a venue that withholds its address stores the venue's
 * public projection, including the venue's keyed circle centre. Anything that
 * moves that centre leaves the stored rows stale:
 *   · rotating UNSUBSCRIBE_SECRET (the obfuscation key's HKDF root) — see
 *     docs/runbooks/rotate-unsubscribe-secret.md;
 *   · a change to the circle geometry (the radius ladder + nested sampling).
 * This runs the SAME cascade `upsertPlace` runs on a privacy change
 * (`reprojectWithheldPlaceLocations` → `reprojectLocationForPlace`, under the
 * exclusive place-location lock) for every venue whose rows differ.
 *
 * SAFE BY DEFAULT.
 *   · DRY RUN unless `--apply` is passed (`--dry-run` is accepted and is the
 *     default) — reports every withheld venue, its public centre now, and the
 *     stale centres its rows hold.
 *   · IDEMPOTENT — a venue whose rows already match is never written; a
 *     second `--apply` reports every venue `up_to_date`.
 *   · REFUSES TO RUN WITHOUT THE KEY, and runs the boot canary first: a
 *     keyless run would project "no circle" and null every stored centre.
 *
 * Env resolution mirrors `reindex-search.ts`: repo-root `.env.local` for
 * DATABASE_URL when unset/placeholder, `apps/api/.env.local` for
 * UNSUBSCRIBE_SECRET and search settings; a non-local database needs
 * `THC_SEED_ALLOW_REMOTE_DB=true`.
 *
 * PUBLIC-READ CACHES. The API caches anonymous home-page reads in memory and
 * only drops them when the shared Redis generation moves. This script writes
 * Prisma directly (no tRPC mutation), so on `--apply` it bumps that
 * generation itself, AFTER the rows and the reindex are done. Run it with the
 * TARGET environment's REDIS_URL and REDIS_NAMESPACE (a local Redis bump does
 * not reach prod). Without REDIS_URL it prints a warning instead: re-run with
 * them set (`--apply` is idempotent), or accept up to
 * PUBLIC_DISCOVERY_CACHE_TTL_S of stale home-page locations.
 *
 * Usage:
 *   pnpm -F api exec tsx src/scripts/ops/reproject-withheld-locations.ts            # dry run
 *   pnpm -F api exec tsx src/scripts/ops/reproject-withheld-locations.ts --apply
 *   … --apply --place <placeId> [--place <placeId>]   # only these venues
 *   … --apply --no-reindex                            # rows only (full reindex after)
 *   SEARCH_BACKEND=meili …                            # reindex into Meilisearch
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const placeholderMatch = (process.env.DATABASE_URL || "").match(
  /USER:PASSWORD|@HOST|postgres:\/\/USER/,
);
if (!process.env.DATABASE_URL || placeholderMatch) {
  dotenvConfig({
    path: path.resolve(__dirname, "../../../../../.env.local"),
    override: true,
  });
}
dotenvConfig({
  path: path.resolve(__dirname, "../../../.env.local"),
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

// ── Imports (after env is settled) ─────────────────────────────────────────
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import {
  MultiIndexMeilisearchAdapter,
  MultiIndexPostgresAdapter,
} from "@th/adapters/search";
import { createSystemClock } from "@th/adapters/infra/clock";
import { adaptersLocationObfuscationCanary } from "@th/adapters/geo/obfuscation";
import { configureLocationObfuscation } from "@th/core/lib/location/obfuscation-key";
import {
  LOCATION_OBFUSCATION_CANARY_PLACE,
  canaryPoint,
  verifyLocationObfuscationLive,
} from "@th/core/lib/location/obfuscation-self-test";
import { redactPlaceLocation } from "@th/core/lib/location/redact-place-location";
import { reprojectWithheldPlaceLocations } from "@th/core/use-cases/places/reproject-withheld-place-locations";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import Redis from "ioredis";
import { resolveRedisConnection } from "@th/adapters/redis/connection-config";
import { createRedisCacheGenerationStore } from "@th/adapters/decorators/cache-generation";

function parseArgs(argv: string[]) {
  const placeIds: string[] = [];
  let apply = false;
  let reindex = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--no-reindex") reindex = false;
    else if (arg === "--place" && argv[i + 1]) placeIds.push(argv[++i]!);
    else if (arg === "--") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { apply, reindex, placeIds };
}

function buildSearch(): MultiSearchPort {
  const prisma = getPrisma();
  if ((process.env.SEARCH_BACKEND || "postgres").toLowerCase() === "meili") {
    const host = process.env.MEILISEARCH_HOST;
    const apiKey =
      process.env.MEILISEARCH_API_KEY || process.env.MEILISEARCH_MASTER_KEY;
    if (!host || !apiKey) {
      throw new Error(
        "SEARCH_BACKEND=meili requires MEILISEARCH_HOST and MEILISEARCH_API_KEY",
      );
    }
    return new MultiIndexMeilisearchAdapter({ host, apiKey });
  }
  return new MultiIndexPostgresAdapter({
    prisma,
    weights: {
      fulltext: readSearchWeight("SEARCH_W_FULLTEXT", 1.0),
      prefix: readSearchWeight("SEARCH_W_PREFIX", 0.7),
      fuzzy: readSearchWeight("SEARCH_W_FUZZY", 0.5),
      popularity: readSearchWeight("SEARCH_W_POPULARITY", 0.05),
      geo: readSearchWeight("SEARCH_W_GEO", 1.0),
    },
  });
}

/**
 * Tell every API instance's anonymous-read caches that locations changed
 * (see the header). Never throws: a failure is printed and fails the exit
 * code, because the rows are already written.
 */
async function bumpPublicReadGeneration(): Promise<void> {
  if (!process.env.REDIS_URL) {
    console.warn(
      "[reproject] REDIS_URL not set — the API's anonymous-read caches were NOT invalidated. Re-run --apply with this environment's REDIS_URL/REDIS_NAMESPACE, or accept up to PUBLIC_DISCOVERY_CACHE_TTL_S of stale home-page locations.",
    );
    return;
  }
  let redis: Redis | null = null;
  try {
    const connection = resolveRedisConnection({
      url: process.env.REDIS_URL,
      namespace: process.env.REDIS_NAMESPACE,
      nodeEnv: process.env.NODE_ENV,
    });
    redis = new Redis(connection.url, {
      ...(connection.keyPrefix ? { keyPrefix: connection.keyPrefix } : {}),
      commandTimeout: connection.commandTimeout,
      maxRetriesPerRequest: connection.maxRetriesPerRequest,
    });
    const value = await createRedisCacheGenerationStore(redis).bump();
    console.log(
      `[reproject] public-read generation bumped to ${value} on ${new URL(connection.url).host}${
        connection.keyPrefix ? ` (${connection.keyPrefix})` : ""
      }`,
    );
  } catch (err) {
    console.error(
      "[reproject] could NOT bump the public-read generation — API caches may serve pre-reproject locations for up to PUBLIC_DISCOVERY_CACHE_TTL_S",
      err,
    );
    process.exitCode = 1;
  } finally {
    redis?.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = {
    error: (message: string, meta?: Record<string, unknown>) =>
      console.error(message, meta ?? {}),
    info: (message: string, meta?: Record<string, unknown>) =>
      console.log(message, meta ?? {}),
  };

  // The key FIRST — and prove it draws circles through the same module the
  // adapters use. Without it the projection is "no circle" and an --apply
  // would null every stored centre.
  const { keyed } = configureLocationObfuscation({
    secret: process.env.UNSUBSCRIBE_SECRET,
    logger,
  });
  if (!keyed) {
    throw new Error(
      "UNSUBSCRIBE_SECRET is not set — refusing to re-project without the obfuscation key",
    );
  }
  verifyLocationObfuscationLive({
    failHard: true,
    logger,
    canaries: [
      {
        source: "@th/core/lib/location/redact-place-location",
        draw: () =>
          canaryPoint(redactPlaceLocation(LOCATION_OBFUSCATION_CANARY_PLACE)),
      },
      {
        source: "@th/adapters/geo/obfuscation",
        draw: adaptersLocationObfuscationCanary,
      },
    ],
  });

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const dbHost = new URL(process.env.DATABASE_URL!).host;

  const placeIds =
    args.placeIds.length > 0
      ? args.placeIds
      : (
          await prisma.place.findMany({
            where: { locationMode: { not: "EXACT" } },
            select: { id: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => row.id);
  const names = new Map(
    (
      await prisma.place.findMany({
        where: { id: { in: placeIds } },
        select: { id: true, name: true },
      })
    ).map((row) => [row.id, row.name]),
  );

  console.log(
    `[reproject] ${args.apply ? "APPLY" : "DRY RUN"} on ${dbHost} — ${placeIds.length} withheld venue(s)${
      args.apply && args.reindex ? ", reindexing changes" : ""
    }`,
  );

  const result = await reprojectWithheldPlaceLocations(
    {
      repos,
      clock: createSystemClock(),
      ...(args.apply && args.reindex ? { search: buildSearch() } : {}),
      reportError: (err) => console.error("[reproject] reindex error", err),
    },
    { placeIds, dryRun: !args.apply },
  );

  for (const place of result.places) {
    console.log(
      JSON.stringify({
        placeId: place.placeId,
        name: names.get(place.placeId) ?? null,
        outcome: place.outcome,
        events: place.eventCount,
        stale: place.staleEventIds.length,
        publicCentre: place.publicCentre,
        staleCentres: place.staleCentres,
        reprojected: place.reprojectedEventIds.length,
      }),
    );
  }
  console.log(`[reproject] totals ${JSON.stringify(result.totals)}`);
  if (!args.apply && result.totals.staleEvents > 0) {
    console.log("[reproject] dry run — re-run with --apply to write.");
  }
  if (args.apply) {
    await bumpPublicReadGeneration();
    console.log(
      "[reproject] rows done. Finish with a FULL reindex (`pnpm -F api reindex:search`) — freeform obscured events and venue docs draw their circles at index time.",
    );
  }
  if (result.totals.reindexFailures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[reproject] Failed:", err);
  process.exit(1);
});
