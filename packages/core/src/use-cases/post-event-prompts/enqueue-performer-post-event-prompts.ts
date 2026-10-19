import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import { DEFAULT_ENQUEUE_LOOKBACK_DAYS } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// enqueuePerformerPostEventPrompts (booking-review-data-weave FR-009/FR-010)
//
// Daily sweep over completed platform gigs: an ACCEPTED BookingRequest whose
// Agreement's event ended inside the lookback window enqueues one PENDING
// PERFORMER prompt per performer human on the gig. Idempotent — the
// (eventId, humanId, audience) unique index makes re-runs insert nothing.
//
// Performer-human derivation (investigated 2026-07-14): BookingRequest only
// identifies the SENDER pair (performerOwnerType/Id, "human"|"organization");
// it carries no per-human lineup. The event's EventHuman rows (role=PERFORMER,
// humanId set) are the per-human lineup source of truth, so the prompt set is
//   lineup PERFORMER humanIds ∪ (sender humanId when the sender is a human).
// Org/band senders with no registered lineup humans yield nothing to prompt —
// counted as skippedNoPerformers, never guessed from org membership (that
// would spam managers who weren't on stage).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const enqueuePerformerPostEventPromptsInputSchema = z
  .object({
    /** Sweep window: events that ended within the last N days. */
    lookbackDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(DEFAULT_ENQUEUE_LOOKBACK_DAYS),
  })
  .strict()
  .optional()
  .default({ lookbackDays: DEFAULT_ENQUEUE_LOOKBACK_DAYS });

export type EnqueuePerformerPostEventPromptsInput = z.infer<
  typeof enqueuePerformerPostEventPromptsInputSchema
>;

export type EnqueuePerformerPostEventPromptsDeps = {
  repos: Pick<Repos, "postEventPrompts">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-gig failures (NFR-003). */
  reportError?: ReporterPort;
};

export const enqueuePerformerPostEventPromptsOutputSchema = z
  .object({
    /** Completed-gig candidates examined this run. */
    candidates: z.number().int().nonnegative(),
    /** New PENDING prompt rows inserted (existing pairs skipped). */
    enqueued: z.number().int().nonnegative(),
    /** Candidates with no resolvable performer humans (org sender, no lineup). */
    skippedNoPerformers: z.number().int().nonnegative(),
    /** Candidates skipped by the belt-and-braces event-status re-check. */
    skippedIneligible: z.number().int().nonnegative(),
    /** Candidates whose enqueue threw (reported, sweep continued). */
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type EnqueuePerformerPostEventPromptsOutput = z.infer<
  typeof enqueuePerformerPostEventPromptsOutputSchema
>;

export async function enqueuePerformerPostEventPrompts(
  deps: EnqueuePerformerPostEventPromptsDeps,
  rawInput?: unknown,
): Promise<EnqueuePerformerPostEventPromptsOutput> {
  const input = parseInput(
    enqueuePerformerPostEventPromptsInputSchema,
    rawInput ?? {},
  );
  const logger = deps.logger?.child({
    useCase: "postEventPrompts.enqueuePerformer",
  });

  const now = deps.clock.now();
  const endedAfter = new Date(now.getTime() - input.lookbackDays * DAY_MS);

  const candidates =
    await deps.repos.postEventPrompts.listPerformerGigCandidates({
      endedAfter,
      endedBefore: now,
    });

  const result: EnqueuePerformerPostEventPromptsOutput = {
    candidates: candidates.length,
    enqueued: 0,
    skippedNoPerformers: 0,
    skippedIneligible: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    // One bad gig must never abort the sweep (NFR-003).
    try {
      // Belt-and-braces: the adapter query already excludes CANCELLED /
      // DRAFT / ARCHIVED events, but a prompt for a cancelled gig is bad
      // enough (weave WS3 risk) to re-check here where it's unit-testable.
      if (
        candidate.eventStatus !== "PUBLISHED" &&
        candidate.eventStatus !== "COMPLETED"
      ) {
        result.skippedIneligible += 1;
        continue;
      }

      const humanIds = new Set<string>(candidate.lineupHumanIds);
      if (
        candidate.performerOwnerType === "human" &&
        candidate.performerOwnerId !== null
      ) {
        humanIds.add(candidate.performerOwnerId);
      }

      if (humanIds.size === 0) {
        result.skippedNoPerformers += 1;
        logger?.info("postEventPrompts.enqueuePerformer.no_performers", {
          bookingRequestId: candidate.bookingRequestId,
          eventId: candidate.eventId,
          performerOwnerType: candidate.performerOwnerType,
        });
        continue;
      }

      result.enqueued +=
        await deps.repos.postEventPrompts.createManySkipExisting(
          [...humanIds].map((humanId) => ({
            eventId: candidate.eventId,
            humanId,
            placeId: candidate.placeId,
            audience: "PERFORMER" as const,
          })),
        );
    } catch (error) {
      // Deliberate swallow: keep sweeping the other gigs. Must stay visible
      // in Sentry (Sentry convention / weave NFR-003).
      result.failed += 1;
      logger?.error("postEventPrompts.enqueuePerformer.candidate_failed", {
        err: error,
        bookingRequestId: candidate.bookingRequestId,
        eventId: candidate.eventId,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "enqueuePerformerPostEventPrompts",
            eventId: candidate.eventId,
          },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  logger?.info("postEventPrompts.enqueuePerformer.completed", result);

  return enqueuePerformerPostEventPromptsOutputSchema.parse(result);
}
