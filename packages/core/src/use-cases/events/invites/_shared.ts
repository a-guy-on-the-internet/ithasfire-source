import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventInviteRecord, EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { isEventPast } from "../../../lib/event-ended";
import { eventPublicUrl, normalizeAppBaseUrl } from "../../../lib/public-urls";
import { mintInviteToken } from "../../../lib/security/invite-token";
import {
  type InviteOptOutOwner,
  mintInviteOptOutToken,
} from "../../../lib/security/invite-optout-token";
import { formatEventStart } from "../../comms/copy/common";
import { inviteEmailMetadata } from "./invite-owner-tag";

/**
 * Shared pieces of the gated-event invite use cases
 * (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml).
 */

/** Gates an invite can open (spec out-of-scope: invites on ungated events). */
export function isInviteGate(
  gateType: EventRecord["gateType"],
): gateType is "PASSWORD" | "APPLICATION" {
  return gateType === "PASSWORD" || gateType === "APPLICATION";
}

/**
 * An organizer may mint or send links only while the event is gated, live
 * and not over (FR-008: a link on an ended or cancelled event is dead
 * anyway, so creating one would hand out a broken link).
 */
export function assertEventTakesNewInvites(event: EventRecord, now: Date): void {
  if (!isInviteGate(event.gateType)) {
    throw fail("INVALID_STATUS", { message: "event_not_gated" });
  }
  if (event.status === "CANCELLED") {
    throw fail("EVENT_ALREADY_CANCELLED");
  }
  if (isEventPast(event, now)) {
    throw fail("EVENT_ALREADY_ENDED");
  }
}

/**
 * Sending a guest an invite email (create / resend) additionally needs a
 * PUBLISHED event: a draft or archived event's page is not public, so the
 * emailed link would land on nothing (orchestrator ruling, step-3 review).
 * Minting the SHARED link on a draft stays allowed: copying it is harmless.
 */
export function assertEventTakesGuestInvites(event: EventRecord, now: Date): void {
  assertEventTakesNewInvites(event, now);
  if (event.status === "DRAFT" || event.status === "ARCHIVED") {
    throw fail("EVENT_NOT_PUBLISHED");
  }
}

/** The two config values every link builder needs, checked up front. */
export type InviteLinkConfig = {
  /** HMAC key for invite tokens. Server secret; never logged. */
  inviteTokenSecret: string;
  /** Public web origin (`https://…`), the base of the event page URL. */
  appBaseUrl?: string | null;
  /**
   * HMAC key for "Stop invites from this organiser" tokens, HKDF-derived by
   * the composition root (`deriveInviteOptOutSecret`). Only the email
   * senders need it ({@link assertInviteEmailConfig}).
   */
  inviteOptOutSecret?: string | null;
};

/**
 * The full invite URL: the event's public page with `?invite=<token>`.
 * The token is re-derived from the invite id, never read back from storage.
 * Throws NOT_CONFIGURED without a web origin or event slug, rather than
 * handing the organizer a link that goes nowhere.
 */
export function buildInviteUrl(
  config: InviteLinkConfig,
  event: Pick<EventRecord, "slug">,
  inviteId: string,
): string {
  const page = eventPublicUrl({ baseUrl: config.appBaseUrl, slug: event.slug });
  if (!page) {
    throw fail("NOT_CONFIGURED", { message: "invite_url_unavailable" });
  }
  const token = mintInviteToken(inviteId, config.inviteTokenSecret);
  return `${page}?invite=${encodeURIComponent(token)}`;
}

/**
 * The organiser an invite opt-out is scoped to: the event's OWNER, an org,
 * or the human who owns a person-owned event. Null for an ownerless event
 * (not a real case; such an event takes no invites).
 */
export function inviteOptOutOwner(
  event: Pick<EventRecord, "orgId" | "humanId">,
): InviteOptOutOwner | null {
  if (event.orgId) return { kind: "ORG", orgId: event.orgId };
  if (event.humanId) return { kind: "HUMAN", humanId: event.humanId };
  return null;
}

/**
 * Web paths for "Stop invites from this organiser":
 *  - the human-facing page (GET; confirms before changing anything, so a
 *    link scanner's prefetch changes nothing) that the email footer links;
 *  - the RFC 8058 one-click endpoint (POST only) the List-Unsubscribe
 *    header names.
 * Both take the signed token in `?token=`.
 */
export const INVITE_OPT_OUT_PAGE_PATH = "/invites/stop";
export const INVITE_OPT_OUT_ONE_CLICK_PATH = "/api/invites/stop";

/**
 * Both opt-out URLs for one (organiser, recipient), or throws NOT_CONFIGURED
 * without the secret or a usable web origin: an invite email must never go
 * out without a working opt-out.
 */
export function buildInviteOptOutUrls(
  config: Pick<InviteLinkConfig, "appBaseUrl" | "inviteOptOutSecret">,
  owner: InviteOptOutOwner,
  email: string,
): { pageUrl: string; oneClickUrl: string } {
  const base = normalizeAppBaseUrl(config.appBaseUrl);
  if (!base || !config.inviteOptOutSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_opt_out_unavailable" });
  }
  const token = encodeURIComponent(
    mintInviteOptOutToken({ owner, email }, config.inviteOptOutSecret),
  );
  return {
    pageUrl: `${base}${INVITE_OPT_OUT_PAGE_PATH}?token=${token}`,
    oneClickUrl: `${base}${INVITE_OPT_OUT_ONE_CLICK_PATH}?token=${token}`,
  };
}

/** Sends (create / resend) additionally need the opt-out key. */
export function assertInviteEmailConfig(config: InviteLinkConfig): void {
  assertInviteConfig(config);
  if (!config.inviteOptOutSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_opt_out_secret_missing" });
  }
}

export function assertInviteConfig(config: InviteLinkConfig): void {
  if (!config.inviteTokenSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_token_secret_missing" });
  }
  if (!config.appBaseUrl) {
    throw fail("NOT_CONFIGURED", { message: "invite_app_base_url_missing" });
  }
}

/** Template key for the personal invite email (template lands in step 4). */
export const EVENT_INVITE_TEMPLATE_KEY = "event.invite";

export type InviteEmailDeps = InviteLinkConfig & {
  repos: Pick<Repos, "organizations" | "humans">;
  mailer?: MailerPort;
  logger?: LoggerPort;
};

/** Organizer display name for the email: org name, else the human owner's. */
export async function resolveOrganizerName(
  repos: Pick<Repos, "organizations" | "humans">,
  event: Pick<EventRecord, "orgId" | "humanId">,
): Promise<string | null> {
  if (event.orgId) {
    return (await repos.organizations.getById(event.orgId))?.name ?? null;
  }
  if (event.humanId) {
    return (await repos.humans.getById(event.humanId))?.name ?? null;
  }
  return null;
}

/**
 * Send ONE personal invite email. Throws on failure; the caller owns the
 * swallow + report (it decides whether to report per send or once per
 * batch).
 *
 * The token appears ONLY inside `inviteUrl` in the template variables. It is
 * never put in `metadata`, `tags`, the idempotency key (mailers log it and
 * send it to the ESP as a header), or any log line.
 *
 * Every invite carries "Stop invites from <organiser>": the footer link
 * (`stopInvitesUrl`, the confirmation page) and the List-Unsubscribe
 * one-click headers. Those carry the separate OPT-OUT token, never the
 * invite token.
 */
export async function sendInviteEmail(
  deps: InviteEmailDeps,
  args: {
    event: Pick<
      EventRecord,
      | "id"
      | "title"
      | "slug"
      | "startsAt"
      | "endsAt"
      | "timezone"
      | "orgId"
      | "humanId"
    >;
    invite: Pick<EventInviteRecord, "id" | "inviteeEmail" | "inviteeName">;
    organizerName: string | null;
    /** This send attempt's instant; makes each resend its own mail. */
    at: Date;
  },
): Promise<void> {
  if (!deps.mailer) {
    throw new Error("event_invite_mailer_not_configured");
  }
  const email = args.invite.inviteeEmail;
  if (!email) {
    throw new Error("event_invite_missing_email");
  }
  const startsAtIso = args.event.startsAt.toISOString();
  const name = args.invite.inviteeName?.trim() || null;
  const owner = inviteOptOutOwner(args.event);
  if (!owner) {
    throw new Error("event_invite_event_has_no_owner");
  }
  // Built before the send: no opt-out, no email (throws NOT_CONFIGURED).
  const optOut = buildInviteOptOutUrls(deps, owner, email);

  await deps.mailer.send({
    to: name ? { to: email, name } : { to: email },
    template: {
      key: EVENT_INVITE_TEMPLATE_KEY,
      variables: {
        eventTitle: args.event.title,
        eventWhen: formatEventStart("en", startsAtIso, args.event.timezone),
        inviteeName: name,
        inviteUrl: buildInviteUrl(deps, args.event, args.invite.id),
        organizerName: args.organizerName,
        // Raw parts so the template can localize the date itself.
        startsAtIso,
        endsAtIso: args.event.endsAt?.toISOString() ?? null,
        timezone: args.event.timezone ?? null,
        stopInvitesUrl: optOut.pageUrl,
      },
    },
    // RFC 2369 + RFC 8058: mail clients offer a one-click "unsubscribe"
    // that POSTs `List-Unsubscribe=One-Click` to this URL. The opt-out
    // token can only opt this address out of invites: from this organiser,
    // or, from the stop page, from every organiser. One-click stays
    // organiser-scoped.
    headers: {
      "List-Unsubscribe": `<${optOut.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    idempotencyKey: `event-invite:${args.invite.id}:${args.at.getTime()}`,
    metadata: inviteEmailMetadata(args.event, args.at),
  });
}

/** Guarded reporter call: a throwing reporter must never change behaviour. */
export function reportSwallowed(
  reportError: ReporterPort | undefined,
  error: unknown,
  context: {
    tags: Record<string, string | undefined>;
    extra: Record<string, unknown>;
  },
): void {
  try {
    reportError?.(error, context);
  } catch {
    // Reporting is best-effort.
  }
}

/** True for the adapter's `{ code }` errors (and AppError-shaped ones). */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
