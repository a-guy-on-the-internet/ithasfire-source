import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot-memory regression test.
 *
 * `GET /jobs` and `GET /jobs/status` are metadata reads. If either one ever
 * touches a handler, listing jobs drags in that job's whole transitive graph —
 * use cases, adapters, the Prisma client, the Stripe SDK — which is exactly
 * the shape of the eager registry that OOMed the dev service at boot
 * (revision hf-dev-jobs-00027-f8h, Mark-Compact pinned at 249.3 MB, exit 134).
 *
 * Every module loader is wrapped in a spy around the REAL loader, so this
 * asserts the honest thing: the endpoints answer with zero imports, and
 * dispatching one job imports exactly one module.
 */

const buildContainerMock = vi.fn();
const loaderSpies = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock("../lib/container", () => ({
  buildContainer: buildContainerMock,
}));

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));

vi.mock("../instrument", () => ({
  Sentry: { captureException: vi.fn(() => "evt_1") },
}));

vi.mock("../jobs/modules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../jobs/modules")>();

  const wrapped: Record<string, () => Promise<unknown>> = {};
  for (const id of actual.JOB_MODULE_IDS) {
    const spy = vi.fn(() =>
      actual.JOB_MODULE_LOADERS[id as keyof typeof actual.JOB_MODULE_LOADERS](),
    );
    loaderSpies.set(id, spy);
    wrapped[id] = spy;
  }

  return { ...actual, JOB_MODULE_LOADERS: wrapped };
});

function makeLogger() {
  const logger = {
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
    isEnabled: vi.fn(async (_name: string) => true),
    setEnabled: vi.fn(async () => undefined),
    latestAll: vi.fn(async () => new Map()),
    pruneRuns: vi.fn(async () => 0),
    runs: vi.fn(async () => []),
    record: vi.fn(async () => undefined),
  };
}

async function makeApp(overrides: { runTracker?: ReturnType<typeof makeTracker> } = {}) {
  buildContainerMock.mockResolvedValue({
    logger: makeLogger(),
    runTracker: overrides.runTracker ?? makeTracker(),
    diagnostics: null,
    env: {},
    close: vi.fn(async () => undefined),
  });

  const { createApp } = await import("../app");
  return await createApp();
}

function loadedModules(): string[] {
  return [...loaderSpies.entries()]
    .filter(([, spy]) => spy.mock.calls.length > 0)
    .map(([id]) => id);
}

describe("metadata endpoints never load a handler", () => {
  beforeEach(() => {
    for (const spy of loaderSpies.values()) spy.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("GET /jobs answers for every job without importing one", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/jobs" });

    expect(response.statusCode).toBe(200);
    const { jobs } = response.json() as {
      jobs: Array<{
        name: string;
        description: string | null;
        scheduled: boolean;
        schedule: { cron: string } | null;
        enabled: boolean;
      }>;
    };

    expect(jobs.length).toBeGreaterThan(40);
    // A real, fully-populated row — not just a list of names.
    expect(jobs).toContainEqual(
      expect.objectContaining({
        name: "settlements.run-batch",
        scheduled: true,
        enabled: true,
        schedule: expect.objectContaining({ cron: expect.any(String) }),
      }),
    );
    expect(loadedModules()).toEqual([]);

    await app.close();
  });

  it("GET /jobs/status answers for every job without importing one", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/jobs/status" });

    expect(response.statusCode).toBe(200);
    const { jobs } = response.json() as { jobs: Array<{ name: string }> };
    expect(jobs.length).toBeGreaterThan(40);
    expect(loadedModules()).toEqual([]);

    await app.close();
  });

  it("GET /jobs/status reports the settlement batch at midnight CENTRAL", async () => {
    // End-to-end through the real route + the real manifest, because this is
    // the exact payload `platformJobs.listStatus` proxies to /platform/jobs and
    // to the /platform/settlements payout clock. Formatting the returned
    // instant back into America/Chicago with Intl (NOT luxon) keeps the
    // assertion independent of the library the implementation uses.
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/jobs/status" });
    const { jobs } = response.json() as {
      jobs: Array<{
        name: string;
        schedule: {
          cron: string;
          timezone: string;
          cronDescription: string;
          nextRun: string | null;
        } | null;
      }>;
    };

    const batch = jobs.find((j) => j.name === "settlements.run-batch");
    expect(batch?.schedule).toMatchObject({
      cron: "0 0 * * *",
      timezone: "America/Chicago",
      cronDescription: "Daily at 00:00 America/Chicago",
    });

    const nextRun = batch?.schedule?.nextRun;
    expect(nextRun).toBeTruthy();
    // Clock-independent: whenever this runs, the answer must be midnight in
    // Central — which on a UTC server is NOT midnight UTC.
    const centralWallClock = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nextRun!));
    expect(centralWallClock).toBe("00:00");
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());

    await app.close();
  });

  it("GET /jobs/status reports a RUNTIME pause as the top-level `enabled`, separate from the manifest schedule", async () => {
    // Staff pause a job from /platform/jobs (`platformJobs.toggleEnabled` →
    // `tracker.setEnabled`); the runner honours it as `job_skipped_disabled`.
    // The /platform/settlements payout clock reads THIS field to say the batch
    // is paused — `schedule.enabled` is the manifest default and stays true —
    // so the two must land in different places in the payload, and reading
    // the pause must cost no handler imports either.
    const runTracker = makeTracker();
    runTracker.isEnabled.mockImplementation(
      async (name: string) => name !== "settlements.run-batch",
    );
    const { app } = await makeApp({ runTracker });

    const response = await app.inject({ method: "GET", url: "/jobs/status" });

    expect(response.statusCode).toBe(200);
    const { jobs } = response.json() as {
      jobs: Array<{
        name: string;
        enabled: boolean;
        schedule: { enabled: boolean } | null;
      }>;
    };

    const batch = jobs.find((j) => j.name === "settlements.run-batch");
    expect(batch?.enabled).toBe(false);
    expect(batch?.schedule?.enabled).toBe(true);
    // Only the paused job reads paused.
    expect(jobs.filter((j) => j.enabled === false).map((j) => j.name)).toEqual([
      "settlements.run-batch",
    ]);
    expect(loadedModules()).toEqual([]);

    await app.close();
  });

  it("a 404 for an unknown job costs no imports either", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/jobs/does.not.exist",
    });

    expect(response.statusCode).toBe(404);
    expect(loadedModules()).toEqual([]);

    await app.close();
  });

  it("resolving one job imports that job's module and nothing else", async () => {
    const { getJob } = await import("../jobs");
    const { resetJobRegistryCaches } = await import("../jobs/registry");
    resetJobRegistryCaches();

    const handle = getJob("settlements.run-batch");
    expect(handle).toBeDefined();
    expect(loadedModules()).toEqual([]);

    const definition = await handle!.load();

    expect(definition.name).toBe("settlements.run-batch");
    expect(typeof definition.handler).toBe("function");
    expect(loadedModules()).toEqual(["settlements"]);
  });
});
