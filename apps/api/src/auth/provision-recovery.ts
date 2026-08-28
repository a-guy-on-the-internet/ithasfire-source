/**
 * Provisioning rollback + self-heal handlers.
 *
 * When Better Auth creates an AuthUser (email/password OR OAuth signup), it
 * commits the `auth_user` row and THEN runs `databaseHooks.user.create.after`,
 * which provisions the domain `Human` + `EntityPage` and links
 * `AuthUser.humanId` via `provisionHumanForAuthUser`.
 *
 * Two failure modes are handled here:
 *
 *  1. ROLLBACK (handleProvisioningRollback) — if provisioning throws in the
 *     after-hook, the `auth_user` row is already persisted (the hook runs
 *     post-commit, see note below). Left alone, that row has `human_id = NULL`:
 *     the email is "taken but unusable". We compensate by DELETING the
 *     just-created auth_user (guarded to `humanId = null`) so the email frees
 *     up, then re-throw so the signup aborts with a clean client error.
 *
 *  2. SELF-HEAL (handleProvisioningSelfHeal) — any AuthUser that still has a
 *     null `humanId` when its session is resolved gets provisioning re-run
 *     (idempotent). This repairs pre-existing orphans and any edge case the
 *     rollback missed. It must NEVER throw — a failed self-heal still returns
 *     a usable session (with humanId still null).
 *
 * Better Auth 1.6.9 after-hook semantics (verified against
 * node_modules/better-auth/dist/db/with-hooks.mjs +
 * @better-auth/core/dist/context/transaction.mjs):
 *   - `create.after` hooks are wrapped in `queueAfterTransactionHook`, so they
 *     run AFTER the surrounding transaction commits.
 *   - Queued hooks are drained via `for (const hook of pendingHooks) await
 *     hook();` with NO try/catch around the loop. A thrown error therefore
 *     propagates out of `runWithAdapter` / `runWithTransaction` to the signup
 *     endpoint and aborts it with an error HTTP response.
 *   => The compensating delete must happen regardless (the row is already
 *      committed); the re-throw is what surfaces the clean client error.
 *
 * This module is extracted from the main Better Auth config (mirroring
 * `shadow-upgrade.ts`) so the logic can be unit-tested without the full
 * Better Auth or Prisma setup.
 */

import type { LoggerPort } from "@th/ports";

import type { fireDiscordAlert } from "../lib/dep";

// ── Shared transient-error classification ──────────────────────────────────

/**
 * Classify a DB error as transient (retryable) for the dependency guard.
 *
 * Single source of truth shared by BOTH provisioning paths — the signup
 * after-hook (rollback) and the `customSession` self-heal — so they treat
 * deadlocks / serialization failures / connection timeouts identically. The
 * advisory lock in `provisionHumanForAuthUser` serializes concurrent
 * provisions, but these classes can still surface under pool contention, so
 * both call sites must guard them the same way.
 */
export function classifyTransientProvisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /deadlock|serialization failure|ETIMEDOUT/i.test(message);
}

/**
 * Dependency-guard config for the provisioning repos. Applied to `humans`
 * (the repo the provisioning use case actually mutates — create / link /
 * advisory lock) so transient DB failures are surfaced as retryable on BOTH
 * provisioning entry points. Shared so the regex lives in exactly one place.
 */
export function provisionGuardConfig() {
  return {
    humans: { classifyTransient: classifyTransientProvisionError },
  };
}

// ── Shared dependency surface ──────────────────────────────────────────────

/** Run the (idempotent) human-provisioning use case for an auth user. */
export type ProvisionFn = (input: {
  authUserId: string;
  email: string;
  name?: string;
  image?: string;
  locale?: string;
}) => Promise<{ humanId: string }>;

/** Discord alert sender, matching the existing `fireDiscordAlert` shape. */
export type AlertFn = typeof fireDiscordAlert;

/**
 * Prisma `where` filter for the compensating delete of an UNPROVISIONED
 * auth_user. Scoped to `humanId: null` so a row that got linked in a race (or
 * by a concurrent self-heal) is NEVER destroyed — only a genuinely orphaned
 * signup row is removed. Extracted so the guard is unit-testable in isolation
 * from the Prisma client.
 */
export function deleteUnprovisionedAuthUserWhere(authUserId: string): {
  id: string;
  humanId: null;
} {
  return { id: authUserId, humanId: null };
}

// ── FIX 1: rollback on provisioning failure ────────────────────────────────

export interface ProvisioningRollbackDeps {
  logger: LoggerPort;

  /** Run human provisioning (idempotent). Throws on failure. */
  provision: ProvisionFn;

  /**
   * Compensating delete of an UNPROVISIONED auth_user. Implementations MUST
   * guard on `humanId = null` so a row that got linked in a race is never
   * nuked. Returns the number of rows actually deleted.
   */
  deleteUnprovisionedAuthUser(authUserId: string): Promise<number>;

  /** Best-effort Discord alert. */
  alert?: AlertFn | null;

  /** Mask an email for structured logs. */
  maskEmail(email: string): string | null;
}

export interface ProvisioningRollbackInput {
  authUserId: string;
  email: string;
  name?: string;
  image?: string;
  locale?: string;
}

/**
 * Provision the human for a freshly-created AuthUser. On failure, perform a
 * compensating delete of the unprovisioned auth_user and re-throw so the
 * signup aborts cleanly and the email frees up.
 *
 * Returns the provisioning result on success (useful for testing / callers).
 */
export async function handleProvisioningWithRollback(
  deps: ProvisioningRollbackDeps,
  input: ProvisioningRollbackInput,
): Promise<{ humanId: string }> {
  const { logger } = deps;

  try {
    return await deps.provision({
      authUserId: input.authUserId,
      email: input.email,
      name: input.name,
      image: input.image,
      locale: input.locale,
    });
  } catch (error) {
    const maskedEmail = deps.maskEmail(input.email);

    // Compensating delete — only removes a genuinely unprovisioned row
    // (humanId = null) so a user linked in a race is never destroyed.
    let deletedCount = 0;
    try {
      deletedCount = await deps.deleteUnprovisionedAuthUser(input.authUserId);
    } catch (deleteError) {
      // The delete itself failing is the worst case: the orphan persists.
      // Log loudly; the self-heal path is the safety net.
      logger.error("auth_user_provision_rollback_delete_failed", {
        authUserId: input.authUserId,
        maskedEmail,
        provisionError: error,
        deleteError,
      });
    }

    await logAndAlertRollback(deps, {
      authUserId: input.authUserId,
      maskedEmail,
      deletedCount,
      error,
    });

    // Re-throw so the signup endpoint returns an error response and the
    // client doesn't believe the account was created. The after-hook throw
    // propagates (see module header note on better-auth 1.6.9 semantics).
    throw error;
  }
}

async function logAndAlertRollback(
  deps: ProvisioningRollbackDeps,
  params: {
    authUserId: string;
    maskedEmail: string | null;
    deletedCount: number;
    error: unknown;
  },
): Promise<void> {
  // Mirror the `auth_reset_password_send_failed` alert pattern.
  const { logger } = deps;
  logger.error("auth_user_provision_rolled_back", {
    authUserId: params.authUserId,
    maskedEmail: params.maskedEmail,
    deletedCount: params.deletedCount,
    error: params.error,
  });

  if (!deps.alert) return;
  try {
    await deps.alert({
      title: "Signup rolled back — provisioning failed",
      colour: "error",
      description:
        "Human provisioning failed in the user.create after-hook. The " +
        "unprovisioned auth_user was deleted so the email frees up, and the " +
        "signup was aborted. Check structured logs for the underlying error.",
      fields: [
        {
          name: "Email",
          value: params.maskedEmail ?? "(unavailable)",
          inline: true,
        },
        { name: "Auth ID", value: params.authUserId, inline: true },
        {
          name: "Rows deleted",
          value: String(params.deletedCount),
          inline: true,
        },
      ],
    });
  } catch {
    // Never fail the rollback because Discord is unavailable.
  }
}

// ── FIX 2: self-heal a null humanId during session resolution ──────────────

export interface ProvisioningSelfHealDeps {
  logger: LoggerPort;

  /** Run human provisioning (idempotent). Throws on failure. */
  provision: ProvisionFn;
}

export interface ProvisioningSelfHealUser {
  id: string;
  email?: string | null;
  name?: string | null;
  humanId?: string | null;
}

/**
 * Resolve the effective humanId for a session user, self-healing a null
 * humanId by (idempotently) re-running provisioning. NEVER throws — on any
 * failure it logs and returns the original (possibly null) humanId so the
 * session is still usable.
 */
export async function resolveHumanIdWithSelfHeal(
  deps: ProvisioningSelfHealDeps,
  user: ProvisioningSelfHealUser,
): Promise<string | null> {
  // Cheap fast-path: only do work while humanId is missing.
  if (user.humanId) {
    return user.humanId;
  }

  if (!user.email) {
    // Cannot provision without an email; nothing we can do here.
    return null;
  }

  try {
    const result = await deps.provision({
      authUserId: user.id,
      email: user.email,
      name: user.name ?? undefined,
    });
    deps.logger.info("auth_user_self_heal_succeeded", {
      authUserId: user.id,
      humanId: result.humanId,
    });
    return result.humanId;
  } catch (error) {
    deps.logger.warn("auth_user_self_heal_failed", {
      authUserId: user.id,
      error,
    });
    return null;
  }
}
