import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMigrationDriftError,
  checkMigrationDrift,
  createMigrationDriftMonitor,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_RECHECK_INTERVAL_MS,
  DEFAULT_RECHECK_TIMEOUT_MS,
  formatPendingMigrations,
  isMissingMigrationsTableError,
  listPendingMigrations,
  MAX_LISTED_PENDING_MIGRATIONS,
  migrationDriftEnforcementOverride,
  readAppliedMigrations,
  readExpectedMigrations,
  resolveMigrationsDir,
  shouldBlockOnDrift,
  staticMigrationDriftMonitor,
} from "../migration-drift";

/** Creates `<parent>/<name>/migration.sql` — a directory Prisma would apply. */
function makeMigrationDir(parent: string, name: string) {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(parent, name, "migration.sql"), "SELECT 1;\n");
}

function makeLogger() {
  const logger: any = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

type MigrationRow = {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at?: Date | null;
};

/**
 * Stands in for the Prisma client without a database. It records the SQL it was
 * handed and applies the `finished_at IS NOT NULL` predicate itself, so the
 * "started but never finished ⇒ still pending" behaviour is exercised through
 * the real query rather than asserted on a hand-filtered fixture.
 */
function makeFakePrisma(
  rows: MigrationRow[],
  options: { throws?: unknown } = {},
) {
  const queries: string[] = [];

  return {
    queries,
    $queryRaw: (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join("");
      queries.push(sql);

      if (options.throws) throw options.throws;

      if (!/from\s+"_prisma_migrations"/i.test(sql)) {
        throw new Error(`unexpected query: ${sql}`);
      }

      const onlyFinished = /finished_at\s+is\s+not\s+null/i.test(sql);
      const excludeRolledBack = /rolled_back_at\s+is\s+null/i.test(sql);

      return rows
        .filter((row) => (onlyFinished ? row.finished_at !== null : true))
        .filter((row) =>
          excludeRolledBack ? (row.rolled_back_at ?? null) === null : true,
        )
        .map((row) => ({ migration_name: row.migration_name })) as never;
    }) as never,
  };
}

describe("checkMigrationDrift", () => {
  it("reports ok when every image migration is finished in the database", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const prisma = makeFakePrisma([
      { migration_name: "20260101120000_init", finished_at: new Date() },
      { migration_name: "20260102120000_events", finished_at: new Date() },
    ]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => [
        "20260101120000_init",
        "20260102120000_events",
      ],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
    });

    expect(result).toEqual({ status: "ok" });
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("is ok when the database has EXTRA migrations the image does not know about (rollback)", async () => {
    const logger = makeLogger();
    const prisma = makeFakePrisma([
      { migration_name: "20260101120000_init", finished_at: new Date() },
      { migration_name: "20260201120000_newer", finished_at: new Date() },
    ]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
    });

    expect(result).toEqual({ status: "ok" });
  });

  it("reports drift naming every migration the database is missing", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const prisma = makeFakePrisma([
      { migration_name: "20260101120000_init", finished_at: new Date() },
    ]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => [
        "20260102120000_add_category_seo_type",
        "20260101120000_init",
      ],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
      enforce: true,
    });

    expect(result).toEqual({
      status: "drift",
      pending: ["20260102120000_add_category_seo_type"],
      enforced: true,
    });
    // Confirmed drift is the TERMINAL state of this feature (a container
    // refusing to serve) so it must be at least as visible as the
    // indeterminate case: a real Error through reportError, plus an `err`
    // field on the log line so Sentry's pinoIntegration links an exception.
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "20260102120000_add_category_seo_type",
        ),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          check: "migration_drift",
          reason: "drift",
          enforced: "true",
        }),
        extra: expect.objectContaining({
          pending: ["20260102120000_add_category_seo_type"],
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_detected",
      expect.objectContaining({
        err: expect.any(Error),
        pending: ["20260102120000_add_category_seo_type"],
        enforced: true,
        hint: expect.stringContaining("pnpm db:migrate:deploy"),
      }),
    );
  });

  it("still detects, logs and reports drift when enforcement is OFF (local dev)", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const prisma = makeFakePrisma([]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260102120000_events"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
      enforce: false,
    });

    // Detection is identical; only `enforced` (and therefore /health) differs.
    expect(result).toEqual({
      status: "drift",
      pending: ["20260102120000_events"],
      enforced: false,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ enforced: "false" }),
      }),
    );
    // The dev still gets the migration name AND the command to fix it.
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_detected",
      expect.objectContaining({
        pending: ["20260102120000_events"],
        enforced: false,
        hint: expect.stringContaining("pnpm db:migrate:deploy"),
      }),
    );
    // ...but no mention of a 503, because there isn't one.
    const hint = logger.error.mock.calls.at(-1)?.[1]?.hint as string;
    expect(hint).not.toContain("503");
  });

  it("defaults enforcement to shouldBlockOnDrift() when not supplied", async () => {
    const logger = makeLogger();
    const prisma = makeFakePrisma([]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260102120000_events"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
    });

    // Under vitest: no K_SERVICE, NODE_ENV !== "production".
    expect(result).toEqual({
      status: "drift",
      pending: ["20260102120000_events"],
      enforced: shouldBlockOnDrift(),
    });
    expect(shouldBlockOnDrift()).toBe(false);
  });

  it("treats a migration with finished_at IS NULL as pending", async () => {
    const logger = makeLogger();
    const prisma = makeFakePrisma([
      { migration_name: "20260101120000_init", finished_at: new Date() },
      // Started, never completed — the half-migrated state this guard exists
      // to catch. Present in _prisma_migrations, but NOT applied.
      { migration_name: "20260102120000_events", finished_at: null },
    ]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => [
        "20260101120000_init",
        "20260102120000_events",
      ],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      enforce: true,
    });

    expect(result).toEqual({
      status: "drift",
      pending: ["20260102120000_events"],
      enforced: true,
    });
    expect(prisma.queries[0]).toMatch(/finished_at IS NOT NULL/i);
  });

  it("treats a rolled-back migration as pending even though finished_at is set", async () => {
    const logger = makeLogger();
    const prisma = makeFakePrisma([
      { migration_name: "20260101120000_init", finished_at: new Date() },
      // `prisma migrate resolve --rolled-back` can leave finished_at set on a
      // migration whose SQL is NOT in the database. Counting it as applied
      // would make the guard miss exactly what it is looking for.
      {
        migration_name: "20260102120000_events",
        finished_at: new Date(),
        rolled_back_at: new Date(),
      },
    ]);

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => [
        "20260101120000_init",
        "20260102120000_events",
      ],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      enforce: true,
    });

    expect(result).toEqual({
      status: "drift",
      pending: ["20260102120000_events"],
      enforced: true,
    });
    expect(prisma.queries[0]).toMatch(/rolled_back_at IS NULL/i);
  });

  it("defaults the query timeout generously enough to survive a Neon cold start", () => {
    // Regression guard. This started at 5s, which lost the race against a
    // scale-to-zero Neon resume on the exact cold-boot path the guard protects
    // — failing OPEN (query_failed → unknown → no blocking) and re-creating the
    // original outage with the guard installed and inert. The bound only has to
    // fit inside Cloud Run's 150s startup-probe budget alongside a ~45s boot.
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("times out a hung _prisma_migrations query instead of hanging boot", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      // A black-holed database: the promise never settles. Without the
      // timeout this would hang boot until Cloud Run kills the container.
      listAppliedMigrations: () => new Promise<string[]>(() => {}),
      logger,
      reportError,
      queryTimeoutMs: 20,
      enforce: true,
    });

    expect(result).toEqual({ status: "unknown", reason: "query_failed" });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("migration_drift_query_timeout"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "query_failed" }),
      }),
    );
  });

  it("does not time out a query that completes in time, and clears the timer", async () => {
    const logger = makeLogger();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return ["20260101120000_init"];
      },
      logger,
      // Long enough that a leaked, REF'd timer would visibly hold the process
      // open — the `finally` clear is what stops that, not `unref()`.
      queryTimeoutMs: 60_000,
    });

    expect(result).toEqual({ status: "ok" });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("stays healthy and reports when _prisma_migrations does not exist", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const undefinedTable = Object.assign(
      new Error('relation "_prisma_migrations" does not exist'),
      { code: "42P01" },
    );
    const prisma = makeFakePrisma([], { throws: undefinedTable });

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
    });

    expect(result).toEqual({
      status: "unknown",
      reason: "migrations_table_missing",
    });
    expect(reportError).toHaveBeenCalledWith(
      undefinedTable,
      expect.objectContaining({
        tags: expect.objectContaining({
          check: "migration_drift",
          reason: "migrations_table_missing",
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_check_indeterminate",
      expect.objectContaining({ reason: "migrations_table_missing" }),
    );
  });

  it("stays healthy and reports when the migrations directory is absent", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const prisma = makeFakePrisma([]);

    const result = await checkMigrationDrift({
      // Mirrors the real wiring: resolveMigrationsDir() returned null.
      listExpectedMigrations: () => readExpectedMigrations(null),
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
    });

    expect(result).toEqual({
      status: "unknown",
      reason: "migrations_dir_missing",
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("prisma_migrations_dir_not_found"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "migrations_dir_missing" }),
      }),
    );
    // The database is never queried when the expected list is unknown.
    expect(prisma.queries).toHaveLength(0);
  });

  it("stays healthy and reports query_failed when the database is unreachable", async () => {
    const logger = makeLogger();
    const reportError = vi.fn();
    const unreachable = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const prisma = makeFakePrisma([], { throws: unreachable });

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
      reportError,
    });

    expect(result).toEqual({ status: "unknown", reason: "query_failed" });
    expect(reportError).toHaveBeenCalledWith(
      unreachable,
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "query_failed" }),
      }),
    );
  });

  it("works with no reporter wired at all (optional-chaining swallow path)", async () => {
    const logger = makeLogger();
    const prisma = makeFakePrisma([], { throws: new Error("boom") });

    // `reportError` is optional per the CLAUDE.md convention — the swallow
    // branch must not depend on it being present.
    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () => readAppliedMigrations(prisma),
      logger,
    });

    expect(result).toEqual({ status: "unknown", reason: "query_failed" });
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_check_indeterminate",
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it("does not let a throwing reporter change the outcome", async () => {
    const logger = makeLogger();
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });
    const prisma = makeFakePrisma([], { throws: new Error("boom") });

    await expect(
      checkMigrationDrift({
        listExpectedMigrations: () => ["20260101120000_init"],
        listAppliedMigrations: () => readAppliedMigrations(prisma),
        logger,
        reportError,
      }),
    ).resolves.toEqual({ status: "unknown", reason: "query_failed" });
  });

  it("does not let a throwing reporter change the DRIFT outcome either", async () => {
    const logger = makeLogger();
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });
    const prisma = makeFakePrisma([]);

    await expect(
      checkMigrationDrift({
        listExpectedMigrations: () => ["20260101120000_init"],
        listAppliedMigrations: () => readAppliedMigrations(prisma),
        logger,
        reportError,
        enforce: true,
      }),
    ).resolves.toEqual({
      status: "drift",
      pending: ["20260101120000_init"],
      enforced: true,
    });
  });
});

describe("shouldBlockOnDrift", () => {
  it("blocks under Cloud Run (K_SERVICE) and in production", () => {
    expect(shouldBlockOnDrift({ K_SERVICE: "hf-prod-api" })).toBe(true);
    expect(shouldBlockOnDrift({ NODE_ENV: "production" })).toBe(true);
    expect(
      shouldBlockOnDrift({ K_SERVICE: "hf-dev-api", NODE_ENV: "production" }),
    ).toBe(true);
  });

  it("does NOT block on a dev laptop, where a 503 would kill the whole stack", () => {
    // scripts/human-dev.cjs gates API/jobs/stripe/web on /health returning
    // 200-399 and hard-exits on timeout (90s api / 60s jobs).
    expect(shouldBlockOnDrift({})).toBe(false);
    expect(shouldBlockOnDrift({ NODE_ENV: "development" })).toBe(false);
    expect(shouldBlockOnDrift({ NODE_ENV: "test" })).toBe(false);
    expect(shouldBlockOnDrift({ K_SERVICE: "" })).toBe(false);
  });

  it("MIGRATION_DRIFT_ENFORCE=false overrules Cloud Run AND production", () => {
    // The break-glass: with a startup probe on /health, a drifted revision
    // never becomes Ready, which halts every job (settlements/payouts) and
    // blocks the pipeline's own `skip-migrate` incident path.
    for (const value of ["false", "FALSE", " off ", "0"]) {
      expect(
        shouldBlockOnDrift({
          K_SERVICE: "hf-prod-jobs",
          NODE_ENV: "production",
          MIGRATION_DRIFT_ENFORCE: value,
        }),
      ).toBe(false);
    }
  });

  it("MIGRATION_DRIFT_ENFORCE=true forces enforcement on locally", () => {
    for (const value of ["true", "TRUE", "1", "on"]) {
      expect(shouldBlockOnDrift({ MIGRATION_DRIFT_ENFORCE: value })).toBe(true);
    }
  });

  it("ignores a typo'd value rather than silently disabling the guard", () => {
    expect(
      shouldBlockOnDrift({
        K_SERVICE: "hf-prod-jobs",
        MIGRATION_DRIFT_ENFORCE: "flase",
      }),
    ).toBe(true);
    expect(
      shouldBlockOnDrift({ K_SERVICE: "hf-prod-jobs", MIGRATION_DRIFT_ENFORCE: "" }),
    ).toBe(true);
  });
});

describe("migrationDriftEnforcementOverride", () => {
  it("reports the explicit override, or null for automatic behaviour", () => {
    expect(migrationDriftEnforcementOverride({})).toBeNull();
    expect(
      migrationDriftEnforcementOverride({ MIGRATION_DRIFT_ENFORCE: "false" }),
    ).toBe("forced_off");
    expect(
      migrationDriftEnforcementOverride({ MIGRATION_DRIFT_ENFORCE: "true" }),
    ).toBe("forced_on");
    expect(
      migrationDriftEnforcementOverride({ MIGRATION_DRIFT_ENFORCE: "maybe" }),
    ).toBeNull();
  });
});

describe("MIGRATION_DRIFT_ENFORCE break-glass in checkMigrationDrift", () => {
  const original = process.env.MIGRATION_DRIFT_ENFORCE;

  afterEach(() => {
    if (original === undefined) delete process.env.MIGRATION_DRIFT_ENFORCE;
    else process.env.MIGRATION_DRIFT_ENFORCE = original;
  });

  it("announces itself at error + Sentry on EVERY boot, even with no drift", () => {
    // Never a quiet mode: an operator who leaves the break-glass set after an
    // incident has removed the guard, and that must be impossible to miss.
    process.env.MIGRATION_DRIFT_ENFORCE = "false";
    const logger = makeLogger();
    const reportError = vi.fn();

    return checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () =>
        readAppliedMigrations(
          makeFakePrisma([
            { migration_name: "20260101120000_init", finished_at: new Date() },
          ]),
        ),
      logger,
      reportError,
    }).then((result) => {
      expect(result).toEqual({ status: "ok" });
      expect(logger.error).toHaveBeenCalledWith(
        "migration_drift_enforcement_disabled",
        expect.objectContaining({ err: expect.any(Error) }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "migration_drift_enforcement_disabled",
          ),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ reason: "enforcement_disabled" }),
        }),
      );
    });
  });

  it("keeps DETECTING and reporting drift while refusing to block", async () => {
    process.env.MIGRATION_DRIFT_ENFORCE = "false";
    process.env.K_SERVICE = "hf-prod-jobs"; // would otherwise enforce
    const logger = makeLogger();
    const reportError = vi.fn();

    try {
      const result = await checkMigrationDrift({
        listExpectedMigrations: () => ["20260101120000_init"],
        listAppliedMigrations: () => readAppliedMigrations(makeFakePrisma([])),
        logger,
        reportError,
      });

      // Detected, named, reported — but NOT enforced.
      expect(result).toEqual({
        status: "drift",
        pending: ["20260101120000_init"],
        enforced: false,
      });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            reason: "drift",
            enforced: "false",
            enforcementOverride: "forced_off",
          }),
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "migration_drift_detected",
        expect.objectContaining({
          enforcementOverride: "forced_off",
          hint: expect.stringContaining("MIGRATION_DRIFT_ENFORCE=false"),
        }),
      );
    } finally {
      delete process.env.K_SERVICE;
    }
  });

  it("stays silent about enforcement when the break-glass is not set", async () => {
    delete process.env.MIGRATION_DRIFT_ENFORCE;
    const logger = makeLogger();

    await checkMigrationDrift({
      listExpectedMigrations: () => [],
      listAppliedMigrations: async () => [],
      logger,
    });

    expect(logger.error).not.toHaveBeenCalledWith(
      "migration_drift_enforcement_disabled",
      expect.anything(),
    );
  });

  it("an explicit `enforce` dep wins over the env override", async () => {
    process.env.MIGRATION_DRIFT_ENFORCE = "false";
    const logger = makeLogger();

    const result = await checkMigrationDrift({
      listExpectedMigrations: () => ["20260101120000_init"],
      listAppliedMigrations: () => readAppliedMigrations(makeFakePrisma([])),
      logger,
      enforce: true,
    });

    expect(result).toEqual({
      status: "drift",
      pending: ["20260101120000_init"],
      enforced: true,
    });
    // The env announcement is skipped too — the caller pinned the decision.
    expect(logger.error).not.toHaveBeenCalledWith(
      "migration_drift_enforcement_disabled",
      expect.anything(),
    );
  });
});

describe("createMigrationDriftMonitor (asymmetric caching)", () => {
  /**
   * Regression suite for prod deploy #583 / revision `hf-prod-jobs-00003-4v9`.
   * Terraform runs concurrently with migrate_db (it provisions the secret
   * migrate_db reads, so the dependency is circular), so the container booted
   * mid-migration, cached `drift` with 16 pending, and replayed a stale 503 for
   * all 48 startup probes even though migrations landed at 2m16s.
   */

  /** Controllable clock + a migration set the test can mutate mid-flight. */
  function harness(options: {
    expected: string[];
    applied: string[];
    recheckIntervalMs?: number;
  }) {
    const state = { applied: [...options.applied], queries: 0 };
    let nowMs = 1_000_000;

    const logger = makeLogger();
    const reportError = vi.fn();

    const deps = {
      listExpectedMigrations: () => options.expected,
      listAppliedMigrations: async () => {
        state.queries += 1;
        return [...state.applied];
      },
      logger,
      reportError,
      enforce: true,
      now: () => nowMs,
      ...(options.recheckIntervalMs !== undefined
        ? { recheckIntervalMs: options.recheckIntervalMs }
        : {}),
    };

    return {
      deps,
      state,
      logger,
      reportError,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it("recovers to healthy once the migrations land (the #583 fix)", async () => {
    const h = harness({
      expected: ["m1", "m2", "m3"],
      applied: ["m1"], // mid-deploy: 2 of 3 still being applied
    });

    const monitor = await createMigrationDriftMonitor(h.deps);

    // Boot verdict: drifted, exactly as the failing revision saw it.
    expect(await monitor.get()).toEqual({
      status: "drift",
      pending: ["m2", "m3"],
      enforced: true,
    });

    // migrate_db finishes while the container is being probed.
    h.state.applied = ["m1", "m2", "m3"];

    // Within the interval the cached verdict still stands (no stampede)...
    expect(await monitor.get()).toMatchObject({ status: "drift" });

    // ...and on the next probe after the interval it self-heals.
    h.advance(DEFAULT_RECHECK_INTERVAL_MS);
    expect(await monitor.get()).toEqual({ status: "ok" });
  });

  it("never re-queries once the verdict is ok (permanent cache)", async () => {
    const h = harness({ expected: ["m1"], applied: ["m1"] });
    const monitor = await createMigrationDriftMonitor(h.deps);

    expect(h.state.queries).toBe(1); // the boot check
    for (let i = 0; i < 10; i += 1) {
      h.advance(60_000);
      expect(await monitor.get()).toEqual({ status: "ok" });
    }
    // Migrations only move forward, so a schema current at boot cannot become
    // stale — /health stays free.
    expect(h.state.queries).toBe(1);
  });

  it("does not re-query more than once per interval", async () => {
    const h = harness({ expected: ["m1"], applied: [] });
    const monitor = await createMigrationDriftMonitor(h.deps);
    expect(h.state.queries).toBe(1);

    // A burst of probes inside the interval reuses the cached verdict.
    for (let i = 0; i < 5; i += 1) {
      h.advance(DEFAULT_RECHECK_INTERVAL_MS / 10);
      await monitor.get();
    }
    expect(h.state.queries).toBe(1);

    h.advance(DEFAULT_RECHECK_INTERVAL_MS);
    await monitor.get();
    expect(h.state.queries).toBe(2);
  });

  it("single-flights concurrent probes into ONE query", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const state = { applied: [] as string[], queries: 0 };
    let nowMs = 0;
    const logger = makeLogger();

    const monitor = await createMigrationDriftMonitor({
      listExpectedMigrations: () => ["m1"],
      listAppliedMigrations: async () => {
        state.queries += 1;
        if (state.queries > 1) await gate; // only the re-query blocks
        return [...state.applied];
      },
      logger,
      enforce: true,
      now: () => nowMs,
    });

    expect(state.queries).toBe(1);
    nowMs += DEFAULT_RECHECK_INTERVAL_MS;

    // Ten probes arrive while the re-query is still in flight.
    const inFlight = Promise.all(
      Array.from({ length: 10 }, () => monitor.get()),
    );
    release?.();
    const results = await inFlight;

    expect(state.queries).toBe(2); // one boot + exactly one re-query
    for (const result of results) {
      expect(result).toMatchObject({ status: "drift" });
    }
  });

  it("keeps blocking when the drift is real and persistent", async () => {
    const h = harness({ expected: ["m1", "m2"], applied: ["m1"] });
    const monitor = await createMigrationDriftMonitor(h.deps);

    for (let i = 0; i < 5; i += 1) {
      h.advance(DEFAULT_RECHECK_INTERVAL_MS);
      expect(await monitor.get()).toEqual({
        status: "drift",
        pending: ["m2"],
        enforced: true,
      });
    }
    expect(h.state.queries).toBe(6);
  });

  it("reports/logs on TRANSITIONS only, not on every re-query", async () => {
    const h = harness({ expected: ["m1", "m2"], applied: ["m1"] });
    const monitor = await createMigrationDriftMonitor(h.deps);

    const afterBoot = h.reportError.mock.calls.length;
    expect(afterBoot).toBe(1);

    // Five identical re-checks must not produce five identical Sentry events
    // or five identical error lines.
    for (let i = 0; i < 5; i += 1) {
      h.advance(DEFAULT_RECHECK_INTERVAL_MS);
      await monitor.get();
    }
    expect(h.reportError.mock.calls.length).toBe(afterBoot);

    // A genuinely NEW verdict (the pending set shrank) is surfaced again.
    h.state.applied = ["m1", "m2"];
    h.advance(DEFAULT_RECHECK_INTERVAL_MS);
    expect(await monitor.get()).toEqual({ status: "ok" });
    expect(h.logger.info).toHaveBeenCalledWith(
      "migration_drift_check_ok",
      expect.anything(),
    );
  });

  it("re-queries an `unknown` verdict instead of failing open forever", async () => {
    // `unknown` fails OPEN. Caching it permanently would let one transient
    // blip at boot disable the guard for the life of the container.
    let failing = true;
    const state = { queries: 0 };
    let nowMs = 0;
    const logger = makeLogger();

    const monitor = await createMigrationDriftMonitor({
      listExpectedMigrations: () => ["m1", "m2"],
      listAppliedMigrations: async () => {
        state.queries += 1;
        if (failing) throw new Error("connect ECONNREFUSED");
        return ["m1"];
      },
      logger,
      enforce: true,
      now: () => nowMs,
    });

    expect(await monitor.get()).toEqual({
      status: "unknown",
      reason: "query_failed",
    });

    // Database comes back — the guard wakes up rather than staying inert.
    failing = false;
    nowMs += DEFAULT_RECHECK_INTERVAL_MS;
    expect(await monitor.get()).toEqual({
      status: "drift",
      pending: ["m2"],
      enforced: true,
    });
  });

  it("never lets an `unknown` re-check clear a confirmed drift", async () => {
    // A slow/flaky database must not be able to UNBLOCK a drifted container.
    let failing = false;
    let nowMs = 0;
    const logger = makeLogger();

    const monitor = await createMigrationDriftMonitor({
      listExpectedMigrations: () => ["m1", "m2"],
      listAppliedMigrations: async () => {
        if (failing) throw new Error("connect ECONNREFUSED");
        return ["m1"];
      },
      logger,
      enforce: true,
      now: () => nowMs,
    });

    expect(await monitor.get()).toMatchObject({ status: "drift" });

    failing = true;
    nowMs += DEFAULT_RECHECK_INTERVAL_MS;
    // Still drift — NOT downgraded to a healthy `unknown`.
    expect(await monitor.get()).toEqual({
      status: "drift",
      pending: ["m2"],
      enforced: true,
    });
  });

  it("peek() exposes the cached verdict without querying", async () => {
    const h = harness({ expected: ["m1"], applied: [] });
    const monitor = await createMigrationDriftMonitor(h.deps);

    h.advance(DEFAULT_RECHECK_INTERVAL_MS * 10);
    expect(monitor.peek()).toMatchObject({ status: "drift" });
    expect(h.state.queries).toBe(1);
  });

  it("bounds a re-query with the tighter recheck timeout", async () => {
    // The boot budget (25s, for a Neon cold start) is far too long for a
    // request whose caller — the startup probe — gives up after 3s.
    expect(DEFAULT_RECHECK_TIMEOUT_MS).toBeLessThan(DEFAULT_QUERY_TIMEOUT_MS);
    expect(DEFAULT_RECHECK_INTERVAL_MS).toBeLessThan(5_000);

    let nowMs = 0;
    let hang = false;
    const logger = makeLogger();

    const monitor = await createMigrationDriftMonitor({
      listExpectedMigrations: () => ["m1", "m2"],
      listAppliedMigrations: () =>
        hang ? new Promise<string[]>(() => {}) : Promise.resolve(["m1"]),
      logger,
      enforce: true,
      now: () => nowMs,
      recheckTimeoutMs: 20,
    });

    expect(await monitor.get()).toMatchObject({ status: "drift" });

    hang = true;
    nowMs += DEFAULT_RECHECK_INTERVAL_MS;
    // Resolves (does not hang the request) and holds the drift verdict.
    expect(await monitor.get()).toMatchObject({ status: "drift" });
  });
});

describe("staticMigrationDriftMonitor", () => {
  it("returns its fixed verdict and never queries", async () => {
    const monitor = staticMigrationDriftMonitor({
      status: "drift",
      pending: ["m1"],
      enforced: true,
    });

    expect(monitor.peek()).toMatchObject({ status: "drift" });
    expect(await monitor.get()).toMatchObject({ status: "drift" });
  });
});

describe("buildMigrationDriftError", () => {
  it("names the count, every pending migration and the fix command", () => {
    const err = buildMigrationDriftError(["a_one", "b_two"]);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("missing 2 migration(s)");
    expect(err.message).toContain("a_one");
    expect(err.message).toContain("b_two");
    expect(err.message).toContain("pnpm db:migrate:deploy");
    // Shared by the boot check and the jobs run-route short-circuit so both
    // group under one Sentry issue.
    expect(err.message.startsWith("migration_drift_detected:")).toBe(true);
  });

  it("bounds the name list so an empty database does not blow up the message", () => {
    // A totally unmigrated database yields ~100 names; unbounded, that lands in
    // every 503 body, every cron-tick log line, and overflows Sentry's message
    // truncation (wrecking issue grouping).
    const pending = Array.from({ length: 100 }, (_, i) => `m_${i}`);
    const err = buildMigrationDriftError(pending);

    // The true count is still stated exactly.
    expect(err.message).toContain("missing 100 migration(s)");
    expect(err.message).toContain("m_0");
    expect(err.message).toContain(`(+${100 - MAX_LISTED_PENDING_MIGRATIONS} more)`);
    expect(err.message).not.toContain("m_99");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("listPendingMigrations", () => {
  it("passes short lists through untouched and caps long ones", () => {
    expect(listPendingMigrations(["a", "b"])).toEqual(["a", "b"]);
    expect(listPendingMigrations([])).toEqual([]);

    const many = Array.from({ length: 100 }, (_, i) => `m_${i}`);
    expect(listPendingMigrations(many)).toHaveLength(
      MAX_LISTED_PENDING_MIGRATIONS,
    );
    expect(listPendingMigrations(many)[0]).toBe("m_0");
  });
});

describe("formatPendingMigrations", () => {
  it("joins with commas and only appends a remainder when truncating", () => {
    expect(formatPendingMigrations(["a", "b"])).toBe("a, b");
    expect(formatPendingMigrations(["a"])).toBe("a");
    expect(
      formatPendingMigrations(
        Array.from({ length: MAX_LISTED_PENDING_MIGRATIONS }, (_, i) => `m${i}`),
      ),
    ).not.toContain("more");
  });
});

describe("isMissingMigrationsTableError", () => {
  it("recognises the raw pg code, the Prisma-wrapped meta code, and the message", () => {
    expect(isMissingMigrationsTableError({ code: "42P01" })).toBe(true);
    expect(
      isMissingMigrationsTableError({ code: "P2010", meta: { code: "42P01" } }),
    ).toBe(true);
    expect(
      isMissingMigrationsTableError(
        new Error('relation "public._prisma_migrations" does not exist'),
      ),
    ).toBe(true);
  });

  it("does not misread an unrelated failure as a missing table", () => {
    expect(isMissingMigrationsTableError(new Error("timeout"))).toBe(false);
    expect(isMissingMigrationsTableError(null)).toBe(false);
    expect(isMissingMigrationsTableError("42P01")).toBe(false);
  });
});

describe("resolveMigrationsDir / readExpectedMigrations", () => {
  let dir: string;
  const originalOverride = process.env.PRISMA_MIGRATIONS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drift-"));
    delete process.env.PRISMA_MIGRATIONS_DIR;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalOverride === undefined) {
      delete process.env.PRISMA_MIGRATIONS_DIR;
    } else {
      process.env.PRISMA_MIGRATIONS_DIR = originalOverride;
    }
  });

  it("finds the container layout (<app>/prisma/migrations) walking up from src/lib", () => {
    makeMigrationDir(join(dir, "prisma", "migrations"), "20260101120000_init");
    mkdirSync(join(dir, "src", "lib"), { recursive: true });

    expect(resolveMigrationsDir(join(dir, "src", "lib"))).toBe(
      join(dir, "prisma", "migrations"),
    );
  });

  it("prefers the container layout over packages/db at the same depth", () => {
    // Pins the in-loop ordering: at every level `prisma/migrations` is checked
    // before `packages/db/prisma/migrations`. In the runtime image the copied
    // /app/prisma/migrations is authoritative and must win even if a
    // packages/db tree were ever present alongside it.
    mkdirSync(join(dir, "prisma", "migrations"), { recursive: true });
    mkdirSync(join(dir, "packages", "db", "prisma", "migrations"), {
      recursive: true,
    });
    mkdirSync(join(dir, "src", "lib"), { recursive: true });

    expect(resolveMigrationsDir(join(dir, "src", "lib"))).toBe(
      join(dir, "prisma", "migrations"),
    );
  });

  it("finds the repo layout (packages/db/prisma/migrations)", () => {
    mkdirSync(join(dir, "packages", "db", "prisma", "migrations"), {
      recursive: true,
    });
    mkdirSync(join(dir, "apps", "api", "src", "lib"), { recursive: true });

    expect(resolveMigrationsDir(join(dir, "apps", "api", "src", "lib"))).toBe(
      join(dir, "packages", "db", "prisma", "migrations"),
    );
  });

  it("honours PRISMA_MIGRATIONS_DIR and returns null when the override is bogus", () => {
    mkdirSync(join(dir, "custom"), { recursive: true });
    process.env.PRISMA_MIGRATIONS_DIR = join(dir, "custom");
    expect(resolveMigrationsDir()).toBe(join(dir, "custom"));

    process.env.PRISMA_MIGRATIONS_DIR = join(dir, "nope");
    expect(resolveMigrationsDir()).toBeNull();
  });

  it("returns null (never a false alarm) when nothing is found", () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    expect(resolveMigrationsDir(join(dir, "empty"))).toBeNull();
  });

  it("reads only directory names, ignoring migration_lock.toml and down.sql", () => {
    const migrations = join(dir, "prisma", "migrations");
    makeMigrationDir(migrations, "20260101120000_init");
    makeMigrationDir(migrations, "20260102120000_events");
    // Mirrors 20260512_search_documents in the real tree.
    writeFileSync(
      join(migrations, "20260102120000_events", "down.sql"),
      "DROP TABLE x;\n",
    );
    writeFileSync(join(migrations, "migration_lock.toml"), 'provider = "x"\n');

    expect(readExpectedMigrations(migrations).sort()).toEqual([
      "20260101120000_init",
      "20260102120000_events",
    ]);
  });

  it("ignores a stray directory with no migration.sql (would 503 forever)", () => {
    const migrations = join(dir, "prisma", "migrations");
    makeMigrationDir(migrations, "20260101120000_init");
    // An editor temp dir / aborted `migrate dev` scaffold. `migrate deploy`
    // would never apply it, so counting it as pending would produce a
    // permanent, unclearable 503.
    mkdirSync(join(migrations, "20260103000000_aborted_scaffold"), {
      recursive: true,
    });
    mkdirSync(join(migrations, ".tmp-editor"), { recursive: true });

    expect(readExpectedMigrations(migrations)).toEqual([
      "20260101120000_init",
    ]);
  });

  it("resolves the real repo migrations directory from this module's location", () => {
    // Sanity check that the guard is LIVE in a local checkout rather than
    // silently degrading to "unknown" every boot.
    const resolved = resolveMigrationsDir();
    expect(resolved).not.toBeNull();
    expect(readExpectedMigrations(resolved).length).toBeGreaterThan(0);
  });
});
