import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { cancelEventSeries, type CancelEventSeriesDeps } from "../cancel-event-series";

// `cancelEvent` is mocked: this file pins only what the series use case
// hands it (the deps, reportError included) and how it treats a failure.
vi.mock("../../events/cancel-event", () => ({
  cancelEvent: vi.fn(),
}));
import { cancelEvent } from "../../events/cancel-event";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const OCC_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

function harness() {
  const reportError = vi.fn();
  const repos = {
    series: {
      getById: vi.fn(async () => ({
        id: SERIES_ID,
        ownerScope: "HUMAN",
        ownerId: ACTOR_ID,
      })),
      archive: vi.fn(async () => undefined),
    },
    seriesOccurrences: {
      getById: vi.fn(async () => ({
        id: OCC_ID,
        seriesId: SERIES_ID,
        eventId: EVENT_ID,
        status: "PUBLISHED",
        startsAt: new Date("2026-11-01T00:00:00.000Z"),
      })),
      markStatus: vi.fn(async () => undefined),
      listBySeriesAndStatuses: vi.fn(async () => [
        { id: OCC_ID, eventId: EVENT_ID, status: "PUBLISHED" },
      ]),
    },
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
    audit: { log: vi.fn(async () => undefined) },
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTime: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  };
  logger.child.mockReturnValue(logger);
  const idempotency = createFakeIdempotencyPort();
  const deps = {
    repos,
    logger,
    authz: {},
    payments: {},
    idempotency,
    clock: { now: () => new Date("2026-10-04T00:00:00.000Z") },
    reportError,
  } as unknown as CancelEventSeriesDeps;
  const input = {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    occurrenceId: OCC_ID,
    scope: "this_only" as const,
    clientKey: "client-key-1234",
  };
  return { deps, reportError, input, repos, logger, idempotency };
}

describe("cancelEventSeries — error reporting", () => {
  beforeEach(() => {
    vi.mocked(cancelEvent).mockReset();
  });

  it("forwards reportError to every occurrence's cancelEvent", async () => {
    const { deps, reportError, input } = harness();
    vi.mocked(cancelEvent).mockResolvedValue({
      eventId: EVENT_ID,
      status: "CANCELLED",
      refundedOrderCount: 0,
      failedRefundCount: 0,
    } as never);

    const out = await cancelEventSeries(deps, input);

    expect(out.cancelledCount).toBe(1);
    expect(vi.mocked(cancelEvent).mock.calls[0]![0]).toMatchObject({
      reportError,
    });
  });

  it("a swallowed occurrence failure is reported (tagged), the series still completes", async () => {
    const { deps, reportError, input } = harness();
    const boom = new Error("stripe_down");
    vi.mocked(cancelEvent).mockRejectedValue(boom);

    const out = await cancelEventSeries(deps, input);

    expect(out.failedEventCount).toBe(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "cancelEventSeries", stage: "cancel_occurrence" },
      extra: { seriesId: SERIES_ID, occurrenceId: OCC_ID, eventId: EVENT_ID },
    });
  });

  it("a THROWING reporter never changes the outcome", async () => {
    const { deps, reportError, input } = harness();
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    vi.mocked(cancelEvent).mockRejectedValue(new Error("stripe_down"));

    const out = await cancelEventSeries(deps, input);
    expect(out.failedEventCount).toBe(1);
  });
});

const CANCELLED_OK = {
  eventId: EVENT_ID,
  status: "CANCELLED",
  refundedOrderCount: 0,
  failedRefundCount: 0,
};
const SERIES_KEY = `series:cancel:${SERIES_ID}:${ACTOR_ID}:client-key-1234`;

describe("cancelEventSeries — deliberate swallows are error + reported", () => {
  beforeEach(() => {
    vi.mocked(cancelEvent).mockReset();
    vi.mocked(cancelEvent).mockResolvedValue(CANCELLED_OK as never);
  });

  it("a failed occurrence status flip: logger.error + report, the series still completes", async () => {
    const { deps, reportError, input, repos, logger } = harness();
    const boom = new Error("db_blip");
    repos.seriesOccurrences.markStatus.mockRejectedValueOnce(boom);

    const out = await cancelEventSeries(deps, input);

    expect(out.cancelledCount).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "cancel_series_mark_occurrence_failed",
      expect.objectContaining({ occurrenceId: OCC_ID }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "cancelEventSeries", stage: "mark_occurrence" },
      extra: { seriesId: SERIES_ID, occurrenceId: OCC_ID },
    });
  });

  it("a failed series archive (scope all): logger.error + report, the series still completes", async () => {
    const { deps, reportError, input, repos, logger } = harness();
    const boom = new Error("db_blip");
    repos.series.archive.mockRejectedValueOnce(boom);

    const out = await cancelEventSeries(deps, { ...input, scope: "all" });

    expect(out.seriesArchived).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "cancel_series_archive_failed",
      expect.objectContaining({ seriesId: SERIES_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "cancelEventSeries", stage: "archive_series" },
      extra: { seriesId: SERIES_ID },
    });
  });

  it("an occurrence already cancelled elsewhere (AppError EVENT_ALREADY_CANCELLED) is skipped, not failed or reported", async () => {
    const { deps, reportError, input } = harness();
    vi.mocked(cancelEvent).mockRejectedValueOnce(
      new AppError("EVENT_ALREADY_CANCELLED"),
    );

    const out = await cancelEventSeries(deps, input);

    expect(out.skippedCount).toBe(1);
    expect(out.failedEventCount).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("cancelEventSeries — idempotency claim on failure (lib/idempotency-claim.ts)", () => {
  beforeEach(() => {
    vi.mocked(cancelEvent).mockReset();
    vi.mocked(cancelEvent).mockResolvedValue(CANCELLED_OK as never);
  });

  it("a transient failure RELEASES the claim (owner-checked): the same-key retry proceeds immediately", async () => {
    const { deps, input, repos, idempotency } = harness();
    repos.series.getById.mockRejectedValueOnce(new Error("db_unavailable"));

    await expect(cancelEventSeries(deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    const begin = idempotency.__mocks.begin.mock.calls.find((c) => c[0] === SERIES_KEY);
    expect(begin?.[2]).toEqual(expect.any(String));
    expect(idempotency.__mocks.release).toHaveBeenCalledWith(SERIES_KEY, begin?.[2]);
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();

    const out = await cancelEventSeries(deps, input);
    expect(out.cancelledCount).toBe(1);
  });

  it("a commit that throws after the run KEEPS the claim: the retry is refused and no occurrence is cancelled twice", async () => {
    const { deps, input, idempotency } = harness();
    idempotency.__mocks.commit.mockRejectedValueOnce(new Error("idempotency_store_down"));

    await expect(cancelEventSeries(deps, input)).rejects.toThrow("idempotency_store_down");
    expect(idempotency.__mocks.release).not.toHaveBeenCalled();
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();

    await expect(cancelEventSeries(deps, input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(vi.mocked(cancelEvent)).toHaveBeenCalledTimes(1);
  });
});
