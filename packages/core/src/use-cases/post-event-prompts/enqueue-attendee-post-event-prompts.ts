import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import { DEFAULT_ENQUEUE_LOOKBACK_DAYS } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// enqueueAttendeePostEventPrompts (attendee-reviews FR-006)
//
// Daily sweep over ended events with SCANNED tickets: one PENDING ATTENDEE
// prompt per distinct scanned ticket-holder human. Idempotent via the
// (eventId, humanId, audience) unique index.
//
// AUDIENCE PRECEDENCE (attendee-reviews prompt-fatigue mitigation): a human
// holding a PERFORMER prompt for the event never also gets an ATTENDEE one —
// performers who scanned in get the performer ask only. The jobs layer runs
// the performer sweep BEFORE this one (post-event-prompts.enqueue), and
// booking acceptance always precedes the gig itself, so the PERFORMER rows
// this check needs are already in place.
//
// NOTE: rows enqueued here are dispatch-GATED (DISPATCH_ENABLED_AUDIENCES in
// ./constants.ts) until the attendee review form ships — enqueue still runs
// so history accumulates and no one is retro-prompted at launch.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const enqueueAttendeePostEventPromptsInputSchema = z
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

export type EnqueueAttendeePostEventPromptsInput = z.infer<
  typeof enqueueAttendeePostEventPromptsInputSchema
>;

export type EnqueueAttendeePostEventPromptsDeps = {
  repos: Pick<Repos, "postEventPrompts">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-event failures (NFR-003). */
  reportError?: ReporterPort;
};

export const enqueueAttendeePostEventPromptsOutputSchema = z
  .object({
    /** Ended-event candidates examined this run. */
    candidates: z.number().int().nonnegative(),
    /** New PENDING prompt rows inserted (existing pairs skipped). */
    enqueued: z.number().int().nonnegative(),
    /** Scanned attendees excluded because they hold a PERFORMER prompt. */
    excludedPerformers: z.number().int().nonnegative(),
    /** Candidates skipped by the belt-and-braces event-status re-check. */
    skippedIneligible: z.number().int().nonnegative(),
    /** Candidates whose enqueue threw (reported, sweep continued). */
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type EnqueueAttendeePostEventPromptsOutput = z.infer<
  typeof enqueueAttendeePostEventPromptsOutputSchema
>;

export async function enqueueAttendeePostEventPrompts(
  deps: EnqueueAttendeePostEventPromptsDeps,
  rawInput?: unknown,
): Promise<EnqueueAttendeePostEventPromptsOutput> {
  const input = parseInput(
    enqueueAttendeePostEventPromptsInputSchema,
    rawInput ?? {},
  );
  const logger = deps.logger?.child({
    useCase: "postEventPrompts.enqueueAttendee",
  });

  const now = deps.clock.now();
  const endedAfter = new Date(now.getTime() - input.lookbackDays * DAY_MS);

  const candidates =
    await deps.repos.postEventPrompts.listAttendeeEventCandidates({
      endedAfter,
      endedBefore: now,
    });

  const result: EnqueueAttendeePostEventPromptsOutput = {
    candidates: candidates.length,
    enqueued: 0,
    excludedPerformers: 0,
    skippedIneligible: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    // One bad event must never abort the sweep (NFR-003).
    try {
      // Belt-and-braces re-check of the adapter query's status filter — a
      // prompt for a cancelled event must never be enqueued.
      if (
        candidate.eventStatus !== "PUBLISHED" &&
        candidate.eventStatus !== "COMPLETED"
      ) {
        result.skippedIneligible += 1;
        continue;
      }

      const scannedHumanIds =
        await deps.repos.postEventPrompts.scannedTicketHolderHumanIds(
          candidate.eventId,
        );
      if (scannedHumanIds.length === 0) {
        continue;
      }

      // Audience precedence: performer-prompted humans never get the
      // attendee ask for the same event.
      const performerHumanIds = new Set(
        await deps.repos.postEventPrompts.humanIdsWithPrompt({
          eventId: candidate.eventId,
          audience: "PERFORMER",
        }),
      );

      const eligible = [...new Set(scannedHumanIds)].filter((humanId) => {
        if (performerHumanIds.has(humanId)) {
          result.excludedPerformers += 1;
          return false;
        }
        return true;
      });

      if (eligible.length === 0) {
        continue;
      }

      result.enqueued +=
        await deps.repos.postEventPrompts.createManySkipExisting(
          eligible.map((humanId) => ({
            eventId: candidate.eventId,
            humanId,
            placeId: candidate.placeId,
            audience: "ATTENDEE" as const,
          })),
        );
    } catch (error) {
      // Deliberate swallow: keep sweeping the other events. Must stay
      // visible in Sentry (Sentry convention / attendee NFR-003).
      result.failed += 1;
      logger?.error("postEventPrompts.enqueueAttendee.candidate_failed", {
        err: error,
        eventId: candidate.eventId,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "enqueueAttendeePostEventPrompts",
            eventId: candidate.eventId,
          },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  logger?.info("postEventPrompts.enqueueAttendee.completed", result);

  return enqueueAttendeePostEventPromptsOutputSchema.parse(result);
}
