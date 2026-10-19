import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { describeError } from "../../lib/io";
import { listOrgEditMembers } from "../booking-holds/notify-booking-hold-intents";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  lookupPerformerDisplayName,
  performerOwnerKey,
  resolvePerformerDisplayNames,
} from "./_shared/performer-display-names";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts). */
export const BOOKING_LINEUP_INVITED_VARIANT = "booking.lineup-invited";

/**
 * Last-resort sender name. `senderName` must never be empty: the renderer
 * schema rejects it (failing notify() before its idempotency claim), and the
 * email template's own props schema would reject it later, AFTER the mail
 * adapter claims its derived `{key}:email` — losing that send silently.
 */
const SENDER_NAME_FALLBACK = "Someone";

/** Last-resort venue name, for the same reason. */
const VENUE_NAME_FALLBACK = "a place";

/** The renderer's name bound — clipped here so a long name can't fail the parse. */
const NAME_MAX_LENGTH = 200;

/**
 * Per (request, act, recipient, invite generation) — FR-007: one invite per
 * tagged act per recipient per request, per time the act is ASKED. A tagged
 * PERSON is both the act and the recipient, so their first-invite key keeps
 * its v2 shape `…:{request}:{human}` (a re-send after deploy must not
 * double-invite). A tagged GROUP (v3 L17) is answered by any of its editors,
 * so each editor gets one: `…:{request}:org:{org}:{human}`.
 *
 * `generation` (v3 FR-009): an act the sender took off the bill and put back
 * is asked AGAIN (restore returns it to PENDING), so the re-invite must not
 * collide with the first one — it carries the row's fresh `invitedAt` epoch
 * as `…:g{epoch}`. Absent for a first invite, which keeps the v2 key.
 */
export function bookingLineupInvitedIdempotencyKey(
  bookingRequestId: string,
  humanId: string,
  viaOrgId?: string | null,
  generation?: number | null,
): string {
  const base = viaOrgId
    ? `booking-lineup-invited:${bookingRequestId}:org:${viaOrgId}:${humanId}`
    : `booking-lineup-invited:${bookingRequestId}:${humanId}`;
  return generation != null ? `${base}:g${generation}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyBookingLineupInvitedDeps = {
  repos: Pick<Repos, "humans" | "organizations">;
  notify: NotifyFn;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for per-recipient delivery failures (the loop keeps
   * going — one bad recipient must not sink the rest). ReporterPort
   * convention: a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app, for the absolute confirm/decline deep link.
   * Required — without it there is no valid `targetUrl` and the whole step
   * throws (the CALLER's swallow reports it).
   */
  publicAppUrl?: string | null;
};

export type NotifyBookingLineupInvitedArgs = {
  bookingRequest: BookingRequestRecord;
  place: Pick<PlaceRecord, "id" | "name">;
  /** The humans tagged onto the bill by THIS create, in bill order. */
  taggedHumanIds: readonly string[];
  /**
   * The GROUPS tagged by this create (v3 L17), in bill order. Each one's
   * invite goes to every member holding an org edit role (ORG_EDIT_ROLES) —
   * the people who may answer for it — the way the hold notices reach an org
   * sender (`listOrgEditMembers`). Absent = none.
   */
  taggedOrgIds?: readonly string[];
  /**
   * Re-invites (v3 FR-009): the acts a bill edit RESTORED, keyed by
   * `performerOwnerKey(ownerType, ownerId)`, valued with the restored row's
   * `invitedAt` epoch — the invite generation in the idempotency key, so an
   * act put back on the bill is really asked again. Absent for an act = its
   * first invite (v2 key shape).
   */
  inviteGenerations?: Readonly<Record<string, number>>;
  /**
   * Re-invites inside the email cooldown (v3 FR-009 — the bill edit decides,
   * see `BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS`), keyed like
   * `inviteGenerations`: those acts are asked IN-APP ONLY (no email, no
   * push), so a remove / restore loop can never become an inbox flood with
   * an invite the recipient cannot mute.
   */
  inviteInAppOnly?: Readonly<Record<string, true>>;
  /**
   * The human who tagged (the create / edit actor). Skipped in a GROUP's
   * fan-out: an editor of a tagged group who tagged it is not invited by
   * their own action. A tagged PERSON is always invited — that is their
   * consent ask, whoever sent it.
   */
  actorHumanId?: string | null;
};

/**
 * Caller-facing hook injected into `createBookingRequest`, composed at the
 * transport/composition layer so the create use case stays decoupled from
 * the notify pipeline's deps.
 */
export type NotifyBookingLineupInvitedFn = (
  args: NotifyBookingLineupInvitedArgs,
) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "You're on a bill" (lineup-booking-requests v2, FR-003): each TAGGED human
 * — and each editor of a TAGGED group (v3 L17) — gets in-app + email + push
 * inviting them to join or pass.
 * SMS is disabled explicitly (the renderer emits no SMS payload either).
 *
 * Fired post-commit by `createBookingRequest`, which wraps this call in its
 * own swallow (logger.error + reportError) so a throwing notifier never
 * fails the committed request; inside, each recipient is additionally
 * isolated so one failed delivery does not block the others.
 *
 * Idempotency key per (request, human): `booking-lineup-invited:{id}:{human}`
 * — notify()'s channels derive their own `{key}:email` keys from it, so a
 * retry can never invite the same artist twice (FR-007).
 *
 * The deep link is the one-tap landing page (`/bookings/acts/{requestId}`),
 * where the invited artist confirms or declines.
 */
export async function notifyBookingLineupInvited(
  deps: NotifyBookingLineupInvitedDeps,
  args: NotifyBookingLineupInvitedArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyBookingLineupInvited" });
  const { bookingRequest, place } = args;

  const taggedHumans = [...new Set(args.taggedHumanIds)];
  const taggedOrgs = [...new Set(args.taggedOrgIds ?? [])];
  if (taggedHumans.length === 0 && taggedOrgs.length === 0) return;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    // No base URL → no valid absolute targetUrl → every per-recipient
    // notify() would fail its renderer parse. Fail the whole step once,
    // loudly; the caller's swallow reports it.
    throw new Error(
      "notifyBookingLineupInvited: publicAppUrl is required to build the lineup-invite link",
    );
  }

  // Resolve everything the renderer/template needs BEFORE any notify() call
  // (same hazard as notify-booking-request-received: a prop that passes the
  // renderer but fails the template would lose the email after its claim).
  const senderName = clip(
    await resolveSenderName(deps.repos, bookingRequest),
    SENDER_NAME_FALLBACK,
  );
  const venueName = clip(place.name ?? "", VENUE_NAME_FALLBACK);
  const targetUrl = `${baseUrl}/bookings/acts/${bookingRequest.id}`;

  // A group editor's invite says which group it is for (v3 FR-012). One
  // batched read; a group that does not resolve is invited without the line.
  const groupNames = await resolveGroupNames(deps, taggedOrgs);

  // One entry per (act, recipient): a tagged person is their own recipient;
  // a tagged group fans out to its editors (one membership read per group,
  // isolated like a delivery — a failed read loses that group's invites, not
  // everyone's). The tagging actor is skipped in a group's fan-out.
  const recipients: Array<{ humanId: string; viaOrgId: string | null }> =
    taggedHumans.map((humanId) => ({ humanId, viaOrgId: null }));
  for (const orgId of taggedOrgs) {
    try {
      for (const humanId of await listOrgEditMembers(deps, orgId)) {
        if (args.actorHumanId && humanId === args.actorHumanId) continue;
        recipients.push({ humanId, viaOrgId: orgId });
      }
    } catch (error) {
      logger?.error("booking_requests.notify_lineup_invited.group_members_failed", {
        bookingRequestId: bookingRequest.id,
        placeId: place.id,
        orgId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "notifyBookingLineupInvited",
            step: "group_members",
          },
          extra: { bookingRequestId: bookingRequest.id, placeId: place.id, orgId },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // per-group swallow into a thrown error.
      }
    }
  }

  for (const { humanId, viaOrgId } of recipients) {
    const asGroupName = viaOrgId ? groupNames.get(viaOrgId) : undefined;
    const actKey = viaOrgId
      ? performerOwnerKey("organization", viaOrgId)
      : performerOwnerKey("human", humanId);
    const generation = args.inviteGenerations?.[actKey];
    const inAppOnly = args.inviteInAppOnly?.[actKey] === true;
    try {
      await deps.notify({
        humanId,
        variant: BOOKING_LINEUP_INVITED_VARIANT,
        idempotencyKey: bookingLineupInvitedIdempotencyKey(
          bookingRequest.id,
          humanId,
          viaOrgId,
          generation,
        ),
        payload: {
          bookingRequestId: bookingRequest.id,
          humanId,
          senderName,
          venueName,
          ...(asGroupName ? { asGroupName } : {}),
          ...(bookingRequest.preferredDates.length > 0
            ? { preferredDates: bookingRequest.preferredDates }
            : {}),
          targetUrl,
        },
        // In-app / email / push follow the recipient's preferences
        // (transactional defaults: all ON). SMS is out of scope. A re-invite
        // inside the email cooldown is in-app only.
        channels: inAppOnly
          ? {
              sms: { enabled: false },
              email: { enabled: false },
              push: { enabled: false },
            }
          : { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("booking_requests.notify_lineup_invited.recipient_failed", {
        bookingRequestId: bookingRequest.id,
        placeId: place.id,
        humanId,
        viaOrgId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyBookingLineupInvited" },
          extra: {
            bookingRequestId: bookingRequest.id,
            placeId: place.id,
            humanId,
            viaOrgId,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // per-recipient swallow into a thrown error.
      }
    }
  }
}

/** Trim + clip to the renderer bound; empty → the field's OWN neutral fallback. */
function clip(name: string, fallback: string): string {
  return name.trim().slice(0, NAME_MAX_LENGTH).trim() || fallback;
}

/**
 * The tagged groups' names (Organization.name, clipped), keyed by org id —
 * ONE read for all of them, none when no group was tagged. A failed read
 * degrades to "no group line" (the invite still goes out); it is reported.
 */
async function resolveGroupNames(
  deps: NotifyBookingLineupInvitedDeps,
  orgIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (orgIds.length === 0) return names;
  try {
    for (const org of await deps.repos.organizations.getByIds([...orgIds])) {
      const name = org.name?.trim().slice(0, NAME_MAX_LENGTH).trim();
      if (name) names.set(org.id, name);
    }
  } catch (error) {
    deps.logger?.error("booking_requests.notify_lineup_invited.group_names_failed", {
      orgIds,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "notifyBookingLineupInvited", step: "group_names" },
        extra: { orgIds: [...orgIds] },
      });
    } catch {
      // Reporting is best-effort.
    }
  }
  return names;
}

/** Trim trailing slashes so URL joins never emit `//bookings/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * The SENDER's platform name (the organizer of the ask — D3), resolved the
 * way every inbox read resolves it; the neutral constant when it does not
 * resolve. Deliberately NOT the request's `actName`: on a bill without the
 * sender, `actName` may be an act's name, and a tagged artist must never be
 * told "<an act on the bill> added you to a bill".
 */
async function resolveSenderName(
  repos: NotifyBookingLineupInvitedDeps["repos"],
  bookingRequest: BookingRequestRecord,
): Promise<string> {
  const names = await resolvePerformerDisplayNames(repos, [bookingRequest]);
  const resolved = lookupPerformerDisplayName(bookingRequest, names)?.trim();
  return resolved || SENDER_NAME_FALLBACK;
}
