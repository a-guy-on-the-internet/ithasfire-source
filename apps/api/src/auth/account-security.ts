/**
 * Account-security decisions for the Better Auth hooks in `better-auth.ts`.
 *
 * Extracted so the rules can be unit-tested without booting the auth stack
 * (importing `better-auth.ts` pulls in env, Prisma and Redis). The hooks in
 * `better-auth.ts` are thin wiring: they build the deps below from Prisma and
 * call these functions. Findings referenced are from the 2026-09-29 security
 * review (F5: bans don't hold; F6: pre-registering someone's email).
 */

import type { LoggerPort } from "@th/ports";
import type { ReporterPort } from "@th/ports/reporter";

export type AuthHumanStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "BANNED";

/** Invoke a reporter so that a throwing reporter can never change behaviour. */
function reportSafely(
  reportError: ReporterPort | undefined,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    reportError?.(err, context);
  } catch {
    // Best-effort by contract (see `@th/ports/reporter`).
  }
}

// ── F5: no new session for a suspended/banned human ────────────────────────

export interface SessionGateDeps {
  reportError?: ReporterPort;
  /**
   * `Human.status` for the AuthUser's linked Human, or null when the AuthUser
   * is not linked yet (a brand-new sign-up: Better Auth defers the
   * `user.create.after` provisioning hook until the request finishes, so the
   * first session is created before the Human exists).
   */
  loadHumanStatus(authUserId: string): Promise<AuthHumanStatus | null>;
  /**
   * Is this AuthUser's email the mailbox of a BANNED human (compared as mail
   * is delivered)? Ban-that-sticks review round 1: accounts created OUTSIDE
   * Better Auth's sign-up hooks — guest-checkout and RSVP shadow users from
   * `ensureGuestHuman`, and alt accounts that existed before the ban — never
   * pass `user.create.before`, so every session is checked here instead.
   * Omitted = no mailbox check. Throws on lookup failure (fail closed),
   * UNREPORTED: `isSessionAllowed` reports it once (op
   * `session_gate_mailbox_lookup`, with the authUserId).
   */
  isEmailBanned?(authUserId: string): Promise<boolean>;
}

/**
 * May Better Auth open a session for this AuthUser?
 *
 * Only an ACTIVE human (or a not-yet-linked AuthUser) may, and only when the
 * AuthUser's email is not a banned human's mailbox. Lookup failures
 * propagate: a sign-in that cannot confirm the human is allowed in fails
 * rather than letting a ban through.
 */
export async function isSessionAllowed(
  deps: SessionGateDeps,
  authUserId: string,
): Promise<boolean> {
  let status: AuthHumanStatus | null;
  let mailboxBanned = false;
  let op = "session_gate_status_lookup";
  try {
    status = await deps.loadHumanStatus(authUserId);
    if (status === null || status === "ACTIVE") {
      op = "session_gate_mailbox_lookup";
      mailboxBanned = (await deps.isEmailBanned?.(authUserId)) ?? false;
    }
  } catch (err) {
    // Rethrown (fail closed), but reported first: Better Auth turns a
    // non-APIError hook throw into a bare 500, so without this a DB blip
    // here would show up only as "sign-in is broken". The ONLY report for
    // either lookup: the mailbox check is wired not to report its own
    // failures (`callerReportsLookupFailure`).
    reportSafely(deps.reportError, err, {
      tags: { area: "auth", op },
      extra: { authUserId },
    });
    throw err;
  }
  if (mailboxBanned) return false;
  return status === null || status === "ACTIVE";
}

/**
 * Where to send a browser whose new session was refused (ACCOUNT_NOT_ACTIVE)
 * on a NAVIGATION endpoint, or null to answer with the JSON 403.
 *
 *  - Magic-link verify: redirect only when the caller sent a `callbackURL`
 *    (no callbackURL = a JSON caller; the plugin itself answers those with
 *    JSON). Target = `errorCallbackURL`, else `callbackURL`, resolved against
 *    Better Auth's baseURL exactly as the plugin does (better-auth 1.6.9
 *    `plugins/magic-link/index.mjs`: `new URL(decodeURIComponent(x),
 *    ctx.context.baseURL)`), so relative URLs work. Both were already
 *    origin-checked by the plugin's `originCheck` middleware.
 *  - OAuth callback: web `/sign-in` (its errorURL lives in the OAuth state).
 *    With `oAuthProxy` across two origins, as in production, the session is
 *    minted on `/oauth-proxy-callback`, which is a navigation too.
 *
 * It must be THROWN from the handler (the session hook), not an after-hook:
 * an after-hook's replacement response keeps the original status.
 */
export function accountNotActiveRedirect(input: {
  path: string | undefined;
  query: Record<string, unknown> | undefined;
  authBaseURL: string;
  webBaseURL: string;
}): string | null {
  const { path, query } = input;
  let target: URL;
  try {
    if (path === "/magic-link/verify") {
      const callbackURL = query?.callbackURL;
      if (typeof callbackURL !== "string" || !callbackURL) return null;
      const errorCallbackURL = query?.errorCallbackURL;
      const raw =
        typeof errorCallbackURL === "string" && errorCallbackURL
          ? errorCallbackURL
          : callbackURL;
      target = new URL(decodeURIComponent(raw), input.authBaseURL);
    } else if (
      path === "/callback/:id" ||
      path === "/oauth-proxy-callback" ||
      path === "/oauth2/callback/:providerId"
    ) {
      target = new URL("/sign-in", input.webBaseURL);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  target.searchParams.set("error", "account_not_active");
  return target.toString();
}

// ── F6: proving the inbox evicts credentials set before it was proven ──────

/**
 * What a credential sweep removed. Everything here could have been attached
 * by whoever registered the address WITHOUT proving they own it.
 */
export interface UnprovenCredentialCounts {
  credentialAccounts: number;
  sessions: number;
  passkeys: number;
  twoFactor: number;
  apiKeys: number;
  /** Key requests closed for account security (scoped API keys R31). */
  apiKeyRequestsClosed: number;
  /**
   * 1 when a phone number was cleared. The phone-number plugin lets a
   * signed-in squatter attach their own phone, and `/phone-number/verify`
   * then opens a session for whichever user owns that number (better-auth
   * 1.6.9 `plugins/phone-number/routes.mjs`), so it is a sign-in method.
   */
  phoneNumbers: number;
  /** HumanDelegate rows where this human is the PRINCIPAL (grants it made). */
  delegateGrants: number;
  /** PENDING org invitations this human sent, now REVOKED. */
  pendingInvitesRevoked: number;
  /**
   * The Human's registered push devices, removed with the sessions (B2):
   * a device registered while signed in keeps receiving the account's
   * pushes (ticket and order notices, the address reveal) after its
   * sessions end, so it goes with them.
   */
  pushDevices: number;
}

/**
 * Org grants the squatter may have made that cannot be undone safely from
 * here — OrgMember does not record who granted it — so they are REPORTED for
 * a human to review, not removed.
 */
export interface UnprovenGrantsToReview {
  /** Orgs where this human is OWNER/ADMIN (e.g. an org the squatter created). */
  privilegedMemberships: { orgId: string; role: string }[];
  /** OWNER/ADMIN invitations this human sent that someone accepted. */
  acceptedPrivilegedInvites: {
    orgId: string;
    role: string;
    acceptedByHumanId: string | null;
  }[];
}

export interface UnprovenSweepResult {
  counts: UnprovenCredentialCounts;
  grantsToReview: UnprovenGrantsToReview;
}

function hasGrantsToReview(g: UnprovenGrantsToReview): boolean {
  return (
    g.privilegedMemberships.length > 0 || g.acceptedPrivilegedInvites.length > 0
  );
}

function reportGrantsToReview(
  deps: { logger: LoggerPort; reportError?: ReporterPort },
  authUserId: string,
  trigger: string,
  grants: UnprovenGrantsToReview,
): void {
  if (!hasGrantsToReview(grants)) return;
  deps.logger.warn("auth_unproven_account_has_org_grants", {
    authUserId,
    trigger,
    ...grants,
  });
  // Not a failure — a review signal. Sent through reportError because
  // `logger.warn` is not captured by Sentry (CLAUDE.md).
  reportSafely(
    deps.reportError,
    new Error("auth_unproven_account_has_org_grants"),
    {
      tags: { area: "auth", op: "unproven_account_grants", trigger },
      extra: { authUserId, ...grants },
    },
  );
}

export interface UnprovenCredentialDeps {
  logger: LoggerPort;
  reportError?: ReporterPort;
  /** Current AuthUser row, read OUTSIDE any Better Auth transaction. */
  loadAuthUser(
    authUserId: string,
  ): Promise<{ id: string; emailVerified: boolean } | null>;
  /**
   * Atomically remove the user's password credential, sessions, passkeys,
   * TOTP enrolment and phone number; revoke their Human's API keys, delegate
   * grants and pending org invitations; and collect org grants to review.
   */
  revokeAll(
    authUserId: string,
    trigger: EmailProofTrigger,
  ): Promise<UnprovenSweepResult>;
}

/**
 * How the inbox was just proven. `oauth_link` = a Google/Apple (or any
 * non-password) account is being linked onto an existing user;
 * `email_otp_sign_in` and `magic_link_sign_in` are the email-proof sign-ins
 * that flip `emailVerified` on an existing user; `email_otp_verify_email` is
 * the emailOTP plugin's `/email-otp/verify-email`, which flips it with no
 * session required (see {@link isOwnInboxVerification}).
 */
export type EmailProofTrigger =
  | "oauth_link"
  | "email_otp_sign_in"
  | "magic_link_sign_in"
  | "email_otp_verify_email";

export type UnprovenCredentialOutcome =
  | { outcome: "skipped_unknown_user" }
  | { outcome: "skipped_already_verified" }
  | {
      outcome: "revoked";
      counts: UnprovenCredentialCounts;
      grantsToReview: UnprovenGrantsToReview;
    };

/**
 * Sign-up does not require verification, so anyone can register
 * `victim@gmail.com` with a password, sign in, and mint an API key. When the
 * real owner later proves the inbox (Continue with Google, an email code, a
 * magic link), Better Auth hands them that SAME user and marks it verified —
 * leaving the squatter's password, sessions and keys in place.
 *
 * Call this from a hook that runs AFTER the proof is validated and BEFORE the
 * new session is created. If the user is still unverified, everything that
 * could have been attached without proof is removed; the prover then gets the
 * fresh session Better Auth creates next.
 *
 * The cost to a legitimate owner who signed up with a password and never
 * verified: their password is removed (reset it to get one back) and their
 * other devices are signed out. That is the price of not being able to tell
 * them apart from a squatter.
 *
 * Fails CLOSED: a sweep failure is reported and rethrown, which aborts the
 * link/sign-in. Callers run it before the state change they guard, so a retry
 * re-runs the check.
 */
export async function revokeUnprovenCredentials(
  deps: UnprovenCredentialDeps,
  input: { authUserId: string; trigger: EmailProofTrigger },
): Promise<UnprovenCredentialOutcome> {
  const { authUserId, trigger } = input;

  try {
    // Not found = the user is being created in this same request (Better
    // Auth's `createOAuthUser` inserts user + account in one uncommitted
    // transaction). A brand-new user has nothing to evict.
    const user = await deps.loadAuthUser(authUserId);
    if (!user) return { outcome: "skipped_unknown_user" };
    if (user.emailVerified) return { outcome: "skipped_already_verified" };

    const { counts, grantsToReview } = await deps.revokeAll(
      authUserId,
      trigger,
    );
    deps.logger.info("auth_unproven_credentials_revoked", {
      authUserId,
      trigger,
      ...counts,
    });
    reportGrantsToReview(deps, authUserId, trigger, grantsToReview);
    return { outcome: "revoked", counts, grantsToReview };
  } catch (err) {
    deps.logger.error("auth_unproven_credentials_revoke_failed", {
      authUserId,
      trigger,
      err,
    });
    reportSafely(deps.reportError, err, {
      tags: { area: "auth", op: "revoke_unproven_credentials", trigger },
      extra: { authUserId },
    });
    throw err;
  }
}

/** Only non-password providers prove the inbox; `credential` is the password. */
export function isInboxProvingProvider(providerId: string): boolean {
  return providerId !== "credential";
}

/**
 * Better Auth endpoints whose ONLY `updateUser` call on an existing user is
 * the `{ emailVerified: true }` flip, made after the code/link was validated
 * and before any session is created (better-auth 1.6.9:
 * `plugins/email-otp/routes.mjs` sign-in and verify-email,
 * `plugins/magic-link/index.mjs` verify).
 *
 * `/email-otp/verify-email` (B2) takes `{ email, otp }` and NO session, so
 * whoever reads the inbox can verify an account someone else opened under
 * that address, leaving that person's password and sessions on a now-verified
 * account. It sweeps like the sign-ins, except when the request is signed in
 * as the account being verified: then the prover holds the account
 * (`isOwnInboxVerification`), and sweeping would delete a legitimate new
 * user's password the moment they verify after sign-up.
 */
export const EMAIL_PROOF_SIGN_IN_TRIGGERS: Readonly<
  Record<string, EmailProofTrigger>
> = {
  "/sign-in/email-otp": "email_otp_sign_in",
  "/magic-link/verify": "magic_link_sign_in",
  "/email-otp/verify-email": "email_otp_verify_email",
};

/**
 * True when an `/email-otp/verify-email` proof comes from a request signed in
 * as the very account being verified: the person holding the account just
 * proved its inbox, so there is nothing to evict and the sweep is skipped.
 *
 * Why that is safe: every session on an unverified account was opened with
 * its password (or after a sweep), so a session holder who also reads the
 * inbox is the account's owner, not a squatter. No session, or a session for
 * another account, means the prover is someone else: the sweep runs.
 *
 * `sessionUserId` is asked only for verify-email. A failed session read does
 * NOT abort the verify: better-auth's `getSessionFromCtx` (and the bearer
 * conversion inside `sessionUserIdOf`) catch the error and answer "no
 * session", so it counts as someone else proving the inbox and the sweep
 * runs (the safe side; the cost is a legitimate holder's password). Pinned by
 * `test/email-otp-verify-email-sweep.test.ts`.
 */
export async function isOwnInboxVerification(
  trigger: EmailProofTrigger,
  authUserId: string,
  sessionUserId: () => Promise<string | null>,
): Promise<boolean> {
  if (trigger !== "email_otp_verify_email") return false;
  return (await sessionUserId()) === authUserId;
}

/**
 * The trigger for a `user.update.before` hook call, or null when this update
 * is not an email-proof sign-in flipping `emailVerified`.
 */
export function resolveEmailProofTrigger(
  path: string | undefined,
  data: Record<string, unknown> | undefined,
): EmailProofTrigger | null {
  if (!path || data?.emailVerified !== true) return null;
  return EMAIL_PROOF_SIGN_IN_TRIGGERS[path] ?? null;
}

// ── Endpoints refused outright ─────────────────────────────────────────────

/**
 * Better Auth endpoints `hooks.before` refuses. The first two change an
 * account's email WITHOUT proving the new address:
 *
 *  - `/change-email` (core): for an unverified account with
 *    `updateEmailWithoutVerification`, rewrites the address on the spot
 *    (better-auth 1.6.9 `api/routes/update-user.mjs:426-442`). Password-reset
 *    tokens are bound to the user id, not the address
 *    (`api/routes/password.mjs`), so a squatter could point the account at
 *    their own inbox, request a reset, point it back, and complete the reset
 *    on the victim's address (2026-09-29 review round 3).
 *  - `/email-otp/request-email-change`: replaced by our own
 *    `POST /api/account/email-change/request`, which mails the code to the
 *    NEW address; `/email-otp/change-email` then verifies it.
 *
 * And `/verify-email` (core, JWT link) flips `emailVerified` without the
 * unproven-account sweep. Nothing mints its tokens today (no
 * `sendVerificationEmail`; codes go through emailOTP) and no client calls it,
 * so it is refused outright rather than left reachable (B2, defence in depth).
 */
export const REFUSED_AUTH_ENDPOINTS: Readonly<
  Record<string, { code: string; message: string }>
> = {
  "/change-email": {
    code: "USE_ACCOUNT_EMAIL_CHANGE_REQUEST",
    message: "Use the account email change request endpoint.",
  },
  "/email-otp/request-email-change": {
    code: "USE_ACCOUNT_EMAIL_CHANGE_REQUEST",
    message: "Use the account email change request endpoint.",
  },
  // Verifies with no sweep; unused: email is verified by code (emailOTP).
  "/verify-email": {
    code: "USE_EMAIL_CODE_VERIFICATION",
    message: "Verify your email with the emailed code.",
  },
};

export function refusedAuthEndpoint(
  path: string | undefined,
): { code: string; message: string } | null {
  return path ? (REFUSED_AUTH_ENDPOINTS[path] ?? null) : null;
}

// ── Audit rows for the sweeps ──────────────────────────────────────────────

export const UNPROVEN_ACCOUNT_SWEPT_ACTION = "auth.unproven_account_swept";

/** Did the sweep remove anything at all? */
export function sweptAnything(counts: UnprovenCredentialCounts): boolean {
  return Object.values(counts).some((n) => n > 0);
}

// ── F5/F6: a password reset ends API keys, and on an unproven account ────
//          every other sign-in method the squatter could have attached

/**
 * How the reset path calls the shared DB sweep.
 *
 * `markEmailVerified` is FALSE on purpose (2026-09-29 review round 3). A
 * reset link proves control of whatever inbox the account pointed at when the
 * link was REQUESTED, not of the address it holds when the link is used —
 * the token is bound to the user id. Marking the address verified here let a
 * squatter launder it (change email to theirs → request reset → change back
 * → reset → victim@ "verified"), after which the Google-link sweep skipped the
 * account as already verified. Cost: an owner who recovered an unverified
 * account by link and later signs in by email code loses the password they
 * just set (that sign-in sweeps it) and resets again.
 */
export const RESET_SWEEP_OPTIONS = {
  keepCredentialAndSessions: true,
  markEmailVerified: false,
} as const;

/**
 * The AuthUser update the unproven-account sweep (`sweepUnprovenAccountInDb`
 * in `better-auth.ts`) writes. The phone is a sign-in method
 * (`/phone-number/verify` opens a session for whoever owns the number), so it
 * goes with the rest.
 *
 * `firstSignedInAt` is cleared only when the sweep also deletes the sessions
 * (`keepCredentialAndSessions` false: email-code / magic-link / Google / Apple
 * proof). The orchestrator's reading of the owner ruling "A new account is new
 * the moment it gets created" (2026-10-07): the squatter's sign-ins are gone,
 * so the inbox prover's sign-in, whose session is created right after, is the
 * account's first and re-stamps it. Side effect: an unverified password user
 * who later proves their own inbox via Google reads as a new account for a
 * week. The reset path (keep = true) leaves the stamp alone.
 */
export function sweepAuthUserPatch(opts: {
  keepCredentialAndSessions: boolean;
  markEmailVerified: boolean;
}): {
  phoneNumber: null;
  phoneNumberVerified: false;
  twoFactorEnabled: false;
  firstSignedInAt?: null;
  emailVerified?: true;
} {
  return {
    phoneNumber: null,
    phoneNumberVerified: false,
    twoFactorEnabled: false,
    ...(opts.keepCredentialAndSessions ? {} : { firstSignedInAt: null }),
    ...(opts.markEmailVerified ? { emailVerified: true } : {}),
  };
}

/** Which factor the password reset proved. */
export type PasswordResetProof = "email" | "phone" | "unknown";

/**
 * Classify the reset route from the request URL Better Auth passes to
 * `onPasswordReset` (1.6.9 calls it from `/reset-password`,
 * `/email-otp/reset-password` and `/phone-number/reset-password`).
 */
export function passwordResetProofFromUrl(
  url: string | undefined,
): PasswordResetProof {
  if (!url) return "unknown";
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "unknown";
  }
  if (path.endsWith("/phone-number/reset-password")) return "phone";
  if (
    path.endsWith("/email-otp/reset-password") ||
    path.endsWith("/reset-password")
  ) {
    return "email";
  }
  return "unknown";
}

export interface PasswordResetDeps {
  logger: LoggerPort;
  reportError?: ReporterPort;
  /** Revoke every API key of the AuthUser's Human; returns the count. */
  revokeApiKeysForAuthUser(authUserId: string): Promise<number>;
  /**
   * The unproven-account sweep MINUS the password credential (it now holds
   * the NEW password) and sessions (Better Auth's
   * `revokeSessionsOnPasswordReset` deletes those next). Must NOT mark the
   * email verified — see {@link RESET_SWEEP_OPTIONS}.
   */
  sweepUnprovenAccountAfterReset(
    authUserId: string,
  ): Promise<UnprovenSweepResult>;
}

export type PasswordResetOutcome =
  | { mode: "api_keys_only"; revoked: number }
  | { mode: "unproven_sweep"; counts: UnprovenCredentialCounts }
  | { mode: "failed"; error: unknown };

/**
 * `emailAndPassword.onPasswordReset` body. Better Auth calls it BEFORE its
 * own `revokeSessionsOnPasswordReset` step, so this must not throw: a throw
 * here would skip the session revocation too. Failure is therefore swallowed
 * — deliberately, and reported, per the CLAUDE.md error-reporting convention.
 *
 * On an account whose email was never verified, an EMAIL-proven reset is the
 * inbox owner recovering it ("forgot password" is the likeliest route a
 * squatting victim takes), so everything the squatter could have attached —
 * passkeys, TOTP, phone, API keys, delegate grants, pending invites — goes.
 * A PHONE-proven reset only proves the phone, which on such an account is the
 * squatter's own; it gets the API-key revocation only.
 */
export async function secureAccountAfterPasswordReset(
  deps: PasswordResetDeps,
  input: {
    authUserId: string;
    emailVerified: boolean | undefined;
    proof: PasswordResetProof;
  },
): Promise<PasswordResetOutcome> {
  const { authUserId, emailVerified, proof } = input;
  try {
    if (emailVerified === false && proof === "email") {
      const { counts, grantsToReview } =
        await deps.sweepUnprovenAccountAfterReset(authUserId);
      deps.logger.info("auth_password_reset_unproven_account_swept", {
        authUserId,
        ...counts,
      });
      reportGrantsToReview(deps, authUserId, "password_reset", grantsToReview);
      return { mode: "unproven_sweep", counts };
    }
    const revoked = await deps.revokeApiKeysForAuthUser(authUserId);
    deps.logger.info("auth_password_reset_api_keys_revoked", {
      authUserId,
      revoked,
    });
    return { mode: "api_keys_only", revoked };
  } catch (error) {
    deps.logger.error("auth_password_reset_secure_failed", {
      authUserId,
      proof,
      err: error,
    });
    reportSafely(deps.reportError, error, {
      tags: { area: "auth", op: "password_reset_secure_account", proof },
      extra: { authUserId },
    });
    return { mode: "failed", error };
  }
}
