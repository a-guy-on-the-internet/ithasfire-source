import type { EventRecord } from "@th/ports/repos/events";

import type { InviteOptOutOwner } from "../../../lib/security/invite-optout-token";

/**
 * Mail metadata that ties a personal invite email back to its organiser, so a
 * spam complaint on it can count against them (invite complaint auto-pause,
 * W4, decision D1). Resend turns each metadata key into a `meta_<key>` tag and
 * echoes the tags on its webhook events.
 *
 * Values are ids only, never the invite token or the address.
 */
export const INVITE_OWNER_METADATA_KEY = "inviteOwner";
export const INVITE_EVENT_METADATA_KEY = "inviteEvent";
/**
 * When THIS send went out (epoch ms). A complaint is counted by the send it
 * is about, so a late complaint on mail sent before a staff LIFT can't
 * re-pause the organiser.
 */
export const INVITE_SENT_AT_METADATA_KEY = "inviteSentAt";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `org-<orgId>` / `human-<humanId>` for the event's owner, or null. */
export function inviteOwnerTag(
  event: Pick<EventRecord, "orgId" | "humanId">,
): string | null {
  if (event.orgId) return `org-${event.orgId}`;
  if (event.humanId) return `human-${event.humanId}`;
  return null;
}

/**
 * The invite email's metadata: owner, event, and this send's instant. Ids and
 * a timestamp only, never the token or the address.
 */
export function inviteEmailMetadata(
  event: Pick<EventRecord, "id" | "orgId" | "humanId">,
  sentAt: Date,
): Record<string, string> | undefined {
  const owner = inviteOwnerTag(event);
  if (!owner) return undefined;
  return {
    [INVITE_OWNER_METADATA_KEY]: owner,
    [INVITE_EVENT_METADATA_KEY]: event.id,
    [INVITE_SENT_AT_METADATA_KEY]: String(sentAt.getTime()),
  };
}

/** Parse an owner tag back; null for anything that isn't exactly our shape. */
export function parseInviteOwnerTag(value: string): InviteOptOutOwner | null {
  const match = /^(org|human)-(.+)$/.exec(value.trim());
  if (!match || !UUID.test(match[2]!)) return null;
  const id = match[2]!.toLowerCase();
  return match[1] === "org"
    ? { kind: "ORG", orgId: id }
    : { kind: "HUMAN", humanId: id };
}

/** The event id tag, or null unless it is a uuid. */
export function parseInviteEventTag(value: string | undefined): string | null {
  const v = value?.trim();
  return v && UUID.test(v) ? v.toLowerCase() : null;
}

/** Earliest / latest send instant a tag may claim (sanity bounds). */
const MIN_SENT_AT_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The send-time tag back as a Date, or null when absent or not a plausible
 * epoch-ms (mail sent before the tag existed falls back to the complaint's
 * own time).
 */
export function parseInviteSentAtTag(
  value: string | undefined,
  now: Date,
): Date | null {
  const v = value?.trim();
  if (!v || !/^\d{1,15}$/.test(v)) return null;
  const ms = Number(v);
  if (ms < MIN_SENT_AT_MS || ms > now.getTime() + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms);
}
