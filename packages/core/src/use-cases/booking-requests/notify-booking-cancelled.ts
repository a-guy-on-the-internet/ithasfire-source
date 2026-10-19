import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { describeError } from "../../lib/io";
import { normalizeCancellerSide } from "../../lib/legacy-place-values";
import { resolvePerformerActName } from "./_shared/act-name";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  resolveBookingThreadRecipients,
  type BookingThreadRecipient,
} from "./notify-booking-request-message";

// ─────────────────────────────────────────────────────────────────────────────
// "The booking was cancelled" (booking-the-night N13 / FR-009; review W4):
// BOTH sides of a booking hear that its night was cancelled — in-app, email
// and push (transactional, so each channel follows the recipient's
// preferences) — with the canceller's reason, through one variant,
// `booking.booking-cancelled`:
//
//   · the VENUE side: the place's human owners and its owning orgs'
//     edit-role members, each with their booking-inbox link;
//   · the SENDER side: the human act, or the act org's edit-role members.
//
// The canceller is never told about their own cancel. The joined acts on the
// bill hear separately (lineup v3 L7 — no reason). Ticket buyers hear through
// cancelEvent's change-notice outbox.
//
// Post-commit and best-effort: the CALLER swallows + reports a thrown
// failure (`fireBookingCancelled`); each recipient is isolated here.
// Per-recipient key `booking-cancelled:${requestId}:${holdId}:${humanId}` —
// a booked night is cancelled once.
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_CANCELLED_VARIANT = "booking.booking-cancelled";

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingCancelledDeps = {
  repos: Pick<
    Repos,
    | "humans"
    | "organizations"
    | "entityPages"
    | "places"
    | "performerBookingDefaults"
  >;
  notify: NotifyFn;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /** Base web URL for the thread links. Required (the caller's swallow reports). */
  publicAppUrl?: string | null;
};

export type NotifyBookingCancelledArgs = {
  bookingRequest: BookingRequestRecord;
  /** The released booked hold (the idempotency anchor). */
  holdId: string;
  /** The booked place-local night, `YYYY-MM-DD`. */
  night: string;
  cancelledBy: "venue" | "sender";
  reason: string;
  /** True when the booking's event was cancelled with it. */
  eventCancelled: boolean;
  actorHumanId: string;
};

export type NotifyBookingCancelledFn = (
  args: NotifyBookingCancelledArgs,
) => Promise<void>;

const NAME_MAX = 200;

export async function notifyBookingCancelled(
  deps: NotifyBookingCancelledDeps,
  args: NotifyBookingCancelledArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyBookingCancelled" });
  const request = args.bookingRequest;
  if (request.direction !== "TO_VENUE") return;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyBookingCancelled: publicAppUrl is required to build the thread links",
    );
  }

  // Every payload field resolved BEFORE any notify() claims a key.
  const cancelledByName = clip(
    args.cancelledBy === "venue"
      ? (request.placeName ?? "The place")
      : (request.actName ??
          (request.performerOwnerType && request.performerOwnerId
            ? await resolvePerformerActName(deps.repos, {
                ownerType: request.performerOwnerType,
                ownerId: request.performerOwnerId,
              })
            : "The act")),
  );
  const recipients: BookingThreadRecipient[] = [];
  const seen = new Set<string>([args.actorHumanId]);
  for (const side of ["VENUE", "PERFORMER"] as const) {
    for (const r of await resolveBookingThreadRecipients(
      deps.repos,
      logger,
      request,
      side,
      baseUrl,
    )) {
      if (seen.has(r.humanId)) continue;
      seen.add(r.humanId);
      recipients.push(r);
    }
  }

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: BOOKING_CANCELLED_VARIANT,
        idempotencyKey: `booking-cancelled:${request.id}:${args.holdId}:${recipient.humanId}`,
        payload: {
          bookingRequestId: request.id,
          cancelledByName,
          // Stored with the in-app row (templateVariables): the new spelling.
          cancelledBy: normalizeCancellerSide(args.cancelledBy),
          date: args.night,
          reason: args.reason,
          eventCancelled: args.eventCancelled,
          targetUrl: recipient.threadUrl,
        },
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_booking_cancelled.recipient_failed", {
        bookingRequestId: request.id,
        humanId: recipient.humanId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingCancelled" },
          extra: { bookingRequestId: request.id, humanId: recipient.humanId },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
  }
}

/**
 * Cancel booking's one call site: fire the hook (when wired), post-commit,
 * inside the deliberate swallow — `logger.error` AND a guarded `reportError`
 * (CLAUDE.md ReporterPort convention). Never throws: the cancel committed.
 */
export async function fireBookingCancelled(
  deps: {
    notifyBookingCancelled?: NotifyBookingCancelledFn;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: NotifyBookingCancelledArgs,
  useCase: string,
): Promise<void> {
  if (!deps.notifyBookingCancelled) return;
  try {
    await deps.notifyBookingCancelled(args);
  } catch (error) {
    deps.logger?.error("booking_requests.notify_booking_cancelled_failed", {
      bookingRequestId: args.bookingRequest.id,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase, step: "booking_cancelled" },
        extra: { bookingRequestId: args.bookingRequest.id },
      });
    } catch {
      // Reporting is best-effort — never fail the committed cancel.
    }
  }
}

function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function clip(name: string): string {
  const trimmed = name.trim() || "Someone";
  return trimmed.length > NAME_MAX ? `${trimmed.slice(0, NAME_MAX - 1)}…` : trimmed;
}
