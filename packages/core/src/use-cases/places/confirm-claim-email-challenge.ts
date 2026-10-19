import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { MAX_CHALLENGE_ATTEMPTS, verifyChallengeCode } from "./_shared/claim";
import { z } from "zod";
import { fail } from "@th/errors";

export const confirmClaimEmailChallengeInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    challengeId: z.string().uuid(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "code_must_be_6_digits"),
  })
  .strict();

export const confirmClaimEmailChallengeOutputSchema = z
  .object({
    verified: z.boolean(),
  })
  .strict();

export type ConfirmClaimEmailChallengeInput = z.infer<
  typeof confirmClaimEmailChallengeInputSchema
>;
export type ConfirmClaimEmailChallengeOutput = z.infer<
  typeof confirmClaimEmailChallengeOutputSchema
>;

export type ConfirmClaimEmailChallengeDeps = {
  repos: Pick<Repos, "placeClaimEmailChallenges">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Claim proof kind (b), step 2: verify the 6-digit code (constant-time hash
 * compare), counting failed attempts and locking after N. On success the
 * challenge is marked satisfied so submit-place-claim can consume it.
 */
export async function confirmClaimEmailChallenge(
  deps: ConfirmClaimEmailChallengeDeps,
  rawInput: unknown,
): Promise<ConfirmClaimEmailChallengeOutput> {
  const logger = deps.logger?.child({ useCase: "confirmClaimEmailChallenge" });

  const execute = async () => {
    const input = parseInput(confirmClaimEmailChallengeInputSchema, rawInput);
    const now = deps.clock.now();

    const challenge = await deps.repos.placeClaimEmailChallenges.getById(
      input.challengeId,
    );
    if (!challenge || challenge.humanId !== input.actorHumanId) {
      throw fail("CLAIM_CHALLENGE_NOT_FOUND");
    }

    // Idempotent replay: already verified → success.
    if (challenge.verifiedAt) {
      return confirmClaimEmailChallengeOutputSchema.parse({ verified: true });
    }

    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw fail("CLAIM_CHALLENGE_EXPIRED");
    }
    if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      throw fail("CLAIM_CHALLENGE_LOCKED");
    }

    if (!verifyChallengeCode(input.code, challenge.codeHash)) {
      const attempts = await deps.repos.placeClaimEmailChallenges.incrementAttempts(
        challenge.id,
      );
      if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
        throw fail("CLAIM_CHALLENGE_LOCKED");
      }
      throw fail("CLAIM_CHALLENGE_CODE_INVALID");
    }

    await deps.repos.placeClaimEmailChallenges.markVerified({
      id: challenge.id,
      verifiedAt: now,
    });

    return confirmClaimEmailChallengeOutputSchema.parse({ verified: true });
  };

  if (logger) {
    return logger.withTime("confirmClaimEmailChallenge", execute);
  }
  return execute();
}
