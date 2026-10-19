import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { recordConsentInputSchema } from "./schemas";

export type RecordConsentDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export type RecordConsentOutput = {
  id: string;
};

/**
 * Persist a single consent-banner decision (Accept All / Essential Only /
 * Reset). The caller — typically the public tRPC procedure — validates rate
 * limits and supplies the request-derived `actorHumanId`, `ipHash`, and
 * `userAgent`; the use case never reads those off the client.
 */
export async function recordConsent(
  deps: RecordConsentDeps,
  rawInput: unknown,
): Promise<RecordConsentOutput> {
  const input = parseInput(recordConsentInputSchema, rawInput);

  const { id } = await deps.repos.consent.add({
    anonymousId: input.anonymousId,
    humanId: input.actorHumanId,
    choice: input.choice,
    source: input.source,
    privacyPolicyVersion: input.privacyPolicyVersion,
    cookiePolicyVersion: input.cookiePolicyVersion,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  });

  return { id };
}
