import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  INTERNAL_ERROR_WIRE_MESSAGE,
  installErrorHandler,
  resolveErrorStatus,
} from "../src/plugins/error-handler";

// Security review F14 (2026-09-29): Fastify's default handler sent
// `error.message` on 500s, so Prisma/SQL and TypeError text reached clients
// on the non-tRPC routes.

const LEAK = "Invalid prisma.$queryRaw() invocation: column h.email does not exist";

async function buildApp(isProduction: boolean) {
  const logger = { warn: vi.fn() };
  const app = Fastify({ logger: false });
  installErrorHandler(app, { logger, isProduction });
  // Stand-in for Sentry.setupFastifyErrorHandler, which registers exactly
  // this: a skip-override plugin adding a root `onError` hook, AFTER all
  // routes (app.ts). Capture must keep firing under the custom handler.
  const onErrorSpy = vi.fn();
  const sentryLike = Object.assign(
    (instance: FastifyInstance, _opts: unknown, done: () => void) => {
      instance.addHook("onError", async (_req, _reply, error) => {
        onErrorSpy(error);
      });
      done();
    },
    { [Symbol.for("skip-override")]: true },
  );

  app.get("/boom", async () => {
    throw new Error(LEAK);
  });
  app.get("/typeerror", async () => {
    const x = undefined as unknown as { ownerId: string };
    return x.ownerId;
  });
  app.get("/bad-gateway", async () => {
    throw Object.assign(new Error("upstream said: secret-token-abc"), {
      statusCode: 502,
    });
  });
  app.get("/status-only", async () => {
    // http-errors style: `status`, no `statusCode`.
    throw Object.assign(new Error("gone upstream"), { status: 503 });
  });
  app.get("/client-error", async () => {
    throw Object.assign(new Error("slug is required"), { statusCode: 400 });
  });
  app.post(
    "/validated",
    { schema: { body: { type: "object", required: ["a"] } } },
    async () => ({ ok: true }),
  );
  // Routes inside an encapsulated plugin (how every real route is added)
  // must inherit the handler too.
  await app.register(async (child) => {
    child.get("/nested-boom", async () => {
      throw new Error(LEAK);
    });
  });
  // Registered LAST, as app.ts does with Sentry.
  await app.register(sentryLike);
  await app.ready();
  return { app, logger, onErrorSpy };
}

const originalNodeEnv = process.env.NODE_ENV;
let app: FastifyInstance | undefined;

afterEach(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  await app?.close();
  app = undefined;
});

describe("installErrorHandler (production)", () => {
  it.each(["/boom", "/typeerror", "/nested-boom"])(
    "%s: 500 body carries no internal text",
    async (url) => {
      const built = await buildApp(true);
      app = built.app;

      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        statusCode: 500,
        error: "Internal Server Error",
        message: INTERNAL_ERROR_WIRE_MESSAGE,
      });
      expect(res.body).not.toContain("prisma");
      expect(res.body).not.toContain("ownerId");
      // Still logged server-side with the real error.
      expect(built.logger.warn).toHaveBeenCalledWith(
        "http_unhandled_error_scrubbed",
        expect.objectContaining({ err: expect.any(Error), statusCode: 500 }),
      );
    },
  );

  it("keeps a non-500 5xx status but scrubs its message", async () => {
    ({ app } = await buildApp(true));
    const res = await app.inject({ method: "GET", url: "/bad-gateway" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      statusCode: 502,
      error: "Bad Gateway",
      message: INTERNAL_ERROR_WIRE_MESSAGE,
    });
  });

  it("leaves 4xx bodies alone", async () => {
    const built = await buildApp(true);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/client-error" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: "slug is required" });
    expect(built.logger.warn).not.toHaveBeenCalled();
  });

  it("leaves Fastify's schema-validation 400 alone", async () => {
    ({ app } = await buildApp(true));
    const res = await app.inject({
      method: "POST",
      url: "/validated",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/must have required property 'a'/);
  });

  it("scrubs when NODE_ENV=production even if isProduction was passed false", async () => {
    process.env.NODE_ENV = "production";
    ({ app } = await buildApp(false));
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.json().message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
  });
});

describe("installErrorHandler keeps Sentry capture firing", () => {
  it.each(["/boom", "/nested-boom"])(
    "production %s: the onError hook (Sentry's capture path) sees the real error",
    async (url) => {
      const built = await buildApp(true);
      app = built.app;

      const res = await app.inject({ method: "GET", url });

      expect(res.json().message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
      expect(built.onErrorSpy).toHaveBeenCalledTimes(1);
      expect(built.onErrorSpy.mock.calls[0]![0]).toMatchObject({
        message: LEAK,
      });
    },
  );

  it("an http-errors style `status` is honoured and scrubbed", async () => {
    ({ app } = await buildApp(true));
    const res = await app.inject({ method: "GET", url: "/status-only" });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
  });
});

describe("installErrorHandler (development)", () => {
  it("keeps the real message for local debugging", async () => {
    process.env.NODE_ENV = "development";
    ({ app } = await buildApp(false));
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe(LEAK);
  });
});

describe("resolveErrorStatus", () => {
  it("mirrors Fastify's choice of status", () => {
    expect(resolveErrorStatus({ statusCode: 404 }, 200)).toBe(404);
    expect(resolveErrorStatus({ statusCode: undefined }, 200)).toBe(500);
    expect(resolveErrorStatus({ statusCode: 200 }, 200)).toBe(500);
    expect(resolveErrorStatus({ statusCode: undefined }, 409)).toBe(409);
    expect(resolveErrorStatus({ status: 404 }, 200)).toBe(404);
    expect(resolveErrorStatus({ status: 503 }, 200)).toBe(503);
    expect(resolveErrorStatus({ statusCode: 409, status: 503 }, 200)).toBe(409);
    expect(resolveErrorStatus({ status: 200 }, 200)).toBe(500);
  });
});
