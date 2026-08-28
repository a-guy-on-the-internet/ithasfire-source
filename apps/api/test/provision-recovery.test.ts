import { describe, expect, it, vi } from "vitest";

import type {
  ProvisioningRollbackDeps,
  ProvisioningSelfHealDeps,
  ProvisioningSelfHealUser,
} from "../src/auth/provision-recovery";
import {
  classifyTransientProvisionError,
  deleteUnprovisionedAuthUserWhere,
  handleProvisioningWithRollback,
  provisionGuardConfig,
  resolveHumanIdWithSelfHeal,
} from "../src/auth/provision-recovery";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRollbackDeps(
  overrides: Partial<ProvisioningRollbackDeps> = {},
): ProvisioningRollbackDeps {
  return {
    logger: makeLogger(),
    provision: vi.fn().mockResolvedValue({ humanId: "human-1" }),
    deleteUnprovisionedAuthUser: vi.fn().mockResolvedValue(1),
    alert: vi.fn().mockResolvedValue(undefined),
    maskEmail: (email: string) => `masked:${email}`,
    ...overrides,
  };
}

const rollbackInput = {
  authUserId: "auth-user-1",
  email: "new@example.com",
  name: "Alice",
  image: "https://img.example/avatar.png",
  locale: "en-US",
};

function makeSelfHealDeps(
  overrides: Partial<ProvisioningSelfHealDeps> = {},
): ProvisioningSelfHealDeps {
  return {
    logger: makeLogger(),
    provision: vi.fn().mockResolvedValue({ humanId: "human-healed" }),
    ...overrides,
  };
}

// ── FIX 1: rollback ──────────────────────────────────────────────────────────

describe("handleProvisioningWithRollback", () => {
  it("returns the provisioning result and does NOT delete or rethrow on success", async () => {
    const deps = makeRollbackDeps();

    const result = await handleProvisioningWithRollback(deps, rollbackInput);

    expect(result).toEqual({ humanId: "human-1" });
    expect(deps.provision).toHaveBeenCalledWith({
      authUserId: "auth-user-1",
      email: "new@example.com",
      name: "Alice",
      image: "https://img.example/avatar.png",
      locale: "en-US",
    });
    expect(deps.deleteUnprovisionedAuthUser).not.toHaveBeenCalled();
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it("deletes the unprovisioned auth_user and rethrows when provisioning throws", async () => {
    const provisionError = new Error("provision boom");
    const deps = makeRollbackDeps({
      provision: vi.fn().mockRejectedValue(provisionError),
    });

    await expect(
      handleProvisioningWithRollback(deps, rollbackInput),
    ).rejects.toBe(provisionError);

    // Compensating delete called with the right id (the deleteMany guard on
    // humanId = null lives in the production wiring, not the handler).
    expect(deps.deleteUnprovisionedAuthUser).toHaveBeenCalledWith(
      "auth-user-1",
    );

    // Structured rollback log emitted.
    expect(deps.logger.error).toHaveBeenCalledWith(
      "auth_user_provision_rolled_back",
      expect.objectContaining({
        authUserId: "auth-user-1",
        deletedCount: 1,
      }),
    );
  });

  it("fires a Discord alert titled 'Signup rolled back — provisioning failed' on rollback", async () => {
    const deps = makeRollbackDeps({
      provision: vi.fn().mockRejectedValue(new Error("provision boom")),
    });

    await expect(
      handleProvisioningWithRollback(deps, rollbackInput),
    ).rejects.toThrow("provision boom");

    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Signup rolled back — provisioning failed",
        colour: "error",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "Auth ID", value: "auth-user-1" }),
          expect.objectContaining({ name: "Rows deleted", value: "1" }),
        ]),
      }),
    );
  });

  it("still rethrows (and logs) when the compensating delete itself fails", async () => {
    const provisionError = new Error("provision boom");
    const deleteError = new Error("delete boom");
    const deps = makeRollbackDeps({
      provision: vi.fn().mockRejectedValue(provisionError),
      deleteUnprovisionedAuthUser: vi.fn().mockRejectedValue(deleteError),
    });

    await expect(
      handleProvisioningWithRollback(deps, rollbackInput),
    ).rejects.toBe(provisionError);

    expect(deps.logger.error).toHaveBeenCalledWith(
      "auth_user_provision_rollback_delete_failed",
      expect.objectContaining({ authUserId: "auth-user-1" }),
    );
  });

  it("does not throw the rollback flow when the Discord alert fails", async () => {
    const provisionError = new Error("provision boom");
    const deps = makeRollbackDeps({
      provision: vi.fn().mockRejectedValue(provisionError),
      alert: vi.fn().mockRejectedValue(new Error("discord down")),
    });

    // The original provision error must still surface — not the alert error.
    await expect(
      handleProvisioningWithRollback(deps, rollbackInput),
    ).rejects.toBe(provisionError);
  });

  it("works without an alert sender configured", async () => {
    const provisionError = new Error("provision boom");
    const deps = makeRollbackDeps({
      provision: vi.fn().mockRejectedValue(provisionError),
      alert: null,
    });

    await expect(
      handleProvisioningWithRollback(deps, rollbackInput),
    ).rejects.toBe(provisionError);
    expect(deps.deleteUnprovisionedAuthUser).toHaveBeenCalledWith(
      "auth-user-1",
    );
  });
});

// ── FIX 2: self-heal ─────────────────────────────────────────────────────────

describe("resolveHumanIdWithSelfHeal", () => {
  const linkedUser: ProvisioningSelfHealUser = {
    id: "auth-user-1",
    email: "user@example.com",
    name: "Alice",
    humanId: "human-existing",
  };

  it("passes through the existing humanId without calling provision", async () => {
    const deps = makeSelfHealDeps();

    const result = await resolveHumanIdWithSelfHeal(deps, linkedUser);

    expect(result).toBe("human-existing");
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("provisions and returns the healed humanId when humanId is null", async () => {
    const deps = makeSelfHealDeps();
    const orphan: ProvisioningSelfHealUser = {
      id: "auth-user-2",
      email: "orphan@example.com",
      name: "Bob",
      humanId: null,
    };

    const result = await resolveHumanIdWithSelfHeal(deps, orphan);

    expect(result).toBe("human-healed");
    expect(deps.provision).toHaveBeenCalledWith({
      authUserId: "auth-user-2",
      email: "orphan@example.com",
      name: "Bob",
    });
    expect(deps.logger.info).toHaveBeenCalledWith(
      "auth_user_self_heal_succeeded",
      expect.objectContaining({
        authUserId: "auth-user-2",
        humanId: "human-healed",
      }),
    );
  });

  it("does NOT throw and returns null when self-heal provisioning fails", async () => {
    const deps = makeSelfHealDeps({
      provision: vi.fn().mockRejectedValue(new Error("provision boom")),
    });
    const orphan: ProvisioningSelfHealUser = {
      id: "auth-user-3",
      email: "orphan@example.com",
      humanId: null,
    };

    const result = await resolveHumanIdWithSelfHeal(deps, orphan);

    expect(result).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "auth_user_self_heal_failed",
      expect.objectContaining({ authUserId: "auth-user-3" }),
    );
  });

  it("returns null without provisioning when humanId is null and email is missing", async () => {
    const deps = makeSelfHealDeps();
    const noEmail: ProvisioningSelfHealUser = {
      id: "auth-user-4",
      email: null,
      humanId: null,
    };

    const result = await resolveHumanIdWithSelfHeal(deps, noEmail);

    expect(result).toBeNull();
    expect(deps.provision).not.toHaveBeenCalled();
  });
});

// ── Shared transient classifier (used by both provisioning paths) ────────────

describe("classifyTransientProvisionError", () => {
  it("flags deadlock / serialization failure / ETIMEDOUT (case-insensitive)", () => {
    expect(
      classifyTransientProvisionError(new Error("deadlock detected")),
    ).toBe(true);
    expect(
      classifyTransientProvisionError(
        new Error("could not serialize access due to SERIALIZATION FAILURE"),
      ),
    ).toBe(true);
    expect(classifyTransientProvisionError(new Error("connect ETIMEDOUT"))).toBe(
      true,
    );
  });

  it("does not flag unrelated errors", () => {
    expect(
      classifyTransientProvisionError(new Error("unique constraint violated")),
    ).toBe(false);
    expect(classifyTransientProvisionError("plain string")).toBe(false);
    expect(classifyTransientProvisionError(null)).toBe(false);
  });
});

describe("provisionGuardConfig", () => {
  it("applies the shared transient classifier to the humans repo", () => {
    const config = provisionGuardConfig();
    expect(config.humans.classifyTransient).toBe(
      classifyTransientProvisionError,
    );
    expect(config.humans.classifyTransient(new Error("deadlock"))).toBe(true);
  });
});

// ── Compensating-delete guard ────────────────────────────────────────────────

describe("deleteUnprovisionedAuthUserWhere", () => {
  it("scopes the delete to the given id AND humanId = null", () => {
    expect(deleteUnprovisionedAuthUserWhere("auth-user-9")).toEqual({
      id: "auth-user-9",
      humanId: null,
    });
  });
});
