import { describe, expect, it, vi } from "vitest";

import {
  accountNotActiveRedirect,
  EMAIL_PROOF_SIGN_IN_TRIGGERS,
  REFUSED_AUTH_ENDPOINTS,
  RESET_SWEEP_OPTIONS,
  refusedAuthEndpoint,
  sweptAnything,
  isInboxProvingProvider,
  isOwnInboxVerification,
  isSessionAllowed,
  passwordResetProofFromUrl,
  resolveEmailProofTrigger,
  revokeUnprovenCredentials,
  secureAccountAfterPasswordReset,
  type UnprovenCredentialCounts,
  type UnprovenCredentialDeps,
  type UnprovenGrantsToReview,
} from "../src/auth/account-security";

function makeLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

const COUNTS: UnprovenCredentialCounts = {
  credentialAccounts: 1,
  sessions: 3,
  passkeys: 1,
  twoFactor: 0,
  apiKeys: 2,
  apiKeyRequestsClosed: 0,
  phoneNumbers: 1,
  delegateGrants: 1,
  pendingInvitesRevoked: 0,
  pushDevices: 0,
};

const NO_GRANTS: UnprovenGrantsToReview = {
  privilegedMemberships: [],
  acceptedPrivilegedInvites: [],
};

function makeRevokeDeps(
  user: { id: string; emailVerified: boolean } | null,
  overrides: Partial<UnprovenCredentialDeps> = {},
): UnprovenCredentialDeps {
  return {
    logger: makeLogger(),
    reportError: vi.fn(),
    loadAuthUser: vi.fn(async () => user),
    revokeAll: vi.fn(async () => ({
      counts: COUNTS,
      grantsToReview: NO_GRANTS,
    })),
    ...overrides,
  };
}

// ── F5: sessions for suspended/banned humans ────────────────────────────────

describe("isSessionAllowed", () => {
  it("allows an ACTIVE human", async () => {
    await expect(
      isSessionAllowed({ loadHumanStatus: async () => "ACTIVE" }, "u1"),
    ).resolves.toBe(true);
  });

  it.each(["SUSPENDED", "BANNED", "INVITED"] as const)(
    "refuses a %s human",
    async (status) => {
      await expect(
        isSessionAllowed({ loadHumanStatus: async () => status }, "u1"),
      ).resolves.toBe(false);
    },
  );

  // Better Auth defers `user.create.after` (Human provisioning) to the end of
  // the request, so the FIRST session of a new sign-up is created while the
  // AuthUser is still unlinked. Refusing null would break every sign-up.
  // Ban that sticks, review round 1: guest-checkout / RSVP shadow users and
  // pre-existing alt accounts never pass the sign-up hook, so every session
  // is checked against the banned-mailbox list here.
  it.each([
    ["an ACTIVE human", "ACTIVE" as const],
    ["an unlinked AuthUser (shadow or fresh)", null],
  ])(
    "refuses %s whose email is a banned human's mailbox",
    async (_label, status) => {
      const isEmailBanned = vi.fn(async () => true);
      await expect(
        isSessionAllowed(
          { loadHumanStatus: async () => status, isEmailBanned },
          "u1",
        ),
      ).resolves.toBe(false);
      expect(isEmailBanned).toHaveBeenCalledWith("u1");
    },
  );

  it("allows an ACTIVE human whose mailbox is not banned", async () => {
    await expect(
      isSessionAllowed(
        {
          loadHumanStatus: async () => "ACTIVE",
          isEmailBanned: async () => false,
        },
        "u1",
      ),
    ).resolves.toBe(true);
  });

  it("fails closed and reports when the mailbox check errors", async () => {
    const reportError = vi.fn();
    await expect(
      isSessionAllowed(
        {
          reportError,
          loadHumanStatus: async () => "ACTIVE",
          isEmailBanned: async () => {
            throw new Error("ban lookup down");
          },
        },
        "u1",
      ),
    ).rejects.toThrow("ban lookup down");
    // Exactly one report, tagged as the mailbox lookup, with the authUserId:
    // the ban lookup itself is wired not to report (callerReportsLookupFailure).
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "session_gate_mailbox_lookup" }),
        extra: { authUserId: "u1" },
      }),
    );
  });

  it("allows an AuthUser not yet linked to a Human (fresh sign-up)", async () => {
    await expect(
      isSessionAllowed({ loadHumanStatus: async () => null }, "u1"),
    ).resolves.toBe(true);
  });

  it("propagates a lookup failure instead of letting the session through, and reports it", async () => {
    const reportError = vi.fn();
    await expect(
      isSessionAllowed(
        {
          reportError,
          loadHumanStatus: async () => {
            throw new Error("db down");
          },
        },
        "u1",
      ),
    ).rejects.toThrow("db down");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "session_gate_status_lookup" }),
      }),
    );
  });
});

// ── F6: squatted unverified accounts ────────────────────────────────────────

describe("revokeUnprovenCredentials", () => {
  it("revokes everything when the inbox is proven on an UNVERIFIED user", async () => {
    const deps = makeRevokeDeps({ id: "u1", emailVerified: false });

    const result = await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "oauth_link",
    });

    expect(result).toEqual({
      outcome: "revoked",
      counts: COUNTS,
      grantsToReview: NO_GRANTS,
    });
    // No org grants → nothing to review → no Sentry noise.
    expect(deps.reportError).not.toHaveBeenCalled();
    expect(deps.revokeAll).toHaveBeenCalledWith("u1", "oauth_link");
    expect(deps.logger.info).toHaveBeenCalledWith(
      "auth_unproven_credentials_revoked",
      expect.objectContaining({ authUserId: "u1", trigger: "oauth_link" }),
    );
  });

  it("leaves an already-VERIFIED user alone (their password was proven)", async () => {
    const deps = makeRevokeDeps({ id: "u1", emailVerified: true });

    const result = await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "oauth_link",
    });

    expect(result).toEqual({ outcome: "skipped_already_verified" });
    expect(deps.revokeAll).not.toHaveBeenCalled();
  });

  // `createOAuthUser` inserts user + account inside one uncommitted
  // transaction, so a brand-new OAuth user is invisible to the lookup.
  it("is a no-op for a user that does not exist yet (brand-new OAuth sign-up)", async () => {
    const deps = makeRevokeDeps(null);

    const result = await revokeUnprovenCredentials(deps, {
      authUserId: "u-new",
      trigger: "oauth_link",
    });

    expect(result).toEqual({ outcome: "skipped_unknown_user" });
    expect(deps.revokeAll).not.toHaveBeenCalled();
  });

  it("fails CLOSED: reports and rethrows when the sweep fails", async () => {
    const boom = new Error("tx aborted");
    const deps = makeRevokeDeps(
      { id: "u1", emailVerified: false },
      { revokeAll: vi.fn(async () => Promise.reject(boom)) },
    );

    await expect(
      revokeUnprovenCredentials(deps, {
        authUserId: "u1",
        trigger: "email_otp_sign_in",
      }),
    ).rejects.toBe(boom);
    expect(deps.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          op: "revoke_unproven_credentials",
          trigger: "email_otp_sign_in",
        }),
      }),
    );
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("a throwing reporter does not replace the original error", async () => {
    const boom = new Error("tx aborted");
    const deps = makeRevokeDeps(
      { id: "u1", emailVerified: false },
      {
        revokeAll: vi.fn(async () => Promise.reject(boom)),
        reportError: vi.fn(() => {
          throw new Error("sentry down");
        }),
      },
    );

    await expect(
      revokeUnprovenCredentials(deps, {
        authUserId: "u1",
        trigger: "magic_link_sign_in",
      }),
    ).rejects.toBe(boom);
  });
});

describe("revokeUnprovenCredentials — reporting (review round 2)", () => {
  it("reports a failing user lookup too (it runs inside the try)", async () => {
    const boom = new Error("lookup failed");
    const deps = makeRevokeDeps(null, {
      loadAuthUser: vi.fn(async () => Promise.reject(boom)),
    });

    await expect(
      revokeUnprovenCredentials(deps, {
        authUserId: "u1",
        trigger: "oauth_link",
      }),
    ).rejects.toBe(boom);
    expect(deps.reportError).toHaveBeenCalledWith(boom, expect.anything());
    expect(deps.revokeAll).not.toHaveBeenCalled();
  });

  it("clears the phone number as part of the sweep (it is a sign-in method)", async () => {
    const deps = makeRevokeDeps({ id: "u1", emailVerified: false });
    const result = await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "email_otp_sign_in",
    });
    expect(result).toMatchObject({
      outcome: "revoked",
      counts: expect.objectContaining({ phoneNumbers: 1 }),
    });
  });

  it("does NOT touch a verified account (its phone, e.g. from checkout, stays)", async () => {
    const deps = makeRevokeDeps({ id: "u1", emailVerified: true });
    await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "oauth_link",
    });
    expect(deps.revokeAll).not.toHaveBeenCalled();
  });

  it("reports org grants the squatter made, for review", async () => {
    const grants: UnprovenGrantsToReview = {
      privilegedMemberships: [{ orgId: "org-1", role: "OWNER" }],
      acceptedPrivilegedInvites: [
        { orgId: "org-1", role: "ADMIN", acceptedByHumanId: "h-2" },
      ],
    };
    const deps = makeRevokeDeps(
      { id: "u1", emailVerified: false },
      {
        revokeAll: vi.fn(async () => ({
          counts: COUNTS,
          grantsToReview: grants,
        })),
      },
    );

    await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "oauth_link",
    });

    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "auth_unproven_account_has_org_grants",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({
          authUserId: "u1",
          privilegedMemberships: grants.privilegedMemberships,
          acceptedPrivilegedInvites: grants.acceptedPrivilegedInvites,
        }),
      }),
    );
  });
});

describe("isInboxProvingProvider", () => {
  it("excludes the password provider", () => {
    expect(isInboxProvingProvider("credential")).toBe(false);
  });

  it.each(["google", "apple", "github"])("includes %s", (providerId) => {
    expect(isInboxProvingProvider(providerId)).toBe(true);
  });
});

describe("resolveEmailProofTrigger", () => {
  it("maps the two email-proof sign-ins when they flip emailVerified", () => {
    expect(
      resolveEmailProofTrigger("/sign-in/email-otp", { emailVerified: true }),
    ).toBe("email_otp_sign_in");
    expect(
      resolveEmailProofTrigger("/magic-link/verify", { emailVerified: true }),
    ).toBe("magic_link_sign_in");
  });

  it("ignores updates that do not set emailVerified=true", () => {
    expect(
      resolveEmailProofTrigger("/sign-in/email-otp", { name: "x" }),
    ).toBeNull();
    expect(
      resolveEmailProofTrigger("/magic-link/verify", { emailVerified: false }),
    ).toBeNull();
    expect(resolveEmailProofTrigger("/magic-link/verify", undefined)).toBeNull();
  });

  // /email-otp/verify-email needs no session, so it is an email proof like
  // the sign-ins (B2); the account holder's OWN verification is exempted by
  // `isOwnInboxVerification`, not here.
  it("maps /email-otp/verify-email when it flips emailVerified", () => {
    expect(
      resolveEmailProofTrigger("/email-otp/verify-email", {
        email: "a@b.com",
        emailVerified: true,
      }),
    ).toBe("email_otp_verify_email");
  });

  it.each([
    "/callback/:id",
    "/change-email",
    "/email-otp/change-email",
    undefined,
  ])("ignores %s", (path) => {
    expect(resolveEmailProofTrigger(path, { emailVerified: true })).toBeNull();
  });

  it("covers exactly the two sign-in paths and verify-email", () => {
    expect(Object.keys(EMAIL_PROOF_SIGN_IN_TRIGGERS).sort()).toEqual([
      "/email-otp/verify-email",
      "/magic-link/verify",
      "/sign-in/email-otp",
    ]);
  });
});

describe("isOwnInboxVerification (B2)", () => {
  const USER = "user-1";

  it("verify-email signed in as the account being verified: skip the sweep", async () => {
    await expect(
      isOwnInboxVerification("email_otp_verify_email", USER, async () => USER),
    ).resolves.toBe(true);
  });

  it("verify-email with no session, or another account's: sweep", async () => {
    await expect(
      isOwnInboxVerification("email_otp_verify_email", USER, async () => null),
    ).resolves.toBe(false);
    await expect(
      isOwnInboxVerification("email_otp_verify_email", USER, async () => "user-2"),
    ).resolves.toBe(false);
  });

  it("never exempts the sign-ins, and does not read the session for them", async () => {
    const sessionUserId = vi.fn(async () => USER);
    for (const trigger of [
      "email_otp_sign_in",
      "magic_link_sign_in",
      "oauth_link",
    ] as const) {
      await expect(
        isOwnInboxVerification(trigger, USER, sessionUserId),
      ).resolves.toBe(false);
    }
    expect(sessionUserId).not.toHaveBeenCalled();
  });
});

// ── Password reset (F5 + review round 2) ────────────────────────────────────

function makeResetDeps(overrides: Record<string, unknown> = {}) {
  return {
    logger: makeLogger(),
    reportError: vi.fn(),
    revokeApiKeysForAuthUser: vi.fn(async () => 3),
    sweepUnprovenAccountAfterReset: vi.fn(async () => ({
      counts: { ...COUNTS, credentialAccounts: 0, sessions: 0 },
      grantsToReview: NO_GRANTS,
    })),
    ...overrides,
  };
}

describe("passwordResetProofFromUrl", () => {
  it.each([
    ["http://api/api/auth/reset-password", "email"],
    ["http://api/api/auth/reset-password?token=x", "email"],
    ["http://api/api/auth/email-otp/reset-password", "email"],
    ["http://api/api/auth/phone-number/reset-password", "phone"],
    ["http://api/api/auth/something-else", "unknown"],
    ["not a url", "unknown"],
    [undefined, "unknown"],
  ] as const)("%s -> %s", (url, expected) => {
    expect(passwordResetProofFromUrl(url)).toBe(expected);
  });
});

describe("secureAccountAfterPasswordReset", () => {
  it("VERIFIED account: revokes API keys only", async () => {
    const deps = makeResetDeps();
    await expect(
      secureAccountAfterPasswordReset(deps, {
        authUserId: "u1",
        emailVerified: true,
        proof: "email",
      }),
    ).resolves.toEqual({ mode: "api_keys_only", revoked: 3 });
    expect(deps.sweepUnprovenAccountAfterReset).not.toHaveBeenCalled();
  });

  // "Forgot password" is the likeliest recovery for a squatting victim; the
  // squatter's passkeys, TOTP and phone would otherwise survive it.
  it.each(["email"] as const)(
    "UNVERIFIED account + %s-proven reset: sweeps passkeys/TOTP/phone/keys",
    async (proof) => {
      const deps = makeResetDeps();
      const result = await secureAccountAfterPasswordReset(deps, {
        authUserId: "u1",
        emailVerified: false,
        proof,
      });
      expect(result).toMatchObject({ mode: "unproven_sweep" });
      expect(deps.sweepUnprovenAccountAfterReset).toHaveBeenCalledWith("u1");
      expect(deps.revokeApiKeysForAuthUser).not.toHaveBeenCalled();
    },
  );

  // A phone-proven reset on an unverified account proves only the phone —
  // which there is the squatter's own. It must not be treated as the owner.
  it.each(["phone", "unknown"] as const)(
    "UNVERIFIED account + %s-proven reset: API keys only",
    async (proof) => {
      const deps = makeResetDeps();
      await expect(
        secureAccountAfterPasswordReset(deps, {
          authUserId: "u1",
          emailVerified: false,
          proof,
        }),
      ).resolves.toEqual({ mode: "api_keys_only", revoked: 3 });
      expect(deps.sweepUnprovenAccountAfterReset).not.toHaveBeenCalled();
    },
  );

  // Better Auth runs `onPasswordReset` BEFORE `revokeSessionsOnPasswordReset`;
  // a throw here would skip the session revocation, so it must swallow — and
  // therefore must report.
  it.each([
    [true, "revokeApiKeysForAuthUser"],
    [false, "sweepUnprovenAccountAfterReset"],
  ] as const)(
    "never throws (emailVerified=%s, failing %s); reports instead",
    async (emailVerified, failing) => {
      const boom = new Error("db down");
      const deps = makeResetDeps({
        [failing]: vi.fn(async () => Promise.reject(boom)),
      });

      await expect(
        secureAccountAfterPasswordReset(deps, {
          authUserId: "u1",
          emailVerified,
          proof: "email",
        }),
      ).resolves.toEqual({ mode: "failed", error: boom });
      expect(deps.reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: expect.objectContaining({
            op: "password_reset_secure_account",
          }),
        }),
      );
      expect(deps.logger.error).toHaveBeenCalled();
    },
  );

  it("a throwing reporter still does not throw", async () => {
    const deps = makeResetDeps({
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
      revokeApiKeysForAuthUser: vi.fn(async () =>
        Promise.reject(new Error("db down")),
      ),
    });

    await expect(
      secureAccountAfterPasswordReset(deps, {
        authUserId: "u1",
        emailVerified: true,
        proof: "email",
      }),
    ).resolves.toMatchObject({ mode: "failed" });
  });
});

// ── Review round 3 ──────────────────────────────────────────────────────────

describe("revokeUnprovenCredentials passes the trigger to the sweep (for the audit row)", () => {
  it("forwards the trigger", async () => {
    const deps = makeRevokeDeps({ id: "u1", emailVerified: false });
    await revokeUnprovenCredentials(deps, {
      authUserId: "u1",
      trigger: "magic_link_sign_in",
    });
    expect(deps.revokeAll).toHaveBeenCalledWith("u1", "magic_link_sign_in");
  });
});

describe("refused endpoints", () => {
  // Better Auth's /change-email rewrote an UNVERIFIED account's address with
  // no proof; the swap attack below depends on it.
  it("refuses Better Auth's /change-email", () => {
    expect(refusedAuthEndpoint("/change-email")).toEqual({
      code: "USE_ACCOUNT_EMAIL_CHANGE_REQUEST",
      message: expect.any(String),
    });
  });

  it("still refuses /email-otp/request-email-change", () => {
    expect(refusedAuthEndpoint("/email-otp/request-email-change")).not.toBeNull();
  });

  it.each([
    "/email-otp/change-email", // the PROVEN change (code to the new inbox)
    "/sign-in/email",
    "/request-password-reset",
    "/reset-password",
    undefined,
  ])("does not refuse %s", (path) => {
    expect(refusedAuthEndpoint(path)).toBeNull();
  });

  // B2: core's link verification flips emailVerified without the sweep.
  it("refuses Better Auth's core /verify-email (link), not the emailOTP one", () => {
    expect(refusedAuthEndpoint("/verify-email")).toEqual({
      code: "USE_EMAIL_CODE_VERIFICATION",
      message: expect.any(String),
    });
    expect(refusedAuthEndpoint("/email-otp/verify-email")).toBeNull();
  });

  it("refuses exactly the two unproven email-change endpoints and /verify-email", () => {
    expect(Object.keys(REFUSED_AUTH_ENDPOINTS).sort()).toEqual([
      "/change-email",
      "/email-otp/request-email-change",
      "/verify-email",
    ]);
  });
});

/**
 * The swap attack (review round 3). The reset token is bound to the user id,
 * not the address, so:
 *   1. squat victim@  2. change email to me@attacker  3. request reset (link
 *   → attacker inbox)  4. change back to victim@  5. complete the reset.
 * Previously step 5 marked victim@ VERIFIED, so a later Google link skipped
 * the sweep and the attacker kept the password.
 *
 * Modelled with an in-memory account driven through the same policy objects
 * the hooks use. The live run in the round-3 report drives the real API.
 */
describe("password-reset email-swap attack", () => {
  type Account = { email: string; emailVerified: boolean };

  function changeEmail(account: Account, newEmail: string): boolean {
    // hooks.before refuses the endpoint before Better Auth's handler runs.
    if (refusedAuthEndpoint("/change-email")) return false;
    account.email = newEmail;
    return true;
  }

  async function completeReset(account: Account) {
    const sweep = vi.fn(async () => {
      // What `sweepUnprovenAccountInDb(..., RESET_SWEEP_OPTIONS)` does to the
      // verified flag.
      if (RESET_SWEEP_OPTIONS.markEmailVerified) account.emailVerified = true;
      return { counts: COUNTS, grantsToReview: NO_GRANTS };
    });
    await secureAccountAfterPasswordReset(
      {
        logger: makeLogger(),
        reportError: vi.fn(),
        revokeApiKeysForAuthUser: vi.fn(async () => 0),
        sweepUnprovenAccountAfterReset: sweep,
      },
      {
        authUserId: "u1",
        emailVerified: account.emailVerified,
        proof: "email",
      },
    );
    return sweep;
  }

  it("step 2 (change email without proof) is refused", () => {
    const account: Account = { email: "victim@x.com", emailVerified: false };
    expect(changeEmail(account, "me@attacker.com")).toBe(false);
    expect(account.email).toBe("victim@x.com");
  });

  it("even if the address were swapped some other way, the reset leaves emailVerified === false", async () => {
    const account: Account = { email: "victim@x.com", emailVerified: false };
    account.email = "me@attacker.com"; // 2 (by any other means)
    // 3: reset link issued for the user id, lands in the attacker's inbox
    account.email = "victim@x.com"; // 4
    const sweep = await completeReset(account); // 5

    expect(sweep).toHaveBeenCalledTimes(1); // the squatter's extras still go
    expect(account.emailVerified).toBe(false);
  });

  it("pins the reset sweep options", () => {
    expect(RESET_SWEEP_OPTIONS).toEqual({
      keepCredentialAndSessions: true,
      markEmailVerified: false,
    });
  });
});

describe("accountNotActiveRedirect", () => {
  const base = {
    authBaseURL: "http://localhost:3001/api/auth",
    webBaseURL: "http://localhost:3000",
  };

  it("magic link: redirects to errorCallbackURL", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/magic-link/verify",
        query: {
          callbackURL: "http://localhost:3000/",
          errorCallbackURL: "http%3A%2F%2Flocalhost%3A3000%2Fsign-in",
        },
      }),
    ).toBe("http://localhost:3000/sign-in?error=account_not_active");
  });

  it("magic link: keeps the scanner deep-link scheme", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/magic-link/verify",
        query: {
          callbackURL: "ithasfire-scanner://auth-callback",
          errorCallbackURL: "ithasfire-scanner://auth-error",
        },
      }),
    ).toBe("ithasfire-scanner://auth-error?error=account_not_active");
  });

  it("magic link: resolves a RELATIVE errorCallbackURL against baseURL, like the plugin", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/magic-link/verify",
        query: { callbackURL: "/", errorCallbackURL: "/oops" },
      }),
    ).toBe("http://localhost:3001/oops?error=account_not_active");
  });

  it("magic link: falls back to callbackURL when no errorCallbackURL", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/magic-link/verify",
        query: { callbackURL: "http://localhost:3000/home?x=1" },
      }),
    ).toBe("http://localhost:3000/home?x=1&error=account_not_active");
  });

  it("magic link with NO callbackURL (a JSON caller) gets the JSON 403", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/magic-link/verify",
        query: { errorCallbackURL: "/oops" },
      }),
    ).toBeNull();
  });

  it("OAuth callback: web sign-in", () => {
    expect(
      accountNotActiveRedirect({ ...base, path: "/callback/:id", query: {} }),
    ).toBe("http://localhost:3000/sign-in?error=account_not_active");
  });

  // Production runs `oAuthProxy` across two origins, so Google / Apple mint
  // their session on this route, not on `/callback/:id`
  // (second-factor-bypass-oauth.test.ts drives the real flow).
  it("OAuth proxy callback: web sign-in, never the proxy's own callbackURL", () => {
    expect(
      accountNotActiveRedirect({
        ...base,
        path: "/oauth-proxy-callback",
        query: { callbackURL: "https://ithasfire.com/my-tickets" },
      }),
    ).toBe("http://localhost:3000/sign-in?error=account_not_active");
  });

  it.each(["/sign-in/email", "/sign-in/email-otp", undefined])(
    "%s (API call) gets the JSON 403",
    (path) => {
      expect(accountNotActiveRedirect({ ...base, path, query: {} })).toBeNull();
    },
  );
});

describe("sweptAnything (gates the reset audit row)", () => {
  it("false when every count is zero", () => {
    expect(
      sweptAnything({
        credentialAccounts: 0,
        sessions: 0,
        passkeys: 0,
        twoFactor: 0,
        apiKeys: 0,
        apiKeyRequestsClosed: 0,
        phoneNumbers: 0,
        delegateGrants: 0,
        pendingInvitesRevoked: 0,
        pushDevices: 0,
      }),
    ).toBe(false);
  });

  it("true when the sweep only removed push devices (B2)", () => {
    expect(
      sweptAnything({
        credentialAccounts: 0,
        sessions: 0,
        passkeys: 0,
        twoFactor: 0,
        apiKeys: 0,
        apiKeyRequestsClosed: 0,
        phoneNumbers: 0,
        delegateGrants: 0,
        pendingInvitesRevoked: 0,
        pushDevices: 1,
      }),
    ).toBe(true);
  });

  it("true when the sweep only closed key requests (scoped API keys R31)", () => {
    expect(
      sweptAnything({
        credentialAccounts: 0,
        sessions: 0,
        passkeys: 0,
        twoFactor: 0,
        apiKeys: 0,
        apiKeyRequestsClosed: 1,
        phoneNumbers: 0,
        delegateGrants: 0,
        pendingInvitesRevoked: 0,
        pushDevices: 0,
      }),
    ).toBe(true);
  });

  it("true when anything was removed", () => {
    expect(sweptAnything(COUNTS)).toBe(true);
  });
});
