import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput, describeError } from "../../lib/io";
import { verifyOrgUnsubscribeToken } from "./unsubscribe-from-audience";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const unsubscribeFromOrgAnnouncementsInputSchema = z
  .object({
    /** The organization whose announcements the recipient is opting out of. */
    orgId: z.string().uuid(),
    /** The email address to unsubscribe. */
    email: z.string().email(),
    /** HMAC token for verifying the request. */
    token: z.string().min(1),
  })
  .strict();

export const unsubscribeFromOrgAnnouncementsOutputSchema = z.object({
  ok: z.literal(true),
});

export type UnsubscribeFromOrgAnnouncementsInput = z.infer<
  typeof unsubscribeFromOrgAnnouncementsInputSchema
>;
export type UnsubscribeFromOrgAnnouncementsOutput = z.infer<
  typeof unsubscribeFromOrgAnnouncementsOutputSchema
>;

export type UnsubscribeFromOrgAnnouncementsDeps = {
  repos: Repos;
  logger: LoggerPort;
  /** HMAC secret for verifying unsubscribe tokens. */
  unsubscribeSecret: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process an org-level announcement unsubscribe request. Verifies the HMAC
 * token (constant-time), then suppresses future announcement emails from the
 * org for this email address:
 *
 * - If a `Human` is linked to the email, upsert a `NotificationPreference`
 *   row at ORG scope with `email.announcements = false`. The upsert deep-merges
 *   into any existing delta at that scope, so other category prefs are
 *   preserved.
 * - If no `Human` is linked, record the email in the anonymous suppression
 *   list (idempotent).
 *
 * This is a public (unauthenticated) endpoint — the HMAC token acts as proof
 * of authorization. Only the `announcements` category is affected;
 * transactional emails are unaffected.
 */
export async function unsubscribeFromOrgAnnouncements(
  deps: UnsubscribeFromOrgAnnouncementsDeps,
  rawInput: unknown,
): Promise<UnsubscribeFromOrgAnnouncementsOutput> {
  const input = parseInput(unsubscribeFromOrgAnnouncementsInputSchema, rawInput);

  const valid = verifyOrgUnsubscribeToken(
    deps.unsubscribeSecret,
    input.orgId,
    input.email,
    input.token,
  );
  if (!valid) {
    throw fail("INVALID_UNSUBSCRIBE_TOKEN");
  }

  const email = input.email.toLowerCase();

  try {
    // Relies on Better Auth persisting `AuthUser.email` lowercased (its default
    // behaviour). If that ever changes, this exact-match lookup would miss the
    // real human and misroute them to the anonymous-suppression table — switch
    // to a case-insensitive lookup here if Better Auth stops lowercasing.
    const found = await deps.repos.humans.getByEmail(email);

    if (found) {
      const humanId = found.human.id;
      // Merge into any existing ORG-scope delta (upsert deep-merges) so we
      // only flip the announcements/email flag without clobbering other prefs.
      await deps.repos.notificationPrefs.upsert({
        humanId,
        scope: { kind: "ORG", orgId: input.orgId },
        delta: { channels: { email: { announcements: false } } },
      });

      deps.logger.info("org_announcements_unsubscribed_human", {
        orgId: input.orgId,
        humanId,
      });
    } else {
      await deps.repos.announcements.insertAnonymousSuppression({
        email,
        orgId: input.orgId,
        reason: "unsubscribe",
      });

      deps.logger.info("org_announcements_unsubscribed_anonymous", {
        orgId: input.orgId,
      });
    }

    return { ok: true };
  } catch (error) {
    deps.logger.error("org_announcements_unsubscribe_failed", {
      orgId: input.orgId,
      error: describeError(error),
    });
    throw error;
  }
}
