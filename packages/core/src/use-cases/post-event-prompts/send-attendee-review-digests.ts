import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";
import type {
  AttendeeReviewDigestCandidate,
  NotificationDigestChannel,
} from "@th/ports/repos/notification-digests";

import { describeError, parseInput } from "../../lib/io";
import { ATTENDEE_REVIEW_WINDOW_MS } from "../attendee-reviews/constants";
import { generateReviewPromptUnsubscribeToken } from "../announcements/unsubscribe-from-audience";
import { renderAttendeeReviewDigestEmail } from "./attendee-review-digest-email";

// ─────────────────────────────────────────────────────────────────────────────
// sendAttendeeReviewDigests (attendee-prompt-delivery-hygiene FR-002/004/005/007)
//
// The WEEKLY EMAIL half of the attendee review prompt. In-app fires per-show
// via the post-event-prompts.dispatch drain (FR-001); this job replaces the
// per-show EMAIL with ONE weekly digest per human listing every un-reviewed,
// still-in-window attended show.
//
// Per human, per weekly run with pending shows (FR-004):
//   (a) if any AttendeeReview was submitted since lastDigestSentAt → reset the
//       soft suppression counter (re-engaged);
//   (b) if subscribed=false (hard opt-out) OR consecutiveIgnored >= 3 → send NO
//       email (in-app already delivered per-show);
//   (c) else send ONE digest, stamp lastDigestSentAt, increment the counter.
//
// Idempotent per (human, week) via NotificationDigestLog: the log row is
// CLAIMED before the send, so a mid-batch crash + retry never double-sends
// (NFR-003). Per-human failures isolate + report to Sentry (guarded).
//
// The email carries a one-click HMAC unsubscribe (footer link +
// List-Unsubscribe / List-Unsubscribe-Post headers) that mutes ONLY this
// human's review-prompt email (FR-005). Sent via the mailer port directly (not
// generic notify) so the List-Unsubscribe headers can be threaded through.
// ─────────────────────────────────────────────────────────────────────────────

const DIGEST_TYPE = "ATTENDEE_FEEDBACK" as const;
const DIGEST_CHANNEL: NotificationDigestChannel = "EMAIL";
const TEMPLATE_KEY = "attendee-review-digest" as const;

/** Soft auto-suppression threshold: silence email after this many unanswered digests. */
export const ATTENDEE_DIGEST_SUPPRESS_AFTER = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const sendAttendeeReviewDigestsInputSchema = z
  .object({
    /** Max humans to process per run (keeps the job bounded). */
    batchSize: z.number().int().positive().max(5000).default(500),
  })
  .strict();

export type SendAttendeeReviewDigestsInput = z.infer<
  typeof sendAttendeeReviewDigestsInputSchema
>;

export const sendAttendeeReviewDigestsOutputSchema = z
  .object({
    /** Humans with >= 1 un-reviewed in-window show examined this run. */
    candidates: z.number().int().nonnegative(),
    /** Digest emails actually sent. */
    sent: z.number().int().nonnegative(),
    /** Humans whose email was suppressed (hard opt-out OR 3-strike). */
    suppressed: z.number().int().nonnegative(),
    /** Humans skipped for a missing email address. */
    skippedNoEmail: z.number().int().nonnegative(),
    /** Humans already sent this week (idempotency short-circuit). */
    alreadySent: z.number().int().nonnegative(),
    /** Counters reset because the human reviewed since the last digest. */
    reengaged: z.number().int().nonnegative(),
    /** Per-human failures (reported, run continued). */
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type SendAttendeeReviewDigestsOutput = z.infer<
  typeof sendAttendeeReviewDigestsOutputSchema
>;

export type SendAttendeeReviewDigestsDeps = {
  repos: Pick<Repos, "notificationDigests">;
  mailer: MailerPort;
  clock: ClockPort;
  /** Public web origin used to build absolute review + unsubscribe links. */
  appBaseUrl: string;
  /** HMAC secret for the unsubscribe token (UNSUBSCRIBE_SECRET). */
  unsubscribeSecret: string;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-human failures (NFR-003). */
  reportError?: ReporterPort;
};

export async function sendAttendeeReviewDigests(
  deps: SendAttendeeReviewDigestsDeps,
  rawInput?: unknown,
): Promise<SendAttendeeReviewDigestsOutput> {
  const input = parseInput(sendAttendeeReviewDigestsInputSchema, rawInput ?? {});
  const logger = deps.logger?.child({
    useCase: "postEventPrompts.sendAttendeeReviewDigests",
  });

  const now = deps.clock.now();
  const weekKey = startOfUtcWeekKey(now);

  const candidates =
    await deps.repos.notificationDigests.listAttendeeReviewDigestCandidates({
      now,
      windowMs: ATTENDEE_REVIEW_WINDOW_MS,
      limit: input.batchSize,
    });

  const result: SendAttendeeReviewDigestsOutput = {
    candidates: candidates.length,
    sent: 0,
    suppressed: 0,
    skippedNoEmail: 0,
    alreadySent: 0,
    reengaged: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    // One bad human must never abort the batch (NFR-003).
    try {
      await processCandidate({
        candidate,
        deps,
        now,
        weekKey,
        result,
        logger,
      });
    } catch (error) {
      result.failed += 1;
      logger?.error(
        "postEventPrompts.sendAttendeeReviewDigests.human_failed",
        {
          err: error,
          humanId: candidate.humanId,
          error: describeError(error),
        },
      );
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "sendAttendeeReviewDigests",
            humanId: candidate.humanId,
          },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  logger?.info("postEventPrompts.sendAttendeeReviewDigests.completed", result);

  return sendAttendeeReviewDigestsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-human processing (FR-004 suppression/reset ladder)
// ─────────────────────────────────────────────────────────────────────────────

async function processCandidate(args: {
  candidate: AttendeeReviewDigestCandidate;
  deps: SendAttendeeReviewDigestsDeps;
  now: Date;
  weekKey: string;
  result: SendAttendeeReviewDigestsOutput;
  logger: LoggerPort | undefined;
}): Promise<void> {
  const { candidate, deps, now, weekKey, result, logger } = args;
  const repo = deps.repos.notificationDigests;

  const subscription = await repo.getSubscription(
    candidate.humanId,
    DIGEST_TYPE,
  );

  // FR-004a — re-engagement reset. If the human reviewed anything since the
  // last digest we sent, wipe the soft counter and treat them as fresh.
  let effectiveCounter = subscription?.consecutiveIgnored ?? 0;
  if (subscription?.lastDigestSentAt) {
    const reviewedSince = await repo.hasAttendeeReviewSince({
      humanId: candidate.humanId,
      since: subscription.lastDigestSentAt,
    });
    if (reviewedSince && effectiveCounter > 0) {
      await repo.resetConsecutiveIgnored({
        humanId: candidate.humanId,
        digestType: DIGEST_TYPE,
      });
      effectiveCounter = 0;
      result.reengaged += 1;
    }
  }

  // FR-004b — suppression. Hard opt-out (user chose) OR 3-strike soft
  // suppression. In-app is NEVER suppressed here (it ships per-show elsewhere).
  const hardOptOut = subscription?.subscribed === false;
  if (hardOptOut || effectiveCounter >= ATTENDEE_DIGEST_SUPPRESS_AFTER) {
    result.suppressed += 1;
    return;
  }

  if (!candidate.humanEmail) {
    result.skippedNoEmail += 1;
    return;
  }

  // Idempotency per (human, week). Claim the log row BEFORE sending so a retry
  // after a mid-batch crash finds the claim and never double-sends (NFR-003).
  const payloadHash = sha256(
    JSON.stringify({
      digestType: DIGEST_TYPE,
      humanId: candidate.humanId,
      weekKey,
    }),
  );

  const existing = await repo.findDigestLogByHash({
    digestType: DIGEST_TYPE,
    channel: DIGEST_CHANNEL,
    payloadHash,
  });
  if (existing) {
    result.alreadySent += 1;
    return;
  }

  try {
    await repo.recordDigestLog({
      humanId: candidate.humanId,
      digestType: DIGEST_TYPE,
      channel: DIGEST_CHANNEL,
      payloadHash,
      templateKey: TEMPLATE_KEY,
      metadata: { weekKey, showCount: candidate.shows.length },
      sentAt: now,
    });
  } catch (error) {
    // A concurrent run claimed the same (human, week) first (unique index).
    // Treat as already sent — never double-send.
    result.alreadySent += 1;
    logger?.info(
      "postEventPrompts.sendAttendeeReviewDigests.claim_conflict",
      {
        humanId: candidate.humanId,
        weekKey,
        error: describeError(error),
      },
    );
    return;
  }

  const base = deps.appBaseUrl.replace(/\/+$/, "");
  const token = generateReviewPromptUnsubscribeToken(
    deps.unsubscribeSecret,
    candidate.humanId,
    candidate.humanEmail,
  );
  const unsubscribeUrl =
    `${base}/unsubscribe?kind=review-prompts` +
    `&humanId=${encodeURIComponent(candidate.humanId)}` +
    `&email=${encodeURIComponent(candidate.humanEmail)}` +
    `&token=${token}`;

  const email = renderAttendeeReviewDigestEmail({
    recipientName: candidate.humanName,
    shows: candidate.shows.map((show) => ({
      eventTitle: show.eventTitle,
      placeName: show.placeName,
      reviewUrl:
        `${base}/review-event/${show.eventId}` +
        `?campaign=attendee-review-digest`,
    })),
    unsubscribeUrl,
  });

  await deps.mailer.send({
    to: {
      to: candidate.humanEmail,
      name: candidate.humanName ?? undefined,
    },
    subject: email.subject,
    text: email.text,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    metadata: {
      source: "attendee-review-digest",
      humanId: candidate.humanId,
    },
    tags: ["attendee-review-digest"],
    // Belt-and-braces dedupe at the mailer boundary too.
    idempotencyKey: `review-digest:${candidate.humanId}:${weekKey}`,
  });

  // FR-004c — the send counts as one unanswered strike (reset later on review).
  await repo.recordDigestSent({
    humanId: candidate.humanId,
    digestType: DIGEST_TYPE,
    sentAt: now,
  });

  result.sent += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * ISO date (YYYY-MM-DD) of the Monday starting the UTC week `now` falls in.
 * Stable week bucket for (human, week) idempotency: a weekly cron always lands
 * in a distinct bucket run-to-run, while a same-week re-run collides.
 */
export function startOfUtcWeekKey(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay: 0=Sun..6=Sat. Shift so Monday is the week start.
  const dayFromMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dayFromMonday * DAY_MS);
  return monday.toISOString().slice(0, 10);
}
