import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// B2 (account squatting through guest checkout): POST /api/cart/release must
// not let an UNVERIFIED account release a held cart. An unverified account
// cannot check out, so any cart on it is a guest's embed checkout attached by
// email, and releasing it cancels that guest's payment.

const testMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  releaseCartHold: vi.fn(),
}));

vi.mock("@th/db", () => ({ prisma: {} }));
vi.mock("@th/adapters/db/prisma-repos", () => ({
  createPrismaRepos: () => ({}),
}));
vi.mock("@th/adapters/decorators/with-dependency-guard", () => ({
  withGuardedRepos: (repos: unknown) => repos,
}));
vi.mock("@th/core/use-cases/orders", () => ({
  releaseCartHold: testMocks.releaseCartHold,
}));
vi.mock("../src/auth/better-auth", () => ({
  auth: { api: { getSession: testMocks.getSession } },
}));

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

async function makeApp() {
  const { default: cartRoutes } = await import("../src/routes/cart");
  const app = Fastify({ logger: false });
  app.decorate("deps", {
    logger: makeLogger(),
    trpc: { payments: {}, reportError: vi.fn() },
  } as any);
  await app.register(cartRoutes as any);
  await app.ready();
  return app;
}

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/cart/release — unverified account (B2)", () => {
  beforeEach(() => {
    testMocks.getSession.mockReset();
    testMocks.releaseCartHold.mockReset();
    testMocks.releaseCartHold.mockResolvedValue({ released: true });
  });

  it("releases nothing for an unverified account", async () => {
    testMocks.getSession.mockResolvedValue({
      user: { id: "auth-user-1", emailVerified: false },
    });
    const app = await makeApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/cart/release",
      payload: { orderId: ORDER_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, released: false });
    expect(testMocks.releaseCartHold).not.toHaveBeenCalled();
    await app.close();
  });

  it("still releases for a verified account", async () => {
    testMocks.getSession.mockResolvedValue({
      user: { id: "auth-user-1", emailVerified: true },
    });
    const app = await makeApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/cart/release",
      payload: { orderId: ORDER_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, released: true });
    expect(testMocks.releaseCartHold).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
