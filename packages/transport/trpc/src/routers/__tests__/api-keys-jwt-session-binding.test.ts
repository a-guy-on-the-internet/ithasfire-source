import { describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { apiKeysRouter } from "../api-keys";
import { createCaller } from "./test-helpers";

/**
 * 2026-09-29 review, round 2: a 15-minute JWT used to outlive the session it
 * was minted from. After the account-takeover sweep (or a password reset, or
 * a ban) deleted every session, a JWT minted just before still worked — and
 * once the real owner had proven the inbox, `apiKeys.create` would accept it
 * and mint a PERMANENT credential for the squatter.
 *
 * The fix binds JWTs to their session (`sid` claim). These tests pin the
 * guard half of the chain: the `sid` read from the token is passed to
 * `ensureAuthedHuman`, and when the AuthN port refuses (its session is gone —
 * see `better-auth-authn-adapter.test.ts` for the adapter half), the key is
 * never created.
 */

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_SESSION = "session-live";
const REVOKED_SESSION = "session-revoked";

function buildAuthn(sessionIdInToken: string) {
  const unauthorized = Object.assign(new Error("Session for this token has ended"), {
    code: "unauthorized" as const,
  });
  return {
    getProviderUserId: vi.fn(async () => ({
      providerUserId: "auth-user-1",
      sessionId: sessionIdInToken,
    })),
    // Mirrors the adapter contract: only a live session authenticates.
    ensureAuthedHuman: vi.fn(async (input: { sessionId?: string }) => {
      if (input.sessionId !== LIVE_SESSION) throw unauthorized;
      return { humanId: HUMAN_ID };
    }),
    ensureAuthedHumanFromApiKey: vi.fn(),
  };
}

function buildRepos() {
  const apiKeys = {
    create: vi.fn(async () => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      key: "thk_minted",
      createdAt: new Date("2026-09-29T00:00:00Z"),
    })),
    lockAndCountActiveByHuman: vi.fn(async () => 0),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: HUMAN_ID },
      // The owner has just proven the inbox — the exact moment the old JWT
      // would otherwise pass `ensureEmailVerified`.
      identity: { emailVerified: true },
    })),
  };
  const audit = { log: vi.fn(async () => {}) };
  const txRepos = { apiKeys, humans, audit };
  return {
    repos: {
      ...txRepos,
      tx: async <T,>(fn: (tx: typeof txRepos) => Promise<T>) => fn(txRepos),
    } as any,
    apiKeys,
  };
}

describe("apiKeys.create with a session-bound JWT", () => {
  it("refuses a JWT minted from a session that has since been revoked, and mints nothing", async () => {
    const authn = buildAuthn(REVOKED_SESSION);
    const { repos, apiKeys } = buildRepos();
    const { caller } = createCaller(
      { apiKeys: router(apiKeysRouter) } as any,
      {
        authn: authn as any,
        repos,
        actorHumanId: null,
        auth: { userId: "auth-user-1", sessionId: null, token: "jwt" },
        authToken: "jwt",
      },
    );

    await expect(caller.apiKeys.create({ label: "late" })).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
    expect(authn.ensureAuthedHuman).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: REVOKED_SESSION }),
    );
    expect(apiKeys.create).not.toHaveBeenCalled();
  });

  it("still works for a JWT whose session is live (control)", async () => {
    const authn = buildAuthn(LIVE_SESSION);
    const { repos, apiKeys } = buildRepos();
    const { caller } = createCaller(
      { apiKeys: router(apiKeysRouter) } as any,
      {
        authn: authn as any,
        repos,
        actorHumanId: null,
        auth: { userId: "auth-user-1", sessionId: null, token: "jwt" },
        authToken: "jwt",
      },
    );

    await expect(caller.apiKeys.create({ label: "ok" })).resolves.toMatchObject(
      { key: "thk_minted" },
    );
    expect(apiKeys.create).toHaveBeenCalledTimes(1);
  });
});
