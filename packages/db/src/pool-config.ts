import type { Pool } from "pg";

type PoolConfig = NonNullable<ConstructorParameters<typeof Pool>[0]>;

/**
 * Shared `pg.Pool` sizing for every service that talks to Postgres.
 *
 * Every pool in this repo was previously constructed bare —
 * `new pg.Pool({ connectionString })` — which silently accepted node-postgres'
 * defaults. One of those defaults is expensive here.
 *
 * ── Why `idleTimeoutMillis` ──────────────────────────────────────────────
 * node-postgres defaults `idleTimeoutMillis` to **10 seconds**, so an idle
 * connection is closed 10s after its last query. Production serves roughly
 * 1.7 tRPC requests/minute — a ~35s mean gap — so essentially every request
 * arrived to an empty pool and paid a fresh TCP+TLS handshake.
 *
 * Measured in production over 7d (2026-08-25, `docs/records/2026-08-25-db-load.md`):
 *
 *   pg.connect      53,380 spans   p50 48ms   avg 57ms   3,046 s/week
 *   all SQL combined                                     1,422 s/week
 *
 * Connection establishment cost 2.1x more than executing every query in the
 * system put together, and 39% of all pool acquisitions were cold. On
 * `GET /trpc/:path` it was 2.51 handshakes per request — ~143ms of pure
 * connection setup on every homepage render.
 *
 * 60s comfortably covers the observed request gap. Going higher buys little:
 * Cloud Run reaps idle instances anyway, so the pool does not outlive them.
 *
 * ── Why holding connections is safe here ─────────────────────────────────
 * `DATABASE_URL` is Neon's **pooled** (PgBouncer) endpoint — see
 * `neon_pooler_connection_uri` in `infra/terraform/secrets.tf`. That endpoint
 * accepts up to 10,000 client connections and Neon documents it as intended
 * for "serverless environments with many idle or short-lived connections".
 * Worst case here is `max` x `api_max_instances` (10 x 10 = 100), plus jobs and
 * the transcoder — orders of magnitude under the ceiling.
 *
 * Note this reasoning is specific to the pooled endpoint. `DIRECT_DATABASE_URL`
 * bypasses PgBouncer and is capped by compute size; anything pointed at the
 * direct endpoint (migrations) should not adopt these values uncritically.
 *
 * ── Why `connectionTimeoutMillis` ────────────────────────────────────────
 * The default is 0, meaning an exhausted pool waits forever and the request
 * only dies at Cloud Run's own timeout. 10s bounds that wait while staying
 * clear of a Neon compute cold-resume, which can take several seconds after
 * autosuspend. This is the one value here that can surface a *new* error
 * (`timeout exceeded when trying to connect`) rather than only removing work.
 *
 * `max: 10` is node-postgres' own default, set explicitly so the relationship
 * to Cloud Run request concurrency is a decision rather than an accident.
 * Cloud Run currently sets no `max_instance_request_concurrency`, so its
 * default of 80 concurrent requests per instance applies — well above `max`.
 * That gap is harmless at current volume and is tracked in the ops doc.
 */
export const POOL_TUNING = {
  max: 10,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 10_000,
} as const satisfies Pick<
  PoolConfig,
  "max" | "idleTimeoutMillis" | "connectionTimeoutMillis"
>;
