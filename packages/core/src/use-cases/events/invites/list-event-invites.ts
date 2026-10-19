import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { EventInviteRecord } from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";
import {
  assertInviteConfig,
  buildInviteUrl,
  type InviteLinkConfig,
} from "./_shared";

/**
 * The Access Gate panel's view of the event's invites (FR-001, FR-002): the
 * live SHARED link, and one row per guest email (its NEWEST invite, so a
 * guest re-invited after a revoke shows the new one).
 *
 * Status precedence: Revoked > Used (redeemed at least once) > Sent >
 * Unsent (created but the email never went out). Copy URLs are re-derived
 * from the invite id and only offered for live rows.
 */

export const listEventInvitesInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const eventGuestInviteStatusSchema = z.enum([
  "SENT",
  "USED",
  "REVOKED",
  "UNSENT",
]);

export const listEventInvitesOutputSchema = z
  .object({
    shared: z
      .object({
        id: z.string().uuid(),
        url: z.string(),
        redemptionCount: z.number().int().nonnegative(),
        firstRedeemedAt: z.date().nullable(),
      })
      .strict()
      .nullable(),
    guests: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().nullable(),
          email: z.string(),
          status: eventGuestInviteStatusSchema,
          sentAt: z.date().nullable(),
          firstRedeemedAt: z.date().nullable(),
          createdAt: z.date(),
          /** Only while the invite is live (not revoked). */
          copyUrl: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListEventInvitesInput = z.infer<typeof listEventInvitesInputSchema>;
export type ListEventInvitesOutput = z.infer<
  typeof listEventInvitesOutputSchema
>;
export type EventGuestInviteStatus = z.infer<
  typeof eventGuestInviteStatusSchema
>;

export type ListEventInvitesDeps = InviteLinkConfig & {
  repos: Repos;
};

export function guestInviteStatus(
  invite: Pick<EventInviteRecord, "revokedAt" | "firstRedeemedAt" | "sentAt">,
): EventGuestInviteStatus {
  if (invite.revokedAt) return "REVOKED";
  if (invite.firstRedeemedAt) return "USED";
  if (invite.sentAt) return "SENT";
  return "UNSENT";
}

export async function listEventInvites(
  deps: ListEventInvitesDeps,
  rawInput: unknown,
): Promise<ListEventInvitesOutput> {
  const input = parseInput(listEventInvitesInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );

  // Newest first (adapter order), so the first row per email wins.
  const invites = await deps.repos.eventInvites.listByEvent(event.id);
  const needsUrls = invites.some((i) => i.revokedAt === null);
  if (needsUrls) assertInviteConfig(deps);

  const liveShared = invites.find(
    (i) => i.kind === "SHARED" && i.revokedAt === null,
  );

  const seen = new Set<string>();
  const guests: ListEventInvitesOutput["guests"] = [];
  for (const invite of invites) {
    if (invite.kind !== "PERSONAL" || !invite.inviteeEmail) continue;
    if (seen.has(invite.inviteeEmail)) continue;
    seen.add(invite.inviteeEmail);
    guests.push({
      id: invite.id,
      name: invite.inviteeName,
      email: invite.inviteeEmail,
      status: guestInviteStatus(invite),
      sentAt: invite.sentAt,
      firstRedeemedAt: invite.firstRedeemedAt,
      createdAt: invite.createdAt,
      copyUrl:
        invite.revokedAt === null
          ? buildInviteUrl(deps, event, invite.id)
          : null,
    });
  }

  return listEventInvitesOutputSchema.parse({
    shared: liveShared
      ? {
          id: liveShared.id,
          url: buildInviteUrl(deps, event, liveShared.id),
          redemptionCount: liveShared.redemptionCount,
          firstRedeemedAt: liveShared.firstRedeemedAt,
        }
      : null,
    guests,
  });
}
