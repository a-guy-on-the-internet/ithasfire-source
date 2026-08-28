import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * `isProd` in origin-guard.ts is computed once at module load time from
 * `process.env.NODE_ENV`, so NODE_ENV must be set to "production" *before*
 * the plugin is imported. `env.ORIGIN_SHARED_SECRET` / `env.ENFORCE_ORIGIN_SECRET`
 * are read live inside the onRequest hook on every request, so the mocked
 * `env` object below can be mutated per-test without re-importing.
 */
const SECRET = "a".repeat(32);

const envMock = vi.hoisted(() => ({
  ORIGIN_SHARED_SECRET: "a".repeat(32),
  ENFORCE_ORIGIN_SECRET: false,
}));

vi.mock("../src/lib/env", () => ({ env: envMock }));

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
  };

  return logger;
}

describe("origin-guard plugin", () => {
  let originGuard: typeof import("../src/plugins/origin-guard").default;
  let app: FastifyInstance;
  let logger: ReturnType<typeof makeLogger>;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    ({ default: originGuard } = await import("../src/plugins/origin-guard"));
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(async () => {
    envMock.ORIGIN_SHARED_SECRET = SECRET;
    envMock.ENFORCE_ORIGIN_SECRET = false;

    logger = makeLogger();
    app = Fastify({ logger: false });
    app.decorate("deps", { logger } as any);
    await app.register(originGuard);
    app.get("/health", async () => ({ ok: true }));
    app.get("/protected", async () => ({ ok: true }));
    await app.ready();
  });

  it("proceeds when the header matches the shared secret", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-origin-secret": SECRET },
    });

    expect(response.statusCode).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw on a mismatched-length header and treats it as a mismatch", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-origin-secret": "short" },
    });

    // Log-only by default (ENFORCE_ORIGIN_SECRET=false) — if the
    // length-mismatch guard didn't work, timingSafeEqual would throw and
    // this would come back 500 instead of 200.
    expect(response.statusCode).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "origin_secret_mismatch",
      expect.objectContaining({ path: "/protected" }),
    );
  });

  it("treats a missing header as a mismatch", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/protected",
    });

    expect(response.statusCode).toBe(200); // log-only default
    expect(logger.warn).toHaveBeenCalledWith(
      "origin_secret_mismatch",
      expect.objectContaining({ path: "/protected" }),
    );
  });

  it("does not block a mismatch when ENFORCE_ORIGIN_SECRET is false (rollout default)", async () => {
    envMock.ENFORCE_ORIGIN_SECRET = false;

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-origin-secret": "wrong-value-wrong-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("blocks with 403 when ENFORCE_ORIGIN_SECRET is true and the header mismatches", async () => {
    envMock.ENFORCE_ORIGIN_SECRET = true;

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-origin-secret": "wrong-value-wrong-value" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "origin_secret_mismatch" });
  });

  it("exempts /health regardless of query string (routeOptions, not raw request.url)", async () => {
    envMock.ENFORCE_ORIGIN_SECRET = true;

    const response = await app.inject({
      method: "GET",
      url: "/health?foo=bar",
    });

    expect(response.statusCode).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
