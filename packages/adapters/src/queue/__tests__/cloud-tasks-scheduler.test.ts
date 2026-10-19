import { describe, expect, it, vi } from "vitest";

// The real ADC source. A scheduler built WITHOUT a getAccessToken seam warms
// its token at construction (the factories below build exactly those), so
// GoogleAuth is faked for the whole file: no test may reach the metadata
// server or a developer's gcloud credentials.
const { adcGetClient, adcGetAccessToken } = vi.hoisted(() => {
  const adcGetAccessToken = vi.fn(async () => ({ token: "adc-token" }));
  const adcGetClient = vi.fn(async () => ({
    getAccessToken: adcGetAccessToken,
  }));
  return { adcGetClient, adcGetAccessToken };
});
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = adcGetClient;
  },
}));

import {
  LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS,
  scheduleLineupSweepContinuation,
} from "@th/core/use-cases/event-humans/_shared/lineup-sweep-continuation";
import { isScheduleNotSentError } from "@th/ports/delayed-jobs";

import {
  CLOUD_TASKS_DEFAULT_TIMEOUT_MS,
  CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS,
  CloudTasksScheduler,
  cloudTaskIdFor,
  createLineupSweepContinuation,
  createSearchReindexDrainTrigger,
  createTaxRateFillScheduler,
} from "../cloud-tasks-scheduler";

const QUEUE = "projects/p1/locations/us-east4/queues/search-drain";
const JOBS = "https://hf-dev-jobs-abc.a.run.app";
const SA = "hfdev-jobs-tasks@p1.iam.gserviceaccount.com";
const RUN_AT = new Date("2026-09-30T12:04:00.000Z");

function makeScheduler(response: Response) {
  const fetchImpl = vi.fn(async () => response);
  const scheduler = new CloudTasksScheduler({
    queuePath: QUEUE,
    jobsServiceUrl: `${JOBS}/`,
    invokerServiceAccountEmail: SA,
    getAccessToken: async () => "token-123",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { scheduler, fetchImpl };
}

describe("CloudTasksScheduler", () => {
  it("creates a NAMED HTTP task at scheduleTime, carrying an OIDC token for the jobs service", async () => {
    const { scheduler, fetchImpl } = makeScheduler(
      new Response("{}", { status: 200 }),
    );

    await expect(
      scheduler.scheduleOnce({
        jobName: "search.drain-reindex-pending",
        payload: {},
        runAt: RUN_AT,
        dedupeKey: "search-reindex-drain-1790769840000",
      }),
    ).resolves.toEqual({ status: "scheduled" });

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-123",
    );
    const body = JSON.parse(String(init.body));
    expect(body.task.name).toBe(
      `${QUEUE}/tasks/${cloudTaskIdFor("search-reindex-drain-1790769840000")}`,
    );
    expect(body.task.scheduleTime).toBe(RUN_AT.toISOString());
    // Never longer than the jobs service's 300s request timeout.
    expect(body.task.dispatchDeadline).toBe("300s");
    expect(body.task.httpRequest).toMatchObject({
      httpMethod: "POST",
      url: `${JOBS}/jobs/search.drain-reindex-pending`,
      oidcToken: { serviceAccountEmail: SA, audience: JOBS },
    });
    expect(
      JSON.parse(Buffer.from(body.task.httpRequest.body, "base64").toString()),
    ).toEqual({});
  });

  it("caps a configured dispatch deadline at 300s", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      dispatchDeadlineSeconds: 1800,
      getAccessToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await scheduler.scheduleOnce({
      jobName: "search.drain-reindex-pending",
      payload: {},
      runAt: RUN_AT,
      dedupeKey: "k",
    });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body)).task.dispatchDeadline).toBe("300s");
  });

  it("409 ALREADY_EXISTS is the dedupe: `duplicate`, not an error", async () => {
    const { scheduler } = makeScheduler(
      new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 }),
    );
    await expect(
      scheduler.scheduleOnce({
        jobName: "search.drain-reindex-pending",
        payload: {},
        runAt: RUN_AT,
        dedupeKey: "k",
      }),
    ).resolves.toEqual({ status: "duplicate" });
  });

  it("any other failure throws (the caller reports it)", async () => {
    const { scheduler } = makeScheduler(
      new Response("permission denied", { status: 403 }),
    );
    await expect(
      scheduler.scheduleOnce({
        jobName: "search.drain-reindex-pending",
        payload: {},
        runAt: RUN_AT,
        dedupeKey: "k",
      }),
    ).rejects.toThrow("cloud_tasks_create_failed: 403");
  });

  it("a refused create is NOT a not-sent error: the request left", async () => {
    const { scheduler } = makeScheduler(new Response("", { status: 403 }));
    const error = await scheduler
      .scheduleOnce({
        jobName: "j",
        payload: {},
        runAt: RUN_AT,
        dedupeKey: "k",
      })
      .catch((e: unknown) => e);
    expect(isScheduleNotSentError(error)).toBe(false);
  });

  it("task ids are Cloud-Tasks-safe and distinct per key", () => {
    const a = cloudTaskIdFor("search-reindex-drain-1");
    const b = cloudTaskIdFor("search reindex/drain:1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    expect(a).not.toBe(b);
    expect(cloudTaskIdFor("x")).toBe(cloudTaskIdFor("x"));
  });
});

describe("createSearchReindexDrainTrigger", () => {
  it("is null unless the queue, the invoker and the jobs URL are all configured", () => {
    expect(createSearchReindexDrainTrigger({})).toBeNull();
    expect(
      createSearchReindexDrainTrigger({
        CLOUD_TASKS_QUEUE: QUEUE,
        JOBS_SERVICE_URL: JOBS,
      }),
    ).toBeNull();
    expect(
      createSearchReindexDrainTrigger({
        CLOUD_TASKS_QUEUE: QUEUE,
        CLOUD_TASKS_INVOKER_SA: SA,
      }),
    ).toBeNull();
  });

  it("carries the configured delay and window", () => {
    const trigger = createSearchReindexDrainTrigger({
      CLOUD_TASKS_QUEUE: QUEUE,
      CLOUD_TASKS_INVOKER_SA: SA,
      JOBS_SERVICE_URL: JOBS,
      SEARCH_REINDEX_DRAIN_DELAY_S: 240,
      SEARCH_REINDEX_DRAIN_WINDOW_S: 60,
    });
    expect(trigger).toMatchObject({ minDelayMs: 240_000, windowMs: 60_000 });
    expect(trigger?.scheduler).toBeInstanceOf(CloudTasksScheduler);
  });
});

describe("createLineupSweepContinuation", () => {
  const LINEUP_QUEUE =
    "projects/p1/locations/us-east4/queues/hf-dev-lineup-notice-sweep";
  const fallback = { scheduleOnce: vi.fn() };

  it("enqueues onto the DEDICATED queue, not the search drain's and not with the arguments transposed", async () => {
    // `instanceof` alone would pass for a scheduler built against the WRONG
    // queue, or with queuePath and jobsServiceUrl swapped — which is the
    // mistake worth guarding, since both are strings. So observe the task.
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const continuation = createLineupSweepContinuation(
      {
        CLOUD_TASKS_LINEUP_SWEEP_QUEUE: LINEUP_QUEUE,
        CLOUD_TASKS_INVOKER_SA: SA,
        JOBS_SERVICE_URL: JOBS,
      },
      fallback,
      {
        getAccessToken: async () => "token-123",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(continuation?.scheduler).toBeInstanceOf(CloudTasksScheduler);
    expect(continuation?.scheduler).not.toBe(fallback);

    const result = await continuation!.scheduler.scheduleOnce({
      jobName: "lineup-notices.continue-sweep",
      dedupeKey: "lineup-sweep-ev1-1-slot",
      runAt: RUN_AT,
      payload: { eventId: "ev1", attempt: 1 },
    });
    expect(result).toEqual({ status: "scheduled" });
    expect(fallback.scheduleOnce).not.toHaveBeenCalled();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe(
      `https://cloudtasks.googleapis.com/v2/${LINEUP_QUEUE}/tasks`,
    );
    expect(url).not.toContain("search-drain");
    const body = JSON.parse(init.body);
    expect(body.task.name.startsWith(`${LINEUP_QUEUE}/tasks/`)).toBe(true);
    // The jobs URL is the target and the audience; the queue path is neither.
    expect(body.task.httpRequest.url).toBe(
      `${JOBS}/jobs/lineup-notices.continue-sweep`,
    );
    expect(body.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: SA,
      audience: JOBS,
    });
  });

  it("falls back to the search-drain scheduler when the dedicated queue is absent, rather than dropping continuations", () => {
    // Every revision between the commit that reads the new variable and the
    // terraform apply that sets it.
    expect(createLineupSweepContinuation({}, fallback)).toEqual({
      scheduler: fallback,
    });
    // A half-configured dedicated queue falls back too — it must never build
    // a scheduler without an invoker or a target.
    expect(
      createLineupSweepContinuation(
        {
          CLOUD_TASKS_LINEUP_SWEEP_QUEUE: LINEUP_QUEUE,
          JOBS_SERVICE_URL: JOBS,
        },
        fallback,
      ),
    ).toEqual({ scheduler: fallback });
    expect(
      createLineupSweepContinuation(
        {
          CLOUD_TASKS_LINEUP_SWEEP_QUEUE: LINEUP_QUEUE,
          CLOUD_TASKS_INVOKER_SA: SA,
        },
        fallback,
      ),
    ).toEqual({ scheduler: fallback });
  });

  it("is null only when there is no scheduler at all", () => {
    expect(createLineupSweepContinuation({}, null)).toBeNull();
  });
});

describe("createTaxRateFillScheduler", () => {
  const TAX_QUEUE = "projects/p1/locations/us-east4/queues/hf-dev-tax-rate-fill";

  it("enqueues onto the DEDICATED tax-fill queue, never the search drain's", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const scheduler = createTaxRateFillScheduler(
      {
        CLOUD_TASKS_TAX_FILL_QUEUE: TAX_QUEUE,
        CLOUD_TASKS_INVOKER_SA: SA,
        JOBS_SERVICE_URL: JOBS,
      },
      {
        getAccessToken: async () => "token-123",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(scheduler).toBeInstanceOf(CloudTasksScheduler);

    const result = await scheduler!.scheduleOnce({
      jobName: "tax.fill-location-rate",
      dedupeKey: "tax-fill-place-p1-1",
      runAt: RUN_AT,
      payload: { target: { kind: "place", placeId: "p1" } },
    });
    expect(result).toEqual({ status: "scheduled" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${TAX_QUEUE}/tasks`);
    expect(url).not.toContain("search-drain");
    const body = JSON.parse(init.body);
    expect(body.task.name.startsWith(`${TAX_QUEUE}/tasks/`)).toBe(true);
    expect(body.task.httpRequest.url).toBe(
      `${JOBS}/jobs/tax.fill-location-rate`,
    );
    expect(body.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: SA,
      audience: JOBS,
    });
  });

  it("is null without the dedicated queue: NO fallback to the search-drain queue", () => {
    expect(createTaxRateFillScheduler({})).toBeNull();
    // The search drain's own variables alone must not build one.
    expect(
      createTaxRateFillScheduler({
        CLOUD_TASKS_INVOKER_SA: SA,
        JOBS_SERVICE_URL: JOBS,
      }),
    ).toBeNull();
    expect(
      createTaxRateFillScheduler({
        CLOUD_TASKS_TAX_FILL_QUEUE: TAX_QUEUE,
        JOBS_SERVICE_URL: JOBS,
      }),
    ).toBeNull();
    expect(
      createTaxRateFillScheduler({
        CLOUD_TASKS_TAX_FILL_QUEUE: TAX_QUEUE,
        CLOUD_TASKS_INVOKER_SA: SA,
      }),
    ).toBeNull();
  });
});

describe("CloudTasksScheduler — failures before the request is sent", () => {
  const input = {
    jobName: "lineup-notices.continue-sweep",
    payload: {},
    runAt: RUN_AT,
    dedupeKey: "k",
  };
  function withToken(getAccessToken: () => Promise<string | null | undefined>) {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      getAccessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { scheduler, fetchImpl };
  }

  it("a token fetch that throws is a ScheduleNotSentError carrying the cause; nothing is sent", async () => {
    const cause = new Error("metadata server: ECONNRESET");
    const { scheduler, fetchImpl } = withToken(async () => {
      throw cause;
    });
    const error = await scheduler.scheduleOnce(input).catch((e: unknown) => e);
    expect(isScheduleNotSentError(error)).toBe(true);
    expect((error as Error).cause).toBe(cause);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no token at all is a ScheduleNotSentError", async () => {
    const { scheduler, fetchImpl } = withToken(async () => null);
    const error = await scheduler.scheduleOnce(input).catch((e: unknown) => e);
    expect(isScheduleNotSentError(error)).toBe(true);
    expect((error as Error).message).toBe("cloud_tasks_no_access_token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a token fetch that stalls fails at its budget as a ScheduleNotSentError, and never sends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { scheduler, fetchImpl } = withToken(
        () => new Promise<never>(() => {}),
      );
      let error: unknown;
      let settled = false;
      const pending = scheduler.scheduleOnce(input).catch((e: unknown) => {
        error = e;
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(
        CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS - 1,
      );
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(isScheduleNotSentError(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /^cloud_tasks_access_token_timeout/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("token + request budgets end inside the lineup sweep's outer timeout, with a margin", () => {
    // If they did not, the caller's timer would win and read a task that was
    // never sent as "may exist" — reported, never retried.
    expect(
      CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS + CLOUD_TASKS_DEFAULT_TIMEOUT_MS,
    ).toBeLessThanOrEqual(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS - 500);
  });

  it("through the real core: a stalled token fetch is a `failed` hop (retried), not `timeout` (stranded)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { scheduler, fetchImpl } = withToken(
        () => new Promise<never>(() => {}),
      );
      const reportError = vi.fn();
      const pending = scheduleLineupSweepContinuation(
        { continuation: { scheduler }, reportError },
        { eventId: "e1", attempt: 1, owedSeen: true, owedSample: [] },
      );
      await vi.advanceTimersByTimeAsync(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBe("failed");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      const [error, context] = reportError.mock.calls[0]!;
      expect(isScheduleNotSentError(error)).toBe(true);
      expect(context.tags.reason).toBe("sweep_continuation_schedule_failed");
      expect(context.extra.notSent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CloudTasksScheduler — token warm-up at construction", () => {
  const input = {
    jobName: "lineup-notices.continue-sweep",
    payload: {},
    runAt: RUN_AT,
    dedupeKey: "k",
  };
  const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 }));
  const authHeader = (fetchImpl: ReturnType<typeof okFetch>) =>
    (
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .headers as Record<string, string>
    ).Authorization;

  it("the real ADC source is warmed at construction, before any hop", async () => {
    adcGetClient.mockClear();
    adcGetAccessToken.mockClear();
    const fetchImpl = okFetch();
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Synchronously started: the cold getClient() is already under way.
    expect(adcGetClient).toHaveBeenCalledTimes(1);
    await scheduler.scheduleOnce(input);
    expect(authHeader(fetchImpl)).toBe("Bearer adc-token");
  });

  it("calls the token source once at construction, and a hop issued while it is in flight joins it", async () => {
    let resolveToken!: (token: string) => void;
    const getAccessToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const fetchImpl = okFetch();
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      getAccessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      warmAccessToken: true,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const pending = scheduler.scheduleOnce(input);
    resolveToken("warm-token");
    await expect(pending).resolves.toEqual({ status: "scheduled" });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchImpl)).toBe("Bearer warm-token");
  });

  it("a warm-up that rejects is handled: construction succeeds and the next hop fetches afresh", async () => {
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("metadata server cold"))
      .mockResolvedValueOnce("fresh-token");
    const fetchImpl = okFetch();
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      getAccessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      warmAccessToken: true,
    });
    // Let the rejected warm-up settle (an unhandled rejection fails the run).
    await new Promise((resolve) => setImmediate(resolve));
    await expect(scheduler.scheduleOnce(input)).resolves.toEqual({
      status: "scheduled",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(authHeader(fetchImpl)).toBe("Bearer fresh-token");
  });

  it("a hop that joined a warm-up which then REJECTS fetches once more inside its budget, and is scheduled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let rejectWarm!: (error: Error) => void;
      const getAccessToken = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((_, reject) => {
              rejectWarm = reject;
            }),
        )
        .mockResolvedValueOnce("retry-token");
      const fetchImpl = okFetch();
      const scheduler = new CloudTasksScheduler({
        queuePath: QUEUE,
        jobsServiceUrl: JOBS,
        invokerServiceAccountEmail: SA,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warmAccessToken: true,
      });
      const pending = scheduler.scheduleOnce(input);
      // A transient metadata-server error 200ms in: ~1.3s of budget left.
      await vi.advanceTimersByTimeAsync(200);
      rejectWarm(new Error("ECONNRESET"));
      await expect(pending).resolves.toEqual({ status: "scheduled" });
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchImpl)).toBe("Bearer retry-token");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the retry after a rejected joined warm-up is the ONLY one: if it fails too, the hop is not-sent and leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let rejectWarm!: (error: Error) => void;
      const retryError = new Error("ECONNRESET again");
      const getAccessToken = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((_, reject) => {
              rejectWarm = reject;
            }),
        )
        .mockRejectedValueOnce(retryError)
        .mockResolvedValue("never-used");
      const fetchImpl = okFetch();
      const scheduler = new CloudTasksScheduler({
        queuePath: QUEUE,
        jobsServiceUrl: JOBS,
        invokerServiceAccountEmail: SA,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warmAccessToken: true,
      });
      const pending = scheduler.scheduleOnce(input).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(200);
      rejectWarm(new Error("ECONNRESET"));
      const error = await pending;
      expect(isScheduleNotSentError(error)).toBe(true);
      expect((error as Error).cause).toBe(retryError);
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hop's OWN token fetch failing is not retried", async () => {
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("never-used");
    const fetchImpl = okFetch();
    const scheduler = new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      getAccessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await scheduler.scheduleOnce(input).catch((e: unknown) => e);
    expect(isScheduleNotSentError(error)).toBe(true);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a warm-up that answers only AFTER a hop's budget: that hop is not-sent, and the next hop fetches afresh and succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let resolveWarm!: (token: string) => void;
      const getAccessToken = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              resolveWarm = resolve;
            }),
        )
        .mockResolvedValueOnce("fresh-token");
      const fetchImpl = okFetch();
      const scheduler = new CloudTasksScheduler({
        queuePath: QUEUE,
        jobsServiceUrl: JOBS,
        invokerServiceAccountEmail: SA,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warmAccessToken: true,
      });
      const first = scheduler.scheduleOnce(input).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS);
      const error = await first;
      expect(isScheduleNotSentError(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /^cloud_tasks_access_token_timeout/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();

      resolveWarm("late-warm-token");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        (scheduler as unknown as { pendingWarmToken?: unknown })
          .pendingWarmToken,
      ).toBeUndefined();

      await expect(scheduler.scheduleOnce(input)).resolves.toEqual({
        status: "scheduled",
      });
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchImpl)).toBe("Bearer fresh-token");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a joined warm-up that rejects AFTER the deadline is not retried, and leaves no rejection or timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let rejectWarm!: (error: Error) => void;
      const getAccessToken = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((_, reject) => {
              rejectWarm = reject;
            }),
        )
        .mockResolvedValue("never-used");
      const fetchImpl = okFetch();
      const scheduler = new CloudTasksScheduler({
        queuePath: QUEUE,
        jobsServiceUrl: JOBS,
        invokerServiceAccountEmail: SA,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warmAccessToken: true,
      });
      const pending = scheduler.scheduleOnce(input).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS);
      const error = await pending;
      expect(isScheduleNotSentError(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /^cloud_tasks_access_token_timeout/,
      );

      rejectWarm(new Error("ECONNRESET after the deadline"));
      await vi.advanceTimersByTimeAsync(0);
      // No post-deadline retry: the only call is the warm-up's.
      expect(getAccessToken).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a token source that throws SYNCHRONOUSLY is a ScheduleNotSentError carrying the cause, and leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const thrown = new Error("x");
      const getAccessToken = vi.fn((): Promise<string> => {
        throw thrown;
      });
      const fetchImpl = okFetch();
      const scheduler = new CloudTasksScheduler({
        queuePath: QUEUE,
        jobsServiceUrl: JOBS,
        invokerServiceAccountEmail: SA,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const error = await scheduler
        .scheduleOnce(input)
        .catch((e: unknown) => e);
      expect(isScheduleNotSentError(error)).toBe(true);
      expect((error as Error).cause).toBe(thrown);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an injected token seam is NOT warmed unless asked", () => {
    const getAccessToken = vi.fn(async () => "t");
    new CloudTasksScheduler({
      queuePath: QUEUE,
      jobsServiceUrl: JOBS,
      invokerServiceAccountEmail: SA,
      getAccessToken,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("leaves no timer behind after a successful hop (the token budget timer is cleared)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { scheduler } = makeScheduler(new Response("{}", { status: 200 }));
      await expect(scheduler.scheduleOnce(input)).resolves.toEqual({
        status: "scheduled",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
