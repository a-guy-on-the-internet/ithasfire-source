/**
 * A handler that SKIPS because a dependency is not configured keeps its 200
 * and its return shape (dev turns search, the mailer and Stripe off on
 * purpose; `classifyRerunResponse` in lib/dlq-rerun.ts reads these shapes),
 * and reports to Sentry ONCE per process through
 * lib/report-not-configured.ts, because the warn/info line it logs reaches
 * nobody.
 *
 * Driven through the real run route: "200, shape unchanged, one report across
 * two runs" is a statement about the route plus the handler, and app.ts
 * builds a new ctx for every run, so only this level shows the latch
 * outliving a run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildContainerMock, getJobMock, captureExceptionMock } = vi.hoisted(
  () => ({
    buildContainerMock: vi.fn(),
    getJobMock: vi.fn(),
    captureExceptionMock: vi.fn((_err: unknown, _ctx?: unknown) => "evt_1"),
  }),
);

vi.mock("../lib/container", () => ({ buildContainer: buildContainerMock }));
vi.mock("../jobs", () => ({ allJobs: [], getJob: getJobMock }));
vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));
vi.mock("../instrument", () => ({
  Sentry: { captureException: captureExceptionMock },
}));

import { createApp } from "../app";
import { sendAttendeeReviewDigestsJob } from "../jobs/attendee-reviews";
import { searchJobs } from "../jobs/search";
import { backfillProcessorFeesJob } from "../jobs/settlements";
import { resetNotConfiguredReportsForTests } from "../lib/report-not-configured";

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

type Definition = {
  name: string;
  notify?: boolean;
  input: unknown;
  handler: unknown;
};

const DEFINITIONS: Definition[] = [
  ...searchJobs,
  sendAttendeeReviewDigestsJob,
  backfillProcessorFeesJob,
];

/** One app (= one process) over a container missing whatever `ctx` omits. */
async function makeApp(ctx: Record<string, unknown>) {
  const logger = makeLogger();
  const record = vi.fn(async (_entry: unknown) => undefined);
  const pushToDLQ = vi.fn(async (_entry: unknown) => undefined);
  const reportError = vi.fn();

  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: {
      isEnabled: vi.fn(async () => true),
      setEnabled: vi.fn(async () => undefined),
      latestAll: vi.fn(async () => new Map()),
      pruneRuns: vi.fn(async () => 0),
      runs: vi.fn(async () => []),
      record,
    },
    diagnostics: { pushToDLQ },
    env: {},
    close: vi.fn(async () => undefined),
    reportError,
    clock: { now: () => new Date("2026-10-10T12:00:00.000Z") },
    // No repos on purpose: a skip that touched one would throw and 500.
    ...ctx,
  });
  // Registry handles, with the REAL input schemas and handlers.
  getJobMock.mockImplementation((name: string) => {
    const definition = DEFINITIONS.find((d) => d.name === name);
    if (!definition) return undefined;
    return {
      name: definition.name,
      notify: definition.notify ?? false,
      input: definition.input,
      handler: definition.handler,
      load: vi.fn(async () => definition),
    };
  });

  const { app } = await createApp();
  // createApp's migration-drift probe reports once (this container has no
  // prisma, an INDETERMINATE outcome). Clear it so the assertions below see
  // only what the runs reported.
  reportError.mockClear();

  const run = (name: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/jobs/${name}`, payload });

  return { app, run, logger, record, pushToDLQ, reportError };
}

const notConfiguredTags = (job: string, reason: string) => ({
  tags: { area: "job-not-configured", job, reason },
});

/** Every call a logger method got for one message, arguments and all. */
const callsFor = (method: { mock: { calls: unknown[][] } }, message: string) =>
  method.mock.calls.filter(([first]) => first === message);

const SEARCH_OFF = "MultiSearchPort not configured";
const AN_ID = "11111111-1111-4111-8111-111111111111";

describe("a not-configured skip stays a 200 and reports once per process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GCP_PROJECT_ID;
    resetNotConfiguredReportsForTests();
  });

  describe("search.* without a search backend", () => {
    it("answers 200 with the unchanged skip result on both runs, and reports once", async () => {
      const { app, run, logger, record, pushToDLQ, reportError } =
        await makeApp({ multiSearch: null });

      const first = await run("search.full-reindex");
      const second = await run("search.full-reindex");

      for (const response of [first, second]) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ success: true });
        // Byte-for-byte what it returned before: lib/dlq-rerun.ts reads it.
        expect(response.json().result).toEqual({
          success: false,
          reason: "search_not_configured",
        });
      }

      // Every run still logs, with the same fields; only the report is
      // latched.
      expect(callsFor(logger.warn, "search.full_reindex_skipped")).toEqual([
        ["search.full_reindex_skipped", { reason: SEARCH_OFF }],
        ["search.full_reindex_skipped", { reason: SEARCH_OFF }],
      ]);
      expect(reportError).toHaveBeenCalledTimes(1);
      const [error, context] = reportError.mock.calls[0]!;
      expect((error as Error).message).toBe(
        "search.full-reindex: search_not_configured",
      );
      expect(context).toEqual(
        notConfiguredTags("search.full-reindex", "search_not_configured"),
      );

      // Not a failed run: the run history says `success` both times, nothing
      // is dead-lettered, and the run route's own catch never fires.
      expect(record.mock.calls.map(([entry]) => entry)).toEqual([
        expect.objectContaining({ status: "success" }),
        expect.objectContaining({ status: "success" }),
      ]);
      expect(pushToDLQ).not.toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();

      await app.close();
    });

    // One row per search handler: a site that lost its call, or named the
    // wrong job in it, fails here.
    // [job, request body, its skip log message]. The by-id jobs log the id
    // they were asked for beside the reason.
    it.each([
      ["search.index-event", { eventId: AN_ID }, "search.index_event_skipped"],
      ["search.index-human", { humanId: AN_ID }, "search.index_human_skipped"],
      ["search.index-place", { placeId: AN_ID }, "search.index_place_skipped"],
      [
        "search.index-organization",
        { organizationId: AN_ID },
        "search.index_organization_skipped",
      ],
      ["search.full-reindex", {}, "search.full_reindex_skipped"],
      ["search.ensure-format", {}, "search.ensure_format_skipped"],
      [
        "search.drain-reindex-pending",
        {},
        "search.drain_reindex_pending_skipped",
      ],
      [
        "search.reindex-scheduled-price-flips",
        {},
        "search.reindex_scheduled_price_flips_skipped",
      ],
    ] as const)("%s reports under its own job name, once", async (name, payload, skipLog) => {
      const { app, run, logger, reportError } = await makeApp({
        multiSearch: null,
      });

      const first = await run(name, payload);
      const second = await run(name, payload);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().result).toEqual({
        success: false,
        reason: "search_not_configured",
      });
      // The existing log line, fields included, on both runs.
      const logged = [skipLog, { ...payload, reason: SEARCH_OFF }];
      expect(callsFor(logger.warn, skipLog)).toEqual([logged, logged]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual(
        notConfiguredTags(name, "search_not_configured"),
      );

      await app.close();
    });

    it("each search job that skips is its own report", async () => {
      const { app, run, reportError } = await makeApp({ multiSearch: null });

      await run("search.full-reindex");
      await run("search.ensure-format");
      await run("search.full-reindex");

      expect(
        reportError.mock.calls.map(([, context]) => context.tags.job),
      ).toEqual(["search.full-reindex", "search.ensure-format"]);

      await app.close();
    });
  });

  describe("attendee-review-digests.send", () => {
    const JOB = "attendee-review-digests.send";

    it("without a mailer: 200, unchanged skip result, one report across two runs", async () => {
      const { app, run, logger, record, pushToDLQ, reportError } =
        await makeApp({
          mailer: null,
          unsubscribeSecret: "unsubscribe-secret-0123456789abcdef",
        });

      const first = await run(JOB);
      const second = await run(JOB);

      for (const response of [first, second]) {
        expect(response.statusCode).toBe(200);
        expect(response.json().result).toEqual({
          skipped: "mailer_unconfigured",
        });
      }
      // The existing log line (a bare message, no fields), on both runs.
      const skipLog = "attendee-review-digests.send.skipped_mailer_unconfigured";
      expect(callsFor(logger.warn, skipLog)).toEqual([[skipLog], [skipLog]]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual(
        notConfiguredTags(JOB, "mailer_unconfigured"),
      );
      expect(record.mock.calls.map(([entry]) => entry)).toEqual([
        expect.objectContaining({ status: "success" }),
        expect.objectContaining({ status: "success" }),
      ]);
      expect(pushToDLQ).not.toHaveBeenCalled();

      await app.close();
    });

    it("without the unsubscribe secret: 200, unchanged skip result, one report across two runs", async () => {
      const { app, run, logger, reportError } = await makeApp({
        mailer: { send: vi.fn(), sendBatch: vi.fn(), health: vi.fn() },
        unsubscribeSecret: null,
      });

      const first = await run(JOB);
      const second = await run(JOB);

      for (const response of [first, second]) {
        expect(response.statusCode).toBe(200);
        expect(response.json().result).toEqual({
          skipped: "unsubscribe_secret_unconfigured",
        });
      }
      const skipLog =
        "attendee-review-digests.send.skipped_unsubscribe_secret_unconfigured";
      expect(callsFor(logger.warn, skipLog)).toEqual([[skipLog], [skipLog]]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual(
        notConfiguredTags(JOB, "unsubscribe_secret_unconfigured"),
      );

      await app.close();
    });
  });

  describe("settlements.backfill-processor-fees without a Stripe key", () => {
    const JOB = "settlements.backfill-processor-fees";

    it("answers 200 with the unchanged skip result on both runs, and reports once", async () => {
      const { app, run, logger, record, pushToDLQ, reportError } =
        await makeApp({ paymentsConfigured: false });

      const first = await run(JOB);
      const second = await run(JOB);

      for (const response of [first, second]) {
        expect(response.statusCode).toBe(200);
        expect(response.json().result).toEqual({
          considered: 0,
          stamped: 0,
          alreadyStamped: 0,
          failed: 0,
          parked: 0,
          stampedCentsByCurrency: [],
          oldestUnstampedAt: null,
          skipped: "payments_not_configured",
        });
      }
      const skipLog = "settlements.backfill-processor-fees.skipped";
      const logged = [skipLog, { reason: "payments_not_configured" }];
      expect(callsFor(logger.info, skipLog)).toEqual([logged, logged]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual(
        notConfiguredTags(JOB, "payments_not_configured"),
      );
      expect(record.mock.calls.map(([entry]) => entry)).toEqual([
        expect.objectContaining({ status: "success" }),
        expect.objectContaining({ status: "success" }),
      ]);
      expect(pushToDLQ).not.toHaveBeenCalled();

      await app.close();
    });
  });

  it("a throwing reporter changes nothing: still 200 with the skip result", async () => {
    const { app, run, reportError } = await makeApp({ multiSearch: null });
    reportError.mockImplementation(() => {
      throw new Error("sentry transport down");
    });

    const response = await run("search.full-reindex");

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      success: false,
      reason: "search_not_configured",
    });
    expect(reportError).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
