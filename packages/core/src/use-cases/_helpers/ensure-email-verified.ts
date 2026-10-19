import type { TxRepos } from "@th/ports/repos";

export async function ensureEmailVerified(
  tx: Pick<TxRepos, "humans">,
  actorHumanId: string,
  opts?: {
    /** If provided, can be used by callers to exempt certain action paths (e.g. admin support). */
    isExempt?: boolean;
    /** Error message key to throw when unverified. */
    message?: string;
  },
): Promise<void> {
  if (opts?.isExempt) {
    return;
  }

  const result = await tx.humans.getByIdWithIdentity(actorHumanId);
  if (!result) {
    throw { code: "not_found", message: "actor_not_found" } as const;
  }

  if (!result.identity.emailVerified) {
    throw {
      code: "forbidden",
      message: opts?.message ?? "email_verification_required",
    } as const;
  }
}

/**
 * The boolean form, for reads that answer LESS (not an error) to an account
 * that has not proved its inbox (B2, account squatting through guest
 * checkout, owner ruling 2026-10-16): e.g. a lineup row linked BY EMAIL
 * (`events.inviteLineupHumanToRegister`) unlocks an act's address only once
 * the account is verified. A missing human is unverified. A failed lookup
 * propagates: callers fail closed.
 */
export async function isEmailVerified(
  humans: Pick<TxRepos["humans"], "getByIdWithIdentity">,
  humanId: string,
): Promise<boolean> {
  const result = await humans.getByIdWithIdentity(humanId);
  return result?.identity.emailVerified === true;
}
