import {
  sweepAuthUserPatch,
  type EmailProofTrigger,
  type UnprovenCredentialDeps,
} from "../../src/auth/account-security";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

/**
 * Deps for the production `revokeUnprovenCredentials`, against the rows of a
 * Better Auth memory adapter.
 *
 * Production's `revokeAll` is `sweepUnprovenAccountInDb` in
 * `apps/api/src/auth/better-auth.ts` (Prisma). This does the same writes for
 * the options every inbox-proof trigger passes
 * (`keepCredentialAndSessions: false`, `markEmailVerified: false`): the
 * password, sessions, passkeys and TOTP enrolment go, and the user row takes
 * the production patch (`sweepAuthUserPatch`, which turns two-factor off).
 */
export const memorySweepDeps = (
  db: () => MemoryDb,
): UnprovenCredentialDeps => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
  loadAuthUser: async (id) => {
    const row = db().user!.find((u) => u.id === id);
    return row ? { id, emailVerified: Boolean(row.emailVerified) } : null;
  },
  revokeAll: async (id) => {
    const drop = (table: string, keep: (r: Row) => boolean) => {
      const rows = db()[table]!;
      const kept = rows.filter(keep);
      const removed = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return removed;
    };
    const credentialAccounts = drop(
      "account",
      (r) => !(r.userId === id && r.providerId === "credential"),
    );
    const sessions = drop("session", (r) => r.userId !== id);
    const passkeys = drop("passkey", (r) => r.userId !== id);
    const twoFactor = drop("twoFactor", (r) => r.userId !== id);
    Object.assign(
      db().user!.find((u) => u.id === id)!,
      sweepAuthUserPatch({
        keepCredentialAndSessions: false,
        markEmailVerified: false,
      }),
    );
    return {
      counts: {
        credentialAccounts,
        sessions,
        passkeys,
        twoFactor,
        apiKeys: 0,
        phoneNumbers: 0,
        delegateGrants: 0,
        pendingInvitesRevoked: 0,
        apiKeyRequestsClosed: 0,
        pushDevices: 0,
      },
      grantsToReview: {
        privilegedMemberships: [],
        acceptedPrivilegedInvites: [],
      },
    };
  },
});

/**
 * Whose `emailVerified` an email-proof sign-in is about to flip: the same
 * recovery as `resolveEmailProofAuthUserId` in `better-auth.ts` (the email-OTP
 * body's `email`; the magic-link token's verification row), with the memory
 * rows in place of Prisma.
 */
export const memoryEmailProofAuthUserId = async (
  db: () => MemoryDb,
  ctx: unknown,
  trigger: EmailProofTrigger,
): Promise<string | null> => {
  const c = ctx as {
    body?: { email?: unknown };
    query?: { token?: unknown };
    context?: {
      internalAdapter?: {
        findVerificationValue(id: string): Promise<{ value: string } | null>;
      };
    };
  } | null;
  let email: string | null = null;
  if (trigger === "email_otp_sign_in" || trigger === "email_otp_verify_email") {
    email = typeof c?.body?.email === "string" ? c.body.email : null;
  } else if (
    trigger === "magic_link_sign_in" &&
    typeof c?.query?.token === "string" &&
    c.context?.internalAdapter
  ) {
    const verification = await c.context.internalAdapter.findVerificationValue(
      c.query.token,
    );
    if (verification) {
      const parsed = JSON.parse(verification.value) as { email?: unknown };
      email = typeof parsed.email === "string" ? parsed.email : null;
    }
  }
  if (!email) return null;
  const row = db().user!.find((u) => u.email === email!.toLowerCase());
  return typeof row?.id === "string" ? row.id : null;
};
