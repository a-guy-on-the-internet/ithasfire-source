import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestAskRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import { describeError } from "../../../lib/io";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";
import { resolvePerformerActName } from "../_shared/act-name";
import {
  resolveBookingThreadRecipients,
  type BookingThreadRecipient,
} from "../notify-booking-request-message";

// ─────────────────────────────────────────────────────────────────────────────
// Ask notices (venue-booking-standards v1.1 FR-009b):
//
//   · `booking.ask-received` — the venue asked: every person on the SENDER
//     side (the human act, or the act org's edit-role members), in-app +
//     email, transactional;
//   · `booking.ask-answered` — the sender answered: every person on the VENUE
//     side (the place's human owners, its owning orgs' edit-role members),
//     in-app only.
//
// The actor is never told about their own action. Post-commit and
// best-effort: the CALLER swallows + reports a thrown failure
// (`fireAskNotice`); each recipient is isolated here.
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_ASK_RECEIVED_VARIANT = "booking.ask-received";
export const BOOKING_ASK_ANSWERED_VARIANT = "booking.ask-answered";

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingRequestAskDeps = {
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

export type NotifyBookingRequestAskArgs = {
  event: "asked" | "answered";
  bookingRequest: BookingRequestRecord;
  ask: BookingRequestAskRecord;
  actorHumanId: string;
};

export type NotifyBookingRequestAskFn = (
  args: NotifyBookingRequestAskArgs,
) => Promise<void>;

const NAME_MAX = 200;

export async function notifyBookingRequestAsk(
  deps: NotifyBookingRequestAskDeps,
  args: NotifyBookingRequestAskArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyBookingRequestAsk" });
  const request = args.bookingRequest;
  if (request.direction !== "TO_VENUE") return;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyBookingRequestAsk: publicAppUrl is required to build the thread links",
    );
  }

  const recipientSide = args.event === "asked" ? "PERFORMER" : "VENUE";
  const recipients: BookingThreadRecipient[] = (
    await resolveBookingThreadRecipients(
      deps.repos,
      logger,
      request,
      recipientSide,
      baseUrl,
    )
  ).filter((r) => r.humanId !== args.actorHumanId);
  if (recipients.length === 0) return;

  // Every payload field resolved BEFORE any notify() claims a key.
  const fromName =
    args.event === "asked"
      ? clip(request.placeName ?? "The place")
      : clip(
          request.actName ??
            (request.performerOwnerType && request.performerOwnerId
              ? await resolvePerformerActName(deps.repos, {
                  ownerType: request.performerOwnerType,
                  ownerId: request.performerOwnerId,
                })
              : "The act"),
        );

  for (const recipient of recipients) {
    const idempotencyKey =
      args.event === "asked"
        ? `booking-ask-received:${args.ask.id}:${recipient.humanId}`
        : `booking-ask-answered:${args.ask.id}:${args.ask.answerRevision}:${recipient.humanId}`;
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant:
          args.event === "asked"
            ? BOOKING_ASK_RECEIVED_VARIANT
            : BOOKING_ASK_ANSWERED_VARIANT,
        idempotencyKey,
        payload:
          args.event === "asked"
            ? {
                bookingRequestId: request.id,
                askId: args.ask.id,
                venueName: fromName,
                kind: args.ask.kind,
                label: args.ask.label,
                ...(args.ask.note ? { note: args.ask.note } : {}),
                targetUrl: recipient.threadUrl,
              }
            : {
                bookingRequestId: request.id,
                askId: args.ask.id,
                answeredByName: fromName,
                kind: args.ask.kind,
                label: args.ask.label,
                targetUrl: recipient.threadUrl,
              },
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_ask.recipient_failed", {
        bookingRequestId: request.id,
        askId: args.ask.id,
        humanId: recipient.humanId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingRequestAsk", event: args.event },
          extra: {
            bookingRequestId: request.id,
            askId: args.ask.id,
            humanId: recipient.humanId,
          },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
  }
}

/**
 * The ask use cases' one call site: fire the hook (when wired), post-commit,
 * inside the deliberate swallow — `logger.error` AND a guarded `reportError`
 * (CLAUDE.md ReporterPort convention). Never throws: the ask committed.
 */
export async function fireAskNotice(
  deps: {
    notifyBookingRequestAsk?: NotifyBookingRequestAskFn;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: NotifyBookingRequestAskArgs,
  useCase: string,
): Promise<void> {
  if (!deps.notifyBookingRequestAsk) return;
  try {
    await deps.notifyBookingRequestAsk(args);
  } catch (error) {
    deps.logger?.error("booking_requests.notify_ask_failed", {
      bookingRequestId: args.bookingRequest.id,
      askId: args.ask.id,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase, step: `ask_${args.event}` },
        extra: { bookingRequestId: args.bookingRequest.id, askId: args.ask.id },
      });
    } catch {
      // Reporting is best-effort — never fail the committed ask.
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
