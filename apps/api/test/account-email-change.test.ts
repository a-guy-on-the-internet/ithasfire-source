import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const testMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  randomInt: vi.fn(),
  authUserFindFirst: vi.fn(),
  authUserFindUnique: vi.fn(),
  orderFindFirst: vi.fn(),
  ticketFindFirst: vi.fn(),
  volunteerGroupFindFirst: vi.fn(),
  eventHumanFindFirst: vi.fn(),
  authVerificationDeleteMany: vi.fn(),
  authVerificationCreate: vi.fn(),
  mailerSend: vi.fn(),
  rateLimitConsume: vi.fn(),
  bansIsActive: vi.fn(),
  reportError: vi.fn(),
}));

const BAN_SECRET = "k".repeat(48);

vi.mock("node:crypto", async (importOriginal) => ({
  // Keep the real module (the recipient bucket HMACs with createHmac); only
  // the OTP generator is pinned.
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: testMocks.randomInt,
}));

vi.mock("@th/db", () => ({
  prisma: {
    authUser: {
      findFirst: testMocks.authUserFindFirst,
      findUnique: testMocks.authUserFindUnique,
    },
    order: { findFirst: testMocks.orderFindFirst },
    ticket: { findFirst: testMocks.ticketFindFirst },
    volunteerGroup: { findFirst: testMocks.volunteerGroupFindFirst },
    eventHuman: { findFirst: testMocks.eventHumanFindFirst },
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
      repos: { bans: { isActive: testMocks.bansIsActive } },
      clock: { now: () => new Date("2026-09-29T12:00:00.000Z") },
      identityHashSecret: BAN_SECRET,
      reportError: testMocks.reportError,
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
    testMocks.authUserFindUnique.mockResolvedValue({
      emailVerified: true,
      humanId: "human-1",
    });
    testMocks.orderFindFirst.mockResolvedValue(null);
    testMocks.ticketFindFirst.mockResolvedValue(null);
    testMocks.volunteerGroupFindFirst.mockResolvedValue(null);
    testMocks.eventHumanFindFirst.mockResolvedValue(null);
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
    testMocks.bansIsActive.mockResolvedValue(false);
  });

  // Ban that sticks (2026-09-29): a banned human's mailbox cannot be moved
  // onto an account, in any as-delivered variant.
  it("answers a banned address exactly like a normal request, but stores and sends nothing", async () => {
    const { createNetworkIdentityHasher } = await import(
      "@th/core/lib/security/network-identity"
    );
    const bannedHash = createNetworkIdentityHasher(BAN_SECRET).hashEmail(
      "banned.person@gmail.com",
    );
    testMocks.bansIsActive.mockImplementation(
      async ({ valueHash }: { valueHash: string }) => valueHash === bannedHash,
    );
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "BannedPerson+again@googlemail.com" },
    });

    // Indistinguishable from a successful request: not a ban-status probe.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
    expect(testMocks.mailerSend).not.toHaveBeenCalled();
    // Looked up by keyed hash only.
    expect(JSON.stringify(testMocks.bansIsActive.mock.calls)).not.toContain(
      "gmail",
    );
  });

  it("fails closed when the ban lookup errors (reported, no code sent)", async () => {
    testMocks.bansIsActive.mockRejectedValue(new Error("db down"));
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/account/email-change/request",
      payload: { newEmail: "new@example.com" },
    });

    expect(response.statusCode).toBe(500);
    expect(testMocks.reportError).toHaveBeenCalled();
    expect(testMocks.mailerSend).not.toHaveBeenCalled();
  });

  // B2: the change would verify the new address with the orders guest
  // checkout attached by email still on the account.
  describe("unverified account holding email-attached rows (B2)", () => {
    it("refuses with verify_current_email_first and stores or sends nothing", async () => {
      testMocks.authUserFindUnique.mockResolvedValue({
        emailVerified: false,
        humanId: "human-1",
      });
      testMocks.orderFindFirst.mockResolvedValue({ id: "order-1" });
      const app = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "squatter@example.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "verify_current_email_first",
      });
      expect(testMocks.authUserFindUnique).toHaveBeenCalledWith({
        where: { id: "auth-user-1" },
        select: { emailVerified: true, humanId: true },
      });
      expect(testMocks.orderFindFirst).toHaveBeenCalledWith({
        where: { buyerHumanId: "human-1" },
        select: { id: true },
      });
      expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses when the account holds only a ticket", async () => {
      testMocks.authUserFindUnique.mockResolvedValue({
        emailVerified: false,
        humanId: "human-1",
      });
      testMocks.ticketFindFirst.mockResolvedValue({ id: "ticket-1" });
      const app = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "squatter@example.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
    });

    it.each([
      ["only a coordinator seat", "volunteerGroupFindFirst", "coordinatorHumanId"],
      ["only a lineup link", "eventHumanFindFirst", "humanId"],
    ] as const)("refuses when the account holds %s", async (_l, mock, field) => {
      testMocks.authUserFindUnique.mockResolvedValue({
        emailVerified: false,
        humanId: "human-1",
      });
      testMocks[mock].mockResolvedValue({ id: "row-1" });
      const app = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "squatter@example.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "verify_current_email_first",
      });
      expect(testMocks[mock]).toHaveBeenCalledWith({
        where: { [field]: "human-1" },
        select: { id: true },
      });
      expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
    });

    it("lets an unverified account with nothing on it fix a typo", async () => {
      testMocks.authUserFindUnique.mockResolvedValue({
        emailVerified: false,
        humanId: "human-1",
      });
      const app = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "fixed@example.com" },
      });

      expect(response.statusCode).toBe(200);
      expect(testMocks.mailerSend).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("fails closed when the lookup errors (no code sent)", async () => {
      testMocks.authUserFindUnique.mockRejectedValue(new Error("db down"));
      const app = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "new@example.com" },
      });

      expect(response.statusCode).toBe(500);
      expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
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
          variables: expect.objectContaining({ code: "123456", purpose: "change-email" }),
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
  // ── 2026-09-29 review: per-IP and per-RECIPIENT buckets ────────────────
  describe("rate-limit buckets", () => {
    const keysConsumed = () =>
      testMocks.rateLimitConsume.mock.calls.map((c) => c[0] as string);

    it("consumes IP, user and recipient buckets, each 3/60s, in that order", async () => {
      const app = await makeApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        payload: { newEmail: "Victim@Example.com" },
      });

      expect(response.statusCode).toBe(200);
      const keys = keysConsumed();
      expect(keys).toHaveLength(3);
      expect(keys[0]).toBe("account-email-change:ip:203.0.113.7");
      expect(keys[1]).toBe("account-email-change:auth-user-1");
      expect(keys[2]).toMatch(/^account-email-change:to:[0-9a-f]{32}$/);
      for (const call of testMocks.rateLimitConsume.mock.calls) {
        expect(call.slice(1)).toEqual([3, 60]);
      }
      await app.close();
    });

    it("keys the recipient on an HMAC, never the raw address", async () => {
      const app = await makeApp();
      await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "victim@example.com" },
      });
      const recipientKey = keysConsumed().find((k) => k.includes(":to:"))!;
      expect(recipientKey).not.toContain("victim");
      expect(recipientKey).not.toContain("@");
      await app.close();
    });

    // The attack the per-user bucket missed: many throwaway accounts (and
    // IPs) aiming at ONE inbox all land on the same recipient bucket.
    it("different users + IPs targeting one inbox share the recipient bucket", async () => {
      const app = await makeApp();
      await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        payload: { newEmail: "Victim@Example.com" },
      });
      testMocks.getSession.mockResolvedValueOnce({
        user: { id: "auth-user-2", email: "other@example.com" },
      });
      await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        headers: { "cf-connecting-ip": "198.51.100.9" },
        payload: { newEmail: " victim@example.com " },
      });
      const recipientKeys = keysConsumed().filter((k) => k.includes(":to:"));
      expect(recipientKeys).toHaveLength(2);
      expect(recipientKeys[0]).toBe(recipientKeys[1]);
      await app.close();
    });

    it("a refused recipient bucket returns 429 and sends nothing", async () => {
      testMocks.rateLimitConsume.mockImplementation(async (key: string) =>
        key.includes(":to:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 17 }
          : { allowed: true, remaining: 2, retryAfterSeconds: 60 },
      );
      const app = await makeApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        payload: { newEmail: "victim@example.com" },
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("17");
      expect(testMocks.authVerificationCreate).not.toHaveBeenCalled();
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
    });

    it("a refused IP bucket short-circuits: the victim's recipient token is not spent", async () => {
      testMocks.rateLimitConsume.mockImplementation(async (key: string) =>
        key.includes(":ip:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
          : { allowed: true, remaining: 2, retryAfterSeconds: 60 },
      );
      const app = await makeApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/account/email-change/request",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        payload: { newEmail: "victim@example.com" },
      });

      expect(response.statusCode).toBe(429);
      expect(keysConsumed()).toEqual(["account-email-change:ip:203.0.113.7"]);
      expect(testMocks.mailerSend).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
