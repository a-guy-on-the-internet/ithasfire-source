import { APIError } from "better-auth/api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STAFF_USE_PASSKEY_ERROR,
  TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR,
} from "../src/auth/second-factor-bypass";

/**
 * The second-factor checks as the REAL config wires them.
 *
 * The other second-factor suites run the helpers in a stand-in
 * `betterAuth()`. This imports `apps/api/src/auth/better-auth.ts` itself and
 * calls the hooks on its options object, so a hook that is no longer called,
 * or is called without its reporter, fails here. Nothing connects to a
 * database: `@th/db`'s `prisma` is a stub that answers `authUser.findUnique`
 * (all the session and account hooks read through Prisma before reaching
 * these checks) and throws on anything else. Sentry is a spy.
 */

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("../src/instrument", () => ({
  Sentry: { captureException: mocks.captureException },
}));
vi.mock("@th/db", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    prisma: new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "authUser") return { findUnique: mocks.findUnique };
          if (typeof prop === "symbol" || prop === "then") return undefined;
          throw new Error(`unexpected prisma.${prop} in the wiring test`);
        },
      },
    ),
  };
});

type Hook = (row: unknown, ctx: unknown) => Promise<unknown>;
interface RealOptions {
  plugins: Array<{
    id: string;
    options?: {
      reportError?: (err: unknown, context?: unknown) => void;
      authentication?: { afterVerification?: (input: unknown) => Promise<void> };
    };
    hooks?: {
      before?: Array<{
        matcher(ctx: unknown): boolean;
        handler(ctx: unknown): Promise<unknown>;
      }>;
    };
  }>;
  databaseHooks: {
    session: { create: { before: Hook } };
    account: { create: { before: Hook } };
  };
  hooks: { before: (ctx: unknown) => Promise<unknown> };
}

let options: RealOptions;
let webOrigin: string;

beforeAll(async () => {
  const { auth } = await import("../src/auth/better-auth");
  const { env } = await import("../src/lib/env");
  options = auth.options as unknown as RealOptions;
  webOrigin = new URL(env.PUBLIC_WEB_URL ?? "http://localhost:3000").origin;
}, 120_000);

beforeEach(() => {
  mocks.captureException.mockReset();
  mocks.findUnique.mockReset();
  // An active human on a verified, unbanned mailbox: the ban gate and the
  // unproven-account sweep both let it through.
  mocks.findUnique.mockResolvedValue({
    id: "u1",
    emailVerified: true,
    email: null,
    human: { status: "ACTIVE" },
  });
});

const contextFor = (
  user: unknown,
  extra: { accounts?: unknown[]; passkey?: unknown; passkeys?: unknown[] } = {},
) => ({
  internalAdapter: {
    findUserById: vi.fn(async () => user),
    findAccounts: vi.fn(
      async () =>
        extra.accounts ?? [{ providerId: "credential", password: "hash" }],
    ),
  },
  adapter: {
    findMany: vi.fn(async () => extra.passkeys ?? []),
    findOne: vi.fn(async () => extra.passkey ?? null),
  },
});
const twoFactorUser = { twoFactorEnabled: true, emailVerified: true };
const failingContext = () => {
  const context = contextFor(twoFactorUser);
  context.internalAdapter.findUserById.mockRejectedValue(new Error("db down"));
  return context;
};

const expectReportedOnce = (op: string) => {
  expect(mocks.captureException).toHaveBeenCalledTimes(1);
  expect(mocks.captureException).toHaveBeenCalledWith(
    expect.objectContaining({ message: "db down" }),
    expect.objectContaining({
      tags: expect.objectContaining({ area: "auth", op }),
    }),
  );
};

describe("session.create.before of the real config", () => {
  const sessionHook = (ctx: unknown) =>
    options.databaseHooks.session.create.before({ userId: "u1" }, ctx);

  it("refuses a two-factor account on a route that is not listed", async () => {
    await expect(
      sessionHook({
        path: "/magic-link/verify",
        query: {},
        context: contextFor(twoFactorUser),
      }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR },
    });
  });

  it("sends a refused Google / Apple callback to the web app's sign-in page", async () => {
    const refusal = await sessionHook({
      path: "/oauth-proxy-callback",
      context: contextFor(twoFactorUser),
    }).catch((err: unknown) => err);

    expect(refusal).toMatchObject({ status: "FOUND" });
    const location = new URL(
      new Headers((refusal as { headers: HeadersInit }).headers).get(
        "location",
      )!,
    );
    expect(location.origin).toBe(webOrigin);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toBe(
      TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code,
    );
  });

  it("lets a listed route through to the rest of the hook", async () => {
    await expect(
      sessionHook({
        path: "/two-factor/verify-totp",
        context: contextFor(twoFactorUser),
      }),
    ).resolves.toEqual({ data: { ipAddress: null } });
  });

  it("lets an account without two-factor through", async () => {
    await expect(
      sessionHook({
        path: "/magic-link/verify",
        context: contextFor({ twoFactorEnabled: false }),
      }),
    ).resolves.toEqual({ data: { ipAddress: null } });
  });

  it("refuses the password for a staff account with a passkey and no TOTP (roles read from the Human)", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "u1",
      emailVerified: true,
      email: null,
      human: { status: "ACTIVE", roles: ["ADMIN"] },
    });
    await expect(
      sessionHook({
        path: "/sign-in/email",
        context: contextFor(
          { twoFactorEnabled: false },
          { passkeys: [{ id: "pk1" }] },
        ),
      }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...STAFF_USE_PASSKEY_ERROR },
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { human: { select: { roles: true } } },
    });
  });

  it("lets the same account's password through when it holds no staff role", async () => {
    await expect(
      sessionHook({
        path: "/sign-in/email",
        context: contextFor(
          { twoFactorEnabled: false },
          { passkeys: [{ id: "pk1" }] },
        ),
      }),
    ).resolves.toEqual({ data: { ipAddress: null } });
  });

  it("reports a lookup failure to Sentry, once, and answers with an APIError", async () => {
    const thrown = await sessionHook({
      path: "/magic-link/verify",
      context: failingContext(),
    }).catch((err: unknown) => err);

    // An APIError: `onAPIError.onError` reports only non-APIErrors, so the
    // report below is the only one.
    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expectReportedOnce("second_factor_bypass_lookup");
  });
});

describe("account.create.before of the real config", () => {
  const accountHook = (ctx: unknown, providerId = "google") =>
    options.databaseHooks.account.create.before(
      { userId: "u1", providerId },
      ctx,
    );

  it("skips the link row of a provider sign-in the session hook will refuse", async () => {
    await expect(
      accountHook({
        path: "/oauth-proxy-callback",
        context: contextFor(twoFactorUser),
      }),
    ).resolves.toBe(false);
  });

  it("skips the link row for a staff account with a passkey and no TOTP", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "u1",
      emailVerified: true,
      email: null,
      human: { status: "ACTIVE", roles: ["ADMIN"] },
    });
    await expect(
      accountHook({
        path: "/oauth-proxy-callback",
        context: contextFor(
          { twoFactorEnabled: false },
          { passkeys: [{ id: "pk1" }] },
        ),
      }),
    ).resolves.toBe(false);
  });

  it("writes the link for an account without two-factor", async () => {
    await expect(
      accountHook({
        path: "/oauth-proxy-callback",
        context: contextFor({ twoFactorEnabled: false }),
      }),
    ).resolves.toBeUndefined();
  });

  it("writes a link made from account settings", async () => {
    await expect(
      accountHook({ path: "/link-social", context: contextFor(twoFactorUser) }),
    ).resolves.toBeUndefined();
  });

  it("never skips the password row", async () => {
    await expect(
      accountHook(
        { path: "/reset-password", context: contextFor(twoFactorUser) },
        "credential",
      ),
    ).resolves.toBeUndefined();
  });

  it("reports a lookup failure to Sentry, once", async () => {
    await expect(
      accountHook({ path: "/oauth-proxy-callback", context: failingContext() }),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expectReportedOnce("second_factor_provider_link_lookup");
  });
});

describe("the passkey plugin of the real config", () => {
  const afterVerification = (input: unknown) =>
    options.plugins
      .find((plugin) => plugin.id === "passkey")!
      .options!.authentication!.afterVerification!(input);
  const assertion = (userVerified: boolean, context: unknown) => ({
    ctx: { context },
    verification: { authenticationInfo: { userVerified } },
    clientData: { id: "cred-1" },
  });

  it("refuses a two-factor account's passkey that did not verify the user", async () => {
    await expect(
      afterVerification(
        assertion(
          false,
          contextFor(twoFactorUser, { passkey: { userId: "u1" } }),
        ),
      ),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  it("refuses a staff account's passkey that did not verify the user (no TOTP)", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "u1",
      emailVerified: true,
      email: null,
      human: { status: "ACTIVE", roles: ["SUPPORT"] },
    });
    await expect(
      afterVerification(
        assertion(
          false,
          contextFor({ twoFactorEnabled: false }, { passkey: { userId: "u1" } }),
        ),
      ),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  it("lets a passkey that verified the user through", async () => {
    await expect(
      afterVerification(
        assertion(
          true,
          contextFor(twoFactorUser, { passkey: { userId: "u1" } }),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("reports a lookup failure to Sentry, once", async () => {
    const context = contextFor(twoFactorUser, { passkey: { userId: "u1" } });
    context.internalAdapter.findUserById.mockRejectedValue(
      new Error("db down"),
    );
    await expect(
      afterVerification(assertion(false, context)),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expectReportedOnce("second_factor_passkey_lookup");
  });
});

describe("the password-or-passkey prerequisites in the real config", () => {
  const plugin = () =>
    options.plugins.find((p) => p.id === "two-factor-prerequisites");

  it("is installed, on its five routes and no other", () => {
    const matcher = plugin()!.hooks!.before![0]!.matcher;
    for (const path of [
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
      "/two-factor/verify-totp",
      "/unlink-account",
      "/passkey/delete-passkey",
    ]) {
      expect(matcher({ path }), path).toBe(true);
    }
    for (const path of ["/two-factor/enable", "/sign-in/email", undefined]) {
      expect(matcher({ path }), String(path)).toBe(false);
    }
  });

  it("its hook reports a lookup failure to Sentry, once, and answers with an APIError", async () => {
    const context = failingContext();
    const thrown = await plugin()!
      .hooks!.before![0]!.handler({
        path: "/two-factor/send-otp",
        method: "POST",
        body: {},
        query: {},
        headers: new Headers(),
        // A signed-in caller: Better Auth reads `context.session` first.
        context: { ...context, session: { user: { id: "u1" } } },
      })
      .catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expectReportedOnce("two_factor_prerequisite_lookup");
  });
});

describe("hooks.before of the real config", () => {
  it("no longer answers for /sign-in/email-otp before the code is checked (it told a caller which accounts have two-factor)", async () => {
    const findUserByEmail = vi.fn(async () => ({ user: twoFactorUser }));
    await expect(
      options.hooks.before({
        path: "/sign-in/email-otp",
        body: { email: "staff@example.com", otp: "000000" },
        headers: new Headers(),
        context: { internalAdapter: { findUserByEmail } },
      }),
    ).resolves.not.toBeInstanceOf(APIError);
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it("still refuses the endpoints that change an email without proving it", async () => {
    await expect(
      options.hooks.before({
        path: "/change-email",
        body: {},
        headers: new Headers(),
        context: {},
      }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
  });

  it("refuses core /verify-email (link verification skips the B2 sweep)", async () => {
    await expect(
      options.hooks.before({
        path: "/verify-email",
        query: { token: "x" },
        headers: new Headers(),
        context: {},
      }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: expect.objectContaining({ code: "USE_EMAIL_CODE_VERIFICATION" }),
    });
  });
});
