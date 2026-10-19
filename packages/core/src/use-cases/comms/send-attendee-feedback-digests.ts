import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { NotificationDigestChannel } from "@th/ports/repos/notification-digests";
import type { ReporterPort } from "@th/ports/reporter";
import type { NotifyInput, NotifyOutput } from "./notify";

import { describeError, parseInput } from "../../lib/io";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import { renderNotification } from "./renderers";
import { fail } from "@th/errors";

const DIGEST_TYPE = "ATTENDEE_FEEDBACK" as const;
const DIGEST_CHANNEL: NotificationDigestChannel = "EMAIL";
const NOTIFICATION_VARIANT = "event.attendee-feedback-request" as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_PADDING_MS = ONE_DAY_MS;
const WINDOW_LOOKBACK_MS = 7 * ONE_DAY_MS;

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

type Logger = LoggerPort | undefined;

type TransactionScheduleResult = {
  event: {
    id: string;
    title: string;
    endsAt: Date | null;
    orgId: string | null;
    organizerName: string | null;
  };
  queued: number;
  skipped: number;
  due: Array<{
    requestId: string;
    humanId: string;
    orderId: string;
    eventId: string;
    orgId: string | null;
    eventTitle: string;
    eventEndsAt: Date | null;
    organizerName: string | null;
    sendAfter: Date;
  }>;
};

export type SendAttendeeFeedbackDigestsDeps = {
  repos: Repos;
  clock: ClockPort;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Guarded Sentry reporting for the verified-lookup swallow below. */
  reportError?: ReporterPort;
};

const sendAttendeeFeedbackDigestsInputSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

const sendAttendeeFeedbackDigestsOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    requestsQueued: z.number().int().nonnegative(),
    requestsSent: z.number().int().nonnegative(),
    requestsSkipped: z.number().int().nonnegative(),
    sendFailures: z.number().int().nonnegative(),
  })
  .strict();

export type SendAttendeeFeedbackDigestsInput = z.infer<
  typeof sendAttendeeFeedbackDigestsInputSchema
>;
export type SendAttendeeFeedbackDigestsOutput = z.infer<
  typeof sendAttendeeFeedbackDigestsOutputSchema
>;

function loadVerifiedHumanIds(
  deps: SendAttendeeFeedbackDigestsDeps,
  logger: Logger,
  eventId: string,
  humanIds: string[],
): Promise<ReadonlySet<string>> {
  return loadVerifiedRecipientIds({
    humans: deps.repos.humans,
    humanIds,
    onLookupFailed: (error) => {
      logger?.error("comms.sendAttendeeFeedbackDigests.verified_lookup_failed", {
        eventId,
        error: describeError(error),
      });
      deps.reportError?.(error, {
        tags: { area: "attendee-feedback", reason: "verified-lookup-failed" },
        extra: { eventId },
      });
    },
  });
}

export async function sendAttendeeFeedbackDigests(
  deps: SendAttendeeFeedbackDigestsDeps,
  rawInput: unknown,
): Promise<SendAttendeeFeedbackDigestsOutput> {
  const input = parseInput(sendAttendeeFeedbackDigestsInputSchema, rawInput);
  const now = deps.clock.now();
  const scopedLogger = deps.logger?.child({
    useCase: "comms.sendAttendeeFeedbackDigests",
    eventId: input.eventId,
  });

  const { event, queued, skipped, due } = await deps.repos.tx((tx) =>
    scheduleFeedbackRequests(tx, {
      eventId: input.eventId,
      now,
      logger: scopedLogger,
    }),
  );

  let sent = 0;
  let sendFailures = 0;

  // B2 (account squatting through guest checkout): the request goes to the
  // holder of a ticket, and guest checkout attaches tickets BY EMAIL, so an
  // unverified account may be someone else's. The request is an email digest
  // and still goes to the address's inbox; in-app, push and SMS go only to
  // accounts that proved theirs. A failed lookup sends email only to everyone
  // (the safe side) and is reported, rather than dropping the digests.
  const dueNow = due.filter((c) => c.sendAfter.getTime() <= now.getTime());
  const verifiedHumanIds = await loadVerifiedHumanIds(
    deps,
    scopedLogger,
    input.eventId,
    dueNow.map((c) => c.humanId),
  );

  for (const candidate of due) {
    if (candidate.sendAfter.getTime() > now.getTime()) {
      continue;
    }

    const payload = {
      eventId: candidate.eventId,
      eventTitle: candidate.eventTitle,
      eventEndsAtIso: candidate.eventEndsAt
        ? candidate.eventEndsAt.toISOString()
        : null,
      organizerName: candidate.organizerName,
      orderId: candidate.orderId,
      requestId: candidate.requestId,
    } as const;

    const scope = { kind: "EVENT", eventId: candidate.eventId } as const;

    let notifyOutput: NotifyOutput;
    try {
      notifyOutput = await deps.notify({
        humanId: candidate.humanId,
        variant: NOTIFICATION_VARIANT,
        payload,
        scope,
        idempotencyKey: candidate.requestId,
        ...channelsForRecipient(verifiedHumanIds, candidate.humanId),
      });
    } catch (error) {
      scopedLogger?.warn("comms.sendAttendeeFeedbackDigests.notify_error", {
        requestId: candidate.requestId,
        humanId: candidate.humanId,
        error: describeError(error),
      });
      sendFailures += 1;
      continue;
    }

    if (!notifyOutput.email || notifyOutput.email.status !== "sent") {
      scopedLogger?.info("comms.sendAttendeeFeedbackDigests.email_not_sent", {
        requestId: candidate.requestId,
        humanId: candidate.humanId,
        status: notifyOutput.email?.status ?? "missing",
        reason: notifyOutput.email?.reason ?? null,
      });
      sendFailures += 1;
      continue;
    }

    const sentAt = deps.clock.now();

    const fingerprint = renderNotification(NOTIFICATION_VARIANT, payload, {
      now: sentAt,
    }).fingerprint;

    const payloadHash = sha256(
      JSON.stringify({
        humanId: candidate.humanId,
        scope,
        variant: NOTIFICATION_VARIANT,
        fingerprint,
      }),
    );

    try {
      await deps.repos.notificationDigests.markFeedbackSent({
        requestId: candidate.requestId,
        sentAt,
        payloadHash,
      });

      await deps.repos.notificationDigests.recordDigestLog({
        humanId: candidate.humanId,
        orgId: candidate.orgId,
        eventId: candidate.eventId,
        digestType: DIGEST_TYPE,
        channel: DIGEST_CHANNEL,
        payloadHash,
        templateKey: NOTIFICATION_VARIANT,
        metadata: {
          requestId: candidate.requestId,
          orderId: candidate.orderId,
        },
        sentAt,
      });

      sent += 1;
    } catch (error) {
      scopedLogger?.warn(
        "comms.sendAttendeeFeedbackDigests.persistence_error",
        {
          requestId: candidate.requestId,
          humanId: candidate.humanId,
          error: describeError(error),
        },
      );
      sendFailures += 1;
    }
  }

  const output = sendAttendeeFeedbackDigestsOutputSchema.parse({
    eventId: event.id,
    requestsQueued: queued,
    requestsSent: sent,
    requestsSkipped: skipped,
    sendFailures,
  });

  scopedLogger?.info("comms.sendAttendeeFeedbackDigests.completed", {
    queued,
    sent,
    skipped,
    sendFailures,
  });

  return output;
}

async function scheduleFeedbackRequests(
  tx: TxRepos,
  input: {
    eventId: string;
    now: Date;
    logger: Logger;
  },
): Promise<TransactionScheduleResult> {
  const event = await tx.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.status !== "COMPLETED") {
    throw fail("EVENT_NOT_COMPLETED");
  }

  const referenceTime = event.endsAt ?? event.startsAt ?? input.now;
  const windowStart = new Date(referenceTime.getTime() - WINDOW_LOOKBACK_MS);
  const windowEnd = new Date(referenceTime.getTime() + WINDOW_PADDING_MS);

  const completedEvents = await tx.notificationDigests.listCompletedEventOrders(
    {
      windowStart,
      windowEnd,
    },
  );

  const target = completedEvents.find((record) => record.eventId === event.id);

  if (!target) {
    input.logger?.info("comms.sendAttendeeFeedbackDigests.no_orders", {
      eventId: event.id,
      windowStart,
      windowEnd,
    });

    return {
      event: {
        id: event.id,
        title: event.title,
        endsAt: event.endsAt,
        orgId: event.orgId,
        organizerName: null,
      },
      queued: 0,
      skipped: 0,
      due: [],
    };
  }

  let queued = 0;
  let skipped = 0;
  const due: TransactionScheduleResult["due"] = [];

  for (const attendee of target.attendees) {
    const subscription = await tx.notificationDigests.getSubscription(
      attendee.humanId,
      DIGEST_TYPE,
    );
    if (subscription && !subscription.subscribed) {
      skipped += 1;
      continue;
    }

    if (!attendee.humanEmail) {
      skipped += 1;
      continue;
    }

    const request = await tx.notificationDigests.ensureFeedbackRequest({
      eventId: target.eventId,
      orderId: attendee.orderId,
      humanId: attendee.humanId,
      channel: DIGEST_CHANNEL,
      sendAfter: attendee.sendAfter,
      metadata: {
        eventId: target.eventId,
        orderId: attendee.orderId,
        eventTitle: target.eventTitle,
      },
    });

    queued += 1;

    if (request.sendAfter.getTime() <= input.now.getTime()) {
      due.push({
        requestId: request.id,
        humanId: attendee.humanId,
        orderId: attendee.orderId,
        eventId: target.eventId,
        orgId: target.orgId,
        eventTitle: target.eventTitle,
        eventEndsAt: target.eventEndsAt,
        organizerName: target.organizerName,
        sendAfter: request.sendAfter,
      });
    }
  }

  return {
    event: {
      id: event.id,
      title: target.eventTitle,
      endsAt: target.eventEndsAt,
      orgId: target.orgId,
      organizerName: target.organizerName,
    },
    queued,
    skipped,
    due,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
