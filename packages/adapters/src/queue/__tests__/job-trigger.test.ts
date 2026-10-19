import { describe, expect, it, vi } from "vitest";

import {
  HttpJobTrigger,
  PubSubJobTrigger,
  createJobTrigger,
} from "../job-trigger";

const logger = {
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  withTime: vi.fn(),
} as never;

describe("PubSubJobTrigger", () => {
  it("publishes the drain's wake-up payload to <prefix><topic> via the REST API", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const trigger = new PubSubJobTrigger({
      topicPrefix: "projects/p/topics/prod-",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await trigger.trigger("community.dispatch-rsvp-confirmations");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://pubsub.googleapis.com/v1/projects/p/topics/prod-hf-trigger-rsvp-confirmations:publish",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    const body = JSON.parse(init.body as string) as {
      messages: { data: string; attributes: Record<string, string> }[];
    };
    // no_wrapper push delivers `data` verbatim as the job's request body.
    expect(
      JSON.parse(Buffer.from(body.messages[0]!.data, "base64").toString()),
    ).toEqual({ freshOnly: true });
    expect(body.messages[0]!.attributes).toEqual({
      job: "community.dispatch-rsvp-confirmations",
    });
  });

  it("rejects on a non-2xx publish so the caller can report it", async () => {
    const trigger = new PubSubJobTrigger({
      topicPrefix: "projects/p/topics/dev-",
      getAccessToken: async () => "tok",
      fetchImpl: (async () =>
        new Response("NOT_FOUND", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(
      trigger.trigger("moderation.drain-image-moderations"),
    ).rejects.toThrow(/job_trigger_publish_failed: 404/);
  });

  it("rejects when no access token is available", async () => {
    const trigger = new PubSubJobTrigger({
      topicPrefix: "projects/p/topics/dev-",
      getAccessToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      trigger.trigger("events.dispatch-change-notifications"),
    ).rejects.toThrow("job_trigger_no_access_token");
  });
});

describe("HttpJobTrigger (local dev)", () => {
  it("POSTs the wake-up payload to the local jobs service", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const trigger = new HttpJobTrigger({
      jobsBaseUrl: "http://localhost:3002/",
      apiKey: "k".repeat(16),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await trigger.trigger("events.dispatch-change-notifications");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://localhost:3002/jobs/events.dispatch-change-notifications",
    );
    expect(JSON.parse(init.body as string)).toEqual({ freshOnly: true });
    expect((init.headers as Record<string, string>)["X-Jobs-API-Key"]).toBe(
      "k".repeat(16),
    );
  });
});

describe("createJobTrigger", () => {
  it("selects Pub/Sub when Terraform set a topic prefix", () => {
    expect(
      createJobTrigger({ JOB_TRIGGER_TOPIC_PREFIX: "projects/p/topics/prod-" }, logger),
    ).toBeInstanceOf(PubSubJobTrigger);
  });
  it("selects direct HTTP only on explicit local opt-in", () => {
    expect(
      createJobTrigger(
        { JOB_TRIGGER_BACKEND: "http", JOBS_SERVICE_URL: "http://localhost:3002" },
        logger,
      ),
    ).toBeInstanceOf(HttpJobTrigger);
    expect(
      createJobTrigger({ JOBS_SERVICE_URL: "http://localhost:3002" }, logger),
    ).toBeNull();
  });
});

describe("hardening (round 2)", () => {
  it("PubSubJobTrigger: a hung access-token fetch is cut off by the same timeout as the publish", async () => {
    const fetchImpl = vi.fn();
    const trigger = new PubSubJobTrigger({
      topicPrefix: "projects/p/topics/prod-",
      getAccessToken: () => new Promise(() => {}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await expect(
      trigger.trigger("moderation.drain-image-moderations"),
    ).rejects.toThrow("job_trigger_timeout");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("HttpJobTrigger: a failed local wake-up is logged at ERROR and reported", async () => {
    const reportError = vi.fn();
    const log = { ...(logger as object), error: vi.fn(), warn: vi.fn() };
    const trigger = new HttpJobTrigger({
      jobsBaseUrl: "http://localhost:3002",
      logger: log as never,
      reportError,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await trigger.trigger("community.dispatch-rsvp-confirmations");
    await new Promise((r) => setImmediate(r));
    expect(log.error).toHaveBeenCalledWith(
      "job_trigger_http_failed",
      expect.objectContaining({ job: "community.dispatch-rsvp-confirmations" }),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ECONNREFUSED" }),
      expect.objectContaining({ tags: expect.objectContaining({ backend: "http" }) }),
    );
  });

  it("HttpJobTrigger: a non-2xx is reported too", async () => {
    const reportError = vi.fn();
    const trigger = new HttpJobTrigger({
      jobsBaseUrl: "http://localhost:3002",
      logger: { ...(logger as object), error: vi.fn() } as never,
      reportError,
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    });
    await trigger.trigger("events.dispatch-change-notifications");
    await new Promise((r) => setImmediate(r));
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "job_trigger_http_non_ok: 503" }),
      expect.anything(),
    );
  });

  it.each([
    [{ K_SERVICE: "hf-prod-api" }],
    [{ NODE_ENV: "production" }],
  ])("createJobTrigger refuses the http backend on Cloud Run / in production (%o)", (guard) => {
    const reportError = vi.fn();
    const log = { ...(logger as object), error: vi.fn() };
    const out = createJobTrigger(
      {
        JOB_TRIGGER_BACKEND: "http",
        JOBS_SERVICE_URL: "http://localhost:3002",
        ...guard,
      },
      log as never,
      reportError,
    );
    expect(out).toBeNull();
    expect(log.error).toHaveBeenCalledWith("job_trigger_http_refused", expect.anything());
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("createJobTrigger still selects Pub/Sub on Cloud Run", () => {
    expect(
      createJobTrigger(
        { JOB_TRIGGER_TOPIC_PREFIX: "projects/p/topics/prod-", K_SERVICE: "hf-prod-api", NODE_ENV: "production" },
        logger,
      ),
    ).toBeInstanceOf(PubSubJobTrigger);
  });
});
