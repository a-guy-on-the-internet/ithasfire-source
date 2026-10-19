import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { getBookingRequestSender } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts). */
export const BOOKING_REQUEST_RECEIVED_VARIANT = "booking.request-received";

/**
 * Org roles notified about a new booking request — the same bar as who can
 * RESPOND to one (`respond-to-booking-request` requires `ORG_EDIT_ROLES` via
 * `requirePlaceOwnership`). Viewers/finance/scanners are deliberately not
 * spammed about inbox items they can't act on.
 */
const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

/**
 * Guaranteed-non-empty act-name fallback. `actName` must NEVER be empty: the
 * renderer schema rejects it (fails the whole notify() up front, before its
 * idempotency claim), and even a value that slipped past the renderer would
 * hit the email template's own props schema inside the mail adapter — AFTER
 * the adapter claims its derived `{key}:email`, silently losing that send.
 */
const ACT_NAME_FALLBACK = "A performer";

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingRequestReceivedDeps = {
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">;
  notify: NotifyFn;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for per-recipient delivery failures (the loop keeps
   * going — one bad recipient must not sink the rest). ReporterPort
   * convention: a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app (e.g. https://ithasfire.com) used to build the
   * absolute booking-inbox deep link. Required — without it there is no valid
   * `inboxUrl` and the whole step throws (the CALLER's swallow reports it).
   */
  publicAppUrl?: string | null;
};

export type NotifyBookingRequestReceivedArgs = {
  bookingRequest: BookingRequestRecord;
  place: Pick<
    PlaceRecord,
    "id" | "name" | "humanIdsWithAccess" | "orgIdsWithAccess"
  >;
};

/**
 * Shape of the caller-facing hook injected into `createBookingRequest` /
 * `createBookingInquiry` — composed at the transport/composition layer so the
 * create use cases stay decoupled from the notify pipeline's deps.
 */
export type NotifyBookingRequestReceivedFn = (
  args: NotifyBookingRequestReceivedArgs,
) => Promise<void>;

type Recipient = { humanId: string; inboxUrl: string };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue-side "new booking request" notification (booking-request-embed-button
 * FR-008): in-app + email + push to everyone who can act on the request —
 * direct human owners of the place AND owning-org members with edit roles
 * (OWNER / ADMIN / EDITOR, paged + deduped).
 *
 * Fired post-commit by BOTH create paths (platform `createBookingRequest` and
 * embed `createBookingInquiry`). NFR-004 posture: the CALLERS wrap this in a
 * swallow (logger.error + reportError) so a throwing notifier never fails the
 * already-committed submission; inside, each recipient is additionally
 * isolated so one failed delivery doesn't block the others.
 *
 * Per-recipient idempotency key:
 * `booking-request-received:${bookingRequestId}:${humanId}` — notify()'s
 * channels derive their own `{key}:email` / `{key}:sms` keys from it.
 *
 * The inbox deep link is per-recipient because the admin slug differs by how
 * the recipient owns the place:
 * - direct human owner → `/admin/@{username | pageSlug | humanId}/places/…`
 *   (mirrors `useEventOwnerEntities`' `toHumanAdminSlug` rules)
 * - owning-org member  → `/admin/{orgSlug | orgId}/places/…`
 *
 * SMS is explicitly disabled (out of scope per spec) — the renderer also
 * omits an SMS payload, so the channel override is belt-and-braces. In-app /
 * email / push stay preference-driven; the `transactional` category defaults
 * all three ON, so recipients get them unless they opted out.
 */
export async function notifyBookingRequestReceived(
  deps: NotifyBookingRequestReceivedDeps,
  args: NotifyBookingRequestReceivedArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyBookingRequestReceived",
  });
  const { bookingRequest, place } = args;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    // No base URL → no valid absolute inboxUrl → every per-recipient notify()
    // would fail its renderer parse. Fail the whole step once, loudly,
    // instead; the caller's swallow reports it.
    throw new Error(
      "notifyBookingRequestReceived: publicAppUrl is required to build the booking-inbox link",
    );
  }

  // Resolve everything the renderer/template needs BEFORE any notify() call.
  // A renderer-schema failure aborts notify() before its idempotency claim
  // (renderNotification runs first), but a prop that passes the renderer and
  // fails the ui-email template's own schema surfaces inside mailer.send —
  // after the mail adapter claims its derived `{key}:email` — losing that
  // email permanently. Pre-resolving valid props closes both paths.
  const sender = getBookingRequestSender(bookingRequest);
  const actName = await resolveActName(deps.repos, bookingRequest);
  const recipients = await resolveRecipients(deps.repos, place, baseUrl);

  if (recipients.length === 0) {
    // A place that accepts requests but resolves to zero notifiable owners
    // means FR-008 silently no-ops for EVERY request at that place. This is a
    // deliberate swallow (the submission already committed; we return, not
    // throw) — and warn is NOT Sentry-captured, so log at error AND report
    // per the ReporterPort convention.
    logger?.error("booking_requests.notify_received.no_recipients", {
      bookingRequestId: bookingRequest.id,
      placeId: place.id,
    });
    try {
      deps.reportError?.(new Error("booking_request_notify_no_recipients"), {
        tags: { useCase: "notifyBookingRequestReceived" },
        extra: { bookingRequestId: bookingRequest.id, placeId: place.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // no-recipients no-op into a thrown error.
    }
    return;
  }

  const payloadBase = {
    bookingRequestId: bookingRequest.id,
    placeId: place.id,
    placeName: place.name,
    actName,
    contactName: sender.kind === "anonymous" ? sender.contactName : null,
    contactEmail: sender.kind === "anonymous" ? sender.contactEmail : null,
    message: bookingRequest.message,
    ...(bookingRequest.preferredDates.length > 0
      ? { preferredDates: bookingRequest.preferredDates }
      : {}),
    source: bookingRequest.source,
  };

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: BOOKING_REQUEST_RECEIVED_VARIANT,
        idempotencyKey: `booking-request-received:${bookingRequest.id}:${recipient.humanId}`,
        payload: { ...payloadBase, inboxUrl: recipient.inboxUrl },
        // In-app / email / push follow the recipient's preferences
        // (transactional defaults: all ON). SMS is out of scope for this
        // variant (spec out_of_scope) — disabled explicitly even though the
        // renderer emits no SMS payload.
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_received.recipient_failed", {
        bookingRequestId: bookingRequest.id,
        placeId: place.id,
        humanId: recipient.humanId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingRequestReceived" },
          extra: {
            bookingRequestId: bookingRequest.id,
            placeId: place.id,
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

/** Trim trailing slashes so URL joins never emit `//admin/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Direct human owners first (their slug wins for humans who are ALSO members
 * of an owning org), then edit-role members of every owning org, paged via
 * `organizations.listMembers` (mirrors notify-payout-completed) and deduped.
 */
async function resolveRecipients(
  repos: NotifyBookingRequestReceivedDeps["repos"],
  place: NotifyBookingRequestReceivedArgs["place"],
  baseUrl: string,
): Promise<Recipient[]> {
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const inboxUrl = (adminSlug: string) =>
    `${baseUrl}/admin/${adminSlug}/places/${place.id}/bookings`;

  for (const humanId of place.humanIdsWithAccess) {
    if (seen.has(humanId)) continue;
    seen.add(humanId);
    const slug = await resolveHumanAdminSlug(repos, humanId);
    recipients.push({ humanId, inboxUrl: inboxUrl(slug) });
  }

  for (const orgId of place.orgIdsWithAccess) {
    const org = await repos.organizations.getById(orgId);
    // Org admin slug rule mirrors `toOrgAdminSlug` (web): slug, else raw id.
    const orgSlug = encodeURIComponent(org?.slug || orgId);
    const orgInboxUrl = inboxUrl(orgSlug);

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
        recipients.push({ humanId: member.humanId, inboxUrl: orgInboxUrl });
      }

      offset += page.items.length;
      if (page.items.length === 0) break;
    } while (offset < total);
  }

  return recipients;
}

/**
 * Human admin slug — mirrors the web's `toHumanAdminSlug`
 * (apps/web/src/hooks/useEventOwnerEntities.ts): `@username`, else the
 * entity page's `@slug`, else `@humanId`. The admin layout treats `@x` and
 * `%40x` as equivalent, so encoding the tail is safe either way.
 */
async function resolveHumanAdminSlug(
  repos: NotifyBookingRequestReceivedDeps["repos"],
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
// Act name resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always-non-empty display name for the requesting act (template hazard: an
 * empty `actName` would fail the email template's props schema inside the
 * mail adapter — after it claims its derived `{key}:email` idempotency key —
 * silently losing that send; the renderer schema also rejects it up front,
 * before notify()'s own claim).
 *
 * - pitch `actName` when present (both owned and anonymous rows);
 * - owned rows without one → the sender's human/org display name (same
 *   resolution as `list-booking-requests`);
 * - anonymous rows without one (schema-required, so belt-and-braces only) →
 *   the submitted contact name;
 * - last resort → a neutral constant.
 */
async function resolveActName(
  repos: NotifyBookingRequestReceivedDeps["repos"],
  record: BookingRequestRecord,
): Promise<string> {
  if (record.actName && record.actName.trim().length > 0) {
    return record.actName;
  }

  const sender = getBookingRequestSender(record);
  if (sender.kind === "anonymous") {
    return sender.contactName.trim().length > 0
      ? sender.contactName
      : ACT_NAME_FALLBACK;
  }

  if (sender.performerOwnerType === "human") {
    const [human] = await repos.humans.getByIds([sender.performerOwnerId]);
    if (human?.name && human.name.trim().length > 0) return human.name;
  } else {
    const [org] = await repos.organizations.getByIds([
      sender.performerOwnerId,
    ]);
    if (org?.name && org.name.trim().length > 0) return org.name;
  }

  return ACT_NAME_FALLBACK;
}
