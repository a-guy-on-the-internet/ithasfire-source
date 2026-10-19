import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { ToPerformerBookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts). */
export const ORGANIZER_BOOKING_REQUEST_RECEIVED_VARIANT =
  "booking.organizer-request-received";

/**
 * Org-act roles notified about an incoming organizer request — the same bar
 * as who can RESPOND to one (`respond-to-booking-request` requires
 * ORG_EDIT_ROLES on the act org). Mirrors notify-booking-request-received.
 */
const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

/**
 * Guaranteed-non-empty sender fallback — the renderer schema rejects an
 * empty orgName BEFORE notify()'s idempotency claim, and a value that
 * slipped past it would die inside the mail adapter AFTER the derived
 * `{key}:email` claim, silently losing that send (documented hazard —
 * resolve template inputs before any claim).
 */
const ORG_NAME_FALLBACK = "An organizer";

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyOrganizerBookingRequestReceivedDeps = {
  repos: Pick<Repos, "organizations">;
  notify: NotifyFn;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for per-recipient delivery failures (the loop keeps
   * going — one bad recipient must not sink the rest). ReporterPort
   * convention: a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app used to build the absolute "requests to you"
   * deep link. Required — without it the whole step throws (the CALLER's
   * swallow reports it).
   */
  publicAppUrl?: string | null;
};

export type NotifyOrganizerBookingRequestReceivedArgs = {
  bookingRequest: ToPerformerBookingRequestRecord;
};

/**
 * Shape of the caller-facing hook injected into
 * `createOrganizerBookingRequest` — composed at the transport layer so the
 * create use case stays decoupled from the notify pipeline's deps.
 */
export type NotifyOrganizerBookingRequestReceivedFn = (
  args: NotifyOrganizerBookingRequestReceivedArgs,
) => Promise<void>;

type Recipient = { humanId: string; requestsUrl: string };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Act-side "an organizer wants to book you" notification
 * (organizer-booking-requests FR-006), fired post-commit by
 * `createOrganizerBookingRequest`. In-app + email + push (SMS out of scope);
 * recipients are the target act itself:
 * - HUMAN act → that human;
 * - ORG act → its ORG_EDIT_ROLES members (paged + deduped) — the people who
 *   can respond.
 *
 * Per-recipient idempotency key:
 * `organizer-booking-request-received:${bookingRequestId}:${humanId}` —
 * notify()'s channels derive their own `{key}:email` / `{key}:sms` keys.
 *
 * The deep link targets the "Requests to you" list (FR-007): account
 * settings for a human act, org settings for an org act.
 *
 * NFR-004 posture mirrors notify-booking-request-received: the CALLER wraps
 * this in a swallow (logger.error + reportError); each recipient is
 * additionally isolated here.
 */
export async function notifyOrganizerBookingRequestReceived(
  deps: NotifyOrganizerBookingRequestReceivedDeps,
  args: NotifyOrganizerBookingRequestReceivedArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyOrganizerBookingRequestReceived",
  });
  const { bookingRequest } = args;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyOrganizerBookingRequestReceived: publicAppUrl is required to build the requests link",
    );
  }

  // Resolve everything the renderer/template needs BEFORE any notify() call
  // (idempotency-claim hazard — see the constant docs above).
  const orgName = await resolveOrgName(
    deps.repos,
    bookingRequest.organizerOrgId,
    bookingRequest.organizerOrgName,
  );
  const recipients = await resolveRecipients(deps.repos, bookingRequest, baseUrl);

  if (recipients.length === 0) {
    // An opted-in act resolving to zero notifiable recipients means FR-006
    // silently no-ops for every request to it. Deliberate swallow (the
    // request already committed) — error-log AND report so it stays visible.
    logger?.error("booking_requests.notify_organizer_received.no_recipients", {
      bookingRequestId: bookingRequest.id,
      organizerOrgId: bookingRequest.organizerOrgId,
    });
    try {
      deps.reportError?.(
        new Error("organizer_booking_request_notify_no_recipients"),
        {
          tags: { useCase: "notifyOrganizerBookingRequestReceived" },
          extra: {
            bookingRequestId: bookingRequest.id,
            organizerOrgId: bookingRequest.organizerOrgId,
          },
        },
      );
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // no-recipients no-op into a thrown error.
    }
    return;
  }

  const payloadBase = {
    bookingRequestId: bookingRequest.id,
    orgName,
    message: bookingRequest.message,
    ...(bookingRequest.preferredDates.length > 0
      ? { preferredDates: bookingRequest.preferredDates }
      : {}),
    ...(bookingRequest.attachedEventTitle
      ? { attachedEventTitle: bookingRequest.attachedEventTitle }
      : {}),
  };

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: ORGANIZER_BOOKING_REQUEST_RECEIVED_VARIANT,
        idempotencyKey: `organizer-booking-request-received:${bookingRequest.id}:${recipient.humanId}`,
        payload: { ...payloadBase, requestsUrl: recipient.requestsUrl },
        // In-app / email / push follow preferences (transactional defaults:
        // all ON). SMS is out of scope for this variant (spec out_of_scope).
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error(
        "booking_requests.notify_organizer_received.recipient_failed",
        {
          bookingRequestId: bookingRequest.id,
          humanId: recipient.humanId,
          err: error,
          error: describeError(error),
        },
      );
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyOrganizerBookingRequestReceived" },
          extra: {
            bookingRequestId: bookingRequest.id,
            humanId: recipient.humanId,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // per-recipient swallow into a thrown error.
      }
    }
  }
}

/** Trim trailing slashes so URL joins never emit `//account/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function resolveOrgName(
  repos: NotifyOrganizerBookingRequestReceivedDeps["repos"],
  organizerOrgId: string,
  denormalizedName: string | null,
): Promise<string> {
  if (denormalizedName && denormalizedName.trim().length > 0) {
    return denormalizedName;
  }
  const org = await repos.organizations.getById(organizerOrgId);
  const name = org?.name?.trim();
  return name && name.length > 0 ? name : ORG_NAME_FALLBACK;
}

/**
 * The act's own people: the human act itself, or the org act's edit-role
 * members (paged via `organizations.listMembers`, mirroring
 * notify-booking-request-received).
 */
async function resolveRecipients(
  repos: NotifyOrganizerBookingRequestReceivedDeps["repos"],
  bookingRequest: ToPerformerBookingRequestRecord,
  baseUrl: string,
): Promise<Recipient[]> {
  if (bookingRequest.performerOwnerType === "human") {
    return [
      {
        humanId: bookingRequest.performerOwnerId,
        // Human "Requests to you" list lives in account settings (FR-007).
        // Account settings is one route per section now, so deep-link the
        // inbox itself — the bare `/account/settings` renders Profile (and on
        // mobile, just the section index), which is a dead end for an email
        // whose whole job is "you have a request waiting".
        requestsUrl: `${baseUrl}/account/settings/booking-requests`,
      },
    ];
  }

  const orgId = bookingRequest.performerOwnerId;
  const org = await repos.organizations.getById(orgId);
  // Org admin slug rule mirrors `toOrgAdminSlug` (web): slug, else raw id.
  const orgSlug = encodeURIComponent(org?.slug || orgId);
  // Deep-link the org's inbox, for the same reason the human branch above
  // deep-links its own: this email's whole job is "you have a request
  // waiting", so it must not land on an index.
  //
  // This used to point at `/admin/<slug>/settings`, which was already a dead
  // end (settings renders General) but at least put the reader one rail click
  // from "Booking requests". booking-inbox-placement moved that inbox to
  // /bookings and removed the settings section — so the old target became a
  // page with NO route to the thing the email is about. Matches the sibling
  // notifications: `notify-booking-request-received` deep-links the place
  // inbox, `notify-booking-request-responded` (organiser side) already uses
  // this exact URL.
  const requestsUrl = `${baseUrl}/admin/${orgSlug}/bookings`;

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const limit = 100;
  let offset = 0;
  let total = 0;
  do {
    const page = await repos.organizations.listMembers({
      orgId,
      limit,
      offset,
    });
    total = page.total;

    for (const member of page.items) {
      if (!NOTIFY_ORG_ROLES.has(member.role)) continue;
      if (seen.has(member.humanId)) continue;
      seen.add(member.humanId);
      recipients.push({ humanId: member.humanId, requestsUrl });
    }

    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);

  return recipients;
}
