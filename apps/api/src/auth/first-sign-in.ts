/**
 * The account's first sign-in, stored once (owner ruling 2026-10-07, "Store
 * first sign-in"): "A new account is new the moment it gets created", i.e.
 * when the person first signs in, not when a guest checkout made a shadow
 * `auth_user` row.
 *
 * Every sign-in method mints a session, so `session.create.after` in
 * `better-auth.ts` calls this on each one. The write only lands while
 * `first_signed_in_at` is still NULL, so it fills once and is a no-op after
 * that; deleting sessions later can no longer make the account look new.
 * Never cleared, with one exception: the unproven-account sweep
 * (`sweepUnprovenAccountInDb`) clears it along with the squatter's sessions,
 * so the inbox prover's sign-in becomes the account's first.
 *
 * Extracted from `better-auth.ts` (same reason as `ban-gate.ts`): importing
 * the auth instance boots env, Prisma and Redis.
 */

import type { LoggerPort } from "@th/ports";
import type { ReporterPort } from "@th/ports/reporter";

export type FirstSignInStampDeps = {
  /**
   * Set `first_signed_in_at = at` on the AuthUser only where it is still
   * NULL. Must be idempotent.
   */
  stampIfUnset(authUserId: string, at: Date): Promise<void>;
  // Wired to HumansRepo.stampFirstSignInIfUnset.
  logger: LoggerPort;
  reportError?: ReporterPort;
  now(): Date;
};

/**
 * The session row's `createdAt` when Better Auth hands over a valid Date,
 * otherwise the clock.
 */
export function firstSignInInstant(
  sessionCreatedAt: unknown,
  now: () => Date,
): Date {
  if (
    sessionCreatedAt instanceof Date &&
    !Number.isNaN(sessionCreatedAt.getTime())
  ) {
    return sessionCreatedAt;
  }
  return now();
}

/**
 * Stamp the account's first sign-in. NEVER throws: the stamp dates the
 * account for invite limits, it is not a gate, so a failed write is logged
 * at ERROR and reported and the sign-in carries on.
 */
export async function stampFirstSignInFromHook(
  deps: FirstSignInStampDeps,
  input: { authUserId: string; sessionCreatedAt?: unknown },
): Promise<"stamped" | "failed"> {
  try {
    await deps.stampIfUnset(
      input.authUserId,
      firstSignInInstant(input.sessionCreatedAt, deps.now),
    );
    return "stamped";
  } catch (err) {
    try {
      deps.logger.error("auth.first_sign_in.stamp_failed", {
        authUserId: input.authUserId,
        err,
      });
    } catch {
      // A throwing logger never changes behaviour either.
    }
    try {
      deps.reportError?.(err, {
        tags: { area: "auth", op: "first_sign_in_stamp" },
        extra: { authUserId: input.authUserId },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return "failed";
  }
}
