import { describe, expect, it, vi } from "vitest";

import { adminSetHumanStatus } from "../admin-set-human-status";
import type { AdminSetHumanStatusDeps } from "../admin-set-human-status";
import { createNetworkIdentityHasher } from "../../../lib/security/network-identity";
import { isEmailBanned } from "../../auth/check-banned-email";
import {
  ACTOR_ID,
  NOW,
  TARGET_EMAIL,
  TARGET_ID,
  makeHumanFixture,
  type HumanFixture,
} from "./_fixtures";

const SECRET = "k".repeat(48);
const DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    target?: HumanFixture | null;
    sessionsCount?: number;
    apiKeysCount?: number;
    apiKeyRequestsClosed?: number;
    networkHashes?: string[];
    existingBanRows?: number;
    identitySecret?: string | null;
    mailboxAccounts?: Array<{ authUserId: string; humanId: string | null }>;
  } = {},
): AdminSetHumanStatusDeps {
  const allowed = overrides.allowed ?? true;
  const target =
    overrides.target !== undefined ? overrides.target : makeHumanFixture();
  const sessionsCount = overrides.sessionsCount ?? 3;
  const apiKeysCount = overrides.apiKeysCount ?? 2;
  const apiKeyRequestsClosed = overrides.apiKeyRequestsClosed ?? 0;

  const humans = {
    getByIdWithIdentity: vi.fn(async () => target),
    update: vi.fn(async () => ({ ...target?.human, status: "SUSPENDED" })),
    invalidateAllSessions: vi.fn(async () => ({ count: sessionsCount })),
    // Default: the mailbox holds only the target's own account.
    listAuthUsersByCanonicalEmail: vi.fn(
      async () =>
        overrides.mailboxAccounts ?? [
          { authUserId: "aa-bb-cc", humanId: TARGET_ID },
        ],
    ),
    invalidateSessionsForAuthUsers: vi.fn(async (ids: string[]) => ({
      count: ids.length * 2,
    })),
  };

  const apiKeys = {
    // The repo's real result shape (RevokeAllApiKeysForHumanResult).
    revokeAllForHuman: vi.fn(async () => ({
      count: apiKeysCount,
      closedRequestCount: apiKeyRequestsClosed,
    })),
  };

  const audit = { log: vi.fn() };

  const bans = {
    removeForHuman: vi.fn(async () => ({
      count: overrides.existingBanRows ?? 0,
    })),
    recordForHuman: vi.fn(async ({ rows }: { rows: unknown[] }) => ({
      count: rows.length,
    })),
  };
  const networkSightings = {
    listNetworkHashesForHuman: vi.fn(async () => overrides.networkHashes ?? []),
  };

  // tx passes the same repo stubs through to the callback
  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ humans, apiKeys, audit, bans, networkSightings }),
  );

  return {
    repos: {
      humans,
      apiKeys,
      audit,
      bans,
      networkSightings,
      tx,
    } as unknown as AdminSetHumanStatusDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as AdminSetHumanStatusDeps["authz"],
    clock: { now: () => NOW },
    identitySecret:
      overrides.identitySecret === undefined
        ? SECRET
        : overrides.identitySecret,
    reportError: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminSetHumanStatus", () => {
  it("suspends a human and invalidates sessions", async () => {
    const deps = buildDeps();
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "SUSPENDED",
      reason: "Policy violation",
    });

    expect(result.humanId).toBe(TARGET_ID);
    expect(result.status).toBe("SUSPENDED");
    expect(result.sessionsInvalidated).toBe(3);

    expect(deps.repos.humans.update).toHaveBeenCalledWith(TARGET_ID, {
      status: "SUSPENDED",
    });
    expect(deps.repos.humans.invalidateAllSessions).toHaveBeenCalledWith(
      TARGET_ID,
    );
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Human",
        entityId: TARGET_ID,
        action: "admin.setHumanStatus",
      }),
    );
  });

  it("bans a human and invalidates sessions", async () => {
    const deps = buildDeps();
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });

    expect(result.status).toBe("BANNED");
    expect(result.sessionsInvalidated).toBe(3);
    expect(deps.repos.humans.invalidateAllSessions).toHaveBeenCalledWith(
      TARGET_ID,
    );
  });

  it("reactivates a human without invalidating sessions", async () => {
    const deps = buildDeps({ sessionsCount: 0 });
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "ACTIVE",
    });

    expect(result.status).toBe("ACTIVE");
    expect(result.sessionsInvalidated).toBe(0);
    expect(result.apiKeysRevoked).toBe(0);
    expect(deps.repos.humans.invalidateAllSessions).not.toHaveBeenCalled();
    expect(deps.repos.apiKeys.revokeAllForHuman).not.toHaveBeenCalled();
  });

  // F5 (2026-09-29 review): a ban used to end sessions only, so API keys —
  // long-lived bearer credentials — kept working for the banned human.
  it.each(["SUSPENDED", "BANNED"] as const)(
    "%s revokes every API key the human owns, inside the transaction, and audits the count",
    async (status) => {
      const deps = buildDeps({ apiKeysCount: 4, apiKeyRequestsClosed: 2 });
      const result = await adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status,
      });

      expect(result.apiKeysRevoked).toBe(4);
      expect(deps.repos.apiKeys.revokeAllForHuman).toHaveBeenCalledWith({
        humanId: TARGET_ID,
      });
      expect(deps.repos.tx).toHaveBeenCalledTimes(1);
      expect(deps.repos.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          // R31: the key requests the ban closed are audited too.
          data: expect.objectContaining({
            apiKeysRevoked: 4,
            apiKeyRequestsClosed: 2,
          }),
        }),
      );
    },
  );

  it("does not commit the status change when key revocation fails", async () => {
    const deps = buildDeps();
    (
      deps.repos.apiKeys.revokeAllForHuman as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("db down"));

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status: "BANNED",
      }),
    ).rejects.toThrow("db down");
    // Throwing out of repos.tx() rolls the status update back; no audit row.
    expect(deps.repos.audit.log).not.toHaveBeenCalled();
  });

  // ── Ban that sticks (2026-09-29) ─────────────────────────────────────────

  it("BANNED records the email hash and every recent network hash, in the same tx", async () => {
    const deps = buildDeps({ networkHashes: ["net-a", "net-b", "net-a"] });

    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });

    const hasher = createNetworkIdentityHasher(SECRET);
    expect(
      deps.repos.networkSightings.listNetworkHashesForHuman,
    ).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      since: new Date(NOW.getTime() - 30 * DAY),
    });
    expect(deps.repos.bans.recordForHuman).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      rows: [
        {
          kind: "EMAIL",
          valueHash: hasher.hashEmail(TARGET_EMAIL),
          expiresAt: null,
        },
        {
          kind: "NETWORK",
          valueHash: "net-a",
          expiresAt: new Date(NOW.getTime() + 30 * DAY),
        },
        {
          kind: "NETWORK",
          valueHash: "net-b",
          expiresAt: new Date(NOW.getTime() + 30 * DAY),
        },
      ],
    });
    expect(result.bannedIdentitiesRecorded).toBe(3);
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bannedIdentitiesRecorded: 3 }),
      }),
    );
    // No plaintext address is written anywhere.
    expect(
      JSON.stringify(
        (deps.repos.bans.recordForHuman as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain(TARGET_EMAIL);
  });

  it("the recorded email hash is exactly what the sign-up gate looks up (+tag / case variants included)", async () => {
    const deps = buildDeps();
    await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });
    const { rows } = (
      deps.repos.bans.recordForHuman as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { rows: Array<{ kind: string; valueHash: string }> };
    const stored = new Set(
      rows.filter((r) => r.kind === "EMAIL").map((r) => r.valueHash),
    );
    const gateDeps = {
      repos: {
        bans: {
          isActive: async ({ valueHash }: { valueHash: string }) =>
            stored.has(valueHash),
        },
      },
      clock: { now: () => NOW },
      identitySecret: SECRET,
    } as unknown as Parameters<typeof isEmailBanned>[0];
    // TARGET_EMAIL is jane@example.com
    await expect(
      isEmailBanned(gateDeps, "Jane+again@Example.com"),
    ).resolves.toBe(true);
    await expect(isEmailBanned(gateDeps, "someone@example.com")).resolves.toBe(
      false,
    );
  });

  it("a re-ban upserts and removes nothing, so earlier coverage is kept", async () => {
    const deps = buildDeps({ existingBanRows: 2, networkHashes: ["net-a"] });
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });
    expect(deps.repos.bans.removeForHuman).not.toHaveBeenCalled();
    expect(deps.repos.bans.recordForHuman).toHaveBeenCalledTimes(1);
    expect(result.bannedIdentitiesRemoved).toBe(0);
    expect(result.bannedIdentitiesRecorded).toBe(2);
  });

  // Owner ruling 2026-09-29: SUSPENDED carries the same email / network
  // block as BANNED; only reactivation lifts it.
  it("reactivating (ACTIVE) removes the human's identities and records none", async () => {
    const deps = buildDeps({ existingBanRows: 4 });
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "ACTIVE",
    });
    expect(deps.repos.bans.removeForHuman).toHaveBeenCalledWith(TARGET_ID);
    expect(deps.repos.bans.recordForHuman).not.toHaveBeenCalled();
    expect(result.bannedIdentitiesRemoved).toBe(4);
    expect(result.bannedIdentitiesRecorded).toBe(0);
  });

  it("SUSPENDED records the same email and network rows as BANNED", async () => {
    const banned = buildDeps({ networkHashes: ["net-a"] });
    const suspended = buildDeps({ networkHashes: ["net-a"] });
    await adminSetHumanStatus(banned, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });
    const result = await adminSetHumanStatus(suspended, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "SUSPENDED",
    });
    expect(suspended.repos.bans.recordForHuman).toHaveBeenCalledWith(
      (banned.repos.bans.recordForHuman as ReturnType<typeof vi.fn>).mock
        .calls[0]![0],
    );
    expect(result.bannedIdentitiesRecorded).toBe(2);
  });

  it("BANNED → SUSPENDED keeps the rows (upsert, nothing removed)", async () => {
    const deps = buildDeps({ existingBanRows: 2, networkHashes: ["net-a"] });
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "SUSPENDED",
    });
    expect(deps.repos.bans.removeForHuman).not.toHaveBeenCalled();
    expect(deps.repos.bans.recordForHuman).toHaveBeenCalledTimes(1);
    expect(result.bannedIdentitiesRemoved).toBe(0);
  });

  it("does not commit the ban when recording identities fails", async () => {
    const deps = buildDeps();
    (
      deps.repos.bans.recordForHuman as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("db down"));
    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status: "BANNED",
      }),
    ).rejects.toThrow("db down");
    expect(deps.repos.audit.log).not.toHaveBeenCalled();
  });

  it("without a secret the ban still applies, records no identities, and reports", async () => {
    const deps = buildDeps({ identitySecret: null });
    const result = await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });
    expect(result.status).toBe("BANNED");
    expect(result.sessionsInvalidated).toBe(3);
    expect(deps.repos.bans.recordForHuman).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "banned_identity_secret_missing" }),
      expect.anything(),
    );
  });

  // Review round 2: alt accounts on the banned mailbox are signed out and lose
  // their API keys in the ban tx; the count is audited.
  it("BANNED signs out every OTHER account on the same mailbox and revokes its API keys", async () => {
    const ALT_HUMAN = "33333333-3333-4333-8333-333333333333";
    const deps = buildDeps({
      apiKeysCount: 1,
      apiKeyRequestsClosed: 3,
      mailboxAccounts: [
        { authUserId: "aa-bb-cc", humanId: TARGET_ID }, // the banned account
        { authUserId: "alt-linked", humanId: ALT_HUMAN },
        { authUserId: "alt-shadow", humanId: null }, // unlinked shadow
      ],
    });

    await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "BANNED",
    });

    // Looked up by the canonical (as-delivered) mailbox.
    expect(
      deps.repos.humans.listAuthUsersByCanonicalEmail,
    ).toHaveBeenCalledWith("jane@example.com");
    expect(
      deps.repos.humans.invalidateSessionsForAuthUsers,
    ).toHaveBeenCalledWith(["alt-linked", "alt-shadow"]);
    // Target's keys + the linked alt's keys; the shadow has no Human.
    expect(deps.repos.apiKeys.revokeAllForHuman).toHaveBeenCalledWith({
      humanId: ALT_HUMAN,
    });
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          altAccountsSignedOut: 2,
          altSessionsInvalidated: 4,
          altApiKeysRevoked: 1,
          apiKeyRequestsClosed: 3,
          altApiKeyRequestsClosed: 3,
        }),
      }),
    );
  });

  it("SUSPENDED also signs out alt accounts on the mailbox", async () => {
    const deps = buildDeps({
      mailboxAccounts: [{ authUserId: "alt", humanId: null }],
    });
    await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "SUSPENDED",
    });
    expect(
      deps.repos.humans.invalidateSessionsForAuthUsers,
    ).toHaveBeenCalledWith(["alt"]);
  });

  it("reactivation does not touch alt accounts", async () => {
    const deps = buildDeps({
      mailboxAccounts: [{ authUserId: "alt", humanId: null }],
    });
    await adminSetHumanStatus(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      status: "ACTIVE",
    });
    expect(
      deps.repos.humans.listAuthUsersByCanonicalEmail,
    ).not.toHaveBeenCalled();
    expect(
      deps.repos.humans.invalidateSessionsForAuthUsers,
    ).not.toHaveBeenCalled();
  });

  it("throws forbidden when actor lacks ADMIN role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status: "SUSPENDED",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws forbidden when actor tries to change own status", async () => {
    const deps = buildDeps();

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: ACTOR_ID,
        status: "SUSPENDED",
      }),
    ).rejects.toMatchObject({ code: "CANNOT_CHANGE_OWN_STATUS" });
  });

  it("throws not_found when target human does not exist", async () => {
    const deps = buildDeps({ target: null });

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status: "SUSPENDED",
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("rejects invalid input (bad UUID)", async () => {
    const deps = buildDeps();

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: "not-a-uuid",
        humanId: TARGET_ID,
        status: "SUSPENDED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid status value", async () => {
    const deps = buildDeps();

    await expect(
      adminSetHumanStatus(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        status: "INVITED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
