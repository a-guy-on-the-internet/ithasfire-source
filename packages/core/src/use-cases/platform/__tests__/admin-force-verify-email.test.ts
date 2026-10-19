import { describe, expect, it, vi } from "vitest";

import { adminForceVerifyEmail } from "../admin-force-verify-email";
import type { AdminForceVerifyEmailDeps } from "../admin-force-verify-email";
import {
  ACTOR_ID,
  TARGET_ID,
  makeHumanFixture,
  type HumanFixture,
} from "./_fixtures";

const FOOTPRINT = {
  hasPasswordCredential: true,
  linkedProviders: [],
  passkeys: 1,
  hasPhoneNumber: true,
  phoneNumberVerified: true,
  twoFactorEnabled: false,
  activeApiKeys: 2,
  delegateGrants: 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    target?: HumanFixture | null;
    holds?: boolean | Error;
  } = {},
): AdminForceVerifyEmailDeps {
  const allowed = overrides.allowed ?? true;
  const target =
    overrides.target !== undefined
      ? overrides.target
      : makeHumanFixture({ emailVerified: false });

  const humans = {
    getByIdWithIdentity: vi.fn(async () => target),
    forceVerifyEmail: vi.fn(),
    getSignInFootprint: vi.fn(async () => FOOTPRINT),
    holdsEmailAttachedRows: vi.fn(async () => {
      if (overrides.holds instanceof Error) throw overrides.holds;
      return overrides.holds ?? false;
    }),
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
    } as unknown as AdminForceVerifyEmailDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as AdminForceVerifyEmailDeps["authz"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminForceVerifyEmail", () => {
  it("force-verifies an unverified email", async () => {
    const deps = buildDeps();
    const result = await adminForceVerifyEmail(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
    });

    expect(result.humanId).toBe(TARGET_ID);
    expect(result.emailVerified).toBe(true);

    expect(deps.repos.humans.forceVerifyEmail).toHaveBeenCalledWith(TARGET_ID);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Human",
        entityId: TARGET_ID,
        action: "admin.forceVerifyEmail",
        data: expect.objectContaining({
          wasAlreadyVerified: false,
        }),
      }),
    );
  });

  it("is idempotent when email is already verified", async () => {
    const deps = buildDeps({
      target: makeHumanFixture({ emailVerified: true }),
    });
    const result = await adminForceVerifyEmail(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
    });

    expect(result.emailVerified).toBe(true);
    expect(deps.repos.humans.forceVerifyEmail).toHaveBeenCalledWith(TARGET_ID);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          wasAlreadyVerified: true,
        }),
      }),
    );
  });

  it("throws forbidden when actor lacks ADMIN role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      adminForceVerifyEmail(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when target human does not exist", async () => {
    const deps = buildDeps({ target: null });

    await expect(
      adminForceVerifyEmail(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });
  // 2026-09-29 review: force-verify skips the unproven-account sweep, so staff
  // must SEE what the account carries when they vouch for the address.
  it("returns and audits the sign-in footprint, read BEFORE the verify", async () => {
    const deps = buildDeps();
    const result = await adminForceVerifyEmail(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
    });

    expect(result.signInFootprint).toEqual(FOOTPRINT);
    expect(result.wasAlreadyVerified).toBe(false);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.forceVerifyEmail",
        data: expect.objectContaining({ signInFootprint: FOOTPRINT }),
      }),
    );
    const humans = deps.repos.humans as unknown as {
      getSignInFootprint: ReturnType<typeof vi.fn>;
      forceVerifyEmail: ReturnType<typeof vi.fn>;
    };
    expect(humans.getSignInFootprint.mock.invocationCallOrder[0]).toBeLessThan(
      humans.forceVerifyEmail.mock.invocationCallOrder[0]!,
    );
  });

  // B2 (owner ruling 2026-10-16): vouching for an unverified address that
  // holds email-attached rows would hand them to a possible squatter with no
  // sweep, so staff send the person to email-code sign-in instead.
  describe("unverified account holding email-attached rows", () => {
    type HumansMocks = {
      holdsEmailAttachedRows: ReturnType<typeof vi.fn>;
      forceVerifyEmail: ReturnType<typeof vi.fn>;
    };
    const mocks = (deps: AdminForceVerifyEmailDeps) =>
      deps.repos.humans as unknown as HumansMocks;

    it("refuses with FORCE_VERIFY_HOLDS_EMAIL_ATTACHED and verifies nothing", async () => {
      const deps = buildDeps({ holds: true });

      await expect(
        adminForceVerifyEmail(deps, {
          actorHumanId: ACTOR_ID,
          humanId: TARGET_ID,
        }),
      ).rejects.toMatchObject({ code: "FORCE_VERIFY_HOLDS_EMAIL_ATTACHED" });

      expect(mocks(deps).holdsEmailAttachedRows).toHaveBeenCalledWith(
        TARGET_ID,
      );
      expect(mocks(deps).forceVerifyEmail).not.toHaveBeenCalled();
      expect(deps.repos.audit.log).not.toHaveBeenCalled();
    });

    it("still verifies an unverified account that holds nothing", async () => {
      const deps = buildDeps({ holds: false });
      const result = await adminForceVerifyEmail(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
      });

      expect(result).toMatchObject({
        emailVerified: true,
        wasAlreadyVerified: false,
        signInFootprint: FOOTPRINT,
      });
      expect(mocks(deps).holdsEmailAttachedRows).toHaveBeenCalledWith(
        TARGET_ID,
      );
      expect(mocks(deps).forceVerifyEmail).toHaveBeenCalledWith(TARGET_ID);
      expect(deps.repos.audit.log).toHaveBeenCalledTimes(1);
    });

    it("does not check an already-verified account, even one holding rows", async () => {
      const deps = buildDeps({
        target: makeHumanFixture({ emailVerified: true }),
        holds: true,
      });
      const result = await adminForceVerifyEmail(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
      });

      expect(result.wasAlreadyVerified).toBe(true);
      expect(mocks(deps).holdsEmailAttachedRows).not.toHaveBeenCalled();
      expect(mocks(deps).forceVerifyEmail).toHaveBeenCalledWith(TARGET_ID);
    });

    it("fails closed when the lookup throws: no verify, no audit", async () => {
      const deps = buildDeps({ holds: new Error("db down") });

      await expect(
        adminForceVerifyEmail(deps, {
          actorHumanId: ACTOR_ID,
          humanId: TARGET_ID,
        }),
      ).rejects.toThrow("db down");

      expect(mocks(deps).forceVerifyEmail).not.toHaveBeenCalled();
      expect(deps.repos.audit.log).not.toHaveBeenCalled();
    });
  });
});
