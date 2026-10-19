import { describe, expect, it, vi } from "vitest";

import { createNetworkIdentityHasher } from "@th/core/lib/security/network-identity";

import {
  ACCOUNT_NOT_ACTIVE_ERROR,
  emailBeingSet,
  isEmailAllowedForAccount,
  networkContextFromHook,
  recordSightingFromHook,
  type SightingHookDeps,
} from "../src/auth/ban-gate";

const SECRET = "k".repeat(48);
const NOW = new Date("2026-09-29T12:00:00.000Z");

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTime: vi.fn(),
    log: vi.fn(),
  } as unknown as SightingHookDeps["logger"] & {
    error: ReturnType<typeof vi.fn>;
  };
}

describe("ACCOUNT_NOT_ACTIVE_ERROR", () => {
  it("is the same generic refusal the session gate answers with", () => {
    expect(ACCOUNT_NOT_ACTIVE_ERROR).toEqual({
      code: "ACCOUNT_NOT_ACTIVE",
      message: "This account is not active.",
    });
  });
});

describe("isEmailAllowedForAccount (sign-up / email-change gate)", () => {
  const hasher = createNetworkIdentityHasher(SECRET);
  const banned = new Set([hasher.hashEmail("banned.person@gmail.com")]);
  const deps = {
    repos: {
      bans: {
        isActive: vi.fn(async ({ valueHash }: { valueHash: string }) =>
          banned.has(valueHash),
        ),
      },
    },
    clock: { now: () => NOW },
    identitySecret: SECRET,
  } as unknown as Parameters<typeof isEmailAllowedForAccount>[0];

  it.each([
    "banned.person@gmail.com",
    "bannedperson+new@gmail.com",
    "Banned.Person@GoogleMail.com",
    "b.a.n.n.e.d.p.e.r.s.o.n@gmail.com",
  ])("refuses %s", async (email) => {
    await expect(isEmailAllowedForAccount(deps, email)).resolves.toBe(false);
  });

  it("allows any other mailbox, and a missing email", async () => {
    await expect(
      isEmailAllowedForAccount(deps, "someone.else@gmail.com"),
    ).resolves.toBe(true);
    await expect(isEmailAllowedForAccount(deps, undefined)).resolves.toBe(true);
  });
});

describe("emailBeingSet", () => {
  it("reads the new email off a user.update patch", () => {
    expect(emailBeingSet({ email: "new@example.com" })).toBe("new@example.com");
    expect(emailBeingSet({ emailVerified: true })).toBeNull();
    expect(emailBeingSet({ email: "" })).toBeNull();
    expect(emailBeingSet(null)).toBeNull();
  });
});

describe("networkContextFromHook", () => {
  it("takes the client IP by the platform precedence (cf-connecting-ip first)", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
      "cf-ipcountry": "NL",
      "user-agent": "curl/8.7.1",
    });
    expect(networkContextFromHook({ headers })).toEqual({
      clientIp: "203.0.113.9",
      countryHeader: "NL",
      userAgent: "curl/8.7.1",
    });
  });

  it("falls back to the leftmost x-forwarded-for; never to a stored session IP", () => {
    expect(
      networkContextFromHook({
        request: {
          headers: new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }),
        },
      }).clientIp,
    ).toBe("198.51.100.1");
    // Sessions no longer hold an IP; only the user agent may fall back.
    expect(
      networkContextFromHook(null, {
        ipAddress: "192.0.2.5",
        userAgent: "UA",
      } as { userAgent: string }),
    ).toEqual({ clientIp: null, countryHeader: null, userAgent: "UA" });
  });

  it("clips oversized client-written headers", () => {
    const ctx = {
      headers: new Headers({ "user-agent": "x".repeat(10_000) }),
    };
    expect(networkContextFromHook(ctx).userAgent).toHaveLength(4096);
  });
});

describe("recordSightingFromHook (best-effort)", () => {
  function makeDeps(overrides: Partial<SightingHookDeps> = {}) {
    const record = vi.fn(async () => undefined);
    const logger = makeLogger();
    const deps = {
      repos: { networkSightings: { record } },
      identitySecret: SECRET,
      logger,
      reportError: vi.fn(),
      loadHumanIdForAuthUser: vi.fn(
        async () => "22222222-2222-4222-8222-222222222222",
      ),
      ...overrides,
    } as unknown as SightingHookDeps;
    return { deps, record, logger };
  }

  const ctx = { headers: new Headers({ "cf-connecting-ip": "203.0.113.9" }) };

  it("records a sign-in with the linked human and only hashes", async () => {
    const { deps, record } = makeDeps();
    await expect(
      recordSightingFromHook(deps, {
        authUserId: "auth-1",
        kind: "SIGN_IN",
        ctx,
      }),
    ).resolves.toBe("recorded");
    const arg = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.humanId).toBe("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(arg)).not.toContain("203.0.113");
  });

  it("never throws when the human lookup fails: logged at ERROR and reported", async () => {
    const boom = new Error("db down");
    const { deps, record, logger } = makeDeps({
      loadHumanIdForAuthUser: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(
      recordSightingFromHook(deps, {
        authUserId: "auth-1",
        kind: "SIGN_IN",
        ctx,
      }),
    ).resolves.toBe("failed");
    expect(record).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "auth.network_sighting.hook_failed",
      expect.objectContaining({ err: boom }),
    );
    expect(deps.reportError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it("never throws when the write fails, even if the reporter throws too", async () => {
    const { deps } = makeDeps({
      repos: {
        networkSightings: {
          record: vi.fn(async () => {
            throw new Error("db down");
          }),
        },
      } as unknown as SightingHookDeps["repos"],
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await expect(
      recordSightingFromHook(deps, {
        authUserId: "auth-1",
        humanId: null,
        kind: "SIGN_UP",
        ctx,
      }),
    ).resolves.toBe("failed");
  });
});
