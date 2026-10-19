import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { getBookingRequestSender } from "@th/ports/repos/booking-requests";
import type { BookingRequestMessageRow, BookingThreadSide } from "@th/types/repos/booking-request-messages";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts) — spec FR-003 name. */
export const BOOKING_MESSAGE_RECEIVED_VARIANT = "booking.message-received";

/**
 * Org roles notified — the same bar as who can PARTICIPATE in the thread
 * (`ensureBookingThreadParticipant` requires edit roles on every org path).
 *
 * DELIBERATELY narrower than who can READ: thread reads are membership-ANY
 * (`ensureBookingThreadReader` mirrors the inbox list), but pinging every
 * viewer-role member for each message would be noise — only the people who
 * can actually reply get notified. A viewer still sees the thread when they
 * open the inbox.
 */
const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

/** Guaranteed-non-empty sender-label fallback (renderer `.min(1)` hazard —
 * see notify-booking-request-received's ACT_NAME_FALLBACK doc). */
const SENDER_LABEL_FALLBACK = "Your booking contact";

/**
 * Upper bound on the resolved sender label BEFORE the renderer schema sees
 * it: the label is assembled from stored display names (place/org/human/
 * actName) whose own caps vary, and a failing renderer parse would abort the
 * whole notification over cosmetic length.
 */
const SENDER_LABEL_MAX = 200;

/** Preview clip length for the notification body. */
const PREVIEW_MAX = 240;

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingRequestMessageDeps = {
  repos: Pick<Repos, "humans" | "organizations" | "entityPages" | "places">;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Per-recipient swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
  /** Base web URL for the thread deep links — required (caller's swallow reports). */
  publicAppUrl?: string | null;
};

export type NotifyBookingRequestMessageArgs = {
  bookingRequest: BookingRequestRecord;
  message: BookingRequestMessageRow;
  /** The side being NOTIFIED (the counterparty of the message's author). */
  recipientSide: BookingThreadSide;
};

/**
 * Caller-facing hook injected into `postBookingRequestMessage` — composed at
 * the transport/composition layer so the post use case stays decoupled from
 * the notify pipeline's deps.
 */
export type NotifyBookingRequestMessagePostedFn = (
  args: NotifyBookingRequestMessageArgs,
) => Promise<void>;

/** One person on one side of a booking thread, with their deep link. */
export type BookingThreadRecipient = { humanId: string; threadUrl: string };
type Recipient = BookingThreadRecipient;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "New message on your booking request" (booking-conversation FR-003):
 * in-app + email + push to everyone on the RECIPIENT side of the thread,
 * riding the existing notify() pipeline. Mirrors
 * notify-booking-request-received: fired post-commit by the post use case
 * inside a swallow, each recipient additionally isolated.
 *
 * Per-recipient idempotency key:
 * `booking-message:${message.id}:${humanId}` — PER-MESSAGE per FR-003;
 * notify()'s channels derive their own `{key}:email` / `{key}:sms` keys
 * from it, so a replayed dispatch can never double-send a channel.
 *
 * Recipient resolution by (direction, recipientSide):
 * - TO_VENUE     + VENUE     → the place's direct human owners + owning-org
 *   edit members → per-recipient booking-inbox link (admin slug rules mirror
 *   notify-booking-request-received).
 * - TO_PERFORMER + VENUE     → the sender ORGANIZER org's edit members →
 *   `/admin/{orgSlug}/bookings`.
 * - either       + PERFORMER → the OWNED act: the human directly
 *   (`/account/settings/booking-requests`) or the act org's edit members
 *   (`/admin/{orgSlug}/bookings`). ANONYMOUS senders are skipped — there is
 *   no reachable identity (logged, deliberately not reported: it is an
 *   expected state, not a fault).
 *
 * ANONYMOUS INQUIRERS ARE NOT THIS USE CASE'S JOB (booking-inquirer-outreach,
 * 2026-09-05). `notifyBookingInquirer` runs AHEAD of this at the composition
 * root: it mints the inquirer's shadow identity, attaches it to the request,
 * and sends the actual email through `MailerPort`. So by the time this runs,
 * the record it is handed usually resolves to that shadow humanId and the
 * anonymous skip below no longer fires.
 *
 * That is deliberate, and it does NOT make this the delivery path: notify()'s
 * email channel hard-returns `skipped: "unverified"` for a shadow identity, so
 * what actually lands here is an in-app row (+ a push to no devices) against a
 * Human nobody can sign in as — inert until the inquirer claims, at which
 * point the owner pair becomes a real account and this path carries its
 * weight. The skip branch still fires when the flip was refused (a loginable
 * address, or a dedupe collision) — see that use case's identity gate.
 */
export async function notifyBookingRequestMessage(
  deps: NotifyBookingRequestMessageDeps,
  args: NotifyBookingRequestMessageArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyBookingRequestMessage",
  });
  const { bookingRequest, message, recipientSide } = args;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "notifyBookingRequestMessage: publicAppUrl is required to build the thread link",
    );
  }

  const senderLabel = await resolveSenderLabel(deps.repos, bookingRequest, message);
  const recipients = await resolveRecipients(
    deps.repos,
    logger,
    bookingRequest,
    recipientSide,
    baseUrl,
  );

  if (recipients.length === 0) {
    // Anonymous performer side resolves to zero recipients by design (see
    // the doc above) — that path logged inside resolveRecipients at info. An
    // EMPTY venue/organizer side, however, means the thread is shouting into
    // the void; error + report (warn is not Sentry-captured).
    if (recipientSide === "VENUE") {
      logger?.error("booking_requests.notify_message.no_recipients", {
        bookingRequestId: bookingRequest.id,
        messageId: message.id,
        recipientSide,
      });
      try {
        deps.reportError?.(new Error("booking_message_notify_no_recipients"), {
          tags: { useCase: "notifyBookingRequestMessage" },
          extra: { bookingRequestId: bookingRequest.id, messageId: message.id },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
    return;
  }

  const preview =
    message.body.length > PREVIEW_MAX
      ? `${message.body.slice(0, PREVIEW_MAX).trimEnd()}…`
      : message.body;

  const payloadBase = {
    bookingRequestId: bookingRequest.id,
    messageId: message.id,
    senderLabel,
    preview,
  };

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: BOOKING_MESSAGE_RECEIVED_VARIANT,
        idempotencyKey: `booking-message:${message.id}:${recipient.humanId}`,
        payload: { ...payloadBase, threadUrl: recipient.threadUrl },
        // In-app / email / push follow preferences (transactional defaults
        // all ON). SMS out of scope — renderer emits no SMS payload; the
        // override is belt-and-braces.
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_message.recipient_failed", {
        bookingRequestId: bookingRequest.id,
        messageId: message.id,
        humanId: recipient.humanId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingRequestMessage" },
          extra: {
            bookingRequestId: bookingRequest.id,
            messageId: message.id,
            humanId: recipient.humanId,
          },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
  }
}

/** Trim trailing slashes so URL joins never emit `//admin/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who stands on one SIDE of a booking thread, with each person's deep link
 * (see the recipient rules in {@link notifyBookingRequestMessage}'s doc).
 * Shared with the Cancel booking notice (booking-the-night FR-009), which
 * tells both sides.
 */
export async function resolveBookingThreadRecipients(
  repos: NotifyBookingRequestMessageDeps["repos"],
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  recipientSide: BookingThreadSide,
  baseUrl: string,
): Promise<Recipient[]> {
  return resolveRecipients(repos, logger, request, recipientSide, baseUrl);
}

async function resolveRecipients(
  repos: NotifyBookingRequestMessageDeps["repos"],
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  recipientSide: BookingThreadSide,
  baseUrl: string,
): Promise<Recipient[]> {
  if (recipientSide === "VENUE") {
    if (request.direction === "TO_VENUE") {
      return resolveVenueRecipients(repos, request.placeId, baseUrl);
    }
    return resolveOrgEditRecipients(
      repos,
      request.organizerOrgId,
      `${baseUrl}/admin/{slug}/bookings`,
    );
  }

  // PERFORMER side.
  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") {
    // Expected state for unclaimed inquiries — no reachable identity yet.
    logger?.info("booking_requests.notify_message.anonymous_performer_skipped", {
      bookingRequestId: request.id,
    });
    return [];
  }
  if (sender.performerOwnerType === "human") {
    return [
      {
        humanId: sender.performerOwnerId,
        threadUrl: `${baseUrl}/account/settings/booking-requests`,
      },
    ];
  }
  return resolveOrgEditRecipients(
    repos,
    sender.performerOwnerId,
    `${baseUrl}/admin/{slug}/bookings`,
  );
}

/**
 * TO_VENUE venue side: direct human owners + owning-org edit members, with
 * the same per-recipient admin-slug URL rules as
 * notify-booking-request-received.
 */
async function resolveVenueRecipients(
  repos: NotifyBookingRequestMessageDeps["repos"],
  placeId: string,
  baseUrl: string,
): Promise<Recipient[]> {
  const place = await repos.places.getById(placeId);
  if (!place) return [];

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const inboxUrl = (adminSlug: string) =>
    `${baseUrl}/admin/${adminSlug}/places/${place.id}/bookings`;

  for (const humanId of place.humanIdsWithAccess) {
    if (seen.has(humanId)) continue;
    seen.add(humanId);
    const slug = await resolveHumanAdminSlug(repos, humanId);
    recipients.push({ humanId, threadUrl: inboxUrl(slug) });
  }

  for (const orgId of place.orgIdsWithAccess) {
    const org = await repos.organizations.getById(orgId);
    const orgSlug = encodeURIComponent(org?.slug || orgId);
    const orgInboxUrl = inboxUrl(orgSlug);
    for (const member of await listOrgEditMembers(repos, orgId)) {
      if (seen.has(member)) continue;
      seen.add(member);
      recipients.push({ humanId: member, threadUrl: orgInboxUrl });
    }
  }

  return recipients;
}

/**
 * Edit-role members of ONE org with a `{slug}`-templated URL (org slug rule:
 * slug, else raw id — mirrors `toOrgAdminSlug`).
 */
async function resolveOrgEditRecipients(
  repos: NotifyBookingRequestMessageDeps["repos"],
  orgId: string,
  urlTemplate: string,
): Promise<Recipient[]> {
  const org = await repos.organizations.getById(orgId);
  const slug = encodeURIComponent(org?.slug || orgId);
  const threadUrl = urlTemplate.replace("{slug}", slug);
  return (await listOrgEditMembers(repos, orgId)).map((humanId) => ({
    humanId,
    threadUrl,
  }));
}

/** Paged edit-role member walk (mirrors notify-booking-request-received). */
async function listOrgEditMembers(
  repos: NotifyBookingRequestMessageDeps["repos"],
  orgId: string,
): Promise<string[]> {
  const members: string[] = [];
  const limit = 100;
  let offset = 0;
  let total = 0;
  do {
    const page = await repos.organizations.listMembers({ orgId, limit, offset });
    total = page.total;
    for (const member of page.items) {
      if (!NOTIFY_ORG_ROLES.has(member.role)) continue;
      members.push(member.humanId);
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return members;
}

/**
 * Human admin slug — mirrors notify-booking-request-received's
 * `resolveHumanAdminSlug` (web `toHumanAdminSlug` rules).
 */
async function resolveHumanAdminSlug(
  repos: NotifyBookingRequestMessageDeps["repos"],
  humanId: string,
): Promise<string> {
  const withIdentity = await repos.humans.getByIdWithIdentity(humanId);
  const username = withIdentity?.identity.username ?? null;
  if (username) return `@${encodeURIComponent(username)}`;

  const page = await repos.entityPages.getByOwner("HUMAN", humanId);
  if (page?.slug) return `@${encodeURIComponent(page.slug)}`;

  return `@${humanId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender label
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always-non-empty "from X" label (renderer `.min(1)` hazard — a failing
 * value must fail notify() BEFORE its idempotency claim, never inside the
 * mail adapter):
 * - VENUE-authored → the venue's name (TO_VENUE) / the organizer org's name
 *   (TO_PERFORMER) — venues speak as the venue, not as individual staff;
 * - PERFORMER-authored → the act: pitch actName, else the owned sender's
 *   display name, else the anonymous contact name;
 * - SYSTEM / last resort → a neutral constant.
 *
 * Clipped to {@link SENDER_LABEL_MAX} before the renderer schema sees it.
 */
async function resolveSenderLabel(
  repos: NotifyBookingRequestMessageDeps["repos"],
  request: BookingRequestRecord,
  message: BookingRequestMessageRow,
): Promise<string> {
  const label = await resolveSenderLabelUnclipped(repos, request, message);
  const clipped = label.slice(0, SENDER_LABEL_MAX).trim();
  // A label that is ALL whitespace past the clip can't happen (sources are
  // trimmed non-empty), but the fallback keeps the `.min(1)` guarantee
  // unconditional.
  return clipped.length > 0 ? clipped : SENDER_LABEL_FALLBACK;
}

async function resolveSenderLabelUnclipped(
  repos: NotifyBookingRequestMessageDeps["repos"],
  request: BookingRequestRecord,
  message: BookingRequestMessageRow,
): Promise<string> {
  if (message.authorSide === "VENUE") {
    if (request.direction === "TO_VENUE") {
      if (request.placeName?.trim()) return request.placeName;
      const place = await repos.places.getById(request.placeId);
      if (place?.name?.trim()) return place.name;
    } else if (request.organizerOrgName?.trim()) {
      return request.organizerOrgName;
    } else {
      const org = await repos.organizations.getById(request.organizerOrgId);
      if (org?.name?.trim()) return org.name;
    }
    return SENDER_LABEL_FALLBACK;
  }

  if (message.authorSide === "PERFORMER") {
    if (request.actName?.trim()) return request.actName;
    const sender = getBookingRequestSender(request);
    if (sender.kind === "anonymous") {
      return sender.contactName.trim() || SENDER_LABEL_FALLBACK;
    }
    if (sender.performerOwnerType === "human") {
      const [human] = await repos.humans.getByIds([sender.performerOwnerId]);
      if (human?.name?.trim()) return human.name;
    } else {
      const [org] = await repos.organizations.getByIds([
        sender.performerOwnerId,
      ]);
      if (org?.name?.trim()) return org.name;
    }
  }

  return SENDER_LABEL_FALLBACK;
}
