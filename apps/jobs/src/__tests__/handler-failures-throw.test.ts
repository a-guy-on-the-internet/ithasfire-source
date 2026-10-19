/**
 * A handler whose work FAILED must answer non-2xx.
 *
 * app.ts answers 200 `{ success: true, result }` and records a `success` run
 * for ANY value a handler returns, so a handler that catches its error and
 * returns `{ success: false }` shows as a success in the run history, pushes
 * no DLQ entry and reaches nobody. Four handlers did exactly that in a catch,
 * and the four by-id search index jobs did it with the `errors` their use
 * case hands back. A test on the handler's return value cannot see the
 * difference; only the HTTP status can, so each case drives the real handler
 * (and the real use case) through the real run route with a repository call
 * failing.
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

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";

import { createApp } from "../app";
import { eventDailyStats, resalePriceSnapshots } from "../jobs/analytics";
import { refreshRecurringDates } from "../jobs/community-recurrence";
import {
  indexEvent,
  indexHuman,
  indexOrganization,
  indexPlace,
} from "../jobs/search";
import { sitemapsGenerate } from "../jobs/sitemaps";

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

/**
 * Each case names the FIRST repository call its use case makes and nothing
 * else the handler needs before it: the batch-level failure (the database is
 * down) rather than one bad row, which the use cases isolate themselves.
 */
const CASES: Array<{
  definition: Definition;
  payload: Record<string, unknown>;
  failedLog: string;
  repos: (fail: () => Promise<never>) => Record<string, unknown>;
}> = [
  {
    definition: eventDailyStats,
    payload: {},
    failedLog: "analytics.event-daily-stats.failed",
    repos: (fail) => ({ events: { listPublished: fail } }),
  },
  {
    definition: resalePriceSnapshots,
    payload: {},
    failedLog: "analytics.resale-price-snapshots.failed",
    repos: (fail) => ({ events: { listPublished: fail } }),
  },
  {
    definition: refreshRecurringDates,
    payload: {},
    failedLog: "community.refresh-recurring-dates.failed",
    repos: (fail) => ({ events: { listRecurringEventIds: fail } }),
  },
  {
    definition: sitemapsGenerate,
    payload: { baseUrl: "https://ithasfire.com" },
    failedLog: "sitemaps.generate.failed",
    repos: (fail) => ({
      events: {
        listPublishedForSitemap: fail,
        enumerateGeoCategoryCombos: vi.fn(async () => []),
      },
      places: { listForSitemap: vi.fn(async () => []) },
      categories: {
        listActiveWithUpcomingEvents: vi.fn(async () => []),
        listCurrentSlugs: vi.fn(async () => []),
      },
    }),
  },
];

/**
 * One app over a container holding `ctx`, with `definition` as the only job,
 * and ONE run of it. The registry handle carries the REAL input schema and
 * handler.
 */
async function runJob(
  definition: Definition,
  payload: Record<string, unknown>,
  ctx: Record<string, unknown>,
) {
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
    fileStorage: { putObject: vi.fn() },
    ...ctx,
  });
  getJobMock.mockReturnValue({
    name: definition.name,
    notify: definition.notify ?? false,
    input: definition.input,
    handler: definition.handler,
    load: vi.fn(async () => definition),
  });

  const { app } = await createApp();
  // createApp's migration-drift probe reports once (this container has no
  // prisma, an INDETERMINATE outcome). Clear it so the assertions below see
  // only what the run itself reported.
  reportError.mockClear();
  captureExceptionMock.mockClear();

  const response = await app.inject({
    method: "POST",
    url: `/jobs/${definition.name}`,
    payload,
  });
  await app.close();

  return { response, logger, record, pushToDLQ, reportError };
}

async function makeFailingApp(testCase: (typeof CASES)[number], error: Error) {
  const fail = vi.fn(async (): Promise<never> => {
    throw error;
  });
  const run = await runJob(testCase.definition, testCase.payload, {
    repos: testCase.repos(fail),
  });
  return { ...run, fail };
}

describe("a handler whose work failed answers non-2xx, not 200 { success: false }", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GCP_PROJECT_ID;
  });

  describe.each(CASES)("$definition.name", (testCase) => {
    const name = testCase.definition.name;

    it("500s when its first query throws, and the run is recorded, dead-lettered and reported once", async () => {
      const dbDown = new Error("connect ECONNREFUSED ::1:5432");
      const { response, fail, logger, record, pushToDLQ, reportError } =
        await makeFailingApp(testCase, dbDown);

      // The status is the whole point: a 200 here is the bug.
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: "internal_error" });
      expect(response.json()).not.toHaveProperty("success");

      // It failed where the case says it does, and the handler's own log
      // line is still written.
      expect(fail).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(testCase.failedLog, {
        error: dbDown.message,
      });

      // What a failed run means in app.ts: an `error` row in the run
      // history and a DLQ entry.
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({
        jobName: name,
        status: "error",
        errorMessage: dbDown.message,
      });
      expect(pushToDLQ).toHaveBeenCalledTimes(1);
      expect(pushToDLQ.mock.calls[0]![0]).toMatchObject({
        ref: { queue: name },
        error: { message: dbDown.message },
      });

      // Reported ONCE, by the run route's catch, with the original error.
      // The handler adds no report of its own (that would double-count).
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock.mock.calls[0]![0]).toBe(dbDown);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("400s with the code when the thrown error carries one (a Prisma P-code)", async () => {
      // The original error is rethrown as-is, so its `code` survives and the
      // route answers the way it does for any coded error. Still a failure.
      const unreachable = Object.assign(
        new Error("Can't reach database server"),
        { code: "P1001" },
      );
      const { response, record, pushToDLQ, reportError } =
        await makeFailingApp(testCase, unreachable);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "P1001",
        message: unreachable.message,
      });
      expect(record.mock.calls[0]![0]).toMatchObject({
        jobName: name,
        status: "error",
        errorCode: "P1001",
      });
      expect(pushToDLQ).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});

/**
 * A handler that throws a ZodError from its OWN work, as opposed to the run
 * route's parse of the request body. `sitemaps.generate` can: its use cases
 * end in an output-schema `.parse`, and a published event with no slug fails
 * that parse.
 *
 * This pins what the run route does with it TODAY, which is to treat it like
 * a bad request body: 400 `invalid_input`. It is still a failed run (an
 * `error` row, a DLQ entry), which is all this asserts. Whether such an error
 * is also reported to Sentry is the run route's business and is deliberately
 * not asserted here.
 */
describe("a ZodError thrown by the handler's own work (not by the request body)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GCP_PROJECT_ID;
  });

  it("sitemaps.generate: 400 invalid_input today, recorded as an error run and dead-lettered", async () => {
    const { response, logger, record, pushToDLQ } = await runJob(
      sitemapsGenerate,
      // A VALID request body: the input parse passes.
      { baseUrl: "https://ithasfire.com" },
      {
        repos: {
          events: {
            // The output schema of listEventSitemapEntries wants a string.
            listPublishedForSitemap: vi.fn(async () => [
              { slug: null, updatedAt: null },
            ]),
            enumerateGeoCategoryCombos: vi.fn(async () => []),
          },
          places: { listForSitemap: vi.fn(async () => []) },
          categories: {
            listActiveWithUpcomingEvents: vi.fn(async () => []),
            listCurrentSlugs: vi.fn(async () => []),
          },
        },
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_input" });
    expect(response.json().details).toEqual([
      expect.objectContaining({ path: [0, "slug"] }),
    ]);

    // It came out of the handler's catch, not the input parse.
    expect(logger.error).toHaveBeenCalledWith(
      "sitemaps.generate.failed",
      expect.anything(),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      jobName: "sitemaps.generate",
      status: "error",
    });
    expect(pushToDLQ).toHaveBeenCalledTimes(1);
    expect(pushToDLQ.mock.calls[0]![0]).toMatchObject({
      ref: { queue: "sitemaps.generate" },
    });
  });
});

/**
 * search.index-event / -human / -place / -organization are each asked for ONE
 * document. `buildSearchIndex` returns a by-id failure in `result.errors` and
 * reports nothing, and the handlers used to pass that on as
 * `{ success: false, result }` with a 200. Each row fails the first per-id
 * read its indexer makes.
 */
const AN_ID = "11111111-1111-4111-8111-111111111111";

const INDEX_CASES: Array<{
  definition: Definition;
  payload: Record<string, string>;
  failedLog: string;
  repos: (read: () => Promise<unknown>) => Record<string, unknown>;
}> = [
  {
    definition: indexEvent,
    payload: { eventId: AN_ID },
    failedLog: "search.index_event_failed",
    repos: (read) => ({ events: { getById: read } }),
  },
  {
    definition: indexHuman,
    payload: { humanId: AN_ID },
    failedLog: "search.index_human_failed",
    repos: (read) => ({ humans: { getByIdWithIdentity: read } }),
  },
  {
    definition: indexPlace,
    payload: { placeId: AN_ID },
    failedLog: "search.index_place_failed",
    repos: (read) => ({ places: { getById: read } }),
  },
  {
    definition: indexOrganization,
    payload: { organizationId: AN_ID },
    failedLog: "search.index_organization_failed",
    repos: (read) => ({ organizations: { getById: read } }),
  },
];

/** A search backend that is up and accepts everything. */
function makeSearch() {
  return {
    ensureIndexes: vi.fn(async () => ({ ok: true, value: undefined })),
    upsertDocuments: vi.fn(async () => ({ ok: true, value: { indexed: 0 } })),
    deleteDocuments: vi.fn(async () => ({ ok: true, value: undefined })),
  };
}

describe("a by-id search index job whose one document failed answers non-2xx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GCP_PROJECT_ID;
  });

  describe.each(INDEX_CASES)("$definition.name", (testCase) => {
    const name = testCase.definition.name;

    it("500s when the document's read fails, and the run is recorded, dead-lettered and reported once", async () => {
      const read = vi.fn(async (): Promise<never> => {
        throw new Error("connect ECONNREFUSED ::1:5432");
      });
      const { response, logger, record, pushToDLQ, reportError } =
        await runJob(testCase.definition, testCase.payload, {
          multiSearch: makeSearch(),
          repos: withSearchIndexFence(testCase.repos(read)),
        });

      // The status is the whole point: a 200 here is the bug.
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: "internal_error" });
      expect(response.json()).not.toHaveProperty("success");
      expect(read).toHaveBeenCalledWith(AN_ID);

      // The id and counts, and nothing else.
      expect(logger.error).toHaveBeenCalledWith(testCase.failedLog, {
        ...testCase.payload,
        indexed: 0,
        errors: 1,
      });

      const message = `${name}: 1 document(s) failed to index: connect ECONNREFUSED ::1:5432`;
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({
        jobName: name,
        status: "error",
        errorMessage: message,
      });
      expect(pushToDLQ).toHaveBeenCalledTimes(1);
      expect(pushToDLQ.mock.calls[0]![0]).toMatchObject({
        ref: { queue: name },
        payload: testCase.payload,
        error: { message },
      });

      // Reported ONCE, by the run route's catch; the handler adds none.
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(
        (captureExceptionMock.mock.calls[0]![0] as Error).message,
      ).toBe(message);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("still answers 200 { success: true } when nothing failed (the row is gone: nothing to index)", async () => {
      const read = vi.fn(async () => null);
      const { response, record, pushToDLQ } = await runJob(
        testCase.definition,
        testCase.payload,
        {
          multiSearch: makeSearch(),
          repos: withSearchIndexFence(testCase.repos(read)),
        },
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().result).toMatchObject({
        success: true,
        result: { errors: [] },
      });
      expect(record.mock.calls[0]![0]).toMatchObject({ status: "success" });
      expect(pushToDLQ).not.toHaveBeenCalled();
    });
  });
});
