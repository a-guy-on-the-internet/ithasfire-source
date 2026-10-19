import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";

import { trimTrailingSlash } from "../../../lib/url";

// ─────────────────────────────────────────────────────────────────────────────
// Invite-to-claim email (booking-request-embed-button FR-007, NFR-004)
//
// Shared by respond-to-booking-request (anonymous accept) and
// resend-booking-request-invite. Always POST-COMMIT and best-effort: the
// accept/rotation is durably committed before this runs, and a mail failure
// must never fail the mutation (the inbox gets a resend affordance).
// Deliberate swallow → logger.error + guarded ReporterPort, per the Sentry
// convention.
// ─────────────────────────────────────────────────────────────────────────────

export type SendClaimInviteEmailDeps = {
  /** Optional at the type level; missing at send time is a reported failure. */
  mailer?: MailerPort;
  /**
   * Base web URL for the claim link. Optional at the type level so existing
   * composition roots keep compiling, but the anonymous fork REQUIRES it —
   * missing config is reported through the same swallow (the accept itself
   * still succeeds).
   */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type SendClaimInviteEmailArgs = {
  /** Tag for the report/log so the two call sites stay distinguishable. */
  useCase: "respondToBookingRequest" | "resendBookingRequestInvite";
  bookingRequestId: string;
  placeId: string;
  placeName: string;
  actName: string | null;
  /** Anonymous submitter's address (lowercased at rest). */
  contactEmail: string;
  /** RAW token — appears only in the claim link. Never logged/persisted. */
  rawToken: string;
  claimTokenExpiresAt: Date;
};

/** Build the claim URL the invite email links to (step-6 landing route). */
export function buildClaimUrl(publicAppUrl: string, rawToken: string): string {
  return `${trimTrailingSlash(publicAppUrl)}/booking-requests/claim/${rawToken}`;
}

/**
 * Send the `booking.invite_to_claim` email directly through MailerPort — the
 * anonymous submitter has no humanId, so the notify() pipeline is unusable
 * here. Never throws.
 *
 * Mailer-level idempotency key includes the token GENERATION (the rotation's
 * fresh `claimTokenExpiresAt` timestamp), so a RESEND with a new token is not
 * deduped away by the original accept's send.
 */
export async function sendClaimInviteEmail(
  deps: SendClaimInviteEmailDeps,
  args: SendClaimInviteEmailArgs,
): Promise<void> {
  try {
    if (!deps.mailer) {
      throw new Error("booking_invite_mailer_not_configured");
    }
    if (!deps.publicAppUrl) {
      throw new Error("booking_invite_public_app_url_missing");
    }

    await deps.mailer.send({
      to: { to: args.contactEmail },
      template: {
        key: "booking.invite_to_claim",
        variables: {
          placeName: args.placeName,
          actName: args.actName,
          claimUrl: buildClaimUrl(deps.publicAppUrl, args.rawToken),
          expiresAtISO: args.claimTokenExpiresAt.toISOString(),
        },
      },
      idempotencyKey: `booking-invite:${args.bookingRequestId}:${args.claimTokenExpiresAt.getTime()}`,
    });

    deps.logger?.info("booking_requests.invite_email_sent", {
      bookingRequestId: args.bookingRequestId,
      placeId: args.placeId,
    });
  } catch (error) {
    // NFR-004: the accept/rotation is already committed — swallow, but keep
    // the failure visible (log AND report; raw token deliberately excluded).
    deps.logger?.error("booking_requests.invite_email_failed", {
      bookingRequestId: args.bookingRequestId,
      placeId: args.placeId,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: args.useCase },
        extra: {
          bookingRequestId: args.bookingRequestId,
          placeId: args.placeId,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // committed mutation.
    }
  }
}
