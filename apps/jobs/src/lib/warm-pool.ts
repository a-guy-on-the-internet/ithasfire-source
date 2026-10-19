import type pg from "pg";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

export interface WarmPoolDeps {
  logger: LoggerPort;
  reportError?: ReporterPort;
}

export interface WarmPoolResult {
  /** Connections open and idle in the pool when warm-up returns. */
  opened: number;
  /** Slots still unopened after the retry. */
  failed: number;
}

/** Connect attempts per slot: the first try plus one retry. */
const ATTEMPTS = 2;

/**
 * Bound on each `SELECT 1`. POOL_TUNING sets no `query_timeout`, and on Neon's
 * PgBouncer endpoint a query waits for a server connection, so without this
 * one hung query would hold `listen` until the startup probe gives up.
 */
export const WARM_QUERY_TIMEOUT_MS = 5_000;

// pg reads `query_timeout` off the query object (client.js `query()`), but
// @types/pg's QueryConfig omits it, hence the widened type.
const WARM_QUERY: pg.QueryConfig & { query_timeout: number } = {
  text: "SELECT 1",
  query_timeout: WARM_QUERY_TIMEOUT_MS,
};

/**
 * A client warm-up has checked out. pg-pool drops its own `error` listener
 * from a client while it is checked out, so warm-up adds one: a connection
 * that drops while held would otherwise throw an uncaught `error` event and
 * kill the boot. `error` records the drop so the client is destroyed on
 * release instead of pooled.
 */
interface HeldClient {
  client: pg.PoolClient;
  onError: (err: Error) => void;
  error?: Error;
}

/**
 * Open `size` pool connections before the service starts listening, so the
 * first requests find them idle instead of all dialling at once.
 *
 * Jobs scales to zero, so every Cloud Scheduler tick lands on a cold instance.
 * On the :00 tick 21 jobs fire together: their requests queue through the cold
 * start and are released at once into an empty pool. New connections from a
 * cold instance are slow (prod Sentry, 2026-10: jobs `pg.connect` p95 6.7s,
 * p99 8.5s, max at the 10s cap, against the API's p95 683ms on the same
 * database), so the slowest connects hit POOL_TUNING's 10s timeout and every
 * job of the tick failed together. Paying that cost here, before `listen`,
 * puts it behind the startup probe, where nothing is waiting on it.
 *
 * Raising the connect timeout instead does not work: Prisma's transaction
 * `maxWait` (5–10s) still fails the `repos.tx()` first, and a connect that
 * completes after that stays checked out with an open BEGIN.
 *
 * Every client is held until all connects, retry included, have settled, so
 * the pool opens `size` distinct connections rather than handing one back
 * out. Each runs `SELECT 1` so a connection that opened but cannot query is
 * destroyed instead of pooled. Released, the connections sit idle for
 * POOL_TUNING's 60s `idleTimeoutMillis`. A client that errors while held is
 * destroyed on release and counted as failed.
 *
 * Best-effort: failed connects are logged and reported, and boot continues on
 * whatever opened. Neither a throwing logger nor a throwing reporter can fail
 * the boot.
 */
export async function warmPool(
  pool: Pick<pg.Pool, "connect">,
  size: number,
  deps: WarmPoolDeps,
): Promise<WarmPoolResult> {
  const held: HeldClient[] = [];
  const firstErrors: unknown[] = [];
  let lastErrors: unknown[] = [];

  try {
    let pending = size;
    for (let attempt = 0; attempt < ATTEMPTS && pending > 0; attempt++) {
      const results = await Promise.allSettled(
        Array.from({ length: pending }, () => openUsable(pool)),
      );
      lastErrors = [];
      for (const result of results) {
        if (result.status === "fulfilled") held.push(result.value);
        else lastErrors.push(result.reason);
      }
      if (attempt === 0) firstErrors.push(...lastErrors);
      pending = lastErrors.length;
    }
  } finally {
    for (const h of held) {
      h.client.removeListener("error", h.onError);
      if (h.error) h.client.release(h.error);
      else h.client.release();
    }
  }

  const dropped = held.filter((h) => h.error);
  const opened = held.length - dropped.length;
  const failed = lastErrors.length + dropped.length;

  if (firstErrors.length > 0 || dropped.length > 0) {
    const extra = {
      size,
      opened,
      failed,
      firstAttemptFailed: firstErrors.length,
      droppedWhileHeld: dropped.length,
    };
    const err = dropped[0]?.error ?? lastErrors[0] ?? firstErrors[0];
    try {
      deps.logger.error("jobs_pool_warmup_failed", { err, ...extra });
    } catch {
      // A throwing logger must not fail the boot.
    }
    try {
      deps.reportError?.(err, { tags: { area: "jobs-pool-warmup" }, extra });
    } catch {
      // A throwing reporter must not fail the boot.
    }
  }

  return { opened, failed };
}

/**
 * Connect, guard against a drop while held, and prove the connection answers
 * within WARM_QUERY_TIMEOUT_MS. A client whose `SELECT 1` fails or times out
 * is released with the error, which makes the pool destroy it rather than
 * keep it; that is its one release.
 */
async function openUsable(pool: Pick<pg.Pool, "connect">): Promise<HeldClient> {
  const client = await pool.connect();
  const held: HeldClient = {
    client,
    onError: (err) => {
      held.error ??= err;
    },
  };
  client.on("error", held.onError);
  try {
    await client.query(WARM_QUERY);
  } catch (err) {
    client.removeListener("error", held.onError);
    client.release(err instanceof Error ? err : true);
    throw err;
  }
  return held;
}
