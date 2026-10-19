import { describe, expect, it, vi } from "vitest";

import type {
  ShadowUpgradeDeps,
  ShadowUpgradeUser,
} from "../src/auth/shadow-upgrade";
import { handleShadowUpgrade } from "../src/auth/shadow-upgrade";

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

function makeDeps(
  overrides: Partial<ShadowUpgradeDeps> = {},
): ShadowUpgradeDeps {
  return {
    logger: makeLogger(),
    loadUpgradeEligibility: vi.fn().mockResolvedValue({
      emailVerified: false,
      accountCount: 0,
      passkeyCount: 0,
    }),
    hashPassword: vi.fn().mockResolvedValue("hashed-pw"),
    createCredentialAccount: vi.fn().mockResolvedValue(undefined),
    updateAuthUserName: vi.fn().mockResolvedValue(undefined),
    updateHumanName: vi.fn().mockResolvedValue(undefined),
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const shadowUser: ShadowUpgradeUser = {
  id: "auth-user-1",
  email: "shadow@example.com",
  name: undefined,
  humanId: "human-1",
};

function makeRequest(
  body: Record<string, unknown> = { password: "securePass1", name: "Alice" },
) {
  return new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("handleShadowUpgrade", () => {
  it("upgrades a shadow user: hashes password, creates credential, updates names, sends email", async () => {
    const deps = makeDeps();
    const request = makeRequest({ password: "securePass1", name: "Alice" });

    const result = await handleShadowUpgrade(deps, shadowUser, request);

    expect(result).toEqual({ outcome: "upgraded" });

    // Password was hashed.
    expect(deps.hashPassword).toHaveBeenCalledWith("securePass1");

    // Credential account was created.
    expect(deps.createCredentialAccount).toHaveBeenCalledWith(
      "auth-user-1",
      "hashed-pw",
    );

    // Name was updated on AuthUser (shadow has no name).
    expect(deps.updateAuthUserName).toHaveBeenCalledWith(
      "auth-user-1",
      "Alice",
    );

    // Name was updated on linked Human.
    expect(deps.updateHumanName).toHaveBeenCalledWith("human-1", "Alice");

    // Verification email was sent.
    expect(deps.sendVerificationEmail).toHaveBeenCalledWith(
      "shadow@example.com",
    );
  });

  it("skips when the user already has a credential account (real duplicate signup)", async () => {
    const deps = makeDeps({
      loadUpgradeEligibility: vi.fn().mockResolvedValue({
        emailVerified: false,
        accountCount: 1,
        passkeyCount: 0,
      }),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "skipped_not_shadow" });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
    expect(deps.hashPassword).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      "shadow_upgrade_skipped_not_shadow",
      expect.objectContaining({ authUserId: "auth-user-1" }),
    );
  });

  // ── F7 (2026-09-29 review): the upgrade must never attach a stranger's
  // password to a REAL account. Every one of these users is a takeover
  // target the old "no credential account" check let through.
  describe("refuses anything that is not a true shadow (no password attached)", () => {
    const cases = [
      {
        name: "a verified user with no accounts (email-code / magic-link only)",
        eligibility: { emailVerified: true, accountCount: 0, passkeyCount: 0 },
      },
      {
        name: "a Google/Apple user (verified, one OAuth account)",
        eligibility: { emailVerified: true, accountCount: 1, passkeyCount: 0 },
      },
      {
        name: "an UNVERIFIED user with an OAuth account",
        eligibility: { emailVerified: false, accountCount: 1, passkeyCount: 0 },
      },
      {
        name: "a passkey-only user (verified)",
        eligibility: { emailVerified: true, accountCount: 0, passkeyCount: 1 },
      },
      {
        name: "an UNVERIFIED passkey-only user",
        eligibility: { emailVerified: false, accountCount: 0, passkeyCount: 2 },
      },
    ];

    it.each(cases)("$name", async ({ eligibility }) => {
      const deps = makeDeps({
        loadUpgradeEligibility: vi.fn().mockResolvedValue(eligibility),
      });

      const result = await handleShadowUpgrade(
        deps,
        shadowUser,
        makeRequest({ password: "attackerPass1", name: "Mallory" }),
      );

      expect(result).toEqual({ outcome: "skipped_not_shadow" });
      expect(deps.hashPassword).not.toHaveBeenCalled();
      expect(deps.createCredentialAccount).not.toHaveBeenCalled();
      expect(deps.updateAuthUserName).not.toHaveBeenCalled();
      expect(deps.updateHumanName).not.toHaveBeenCalled();
      expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it("refuses when the AuthUser no longer exists", async () => {
      const deps = makeDeps({
        loadUpgradeEligibility: vi.fn().mockResolvedValue(null),
      });

      const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

      expect(result).toEqual({ outcome: "skipped_not_shadow" });
      expect(deps.createCredentialAccount).not.toHaveBeenCalled();
    });

    it("checks eligibility BEFORE reading the password from the body", async () => {
      const deps = makeDeps({
        loadUpgradeEligibility: vi.fn().mockResolvedValue({
          emailVerified: true,
          accountCount: 1,
          passkeyCount: 0,
        }),
      });
      const request = makeRequest();
      const cloneSpy = vi.spyOn(request, "clone");

      await handleShadowUpgrade(deps, shadowUser, request);

      expect(deps.loadUpgradeEligibility).toHaveBeenCalledWith("auth-user-1");
      expect(cloneSpy).not.toHaveBeenCalled();
    });
  });

  it("skips when no request object is provided", async () => {
    const deps = makeDeps();

    const result = await handleShadowUpgrade(deps, shadowUser, undefined);

    expect(result).toEqual({ outcome: "skipped_no_request" });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
  });

  it("skips when request body cannot be parsed", async () => {
    const deps = makeDeps();
    // Create a request whose body is not valid JSON.
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    const result = await handleShadowUpgrade(deps, shadowUser, request);

    expect(result).toEqual({ outcome: "skipped_body_parse_failed" });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
  });

  it("skips when password is missing from body", async () => {
    const deps = makeDeps();
    const request = makeRequest({ name: "Alice" }); // no password

    const result = await handleShadowUpgrade(deps, shadowUser, request);

    expect(result).toEqual({ outcome: "skipped_no_password" });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
  });

  it("skips when password is too short", async () => {
    const deps = makeDeps();
    const request = makeRequest({ password: "short", name: "Alice" });

    const result = await handleShadowUpgrade(deps, shadowUser, request);

    expect(result).toEqual({ outcome: "skipped_no_password" });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
  });

  it("does not update AuthUser name when shadow user already has one", async () => {
    const deps = makeDeps();
    const userWithName = { ...shadowUser, name: "Existing Name" };

    await handleShadowUpgrade(
      deps,
      userWithName,
      makeRequest({ password: "securePass1", name: "Alice" }),
    );

    // AuthUser name should NOT be overwritten.
    expect(deps.updateAuthUserName).not.toHaveBeenCalled();
    // Human name SHOULD still be updated (name is provided and humanId exists).
    expect(deps.updateHumanName).toHaveBeenCalledWith("human-1", "Alice");
  });

  it("does not update Human name when no humanId is linked", async () => {
    const deps = makeDeps();
    const userNoHuman = { ...shadowUser, humanId: undefined };

    await handleShadowUpgrade(
      deps,
      userNoHuman,
      makeRequest({ password: "securePass1", name: "Alice" }),
    );

    expect(deps.updateHumanName).not.toHaveBeenCalled();
    // AuthUser name update should still happen (shadow has no name).
    expect(deps.updateAuthUserName).toHaveBeenCalledWith(
      "auth-user-1",
      "Alice",
    );
  });

  it("does not update names when no name is provided in body", async () => {
    const deps = makeDeps();

    await handleShadowUpgrade(
      deps,
      shadowUser,
      makeRequest({ password: "securePass1" }),
    );

    expect(deps.updateAuthUserName).not.toHaveBeenCalled();
    expect(deps.updateHumanName).not.toHaveBeenCalled();
    // Credential account should still be created.
    expect(deps.createCredentialAccount).toHaveBeenCalled();
  });

  it("still succeeds when verification email fails (non-critical)", async () => {
    const deps = makeDeps({
      sendVerificationEmail: vi.fn().mockRejectedValue(new Error("SMTP down")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "upgraded" });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "shadow_upgrade_verification_email_failed",
      expect.objectContaining({ authUserId: "auth-user-1" }),
    );
  });

  it("still succeeds when Human name update fails (non-critical)", async () => {
    const deps = makeDeps({
      updateHumanName: vi.fn().mockRejectedValue(new Error("DB timeout")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "upgraded" });
    // Credential was still created.
    expect(deps.createCredentialAccount).toHaveBeenCalled();
  });

  it("returns error outcome when credential creation fails", async () => {
    const deps = makeDeps({
      createCredentialAccount: vi
        .fn()
        .mockRejectedValue(new Error("unique constraint")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "error", error: expect.any(Error) });
    expect(deps.logger.error).toHaveBeenCalledWith(
      "shadow_upgrade_failed",
      expect.objectContaining({ authUserId: "auth-user-1" }),
    );
  });

  it("returns error outcome when the eligibility lookup throws, and attaches nothing", async () => {
    const deps = makeDeps({
      loadUpgradeEligibility: vi
        .fn()
        .mockRejectedValue(new Error("connection lost")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "error", error: expect.any(Error) });
    expect(deps.createCredentialAccount).not.toHaveBeenCalled();
  });

  it("reports the swallowed failure to Sentry via reportError", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      reportError,
      createCredentialAccount: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "error", error: expect.any(Error) });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "shadow_upgrade" }),
      }),
    );
  });

  it("reports (but survives) a failed Human name update", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      reportError,
      updateHumanName: vi.fn().mockRejectedValue(new Error("name write")),
    });

    const result = await handleShadowUpgrade(deps, shadowUser, makeRequest());

    expect(result).toEqual({ outcome: "upgraded" });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "shadow_upgrade_human_name" }),
      }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const deps = makeDeps({
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
      createCredentialAccount: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(
      handleShadowUpgrade(deps, shadowUser, makeRequest()),
    ).resolves.toEqual({ outcome: "error", error: expect.any(Error) });
  });
});
