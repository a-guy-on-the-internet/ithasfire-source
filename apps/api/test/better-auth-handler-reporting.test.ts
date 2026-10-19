import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Regression test for the swallow site in `plugins/better-auth.ts`.
 *
 * A throw out of `auth.handler()` is caught there and answered with a generic
 * 500 `AUTH_FAILURE`, which makes that catch the ONLY place the real cause is
 * ever visible. It used to be log-only, and the log did not survive the trip:
 * a total dev sign-in outage — every `/sign-in/*` 500ing while `/get-session`
 * stayed 200 — ran for three weeks with nothing in Sentry and no
 * `better_auth_handler_failed` line to grep for in Cloud Logging.
 *
 * These tests pin the two properties that made it undiagnosable, so the
 * instrumentation cannot be quietly dropped again:
 *  1. the error reaches `Sentry.captureException`, and
 *  2. it is logged under the `err` key (what Sentry's pinoIntegration
 *     serialises as an exception — the old `{ error }` shape logged an
 *     opaque object).
 */

const captureException = vi.hoisted(() => vi.fn());
const handler = vi.hoisted(() => vi.fn());

vi.mock("../src/instrument", () => ({ Sentry: { captureException } }));
vi.mock("../src/auth/better-auth", () => ({ auth: { handler } }));

const BOOM = new Error("better auth exploded");

describe("better-auth plugin error reporting", () => {
  let app: FastifyInstance;
  let logged: Array<[unknown, unknown]>;

  beforeEach(async () => {
    captureException.mockClear();
    handler.mockReset();
    logged = [];

    const { default: betterAuthPlugin } = await import(
      "../src/plugins/better-auth"
    );

    app = Fastify({ logger: false });
    // `app.log.error` is what the plugin calls; capture both arguments so the
    // structured shape can be asserted, not just the message.
    app.log.error = ((obj: unknown, msg: unknown) => {
      logged.push([obj, msg]);
    }) as never;

    await app.register(betterAuthPlugin as never);
    await app.ready();
  });

  it("reports a throwing auth handler to Sentry and still answers 500", async () => {
    handler.mockRejectedValue(BOOM);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "someone@example.com", password: "hunter2" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Internal authentication error",
      code: "AUTH_FAILURE",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBe(BOOM);
    expect(captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "better_auth_handler" },
      extra: { path: "/api/auth/sign-in/email", method: "POST" },
    });
  });

  it("logs the cause under `err` so pinoIntegration serialises it", async () => {
    handler.mockRejectedValue(BOOM);

    await app.inject({ method: "POST", url: "/api/auth/sign-in/email" });

    const entry = logged.find(([, msg]) => msg === "better_auth_handler_failed");
    expect(entry).toBeDefined();
    expect(entry?.[0]).toMatchObject({
      err: BOOM,
      path: "/api/auth/sign-in/email",
      method: "POST",
    });
  });

  it("a throwing reporter never turns the 500 into a crash", async () => {
    handler.mockRejectedValue(BOOM);
    captureException.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Internal authentication error",
      code: "AUTH_FAILURE",
    });
  });

  it("does not report when the handler succeeds", async () => {
    handler.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/auth/get-session" });

    expect(res.statusCode).toBe(200);
    expect(captureException).not.toHaveBeenCalled();
  });
});
