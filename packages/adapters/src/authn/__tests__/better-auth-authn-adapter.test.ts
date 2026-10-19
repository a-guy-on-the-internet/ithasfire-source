import { describe, expect, it, vi } from "vitest";

import {
  SID_REQUIRED_AFTER,
  createBetterAuthAuthNAdapterWithDeps,
} from "../better-auth-authn-adapter";

function makeReposMocks() {
  const getHumanIdForKey = vi.fn();

  // Key resolution runs on the ROOT repos (one statement, no tx: NFR-003);
  // a tx-scoped apiKeys would mean a BEGIN/COMMIT round trip per keyed call.
  const txGetHumanIdForKey = vi.fn(() => {
    throw new Error("key resolution must not open a transaction");
  });
  const repos = {
    apiKeys: { getHumanIdForKey },
    tx: async (fn: any) =>
      fn({
        apiKeys: { getHumanIdForKey: txGetHumanIdForKey },
      }),
  } as any;

  return { repos, getHumanIdForKey };
}

describe("BetterAuthAuthNAdapter", () => {
  it("parses provider user id from JWT sub", async () => {
    const verifyJwt = vi
      .fn()
      .mockResolvedValue({ sub: "user_123", sid: "sess_1" });
    const { repos } = makeReposMocks();

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.getProviderUserId({ token: "token-abc" }),
    ).resolves.toEqual({
      providerUserId: "user_123",
      sessionId: "sess_1",
    });

    expect(verifyJwt).toHaveBeenCalledWith("token-abc");
  });

  it("throws unauthorized when token verification fails", async () => {
    const verifyJwt = vi.fn().mockRejectedValue(new Error("bad token"));
    const { repos } = makeReposMocks();

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.getProviderUserId({ token: "bad" }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("resolves a human id for a valid api key", async () => {
    const verifyJwt = vi.fn();
    const { repos, getHumanIdForKey } = makeReposMocks();

    getHumanIdForKey.mockResolvedValue({
      apiKeyId: "key_1",
      humanId: "11111111-1111-4111-8111-111111111111",
      humanStatus: "ACTIVE",
      keyScope: { kind: "legacy", keyId: "key_1" },
    });

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHumanFromApiKey({ apiKey: "key-123" }),
    ).resolves.toEqual({
      humanId: "11111111-1111-4111-8111-111111111111",
      keyScope: { kind: "legacy", keyId: "key_1" },
    });
    expect(getHumanIdForKey).toHaveBeenCalledTimes(1);
  });

  it("returns the key scope resolved with a scoped key", async () => {
    const verifyJwt = vi.fn();
    const { repos, getHumanIdForKey } = makeReposMocks();
    const keyScope = {
      kind: "scoped",
      keyId: "key_2",
      requestId: "req_2",
      subject: "ORG",
      access: "READ",
      orgId: "org_2",
    } as const;
    getHumanIdForKey.mockResolvedValue({
      apiKeyId: "key_2",
      humanId: "11111111-1111-4111-8111-111111111111",
      humanStatus: "ACTIVE",
      keyScope,
    });

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHumanFromApiKey({ apiKey: "key-456" }),
    ).resolves.toEqual({
      humanId: "11111111-1111-4111-8111-111111111111",
      keyScope,
    });
  });

  it("throws unauthorized for invalid api keys", async () => {
    const verifyJwt = vi.fn();
    const { repos, getHumanIdForKey } = makeReposMocks();

    getHumanIdForKey.mockResolvedValue(null);

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHumanFromApiKey({ apiKey: "nope" }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("ensures authed human by looking up AuthUser link", async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: "auth_user_123" });
    const { repos } = makeReposMocks();

    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId: vi.fn().mockResolvedValue({
            humanId: "22222222-2222-4222-9222-222222222222",
            status: "ACTIVE",
          }),
          getAuthUserById: vi.fn(),
          ensureByProvider: vi.fn(),
        },
        entityPages: {
          getByOwner: vi.fn(),
          upsert: vi.fn(),
        },
      } as any),
    );

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_123" }),
    ).resolves.toEqual({ humanId: "22222222-2222-4222-9222-222222222222" });
  });

  it("auto-provisions a Human when AuthUser exists but has no linked Human", async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: "auth_user_456" });
    const { repos } = makeReposMocks();

    const getAuthActorForAuthUserId = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        humanId: "33333333-3333-4333-9333-333333333333",
        status: "ACTIVE",
        sessionActive: null,
      });
    const getAuthUserById = vi.fn().mockResolvedValue({
      id: "auth_user_456",
      email: "alice@example.com",
      name: "Alice",
      image: "https://img.example.com/alice.jpg",
    });
    const ensureByProvider = vi.fn().mockResolvedValue({
      humanId: "33333333-3333-4333-9333-333333333333",
      created: true,
    });
    const getByOwner = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue({
      id: "page-1",
      ownerType: "HUMAN",
      ownerId: "33333333-3333-4333-9333-333333333333",
      slug: "alice-33333333",
      displayName: "Alice",
    });

    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId,
          getAuthUserById,
          ensureByProvider,
        },
        entityPages: { getByOwner, upsert },
      } as any),
    );

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_456" }),
    ).resolves.toEqual({ humanId: "33333333-3333-4333-9333-333333333333" });

    expect(getAuthUserById).toHaveBeenCalledWith("auth_user_456");
    expect(ensureByProvider).toHaveBeenCalledWith({
      providerUserId: "auth_user_456",
      email: "alice@example.com",
      name: "Alice",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "HUMAN",
        ownerId: "33333333-3333-4333-9333-333333333333",
        displayName: "Alice",
        avatarUrl: "https://img.example.com/alice.jpg",
      }),
    );
  });

  it("skips entity page upsert when page already exists", async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: "auth_user_789" });
    const { repos } = makeReposMocks();

    const upsert = vi.fn();
    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
              humanId: "44444444-4444-4444-9444-444444444444",
              status: "ACTIVE",
              sessionActive: null,
            }),
          getAuthUserById: vi.fn().mockResolvedValue({
            id: "auth_user_789",
            email: "bob@example.com",
            name: "Bob",
            image: null,
          }),
          ensureByProvider: vi.fn().mockResolvedValue({
            humanId: "44444444-4444-4444-9444-444444444444",
            created: false,
          }),
        },
        entityPages: {
          getByOwner: vi.fn().mockResolvedValue({
            id: "page-2",
            ownerType: "HUMAN",
            ownerId: "44444444-4444-4444-9444-444444444444",
            slug: "bob-44444444",
            displayName: "Bob",
          }),
          upsert,
        },
      } as any),
    );

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_789" }),
    ).resolves.toEqual({ humanId: "44444444-4444-4444-9444-444444444444" });

    // Profile already existed, so upsert should NOT have been called
    expect(upsert).not.toHaveBeenCalled();
  });

  it("throws unauthorized when no AuthUser row exists at all", async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: "auth_user_123" });
    const { repos } = makeReposMocks();

    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId: vi.fn().mockResolvedValue(null),
          getAuthUserById: vi.fn().mockResolvedValue(null),
          ensureByProvider: vi.fn(),
        },
        entityPages: {
          getByOwner: vi.fn(),
          upsert: vi.fn(),
        },
      } as any),
    );

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_123" }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
  // ── F5: a ban must hold on every per-request auth path ──────────────────

  it.each(["SUSPENDED", "BANNED", "INVITED"] as const)(
    "refuses a valid api key whose owner is %s",
    async (humanStatus) => {
      const verifyJwt = vi.fn();
      const { repos, getHumanIdForKey } = makeReposMocks();
      getHumanIdForKey.mockResolvedValue({
        apiKeyId: "key_1",
        humanId: "11111111-1111-4111-8111-111111111111",
        humanStatus,
        keyScope: { kind: "legacy", keyId: "key_1" },
      });

      const adapter = createBetterAuthAuthNAdapterWithDeps({
        repos,
        verifyJwt,
      });

      await expect(
        adapter.ensureAuthedHumanFromApiKey({ apiKey: "key-123" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    },
  );

  it.each(["SUSPENDED", "BANNED", "INVITED"] as const)(
    "refuses a valid session/JWT whose human is %s",
    async (status) => {
      const verifyJwt = vi.fn();
      const { repos } = makeReposMocks();
      const getAuthUserById = vi.fn();
      repos.tx = vi.fn().mockImplementation(async (fn) =>
        fn({
          humans: {
            getAuthActorForAuthUserId: vi.fn().mockResolvedValue({
              humanId: "22222222-2222-4222-9222-222222222222",
              status,
            }),
            getAuthUserById,
            ensureByProvider: vi.fn(),
          },
          entityPages: { getByOwner: vi.fn(), upsert: vi.fn() },
        } as any),
      );

      const adapter = createBetterAuthAuthNAdapterWithDeps({
        repos,
        verifyJwt,
      });

      await expect(
        adapter.ensureAuthedHuman({ providerUserId: "auth_user_123" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      // Refused off the single hot-path read — no fallback provisioning.
      expect(getAuthUserById).not.toHaveBeenCalled();
    },
  );

  it("refuses when self-heal provisioning links to an existing BANNED human", async () => {
    const verifyJwt = vi.fn();
    const { repos } = makeReposMocks();
    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
              humanId: "44444444-4444-4444-9444-444444444444",
              status: "BANNED",
              sessionActive: null,
            }),
          getAuthUserById: vi.fn().mockResolvedValue({
            id: "auth_user_789",
            email: "bob@example.com",
            name: "Bob",
            image: null,
          }),
          ensureByProvider: vi.fn().mockResolvedValue({
            humanId: "44444444-4444-4444-9444-444444444444",
            created: false,
          }),
        },
        entityPages: {
          getByOwner: vi.fn().mockResolvedValue({ id: "page" }),
          upsert: vi.fn(),
        },
      } as any),
    );

    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_789" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  // ── Review round 2: JWTs are bound to their Better Auth session ─────────

  it("surfaces the sid claim as sessionId", async () => {
    const verifyJwt = vi
      .fn()
      .mockResolvedValue({ sub: "auth_user_123", sid: "sess_1" });
    const { repos } = makeReposMocks();
    const adapter = createBetterAuthAuthNAdapterWithDeps({ repos, verifyJwt });

    await expect(
      adapter.getProviderUserId({ token: "jwt" }),
    ).resolves.toEqual({ providerUserId: "auth_user_123", sessionId: "sess_1" });
  });

  function reposWithActor(actor: unknown) {
    const getAuthActorForAuthUserId = vi.fn().mockResolvedValue(actor);
    const { repos } = makeReposMocks();
    repos.tx = vi.fn().mockImplementation(async (fn) =>
      fn({
        humans: {
          getAuthActorForAuthUserId,
          getAuthUserById: vi.fn(),
          ensureByProvider: vi.fn(),
        },
        entityPages: { getByOwner: vi.fn(), upsert: vi.fn() },
      } as any),
    );
    return { repos, getAuthActorForAuthUserId };
  }

  it("refuses a JWT whose session was revoked (sweep / reset / ban), checked in the SAME read", async () => {
    const { repos, getAuthActorForAuthUserId } = reposWithActor({
      humanId: "22222222-2222-4222-9222-222222222222",
      status: "ACTIVE",
      sessionActive: false,
    });
    const adapter = createBetterAuthAuthNAdapterWithDeps({
      repos,
      verifyJwt: vi.fn(),
    });

    await expect(
      adapter.ensureAuthedHuman({
        providerUserId: "auth_user_123",
        sessionId: "sess_gone",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(getAuthActorForAuthUserId).toHaveBeenCalledTimes(1);
    expect(getAuthActorForAuthUserId).toHaveBeenCalledWith("auth_user_123", {
      sessionId: "sess_gone",
    });
  });

  it("accepts a JWT whose session is live", async () => {
    const { repos } = reposWithActor({
      humanId: "22222222-2222-4222-9222-222222222222",
      status: "ACTIVE",
      sessionActive: true,
    });
    const adapter = createBetterAuthAuthNAdapterWithDeps({
      repos,
      verifyJwt: vi.fn(),
    });

    await expect(
      adapter.ensureAuthedHuman({
        providerUserId: "auth_user_123",
        sessionId: "sess_live",
      }),
    ).resolves.toEqual({ humanId: "22222222-2222-4222-9222-222222222222" });
  });

  // Transitional: tokens minted before `definePayload` added `sid` (<=15 min
  // after deploy) carry no session to check.
  it("still accepts a legacy JWT without sid (sessionActive null)", async () => {
    const { repos } = reposWithActor({
      humanId: "22222222-2222-4222-9222-222222222222",
      status: "ACTIVE",
      sessionActive: null,
    });
    const adapter = createBetterAuthAuthNAdapterWithDeps({
      repos,
      verifyJwt: vi.fn(),
    });

    await expect(
      adapter.ensureAuthedHuman({ providerUserId: "auth_user_123" }),
    ).resolves.toEqual({ humanId: "22222222-2222-4222-9222-222222222222" });
  });
  // ── Review round 3: sid-less acceptance closes at SID_REQUIRED_AFTER ────

  describe("sid-less JWTs", () => {
    const CUTOFF = new Date("2026-09-30T05:00:00Z");
    const secs = (d: Date) => Math.floor(d.getTime() / 1000);
    const adapterFor = (payload: Record<string, unknown>) =>
      createBetterAuthAuthNAdapterWithDeps({
        repos: makeReposMocks().repos,
        verifyJwt: vi.fn().mockResolvedValue(payload),
        sidRequiredAfter: CUTOFF,
      });

    it("accepts a legacy token issued BEFORE the cutoff", async () => {
      await expect(
        adapterFor({
          sub: "u1",
          iat: secs(new Date(CUTOFF.getTime() - 60_000)),
        }).getProviderUserId({ token: "jwt" }),
      ).resolves.toEqual({ providerUserId: "u1" });
    });

    it("refuses a sid-less token issued AFTER the cutoff", async () => {
      await expect(
        adapterFor({
          sub: "u1",
          iat: secs(new Date(CUTOFF.getTime() + 60_000)),
        }).getProviderUserId({ token: "jwt" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    });

    it("refuses a sid-less token with no iat (fail closed)", async () => {
      await expect(
        adapterFor({ sub: "u1" }).getProviderUserId({ token: "jwt" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    });

    it("the production cutoff is a real instant, not left open-ended", () => {
      expect(Number.isFinite(SID_REQUIRED_AFTER.getTime())).toBe(true);
      // Guards against someone "fixing" a refusal by pushing it far out.
      expect(SID_REQUIRED_AFTER.getTime()).toBeLessThan(
        new Date("2026-11-01T00:00:00Z").getTime(),
      );
    });
  });
});
