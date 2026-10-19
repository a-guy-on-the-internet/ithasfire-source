import escapeHtml from "escape-html";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import {
  CHALLENGE_TTL_MS,
  domainMatchesWebsite,
  emailDomain,
  generateChallengeCode,
  hashChallengeCode,
  isFreeEmailDomain,
  registrableDomainFromWebsite,
} from "./_shared/claim";
import { z } from "zod";
import { fail } from "@th/errors";

export const requestClaimEmailChallengeInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    email: z.string().email().trim().toLowerCase().max(320),
  })
  .strict();

export const requestClaimEmailChallengeOutputSchema = z
  .object({
    challengeId: z.string().uuid(),
    expiresAt: z.date(),
  })
  .strict();

export type RequestClaimEmailChallengeInput = z.infer<
  typeof requestClaimEmailChallengeInputSchema
>;
export type RequestClaimEmailChallengeOutput = z.infer<
  typeof requestClaimEmailChallengeOutputSchema
>;

export type RequestClaimEmailChallengeDeps = {
  repos: Pick<Repos, "places" | "placeClaimEmailChallenges">;
  mailer?: MailerPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Claim proof kind (b): issue a 6-digit code to an address at the venue's
 * registrable domain, proving mailbox control. Rejects free-email domains and
 * domains not matching Place.website. Idempotent-ish: an already-active
 * (unexpired, unverified) challenge for the same (place, human) is returned
 * instead of spamming a fresh code.
 */
export async function requestClaimEmailChallenge(
  deps: RequestClaimEmailChallengeDeps,
  rawInput: unknown,
): Promise<RequestClaimEmailChallengeOutput> {
  const logger = deps.logger?.child({ useCase: "requestClaimEmailChallenge" });

  const execute = async () => {
    const input = parseInput(requestClaimEmailChallengeInputSchema, rawInput);
    const now = deps.clock.now();

    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }
    if (place.status === "ARCHIVED" || place.verificationStatus === "VERIFIED") {
      throw fail("PLACE_NOT_CLAIMABLE");
    }

    const websiteDom = registrableDomainFromWebsite(place.website);
    if (!websiteDom) {
      throw fail("CLAIM_PLACE_HAS_NO_WEBSITE");
    }
    if (isFreeEmailDomain(websiteDom)) {
      throw fail("CLAIM_FREE_EMAIL_NOT_ALLOWED");
    }

    const targetDom = emailDomain(input.email);
    if (!targetDom) {
      throw fail("CLAIM_EMAIL_DOMAIN_MISMATCH");
    }
    if (isFreeEmailDomain(targetDom)) {
      throw fail("CLAIM_FREE_EMAIL_NOT_ALLOWED");
    }
    if (!domainMatchesWebsite(targetDom, websiteDom)) {
      throw fail("CLAIM_EMAIL_DOMAIN_MISMATCH");
    }

    // Rate limit: reuse an active challenge for this (place, human) rather than
    // minting a second live code.
    const active =
      await deps.repos.placeClaimEmailChallenges.getActiveForPlaceHuman({
        placeId: input.placeId,
        humanId: input.actorHumanId,
        now,
      });
    if (active) {
      return requestClaimEmailChallengeOutputSchema.parse({
        challengeId: active.id,
        expiresAt: active.expiresAt,
      });
    }

    const code = generateChallengeCode();
    const challenge = await deps.repos.placeClaimEmailChallenges.create({
      placeId: input.placeId,
      humanId: input.actorHumanId,
      email: input.email,
      codeHash: hashChallengeCode(code),
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    });

    // Best-effort: email the code. The challenge row is authoritative; a send
    // failure surfaces to logs (the user can re-request).
    if (deps.mailer) {
      deps.mailer
        .send({
          to: { to: input.email },
          subject: `Your place claim code for ${place.name}`,
          text: [
            `Your verification code to claim "${place.name}" on Ithas Fire is:`,
            "",
            code,
            "",
            "This code expires in 15 minutes. If you didn't request it, ignore this email.",
          ].join("\n"),
          // `place.name` is operator-controlled free text; escape it before
          // embedding in the HTML body (the text/subject legs are not HTML
          // sinks). Mirrors the event-approval email escaping.
          html: [
            `<p>Your verification code to claim "${escapeHtml(place.name)}" on Ithas Fire is:</p>`,
            `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>`,
            "<p>This code expires in 15 minutes. If you didn't request it, ignore this email.</p>",
          ].join("\n"),
        })
        .catch((err) => {
          logger?.error("requestClaimEmailChallenge.emailFailed", {
            challengeId: challenge.id,
            error: describeError(err),
          });
        });
    }

    return requestClaimEmailChallengeOutputSchema.parse({
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
    });
  };

  if (logger) {
    return logger.withTime("requestClaimEmailChallenge", execute);
  }
  return execute();
}
