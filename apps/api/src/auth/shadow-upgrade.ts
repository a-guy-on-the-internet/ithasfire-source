/**
 * Shadow profile upgrade handler.
 *
 * When a guest checkout (or future volunteer signup, comp ticket claim, etc.)
 * creates a shadow AuthUser via `ensureGuestHuman`, that user has an AuthUser
 * row (email, emailVerified=false) but NO AuthAccount.
 *
 * If they later try to sign up with email/password, Better Auth finds the
 * existing email and fires `onExistingUserSignUp`. We detect shadow users (no
 * credential account) and upgrade them by creating a credential AuthAccount
 * with their chosen password.
 *
 * This module is extracted from the main Better Auth config so the core logic
 * can be unit-tested without requiring the full Better Auth or Prisma setup.
 */

import type { LoggerPort } from "@th/ports";
import { sanitizePlainText } from "@th/core/lib/sanitize-plain-text";

// ── Dependency interfaces (keeps the handler testable) ─────────────────────

export interface ShadowUpgradeDeps {
  logger: LoggerPort;

  /** Look up an existing credential AuthAccount for the user. */
  findCredentialAccount(userId: string): Promise<{ id: string } | null>;

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
  | { outcome: "skipped_has_credential" }
  | { outcome: "skipped_no_request" }
  | { outcome: "skipped_body_parse_failed" }
  | { outcome: "skipped_no_password" }
  | { outcome: "upgraded" }
  | { outcome: "error"; error: unknown }
> {
  const { logger } = deps;

  try {
    // Check if this user already has a credential account (real user,
    // not a shadow). If so, this is a genuine duplicate signup — let
    // Better Auth's default anti-enumeration behavior handle it.
    const existingCredential = await deps.findCredentialAccount(user.id);

    if (existingCredential) {
      logger.info("shadow_upgrade_skipped_has_credential", {
        authUserId: user.id,
        email: user.email,
      });
      return { outcome: "skipped_has_credential" };
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
      } catch {
        // Non-critical — the Human name can be updated later.
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
    return { outcome: "error", error };
  }
}
