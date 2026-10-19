import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import { verifyReviewPromptUnsubscribeToken } from "./unsubscribe-from-audience";

// ─────────────────────────────────────────────────────────────────────────────
// unsubscribeReviewPrompts (attendee-prompt-delivery-hygiene FR-006)
//
// One-click, unauthenticated opt-out from the weekly attendee review-prompt
// EMAIL digest. The HMAC token (signed over `reviewprompts:<humanId>:<email>`)
// is the sole proof of authorization — same threat model the announcements
// unsubscribe already accepts. Flips ONLY the human's ATTENDEE_FEEDBACK
// subscription to subscribed=false; it reads and mutates no other preference
// and never touches in-app delivery (the spec's compliance invariant).
// ─────────────────────────────────────────────────────────────────────────────

const DIGEST_TYPE = "ATTENDEE_FEEDBACK" as const;

export const unsubscribeReviewPromptsInputSchema = z
  .object({
    kind: z.literal("review-prompts").default("review-prompts"),
    /** The human whose review-prompt email is being muted. */
    humanId: z.string().uuid(),
    /** The email address the digest was sent to (part of the signed token). */
    email: z.string().email().max(320),
    /** HMAC token proving authorization. */
    token: z.string().min(1).max(256),
  })
  .strict();

export const unsubscribeReviewPromptsOutputSchema = z.object({
  ok: z.literal(true),
});

export type UnsubscribeReviewPromptsInput = z.infer<
  typeof unsubscribeReviewPromptsInputSchema
>;
export type UnsubscribeReviewPromptsOutput = z.infer<
  typeof unsubscribeReviewPromptsOutputSchema
>;

export type UnsubscribeReviewPromptsDeps = {
  repos: Pick<Repos, "notificationDigests">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** HMAC secret for verifying unsubscribe tokens (UNSUBSCRIBE_SECRET). */
  unsubscribeSecret: string;
};

export async function unsubscribeReviewPrompts(
  deps: UnsubscribeReviewPromptsDeps,
  rawInput: unknown,
): Promise<UnsubscribeReviewPromptsOutput> {
  const input = parseInput(unsubscribeReviewPromptsInputSchema, rawInput);

  const valid = verifyReviewPromptUnsubscribeToken(
    deps.unsubscribeSecret,
    input.humanId,
    input.email,
    input.token,
  );
  if (!valid) {
    throw fail("INVALID_UNSUBSCRIBE_TOKEN");
  }

  try {
    await deps.repos.notificationDigests.upsertSubscription({
      humanId: input.humanId,
      digestType: DIGEST_TYPE,
      subscribed: false,
      reason: "user_unsubscribed",
      unsubscribedAt: deps.clock.now(),
    });

    deps.logger?.info("review_prompts_unsubscribed", {
      humanId: input.humanId,
    });

    return { ok: true };
  } catch (error) {
    // Rethrow (the transport maps it) — but keep it visible in logs.
    deps.logger?.error("review_prompts_unsubscribe_failed", {
      err: error,
      humanId: input.humanId,
      error: describeError(error),
    });
    throw error;
  }
}
