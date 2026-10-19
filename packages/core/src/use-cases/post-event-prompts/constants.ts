import type { PostEventPromptAudience } from "@th/ports/repos/post-event-prompts";

/**
 * Audiences the dispatch drain actually sends. ATTENDEE is enqueued from day
 * one (history accumulates against the (eventId, humanId, audience) unique
 * index) but deliberately NOT dispatched: its prompt deep-links to the
 * attendee review form, which ships in a later loop — never send a prompt
 * that points at a page that doesn't exist yet (attendee-reviews FR-006).
 * Enabling it later = add "ATTENDEE" here, add its notification renderer +
 * review-form URL in dispatch-post-event-prompts.ts — PLUS two gate-open
 * guards (review 2026-07-14):
 *  1. Dead-letter (or age-gate at dispatch) accumulated ATTENDEE rows whose
 *     event ended more than ATTENDEE_REVIEW_WINDOW_DAYS ago — otherwise the
 *     gate-open drains months of PENDING rows into prompts whose form will
 *     refuse them (window_closed).
 *  2. Dispatch-time precedence check: skip an ATTENDEE prompt whose human
 *     also holds a PERFORMER prompt for the same event (late lineup edits
 *     can create both rows across enqueue runs; enqueue-time precedence
 *     only covers a single run's ordering).
 */
export const DISPATCH_ENABLED_AUDIENCES = [
  "PERFORMER",
  // ATTENDEE enabled 2026-07-15 alongside the /review-event/[eventId] form.
  // Both gate-open guards from the note above are implemented in
  // dispatch-post-event-prompts.ts (processAttendeePrompt): (1) the age gate
  // dead-letters prompts whose review window has already closed, draining the
  // accumulated PENDING backlog harmlessly; (2) the dispatch-time precedence
  // re-check dead-letters an ATTENDEE prompt whose human also holds a
  // PERFORMER prompt for the same event.
  "ATTENDEE",
] as const satisfies readonly PostEventPromptAudience[];

/**
 * How far back the daily enqueue sweeps look for ended events. Wide enough
 * that a few missed job runs lose nothing (the unique index dedupes
 * overlap); narrow enough that the FIRST deploy doesn't retro-prompt the
 * whole event history.
 */
export const DEFAULT_ENQUEUE_LOOKBACK_DAYS = 14;
