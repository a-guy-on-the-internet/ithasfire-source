import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBetterAuthAuthNAdapter } from "../better-auth-authn-adapter";

// `jose` is pulled in via a lazy `await import("jose")` inside the adapter, so
// the mock has to be hoisted above the module graph.
const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: (...args: unknown[]) => jose.createRemoteJWKSet(...args),
  jwtVerify: (...args: unknown[]) => jose.jwtVerify(...args),
}));

const JWKS_URL = "https://auth.example.test/api/auth/jwks";

function makeRepos() {
  return { tx: vi.fn() } as never;
}

describe("createBetterAuthAuthNAdapter — JWKS resolver reuse", () => {
  beforeEach(() => {
    jose.createRemoteJWKSet.mockReset();
    jose.jwtVerify.mockReset();
    jose.createRemoteJWKSet.mockImplementation(() => "jwks-resolver");
    // Session-bound, as every token minted since the sid binding is.
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: "auth_user_1", sid: "session_1" },
    });
  });

  it("builds the remote JWKS resolver once across many verifications", async () => {
    const adapter = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: JWKS_URL,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        adapter.getProviderUserId({ token: `token-${i}` }),
      ).resolves.toEqual({ providerUserId: "auth_user_1", sessionId: "session_1" });
    }

    // The resolver caches the fetched key set internally; rebuilding it per
    // call is what made every authenticated request re-fetch /api/auth/jwks.
    expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(new URL(JWKS_URL));
    expect(jose.jwtVerify).toHaveBeenCalledTimes(5);
    // Every verification reuses the SAME resolver instance.
    for (const call of jose.jwtVerify.mock.calls) {
      expect(call[1]).toBe("jwks-resolver");
    }
  });

  it("does not race a second resolver when cold-start calls are concurrent", async () => {
    const adapter = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: JWKS_URL,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        adapter.getProviderUserId({ token: `token-${i}` }),
      ),
    );

    expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  it("keeps the resolver scoped per adapter instance", async () => {
    const a = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: JWKS_URL,
    });
    const b = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: "https://other.example.test/api/auth/jwks",
    });

    await a.getProviderUserId({ token: "token-a" });
    await b.getProviderUserId({ token: "token-b" });

    expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed initialisation", async () => {
    jose.createRemoteJWKSet.mockImplementationOnce(() => {
      throw new Error("jwks init blew up");
    });

    const adapter = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: JWKS_URL,
    });

    await expect(
      adapter.getProviderUserId({ token: "token-1" }),
    ).rejects.toMatchObject({ code: "unauthorized" });

    // A transient init failure must not poison the adapter for the lifetime of
    // the process — the next call retries and succeeds.
    await expect(
      adapter.getProviderUserId({ token: "token-2" }),
    ).resolves.toEqual({ providerUserId: "auth_user_1", sessionId: "session_1" });

    expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(2);
  });

  it("passes issuer/audience through and surfaces verification failures", async () => {
    jose.jwtVerify.mockRejectedValueOnce(new Error("JWTExpired"));

    const adapter = createBetterAuthAuthNAdapter({
      repos: makeRepos(),
      jwksUrl: JWKS_URL,
      issuer: "https://auth.example.test",
      audience: "https://api.example.test",
    });

    await expect(
      adapter.getProviderUserId({ token: "expired" }),
    ).rejects.toMatchObject({ code: "unauthorized" });

    expect(jose.jwtVerify).toHaveBeenCalledWith("expired", "jwks-resolver", {
      issuer: "https://auth.example.test",
      audience: "https://api.example.test",
    });
  });
});
