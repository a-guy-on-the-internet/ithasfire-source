import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
  type BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { resolvePerformerActName } from "./_shared/act-name";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// "They answered your booking request" (booking-the-night N9 / FR-008).
//
// Whoever SENT a booking request hears the other side's answer, in-app,
// email and push (transactional, so each channel follows the recipient's
// preferences), through ONE variant for both directions:
//
//   · TO_VENUE     — the venue accepted, declined or (after accepting)
//                    closed the request. Recipients: the SENDER PAIR — the
//                    human act, or the act org's edit-role members. A decline
//                    or close carries the venue's reason (the sender is the
//                    party the reason is FOR; joined acts on the bill never
//                    get it — lineup v3 L7). An unclaimed embed inquiry has no
//                    on-platform sender and is skipped (its inquirer hears by
//                    email through the claim / outreach paths).
//   · TO_PERFORMER — the act accepted or declined an organiser's request.
//                    Recipients: the organiser org's edit-role members (the
//                    folded `booking.organizer-request-responded`).
//
// The acting human is never notified about their own answer. Post-commit and
// best-effort: the CALLER swallows + reports a thrown failure (ReporterPort
// convention); each recipient is additionally isolated here.
//
// Per-recipient idempotency key:
// `booking-request-responded:${requestId}:${action}:${humanId}` — a request is
// accepted once, declined once, closed once.
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts). */
export const BOOKING_REQUEST_RESPONDED_VARIANT = "booking.request-responded";

const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingRequestRespondedDeps = {
  repos: Pick<
    Repos,
    "organizations" | "performerBookingDefaults" | "entityPages" | "humans"
  >;
  notify: NotifyFn;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /** Base URL for the request / agreement links. Required. */
  publicAppUrl?: string | null;
};

export type BookingRequestResponseAction = "accepted" | "declined" | "closed";

export type NotifyBookingRequestRespondedArgs = {
  bookingRequest: BookingRequestRecord;
  action: BookingRequestResponseAction;
  /** The request's agreement, when there is one (an accept mints it). */
  agreementId: string | null;
  /** The responder's reason (decline / close); null when none was given. */
  reason: string | null;
  /** The human who answered — never told about their own answer. */
  actorHumanId: string;
};

/** The hook `respondToBookingRequest` / `closeBookingRequest` call post-commit. */
export type NotifyBookingRequestRespondedFn = (
  args: NotifyBookingRequestRespondedArgs,
) => Promise<void>;

type Recipient = { humanId: string; targetUrl: string };

export async function notifyBookingRequestResponded(
  deps: NotifyBookingRequestRespondedDeps,
  args: NotifyBookingRequestRespondedArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyBookingRequestResponded",
  });
  const { bookingRequest: request, action } = args;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyBookingRequestResponded: publicAppUrl is required to build the request link",
    );
  }

  // Resolve every payload field BEFORE any notify() call (a notify claims
  // its idempotency key; a later throw would leave a half-sent fan-out).
  let responderName: string;
  let recipients: Recipient[];
  if (request.direction === "TO_PERFORMER") {
    responderName = await resolvePerformerActName(deps.repos, {
      ownerType: request.performerOwnerType,
      ownerId: request.performerOwnerId,
    });
    const org = await deps.repos.organizations.getById(request.organizerOrgId);
    // Org admin slug rule mirrors `toOrgAdminSlug` (web): slug, else raw id.
    const orgSlug = encodeURIComponent(org?.slug || request.organizerOrgId);
    const targetUrl =
      action === "accepted" && args.agreementId
        ? `${baseUrl}/agreements/${args.agreementId}`
        : `${baseUrl}/admin/${orgSlug}/bookings`;
    recipients = (
      await resolveOrgEditMembers(deps.repos, request.organizerOrgId)
    ).map((humanId) => ({ humanId, targetUrl }));
  } else {
    const sender = getBookingRequestSender(request);
    if (sender.kind !== "owned" || isUnclaimedBookingInquiry(request)) {
      // Expected: an embed inquiry has nobody on the platform to tell.
      logger?.info("booking_requests.notify_responded.anonymous_sender_skipped", {
        bookingRequestId: request.id,
        action,
      });
      return;
    }
    responderName = clipName(request.placeName) ?? "The place";
    if (sender.performerOwnerType === "human") {
      recipients = [
        {
          humanId: sender.performerOwnerId,
          targetUrl: `${baseUrl}/account/settings/booking-requests`,
        },
      ];
    } else {
      const org = await deps.repos.organizations.getById(
        sender.performerOwnerId,
      );
      const orgSlug = encodeURIComponent(org?.slug || sender.performerOwnerId);
      const targetUrl = `${baseUrl}/admin/${orgSlug}/bookings`;
      recipients = (
        await resolveOrgEditMembers(deps.repos, sender.performerOwnerId)
      ).map((humanId) => ({ humanId, targetUrl }));
    }
  }

  recipients = recipients.filter((r) => r.humanId !== args.actorHumanId);
  if (recipients.length === 0) {
    // A sender side with nobody to tell (an org with no edit-role members
    // left): the answer reaches no one. Error + report — warn is not
    // captured (CLAUDE.md), and this is a fault, not an expected state.
    logger?.error("booking_requests.notify_responded.no_recipients", {
      bookingRequestId: request.id,
      direction: request.direction,
      action,
    });
    try {
      deps.reportError?.(new Error("booking_request_responded_no_recipients"), {
        tags: { useCase: "notifyBookingRequestResponded" },
        extra: { bookingRequestId: request.id, action },
      });
    } catch {
      // Reporting is best-effort.
    }
    return;
  }

  const reason = action === "accepted" ? null : args.reason;
  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: BOOKING_REQUEST_RESPONDED_VARIANT,
        idempotencyKey: `booking-request-responded:${request.id}:${action}:${recipient.humanId}`,
        payload: {
          bookingRequestId: request.id,
          responderName,
          action,
          ...(reason ? { reason } : {}),
          ...(action === "accepted"
            ? {
                acceptedNext:
                  request.direction === "TO_PERFORMER"
                    ? ("agreement_ready" as const)
                    : ("terms_coming" as const),
              }
            : {}),
          ...(args.agreementId ? { agreementId: args.agreementId } : {}),
          targetUrl: recipient.targetUrl,
        },
        // In-app / email / push follow the recipient's preferences; no SMS.
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_responded.recipient_failed", {
        bookingRequestId: request.id,
        humanId: recipient.humanId,
        action,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingRequestResponded" },
          extra: { bookingRequestId: request.id, humanId: recipient.humanId },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
  }
}

/** Trim trailing slashes so URL joins never emit `//agreements/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** A display name bounded for the renderer (≤ 200), or null when blank. */
function clipName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

/** Edit-role members of an org (paged + deduped). */
async function resolveOrgEditMembers(
  repos: NotifyBookingRequestRespondedDeps["repos"],
  orgId: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const recipients: string[] = [];
  const limit = 100;
  let offset = 0;
  let total = 0;
  do {
    const page = await repos.organizations.listMembers({ orgId, limit, offset });
    total = page.total;
    for (const member of page.items) {
      if (!NOTIFY_ORG_ROLES.has(member.role)) continue;
      if (seen.has(member.humanId)) continue;
      seen.add(member.humanId);
      recipients.push(member.humanId);
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return recipients;
}

/**
 * The respond / close paths' one call site: fire the hook (when wired),
 * post-commit, inside the deliberate swallow — `logger.error` AND a guarded
 * `reportError` (CLAUDE.md ReporterPort convention). Never throws: the answer
 * is already committed.
 */
export async function fireBookingRequestResponded(
  deps: {
    notifyBookingRequestResponded?: NotifyBookingRequestRespondedFn;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: NotifyBookingRequestRespondedArgs,
  useCase: string,
): Promise<void> {
  if (!deps.notifyBookingRequestResponded) return;
  try {
    await deps.notifyBookingRequestResponded(args);
  } catch (error) {
    deps.logger?.error("booking_requests.notify_responded_failed", {
      bookingRequestId: args.bookingRequest.id,
      action: args.action,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase, step: "request_responded" },
        extra: { bookingRequestId: args.bookingRequest.id, action: args.action },
      });
    } catch {
      // Reporting is best-effort — never fail the committed answer.
    }
  }
}
