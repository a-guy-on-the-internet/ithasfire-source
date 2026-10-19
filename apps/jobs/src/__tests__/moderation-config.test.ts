import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveModerationCategoryThresholds,
  resolveModerationProvider,
} from "../lib/moderation-config";
import type { Env } from "../lib/env";

const buildContainerMock = vi.fn();

vi.mock("../lib/container", () => ({
  buildContainer: buildContainerMock,
}));

vi.mock("../jobs", () => ({
  allJobs: [],
  getJob: vi.fn(() => undefined),
}));

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));

vi.mock("../instrument", () => ({
  Sentry: { captureException: vi.fn(() => "evt_1") },
}));

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

const env = (over: Partial<Env> = {}) => over as Env;

// ─────────────────────────────────────────────────────────────────────────────
// The selection rule itself
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveModerationProvider", () => {
  it("picks azure only when BOTH secrets are present", () => {
    expect(
      resolveModerationProvider(
        env({
          AZURE_CONTENT_SAFETY_ENDPOINT: "https://cs.example",
          AZURE_CONTENT_SAFETY_KEY: "k",
          NODE_ENV: "production",
        }),
      ),
    ).toBe("azure");

    // Half-configured is NOT configured. A cleared key with the endpoint still
    // set is the exact shape of the August 2026 outage.
    expect(
      resolveModerationProvider(
        env({
          AZURE_CONTENT_SAFETY_ENDPOINT: "https://cs.example",
          NODE_ENV: "production",
        }),
      ),
    ).toBe("fail-closed");
  });

  it("fails CLOSED in production and STUBS everywhere else", () => {
    // The two answers an operator must never have guessed at: "stub" means
    // every image auto-approves un-scanned.
    expect(resolveModerationProvider(env({ NODE_ENV: "production" }))).toBe(
      "fail-closed",
    );
    expect(resolveModerationProvider(env({ NODE_ENV: "development" }))).toBe(
      "stub",
    );
    expect(resolveModerationProvider(env({ NODE_ENV: "test" }))).toBe("stub");
  });
});

describe("resolveModerationCategoryThresholds", () => {
  it("fills an absent override from reviewThreshold — never from zero", () => {
    // The container passes a PARTIAL map on purpose; `exceedsCategoryThreshold`
    // falls back per category. Reporting the partial map raw would show blanks,
    // and defaulting to 0 would claim we flag everything.
    expect(resolveModerationCategoryThresholds(4, { HATE: 2 })).toEqual({
      SEXUAL: 4,
      VIOLENCE: 4,
      HATE: 2,
      SELF_HARM: 4,
    });
  });

  it("is total over the four categories even with no overrides at all", () => {
    expect(resolveModerationCategoryThresholds(6, {})).toEqual({
      SEXUAL: 6,
      VIOLENCE: 6,
      HATE: 6,
      SELF_HARM: 6,
    });
  });

  it("keeps an explicit zero override rather than treating it as absent", () => {
    // `?? reviewThreshold`, not `|| reviewThreshold`. Severity 0 is a real
    // (paranoid) setting and must survive the round trip.
    expect(
      resolveModerationCategoryThresholds(6, { SELF_HARM: 0 }),
    ).toMatchObject({ SELF_HARM: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /moderation/config
// ─────────────────────────────────────────────────────────────────────────────

async function makeApp(over: Record<string, unknown> = {}) {
  buildContainerMock.mockResolvedValue({
    logger: makeLogger(),
    runTracker: {
      isEnabled: vi.fn(async () => true),
      setEnabled: vi.fn(async () => undefined),
      latestAll: vi.fn(async () => new Map()),
      pruneRuns: vi.fn(async () => 0),
      runs: vi.fn(async () => []),
      record: vi.fn(async () => undefined),
    },
    diagnostics: null,
    env: {},
    moderationProvider: "stub",
    imageModerationReviewThreshold: 4,
    imageModerationCategoryThresholds: { HATE: 2, SELF_HARM: 2 },
    close: vi.fn(async () => undefined),
    ...over,
  });

  const { createApp } = await import("../app");
  const { app } = await createApp();
  return app;
}

describe("GET /moderation/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("reports the provider the CONTAINER selected, with fully-resolved thresholds", async () => {
    const app = await makeApp();

    const res = await app.inject({ method: "GET", url: "/moderation/config" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "stub",
      reviewThreshold: 4,
      // SEXUAL/VIOLENCE had no override and come back filled from
      // reviewThreshold, matching what moderate-image actually compares against.
      categoryThresholds: {
        SEXUAL: 4,
        VIOLENCE: 4,
        HATE: 2,
        SELF_HARM: 2,
      },
    });

    await app.close();
  });

  it("carries the boot-time selection, not a re-derivation from env", async () => {
    // Env here says "azure is configured" while the container recorded
    // fail-closed. The endpoint must answer with what the process actually
    // wired — a second env read is how a dashboard lies during an outage.
    const app = await makeApp({
      moderationProvider: "fail-closed",
      env: {
        AZURE_CONTENT_SAFETY_ENDPOINT: "https://cs.example",
        AZURE_CONTENT_SAFETY_KEY: "k",
      },
    });

    const res = await app.inject({ method: "GET", url: "/moderation/config" });

    expect(res.json().provider).toBe("fail-closed");

    await app.close();
  });

  it("leaks NO endpoint URL and NO key, even when both are configured", async () => {
    const app = await makeApp({
      moderationProvider: "azure",
      env: {
        AZURE_CONTENT_SAFETY_ENDPOINT: "https://contoso.cognitiveservices.azure.com",
        AZURE_CONTENT_SAFETY_KEY: "super-secret-key",
      },
    });

    const res = await app.inject({ method: "GET", url: "/moderation/config" });
    const body = res.payload;

    expect(body).not.toContain("super-secret-key");
    expect(body).not.toContain("cognitiveservices");
    expect(Object.keys(res.json()).sort()).toEqual([
      "categoryThresholds",
      "provider",
      "reviewThreshold",
    ]);

    await app.close();
  });

  it("sits behind the same auth as /jobs/status — 401 without a credential", async () => {
    // There is no route-level guard: the app's `onRequest` hook rejects
    // everything but /health. This test is what stops a future refactor from
    // adding this path to that exemption.
    const app = await makeApp({ env: { JOBS_API_KEY: "s3cret" } });

    const unauthed = await app.inject({
      method: "GET",
      url: "/moderation/config",
    });
    expect(unauthed.statusCode).toBe(401);

    // Same credential /jobs/status takes.
    const authed = await app.inject({
      method: "GET",
      url: "/moderation/config",
      headers: { "x-jobs-api-key": "s3cret" },
    });
    expect(authed.statusCode).toBe(200);

    const status = await app.inject({
      method: "GET",
      url: "/jobs/status",
      headers: { "x-jobs-api-key": "s3cret" },
    });
    expect(status.statusCode).toBe(200);

    await app.close();
  });
});
