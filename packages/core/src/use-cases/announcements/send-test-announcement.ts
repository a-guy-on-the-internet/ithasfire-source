import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput, describeError } from "../../lib/io";
import { requireOwnerAccess, ORG_EDIT_ROLES } from "../../lib/rbac";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { sanitizeAnnouncementHtml } from "../../lib/announcement-html";
import { fail } from "@th/errors";
import { plainTextRequired } from "../../lib/sanitize-plain-text";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum HTML body size in bytes (~150 KB, matches industry standard). */
const MAX_BODY_HTML_BYTES = 150_000;

export const sendTestAnnouncementInputSchema = z
  .object({
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    subject: plainTextRequired(200),
    bodyHtml: z
      .string()
      .min(1)
      .refine(
        (html) =>
          new TextEncoder().encode(html).byteLength <= MAX_BODY_HTML_BYTES,
        {
          message: `Email body must be under ${Math.round(MAX_BODY_HTML_BYTES / 1_000)} KB`,
        },
      ),
  })
  .strict();

export const sendTestAnnouncementOutputSchema = z.object({
  sentToEmail: z.string().email(),
});

export type SendTestAnnouncementInput = z.infer<
  typeof sendTestAnnouncementInputSchema
>;
export type SendTestAnnouncementOutput = z.infer<
  typeof sendTestAnnouncementOutputSchema
>;

export type SendTestAnnouncementDeps = {
  repos: Repos;
  clock: ClockPort;
  logger: LoggerPort;
  mailer?: MailerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a test copy of the announcement to the actor's own email address.
 * Does NOT persist an Announcement record — this is a preview-only action.
 */
export async function sendTestAnnouncement(
  deps: SendTestAnnouncementDeps,
  rawInput: unknown,
): Promise<SendTestAnnouncementOutput> {
  const input = parseInput(sendTestAnnouncementInputSchema, rawInput);

  // Verified-email gate (security review F8): the test copy goes to the
  // actor's identity email with caller-written HTML, so an unverified address
  // (change-email does not verify) would make this a relay.
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  // Sanitize against the prose-editor allowlist before dispatch.
  const bodyHtml = sanitizeAnnouncementHtml(input.bodyHtml);

  // ── RBAC: authorize based on owner type ───────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // ── Resolve the actor's email ─────────────────────────────────────────
  const result = await deps.repos.humans.getByIdWithIdentity(
    input.actorHumanId,
  );
  if (!result?.identity.email) {
    throw fail("ACTOR_EMAIL_NOT_FOUND");
  }

  const { human, identity } = result;

  try {
    // ── Send a test email to the actor ──────────────────────────────────
    if (!deps.mailer) {
      throw fail("MAILER_NOT_CONFIGURED");
    }

    const sendOutput = await deps.mailer.send({
      to: { to: identity.email, name: human.name ?? undefined },
      subject: `[TEST] ${input.subject}`,
      html: bodyHtml,
      metadata: {
        source: "announcement_test",
        ownerId: input.ownerId,
        actorHumanId: input.actorHumanId,
      },
      tags: ["announcement", "test"],
    });

    if (!sendOutput.result.success) {
      deps.logger.warn("test_announcement_send_port_error", {
        ownerId: input.ownerId,
        errorCode: sendOutput.result.errorCode ?? null,
        errorMessage: sendOutput.result.errorMessage ?? null,
      });
      throw fail("EMAIL_DELIVERY_FAILED");
    }

    deps.logger.info("test_announcement_sent", {
      ownerId: input.ownerId,
      actorHumanId: input.actorHumanId,
      sentToEmail: identity.email,
      subject: input.subject,
      vendorMessageId: sendOutput.result.id ?? null,
    });

    return { sentToEmail: identity.email };
  } catch (error) {
    deps.logger.error("test_announcement_send_failed", {
      ownerId: input.ownerId,
      error: describeError(error),
    });
    throw error;
  }
}
