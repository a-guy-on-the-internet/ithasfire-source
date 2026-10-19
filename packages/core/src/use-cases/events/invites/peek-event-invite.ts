import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { resolveOrganizerName } from "./_shared";
import {
  redeemEventInviteDeadReasonSchema,
  resolveLiveInvite,
} from "./redeem-event-invite";

/**
 * READ-ONLY look at an invite link, for the guest landing BEFORE they tap
 * "Open the event" (gated-event invite links FR-010; approved landing
 * design). The gated document is identity-free and edge-cached, so the page
 * asks this per visit, keyed on the token.
 *
 * The verdict is redeem's own (`resolveLiveInvite`): same parse, HMAC, hash
 * lookup and dead reasons, so the landing can never promise entry that the
 * redeem then refuses. A reset or turned-off SHARED link is REVOKED here too:
 * it lets no NEW arrival in (R5).
 *
 * No writes, no counting, no logging of the token. The invitee's email is
 * never returned; their name only as a short form ("Maya R.").
 */

export const peekEventInviteInputSchema = z
  .object({
    token: z.string().min(1).max(256),
    /** The event the caller's URL names; another event's token is INVALID. */
    expectedEventId: z.string().uuid().optional(),
  })
  .strict();

export const peekEventInviteOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      reason: redeemEventInviteDeadReasonSchema,
      /** Set when the token resolved to an event. */
      eventId: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      eventId: z.string().uuid(),
      kind: z.enum(["SHARED", "PERSONAL"]),
      /** PERSONAL only: first name + last initial ("Maya R."), else null. */
      inviteeShortName: z.string().nullable(),
      organizerName: z.string().nullable(),
    })
    .strict(),
]);

export type PeekEventInviteInput = z.infer<typeof peekEventInviteInputSchema>;
export type PeekEventInviteOutput = z.infer<typeof peekEventInviteOutputSchema>;

export type PeekEventInviteDeps = {
  repos: Pick<Repos, "eventInvites" | "events" | "organizations" | "humans">;
  clock: ClockPort;
  /** HMAC key for invite tokens. Server secret; never logged. */
  inviteTokenSecret: string;
};

/**
 * "Maya Rodriguez" → "Maya R."; "Maya" → "Maya"; blank → null. Words split
 * on whitespace; the initial is the last word's first code point, so a
 * surrogate pair or accented letter is never cut in half.
 */
export function shortInviteeName(name: string | null | undefined): string | null {
  const words = (name ?? "").trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  if (!first) return null;
  if (words.length === 1) return first;
  const initial = Array.from(words[words.length - 1]!)[0]!;
  return `${first} ${initial.toLocaleUpperCase()}.`;
}

export async function peekEventInvite(
  deps: PeekEventInviteDeps,
  rawInput: unknown,
): Promise<PeekEventInviteOutput> {
  const input = parseInput(peekEventInviteInputSchema, rawInput);
  if (!deps.inviteTokenSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_token_secret_missing" });
  }

  const resolved = await resolveLiveInvite(
    deps,
    input.token,
    deps.inviteTokenSecret,
    input.expectedEventId,
  );
  if (!resolved.ok) {
    return peekEventInviteOutputSchema.parse({
      ok: false,
      reason: resolved.reason,
      eventId: resolved.event?.id ?? null,
    });
  }

  const { invite, event } = resolved;
  return peekEventInviteOutputSchema.parse({
    ok: true,
    eventId: event.id,
    kind: invite.kind,
    inviteeShortName:
      invite.kind === "PERSONAL" ? shortInviteeName(invite.inviteeName) : null,
    organizerName: await resolveOrganizerName(deps.repos, event),
  });
}
