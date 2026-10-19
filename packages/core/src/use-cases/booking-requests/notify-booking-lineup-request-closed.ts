import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { BOOKING_LINEUP_REQUEST_CLOSED_VARIANT } from "../comms/booking-lineup-notice-renderers";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  BILL_NOTICE_VENUE_FALLBACK,
  clipNoticeName,
  normalizeNoticeBaseUrl,
  reportNoticeFailure,
  resolveActNoticeRecipients,
  resolveNoticeGroupName,
  resolveNoticeSenderName,
  type BillNoticeRecipient,
} from "./_shared/bill-notice-support";

// ─────────────────────────────────────────────────────────────────────────────
// "The request isn't going ahead" (lineup-booking-requests v3, L7 /
// FR-012b): when a TO_VENUE request with a bill closes — the venue declines
// it, the sender withdraws it, or it expires — every act that JOINED the
// bill gets ONE notice, in-app + email, category "Bills you're on".
//
//   · JOINED only: CONFIRMED TAGGED rows still on the bill. Invited acts get
//     nothing (their invite page shows the request as closed); passed acts
//     already left; by-name acts have nobody to tell; the sender (SELF)
//     closed it or was told by the venue's own notice.
//   · NEVER the venue's decline reason — the notice carries no reason and no
//     "why" at all; only that it is not going ahead.
//   · a group is heard by its editors, minus the acting human.
//
// Post-commit and best-effort: each close path calls this after its
// transaction committed, inside its own swallow; inside, every recipient is
// isolated.
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant — registered from comms/booking-lineup-notice-renderers.ts. */
export { BOOKING_LINEUP_REQUEST_CLOSED_VARIANT };

/**
 * How the request closed — logged only, never shown (no reason reaches an
 * act). `closed` = the venue closed it after accepting (booking-the-night
 * FR-010); `booking_cancelled` = its booked night was cancelled (FR-009, the
 * request itself stays ACCEPTED as history).
 */
export type BookingLineupRequestClosedBy =
  | "declined"
  | "withdrawn"
  | "expired"
  | "closed"
  | "booking_cancelled";

/** Per (request, act, recipient): a request closes once. */
export function bookingLineupRequestClosedIdempotencyKey(args: {
  bookingRequestId: string;
  actId: string;
  humanId: string;
}): string {
  return `booking-lineup-request-closed:${args.bookingRequestId}:${args.actId}:${args.humanId}`;
}

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingLineupRequestClosedDeps = {
  repos: Pick<Repos, "bookingRequests" | "humans" | "organizations">;
  notify: NotifyFn;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /** Web origin for the invite page link (which shows the request closed). */
  publicAppUrl?: string | null;
};

export type NotifyBookingLineupRequestClosedArgs = {
  bookingRequest: BookingRequestRecord;
  closedBy: BookingLineupRequestClosedBy;
  /** Who closed it, when a person did — skipped in a group's fan-out. */
  actorHumanId?: string | null;
};

/** Hook injected into the close paths (composed by transport / jobs). */
export type NotifyBookingLineupRequestClosedFn = (
  args: NotifyBookingLineupRequestClosedArgs,
) => Promise<void>;

export async function notifyBookingLineupRequestClosed(
  deps: NotifyBookingLineupRequestClosedDeps,
  args: NotifyBookingLineupRequestClosedArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyBookingLineupRequestClosed",
  });
  const request = args.bookingRequest;
  // Only TO_VENUE requests carry a bill (NFR-004).
  if (request.direction !== "TO_VENUE") return;

  const joined = (
    await deps.repos.bookingRequests.listActsForRequests([request.id])
  ).filter(
    (act) =>
      act.source === "TAGGED" &&
      act.confirmation === "CONFIRMED" &&
      act.actOwnerId !== null,
  );
  if (joined.length === 0) return;

  const baseUrl = normalizeNoticeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    // No base URL → no valid link → every renderer parse fails. Fail the
    // step once; the caller's swallow reports it.
    throw new Error(
      "notifyBookingLineupRequestClosed: publicAppUrl is required to build the invite-page link",
    );
  }
  const targetUrl = `${baseUrl}/bookings/acts/${request.id}`;
  const senderName = await resolveNoticeSenderName(deps.repos, request);
  const venueName = clipNoticeName(request.placeName, BILL_NOTICE_VENUE_FALLBACK);

  for (const act of joined) {
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
        "booking_requests.notify_lineup_request_closed.recipients_failed",
        {
          useCase: "notifyBookingLineupRequestClosed",
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
          variant: BOOKING_LINEUP_REQUEST_CLOSED_VARIANT,
          idempotencyKey: bookingLineupRequestClosedIdempotencyKey({
            bookingRequestId: request.id,
            actId: act.id,
            humanId: recipient.humanId,
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
            targetUrl,
          },
          // In-app + email (L7); no push, no SMS.
          channels: { sms: { enabled: false }, push: { enabled: false } },
        });
      } catch (error) {
        reportNoticeFailure(
          { logger, reportError: deps.reportError },
          error,
          "booking_requests.notify_lineup_request_closed.recipient_failed",
          {
            useCase: "notifyBookingLineupRequestClosed",
            extra: {
              bookingRequestId: request.id,
              actId: act.id,
              humanId: recipient.humanId,
              viaOrgId: recipient.viaOrgId,
              closedBy: args.closedBy,
            },
          },
        );
      }
    }
  }
}

/**
 * The close paths' one call site shape: fire the hook (when wired) for a
 * request that just closed, post-commit, inside the deliberate swallow —
 * `logger.error` AND a guarded `reportError` (CLAUDE.md ReporterPort
 * convention). Never throws: the close is already committed.
 */
export async function fireBookingLineupRequestClosed(
  deps: {
    notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: NotifyBookingLineupRequestClosedArgs,
  useCase: string,
): Promise<void> {
  if (!deps.notifyBookingLineupRequestClosed) return;
  if (args.bookingRequest.direction !== "TO_VENUE") return;
  try {
    await deps.notifyBookingLineupRequestClosed(args);
  } catch (error) {
    reportNoticeFailure(
      deps,
      error,
      "booking_requests.notify_lineup_request_closed_failed",
      {
        useCase,
        step: "lineup_request_closed",
        extra: {
          bookingRequestId: args.bookingRequest.id,
          closedBy: args.closedBy,
        },
      },
    );
  }
}
