/**
 * A two-factor account gets a session only on a listed route.
 *
 * Better Auth's twoFactor plugin raises its challenge from an after-hook keyed
 * on three paths: `/sign-in/email`, `/sign-in/username`,
 * `/sign-in/phone-number` (better-auth 1.6.9
 * `dist/plugins/two-factor/index.mjs:192`). Every other route that calls
 * `createSession` hands an account with `twoFactorEnabled` a FULL session and
 * the second factor is never asked for. The staff gate
 * (`AuthZPort.hasStaffRole`, which answers `secondFactorRequired`, surfaced by
 * `throwIfStaffSecondFactorRequired` in `packages/transport/trpc/src/guard.ts`)
 * then passes too, because it checks that a factor is ENROLLED, not that this
 * session passed one.
 *
 * So `databaseHooks.session.create.before` decides from an ALLOWLIST: a
 * two-factor account gets a session only on a route listed in
 * `SECOND_FACTOR_SATISFIED_ROUTES`. Any other route is refused, including one
 * a later plugin or upgrade adds, until someone lists it here. Add a route
 * only after reading its handler and establishing which of the four reasons
 * below holds.
 *
 * WHAT THIS DOES NOT GUARANTEE. It guarantees the route, not the strength of
 * what the route accepts. `/two-factor/verify-otp` accepts a code the plugin
 * mails (or texts, to a verified phone), and a password can be reset by a
 * mailed link, so whoever holds the inbox of a two-factor account can still
 * sign in: reset the password, sign in with it, ask for the mailed code.
 * The owner ruled on 2026-10-14 that a mailed or texted code counts as the
 * second factor, also for an account with an authenticator app enrolled; the
 * inbox (or SIM) holder getting in is the accepted cost.
 *
 * Every `createSession` call site reachable with this app's plugins
 * (better-auth and @better-auth/passkey 1.6.9), and what happens to a
 * two-factor account there:
 *
 *  | Route                              | Proves                        | Two-factor account |
 *  | ---------------------------------- | ----------------------------- | ------------------ |
 *  | `/sign-in/email`                   | password                      | allowed: the plugin deletes this session and challenges, unless a trusted-device cookie from an earlier passed challenge is presented |
 *  | `/sign-in/username`                | password                      | allowed: same |
 *  | `/sign-in/phone-number`            | password                      | allowed: same |
 *  | `/two-factor/verify-totp`          | TOTP code                     | allowed: the challenge was passed (or a signed-in user is finishing enrolment) |
 *  | `/two-factor/verify-otp`           | texted / mailed 2FA code      | allowed: same |
 *  | `/two-factor/verify-backup-code`   | backup code                   | allowed: same |
 *  | `/passkey/verify-authentication`   | passkey                       | allowed when the passkey verified the user (`refuseUnverifiedPasskeyForTwoFactor`); a passkey satisfies the second factor on its own (owner ruling 2026-10-10) |
 *  | `/change-password`                 | session + current password    | allowed: rotates the caller's own session (`revokeOtherSessions`) |
 *  | `/sign-in/email-otp`               | the inbox                     | refused |
 *  | `/magic-link/verify`               | the inbox                     | refused |
 *  | `/phone-number/verify`             | the SIM                       | refused |
 *  | `/oauth-proxy-callback`            | a Google / Apple account      | refused, and the provider is not linked (see `providerIsOnlyWayIn`) |
 *  | `/callback/:id`                    | a Google / Apple account      | refused (same) |
 *  | `/sign-in/social` with an idToken  | a Google / Apple account      | refused (same) |
 *  | `/sign-up/email`                   | nothing (a new account)       | never two-factor |
 *  | `/two-factor/disable`              | session + password            | the flag is already off when the session rotates |
 *  | `/verify-email`, `/email-otp/verify-email`, `/two-factor/enable` | | mint a session only with options this app leaves off (`autoSignInAfterVerification`, `changeEmail`, `skipVerificationOnEnable`); refused if that changes |
 *
 * STAFF WITH A PASSKEY AND NO AUTHENTICATOR APP. A staff role
 * (`SECOND_FACTOR_STAFF_ROLES` in `@th/ports/authz`) counts as enrolled with
 * a passkey alone (`hasSecondFactorEnrolled`), but the plugin challenges only
 * `twoFactorEnabled` accounts, so the password (or the inbox, or Google /
 * Apple) would get a full session that passes every staff check. Such an
 * account is "passkey-gated" (`SecondFactorState.staffPasskeyGated`, filled
 * by `decideForUser`) and gets a session only on `STAFF_PASSKEY_ROUTES`:
 *
 *  | Route                              | Passkey-gated staff account |
 *  | ---------------------------------- | --------------------------- |
 *  | `/passkey/verify-authentication`   | allowed when the passkey verified the user (`refuseUnverifiedPasskeyForTwoFactor`) |
 *  | `/change-password`                 | allowed: rotates a session the caller already holds |
 *  | `/two-factor/disable`              | allowed: needs a session plus the password, and turns that session into a fresh one (staff with TOTP and a passkey turning TOTP off; the flag is off by the time the session rotates) |
 *  | `/two-factor/verify-totp`, `/two-factor/verify-otp` | enrolment turns `twoFactorEnabled` on BEFORE the session rotates (1.6.9 `totp/index.mjs:147`, `otp/index.mjs:176`), so the account is a two-factor account there and the table above applies |
 *  | every other route, the password sign-ins included | refused with STAFF_ACCOUNT_USE_PASSKEY (`/sign-in/email` answers 400 JSON; magic link and Google / Apple redirect as above) |
 *
 * A staff account with no factor at all signs in as before: its roles grant
 * nothing until it enrols one. And a two-factor STAFF account with no
 * password and no passkey is refused on Google / Apple (the `provider_only`
 * allowance below is for non-staff only); it gets back in by resetting its
 * password and passing the mailed code.
 *
 * With `oAuthProxy` configured across two origins, as it is here (web vs API),
 * the browser Google / Apple flow mints its session on
 * `/oauth-proxy-callback`, not on `/callback/:id`: the proxy's before-hook on
 * `/callback/:id` exchanges the code and redirects on (1.6.9
 * `plugins/oauth-proxy/index.mjs:129-235`).
 *
 * An UNVERIFIED account with two-factor on (someone registered an address
 * they never proved, possibly a squatter) needs no exception here. The first
 * proof of its inbox (email code, magic link, a first Google / Apple link)
 * runs the unproven-account sweep before the session is created
 * (`revokeUnprovenCredentials`, from `user.update.before` and
 * `account.create.before`), which turns two-factor off. By the time this
 * check reads the row it says "no 2FA", and the inbox owner gets in.
 *
 * Revisit a refusal only by wiring that route into the real challenge, never
 * by assuming the plugin covers it.
 */

import {
  APIError,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
} from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { bearer } from "better-auth/plugins";
import { isSecondFactorStaffRole } from "@th/ports/authz";
import type { ReporterPort } from "@th/ports/reporter";

import { accountNotActiveRedirect } from "./account-security";

export const TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR = {
  code: "TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN",
  message:
    "This account uses two-factor authentication. Sign in with your password or passkey.",
} as const;

/** The refusal for a passkey-gated staff account (see the module header). */
export const STAFF_USE_PASSKEY_ERROR = {
  code: "STAFF_ACCOUNT_USE_PASSKEY",
  message: "This is a staff account. Sign in with your passkey.",
} as const;

type RefusalError =
  | typeof TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR
  | typeof STAFF_USE_PASSKEY_ERROR;

/**
 * The staff roles of the Human behind an auth user id (`Human.roles`). Empty
 * for an account with no Human yet.
 */
export type StaffRolesOf = (authUserId: string) => Promise<readonly string[]>;

/**
 * The routes a two-factor account may get a session on, and why:
 *
 *  - `plugin_challenge`: a password sign-in the twoFactor plugin intercepts.
 *    The session minted here is deleted in the same request and replaced by
 *    the challenge, unless the request carries a valid trusted-device cookie.
 *    These must stay equal to the plugin's own matcher.
 *  - `second_factor_passed`: the session is minted after the code validated.
 *  - `strong_factor`: a passkey.
 *  - `session_rotation`: the caller already holds a session for this account
 *    (`sensitiveSessionMiddleware`) and is replacing it.
 */
export const SECOND_FACTOR_SATISFIED_ROUTES = {
  "/sign-in/email": "plugin_challenge",
  "/sign-in/username": "plugin_challenge",
  "/sign-in/phone-number": "plugin_challenge",
  "/two-factor/verify-totp": "second_factor_passed",
  "/two-factor/verify-otp": "second_factor_passed",
  "/two-factor/verify-backup-code": "second_factor_passed",
  "/passkey/verify-authentication": "strong_factor",
  "/change-password": "session_rotation",
} as const satisfies Record<
  string,
  | "plugin_challenge"
  | "second_factor_passed"
  | "strong_factor"
  | "session_rotation"
>;

export type SecondFactorSatisfiedRoute =
  keyof typeof SECOND_FACTOR_SATISFIED_ROUTES;

export const isSecondFactorSatisfiedRoute = (
  path: string | undefined,
): path is SecondFactorSatisfiedRoute =>
  typeof path === "string" &&
  Object.prototype.hasOwnProperty.call(SECOND_FACTOR_SATISFIED_ROUTES, path);

/**
 * The routes a passkey-gated staff account (a staff role, a passkey, no TOTP)
 * may get a session on. `session_rotation` needs a session the caller already
 * holds (`sessionMiddleware` / `sensitiveSessionMiddleware`).
 */
export const STAFF_PASSKEY_ROUTES = {
  "/passkey/verify-authentication": "strong_factor",
  "/change-password": "session_rotation",
  "/two-factor/disable": "session_rotation",
} as const satisfies Record<string, "strong_factor" | "session_rotation">;

export const isStaffPasskeyRoute = (path: string | undefined): boolean =>
  typeof path === "string" &&
  Object.prototype.hasOwnProperty.call(STAFF_PASSKEY_ROUTES, path);

/** Allowed for every account whatever its state: no lookup needed. */
const isAllowedForEveryAccount = (path: string | undefined): boolean =>
  isSecondFactorSatisfiedRoute(path) && isStaffPasskeyRoute(path);

/**
 * Google / Apple sign-ins. The first two are browser NAVIGATIONS (the refusal
 * is a redirect); `/sign-in/social` mints a session only for an `idToken`
 * body and answers JSON.
 */
const PROVIDER_NAVIGATION_ROUTES: ReadonlySet<string> = new Set([
  "/oauth-proxy-callback",
  "/callback/:id",
]);
const PROVIDER_ROUTES: ReadonlySet<string> = new Set([
  ...PROVIDER_NAVIGATION_ROUTES,
  "/sign-in/social",
]);

export interface SecondFactorState {
  twoFactorEnabled?: boolean | null;
  /**
   * Holds a staff role and has a passkey, with `twoFactorEnabled` off. Not a
   * column: `decideForUser` fills it from `Human.roles` and the passkey rows.
   */
  staffPasskeyGated?: boolean;
}

/**
 * Would a session minted on `path` skip this account's second factor?
 *
 * Deny by default: for a two-factor account every route outside
 * `SECOND_FACTOR_SATISFIED_ROUTES` answers true, and for a passkey-gated
 * staff account every route outside `STAFF_PASSKEY_ROUTES`, an unknown or
 * missing path included. There is no exception for an unverified email: see
 * the module header for why none is needed.
 */
export function bypassesSecondFactor(
  path: string | undefined,
  user: SecondFactorState | null | undefined,
): boolean {
  if (user?.twoFactorEnabled) return !isSecondFactorSatisfiedRoute(path);
  if (user?.staffPasskeyGated) return !isStaffPasskeyRoute(path);
  return false;
}

const reportSafely = (
  reportError: ReporterPort | undefined,
  err: unknown,
  op: string,
  extra: Record<string, unknown>,
): void => {
  try {
    reportError?.(err, { tags: { area: "auth", op }, extra });
  } catch {
    // Best-effort by contract (see `@th/ports/reporter`).
  }
};

/**
 * The 500 a failed lookup answers with. An APIError on purpose: the cause was
 * already reported by the caller, and `onAPIError.onError` in `better-auth.ts`
 * reports every NON-APIError a hook throws, so rethrowing the raw error would
 * report it twice.
 */
const lookupFailed = (): APIError =>
  new APIError("INTERNAL_SERVER_ERROR", {
    message: "Could not complete sign-in.",
  });

interface RefusalInput {
  path: string | undefined;
  query: Record<string, unknown> | undefined;
  authBaseURL: string;
  webBaseURL: string;
  reportError?: ReporterPort;
  /** Default: TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR. */
  error?: RefusalError;
}

/**
 * Where to send a browser whose sign-in was refused on a NAVIGATION route, or
 * null to answer with the JSON 400.
 *
 *  - Magic-link verify: only when the caller sent a `callbackURL`. The target
 *    is `errorCallbackURL` (else `callbackURL`), resolved exactly as the
 *    ACCOUNT_NOT_ACTIVE refusal resolves it (`accountNotActiveRedirect`), with
 *    only the error value replaced.
 *  - Google / Apple callbacks: the web sign-in page, on both routes. On
 *    `/oauth-proxy-callback` (production) the flow's own error URL is not
 *    available here: it travels in the proxy's encrypted profile. On
 *    `/callback/:id` it is (`getOAuthState().errorURL`), but it is used on
 *    neither so the two behave the same; when the caller sent no
 *    `errorCallbackURL` it is Better Auth's API-origin `/error` page anyway.
 *
 * A web origin that is not a URL (`PUBLIC_WEB_URL` is an unvalidated string)
 * cannot be redirected to: the refusal still happens, as JSON on the API
 * origin, and the misconfiguration is reported.
 */
export function secondFactorRefusalRedirect(input: RefusalInput): string | null {
  const { path } = input;
  try {
    let target: URL;
    if (path === "/magic-link/verify") {
      const resolved = accountNotActiveRedirect(input);
      if (!resolved) return null;
      target = new URL(resolved);
    } else if (path !== undefined && PROVIDER_NAVIGATION_ROUTES.has(path)) {
      target = new URL("/sign-in", input.webBaseURL);
    } else {
      return null;
    }
    target.searchParams.set(
      "error",
      (input.error ?? TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR).code,
    );
    return target.toString();
  } catch (err) {
    reportSafely(input.reportError, err, "second_factor_refusal_redirect", {
      path,
      webBaseURL: input.webBaseURL,
    });
    return null;
  }
}

/**
 * Refuse with `input.error` (default TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN):
 * a redirect carrying `?error=<code>` where the browser is navigating
 * (`secondFactorRefusalRedirect`), otherwise the 400 JSON. It must
 * be thrown from the handler (the session hook): an after-hook's replacement
 * response keeps the original status.
 */
export function throwSecondFactorBypassRefusal(input: RefusalInput): never {
  const redirectTo = secondFactorRefusalRedirect(input);
  if (redirectTo) {
    throw new APIError("FOUND", undefined, { Location: redirectTo });
  }
  throw new APIError("BAD_REQUEST", {
    ...(input.error ?? TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR),
  });
}

type Where = Array<{ field: string; value: string }>;

/** The parts of Better Auth's endpoint context these checks read. */
interface GateAdapters {
  baseURL?: string;
  internalAdapter?: {
    findUserById(userId: string): Promise<unknown>;
    findAccounts(userId: string): Promise<unknown>;
  };
  adapter?: {
    findMany(input: {
      model: string;
      where: Where;
      limit?: number;
    }): Promise<unknown>;
    findOne(input: { model: string; where: Where }): Promise<unknown>;
  };
}

interface HookCtx {
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  context?: GateAdapters;
}

const hookPathOf = (c: HookCtx | null | undefined): string | undefined =>
  typeof c?.path === "string" ? c.path : undefined;

/**
 * The sign-ins an account can pass a second factor on: its password, and its
 * passkeys (by id). The passkey model name is the one the plugin itself reads
 * (@better-auth/passkey 1.6.9 `dist/index.mjs`, `model: "passkey"`).
 */
async function primarySignInOf(
  adapters: GateAdapters,
  userId: string,
): Promise<{ hasPassword: boolean; passkeyIds: string[] }> {
  const { internalAdapter, adapter } = adapters;
  if (!internalAdapter || !adapter) {
    throw new Error("second-factor gate: no database adapter on the context");
  }
  const accounts = (await internalAdapter.findAccounts(userId)) as
    | Array<{ providerId?: unknown; password?: unknown }>
    | null
    | undefined;
  const hasPassword = (accounts ?? []).some(
    (a) =>
      a.providerId === "credential" &&
      typeof a.password === "string" &&
      a.password.length > 0,
  );
  const passkeys = (await adapter.findMany({
    model: "passkey",
    where: [{ field: "userId", value: userId }],
  })) as Array<{ id?: unknown }> | null | undefined;
  return {
    hasPassword,
    passkeyIds: (passkeys ?? []).map((p) => String(p.id)),
  };
}

/**
 * Is a Google / Apple sign-in this account's only way in?
 *
 * Refusing the provider is safe only when the account can still sign in with
 * a password or a passkey. One that has neither would be locked out.
 * `twoFactorPrerequisites` below and the staff unlink in `packages/core`
 * refuse the requests that lead there, but they check, then the route acts:
 * two concurrent requests (deleting the last passkey while unlinking the
 * password, or enrolling while removing either) can each pass the check and
 * together reach the state. That race must be closed (a lock, or a re-check
 * inside the write) before this allowance is removed. Accounts also got here
 * before 2026-10-10:
 * `/two-factor/verify-otp` turned `twoFactorEnabled` on for any signed-in
 * user with a mailed or texted code and no password (better-auth 1.6.9
 * `plugins/two-factor/otp/index.mjs:174-187`), and `/unlink-account` or a
 * staff unlink could remove the password afterwards. For those accounts the
 * provider sign-in is left as it was, and every such sign-in is reported so
 * the gap stays visible. Not for a STAFF account: `decideForUser` refuses
 * it, because a staff role must not be reached without a factor.
 *
 * INTERIM: delete this once production has no two-factor account without a
 * password or passkey (the count is in the step's report).
 */
async function providerIsOnlyWayIn(
  path: string | undefined,
  adapters: GateAdapters,
  userId: string,
): Promise<boolean> {
  if (path === undefined || !PROVIDER_ROUTES.has(path)) return false;
  const primary = await primarySignInOf(adapters, userId);
  return !primary.hasPassword && primary.passkeyIds.length === 0;
}

type SessionDecision =
  | "allow"
  | "refuse"
  | "refuse_staff_passkey"
  | "provider_only";

/**
 * Does the account hold a staff role? Throws when no lookup was wired, so the
 * caller fails closed (a gate that cannot see roles must not guess "none").
 */
async function holdsStaffRole(
  staffRolesOf: StaffRolesOf | undefined,
  userId: string,
): Promise<boolean> {
  if (!staffRolesOf) {
    throw new Error("second-factor gate: no staff-role lookup wired");
  }
  const roles = await staffRolesOf(userId);
  return roles.some(isSecondFactorStaffRole);
}

/**
 * The one decision both the session hook and the link hook make. Reads only
 * what the answer needs: a two-factor account's roles only on a provider
 * route with no password or passkey; an account without two-factor's roles
 * only off `STAFF_PASSKEY_ROUTES`, and its passkeys only when it is staff.
 */
async function decideForUser(
  path: string | undefined,
  user: SecondFactorState,
  adapters: GateAdapters,
  userId: string,
  staffRolesOf: StaffRolesOf | undefined,
): Promise<SessionDecision> {
  if (user.twoFactorEnabled) {
    if (!bypassesSecondFactor(path, user)) return "allow";
    if (await providerIsOnlyWayIn(path, adapters, userId)) {
      // A staff role is authority: no session without a factor, whatever
      // the lockout risk. Recovery is a password reset plus the mailed code.
      return (await holdsStaffRole(staffRolesOf, userId))
        ? "refuse"
        : "provider_only";
    }
    return "refuse";
  }
  if (isStaffPasskeyRoute(path)) return "allow";
  if (!(await holdsStaffRole(staffRolesOf, userId))) return "allow";
  const primary = await primarySignInOf(adapters, userId);
  const gated: SecondFactorState = {
    ...user,
    staffPasskeyGated: primary.passkeyIds.length > 0,
  };
  return bypassesSecondFactor(path, gated) ? "refuse_staff_passkey" : "allow";
}

/**
 * The `databaseHooks.session.create.before` check. Runs where the user id is
 * known and only when a session is actually being minted, so on
 * `/phone-number/verify` it sees exactly the sign-in use: the
 * `updatePhoneNumber` mode (verifying a number on an already-signed-in
 * account) and `disableSession: true` never call `createSession` (better-auth
 * 1.6.9 `plugins/phone-number/routes.mjs:301-325`, `:352`). It also runs only
 * after the code, link or provider token was proven, so the refusal tells
 * nothing to someone who cannot already prove the inbox, SIM or provider
 * account.
 *
 * The hook receives the endpoint context (`db/with-hooks.mjs` passes
 * `getCurrentAuthContext()`), whose `path` is the route template
 * (`/callback/:id`, not `/callback/google`).
 *
 * Fails closed. A missing adapter, a failed lookup, or a user row that cannot
 * be read is reported once and answered with a 500. (Every real route reads
 * its user. Sign-up creates the row before the session, and this app's
 * Prisma adapter runs without a transaction, so the row is committed by
 * then; were one turned on, the lookup would go through it, 1.6.9
 * `db/internal-adapter.mjs` `getCurrentAdapter`.)
 */
export async function refuseSecondFactorBypassSession(
  ctx: unknown,
  userId: string,
  opts: {
    authBaseURL: string;
    webBaseURL: string;
    reportError?: ReporterPort;
    /** Required: without it every lookup-needing session is refused (500). */
    staffRolesOf: StaffRolesOf;
  },
): Promise<void> {
  const c = ctx as HookCtx | null | undefined;
  const path = hookPathOf(c);
  // Passkey and change-password: allowed in every state, no lookup.
  if (isAllowedForEveryAccount(path)) return;

  const adapters = c?.context;
  if (!adapters?.internalAdapter) {
    // Every endpoint context carries one. Without it (a session minted
    // outside an endpoint) nobody can tell whether the account has 2FA.
    reportSafely(
      opts.reportError,
      new Error("second-factor gate: session minted without an endpoint context"),
      "second_factor_bypass_no_context",
      { authUserId: userId, path },
    );
    throw lookupFailed();
  }

  let decision: SessionDecision;
  try {
    const user = (await adapters.internalAdapter.findUserById(
      userId,
    )) as SecondFactorState | null;
    if (!user) {
      throw new Error("second-factor gate: no user row for the new session");
    }
    decision = await decideForUser(
      path,
      user,
      adapters,
      userId,
      opts.staffRolesOf,
    );
  } catch (err) {
    reportSafely(opts.reportError, err, "second_factor_bypass_lookup", {
      authUserId: userId,
      path,
    });
    throw lookupFailed();
  }

  if (decision === "provider_only") {
    reportSafely(
      opts.reportError,
      new Error(
        "two-factor account signed in by provider with no second factor: it has no password and no passkey",
      ),
      "second_factor_provider_only_allowed",
      { authUserId: userId, path },
    );
    return;
  }
  if (decision === "refuse" || decision === "refuse_staff_passkey") {
    throwSecondFactorBypassRefusal({
      path,
      query: c?.query,
      authBaseURL: adapters.baseURL ?? opts.authBaseURL,
      webBaseURL: opts.webBaseURL,
      reportError: opts.reportError,
      error:
        decision === "refuse_staff_passkey"
          ? STAFF_USE_PASSKEY_ERROR
          : TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR,
    });
  }
}

/**
 * The `databaseHooks.account.create.before` check: should this provider
 * account NOT be written?
 *
 * Better Auth links a Google / Apple account onto the user before it creates
 * the session (`oauth2/link-account.mjs`), so a sign-in the session hook goes
 * on to refuse would still leave the link row and the provider's tokens on
 * the account. This answers true exactly when the session hook will refuse
 * (the same decision, `decideForUser`), and the caller returns `false` from
 * the hook: Better Auth then skips the insert and carries on to
 * `createSession`, where the refusal is answered with the right redirect or
 * body. (Throwing here instead would be swallowed into Better Auth's generic
 * "unable to link account".)
 *
 * Left alone:
 *  - the password row (`credential`): sign-up, and the account a password
 *    reset creates;
 *  - a signed-in user linking a provider from account settings. That is not a
 *    sign-in: `/link-social` with an idToken, or the `/callback/:id` that
 *    ends a `/link-social` redirect, which carries `link.userId` in its
 *    OAuth state;
 *  - a user row that cannot be read yet (a Google / Apple sign-up creates
 *    user and account together);
 *  - an unverified account: the caller runs the unproven-account sweep first,
 *    which turns two-factor off, so the inbox owner's first link goes through.
 */
export async function skipsProviderLinkForTwoFactor(
  ctx: unknown,
  account: { userId: string; providerId: string },
  opts: {
    reportError?: ReporterPort;
    staffRolesOf: StaffRolesOf;
    /** `link.userId` of the request's OAuth state. Default: Better Auth's. */
    oauthLinkUserId?: () => Promise<string | undefined>;
  },
): Promise<boolean> {
  if (account.providerId === "credential") return false;
  const c = ctx as HookCtx | null | undefined;
  const path = hookPathOf(c);
  if (path === "/link-social") return false;

  const adapters = c?.context;
  try {
    if (path === "/callback/:id") {
      const linkUserId = await (opts.oauthLinkUserId ?? oauthStateLinkUserId)();
      if (linkUserId !== undefined && linkUserId === account.userId) {
        return false;
      }
    }
    if (!adapters?.internalAdapter) {
      throw new Error("second-factor gate: account linked without an endpoint context");
    }
    const user = (await adapters.internalAdapter.findUserById(
      account.userId,
    )) as SecondFactorState | null;
    if (!user) return false;
    const decision = await decideForUser(
      path,
      user,
      adapters,
      account.userId,
      opts.staffRolesOf,
    );
    return decision === "refuse" || decision === "refuse_staff_passkey";
  } catch (err) {
    reportSafely(opts.reportError, err, "second_factor_provider_link_lookup", {
      authUserId: account.userId,
      providerId: account.providerId,
      path,
    });
    throw lookupFailed();
  }
}

const oauthStateLinkUserId = async (): Promise<string | undefined> => {
  const state = (await getOAuthState()) as {
    link?: { userId?: unknown } | null;
  } | null;
  const userId = state?.link?.userId;
  return userId === undefined || userId === null ? undefined : String(userId);
};

/**
 * The passkey plugin's `authentication.afterVerification` check.
 *
 * A passkey counts as a two-factor account's second factor because it is
 * something the user has that also verified the user (PIN or biometric). The
 * plugin asks for that only as `userVerification: "preferred"` and verifies
 * with `requireUserVerification: false` (@better-auth/passkey 1.6.9
 * `dist/index.mjs:263`, `:428`), so a security key with no PIN signs in with
 * a touch. For a two-factor account that is one factor: refused. The same
 * holds for a staff account: its passkey is the factor its roles rest on
 * (and for a passkey-gated one, its only way in). Any other account is
 * unaffected.
 *
 * It runs after the assertion verified and before `createSession`. The
 * plugin turns anything thrown here into its own 400 AUTHENTICATION_FAILED
 * (`dist/index.mjs:458-461`), so the caller sees a failed passkey sign-in and
 * no session or cookie is written.
 */
export async function refuseUnverifiedPasskeyForTwoFactor(
  input: {
    ctx: unknown;
    verification: { authenticationInfo?: { userVerified?: boolean } };
    clientData: { id?: string };
  },
  opts: { reportError?: ReporterPort; staffRolesOf: StaffRolesOf },
): Promise<void> {
  if (input.verification.authenticationInfo?.userVerified === true) return;
  const adapters = (input.ctx as HookCtx | null | undefined)?.context;
  const credentialId = input.clientData.id;
  let refusal: "two_factor" | "staff" | null = null;
  try {
    if (!adapters?.internalAdapter || !adapters.adapter || !credentialId) {
      throw new Error("second-factor gate: passkey verified without a context");
    }
    const passkey = (await adapters.adapter.findOne({
      model: "passkey",
      where: [{ field: "credentialID", value: credentialId }],
    })) as { userId?: unknown } | null;
    const userId = typeof passkey?.userId === "string" ? passkey.userId : null;
    const user = userId
      ? ((await adapters.internalAdapter.findUserById(
          userId,
        )) as SecondFactorState | null)
      : null;
    if (!userId || !user) {
      throw new Error("second-factor gate: no user for the verified passkey");
    }
    if (user.twoFactorEnabled) refusal = "two_factor";
    else if (await holdsStaffRole(opts.staffRolesOf, userId)) refusal = "staff";
  } catch (err) {
    reportSafely(opts.reportError, err, "second_factor_passkey_lookup", {
      credentialId,
    });
    throw lookupFailed();
  }
  if (refusal) {
    throw new APIError("UNAUTHORIZED", {
      code: "AUTHENTICATION_FAILED",
      message:
        refusal === "staff"
          ? "This passkey did not verify you with a PIN or biometric, which a staff account requires."
          : "This passkey did not verify you with a PIN or biometric, which an account with two-factor authentication requires.",
    });
  }
}

// ── A two-factor account always keeps a password or a passkey ──────────────

const TWO_FACTOR_ENROLMENT_ROUTES: ReadonlySet<string> = new Set([
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/verify-totp",
]);
const PREREQUISITE_ROUTES: ReadonlySet<string> = new Set([
  ...TWO_FACTOR_ENROLMENT_ROUTES,
  "/unlink-account",
  "/passkey/delete-passkey",
]);

/**
 * The refusals, with Better Auth's own codes for the nearest case
 * (`BASE_ERROR_CODES`) and copy that says what to do.
 */
export const TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR = {
  code: "CREDENTIAL_ACCOUNT_NOT_FOUND",
  message:
    "Set a password or add a passkey before turning on two-factor authentication.",
} as const;
export const TWO_FACTOR_KEEPS_PASSWORD_ERROR = {
  code: "FAILED_TO_UNLINK_LAST_ACCOUNT",
  message:
    "Add a passkey or turn off two-factor authentication before removing your password.",
} as const;
export const TWO_FACTOR_KEEPS_PASSKEY_ERROR = {
  code: "FAILED_TO_UNLINK_LAST_ACCOUNT",
  message:
    "Set a password or turn off two-factor authentication before removing your last passkey.",
} as const;

/**
 * Refuse a request that would leave a two-factor account with neither a
 * password nor a passkey: the state in which only a Google / Apple sign-in
 * gets in, and that sign-in cannot be asked for a second factor.
 *
 *  - Turning two-factor on (`/two-factor/send-otp`, `/two-factor/verify-otp`,
 *    `/two-factor/verify-totp` by a signed-in user whose flag is off). The
 *    mailed-code route needs no password at all in the plugin; the
 *    authenticator route asks for one at `/two-factor/enable`, but it could be
 *    removed before the first code is verified.
 *  - `/unlink-account` for `credential` while two-factor is on and there is no
 *    passkey.
 *  - `/passkey/delete-passkey` for the last passkey while two-factor is on and
 *    there is no password.
 *
 * Without a session these routes are something else (the sign-in challenge on
 * `/two-factor/*`) or answer 401 themselves, so the check does nothing. Reads
 * the user fresh: the session's copy may come from the cookie cache.
 */
export async function refuseTwoFactorWithoutPrimarySignIn(
  ctx: unknown,
  opts: {
    reportError?: ReporterPort;
    /** The signed-in user's id, or null. Default: Better Auth's session. */
    sessionUserId?: (ctx: unknown) => Promise<string | null>;
  } = {},
): Promise<void> {
  const c = ctx as HookCtx | null | undefined;
  const path = hookPathOf(c);
  if (path === undefined || !PREREQUISITE_ROUTES.has(path)) return;
  const body = (c?.body ?? {}) as { providerId?: unknown; id?: unknown };
  if (path === "/unlink-account" && body.providerId !== "credential") return;

  let userId: string | null = null;
  let refusal: { code: string; message: string } | null = null;
  try {
    userId = await (opts.sessionUserId ?? sessionUserIdOf)(ctx);
    if (!userId) return;
    const adapters = c?.context;
    if (!adapters?.internalAdapter) {
      throw new Error("second-factor gate: no database adapter on the context");
    }
    const user = (await adapters.internalAdapter.findUserById(
      userId,
    )) as SecondFactorState | null;
    if (!user) return;
    const twoFactorOn = Boolean(user.twoFactorEnabled);
    const enrolling = TWO_FACTOR_ENROLMENT_ROUTES.has(path);
    // An account with two-factor on that posts a code is being challenged or
    // already enrolled; one with it off has nothing to lose on the other two.
    if (enrolling === twoFactorOn) return;

    const primary = await primarySignInOf(adapters, userId);
    if (enrolling) {
      if (!primary.hasPassword && primary.passkeyIds.length === 0) {
        refusal = TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR;
      }
    } else if (path === "/unlink-account") {
      if (primary.passkeyIds.length === 0) {
        refusal = TWO_FACTOR_KEEPS_PASSWORD_ERROR;
      }
    } else if (
      !primary.hasPassword &&
      typeof body.id === "string" &&
      primary.passkeyIds.includes(body.id) &&
      primary.passkeyIds.length === 1
    ) {
      refusal = TWO_FACTOR_KEEPS_PASSKEY_ERROR;
    }
  } catch (err) {
    reportSafely(opts.reportError, err, "two_factor_prerequisite_lookup", {
      authUserId: userId,
      path,
    });
    throw lookupFailed();
  }
  if (refusal) throw new APIError("BAD_REQUEST", { ...refusal });
}

/** The bearer plugin's own "Bearer token to session cookie" before-hook. */
const bearerToCookie = bearer().hooks.before[0]!;

/**
 * The user the endpoint is about to run as, read from inside a before-hook.
 *
 * A before-hook never sees what another before-hook changed: Better Auth
 * hands every one of them the ORIGINAL request context and applies their
 * header changes only when it calls the endpoint (1.6.9
 * `api/to-auth-endpoints.mjs` `runBeforeHooks`). So a session presented as
 * `Authorization: Bearer` (the scanner and mobile apps) is not a cookie yet
 * here, whatever the plugin order, and a plain `getSessionFromCtx(ctx)` would
 * answer "no session". This runs the bearer plugin's own conversion first.
 *
 * Reads without refreshing the session and on a copy of the context, so the
 * endpoint's own session read (and its cookie refresh) is unchanged.
 */
export const sessionUserIdOf = async (
  ctx: unknown,
): Promise<string | null> => {
  const c = ctx as Parameters<typeof getSessionFromCtx>[0];
  let headers = c.headers;
  if (bearerToCookie.matcher(c)) {
    const converted = (await bearerToCookie.handler(c as never)) as {
      context?: { headers?: unknown };
    } | void;
    if (converted?.context?.headers instanceof Headers) {
      headers = converted.context.headers;
    }
  }
  const session = await getSessionFromCtx(
    { ...c, headers, context: { ...c.context } },
    { disableRefresh: true },
  );
  return session?.user?.id ?? null;
};

/**
 * `refuseTwoFactorWithoutPrimarySignIn` as a before-hook on its five routes.
 * A plugin rather than a branch in the app's `hooks.before` so it carries its
 * own matcher and is testable in a stand-in `betterAuth()`.
 */
export const twoFactorPrerequisites = (
  opts: { reportError?: ReporterPort } = {},
) =>
  ({
    id: "two-factor-prerequisites",
    options: opts,
    hooks: {
      before: [
        {
          matcher: (context) =>
            typeof context.path === "string" &&
            PREREQUISITE_ROUTES.has(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            await refuseTwoFactorWithoutPrimarySignIn(ctx, opts);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
