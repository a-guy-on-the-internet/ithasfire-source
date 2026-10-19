import { afterEach, describe, expect, it, vi } from "vitest";

import { router } from "../trpc";
import { router as trpcRouter } from "../init";
import type { Ctx } from "../context";
import { createTestLogger } from "@th/test-utils";
import * as announcementUseCases from "@th/core/use-cases/announcements";
import * as exportUseCases from "@th/core/use-cases/exports/request-admin-export";
import { announcementsRouter } from "../routers/announcements";
import { ordersRouter } from "../routers/orders";
import {
  jobsServiceHeaders,
  postJobToJobsService,
} from "../jobs-service-request";

/**
 * Announcements and the admin CSV export used to call the jobs service with
 * `Authorization: Bearer <JOBS_API_KEY>`. On Cloud Run the jobs service sits
 * behind IAM, which only accepts a Google OIDC token in that header, so both
 * were rejected before reaching the app. They now send the API key in
 * `X-Jobs-API-Key` and a metadata-server identity token as the bearer.
 */

const JOBS_URL = "https://hf-prod-jobs-abc.a.run.app";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** fetch stub: the metadata server answers `idToken` (null = off GCP). */
function stubFetch(idToken: string | null) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    if (u.startsWith("http://metadata.google.internal/")) {
      if (idToken === null) throw new TypeError("fetch failed");
      return new Response(idToken, { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  return { impl, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Env is stubbed with vi.stubEnv, so a failed assertion can never leak
  // JOBS_API_KEY into the next test.
  vi.unstubAllEnvs();
});

describe("jobsServiceHeaders", () => {
  it("on Cloud Run: API key in X-Jobs-API-Key, Google identity token (jobs audience) as the bearer", async () => {
    const { impl, calls } = stubFetch("oidc.jwt.token");
    const headers = await jobsServiceHeaders(`${JOBS_URL}/`, {
      apiKey: "k".repeat(16),
      fetchImpl: impl as unknown as typeof fetch,
    });
    expect(headers).toEqual({
      "Content-Type": "application/json",
      "X-Jobs-API-Key": "k".repeat(16),
      Authorization: "Bearer oidc.jwt.token",
    });
    expect(calls[0]!.url).toBe(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(JOBS_URL)}`,
    );
  });

  it("off GCP: API key header only — never the API key as a bearer", async () => {
    const { impl } = stubFetch(null);
    const headers = await jobsServiceHeaders(JOBS_URL, {
      apiKey: "k".repeat(16),
      fetchImpl: impl as unknown as typeof fetch,
    });
    expect(headers).toEqual({
      "Content-Type": "application/json",
      "X-Jobs-API-Key": "k".repeat(16),
    });
  });

  it("postJobToJobsService posts the JSON payload to /jobs/<name>", async () => {
    const { impl, calls } = stubFetch("tok");
    await postJobToJobsService(JOBS_URL, "admin.csv-export", { a: 1 }, {
      apiKey: null,
      fetchImpl: impl as unknown as typeof fetch,
    });
    const post = calls.find((c) => c.url.startsWith(JOBS_URL))!;
    expect(post.url).toBe(`${JOBS_URL}/jobs/admin.csv-export`);
    expect(post.init.method).toBe("POST");
    expect(JSON.parse(post.init.body as string)).toEqual({ a: 1 });
    expect((post.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });
});

const buildCtx = () =>
  ({
    repos: {} as Ctx["repos"],
    authz: {} as Ctx["authz"],
    clock: { now: () => new Date("2026-09-30T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    rateLimit: {
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    } as unknown as Ctx["rateLimit"],
    actorHumanId: ACTOR_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
    jobsServiceUrl: JOBS_URL,
  }) as unknown as Ctx;

function jobsPost(calls: Array<{ url: string; init: RequestInit }>) {
  const post = calls.find((c) => c.url.startsWith(`${JOBS_URL}/jobs/`));
  expect(post).toBeDefined();
  return {
    url: post!.url,
    headers: post!.init.headers as Record<string, string>,
  };
}

describe("routers reaching the jobs service", () => {
  it("announcements.send dispatches with the API key header + OIDC bearer", async () => {
    vi.stubEnv("JOBS_API_KEY", "a".repeat(16));
    const { impl, calls } = stubFetch("oidc.for.jobs");
    vi.stubGlobal("fetch", impl);
    vi.spyOn(announcementUseCases, "sendAnnouncement").mockImplementation(
      async (deps) => {
        await deps.enqueueNotifyJob?.({ announcementId: "x" } as never);
        return { id: "33333333-3333-4333-8333-333333333333", sentAt: new Date() } as never;
      },
    );

    await trpcRouter({ announcements: router(announcementsRouter) })
      .createCaller(buildCtx())
      .announcements.send({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        subject: "Doors at 8",
        bodyDoc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
        },
        bodyHtml: "<p>Hi</p>",
        audienceType: "ALL_TICKET_HOLDERS",
      });

    const post = jobsPost(calls);
    expect(post.url).toBe(`${JOBS_URL}/jobs/announcements.dispatch-notifications`);
    expect(post.headers["X-Jobs-API-Key"]).toBe("a".repeat(16));
    expect(post.headers.Authorization).toBe("Bearer oidc.for.jobs");
  });

  it("orders.requestExport enqueues with the API key header + OIDC bearer", async () => {
    vi.stubEnv("JOBS_API_KEY", "b".repeat(16));
    const { impl, calls } = stubFetch("oidc.for.jobs");
    vi.stubGlobal("fetch", impl);
    vi.spyOn(exportUseCases, "requestAdminExport").mockImplementation(
      async (deps) => {
        await deps.enqueueJob("admin.csv-export", { orgId: ORG_ID });
        return { enqueued: true };
      },
    );

    await trpcRouter({ orders: router(ordersRouter) })
      .createCaller(buildCtx())
      .orders.requestExport({ orgId: ORG_ID, exportType: "org_orders" });

    const post = jobsPost(calls);
    expect(post.url).toBe(`${JOBS_URL}/jobs/admin.csv-export`);
    expect(post.headers["X-Jobs-API-Key"]).toBe("b".repeat(16));
    expect(post.headers.Authorization).toBe("Bearer oidc.for.jobs");
  });
});
