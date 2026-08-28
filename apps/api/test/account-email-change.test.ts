import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const testMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  randomInt: vi.fn(),
  authUserFindFirst: vi.fn(),
  authVerificationDeleteMany: vi.fn(),
  authVerificationCreate: vi.fn(),
  mailerSend: vi.fn(),
  rateLimitConsume: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomInt: testMocks.randomInt,
}));

vi.mock("@th/db", () => ({
  prisma: {
    authUser: {
      findFirst: testMocks.authUserFindFirst,
    },
    authVerification: {
      deleteMany: testMocks.authVerificationDeleteMany,
      create: testMocks.authVerificationCreate,
    },
  },
}));

vi.mock("../src/auth/better-auth", () => ({
  auth: {
    api: {
      getSession: testMocks.getSession,
    },
  },
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
  };

  return logger;
}

async function makeApp() {
  const { default: accountEmailChange } = await import(
    "../src/routes/account/email-change"
  );
  const app = Fastify({ logger: false });
  app.decorate("deps", {
    logger: makeLogger(),
    mailer: {
      send: testMocks.mailerSend,
    },
    trpc: {
      rateLimit: {
        consume: testMocks.rateLimitConsume,
      },
    },
  } as any);
  await app.register(accountEmailChange as any);
  return app;
}

describe("account email-change OTP request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.randomInt.mockReturnValue(123456);
    testMocks.getSession.mockResolvedValue({
      user: { id: "auth-user-1", email: "Current@Example.com" },
    });
    testMocks.authUserFindFirst.mockResolvedValue(null);
    testMocks.authVerificationDeleteMany.mockResolvedValue({ count: 1 });
    testMocks.authVerificationCreate.mockResolvedValue({ id: "verification-1" });
    testMocks.mailerSend.mockResolvedValue({
      result: { success: true, id: "email-1" },
    });
    testMocks.rateLimitConsume.mockResolvedValue({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 60,
    });
  });

  it("stores the Better Auth change-email OTP and sends it synchronously", async () => {
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "  New@Example.COM " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(testMocks.authVerificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        identifier: "change-email-otp-current@example.com-new@example.com",
        value: "123456:0",
        expiresAt: expect.any(Date),
      }),
    });
    expect(testMocks.mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "new@example.com" },
        template: expect.objectContaining({
          key: "auth.verification_code",
          variables: expect.objectContaining({ code: "123456" }),
        }),
      }),
    );
    expect(testMocks.rateLimitConsume).toHaveBeenCalledWith(
      "account-email-change:auth-user-1",
      3,
      60,
    );

    await app.close();
  });

  it("does not disclose when the requested email belongs to another account", async () => {
    testMocks.authUserFindFirst.mockResolvedValueOnce({ id: "other-user" });
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "taken@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(testMocks.authVerificationDeleteMany).toHaveBeenCalledWith({
      where: {
        identifier: "change-email-otp-current@example.com-taken@example.com",
      },
    });
    expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
    expect(testMocks.mailerSend).not.toHaveBeenCalled();

    await app.close();
  });

  it("rate-limits OTP request attempts before writing or sending", async () => {
    testMocks.rateLimitConsume.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    });
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "new@example.com" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("42");
    expect(response.json()).toEqual({
      ok: false,
      error: "rate_limited",
      message: "Too many verification code requests. Try again shortly.",
    });
    expect(testMocks.authUserFindFirst).not.toHaveBeenCalled();
    expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
    expect(testMocks.mailerSend).not.toHaveBeenCalled();

    await app.close();
  });

  it("deletes the stored OTP and returns an error when the mailer fails", async () => {
    testMocks.mailerSend.mockResolvedValueOnce({
      result: {
        success: false,
        errorCode: "conflict",
        errorMessage: "recipient_suppressed",
      },
    });
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "new@example.com" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "email_send_failed",
      message: "Could not send verification code.",
    });
    expect(testMocks.authVerificationCreate).toHaveBeenCalled();
    expect(testMocks.authVerificationDeleteMany).toHaveBeenCalledTimes(2);
    expect(testMocks.authVerificationDeleteMany).toHaveBeenLastCalledWith({
      where: {
        identifier: "change-email-otp-current@example.com-new@example.com",
      },
    });

    await app.close();
  });
});
