import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import { BOOKING_LINEUP_REMOVED_VARIANT } from "../comms/booking-lineup-notice-renderers";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  BILL_NOTICE_VENUE_FALLBACK,
  clipNoticeName,
  reportNoticeFailure,
  resolveActNoticeRecipients,
  resolveNoticeGroupName,
  resolveNoticeSenderName,
  type BillNoticeRecipient,
} from "./_shared/bill-notice-support";

// ─────────────────────────────────────────────────────────────────────────────
// "You're off the bill" (lineup-booking-requests v3, L5 / FR-009 /
// FR-012c): the sender took an act that had JOINED off the bill. One notice
// to that act — the person, or the group's editors (minus the sender's
// acting human). In-app + email, category "Bills you're on" (mutable per
// channel). Invited acts that are removed hear nothing (they never said
// yes); by-name acts have nobody to tell; a passed act is already off.
//
// Post-commit and best-effort: fired by `editBookingRequestBill` after its
// transaction, wrapped there in its own swallow; inside, each recipient is
// isolated so one failed send does not block the rest.
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant — registered from comms/booking-lineup-notice-renderers.ts. */
export { BOOKING_LINEUP_REMOVED_VARIANT };

/**
 * Per (request, act, recipient, removal): an act can be removed, put back,
 * join again and be removed again — each removal is its own notice, keyed by
 * the row's `removedAt` epoch.
 */
export function bookingLineupRemovedIdempotencyKey(args: {
  bookingRequestId: string;
  actId: string;
  humanId: string;
  removedAt: Date;
}): string {
  return `booking-lineup-removed:${args.bookingRequestId}:${args.actId}:${args.humanId}:${args.removedAt.getTime()}`;
}

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingLineupRemovedDeps = {
  repos: Pick<Repos, "humans" | "organizations">;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Per-recipient swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
};

export type NotifyBookingLineupRemovedArgs = {
  bookingRequest: BookingRequestRecord;
  /**
   * The removed acts that had JOINED (CONFIRMED TAGGED rows, as the edit
   * wrote them — `removedAt` set). Anything else is ignored here.
   */
  acts: readonly BookingRequestActRecord[];
  /** The sender's acting human — skipped in a group's fan-out. */
  actorHumanId?: string | null;
};

/** Hook injected into `editBookingRequestBill` (composed by the transport). */
export type NotifyBookingLineupRemovedFn = (
  args: NotifyBookingLineupRemovedArgs,
) => Promise<void>;

export async function notifyBookingLineupRemoved(
  deps: NotifyBookingLineupRemovedDeps,
  args: NotifyBookingLineupRemovedArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyBookingLineupRemoved" });
  const acts = args.acts.filter(
    (act) =>
      act.source === "TAGGED" &&
      act.confirmation === "CONFIRMED" &&
      act.removedAt !== null &&
      act.actOwnerId !== null,
  );
  if (acts.length === 0) return;
  const request = args.bookingRequest;

  const senderName = await resolveNoticeSenderName(deps.repos, request);
  const venueName = clipNoticeName(request.placeName, BILL_NOTICE_VENUE_FALLBACK);

  for (const act of acts) {
    let recipients: BillNoticeRecipient[];
    let asGroupName: string | null;
    try {
      [recipients, asGroupName] = await Promise.all([
        resolveActNoticeRecipients(deps, act, args.actorHumanId),
        resolveNoticeGroupName(deps.repos, act),
      ]);
    } catch (error) {
      reportNoticeFailure(
        { logger, reportError: deps.reportError },
        error,
        "booking_requests.notify_lineup_removed.recipients_failed",
        {
          useCase: "notifyBookingLineupRemoved",
          step: "recipients",
          extra: { bookingRequestId: request.id, actId: act.id },
        },
      );
      continue;
    }

    for (const recipient of recipients) {
      try {
        await deps.notify({
          humanId: recipient.humanId,
          variant: BOOKING_LINEUP_REMOVED_VARIANT,
          idempotencyKey: bookingLineupRemovedIdempotencyKey({
            bookingRequestId: request.id,
            actId: act.id,
            humanId: recipient.humanId,
            removedAt: act.removedAt as Date,
          }),
          payload: {
            bookingRequestId: request.id,
            actId: act.id,
            humanId: recipient.humanId,
            senderName,
            venueName,
            ...(asGroupName ? { asGroupName } : {}),
            ...(request.preferredDates.length > 0
              ? { preferredDates: request.preferredDates }
              : {}),
          },
          // In-app + email (L8 / FR-012); the renderer carries no push or
          // SMS payload, and both are off here as well.
          channels: { sms: { enabled: false }, push: { enabled: false } },
        });
      } catch (error) {
        reportNoticeFailure(
          { logger, reportError: deps.reportError },
          error,
          "booking_requests.notify_lineup_removed.recipient_failed",
          {
            useCase: "notifyBookingLineupRemoved",
            extra: {
              bookingRequestId: request.id,
              actId: act.id,
              humanId: recipient.humanId,
              viaOrgId: recipient.viaOrgId,
            },
          },
        );
      }
    }
  }
}
