import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RECHECK_INTERVAL_MS } from "@th/adapters/infra/migration-drift";

/**
 * Jobs-side wiring of the migration-drift guard.
 *
 * The check itself is unit-tested in
 * `packages/adapters/src/infra/__tests__/migration-drift.test.ts`. What is
 * covered here is what jobs does with the verdict:
 *
 *  - `/health` → 503 only on confirmed + ENFORCED drift, `{ status: "ok" }`
 *    otherwise (shape preserved).
 *  - `POST /jobs/:name` → short-circuits BEFORE the handler, the run tracker,
 *    the DLQ and the lifecycle alerts. This is the path that produced ~208 of
 *    the ~220 events in Sentry HEARTH-FIRE-WEB-17.
 *  - every indeterminate outcome resolves to fully healthy + running.
 *
 * No database: the container's `prisma` is a fake whose `$queryRaw` returns the
 * applied-migration rows (or throws) for each scenario.
 */

const buildContainerMock = vi.fn();
const getJobMock = vi.fn();
const fireDiscordAlertMock = vi.fn(async () => undefined);
const captureExceptionMock = vi.fn((_err: unknown, _ctx?: unknown) => "evt_1");

vi.mock("../lib/container", () => ({
  buildContainer: buildContainerMock,
}));

vi.mock("../jobs", () => ({
  allJobs: [],
  getJob: getJobMock,
}));

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: fireDiscordAlertMock,
  buildCloudLoggingUrl: () => null,
}));

vi.mock("../instrument", () => ({
  Sentry: { captureException: captureExceptionMock },
}));

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
    debug: vi.fn(),
  };
  return logger;
}

function makeTracker() {
  return {
    isEnabled: vi.fn(async () => true),
    setEnabled: vi.fn(async () => undefined),
    latestAll: vi.fn(async () => new Map()),
    pruneRuns: vi.fn(async () => 0),
    runs: vi.fn(async () => []),
    record: vi.fn(async () => undefined),
  };
}

/** Fake Prisma: applies the `finished_at IS NOT NULL` predicate itself. */
function makeFakePrisma(
  rows: { migration_name: string; finished_at: Date | null }[],
  options: { throws?: unknown } = {},
) {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (options.throws) throw options.throws;
      const sql = strings.join("");
      const onlyFinished = /finished_at\s+is\s+not\s+null/i.test(sql);
      return rows
        .filter((row) => (onlyFinished ? row.finished_at !== null : true))
        .map((row) => ({ migration_name: row.migration_name }));
    },
  };
}

function makeJob() {
  return {
    name: "demo.job",
    notify: true,
    input: { parse: vi.fn((input: unknown) => input ?? {}) },
    handler: vi.fn(async () => ({ ok: true })),
  };
}

const APPLIED = [
  { migration_name: "20260101120000_init", finished_at: new Date() },
];

async function makeApp(
  options: {
    prisma?: unknown;
    /** Cloud Run posture — drives shouldBlockOnDrift(). */
    deployed?: boolean;
  } = {},
) {
  const logger = makeLogger();
  const tracker = makeTracker();
  const dlq = { pushToDLQ: vi.fn(async () => undefined) };
  const job = makeJob();

  if (options.deployed) process.env.K_SERVICE = "hf-prod-jobs";
  else delete process.env.K_SERVICE;

  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: tracker,
    diagnostics: dlq,
    env: {},
    // `"prisma" in options` (not `??`) so a test can explicitly pass
    // `undefined` to model a container that exposes no client at all.
    prisma: "prisma" in options ? options.prisma : makeFakePrisma(APPLIED),
    reportError: captureExceptionMock,
    close: vi.fn(async () => undefined),
  });
  getJobMock.mockReturnValue(job);

  const { createApp } = await import("../app");
  const { app } = await createApp();

  return { app, job, logger, tracker, dlq };
}

/**
 * Two migrations are on disk that the fake database has never applied. The
 * expected list comes from the REAL repo migrations directory, so this also
 * proves resolveMigrationsDir() finds it from the jobs package.
 */
const DRIFTED_DB = makeFakePrisma(APPLIED);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.K_SERVICE;
  delete process.env.PRISMA_MIGRATIONS_DIR;
  delete process.env.MIGRATION_DRIFT_ENFORCE;
});

describe("jobs /health with migration drift", () => {
  it("returns 200 {status:'ok'} — shape preserved — when the schema is current", async () => {
    // Point the expected-migrations list at a directory containing exactly the
    // one migration the fake DB reports as applied: genuinely undrifted, and
    // deployed (K_SERVICE set) so enforcement is ON.
    const dir = mkdtempSync(join(tmpdir(), "jobs-drift-"));
    mkdirSync(join(dir, "20260101120000_init"), { recursive: true });
    writeFileSync(join(dir, "20260101120000_init", "migration.sql"), "SELECT 1;\n");
    process.env.PRISMA_MIGRATIONS_DIR = dir;

    try {
      const { app } = await makeApp({
        deployed: true,
        prisma: makeFakePrisma(APPLIED),
      });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 503 naming the pending migrations when deployed and drifted", async () => {
    const { app } = await makeApp({ deployed: true, prisma: DRIFTED_DB });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error).toBe("migration_drift");
    expect(body.pendingMigrations.length).toBeGreaterThan(0);
    expect(body.message).toContain("pnpm db:migrate:deploy");
    await app.close();
  });

  it("stays 200 {status:'ok'} on a dev laptop even when drifted", async () => {
    // scripts/human-dev.cjs:170 gates the local stack on this endpoint
    // returning 200-399 and hard-exits after 60s.
    const { app } = await makeApp({ deployed: false, prisma: DRIFTED_DB });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("jobs POST /jobs/:name short-circuit", () => {
  it("blocks the run with 503 + Retry-After and never invokes the handler", async () => {
    const { app, job, logger, tracker, dlq } = await makeApp({
      deployed: true,
      prisma: DRIFTED_DB,
    });

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("300");

    const body = response.json();
    expect(body).toMatchObject({
      success: false,
      error: "migration_drift",
      job: "demo.job",
    });
    expect(body.pendingMigrations.length).toBeGreaterThan(0);
    expect(body.message).toContain("migration_drift_detected");

    // The whole point: the handler never touches the stale schema.
    expect(job.handler).not.toHaveBeenCalled();
    // A blocked run is not a run — no RunEntry, no DLQ entry, no lifecycle
    // alerts (the job is notify:true, so an alert would have fired).
    expect(tracker.record).not.toHaveBeenCalled();
    expect(dlq.pushToDLQ).not.toHaveBeenCalled();
    expect(fireDiscordAlertMock).not.toHaveBeenCalled();

    expect(logger.error).toHaveBeenCalledWith(
      "job_blocked_migration_drift",
      expect.objectContaining({
        job: "demo.job",
        hint: expect.stringContaining("pnpm db:migrate:deploy"),
      }),
    );
    await app.close();
  });

  it("is not overridable with ?force=true (force is for disabled jobs)", async () => {
    const { app, job } = await makeApp({ deployed: true, prisma: DRIFTED_DB });

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job?force=true",
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(job.handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("still 404s an unknown job without consulting the drift verdict", async () => {
    const { app } = await makeApp({ deployed: true, prisma: DRIFTED_DB });
    getJobMock.mockReturnValue(undefined);

    const response = await app.inject({
      method: "POST",
      url: "/jobs/nope.job",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "job_not_found" });
    await app.close();
  });

  it("reports to Sentry ONCE per process, not once per cron tick", async () => {
    const { app } = await makeApp({ deployed: true, prisma: DRIFTED_DB });

    // The boot check reports once; the run-route latch must add exactly one
    // more no matter how many ticks arrive. Anything else recreates the
    // 208-events-in-one-issue flood.
    const afterBoot = captureExceptionMock.mock.calls.length;

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        payload: {},
      });
      expect(response.statusCode).toBe(503);
    }

    expect(captureExceptionMock.mock.calls.length - afterBoot).toBe(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("migration_drift_detected"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          check: "migration_drift",
          phase: "job_blocked",
        }),
      }),
    );
    await app.close();
  });

  it("blocks over real HTTP too (not just app.inject)", async () => {
    // Binds a real socket on an ephemeral port and drives it with fetch, so the
    // status line, the Retry-After header and the JSON body are verified as
    // Cloud Scheduler would actually receive them.
    const { app, job } = await makeApp({ deployed: true, prisma: DRIFTED_DB });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${port}/jobs/demo.job`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("300");
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("migration_drift");
      expect(body.message).toContain("pnpm db:migrate:deploy");
      expect(job.handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("MIGRATION_DRIFT_ENFORCE=false lets jobs keep running during an incident", async () => {
    // Break-glass. With a startup probe on /health a drifted revision never
    // becomes Ready, halting settlements/payout crons and blocking the deploy
    // pipeline's own `skip-migrate` path. Detection stays on; blocking stops.
    process.env.MIGRATION_DRIFT_ENFORCE = "false";

    const { app, job, logger } = await makeApp({
      deployed: true,
      prisma: DRIFTED_DB,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const run = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(job.handler).toHaveBeenCalled();

    // ...but the guard is NOT blind, and says so loudly.
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_enforcement_disabled",
      expect.objectContaining({ err: expect.any(Error) }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "migration_drift_detected",
      expect.objectContaining({ enforcementOverride: "forced_off" }),
    );
    await app.close();
  });

  it("does NOT block on a dev laptop even when drifted", async () => {
    const { app, job } = await makeApp({ deployed: false, prisma: DRIFTED_DB });

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });
    expect(job.handler).toHaveBeenCalled();
    await app.close();
  });
});

describe("jobs recovers when migrations land after boot (prod deploy #583)", () => {
  /**
   * Terraform creates the jobs revision while migrate_db is still running (the
   * two cannot be ordered — terraform provisions the secret migrate_db reads).
   * The container boots mid-migration, sees drift, and must NOT replay that
   * stale verdict for its whole startup budget.
   */
  it("stops 503ing on /health and starts running jobs once the DB catches up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-drift-"));
    for (const name of ["20260101120000_init", "20260102120000_late"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "migration.sql"), "SELECT 1;\n");
    }
    process.env.PRISMA_MIGRATIONS_DIR = dir;

    // Mutable: models migrate_db finishing while the probes are running.
    const applied = [{ migration_name: "20260101120000_init" }];
    const prisma = {
      $queryRaw: async () => applied.map((row) => ({ ...row })),
    };

    try {
      const { app, job } = await makeApp({ deployed: true, prisma });

      // Probe 1 — mid-migration. The revision correctly refuses.
      const first = await app.inject({ method: "GET", url: "/health" });
      expect(first.statusCode).toBe(503);
      const blocked = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        payload: {},
      });
      expect(blocked.statusCode).toBe(503);
      expect(job.handler).not.toHaveBeenCalled();

      // migrate_db completes.
      applied.push({ migration_name: "20260102120000_late" });

      // Wait past the re-check interval, then probe again — this is the step
      // that failed in #583, where all 48 probes replayed the boot verdict.
      await new Promise((r) => setTimeout(r, DEFAULT_RECHECK_INTERVAL_MS + 50));

      const recovered = await app.inject({ method: "GET", url: "/health" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({ status: "ok" });

      const run = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        payload: {},
      });
      expect(run.statusCode).toBe(200);
      expect(job.handler).toHaveBeenCalled();
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("jobs migration-drift fail-safe (indeterminate outcomes never block)", () => {
  const indeterminate: [string, () => unknown][] = [
    [
      "_prisma_migrations table missing (fresh/bootstrap DB)",
      () =>
        makeFakePrisma([], {
          throws: Object.assign(
            new Error('relation "_prisma_migrations" does not exist'),
            { code: "42P01" },
          ),
        }),
    ],
    [
      "database unreachable",
      () =>
        makeFakePrisma([], {
          throws: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          }),
        }),
    ],
    [
      "container exposes no prisma at all",
      () => undefined,
    ],
  ];

  for (const [label, makePrisma] of indeterminate) {
    it(`stays healthy AND keeps running jobs when ${label}`, async () => {
      const { app, job } = await makeApp({
        deployed: true,
        prisma: makePrisma(),
      });

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });

      const run = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        payload: {},
      });
      expect(run.statusCode).toBe(200);
      expect(job.handler).toHaveBeenCalled();
      await app.close();
    });
  }

  it("stays healthy AND keeps running jobs when the migrations dir is absent", async () => {
    process.env.PRISMA_MIGRATIONS_DIR = "/nonexistent/migrations";
    const { app, job } = await makeApp({
      deployed: true,
      prisma: makeFakePrisma(APPLIED),
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const run = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(job.handler).toHaveBeenCalled();
    await app.close();
  });
});
