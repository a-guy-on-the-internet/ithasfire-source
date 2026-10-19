import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  sendScannerOnboardingEmailInputSchema,
  SCANNER_OPERATOR_ROLES,
} from "./schemas";

export type SendScannerOnboardingEmailDeps = {
  repos: Repos;
  clock: ClockPort;
  mailer: MailerPort;
  /** App Store / TestFlight URL. `null` hides the iOS button. */
  iosAppUrl: string | null;
  /** Play Store / internal-track URL. `null` hides the Android button. */
  androidAppUrl: string | null;
  logger?: LoggerPort;
};

export type SendScannerOnboardingEmailOutput = {
  sentTo: string;
};

/**
 * Email a scanner-app onboarding message: download links + sign-in
 * instructions. The recipient's access is governed by their org SCANNER (or
 * higher) role on the Team page; this use case sends no token and grants no
 * access — it only tells the recipient *how* to install and sign in via the
 * standard scanner magic-link flow.
 *
 * RBAC:
 *   - actor must hold OWNER or ADMIN on `orgId`
 *   - target (humanId or email match) must already hold OWNER, ADMIN, or
 *     SCANNER on `orgId`. We require this so the email body's "You've been
 *     added to {orgName} as a Scanner" claim is never a lie, and so this
 *     surface can't be abused to fan out arbitrary "install our app" mail.
 */
export async function sendScannerOnboardingEmail(
  deps: SendScannerOnboardingEmailDeps,
  rawInput: unknown,
): Promise<SendScannerOnboardingEmailOutput> {
  const input = parseInput(sendScannerOnboardingEmailInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
  });

  let recipientHumanId: string;
  let recipientEmail: string;
  if (input.targetHumanId) {
    const target = await deps.repos.humans.getByIdWithIdentity(
      input.targetHumanId,
    );
    if (!target?.identity.email) {
      // Collapse "no such human" and "human without identity email" into a
      // single error so an admin caller can't enumerate platform humans.
      throw fail("TARGET_NOT_FOUND");
    }
    recipientHumanId = target.human.id;
    recipientEmail = target.identity.email;
  } else if (input.targetEmail) {
    const found = await deps.repos.humans.getByEmail(input.targetEmail);
    if (!found)
      throw fail("TARGET_NOT_FOUND");
    recipientHumanId = found.human.id;
    recipientEmail = found.identity.email;
  } else {
    // Schema's refine() guarantees one is set; this is for the type narrower.
    throw fail("MISSING_TARGET");
  }

  // The recipient must already hold a scanner-eligible role on the org.
  const targetMembership = await deps.repos.authz.getOrgMembership({
    orgId: input.orgId,
    humanId: recipientHumanId,
  });
  if (!targetMembership) {
    throw fail("TARGET_NOT_MEMBER");
  }
  if (
    !(SCANNER_OPERATOR_ROLES as readonly string[]).includes(
      targetMembership.role,
    )
  ) {
    throw fail("TARGET_LACKS_SCANNER_ROLE");
  }

  const org = await deps.repos.organizations.getById(input.orgId);
  if (!org)
    throw fail("ORGANIZATION_NOT_FOUND");
  const orgContactEmail = org.contactEmail ?? null;

  // Idempotency key: scoped per (org, recipient, day) so re-sends within the
  // same UTC day are deduped at the mailer layer.
  const day = deps.clock.now().toISOString().slice(0, 10);
  const idempotencyKey = `scanner-onboarding:${input.orgId}:${recipientEmail}:${day}`;

  await deps.mailer.send({
    to: { to: recipientEmail },
    replyTo: orgContactEmail
      ? { to: orgContactEmail, name: org.name }
      : undefined,
    template: {
      key: "scanner.onboarding",
      variables: {
        orgName: org.name,
        recipientEmail,
        iosAppUrl: deps.iosAppUrl,
        androidAppUrl: deps.androidAppUrl,
      },
    },
    idempotencyKey,
  });

  deps.logger?.info("scanner.send_onboarding_email", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    recipientEmail,
    hasIosUrl: !!deps.iosAppUrl,
    hasAndroidUrl: !!deps.androidAppUrl,
  });

  return { sentTo: recipientEmail };
}
