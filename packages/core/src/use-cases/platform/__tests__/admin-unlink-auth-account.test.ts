import { describe, expect, it, vi } from "vitest";

import { adminUnlinkAuthAccount } from "../admin-unlink-auth-account";
import type { AdminUnlinkAuthAccountDeps } from "../admin-unlink-auth-account";
import {
  ACTOR_ID,
  TARGET_ID,
  makeHumanFixture,
  type HumanFixture,
} from "./_fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    target?: HumanFixture | null;
    unlinkThrows?: { code: string; message: string } | null;
    sessionsCount?: number;
    footprint?: { twoFactorEnabled: boolean; passkeys: number } | null;
  } = {},
): AdminUnlinkAuthAccountDeps {
  const allowed = overrides.allowed ?? true;
  const target =
    overrides.target !== undefined ? overrides.target : makeHumanFixture();
  const sessionsCount = overrides.sessionsCount ?? 2;

  const unlinkFn = overrides.unlinkThrows
    ? vi.fn(async () => {
        throw overrides.unlinkThrows;
      })
    : vi.fn();

  const humans = {
    getByIdWithIdentity: vi.fn(async () => target),
    unlinkAuthAccount: unlinkFn,
    getSignInFootprint: vi.fn(async () =>
      overrides.footprint !== undefined
        ? overrides.footprint
        : { twoFactorEnabled: false, passkeys: 0 },
    ),
    invalidateAllSessions: vi.fn(async () => ({ count: sessionsCount })),
  };

  const audit = { log: vi.fn() };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ humans, audit }),
  );

  return {
    repos: {
      humans,
      audit,
      tx,
    } as unknown as AdminUnlinkAuthAccountDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as AdminUnlinkAuthAccountDeps["authz"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminUnlinkAuthAccount", () => {
  it("unlinks a provider and invalidates sessions", async () => {
    const deps = buildDeps();
    const result = await adminUnlinkAuthAccount(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      providerId: "google",
    });

    expect(result.humanId).toBe(TARGET_ID);
    expect(result.unlinkedProviderId).toBe("google");
    expect(result.sessionsInvalidated).toBe(2);

    expect(deps.repos.humans.unlinkAuthAccount).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      providerId: "google",
    });
    expect(deps.repos.humans.invalidateAllSessions).toHaveBeenCalledWith(
      TARGET_ID,
    );
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Human",
        entityId: TARGET_ID,
        action: "admin.unlinkAuthAccount",
      }),
    );
  });

  it("throws forbidden when actor lacks ADMIN role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      adminUnlinkAuthAccount(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        providerId: "google",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when target human does not exist", async () => {
    const deps = buildDeps({ target: null });

    await expect(
      adminUnlinkAuthAccount(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        providerId: "google",
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("propagates conflict when unlinking the last auth method", async () => {
    const deps = buildDeps({
      unlinkThrows: {
        code: "conflict",
        message: "cannot_remove_last_auth_method",
      },
    });

    await expect(
      adminUnlinkAuthAccount(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        providerId: "credential",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "cannot_remove_last_auth_method",
    });

    // Sessions should NOT have been invalidated since unlink failed
    expect(deps.repos.humans.invalidateAllSessions).not.toHaveBeenCalled();
  });

  // A two-factor account must keep a password or a passkey: with neither,
  // a Google / Apple sign-in is its only way in and cannot be challenged.
  it("refuses to remove the password of a two-factor account that has no passkey", async () => {
    const deps = buildDeps({
      footprint: { twoFactorEnabled: true, passkeys: 0 },
    });

    await expect(
      adminUnlinkAuthAccount(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        providerId: "credential",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "two_factor_needs_password_or_passkey",
    });

    expect(deps.repos.humans.unlinkAuthAccount).not.toHaveBeenCalled();
    expect(deps.repos.humans.invalidateAllSessions).not.toHaveBeenCalled();
    expect(deps.repos.audit.log).not.toHaveBeenCalled();
  });

  it("removes the password of a two-factor account that has a passkey", async () => {
    const deps = buildDeps({
      footprint: { twoFactorEnabled: true, passkeys: 1 },
    });

    await adminUnlinkAuthAccount(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      providerId: "credential",
    });

    expect(deps.repos.humans.unlinkAuthAccount).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      providerId: "credential",
    });
  });

  it("removes the password of an account without two-factor", async () => {
    const deps = buildDeps({
      footprint: { twoFactorEnabled: false, passkeys: 0 },
    });

    await adminUnlinkAuthAccount(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      providerId: "credential",
    });

    expect(deps.repos.humans.unlinkAuthAccount).toHaveBeenCalled();
  });

  it("removes a provider from a two-factor account without reading the footprint", async () => {
    const deps = buildDeps({
      footprint: { twoFactorEnabled: true, passkeys: 0 },
    });

    await adminUnlinkAuthAccount(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      providerId: "google",
    });

    expect(deps.repos.humans.getSignInFootprint).not.toHaveBeenCalled();
    expect(deps.repos.humans.unlinkAuthAccount).toHaveBeenCalled();
  });
});
