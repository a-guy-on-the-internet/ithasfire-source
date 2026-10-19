/**
 * Shadow profile upgrade handler.
 *
 * When a guest checkout (or future volunteer signup, comp ticket claim, etc.)
 * creates a shadow AuthUser via `ensureGuestHuman`, that user has an AuthUser
 * row (email, emailVerified=false) but NO AuthAccount.
 *
 * If they later try to sign up with email/password, Better Auth finds the
 * existing email and fires `onExistingUserSignUp`. We detect shadow users and
 * upgrade them by creating a credential AuthAccount with their chosen
 * password.
 *
 * A shadow user is STRICTLY: `emailVerified = false` AND zero AuthAccount rows
 * of ANY provider AND zero passkeys. Anything else is a real account, and
 * attaching a password the caller just typed to it would be an account
 * takeover: every Google/Apple, passkey-only, email-code or magic-link user
 * is already `emailVerified = true`, so the attacker's password sign-in
 * would succeed immediately (2026-09-29 security review, F7). The old check
 * ("no `credential` account") let exactly those users through.
 *
 * `onExistingUserSignUp` only fires while `requireEmailVerification` is true
 * (better-auth 1.6.9 `api/routes/sign-up.mjs`), so this is dormant today; the
 * guard has to be right BEFORE that flag is flipped.
 *
 * This module is extracted from the main Better Auth config so the core logic
 * can be unit-tested without requiring the full Better Auth or Prisma setup.
 */

import type { LoggerPort } from "@th/ports";
import type { ReporterPort } from "@th/ports/reporter";
import { sanitizePlainText } from "@th/core/lib/sanitize-plain-text";

// ── Dependency interfaces (keeps the handler testable) ─────────────────────

export interface ShadowUpgradeDeps {
  logger: LoggerPort;

  /** Best-effort Sentry reporter for the swallowed failure branches. */
  reportError?: ReporterPort;

  /**
   * Everything needed to decide whether the user is a shadow: the CURRENT
   * `emailVerified` (read from the DB, not the hook's user object) and how
   * many AuthAccount rows (any provider) and passkeys it has. `null` when the
   * AuthUser no longer exists.
   */
  loadUpgradeEligibility(userId: string): Promise<{
    emailVerified: boolean;
    accountCount: number;
    passkeyCount: number;
  } | null>;

  /** Hash a plaintext password. */
  hashPassword(password: string): Promise<string>;

  /** Create a credential AuthAccount for the shadow user. */
  createCredentialAccount(
    userId: string,
    hashedPassword: string,
  ): Promise<void>;

  /** Update the AuthUser name if currently empty. */
  updateAuthUserName(userId: string, name: string): Promise<void>;

  /** Update the linked Human name (non-critical). */
  updateHumanName(humanId: string, name: string): Promise<void>;

  /** Send a verification email to the user. */
  sendVerificationEmail(email: string): Promise<void>;
}

export interface ShadowUpgradeUser {
  id: string;
  email: string;
  name?: string;
  humanId?: string;
}

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

// ── Core handler ───────────────────────────────────────────────────────────

/**
 * Attempt to upgrade a shadow AuthUser to a real credential user.
 *
 * Returns a result object describing what happened (useful for testing).
 */
export async function handleShadowUpgrade(
  deps: ShadowUpgradeDeps,
  user: ShadowUpgradeUser,
  request: Request | undefined,
): Promise<
  | { outcome: "skipped_not_shadow" }
  | { outcome: "skipped_no_request" }
  | { outcome: "skipped_body_parse_failed" }
  | { outcome: "skipped_no_password" }
  | { outcome: "upgraded" }
  | { outcome: "error"; error: unknown }
> {
  const { logger } = deps;

  try {
    // Refuse unless this is a TRUE shadow (see the module comment). The
    // caller gets Better Auth's normal duplicate-sign-up response either way,
    // so a refusal reveals nothing about the account — and no password is
    // attached to it.
    const eligibility = await deps.loadUpgradeEligibility(user.id);
    const isShadow =
      eligibility !== null &&
      !eligibility.emailVerified &&
      eligibility.accountCount === 0 &&
      eligibility.passkeyCount === 0;

    if (!isShadow) {
      logger.info("shadow_upgrade_skipped_not_shadow", {
        authUserId: user.id,
        userFound: eligibility !== null,
        emailVerified: eligibility?.emailVerified ?? null,
        accountCount: eligibility?.accountCount ?? null,
        passkeyCount: eligibility?.passkeyCount ?? null,
      });
      return { outcome: "skipped_not_shadow" };
    }

    // ── This is a shadow user — upgrade it ──

    // Parse the password from the signup request body.
    let password: string | undefined;
    let name: string | undefined;
    if (!request) {
      logger.warn("shadow_upgrade_no_request", { authUserId: user.id });
      return { outcome: "skipped_no_request" };
    }
    try {
      const body = await request.clone().json();
      password = typeof body.password === "string" ? body.password : undefined;
      name = typeof body.name === "string" ? body.name : undefined;
      // This is the only write path with zero validation upstream — no Zod
      // schema, no `parseInput` — going straight from a raw HTTP body field
      // to Human.name, which is publicly rendered via EntityPage.displayName.
      // Sanitize + bound length here (non-critical secondary field: truncate
      // rather than reject the whole signup over a long name).
      if (name) {
        name = sanitizePlainText(name).slice(0, 200) || undefined;
      }
    } catch {
      logger.warn("shadow_upgrade_body_parse_failed", {
        authUserId: user.id,
      });
      return { outcome: "skipped_body_parse_failed" };
    }

    if (!password || password.length < 8) {
      logger.warn("shadow_upgrade_no_password", {
        authUserId: user.id,
      });
      return { outcome: "skipped_no_password" };
    }

    // Hash and create the credential account.
    const hashed = await deps.hashPassword(password);
    await deps.createCredentialAccount(user.id, hashed);

    // Update name on the AuthUser if provided and currently empty.
    if (name && !user.name) {
      await deps.updateAuthUserName(user.id, name);
    }

    // Update name on the linked Human if one exists.
    if (name && user.humanId) {
      try {
        await deps.updateHumanName(user.humanId, name);
      } catch (nameErr) {
        // Non-critical — the Human name can be updated later.
        reportSafely(deps.reportError, nameErr, {
          tags: { area: "auth", op: "shadow_upgrade_human_name" },
          extra: { authUserId: user.id, humanId: user.humanId },
        });
      }
    }

    // Trigger email verification.
    try {
      await deps.sendVerificationEmail(user.email);
    } catch (verifyErr) {
      // Non-critical — user can request verification later.
      logger.warn("shadow_upgrade_verification_email_failed", {
        authUserId: user.id,
        error: verifyErr,
      });
      reportSafely(deps.reportError, verifyErr, {
        tags: { area: "auth", op: "shadow_upgrade_verification_email" },
        extra: { authUserId: user.id },
      });
    }

    logger.info("shadow_upgrade_succeeded", {
      authUserId: user.id,
      email: user.email,
      humanId: user.humanId ?? null,
    });
    return { outcome: "upgraded" };
  } catch (error) {
    // Defensive: never let this break the signup response.
    logger.error("shadow_upgrade_failed", {
      authUserId: user.id,
      error,
    });
    reportSafely(deps.reportError, error, {
      tags: { area: "auth", op: "shadow_upgrade" },
      extra: { authUserId: user.id },
    });
    return { outcome: "error", error };
  }
}
