import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import { BOOKING_LINEUP_ANSWERED_VARIANT } from "../comms/booking-lineup-notice-renderers";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  BILL_NOTICE_VENUE_FALLBACK,
  clipNoticeName,
  normalizeNoticeBaseUrl,
  reportNoticeFailure,
  resolveSenderNoticeRecipients,
} from "./_shared/bill-notice-support";

// ─────────────────────────────────────────────────────────────────────────────
// "{act} joined / passed on / left your bill" (lineup-booking-requests v3,
// L6 / FR-012a): when a tagged act answers, the SENDER hears it — IN-APP
// ONLY (answers come in bursts; no email, no push) and transactional. The
// venue hears nothing here: it sees the ledger lines it already may, and
// never learns about a pass.
//
// Recipients: a human sender, or an org sender's edit members minus the
// answering human (an editor of the sending org who answers for a tagged act
// is not told about their own answer). The pass reason is NOT copied here —
// it is on the sender-only ledger entry (v3 L19), where the sender reads it
// in the thread.
//
// Post-commit and best-effort: fired by the join / pass use cases after
// their transaction, wrapped there in their own swallow.
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant — registered from comms/booking-lineup-notice-renderers.ts. */
export { BOOKING_LINEUP_ANSWERED_VARIANT };

export type BookingLineupAnswer = "joined" | "passed" | "left";

/**
 * Per (request, act, recipient, answer): an act can join and later leave,
 * and a restored act can join again — each answer is its own notice, keyed
 * by the row's `respondedAt` epoch.
 */
export function bookingLineupAnsweredIdempotencyKey(args: {
  bookingRequestId: string;
  actId: string;
  humanId: string;
  answer: BookingLineupAnswer;
  respondedAt: Date;
}): string {
  return `booking-lineup-answered:${args.bookingRequestId}:${args.actId}:${args.humanId}:${args.answer}:${args.respondedAt.getTime()}`;
}

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingLineupAnsweredDeps = {
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">;
  notify: NotifyFn;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /** Web origin for the sender's bookings link. Required (else the step throws). */
  publicAppUrl?: string | null;
};

export type NotifyBookingLineupAnsweredArgs = {
  bookingRequest: BookingRequestRecord;
  /** The act's row as the answer wrote it (`respondedAt` set). */
  act: BookingRequestActRecord;
  /** The act's snapshot name — the same one the ledger entry carries. */
  actName: string;
  answer: BookingLineupAnswer;
  /** The human who answered (skipped in an org sender's fan-out). */
  actorHumanId: string;
  /**
   * Recipients told by the caller instead (a lineup leave's
   * `event.lineup-left` — `DeclineBookingRequestActOptions`). Absent = all.
   */
  skipRecipientHumanIds?: readonly string[];
};

/** Hook injected into the answer use cases (composed by the transport). */
export type NotifyBookingLineupAnsweredFn = (
  args: NotifyBookingLineupAnsweredArgs,
) => Promise<void>;

export async function notifyBookingLineupAnswered(
  deps: NotifyBookingLineupAnsweredDeps,
  args: NotifyBookingLineupAnsweredArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyBookingLineupAnswered" });
  const { bookingRequest: request, act } = args;

  const baseUrl = normalizeNoticeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyBookingLineupAnswered: publicAppUrl is required to build the sender's bookings link",
    );
  }
  const skip = new Set(args.skipRecipientHumanIds ?? []);
  const recipients = (
    await resolveSenderNoticeRecipients(
      deps,
      request,
      baseUrl,
      args.actorHumanId,
    )
  ).filter((recipient) => !skip.has(recipient.humanId));
  if (recipients.length === 0) return;

  const venueName = clipNoticeName(request.placeName, BILL_NOTICE_VENUE_FALLBACK);
  const actName = clipNoticeName(args.actName, "An artist");
  const respondedAt = act.respondedAt ?? act.updatedAt;

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: BOOKING_LINEUP_ANSWERED_VARIANT,
        idempotencyKey: bookingLineupAnsweredIdempotencyKey({
          bookingRequestId: request.id,
          actId: act.id,
          humanId: recipient.humanId,
          answer: args.answer,
          respondedAt,
        }),
        payload: {
          bookingRequestId: request.id,
          actId: act.id,
          humanId: recipient.humanId,
          actName,
          venueName,
          answer: args.answer,
          targetUrl: recipient.targetUrl,
        },
        // IN-APP ONLY (L6): the renderer carries no email / push payload,
        // and the channels are off here as well.
        channels: {
          email: { enabled: false },
          push: { enabled: false },
          sms: { enabled: false },
        },
      });
    } catch (error) {
      reportNoticeFailure(
        { logger, reportError: deps.reportError },
        error,
        "booking_requests.notify_lineup_answered.recipient_failed",
        {
          useCase: "notifyBookingLineupAnswered",
          extra: {
            bookingRequestId: request.id,
            actId: act.id,
            humanId: recipient.humanId,
            viaOrgId: recipient.viaOrgId,
            answer: args.answer,
          },
        },
      );
    }
  }
}
