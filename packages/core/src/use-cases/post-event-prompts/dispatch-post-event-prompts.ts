import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PostEventPromptRecord } from "@th/ports/repos/post-event-prompts";

import { describeError, parseInput } from "../../lib/io";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import { ATTENDEE_REVIEW_WINDOW_MS } from "../attendee-reviews/constants";
import type { NotifyInput } from "../comms/notify";
import { DISPATCH_ENABLED_AUDIENCES } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// dispatchPostEventPrompts (weave FR-009/FR-010 + attendee FR-006)
//
// Drains the SHARED post-event prompt outbox through the notify pipeline
// (in-app + email; notify() itself derives the per-channel `{key}:email` /
// `{key}:sms` idempotency keys from the notify-level key we pass — see
// comms/notify.ts). Only DISPATCH_ENABLED_AUDIENCES are pulled from the
// outbox (filtering happens in the listPending QUERY so a gated audience can
// never fill — and starve — the batch). Both PERFORMER and ATTENDEE are
// enabled; dispatch branches on prompt.audience for the variant + deep link.
//
// PERFORMER deep-link: /review-a-place?place=<place NAME>&placeId=…&campaign=…
// — the page's searchParams accept `place` as a NAME prefill for the review
// form (apps/web/src/app/review-a-place/page.tsx), so dispatch resolves the
// prompt's placeId to its display name at send time.
//
// ATTENDEE deep-link: /review-event/<eventId>?campaign=post-event-prompt (the
// fixed contract shared with the attendee review form loop). Place is optional
// for attendee copy; see processAttendeePrompt for the two gate-open guards.
// ─────────────────────────────────────────────────────────────────────────────

const PERFORMER_PROMPT_VARIANT = "post-event.performer-review-prompt" as const;
const ATTENDEE_PROMPT_VARIANT = "post-event.attendee-review-prompt" as const;
const PROMPT_CAMPAIGN = "post-gig-prompt" as const;
// Fixed contract shared with the /review-event/[eventId] web form loop —
// do not change without coordinating with that page's searchParams.
const ATTENDEE_PROMPT_CAMPAIGN = "post-event-prompt" as const;

export const dispatchPostEventPromptsInputSchema = z
  .object({
    /** Max outbox rows to drain per run (keeps the job bounded). */
    batchLimit: z.number().int().positive().default(50),
    /** Attempts after which a prompt is dead-lettered instead of retried. */
    maxAttempts: z.number().int().positive().default(5),
  })
  .strict();

export type DispatchPostEventPromptsInput = z.infer<
  typeof dispatchPostEventPromptsInputSchema
>;

export const dispatchPostEventPromptsOutputSchema = z
  .object({
    /** Prompts examined this run. */
    processed: z.number().int().nonnegative(),
    /** Prompts flipped to SENT after a successful notify. */
    sent: z.number().int().nonnegative(),
    /**
     * Prompts dead-lettered WITHOUT a send: the event vanished / was
     * cancelled / unpublished, or the prompt's place vanished (a performer
     * prompt without a review target has nothing to deep-link).
     */
    skipped: z.number().int().nonnegative(),
    /** Prompts that exhausted maxAttempts and were dead-lettered. */
    deadLettered: z.number().int().nonnegative(),
    /**
     * ATTENDEE prompts dead-lettered because the event's review window
     * (end + ATTENDEE_REVIEW_WINDOW_DAYS) has already closed — the form would
     * refuse them. Drains the backlog accumulated while ATTENDEE was gated.
     */
    expired: z.number().int().nonnegative(),
    /**
     * ATTENDEE prompts dead-lettered because the same human also holds a
     * PERFORMER prompt for the event (audience precedence re-check).
     */
    superseded: z.number().int().nonnegative(),
    /**
     * B2: prompts settled (and counted in `sent`) with in-app and push
     * withheld because the account email is not verified. Verifying later
     * does not resend them. A failed lookup is retried, not counted here.
     */
    suppressedUnverified: z.number().int().nonnegative(),
  })
  .strict();

export type DispatchPostEventPromptsOutput = z.infer<
  typeof dispatchPostEventPromptsOutputSchema
>;

/**
 * `notify` is typed against `NotifyInput` only (return ignored), matching
 * dispatch-rsvp-notifications: the jobs layer closes over the real notify
 * use case with the mailer bound; tests pass a plain spy.
 */
export type DispatchPostEventPromptsDeps = {
  repos: Pick<Repos, "postEventPrompts" | "events" | "places" | "humans">;
  notify: (input: NotifyInput) => Promise<unknown>;
  clock: ClockPort;
  /** Public web origin used to build absolute deep-link URLs. */
  appBaseUrl: string;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-prompt failures (NFR-003). */
  reportError?: ReporterPort;
};

export async function dispatchPostEventPrompts(
  deps: DispatchPostEventPromptsDeps,
  rawInput: unknown,
): Promise<DispatchPostEventPromptsOutput> {
  const input = parseInput(dispatchPostEventPromptsInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "postEventPrompts.dispatch",
  });

  const prompts = await deps.repos.postEventPrompts.listPending({
    limit: input.batchLimit,
    audiences: [...DISPATCH_ENABLED_AUDIENCES],
  });

  const result: DispatchPostEventPromptsOutput = {
    processed: 0,
    sent: 0,
    skipped: 0,
    deadLettered: 0,
    expired: 0,
    superseded: 0,
    suppressedUnverified: 0,
  };

  for (const prompt of prompts) {
    result.processed += 1;
    // Outer guard: one prompt must NEVER abort the batch, not even if a repo
    // bookkeeping call throws unexpectedly (Sentry convention).
    try {
      await processPrompt({ prompt, deps, input, result, logger });
    } catch (error) {
      logger?.error("postEventPrompts.dispatch.prompt_unhandled", {
        err: error,
        promptId: prompt.id,
        eventId: prompt.eventId,
        humanId: prompt.humanId,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "dispatchPostEventPrompts",
            promptId: prompt.id,
          },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  logger?.info("postEventPrompts.dispatch.completed", result);

  return dispatchPostEventPromptsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-prompt processing
// ─────────────────────────────────────────────────────────────────────────────

async function processPrompt(args: {
  prompt: PostEventPromptRecord;
  deps: DispatchPostEventPromptsDeps;
  input: DispatchPostEventPromptsInput;
  result: DispatchPostEventPromptsOutput;
  logger: LoggerPort | undefined;
}): Promise<void> {
  const { prompt, deps, input, result, logger } = args;
  const { repos } = deps;

  // Defensive: listPending is audience-filtered, so a gated (ATTENDEE)
  // prompt can't normally reach here. If one somehow does, leave it PENDING
  // untouched — it's still owed once its audience is enabled.
  if (
    !(DISPATCH_ENABLED_AUDIENCES as readonly string[]).includes(
      prompt.audience,
    )
  ) {
    logger?.warn("postEventPrompts.dispatch.audience_gated", {
      promptId: prompt.id,
      audience: prompt.audience,
    });
    return;
  }

  // Resolve the event AT DISPATCH TIME. A vanished, cancelled, or
  // no-longer-listed event is dead-lettered silently — soliciting a review
  // for a cancelled gig is exactly the failure mode the spec calls out. This
  // applies to BOTH audiences (attendee prompts with a vanished event
  // dead-letter exactly like performer ones).
  const event = await repos.events.getById(prompt.eventId);
  if (
    !event ||
    (event.status !== "PUBLISHED" && event.status !== "COMPLETED")
  ) {
    await repos.postEventPrompts.markFailed([prompt.id]);
    result.skipped += 1;
    logger?.info("postEventPrompts.dispatch.event_gone", {
      promptId: prompt.id,
      eventId: prompt.eventId,
      status: event?.status ?? null,
    });
    return;
  }

  if (prompt.audience === "ATTENDEE") {
    await processAttendeePrompt({ prompt, event, deps, input, result, logger });
    return;
  }

  // ── PERFORMER path ──────────────────────────────────────────────────────
  // PERFORMER prompts deep-link to the venue review form; without a
  // resolvable place there is nothing to review — dead-letter.
  const place = prompt.placeId
    ? await repos.places.getById(prompt.placeId)
    : null;
  if (!place) {
    await repos.postEventPrompts.markFailed([prompt.id]);
    result.skipped += 1;
    logger?.info("postEventPrompts.dispatch.place_gone", {
      promptId: prompt.id,
      eventId: prompt.eventId,
      placeId: prompt.placeId,
    });
    return;
  }

  const base = deps.appBaseUrl.replace(/\/+$/, "");
  // placeId pins the review to the booked venue (names are not unique — a
  // name-only prefill can attach a solicited review to a duplicate stub);
  // the name keeps the venue screen human-readable.
  const reviewUrl =
    `${base}/review-a-place` +
    `?place=${encodeURIComponent(place.name)}` +
    `&placeId=${encodeURIComponent(place.id)}` +
    `&campaign=${PROMPT_CAMPAIGN}`;

  try {
    const recipient = await verifiedRecipientChannels({ prompt, deps, result, logger });
    await deps.notify({
      humanId: prompt.humanId,
      variant: PERFORMER_PROMPT_VARIANT,
      payload: {
        eventId: event.id,
        eventTitle: event.title,
        placeId: place.id,
        placeName: place.name,
        reviewUrl,
      },
      ...recipient,
      // notify() claims THIS key itself and derives the per-channel
      // `:email` / `:sms` keys internally — never pass channel-suffixed keys
      // from here (see the notify-channel idempotency incident, a3fad989).
      idempotencyKey: `post-event-prompt:${prompt.id}`,
    });
  } catch (error) {
    await handleFailure({ prompt, input, result, deps, logger, error });
    return;
  }

  await repos.postEventPrompts.markSent([prompt.id], deps.clock.now());
  result.sent += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDEE prompt processing (attendee-reviews FR-006 / FR-008)
//
// The event has already been resolved (and status-gated) by the caller. Two
// gate-open guards run before the send (see constants.ts):
//  1. Age gate — a prompt whose review window (event end +
//     ATTENDEE_REVIEW_WINDOW_DAYS) has closed is dead-lettered, not sent: the
//     form refuses it (window_closed). This drains the backlog that piled up
//     while ATTENDEE dispatch was gated.
//  2. Precedence re-check — a human who also holds a PERFORMER prompt for this
//     event gets the performer ask only.
//
// Place is OPTIONAL for attendee copy: the review form keys off the event, so
// a missing/vanished place never dead-letters an attendee prompt (only the
// venue NAME in the copy is dropped).
// ─────────────────────────────────────────────────────────────────────────────

async function processAttendeePrompt(args: {
  prompt: PostEventPromptRecord;
  event: NonNullable<
    Awaited<ReturnType<DispatchPostEventPromptsDeps["repos"]["events"]["getById"]>>
  >;
  deps: DispatchPostEventPromptsDeps;
  input: DispatchPostEventPromptsInput;
  result: DispatchPostEventPromptsOutput;
  logger: LoggerPort | undefined;
}): Promise<void> {
  const { prompt, event, deps, input, result, logger } = args;
  const { repos } = deps;

  // Guard 1 — age gate. Use endsAt ?? startsAt (same convention as the enqueue
  // sweep and the submit window).
  const eventEnd = event.endsAt ?? event.startsAt;
  const ageMs = deps.clock.now().getTime() - eventEnd.getTime();
  if (ageMs > ATTENDEE_REVIEW_WINDOW_MS) {
    await repos.postEventPrompts.markFailed([prompt.id]);
    result.expired += 1;
    logger?.info("postEventPrompts.dispatch.attendee_window_closed", {
      promptId: prompt.id,
      eventId: prompt.eventId,
      eventEnd: eventEnd.toISOString(),
    });
    return;
  }

  // Guard 2 — dispatch-time precedence re-check. Late lineup edits can create
  // both a PERFORMER and an ATTENDEE row across separate enqueue runs; the
  // enqueue-time check only covers one run's ordering, so re-check here.
  const hasPerformerPrompt = await repos.postEventPrompts.existsForAudience({
    eventId: prompt.eventId,
    humanId: prompt.humanId,
    audience: "PERFORMER",
  });
  if (hasPerformerPrompt) {
    await repos.postEventPrompts.markFailed([prompt.id]);
    result.superseded += 1;
    logger?.info("postEventPrompts.dispatch.attendee_superseded", {
      promptId: prompt.id,
      eventId: prompt.eventId,
      humanId: prompt.humanId,
    });
    return;
  }

  // Place is optional — resolve for the copy's venue name only; a missing
  // place is NOT a dead-letter (the form needs only the event).
  const place = prompt.placeId
    ? await repos.places.getById(prompt.placeId)
    : null;

  const base = deps.appBaseUrl.replace(/\/+$/, "");
  // Fixed contract with the /review-event/[eventId] web form loop.
  const reviewUrl =
    `${base}/review-event/${event.id}` +
    `?campaign=${ATTENDEE_PROMPT_CAMPAIGN}`;

  try {
    const recipient = await verifiedRecipientChannels({ prompt, deps, result, logger });
    await deps.notify({
      humanId: prompt.humanId,
      variant: ATTENDEE_PROMPT_VARIANT,
      payload: {
        eventId: event.id,
        eventTitle: event.title,
        // Omit placeName entirely when there is no resolvable place (the
        // renderer schema treats it as optional).
        ...(place ? { placeName: place.name } : {}),
        reviewUrl,
      },
      // FR-001 (attendee-prompt-delivery-hygiene): the ATTENDEE prompt is
      // IN-APP ONLY. The EMAIL half moved to the weekly digest
      // (send-attendee-review-digests) so a frequent attendee gets one email a
      // week, not one per show. Performer prompts are unaffected (in-app +
      // email). Force the email channel off here.
      channels: {
        email: { enabled: false },
        ...recipient.channels,
      },
      // notify() claims THIS key itself and derives the per-channel
      // `:email` / `:sms` keys internally — never pass channel-suffixed keys
      // from here (see the notify-channel idempotency incident, a3fad989).
      idempotencyKey: `post-event-prompt:${prompt.id}`,
    });
  } catch (error) {
    await handleFailure({ prompt, input, result, deps, logger, error });
    return;
  }

  await repos.postEventPrompts.markSent([prompt.id], deps.clock.now());
  result.sent += 1;
}

/**
 * B2 (owner ruling 2026-10-16): prompt recipients are found through tickets
 * and lineup rows, which attach BY EMAIL, so an unverified account may be a
 * squatter's. In-app and push go only to an account that proved its inbox:
 * for any other account this returns the email-only override (and notify()'s
 * email leg skips an unverified address itself). That prompt still settles,
 * counted in `suppressedUnverified`; verifying later does not resend it.
 *
 * A FAILED lookup is ERROR-logged, reported, and THROWN: called inside the
 * send's try, it lands in `handleFailure` (attempt charged, dead-lettered at
 * maxAttempts), so a DB blip retries the prompt instead of settling it with
 * nothing sent.
 */
async function verifiedRecipientChannels(args: {
  prompt: PostEventPromptRecord;
  deps: DispatchPostEventPromptsDeps;
  result: DispatchPostEventPromptsOutput;
  logger: LoggerPort | undefined;
}): Promise<ReturnType<typeof channelsForRecipient>> {
  const { prompt, deps, result, logger } = args;
  const lookup: { error?: unknown } = {};
  const verified = await loadVerifiedRecipientIds({
    humans: deps.repos.humans,
    humanIds: [prompt.humanId],
    onLookupFailed: (error) => {
      lookup.error = error ?? new Error("verified lookup failed");
      logger?.error("postEventPrompts.dispatch.verified_lookup_failed", {
        promptId: prompt.id,
        eventId: prompt.eventId,
        error: describeError(error),
      });
      deps.reportError?.(error, {
        tags: {
          useCase: "dispatchPostEventPrompts",
          reason: "verified-lookup-failed",
        },
        extra: { promptId: prompt.id, eventId: prompt.eventId },
      });
    },
  });
  if (lookup.error !== undefined) throw lookup.error;
  const override = channelsForRecipient(verified, prompt.humanId);
  if (override.channels) {
    result.suppressedUnverified += 1;
    logger?.info("postEventPrompts.dispatch.in_app_withheld_unverified", {
      promptId: prompt.id,
      eventId: prompt.eventId,
      audience: prompt.audience,
    });
  }
  return override;
}

/**
 * Records a failed send: always bumps `attempts`, and dead-letters (marks
 * FAILED) once the prompt reaches `maxAttempts` so a permanently bad prompt
 * can't retry forever. The notify idempotency key dedupes a retried send
 * only within notify's idempotency TTL (~60s) — a crash between a landed
 * notify and markSent, retried on the next daily run, re-sends. Same
 * at-least-once semantics as the rsvp-notices outbox.
 */
async function handleFailure(args: {
  prompt: PostEventPromptRecord;
  input: DispatchPostEventPromptsInput;
  result: DispatchPostEventPromptsOutput;
  deps: DispatchPostEventPromptsDeps;
  logger: LoggerPort | undefined;
  error: unknown;
}): Promise<void> {
  const { prompt, input, result, deps, logger, error } = args;

  await deps.repos.postEventPrompts.incrementAttempts([prompt.id]);
  const attempts = prompt.attempts + 1;

  if (attempts >= input.maxAttempts) {
    await deps.repos.postEventPrompts.markFailed([prompt.id]);
    result.deadLettered += 1;
    // Dead-letter drops the prompt on the floor — keep it visible in Sentry
    // (Sentry convention: swallow branches report, not just log).
    logger?.error("postEventPrompts.dispatch.dead_letter", {
      err: error,
      promptId: prompt.id,
      eventId: prompt.eventId,
      humanId: prompt.humanId,
      attempts,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "dispatchPostEventPrompts",
          promptId: prompt.id,
          outcome: "dead_letter",
        },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return;
  }

  logger?.warn("postEventPrompts.dispatch.retry", {
    promptId: prompt.id,
    eventId: prompt.eventId,
    humanId: prompt.humanId,
    attempts,
    error: describeError(error),
  });
}
