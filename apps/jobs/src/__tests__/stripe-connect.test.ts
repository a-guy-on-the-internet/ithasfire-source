import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the full job registry (to assert this job is actually wired in)
// pulls `lib/env.ts`, which parses `process.env` at module load. `vi.hoisted`
// runs before the hoisted imports, so this has to be here rather than in a
// `beforeAll`.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
});

// The use case is mocked, but the input SCHEMA must stay real: the job reuses
// it as its own `input`, and `job.input.parse` is what the bounds test asserts.
vi.mock("@th/core/use-cases/stripe-connect", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@th/core/use-cases/stripe-connect")>();
  return { ...actual, reconcileConnectAccounts: vi.fn() };
});

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  // No GCP project in the test env — the helper returns null and the alert
  // payload omits the Logs field, matching unconfigured environments.
  buildCloudLoggingUrl: vi.fn(() => null),
}));

import { reconcileConnectAccounts } from "@th/core/use-cases/stripe-connect";

import { stripeConnectJobs } from "../jobs/stripe-connect";
import { allJobs } from "../jobs";
import { fireDiscordAlert } from "../lib/discord-alerts";
import manifest from "../../jobs.manifest.json";

const JOB_NAME = "stripe-connect.reconcile-capabilities";

function buildLogger() {
  const logger = {
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

function buildCtx(logger = buildLogger()) {
  return {
    ctx: {
      repos: {},
      payments: {},
      clock: { now: () => new Date("2026-08-06T22:00:00.000Z") },
      logger,
      reportError: vi.fn(),
      forceConnectCapabilities: false,
      runId: "run-1",
    } as never,
    logger,
  };
}

const CLEAN = {
  listed: 10,
  scanned: 10,
  unchanged: 10,
  drifted: 0,
  healedToPayable: 0,
  demotedFromPayable: 0,
  failed: 0,
  skipped: 0,
  truncated: false,
  restrictedWithAccount: 0,
};

const INPUT = {
  limit: 200,
  maxDurationMs: 120_000,
  perAccountTimeoutMs: 20_000,
};

const job = stripeConnectJobs.find((j) => j.name === JOB_NAME)!;

beforeEach(() => {
  vi.mocked(reconcileConnectAccounts).mockReset();
  vi.mocked(fireDiscordAlert).mockClear();
});

describe("stripe-connect.reconcile-capabilities", () => {
  it("is registered in the job registry AND the manifest", () => {
    // Both halves matter: a job missing from the registry never runs, and one
    // missing from the manifest gets no Cloud Scheduler entry (Terraform reads
    // the same file), so it would only ever run if triggered by hand.
    expect(allJobs.some((j) => j.name === JOB_NAME)).toBe(true);
    expect(
      (manifest.scheduled as Record<string, unknown>)[JOB_NAME],
    ).toBeDefined();
  });

  it("runs before the nightly payout batch", () => {
    // A payee healed by the reconcile should be payable in the SAME night, not
    // the next one. If someone moves either cron, this fails loudly.
    const scheduled = manifest.scheduled as Record<
      string,
      { cron: string; timezone: string }
    >;
    const reconcile = scheduled[JOB_NAME]!;
    const batch = scheduled["settlements.run-batch"]!;

    expect(reconcile.timezone).toBe(batch.timezone);
    // The real invariant is the forward gap, not "later hour number" — that
    // form passes for batch 04:00 / reconcile 05:00, which is the exact
    // regression this is supposed to catch. Minutes count too.
    const mins = (cron: string) => {
      const [m, h] = cron.split(" ");
      return Number(h) * 60 + Number(m);
    };
    const gap = (mins(batch.cron) - mins(reconcile.cron) + 1440) % 1440;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(4 * 60);
  });

  it("passes the limit through and threads the dev capability override", async () => {
    vi.mocked(reconcileConnectAccounts).mockResolvedValue(CLEAN);
    const { ctx } = buildCtx();

    await job.handler({ input: { ...INPUT, limit: 75 }, ctx });

    expect(reconcileConnectAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ forceConnectCapabilities: false }),
      { ...INPUT, limit: 75 },
    );
  });

  it("stays quiet on a clean run", async () => {
    vi.mocked(reconcileConnectAccounts).mockResolvedValue(CLEAN);
    const { ctx, logger } = buildCtx();

    await job.handler({ input: INPUT, ctx });

    expect(fireDiscordAlert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("alerts when it healed a payee that was blocked from publishing", async () => {
    // This is the incident, caught by the backstop. A successful run is NOT
    // "resolved" — it means an account.updated was lost and the webhook
    // endpoint is what needs looking at.
    vi.mocked(reconcileConnectAccounts).mockResolvedValue({
      ...CLEAN,
      unchanged: 8,
      drifted: 2,
      healedToPayable: 2,
    });
    const { ctx } = buildCtx();

    await job.handler({ input: INPUT, ctx });

    expect(fireDiscordAlert).toHaveBeenCalledOnce();
    const payload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0] as {
      title: string;
      colour: string;
      fields: Array<{ name: string; value: string }>;
    };
    expect(payload.title).toContain("lost webhook");
    expect(payload.colour).toBe("error");
    expect(
      payload.fields.find((f) => f.name === "Healed (now payable)")?.value,
    ).toBe("2");
  });

  it("says so in the alert when the run was truncated", async () => {
    // "Scanned: 200" on a run that reached 60 reads as full coverage. On the
    // one alert an operator acts on, that's the wrong impression to give.
    vi.mocked(reconcileConnectAccounts).mockResolvedValue({
      ...CLEAN,
      listed: 200,
      scanned: 60,
      unchanged: 58,
      drifted: 2,
      healedToPayable: 2,
      truncated: true,
    });
    const { ctx } = buildCtx();

    await job.handler({ input: INPUT, ctx });

    const payload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0] as {
      fields: Array<{ name: string; value: string }>;
    };
    expect(payload.fields.find((f) => f.name === "Scanned")?.value).toBe(
      "60 of 200 (run truncated)",
    );
  });

  it("alerts on a demotion — those payees get skipped in 100 minutes", async () => {
    // This used to be deliberately silent ("fails safe, publish refuses"),
    // which was wrong for money already owed: run-batch skips them at the
    // eligibility gate, so the payout is DELAYED until someone fixes the
    // capability. Nothing is lost (the credits stay on the ledger), which is
    // exactly what the alert copy has to say now.
    vi.mocked(reconcileConnectAccounts).mockResolvedValue({
      ...CLEAN,
      unchanged: 9,
      drifted: 1,
      healedToPayable: 0,
      demotedFromPayable: 1,
    });
    const { ctx } = buildCtx();

    await job.handler({ input: INPUT, ctx });

    expect(fireDiscordAlert).toHaveBeenCalledOnce();
    const payload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0] as {
      title: string;
      description: string;
      fields: Array<{ name: string; value: string }>;
    };
    expect(payload.title).toMatch(/payouts will be skipped/i);
    // The operator needs the remedy named, not just the symptom — and the
    // remedy is now "fix the capability", never a settlement reset.
    expect(payload.description).toContain("fix the capability in Stripe");
    expect(payload.description).not.toContain("resetFailed");
    expect(payload.fields.find((f) => /demoted/i.test(f.name))?.value).toBe(
      "1",
    );
  });

  it("fires BOTH alerts when one run heals one payee and demotes another", async () => {
    // The two branches must not be if/else — different responders, different
    // clocks. Only one would survive a mutually-exclusive structure.
    vi.mocked(reconcileConnectAccounts).mockResolvedValue({
      ...CLEAN,
      unchanged: 8,
      drifted: 2,
      healedToPayable: 1,
      demotedFromPayable: 1,
    });
    const { ctx } = buildCtx();

    await job.handler({ input: INPUT, ctx });

    expect(fireDiscordAlert).toHaveBeenCalledTimes(2);
    const titles = vi
      .mocked(fireDiscordAlert)
      .mock.calls.map((c) => (c[0] as { title: string }).title);
    expect(titles).toEqual([
      expect.stringMatching(/lost webhook/i),
      expect.stringMatching(/payouts will be skipped/i),
    ]);
  });

  it("rejects an out-of-range limit before doing any work", async () => {
    expect(() => job.input.parse({ limit: 5000 })).toThrow();
    expect(job.input.parse({})).toEqual(INPUT);
  });

  it("awaits the alert rather than firing it into a throttled instance", async () => {
    // Cloud Run throttles CPU once the response is written, so a `void`ed
    // Discord POST / Sentry flush can simply never complete. Asserting the
    // call was MADE (as a naive test does) cannot tell the two apart — this
    // asserts the handler is still pending until the alert resolves.
    vi.mocked(reconcileConnectAccounts).mockResolvedValue({
      ...CLEAN,
      drifted: 1,
      healedToPayable: 1,
    });
    let released!: () => void;
    vi.mocked(fireDiscordAlert).mockImplementationOnce(
      () => new Promise<void>((resolve) => (released = resolve)),
    );
    const { ctx } = buildCtx();

    let settled = false;
    const running = job.handler({ input: INPUT, ctx }).then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // still waiting on the alert

    released();
    await running;
    expect(settled).toBe(true);
  });
});
