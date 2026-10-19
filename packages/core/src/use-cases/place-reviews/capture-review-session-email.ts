import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const captureReviewSessionEmailInputSchema = z
  .object({
    sessionToken: z.string().uuid(),
    email: z.string().email().max(320),
  })
  .strict();

export const captureReviewSessionEmailOutputSchema = z
  .object({
    captured: z.boolean(),
    matchedHumanId: z.string().uuid().nullable(),
  })
  .strict();

export type CaptureReviewSessionEmailInput = z.infer<
  typeof captureReviewSessionEmailInputSchema
>;
export type CaptureReviewSessionEmailOutput = z.infer<
  typeof captureReviewSessionEmailOutputSchema
>;

export type CaptureReviewSessionEmailDeps = {
  repos: Pick<Repos, "placeReviewSessions">;
  logger?: LoggerPort;
};

export async function captureReviewSessionEmail(
  deps: CaptureReviewSessionEmailDeps,
  rawInput: unknown,
): Promise<CaptureReviewSessionEmailOutput> {
  const input = parseInput(captureReviewSessionEmailInputSchema, rawInput);

  const session = await deps.repos.placeReviewSessions.captureEmail({
    sessionToken: input.sessionToken,
    email: input.email,
  });

  return {
    captured: true,
    matchedHumanId: session.humanId,
  };
}
