import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";

import pg from "pg";

import { POOL_TUNING } from "@th/db";
import type { LoggerPort } from "@th/ports/logger";
import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers/index";

import { WARM_QUERY_TIMEOUT_MS, warmPool } from "../warm-pool";

function fakeLogger(): LoggerPort & { error: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    withTime: <T>(_name: string, f: () => Promise<T>) => f(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  // Let any stray rejection surface before checking.
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

describe("warmPool against Postgres", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
  }, 300_000);

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  afterAll(async () => {
    await pgContainer?.stop();
  });

  function newPool() {
    pool = new pg.Pool({
      connectionString: pgContainer!.databaseUrl,
      ...POOL_TUNING,
    });
    return pool;
  }

  /** The real pool, with chosen connect() calls (1-based) failing. */
  function failingCalls(real: pg.Pool, fails: (call: number) => boolean) {
    const connect = real.connect.bind(real) as () => Promise<pg.PoolClient>;
    let calls = 0;
    return {
      connect: () => {
        calls += 1;
        return fails(calls)
          ? Promise.reject(new Error("timeout exceeded when trying to connect"))
          : connect();
      },
    } as Pick<pg.Pool, "connect">;
  }

  test("leaves max idle connections in the pool for the first tick", async () => {
    const real = newPool();
    const logger = fakeLogger();
    const reportError = vi.fn();

    const result = await warmPool(real, POOL_TUNING.max, { logger, reportError });

    expect(result).toEqual({ opened: POOL_TUNING.max, failed: 0 });
    expect(real.totalCount).toBe(POOL_TUNING.max);
    expect(real.idleCount).toBe(POOL_TUNING.max);
    expect(real.waitingCount).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  test("retries failed slots while the open ones are held, so all N open, and reports it", async () => {
    const real = newPool();
    // Calls 3, 6, 9 fail on the first round; the three retries (10-12) succeed.
    const flaky = failingCalls(real, (call) => call <= 9 && call % 3 === 0);
    const logger = fakeLogger();
    const reportError = vi.fn();

    const result = await warmPool(flaky, 9, { logger, reportError });

    expect(result).toEqual({ opened: 9, failed: 0 });
    expect(real.totalCount).toBe(9);
    expect(real.idleCount).toBe(9);
    const extra = {
      size: 9,
      opened: 9,
      failed: 0,
      firstAttemptFailed: 3,
      droppedWhileHeld: 0,
    };
    expect(logger.error).toHaveBeenCalledWith(
      "jobs_pool_warmup_failed",
      expect.objectContaining(extra),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "timeout exceeded when trying to connect",
      }),
      { tags: { area: "jobs-pool-warmup" }, extra },
    );
  });

  test("boots on what opened when a slot still fails after the retry", async () => {
    const real = newPool();
    // First round: 3, 6, 9 fail. Retry round: 10, 11 open, 12 fails.
    const flaky = failingCalls(real, (call) => call % 3 === 0);
    const reportError = vi.fn();

    const result = await warmPool(flaky, 9, {
      logger: fakeLogger(),
      reportError,
    });

    expect(result).toEqual({ opened: 8, failed: 1 });
    expect(real.totalCount).toBe(8);
    expect(real.idleCount).toBe(8);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "jobs-pool-warmup" },
      extra: {
        size: 9,
        opened: 8,
        failed: 1,
        firstAttemptFailed: 3,
        droppedWhileHeld: 0,
      },
    });
  });
});

describe("warmPool with a fake pool", () => {
  type FakeClient = EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  type Outcome = "ok" | "fail" | "query-fails" | "query-hangs";

  /**
   * Each connect() parks until its settle function runs. `outcome` decides,
   * per 0-based call, whether it connects, fails to connect, or connects and
   * then fails `SELECT 1`, or connects and never answers it. A hung query
   * rejects at its `query_timeout`, as pg's client does ("Query read
   * timeout").
   */
  function parkedPool(outcome: (call: number) => Outcome) {
    const settles: Array<() => void> = [];
    const clients: FakeClient[] = [];
    const pool = {
      connect: () =>
        new Promise((resolve, reject) => {
          const call = settles.length;
          settles.push(() => {
            const o = outcome(call);
            if (o === "fail") {
              reject(new Error("Connection terminated due to connection timeout"));
              return;
            }
            const client = Object.assign(new EventEmitter(), {
              query: vi.fn((config: { query_timeout?: number }) => {
                if (o === "query-fails") {
                  return Promise.reject(
                    new Error("Connection terminated unexpectedly"),
                  );
                }
                if (o === "query-hangs") {
                  return new Promise((_resolve, rejectQuery) => {
                    if (config.query_timeout) {
                      setTimeout(
                        () => rejectQuery(new Error("Query read timeout")),
                        config.query_timeout,
                      );
                    }
                  });
                }
                return Promise.resolve({ rows: [{ "?column?": 1 }] });
              }),
              release: vi.fn(),
            }) as FakeClient;
            clients.push(client);
            resolve(client);
          });
        }),
    } as unknown as Pick<pg.Pool, "connect">;
    return { pool, settles, clients };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test("holds every client through the retry, then releases each exactly once", async () => {
    // Calls 1 and 3 fail; their retries (5 and 6) succeed.
    const { pool, settles, clients } = parkedPool((call) =>
      call === 1 || call === 3 ? "fail" : "ok",
    );

    const run = warmPool(pool, 5, { logger: fakeLogger() });
    expect(settles).toHaveLength(5);

    for (const settle of settles) settle();
    await flush();
    // The retry round has dialled while the first three are still held.
    expect(settles).toHaveLength(7);
    for (const c of clients) expect(c.release).not.toHaveBeenCalled();

    settles[5]!();
    settles[6]!();
    const result = await run;

    expect(result).toEqual({ opened: 5, failed: 0 });
    expect(clients).toHaveLength(5);
    for (const c of clients) {
      expect(c.query).toHaveBeenCalledWith({
        text: "SELECT 1",
        query_timeout: WARM_QUERY_TIMEOUT_MS,
      });
      expect(c.listenerCount("error")).toBe(0);
      expect(c.release).toHaveBeenCalledTimes(1);
      expect(c.release).toHaveBeenCalledWith();
    }
  });

  test("a client that cannot run SELECT 1 is destroyed once and its slot retried", async () => {
    const { pool, settles, clients } = parkedPool((call) =>
      call === 0 ? "query-fails" : "ok",
    );
    const reportError = vi.fn();

    const run = warmPool(pool, 2, { logger: fakeLogger(), reportError });
    settles[0]!();
    settles[1]!();
    await flush();
    settles[2]!();
    const result = await run;

    expect(result).toEqual({ opened: 2, failed: 0 });
    const [broken, ...good] = clients;
    expect(broken!.release).toHaveBeenCalledTimes(1);
    expect(broken!.release).toHaveBeenCalledWith(expect.any(Error));
    for (const c of good) expect(c.release).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  test("a held client that drops is destroyed once and the boot goes on", async () => {
    const { pool, settles, clients } = parkedPool(() => "ok");
    const reportError = vi.fn();

    const run = warmPool(pool, 2, { logger: fakeLogger(), reportError });
    settles[0]!();
    await flush();
    // Client 0 is held while client 1 is still connecting; its connection
    // drops. With no listener, emit("error") would throw right here.
    const drop = new Error("Connection terminated unexpectedly");
    expect(() => clients[0]!.emit("error", drop)).not.toThrow();
    settles[1]!();
    const result = await run;

    expect(result).toEqual({ opened: 1, failed: 1 });
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
    expect(clients[0]!.release).toHaveBeenCalledWith(drop);
    expect(clients[1]!.release).toHaveBeenCalledTimes(1);
    expect(clients[1]!.release).toHaveBeenCalledWith();
    for (const c of clients) expect(c.listenerCount("error")).toBe(0);
    expect(reportError).toHaveBeenCalledWith(drop, {
      tags: { area: "jobs-pool-warmup" },
      extra: {
        size: 2,
        opened: 1,
        failed: 1,
        firstAttemptFailed: 0,
        droppedWhileHeld: 1,
      },
    });
  });

  test("a SELECT 1 that never answers times out, so warm-up still resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Every query hangs, first round and retry alike.
      const { pool, settles, clients } = parkedPool(() => "query-hangs");
      const reportError = vi.fn();

      const run = warmPool(pool, 1, { logger: fakeLogger(), reportError });
      settles[0]!();
      await vi.advanceTimersByTimeAsync(WARM_QUERY_TIMEOUT_MS);
      await flush();
      expect(settles).toHaveLength(2);
      settles[1]!();
      await vi.advanceTimersByTimeAsync(WARM_QUERY_TIMEOUT_MS);

      await expect(run).resolves.toEqual({ opened: 0, failed: 1 });
      expect(clients).toHaveLength(2);
      for (const c of clients) {
        expect(c.release).toHaveBeenCalledTimes(1);
        expect(c.release).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Query read timeout" }),
        );
      }
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a throwing reporter and a throwing logger leave the boot alive", async () => {
    const { pool, settles, clients } = parkedPool((call) =>
      call === 0 ? "ok" : "fail",
    );
    const logger = fakeLogger();
    logger.error.mockImplementation(() => {
      throw new Error("logger down");
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const run = warmPool(pool, 2, { logger, reportError });
    settles[0]!();
    settles[1]!();
    await flush();
    settles[2]!();

    await expect(run).resolves.toEqual({ opened: 1, failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
  });

  test("every connect failing twice still resolves, with nothing to release", async () => {
    const { pool, settles, clients } = parkedPool(() => "fail");
    const reportError = vi.fn();

    const run = warmPool(pool, 2, { logger: fakeLogger(), reportError });
    settles[0]!();
    settles[1]!();
    await flush();
    settles[2]!();
    settles[3]!();

    await expect(run).resolves.toEqual({ opened: 0, failed: 2 });
    expect(settles).toHaveLength(4);
    expect(clients).toHaveLength(0);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
